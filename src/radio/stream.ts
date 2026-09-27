/**
 * Construcción de la URL y headers para consumir el stream Icecast de la radio.
 *
 * Regla de oro: la password viaja SOLO como header `Authorization: Basic` —
 * nunca en la query (`?auth=`), porque la query termina en logs del reverse
 * proxy, historial y access logs de la estación.
 */

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
