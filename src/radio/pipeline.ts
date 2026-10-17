/**
 * Pipeline de audio por guild:
 *
 *   GET stream.mp3 (HTTP Basic) ──> stdin ──> FFmpeg (s16le 48k 2ch) ──> stdout ──> AudioPlayer
 *
 * Garantía clave: el request HTTP al stream SOLO se abre aquí, dentro de start().
 * No existe ningún preload en el arranque del bot. 0 guilds escuchando = 0
 * conexiones a la radio. La garantía la da la construcción: no hay otro
 * call-site HTTP al stream en todo el código.
 *
 * stop(): cierra el socket HTTP y SIGKILL ffmpeg → Icecast resta el listener
 * al instante (sin keep-alive de undici de por medio).
 * El objetivo del diseño es que "no consumir stream" no dependa de un
 * check que alguien pueda olvidar: es imposible abrir el stream sin guild.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { openStream, streamFetchInit, type OpenedStream } from "./stream.js";

export interface PipelineLogger {
  info: (s: string) => void;
  warn: (s: string) => void;
  error: (s: string) => void;
}

export const defaultLogger: PipelineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface StreamPipelineDeps {
  guildId: string;
  baseUrl: string;
  streamMount: string;
  streamPassword: string;
  /** fallback (deprecado): el manager lo sobreescribe con onEnded() */
  onEnded?: (reason: string) => void;
  /** inyección para tests */
  spawnFn?: typeof spawn;
  ffmpegPath?: string;
  /** intentos totales de apertura del stream (default 1 = sin reintentos) */
  streamRetries?: number;
  log?: PipelineLogger;
}

