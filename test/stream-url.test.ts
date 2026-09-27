import { describe, expect, it } from "vitest";
import { buildStreamUrl, streamFetchInit, basicAuthHeader } from "../src/radio/stream.js";

const base = "https://radio.cundalf.com.ar";
const pw = "GlobexAspen";

describe("buildStreamUrl", () => {
  it("URL limpia: mount en la base, SIN password en query (no va a los logs del proxy)", () => {
    const url = buildStreamUrl(base, "/stream.mp3", pw);
    expect(url).toBe("https://radio.cundalf.com.ar/stream.mp3");
    expect(url).not.toContain("GlobexAspen");
    expect(url).not.toContain("auth=");
  });

  it("normaliza barra final de base y duplicados de /", () => {
    expect(buildStreamUrl(`${base}/`, "/stream.mp3", pw)).toBe(`${base}/stream.mp3`);
  });

  it("acepta mount absoluto http como URL entera (origin directo :7700)", () => {
    const url = buildStreamUrl(base, "http://192.168.1.20:7700/stream.mp3", pw);
    expect(url).toBe("http://192.168.1.20:7700/stream.mp3");
    expect(url).not.toContain(pw);
  });
});

describe("basicAuthHeader", () => {
  it("codifica user:pass en base64 (cualquier username vale en subwave)", () => {
    const h = basicAuthHeader("listener", pw);
    expect(h).toBe(`Basic ${Buffer.from("listener:GlobexAspen").toString("base64")}`);
  });

  it("sobrevive passwords con unicode/caracteres raros (latin1 de Basic)", () => {
    const h = basicAuthHeader("listener", "pa­ss™w/rd:con:do­s");
    expect(h.startsWith("Basic ")).toBe(true);
    expect(() => Buffer.from(h.slice(6), "base64")).not.toThrow();
    expect(h).not.toContain("™"); // viaja base64, nunca plano
  });
});

describe("streamFetchInit", () => {
  it("Authorization Basic + headers de re-stream para Icecast", () => {
    const init = streamFetchInit(base, "/stream.mp3", pw);
    const h = new Headers(init.headers as HeadersInit);
    expect(h.get("authorization")).toBe(`Basic ${Buffer.from("listener:GlobexAspen").toString("base64")}`);
    expect(h.get("user-agent")).toContain("discordwave");
    expect(h.get("accept")).toBe("*/*");
    expect(init.redirect).toBe("follow");
    // la URL de init no lleva la password
    expect(String(init.url ?? "")).not.toContain(pw);
  });
});
