/**
 * Test E2E del StreamPipeline real: servidor HTTP local fake + ffmpeg real.
 * Verifica las invariantes clave:
 *  - poll() → 0 conexiones al stream (no hay nada abierto)
 *  - pipeline.start() → el fetch llega con Basic auth y empieza a fluir audio
 *  - pipeline.stop() → SIGKILL ffmpeg y el stream del server queda sin cliente
 *  - stream 401 → start rechaza con mensaje de password
 */
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StreamPipeline } from "../src/radio/pipeline.js";
import { ffmpegPath } from "../src/radioutil/ffmpeg-bin.js";

/** MP3 real (sine 440Hz, ~2s) generado una vez con ffmpeg */
const MP3 = ((ffmpeg) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dw-"));
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-b:a",
      "128k",
      path.join(dir, "t.mp3"),
    ],
    { stdio: "ignore" },
  );
  return readFileSync(path.join(dir, "t.mp3"));
})(ffmpegPath());

let server: http.Server;
let port = 0;
let liveSockets = new Set<object>();

function mp3Bytes(): Buffer {
  return MP3;
}

const PASSWORD = "pw-test";

beforeEach(async () => {
  liveSockets = new Set();
  server = http.createServer((req, res) => {
    const auth = req.headers["authorization"];
    if (auth !== `Basic ${Buffer.from(`listener:${PASSWORD}`).toString("base64")}`) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    res.writeHead(200, { "content-type": "audio/mpeg" });
    const data = mp3Bytes();
    const timer = setInterval(() => {
      res.write(data);
    }, 100);
    req.on("close", () => clearInterval(timer));
    res.on("close", () => clearInterval(timer));
  });
  // trackeo de sockets abiertos para verificar "0 conexiones"
  server.on("connection", (socket) => {
    liveSockets.add(socket);
    socket.on("close", () => liveSockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

function makePipeline(overrides: Partial<ConstructorParameters<typeof StreamPipeline>[0]> = {}) {
  return new StreamPipeline({
    guildId: "g-test",
    baseUrl: `http://127.0.0.1:${port}`,
    streamMount: "/stream.mp3",
    streamPassword: PASSWORD,
    ffmpegPath: ffmpegPath(),
    onEnded: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  });
}

describe("StreamPipeline e2e (http+ffmpeg reales)", () => {
  it("start fluye PCM a stdout y stop mata todo (0 conexiones después)", async () => {
    const p = makePipeline();
    await p.start();
    const pcm = p.pcmStream() as NodeJS.ReadableStream & { read?: (n: number) => Buffer | null };
    expect(pcm).toBeTruthy();
    // leemos un chunk del stdout de ffmpeg (PCM)
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("sin PCM en 4s")), 4000);
      pcm.on("data", (c: Buffer) => {
        clearTimeout(to);
        resolve(c);
      });
      pcm.on("error", reject);
    });
    expect(chunk.length).toBeGreaterThan(0);

    await p.stop();
    // el server no debe tener sockets de datos vivos (solo el keepalive del test no aplica)
    await new Promise((r) => setTimeout(r, 300));
    expect(liveSockets.size).toBe(0);
  });

  it("password de stream rechazada → start falla con mensaje claro", async () => {
    const p = makePipeline({ streamPassword: "mala" });
    await expect(p.start()).rejects.toThrow(/password/);
    await p.stop();
  });

  it("sin password configurada no manda Authorization (radio pública)", async () => {
    // server sin auth: hacemos pwnar el test cambiando expectativa manual
    const gotHeaders: string[] = [];
    server.closeAllConnections?.();
    server.close();
    await once(server, "close");
    server = http.createServer((req, res) => {
      gotHeaders.push(String(req.headers["authorization"] ?? ""));
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.write(mp3Bytes());
      req.on("close", () => res.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const p2port = (server.address() as { port: number }).port;
    const p = new StreamPipeline({
      guildId: "g2",
      baseUrl: `http://127.0.0.1:${p2port}`,
      streamMount: "/stream.mp3",
      streamPassword: "",
      ffmpegPath: ffmpegPath(),
      onEnded: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await p.start();
    await new Promise((r) => setTimeout(r, 400));
    await p.stop();
    expect(gotHeaders.every((h) => h === "" || h === "undefined")).toBe(true);
  });


  it("corte del stream dispara TODAS las callbacks registradas (boot health + manager cascade)", async () => {
    const ended: string[] = [];
    const p = makePipeline({ onEnded: (r) => ended.push(`deps:${r}`) });
    await p.start();
    p.onEnded((r) => ended.push(`manager:${r}`));
    // drenar stdout como lo haría el AudioPlayer (si no, ffmpeg se bloquea en pipe lleno)
    p.pcmStream().resume();
    // el server muere de golpe (la radio se cayó)
    server.closeAllConnections?.();
    await new Promise<void>((r) => setTimeout(r, 1200));
    expect(ended.length).toBeGreaterThanOrEqual(2);
    expect(ended.some((e) => e.startsWith("deps:"))).toBe(true);
    expect(ended.some((e) => e.startsWith("manager:"))).toBe(true);
    await p.stop();
  }, 10000);

  it("múltiples pipelines independientes: cada uno su propio stream", async () => {
    const p1 = makePipeline();
    const p2 = makePipeline();
    await p1.start();
    await p2.start();
    expect(p1.isRunning).toBe(true);
    expect(p2.isRunning).toBe(true);
    await p1.stop();
    await p2.stop();
    expect(p1.pcmStream()).toBeNull();
    expect(p2.pcmStream()).toBeNull();
  });
});