/** backoff de reintentos de apertura: 250ms, 500ms, 1s, 2s (tope) */
function retryDelayMs(attempt: number): number {
  return Math.min(2000, 250 * 2 ** (attempt - 1));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class StreamPipeline {
  readonly #deps: StreamPipelineDeps;
  readonly #log: PipelineLogger;
  /** callbacks de "stream murió solo": deps (health del boot) + los que registren (manager) */
  #endedCbs: ((reason: string) => void)[] = [];
  #proc: ChildProcessWithoutNullStreams | null = null;
  #source: Readable | null = null;
  #abortStream: (() => void) | null = null;
  #stopped = false;

  constructor(deps: StreamPipelineDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? defaultLogger;
  }

  /** registra callback de "stream murió solo" (el manager cablea su cascada acá) */
  onEnded(cb: (reason: string) => void): void {
    this.#endedCbs.push(cb);
  }

  #fireEnded(reason: string): void {
    this.#deps.onEnded?.(reason); // SIEMPRE: boot → salud de la radio
    for (const cb of this.#endedCbs) {
      try {
        cb(reason);
      } catch (err) {
        this.#log.error(`onEnded callback: ${(err as Error).message}`);
      }
    }
  }

  get isRunning(): boolean {
    return this.#proc !== null && !this.#stopped;
  }

  /**
   * Abre el HTTP stream y el ffmpeg. Resuelve apenas todo está pipeado;
   * falla rápido si el stream no responde (ej: 401 con password vieja).
   */
  async start(): Promise<void> {
    if (this.#proc) throw new Error("pipeline ya arrancado");
    this.#stopped = false;
    const init = streamFetchInit(this.#deps.baseUrl, this.#deps.streamMount, this.#deps.streamPassword);

    // apertura con reintentos: errores transitorios (red, 5xx) se reintentan con
    // backoff; 401/403/404 fallan al toque (no tiene sentido insistir)
    const attempts = Math.max(1, Math.floor(this.#deps.streamRetries ?? 1));
    let opened: OpenedStream | null = null;
    let lastError = "sin respuesta";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const candidate = await openStream(init.url, init.headers, { headersTimeoutMs: 10_000 });
        if (candidate.statusCode >= 500) {
          candidate.abort();
          lastError = `HTTP ${candidate.statusCode}`;
        } else {
          opened = candidate;
          break;
        }
      } catch (err) {
        lastError = (err as Error).message;
      }
      if (this.#stopped || attempt === attempts) break;
      this.#log.warn(
        `stream no abrió en guild ${this.#deps.guildId} (${lastError}); reintento ${attempt + 1}/${attempts}`,
      );
      await sleep(retryDelayMs(attempt));
      if (this.#stopped) break; // stop() durante el backoff: ni intentar
    }
    if (this.#stopped) {
      // stop() cayó durante los intentos: no dejar nada colgado
      opened?.abort();
      throw new Error("pipeline detenido durante el arranque");
    }
    if (!opened) throw new Error(`no pude abrir el stream: ${lastError}`);
    if (opened.statusCode === 401 || opened.statusCode === 403) {
      opened.abort();
      throw new Error("no pude abrir el stream: la radio rechazó el password del stream (¿cambió?)");
    }
    if (opened.statusCode < 200 || opened.statusCode >= 300) {
      opened.abort();
      throw new Error(`no pude abrir el stream: HTTP ${opened.statusCode}`);
    }

    const ffmpegPath = this.#deps.ffmpegPath ?? "ffmpeg";
    const proc = (this.#deps.spawnFn ?? spawn)(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-analyzeduration",
        "0",
        "-probesize",
        "32",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    ) as ChildProcessWithoutNullStreams;
    this.#proc = proc;

    let stderrTail = "";
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s) {
        stderrTail = (stderrTail + "\n" + s).split("\n").slice(-3).join("\n");
        this.#log.warn(`ffmpeg[g${this.#deps.guildId}]: ${s}`);
      }
    });

    // sin esto, un spawn fallido (ENOENT) tira un 'error' sin listener y mata el proceso
    proc.on("error", (err) => {
      this.#log.error(`ffmpeg[g${this.#deps.guildId}]: ${err.message}`);
    });

    proc.on("close", (code) => {
      const wasStopped = this.#stopped;
      this.#proc = null;
      if (!wasStopped) {
        this.#stopped = true;
        this.#log.warn(
          `stream cerrado solo en guild ${this.#deps.guildId} (ffmpeg code=${code}${stderrTail ? `; ${stderrTail.split("\n")[0]}` : ""})`,
        );
        this.#closeHttp(); // el body HTTP ya no tiene consumidor: socket afuera ya
        this.#fireEnded(`ffmpeg exit ${code}`);
      }
    });

    // IncomingMessage → stdin ffmpeg
    const source = opened.body;
    this.#source = source;
    this.#abortStream = opened.abort;
    const killStdin = (why: string): void => {
      if (this.#stopped) return; // stop() o el propio cierre ya lo desarmaron
      // body muerto (la radio se cayó / reset de conexión) o cierre sin 'end':
      // hay que EOFear el stdin o ffmpeg queda colgado esperando bytes para SIEMPRE
      this.#log.warn(`stream cortado en guild ${this.#deps.guildId}: ${why}`);
      try {
        proc.stdin.destroy();
      } catch {
        /* noop */
      }
    };
    source.on("error", (err) => killStdin(err.message));
    source.on("close", () => {
      if (!source.complete) killStdin("conexión cerrada sin terminar");
    });
    source.pipe(proc.stdin);
    this.#log.info(`stream abierto para guild ${this.#deps.guildId}`);
  }

  /** PCM s16le 48k estéreo para enchufar al AudioPlayer de discord.js */
  pcmStream(): NodeJS.ReadableStream | null {
    return this.#proc?.stdout ?? null;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const proc = this.#proc;
    this.#proc = null;
    this.#closeHttp();
    if (proc) {
      try {
        proc.stdout.destroy();
        proc.stderr.destroy();
        proc.stdin.destroy();
        proc.kill("SIGKILL");
      } catch {
        /* noop */
      }
    }
    this.#log.info(`stream cerrado para guild ${this.#deps.guildId}`);
  }

  /** cierra el request HTTP y su socket ya (agent:false → sin keep-alive colgado) */
  #closeHttp(): void {
    const abort = this.#abortStream;
    this.#abortStream = null;
    try {
      abort?.();
    } catch {
      /* noop */
    }
    try {
      this.#source?.destroy();
    } catch {
      /* noop */
    }
    this.#source = null;
  }
}
