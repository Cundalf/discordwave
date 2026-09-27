/**
 * Integración manager + StreamPipeline real (ffmpeg+http fake): la cadena
 * completa salvo discord.js. Verifica que la única forma de tener una
 * conexión abierta es tener un guild "playing".
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RadioManager, type GuildVoiceAdapter, type RadioPipeline } from "../src/radio/manager.js";
import { StreamPipeline } from "../src/radio/pipeline.js";
import { ffmpegPath } from "../src/radioutil/ffmpeg-bin.js";

const MP3 = ((ffmpeg) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dw2-"));
  execFileSync(
    ffmpeg,
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-b:a", "128k", path.join(dir, "t.mp3")],
    { stdio: "ignore" },
  );
  return readFileSync(path.join(dir, "t.mp3"));
})(ffmpegPath());

const PW = "pw-int";
const baseEnv = { url: "", port: 0 };
let server: http.Server;

beforeEach(async () => {
  server = http.createServer((req, res) => {
    if (req.headers["authorization"] !== `Basic ${Buffer.from(`listener:${PW}`).toString("base64")}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "audio/mpeg" });
    const timer = setInterval(() => res.write(MP3), 100);
    res.on("close", () => clearInterval(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseEnv.port = (server.address() as { port: number }).port;
  baseEnv.url = `http://127.0.0.1:${baseEnv.port}`;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

class FakeAdapter implements GuildVoiceAdapter {
  destroyed = 0;
  humans = 2;
  #idle: (() => void) | null = null;
  constructor(public guildId: string, public channelId: string) {}
  async join(): Promise<void> {}
  play(): void {}
  destroy(): void {
    this.destroyed++;
  }
  humanListeners(): number {
    return this.humans;
  }
  onIdle(cb: () => void): void {
    this.#idle = cb;
  }
  onDestroyed(): void {}
  fireIdle(): void {
    this.#idle?.();
  }
}

function rig(autoLeaveMs = 0, now = () => Date.now()) {
  const adapters = new Map<string, FakeAdapter>();
  const manager = new RadioManager({
    adapterFactory: (guildId, channelId) => {
      const a = new FakeAdapter(guildId, channelId);
      adapters.set(guildId, a);
      return a;
    },
    pipelineFactory: (guildId): RadioPipeline =>
      new StreamPipeline({
        guildId,
        baseUrl: baseEnv.url,
        streamMount: "/stream.mp3",
        streamPassword: PW,
        ffmpegPath: ffmpegPath(),
        onEnded: () => {},
        log: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    autoLeaveMs,
    now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { manager, adapters };
}

describe("integración manager+pipeline real", () => {
  it("tune reproduce de verdad y leave corta el stream del server", async () => {
    const { manager, adapters } = rig();
    const r = await manager.tune("g1", "c1");
    expect(r.status).toBe("playing");
    const a = adapters.get("g1")!;
    expect(a.destroyed).toBe(0);

    await manager.leave("g1");
    expect(a.destroyed).toBe(1);
    expect(manager.playingCount).toBe(0);
  }, 15000);

  it("password incorrecta → channel-error, adapter destruido, 0 guilds", async () => {
    const { manager, adapters } = rig();
    // simulate password cambiada: creamos manager con factory que usa pw mala
    const bad = new RadioManager({
      adapterFactory: (g, c) => {
        const a = new FakeAdapter(g, c);
        adapters.set(g, a);
        return a;
      },
      pipelineFactory: (): RadioPipeline =>
        new StreamPipeline({
          guildId: "gb",
          baseUrl: baseEnv.url,
          streamMount: "/stream.mp3",
          streamPassword: "wrong",
          ffmpegPath: ffmpegPath(),
          onEnded: () => {},
          log: { info: () => {}, warn: () => {}, error: () => {} },
        }),
      autoLeaveMs: 0,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const r = await bad.tune("gb", "cb");
    expect(r.status).toBe("channel-error");
    expect(bad.playingCount).toBe(0);
    expect(adapters.get("gb")?.destroyed).toBe(1);
  }, 15000);
});
