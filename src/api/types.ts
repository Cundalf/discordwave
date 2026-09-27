/** Tipos mínimos de la API de SUB/WAVE. Campos opcional-robustos (la radio puede añadir/quitar). */

export interface TrackInfo {
  title: string;
  artist?: string;
  album?: string;
  genres?: string[];
  duration?: number;
}

export interface DjInfo {
  name?: string;
  tagline?: string;
  avatar?: string;
  station?: string;
}

export interface NowPlaying {
  nowPlaying: TrackInfo;
  dj?: DjInfo;
  activeShow?: {
    name?: string;
    host?: { name?: string };
  } | null;
  listeners?: { current?: number; peak?: number };
  streamOnline?: boolean;
  stream?: {
    mount?: string;
    format?: string;
    bitrate?: number;
  };
}

export interface DjOnAir {
  name?: string;
  tagline?: string;
  avatar?: string;
  soul?: string;
}

export interface ApiRequestResponse {
  success: boolean;
  requestId?: string;
  status?: string;
}

export type ApiErrorCode =
  | "AUTH"
  | "RATE_LIMITED"
  | "REQUEST"
  | "NETWORK"
  | "HTTP";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly retryAfterS?: number;

  constructor(code: ApiErrorCode, message: string, retryAfterS?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

export type FetchLike = typeof fetch;
