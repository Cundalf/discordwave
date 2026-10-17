import {
  EmbedBuilder,
} from "discord.js";
import type { NowPlaying } from "../api/types.js";

const ACCENT = 0xe9a03b; // ámbar cebrita

function fmtDur(s?: number): string | null {
  if (!s || !Number.isFinite(s)) return null;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function suenaEmbed(np: NowPlaying, stationUrl: string): EmbedBuilder {
  const t = np.nowPlaying ?? { title: "—" };
  const station = /^https?:\/\//i.test(stationUrl) ? stationUrl : undefined;
  const e = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(t.title || "—")
    .setDescription(
      [
        t.artist ? `**${t.artist}**` : null,
        t.album ? t.album : null,
        t.genres?.length ? t.genres.map((g) => `\`${g}\``).join(" ") : null,
      ]
        .filter(Boolean)
        .join(" · ") || "Transmitiendo",
    );
  if (station) e.setURL(station);

  const bits: string[] = [];
  if (np.dj?.name) bits.push(`🎙️ ${np.dj.name}`);
  if (np.activeShow?.name) bits.push(`📻 ${np.activeShow.name}`);
  if (np.stream?.bitrate) bits.push(`📶 ${np.stream.bitrate}kbps`);
  const dur = fmtDur(t.duration);
  if (dur) bits.push(`⏱️ ~${dur}`);

  if (bits.length) e.setFooter({ text: bits.join(" · ") });
  if (typeof np.listeners?.current === "number") {
    e.addFields({ name: "Oyentes en la radio", value: `${np.listeners.current}`, inline: true });
  }
  return e;
}

export function pedirAckEmbed(texto: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle("🎁 Pedido en la cabina")
    .setDescription(`Anotado: **${texto.trim().slice(0, 80)}**\nEl DJ lo mete en la cola cuando vuelva al micrófono.`);
}

export function pedirErrorEmbed(code: string, retryAfterS?: number): EmbedBuilder {
  const msgs: Record<string, string> = {
    AUTH: "La radio rechazó mi password. Avisale al operador que la cambió.",
    RATE_LIMITED: `Demasiados pedidos seguidos${retryAfterS ? ` — probá de nuevo en ~${retryAfterS} segundo${retryAfterS === 1 ? "" : "s"}` : ""}.`,
    REQUEST: "La cabina no aceptó el pedido (¿mensaje vacío o muy largo?).",
    NETWORK: "No pude hablar con la radio, probablemente bum temporal. Probá de nuevo.",
    HTTP: "La radio respondió raro. Probá de nuevo en un rato.",
  };
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("No pude pedirlo")
    .setDescription(msgs[code] ?? "Algo salió mal en la cabina.");
}

export interface EstadoInput {
  guilds: number;
  uptimeS: number;
  ping: number;
  streamOnline: boolean;
  stationUrl?: string;
}

export function estadoReply(input: EstadoInput): string {
  const m = Math.floor(input.uptimeS / 60);
  const lineaStream = input.streamOnline
    ? "🟢 stream de la radio en línea"
    : "🔴 stream de la radio offline";
  return [
    `📡 ${lineaStream}`,
    `🏠 Sonando en **${input.guilds}** guild${input.guilds === 1 ? "" : "s"}`,
    `⏱️ Uptime: ${m}m · Ping: ${input.ping}ms`,
    ...(input.stationUrl ? [`🔗 ${input.stationUrl}`] : []),
  ].join("\n");
}
