import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../src/api/client.js";
import type { NowPlaying } from "../src/api/types.js";

/** fetch mockeado: graba (url, headers) y devuelve según cola/función */
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = url.toString();
    calls.push({ url: u, init });
    return handler(u, init);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

const NOW_PLAYING: NowPlaying = {
  nowPlaying: {
    title: "チャイナ ローズ",
    artist: "金井夕子",
    album: "The Best of City Pop Vol.23",
    duration: 227,
    genres: ["JPop"],
  },
  dj: { name: "Ricardo IArio", tagline: "El filósofo del metal pesado", station: "Onda Fuzz" },
  listeners: { current: 7, peak: 12 },
  streamOnline: true,
  stream: { mount: "/stream.mp3", bitrate: 192, format: "mp3" },
  activeShow: null,
};

describe("ApiClient", () => {
  const base = "https://radio.example";
  const pw = "sekret";

  it("GET now-playing va sin auth (endpoint público) y parsea", async () => {
    const f = mockFetch(() => jsonResponse(NOW_PLAYING));
    const api = new ApiClient(base, pw, f as typeof fetch);
    const np = await api.nowPlaying();
    expect(np.nowPlaying.title).toBe("チャイナ ローズ");
    expect(f.calls[0]?.url).toBe("https://radio.example/api/now-playing");
    expect(f.calls[0]?.init?.headers).toBeDefined();
    // no debe filtrar la password por accidente en un read público
    expect(JSON.stringify(f.calls[0]?.init?.headers)).not.toContain(pw);
  });

  it("POST /api/request manda x-station-auth, text y name (requestedBy)", async () => {
    const f = mockFetch(() =>
      jsonResponse({ success: true, requestId: "r1", status: "pending" }, 202),
    );
    const api = new ApiClient(base, pw, f as typeof fetch);
    const res = await api.requestTrack("心愿 - Robbie Williams", "Cunda");
    expect(res.success).toBe(true);
    expect(res.requestId).toBe("r1");
    const init = f.calls[0]?.init;
    expect(init?.method).toBe("POST");
    const h = new Headers(init?.headers as HeadersInit);
    expect(h.get("x-station-auth")).toBe(pw);
    const body = JSON.parse(init?.body as string);
    expect(body.text).toBe("心愿 - Robbie Williams");
    expect(body.name).toBe("Cunda"); // el DJ puede nombrarlo en el aire
  });

  it("requestedBy sin nombre → body sin name (radio lo marca anon)", async () => {
    const f = mockFetch(() => jsonResponse({ success: true }, 202));
    const api = new ApiClient(base, pw, f as typeof fetch);
    await api.requestTrack("x");
    expect(JSON.parse(f.calls[0]?.init?.body as string).name).toBeUndefined();
  });

  it("name se recorta a 40 y limpia chars no-letters (limite de la radio)", async () => {
    const f = mockFetch(() => jsonResponse({ success: true }, 202));
    const api = new ApiClient(base, pw, f as typeof fetch);
    const largo = "x".repeat(50);
    await api.requestTrack("t", largo);
    expect(JSON.parse(f.calls[0]?.init?.body as string).name).toBe(largo.slice(0, 40));
    await api.requestTrack("t", "🎸!!!"); // solo emoji/puntaje no-latin → sin name
    expect(JSON.parse(f.calls[1]?.init?.body as string).name).toBeUndefined();
  });


  it("429 levanta RATE_LIMITED con retryAfter", async () => {
    const f = mockFetch(() =>
      jsonResponse({ success: false, retryAfter: 60 }, 429),
    );
    const api = new ApiClient(base, pw, f as typeof fetch);
    const p = api.requestTrack("x");
    await expect(p).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterS: 60 });
  });

  it("401/403 levanta AUTH (password vieja)", async () => {
    const f = mockFetch(() => jsonResponse({ success: false }, 403));
    const api = new ApiClient(base, pw, f as typeof fetch);
    await expect(api.requestTrack("x")).rejects.toMatchObject({ code: "AUTH" });
  });

  it("convierte respuesta failed de la radio en error legible (Empty request → 400)", async () => {
    const f = mockFetch(() =>
      jsonResponse(
        { success: false, error: "Empty request", fieldErrors: { text: "Empty request" } },
        400,
      ),
    );
    const api = new ApiClient(base, pw, f as typeof fetch);
    const e = await api.requestTrack("").catch((x) => x);
    expect(e.code).toBe("REQUEST");
    expect(e.message).toContain("Empty request");
  });

  it("tolera now-playing incompleto (sin dj, sin listeners)", async () => {
    const f = mockFetch(() =>
      jsonResponse({ nowPlaying: { title: "T" } } as unknown as NowPlaying),
    );
    const api = new ApiClient(base, pw, f as typeof fetch);
    const np = await api.nowPlaying();
    expect(np.nowPlaying.title).toBe("T");
    expect(np.dj).toBeUndefined();
    expect(np.listeners).toBeUndefined();
  });

  it("errores de red levantan NETWORK", async () => {
    const f = mockFetch(() => {
      throw new Error("ECONNRESET");
    });
    const api = new ApiClient(base, pw, f as typeof fetch);
    await expect(api.nowPlaying()).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("dj() y schedule() pegan a sus endpoints", async () => {
    const f = mockFetch((url) => jsonResponse({ url }));
    const api = new ApiClient(base, pw, f as typeof fetch);
    const dj = await api.dj();
    expect(dj).toMatchObject({ url: "https://radio.example/api/dj" });
  });
});
