/** Resuelve el binario de FFmpeg: embebido (ffmpeg-static) o del sistema. */
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

function exists(p: string | undefined): p is string {
  if (!p) return false;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let cached: string | null = null;

export function ffmpegPath(): string {
  if (cached) return cached;
  // 1) ffmpeg-static embebido (prod docker / npm install con network)
  try {
    const p = require_("ffmpeg-static") as string | null; // CJS-only package
    if (exists(p ?? undefined)) {
      cached = p as string;
      return cached;
    }
  } catch {
    /* opcional */
  }
  // 2) del sistema
  for (const candidate of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/bin/ffmpeg"]) {
    if (exists(candidate)) {
      cached = candidate;
      return cached;
    }
  }
  throw new Error("ffmpeg no encontrado (¿instalaste ffmpeg o ffmpeg-static?)");
}
