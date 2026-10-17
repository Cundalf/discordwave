/**
 * RadioManager: lógica pura de "¿qué guilds están escuchando la radio?".
 *
 * No conoce discord.js: opera sobre GuildVoiceAdapter (el mundo real lo
 * implementa con joinVoiceChannel/AudioPlayer) y sobre RadioPipeline
 * (la producción lo implementa con StreamPipeline = HTTP+ffmpeg).
 *
 * Invariantes:
 *  - el stream SOLO se abre dentro de tune(), cuando ya hay adapter listo.
 *  - leave() y onEnded() hacen teardown en cascada: pipeline.stop() →
 *    adapter.destroy() → salida del mapa.
 *  - sweepEmpty() auto-leave tras grace period sin humanos (opcional).
 */

export interface GuildVoiceAdapter {
  readonly guildId: string;
  join(): Promise<void>;
  /** conecta el pipeline al player; el pipeline ya viene starteado por el manager */
  play(pcm: NodeJS.ReadableStream | null): void;
  /** mata conexión + player. Idempotente. */
  destroy(): void;
  /** humanos oyentes en el canal (excluye bots y deafenados); -1 si desconocido */
  humanListeners(): number;
  onIdle(cb: () => void): void;
  onDestroyed(cb: () => void): void;
}

/** Puerto del pipeline: la unidad minima que abre/cierra el stream. */
export interface RadioPipeline {
  start(): Promise<void>;
  /** stream de PCM para adapters que lo consumen directo; null = el pipeline juega solo */
  pcmStream(): NodeJS.ReadableStream | null;
  stop(): void;
  /** el manager registra el callback de "stream murió solo" (corte/401/exit) */
  onEnded(cb: (reason: string) => void): void;
}

export interface PipelineLogger {
  info: (s: string) => void;
  warn: (s: string) => void;
  error: (s: string) => void;
}

export const managerLogger: PipelineLogger = { info: () => {}, warn: () => {}, error: () => {} };

export type TuneResult =
  | { status: "playing" }
  | { status: "already-playing" }
  | { status: "error" | "channel-error"; reason: string };

export interface RadioManagerDeps {
  adapterFactory: (guildId: string, channelId: string) => GuildVoiceAdapter;
  /** factory del pipeline — EN PRODUCCIÓN abre el fetch+ffmpeg aquí dentro */
  pipelineFactory: ( guildId: string) => RadioPipeline;
  /** listener count de la radio (opcional, para stats) */
  onOpenStream?: (guildId: string) => void | Promise<void>;
  onCloseStream?: (guildId: string) => void | Promise<void>;
  /** ms sin humanos para auto-leave; 0 = off */
  autoLeaveMs: number;
  now?: () => number;
  log?: PipelineLogger;
}

interface GuildState {
  adapter: GuildVoiceAdapter;
  pipeline: RadioPipeline | null;
  emptySince: number | null;
  leaving: boolean;
}

export class RadioManager {
  readonly #guilds = new Map<string, GuildState>();
  readonly #adapterFactory: RadioManagerDeps["adapterFactory"];
  readonly #pipelineFactory: RadioManagerDeps["pipelineFactory"];
  readonly #onOpenStream?: RadioManagerDeps["onOpenStream"];
  readonly #onCloseStream?: RadioManagerDeps["onCloseStream"];
  readonly #autoLeaveMs: number;
  readonly #now: () => number;
  readonly #log: PipelineLogger;

  constructor(deps: RadioManagerDeps) {
    this.#adapterFactory = deps.adapterFactory;
    this.#pipelineFactory = deps.pipelineFactory;
    this.#onOpenStream = deps.onOpenStream;
    this.#onCloseStream = deps.onCloseStream;
    this.#autoLeaveMs = deps.autoLeaveMs;
    this.#now = deps.now ?? (() => Date.now());
    this.#log = deps.log ?? managerLogger;
  }

  /** cantidad de guilds con stream ABIERTO ahora mismo = "listeners" que aporta el bot */
  get playingCount(): number {
    return this.#guilds.size;
  }

