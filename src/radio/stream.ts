/**
 * Construcción de la URL y headers para consumir el stream Icecast de la radio.
 *
 * Regla de oro: la password viaja SOLO como header `Authorization: Basic` —
 * nunca en la query (`?auth=`), porque la query termina en logs del reverse
 * proxy, historial y access logs de la estación.
 */
import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";

/** Basicauth de Basic desde latin1 (lo que espera el ecosistema Icecast). */
export function basicAuthHeader(username: string, password: string): string {
  const creds = `${username}:${password}`.replace(/[\u0080-\uFFFF]/g, (ch) => ch.normalize("NFKD")).split("");
  const bytes: number[] = [];
  for (const ch of creds.join("")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0xff) {
      // Latin-1 no puede representarlo: caemos al byte 0x3F ("?"), igual que hace el stack de Icecast.
      bytes.push(0x3f);
    } else {
      bytes.push(cp);
    }
  }
  const b64 = Buffer.from(Uint8Array.from(bytes)).toString("base64");
  return `Basic ${b64}`;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function buildStreamUrl(baseUrl: string, streamMount: string, _password: string): string {
  // El mount puede ser un path (`/stream.mp3`) o una URL absoluta (origin directo :7700).
  if (/^https?:\/\//i.test(streamMount)) {
    return streamMount;
  }
  const mount = streamMount.startsWith("/") ? streamMount : `/${streamMount}`;
  return `${normalizeBase(baseUrl)}${mount}`;
}

export interface StreamRequestInit {
  url: string;
  headers: Record<string, string>;
  redirect: "follow";
  signal?: AbortSignal;
}

export function streamFetchInit(
  baseUrl: string,
  streamMount: string,
  password: string,
  signal?: AbortSignal,
): StreamRequestInit {
  const url = buildStreamUrl(baseUrl, streamMount, password);
  const headers: Record<string, string> = {
    "user-agent": "discordwave/1.0 (+https://github.com/cunda)",
    accept: "*/*",
    "icy-metadata": "0",
  };
  if (password) {
    headers["authorization"] = basicAuthHeader("listener", password);
  }
  return {
    url,
    headers,
    redirect: "follow",
    signal,
  };
}

export interface OpenedStream {
  statusCode: number;
  headers: IncomingHttpHeaders;
  /** cuerpo crudo del stream: `IncomingMessage` ya es Readable, no bufferea nada */
  body: IncomingMessage;
  /** destruye request + socket en el acto (no queda keep-alive pendiente) */
  abort: () => void;
}

export interface OpenStreamOptions {
  /** máximo de saltos a seguir (default 20, igual que fetch) */
  maxRedirects?: number;
  /** timeout para conectar + recibir headers; 0/omitido = sin timeout (el body no tiene timeout) */
  headersTimeoutMs?: number;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function requestOnce(
  url: URL,
  headers: Record<string, string>,
  headersTimeoutMs?: number,
): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: "GET", headers, agent: false }, (res) => {
      req.setTimeout(0); // ojo: el timeout es solo hasta headers; un mount silencioso no debe morir
      resolve({ req, res });
    });
    req.on("error", reject);
    if (headersTimeoutMs && headersTimeoutMs > 0) {
      req.setTimeout(headersTimeoutMs, () => {
        req.destroy(new Error(`timeout esperando headers (${headersTimeoutMs}ms)`));
      });
    }
    req.end();
  });
}

/**
 * Abre el stream con http/https crudos en vez de `fetch`.
 *
 * ¿Por qué no fetch? undici (el fetch nativo) reabre una conexión idle cuando
 * se corta el body y deja ese socket vivo hasta su keep-alive timeout: la
 * radio seguía viendo una conexión después de `stop()`. Con `agent: false`
 * (sin pool) + `destroy()` el socket muere en el momento, que es lo que exige
 * la invariante "0 conexiones a la radio sin guild escuchando".
 *
 * Sigue redirects a mano con la misma política que fetch: máx. 20 saltos y
 * la credencial no viaja a otro origen.
 */
export async function openStream(
  rawUrl: string,
  headers: Record<string, string>,
  opts: OpenStreamOptions = {},
): Promise<OpenedStream> {
  const maxRedirects = opts.maxRedirects ?? 20;
  const headersTimeoutMs = opts.headersTimeoutMs;
  let url = new URL(rawUrl);
  let currentHeaders = { ...headers };
  let redirects = 0;

  for (;;) {
    const { req, res } = await requestOnce(url, currentHeaders, headersTimeoutMs);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;

    if (REDIRECT_CODES.has(status) && location && redirects < maxRedirects) {
      redirects += 1;
      const next = new URL(location, url);
      if (next.origin !== url.origin) delete currentHeaders["authorization"];
      // el destroy local del salto no debe emitir un error sin listener
      res.on("error", () => {});
      res.destroy();
      req.destroy();
      url = next;
      continue;
    }

    return {
      statusCode: status,
      headers: res.headers,
      body: res,
      abort: () => {
        // respuestas no-2xx se abortan sin consumidor: que un reset local no explote
        res.on("error", () => {});
        try {
          res.destroy();
        } catch {
          /* noop */
        }
        try {
          req.destroy();
        } catch {
          /* noop */
        }
      },
    };
  }
}
