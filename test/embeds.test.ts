import { describe, expect, it } from "vitest";
import { suenaEmbed, estadoReply, pedirAckEmbed, pedirErrorEmbed } from "../src/format/embeds.js";
import type { NowPlaying } from "../src/api/types.js";

const NP: NowPlaying = {
  nowPlaying: {
    title: "チャイナ ローズ",
    artist: "金井夕子",
    album: "The Best of City Pop Vol.23",
    duration: 227,
    genres: ["JPop"],
  },
  dj: { name: "Ricardo IArio", tagline: "El filósofo del metal pesado", station: "Onda Fuzz" },
  listeners: { current: 7 },
  streamOnline: true,
  stream: { mount: "/stream.mp3", bitrate: 192 },
  activeShow: null,
};

describe("suenaEmbed", () => {
  it("incluye título, artista y DJ", () => {
    const e = suenaEmbed(NP, "https://radio.example");
    const json = JSON.stringify(e.toJSON());
    expect(json).toContain("チャイナ ローズ");
    expect(json).toContain("金井夕子");
    expect(json).toContain("Ricardo IArio");
    expect(json).toContain("192");
  });

  it("sobrevive a now-playing vacío (radio offline)", () => {
    const e = suenaEmbed({ nowPlaying: { title: "—" } }, "https://radio.example");
    const json = JSON.stringify(e.toJSON());
    expect(json).toContain("—");
  });

  it("muestra el show activo si hay", () => {
    const np = { ...NP, activeShow: { name: "Tarde Cebra", host: { name: "Ricardo IArio" } } };
    const json = JSON.stringify(suenaEmbed(np, "x").toJSON());
    expect(json).toContain("Tarde Cebra");
  });
});

describe("pedir ack / error", () => {
  it("ack menciona la canción y la fila", () => {
    const e = pedirAckEmbed(" Soda stereo - de música ligera");
    const json = JSON.stringify(e.toJSON());
    expect(json).toContain("Soda stereo");
    expect(json).toContain("cola");
  });

  it("error mapea AUTH a mensaje humano", () => {
    const e = pedirErrorEmbed("AUTH");
    const json = JSON.stringify(e.toJSON());
    expect(json).toContain("password");
  });

  it("error RATE_LIMITED menciona el reintento", () => {
    const e = pedirErrorEmbed("RATE_LIMITED", 42);
    const json = JSON.stringify(e.toJSON());
    expect(json).toContain("segundo");
  });
});

describe("estadoReply", () => {
  it("usa contadores pasados por parámetro", () => {
    const s = estadoReply({ guilds: 3, uptimeS: 120, ping: 33, streamOnline: true });
    expect(s).toContain("3");
    expect(s).toContain("2m");
    expect(s).toContain("33");
  });
});
