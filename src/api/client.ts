import { ApiError, type ApiRequestResponse, type DjOnAir, type FetchLike, type NowPlaying } from "./types.js";
import { cleanRequesterName } from "./requester-name.js";

export class ApiClient {
  readonly #base: string;
  readonly #stationPassword: string;
  readonly #fetch: FetchLike;

  constructor(baseUrl: string, stationPassword: string, fetchImpl?: FetchLike) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#stationPassword = stationPassword;
    this.#fetch = fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.#base;
  }

  async #get<T>(path: string, opts: { stationAuth?: boolean } = {}): Promise<T> {
    const url = `${this.#base}/api${path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.stationAuth) {
      headers["x-station-auth"] = this.#stationPassword;
    }
    let res: Response;
    try {
      res = await this.#fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new ApiError("NETWORK", `Fallo de red contacting ${path}: ${(err as Error).message}`);
    }
    return await this.#parse<T>(res, path);
  }

  async #parse<T>(res: Response, path: string): Promise<T> {
    let body: unknown = null;
    let parsed = false;
    try {
      body = await res.json();
      parsed = true;
    } catch {
      /* body no-JSON: manda el status */
    }
    if (!res.ok) {
      throw this.#errorForStatus(res, body, path);
    }
    if (!parsed) {
      throw new ApiError("HTTP", `${path}: respuesta no-JSON (HTTP ${res.status})`);
    }
    return body as T;
  }

  #errorForStatus(res: Response, body: unknown, path: string): ApiError {
    const b = (body ?? {}) as Record<string, unknown>;
    if (res.status === 401 || res.status === 403) {
      return new ApiError("AUTH", `${path}: password de estación rechazada (HTTP ${res.status})`);
    }
    if (res.status === 429) {
      const ra = Number(b["retryAfter"]) || 60;
      return new ApiError("RATE_LIMITED", `${path}: demasiados pedidos (HTTP 429)`, ra);
    }
    const message =
      (typeof b["message"] === "string" && b["message"]) ||
      (typeof b["error"] === "string" && b["error"]) ||
      null;
    if (message) {
      return new ApiError("REQUEST", `${path}: ${message}`);
    }
    return new ApiError("HTTP", `${path}: HTTP ${res.status}`);
  }

  async nowPlaying(): Promise<NowPlaying> {
    return await this.#get<NowPlaying>("/now-playing");
  }

  async dj(): Promise<DjOnAir> {
    return await this.#get<DjOnAir>("/dj");
  }

  /**
   * Pide una canción a la cabina.
   * `name` es el nombre del que pide (≤40 chars, letras — el DJ lo nombra en el aire).
   * Si en seteado/vacío tras limpiar → no se manda (radio lo registra anon).
   */
  async requestTrack(text: string, name?: string): Promise<ApiRequestResponse> {
    const url = `${this.#base}/api/request`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-station-auth": this.#stationPassword,
    };
    const payload: Record<string, string> = { text };
    const clean = cleanRequesterName(name);
    if (clean) payload["name"] = clean;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new ApiError("NETWORK", `Fallo de red en /request: ${(err as Error).message}`);
    }
    return await this.#parse<ApiRequestResponse>(res, "/request");
  }
}
