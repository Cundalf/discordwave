/**
 * Estado de salud de la radio observado por boot/presence/comandos.
 *
 * Fuentes de verdad:
 *  - markOffline: cuando un StreamPipeline termina solo (stream caído neto,
 *    no un stop normal) — lo dispara la factory de pipelines del boot.
 *  - markOnline: cuando un /sintonizar logró abrir el stream (radio de vuelta).
 * Radio "desconocida de arranque" = asumida arriba (el bot no nace pesimista).
 */
export type HealthState = "online" | "offline";
export type HealthListener = (state: HealthState, reason: string | null) => void;

export class RadioHealth {
  #healthy = true;
  #reason: string | null = null;
  readonly #listener: HealthListener | null;

  constructor(listener?: HealthListener) {
    this.#listener = listener ?? null;
  }

  get healthy(): boolean {
    return this.#healthy;
  }

  get reason(): string | null {
    return this.#reason;
  }

  markOffline(reason: string): void {
    if (!this.#healthy) return; // idempotente
    this.#healthy = false;
    this.#reason = reason;
    this.#listener?.("offline", reason);
  }

  markOnline(): void {
    if (this.#healthy) return; // idempotente
    this.#healthy = true;
    this.#reason = null;
    this.#listener?.("online", null);
  }
}
