/**
 * Smoke test contra la radio real (lee .env). No toca Discord.
 * Verifica: API now-playing + apertura real del stream con Basic auth.
 */
import { config as loadDotenv } from "dotenv";
import { ApiClient } from "../src/api/client.js";
import { StreamPipeline } from "../src/radio/pipeline.js";
import { ffmpegPath } from "../src/radioutil/ffmpeg-bin.js";

loadDotenv();

const base = process.env["SUBWAVE_BASE_URL"]!;
const pw = process.env["SUBWAVE_STREAM_PASSWORD"]!;
const mount = process.env["SUBWAVE_STREAM_MOUNT"] ?? "/stream.mp3";
const retries = Number(process.env["STREAM_RETRIES"] ?? "1") || 1;

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

// 1) API
const api = new ApiClient(base, pw);
try {
  const np = await api.nowPlaying();
  check(
    "GET /api/now-playing",
    Boolean(np.nowPlaying?.title),
    `${np.nowPlaying.title}${np.nowPlaying.artist ? ` — ${np.nowPlaying.artist}` : ""} (oyentes: ${np.listeners?.current ?? "?"})`,
  );
} catch (err) {
  check("GET /api/now-playing", false, (err as Error).message);
}

// 2) stream real: abrir, recibir PCM y cortar — DEBE quedar en 0 conexiones
const pipeline = new StreamPipeline({
  guildId: "smoke",
  baseUrl: base,
  streamMount: mount,
  streamPassword: pw,
  streamRetries: retries,
  ffmpegPath: ffmpegPath(),
  onEnded: () => {},
  log: { info: (s) => console.log(`    ${s}`), warn: (s) => console.log(`    ${s}`), error: (s) => console.log(`    ${s}`) },
});
try {
  await pipeline.start();
  const pcm = pipeline.pcmStream() as NodeJS.ReadableStream;
  const got = await new Promise<boolean>((resolve) => {
    const to = setTimeout(() => resolve(false), 8000);
    pcm.once("data", () => {
      clearTimeout(to);
      resolve(true);
    });
  });
  check("stream.mp3 (Basic auth) fluye PCM", got);
} catch (err) {
  check("stream.mp3 (Basic auth)", false, (err as Error).message);
} finally {
  await pipeline.stop();
}
console.log(failures === 0 ? "\n🟢 smoke OK" : `\n🔴 smoke: ${failures} falla(s)`);
process.exit(failures === 0 ? 0 : 1);