  get playingGuildIds(): string[] {
    return [...this.#guilds.keys()];
  }

  isPlaying(guildId: string): boolean {
    return this.#guilds.has(guildId);
  }

  /** Sweep de huérfanos: guilds cuyo canal quedó sin humanos hace > autoLeaveMs. */
  sweepEmpty(): string[] {
    if (this.#autoLeaveMs <= 0) return [];
    const now = this.#now();
    const toLeave: string[] = [];
    for (const [guildId, st] of this.#guilds) {
      const humans = st.adapter.humanListeners();
      if (humans > 0) {
        st.emptySince = null;
        continue;
      }
      st.emptySince ??= now;
      if (now - st.emptySince >= this.#autoLeaveMs) toLeave.push(guildId);
    }
    for (const guildId of toLeave) {
      this.#log.info(`auto-leave guild ${guildId} (sin oyentes humanos)`);
      void this.leave(guildId);
    }
    return toLeave;
  }

  async tune(guildId: string, channelId: string): Promise<TuneResult> {
    if (this.#guilds.has(guildId)) return { status: "already-playing" };

    const adapter = this.#adapterFactory(guildId, channelId);
    const st: GuildState = { adapter, pipeline: null, emptySince: null, leaving: false };
    this.#guilds.set(guildId, st);

    try {
      adapter.onIdle(() => {
        // stream terminó solo (corte, 401, ffmpeg exit) → cascada
        this.#log.warn(`stream idle en guild ${guildId}, teardown`);
        void this.leave(guildId);
      });
      adapter.onDestroyed(() => {
        // conexión de voz caída (kick de Discord, red): teardown COMPLETO,
        // no solo borrar del mapa — si no, el stream queda huérfano para siempre
        void this.leave(guildId);
      });

      // 1) join de voz
      await adapter.join();

      // leave() pudo caer durante el join: no abrir el stream si ya no corresponde
      if (st.leaving || !this.#guilds.has(guildId)) {
        adapter.destroy();
        return { status: "error", reason: "cancelado durante el join" };
      }

      // 2) recién AHORA se abre el stream. El orden importa: si el join falla,
      // nunca abrimos el fetch. Spawn garantizado post-join.
      const pipeline = this.#pipelineFactory(guildId);
      pipeline.onEnded((reason) => {
        // corte espontáneo del stream (red, 401, ffmpeg exit) → cascada
        this.#log.warn(`stream terminó solo en guild ${guildId}: ${reason}`);
        void this.leave(guildId);
      });
      st.pipeline = pipeline;
      try {
        await pipeline.start();
      } catch (err) {
        // no abrir stream ⇒ deshacer el join para no dejar el bot colgado en un canal mudo
        pipeline.stop(); // start() pudo dejar algo a medio abrir
        this.#guilds.delete(guildId);
        adapter.destroy();
        if (st.leaving) return { status: "error", reason: "cancelado durante el arranque" };
        return { status: "channel-error", reason: (err as Error).message };
      }

      // leave() pudo caer durante el start: el pipeline ya está detenido, no hay que sonar
      if (st.leaving || !this.#guilds.has(guildId)) {
        pipeline.stop();
        adapter.destroy();
        return { status: "error", reason: "cancelado durante el arranque" };
      }

      // 3) play
      adapter.play(pipeline.pcmStream());

      await this.#onOpenStream?.(guildId);
      return { status: "playing" };
    } catch (err) {
      st.pipeline?.stop(); // play/onOpenStream fallaron: nada puede quedar sonando
      this.#guilds.delete(guildId);
      adapter.destroy();
      return { status: "error", reason: (err as Error).message };
    }
  }

  /** Teardown cascada: pipeline (mata ffmpeg+fetch) → adapter (sale del canal). */
  async leave(guildId: string): Promise<boolean> {
    const st = this.#guilds.get(guildId);
    if (!st || st.leaving) return false;
    st.leaving = true;
    this.#guilds.delete(guildId);
    try {
      st.pipeline?.stop();
    } catch (err) {
      this.#log.error(`pipeline.stop: ${(err as Error).message}`);
    }
    try {
      st.adapter.destroy();
    } catch (err) {
      this.#log.error(`adapter.destroy: ${(err as Error).message}`);
    }
    await this.#onCloseStream?.(guildId);
    return true;
  }

  /** Para SIGTERM: mata todos los pipelines primero (corta los streams de la radio). */
  async shutdown(): Promise<void> {
    const ids = [...this.#guilds.keys()];
    await Promise.all(ids.map((id) => this.leave(id)));
  }
}
