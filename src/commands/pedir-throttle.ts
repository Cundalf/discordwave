/**
 * Throttle de /pedir alineado con los límites server-side de la propia radio:
 *
 * La radio (SUB/WAVE) aplica sobre CADA IP:
 *   - cooldown/espaciado entre pedidos (default 60s)
 *   - "one pending per IP": mientras un siga en cola, el próximo da 429
 *   - per-listener hourly cap (default 8/h)
 *   - station hourly cap, max queued, repeat cooldown (no nos toca localmente)
 *
 * TRAMPA: el bot es UNA IP para la radio. Todos los usuarios de Discord
 * comparten ese "oyente" → el cap horario y el espaciado son GLOBALES acá.
 * Orden de chequeo (mensaje más útil primero): usuario → global → cap.
 * El commit lo hace el caller solo cuando la radio aceptó (202).
 */

export type ThrottleCheck =
  | { ok: true }
  | { ok: false; kind: "user" | "global" | "cap"; waitS: number; resetAtMs: number };

export interface RequestThrottleOpts {
  /** cooldown por usuario de Discord (s); 0 = off */
  cooldownS?: number;
  /** espaciado mínimo entre pedidos de todo el bot (s) — el per-listener de la radio; 0 = off */
  spacingS?: number;
  /** tope global por hora rodante = per-listener cap de la radio; 0 = off */
  hourlyCap?: number;
  now?: () => number;
}

/** ventana rodante de una hora en ms */
const HOUR_MS = 3600_000;

export class RequestThrottle {
  readonly #cooldownS: number;
  readonly #spacingS: number;
  readonly #hourlyCap: number;
  readonly #now: () => number;
  readonly #lastByUser = new Map<string, number>();
  #lastGlobal = -Infinity;
  /** timestamps (ms) de los pedidos aceptados, para el hour rolling */
  #spend: number[] = [];

  constructor(opts: RequestThrottleOpts = {}) {
    this.#cooldownS = opts.cooldownS ?? 60;
    this.#spacingS = opts.spacingS ?? 60;
    this.#hourlyCap = opts.hourlyCap ?? 8;
    this.#now = opts.now ?? (() => Date.now());
  }

  check(userId: string): ThrottleCheck {
    const t = this.#now();

    // 1) cooldown por usuario
    if (this.#cooldownS > 0) {
      const prev = this.#lastByUser.get(userId);
      if (prev !== undefined) {
        const wait = prev + this.#cooldownS * 1000 - t;
        if (wait > 0) return { ok: false, kind: "user", waitS: Math.ceil(wait / 1000), resetAtMs: prev + this.#cooldownS * 1000 };
      }
    }

    // 2) espaciado global (1 IP → 1 "oyente" para la radio)
    if (this.#spacingS > 0) {
      const wait = this.#lastGlobal + this.#spacingS * 1000 - t;
      if (Number.isFinite(this.#lastGlobal) && wait > 0) {
        return { ok: false, kind: "global", waitS: Math.ceil(wait / 1000), resetAtMs: this.#lastGlobal + this.#spacingS * 1000 };
      }
    }

    // 3) cap horario global rodante
    if (this.#hourlyCap > 0) {
      this.#spend = this.#spend.filter((x) => t - x < HOUR_MS);
      if (this.#spend.length >= this.#hourlyCap) {
        const oldest = this.#spend[0] ?? t;
        const waitMs = oldest + HOUR_MS - t;
        return { ok: false, kind: "cap", waitS: Math.ceil(waitMs / 1000), resetAtMs: oldest + HOUR_MS };
      }
    }

    return { ok: true };
  }

  /** registrar un pedido que la radio ACEPTÓ (202) */
  commit(userId: string): void {
    const t = this.#now();
    this.#lastGlobal = t;
    this.#lastByUser.set(userId, t);
    if (this.#hourlyCap > 0) {
      this.#spend.push(t);
      // acotado por cap; recorte defensivo si cambia el cap
      if (this.#spend.length > Math.max(64, this.#hourlyCap * 2)) {
        this.#spend = this.#spend.slice(-this.#hourlyCap);
      }
    }
  }
}
