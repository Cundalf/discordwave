/**
 * Pipeline de audio por guild:
 *
 *   GET stream.mp3 (HTTP Basic) ──> stdin ──> FFmpeg (s16le 48k 2ch) ──> stdout ──> AudioPlayer
 *
 * Garantía clave: el fetch HTTP al stream SOLO se abre aquí, dentro de start().
 * No existe ningún preload en el arranque del bot. 0 guilds escuchando = 0
 * conexiones a la radio. La garantía la da la construcción: no hay otro
 * call-site de fetch al stream en todo el código.
 *
 * stop(): SIGKILL ffmpeg → el body HTTP queda con el pipe roto y el socket
 * muere → Icecast resta el listener al expire de su timeout.
 * Elobjetivo del diseño es que "no consumir stream" no dependa de un
 * check que alguien pueda olvidar: es imposible abrir el stream sin guild.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { streamFetchInit } from "./stream.js";

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
  /**inyección para tests */
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  ffmpegPath?: string;
  log?: PipelineLogger;
}

export class StreamPipeline {
  readonly #deps: StreamPipelineDeps;
  readonly #log: PipelineLogger;
  /** callbacks de "stream murió solo": deps (health del boot) + los que registren (manager) */
  #endedCbs: ((reason: string) => void)[] = [];
  #proc: ChildProcessWithoutNullStreams | null = null;
  #source: Readable | null = null;
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
    const init = streamFetchInit(this.#deps.baseUrl, this.#deps.streamMount, this.#deps.streamPassword);
    const fetchFn = this.#deps.fetchFn ?? fetch;

    let body: ReadableStream<Uint8Array>;
    try {
      const res = await fetchFn(init.url, { headers: init.headers, redirect: init.redirect });
      if (!res.ok || !res.body) {
        const detail =
          res.status === 401 || res.status === 403
            ? "la radio rechazó el password del stream (¿cambió?)"
            : `HTTP ${res.status}`;
        throw new Error(detail);
      }
      body = res.body as ReadableStream<Uint8Array>;
    } catch (err) {
      throw new Error(`no pude abrir el stream: ${(err as Error).message}`);
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

    proc.on("close", (code) => {
      const wasStopped = this.#stopped;
      this.#proc = null;
      if (!wasStopped) {
        this.#stopped = true;
        this.#log.warn(
          `stream cerrado solo en guild ${this.#deps.guildId} (ffmpeg code=${code}${stderrTail ? `; ${stderrTail.split("\n")[0]}` : ""})`,
        );
        this.#fireEnded(`ffmpeg exit ${code}`);
      }
    });

    // WebStream (fetch) → Node Readable → stdin ffmpeg
    const nodeStream = Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on("error", (err) => {
      if (this.#stopped) return; // stop() ya lo desarmó
      // body del fetch muerto (la radio se cayó / reset de conexión):
      // hay que EOFear el stdin o ffmpeg queda colgado esperando bytes para SIEMPRE
      this.#log.warn(`fetch body error en guild ${this.#deps.guildId}: ${err.message}`);
      try {
        proc.stdin.destroy();
      } catch {
        /* noop */
      }
    });
    nodeStream.pipe(proc.stdin);
    this.#source = nodeStream;
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
    try {
      this.#source?.destroy();
    } catch {
      /* noop */
    }
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
}
