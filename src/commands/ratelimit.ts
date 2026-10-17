/**
 * Límite de tasa por (guild, comando) — ventana fija.
 *
 * Discord ya rate-limita nuestras respuestas, pero no protege el efecto
 * colateral que sí importa: churn de streams (sintonizar/salir spam → spawn
 * de ffmpeg y flapping de connections contra la radio) y martilleo de los
 * endpoints públicos de la radio (/suena → now-playing).
 */

export type LimiterCheck =
  | { ok: true }
  | { ok: false; remainingMs: number; remainingS: number };

export class GuildRateLimiter {
  /** windows activas (key → [inicioVentana, hits]) */
  readonly #windows = new Map<string, { start: number; hits: number }>();
  readonly #now: () => number;

  /** cota superior de memoria: ~número de guilds × comandos — sobra margen */
  static readonly MAX_ENTRIES = 1000;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get size(): number {
    return this.#windows.size;
  }

  check(key: string, max: number, windowMs: number): LimiterCheck {
    if (max <= 0 || windowMs <= 0) return { ok: true };
    const t = this.#now();
    const w = this.#windows.get(key);

    if (!w || t - w.start >= windowMs) {
      if (!w && this.#windows.size >= GuildRateLimiter.MAX_ENTRIES) {
        // cota dura: evict del más viejo (Map conserva orden de inserción)
        const oldest = this.#windows.keys().next().value;
        if (oldest !== undefined) this.#windows.delete(oldest);
      }
      this.#windows.set(key, { start: t, hits: 1 });
      return { ok: true };
    }

    const remaining = windowMs - (t - w.start);
    if (w.hits >= max) {
      return { ok: false, remainingMs: remaining, remainingS: Math.ceil(remaining / 1000) };
    }
    w.hits++;
    return { ok: true };
  }
}
