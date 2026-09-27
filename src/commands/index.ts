/**
 * Definición y handlers de los comandos slash.
 *
 * Los handlers reciben un "Context" inyectable (api, manager, config) así la
 * lógica queda testeable sin levantar Discord.
 */
import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
} from "discord.js";
import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/types.js";
import type { RadioManager } from "../radio/manager.js";
import { suenaEmbed, pedirAckEmbed, pedirErrorEmbed, estadoReply } from "../format/embeds.js";
import { RequestThrottle } from "./pedir-throttle.js";
import { GuildRateLimiter } from "./ratelimit.js";
import { userFacingMessage } from "../util/user-facing-error.js";

export interface CommandContext {
  client: Client;
  api: ApiClient;
  manager: RadioManager;
  /** join al canal de voz del member + arranque de pipeline; encapsula DiscordVoiceAdapter */
  tuneChannel: (member: GuildMember, channelId: string) => Promise<void>;
  stationUrl: string;
  defaultVolume: number;
  /** estado de salud de la radio (stream caído = responder "no está al aire") */
  radioHealthy: () => boolean;
  /** throttle de /pedir alineado con la radio (cooldown por user + spacing/cap globales) */
  requestThrottle: RequestThrottle;
  /** anti-flapping /sintonizar por guild (segundos); 0 = off */
  rlTuneCooldownS: number;
  /** /suena y /estado: max hits por cada 10s per guild; 0 = off */
  rlApiMaxPer10S: number;
  rateLimiter: GuildRateLimiter;
}

export interface SlashCommand {
  // acepta cualquier builder que .toJSON() valide (options-only, etc.)
  data: { toJSON: () => unknown; name: string };
  handle: (interaction: ChatInputCommandInteraction, ctx: CommandContext) => Promise<void>;
}

const defer = (i: ChatInputCommandInteraction) =>
  i.deferReply().catch(() => undefined);

/**
 * Guard de rate limit por (guild, comando). Devuelve true si pasa;
 * si bloquea, responde al usuario y el handler corta.
 * key = guildId:commandName → los límites son independientes por server.
 */
async function guard(
  i: ChatInputCommandInteraction,
  ctx: CommandContext,
  name: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  if (!i.guildId) return true; // DM no hay rate limit propio
  const r = ctx.rateLimiter.check(`${i.guildId}:${name}`, max, windowMs);
  if (r.ok) return true;
  await i.editReply(
    `⏳ Frená ahí — probá de nuevo en ~${"remainingS" in r ? r.remainingS : "?"}s.`,
  );
  return false;
}

/* ── /sintonizar ─────────────────────────────────────────── */
const sintonizar: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("sintonizar")
    .setDescription("Te une al canal de voz donde estás y sintoniza la radio"),
  handle: async (i, ctx) => {
    await defer(i);
    if (!(await guard(i, ctx, "sintonizar", 1, ctx.rlTuneCooldownS * 1000))) return;
    const member = i.member as GuildMember | null;
    const voice = member?.voice;
    const channelId = voice?.channelId;
    if (!member || !channelId) {
      await i.editReply("Entrá a un canal de voz primero y después corré `/sintonizar`.");
      return;
    }
    try {
      await ctx.tuneChannel(member, channelId);
      const np = await ctx.api.nowPlaying().catch(() => null);
      const embed = np
        ? suenaEmbed(np, ctx.stationUrl)
        : new EmbedBuilder()
            .setColor(0xe9a03b)
            .setTitle("📻 Sintonizado")
            .setDescription("En el aire (no pude leer qué está sonando).");
      await i.editReply({ content: "📻 **Sintonizando Onda Fuzz**", embeds: [embed] });
    } catch (err) {
      console.error("[cmd sintonizar] error (detalle en log):", err);
      const friendly =
        userFacingMessage(err) ??
        "💥 No pude sintonizar — se registró el error en el log del bot.";
      await i.editReply(friendly);
    }
  },
};

/* ── /salir ──────────────────────────────────────────────── */
const salir: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("salir")
    .setDescription("Apaga la radio en este servidor y sale del canal de voz"),
  handle: async (i, ctx) => {
    await defer(i);
    if (!(await guard(i, ctx, "salir", 1, 3_000))) return;
    if (!i.guildId) {
      await i.editReply("Este comando va en un server.");
      return;
    }
    const ok = await ctx.manager.leave(i.guildId);
    await i.editReply(ok ? "👋 Cerré la radio y corté el stream." : "No estaba sonando acá.");
  },
};

/* ── /suena ──────────────────────────────────────────────── */
const suena: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("suena")
    .setDescription("Qué está sonando ahora mismo en la radio"),
  handle: async (i, ctx) => {
    await defer(i);
    if (!(await guard(i, ctx, "suena", ctx.rlApiMaxPer10S, 10_000))) return;
    if (!ctx.radioHealthy()) {
      await i.editReply("**La radio no está al aire en este momento** — cuando vuelva volvé a preguntar.");
      return;
    }
    try {
      const np = await ctx.api.nowPlaying();
      await i.editReply({ embeds: [suenaEmbed(np, ctx.stationUrl)] });
    } catch (err) {
      console.error("[cmd suena] error (detalle en log):", err);
      await i.editReply("💥 No pude leer la radio ahora mismo — probá en un rato.");
    }
  },
};

/* ── /pedir ──────────────────────────────────────────────── */
const pedir: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("pedir")
    .setDescription("Pedile a la cabina que pase una canción")
    .addStringOption((o) =>
      o
        .setName("cancion")
        .setDescription("Artista y/o tema que querés escuchar")
        .setRequired(true)
        .setMaxLength(200),
    ),
  handle: async (i, ctx) => {
    await defer(i);
    const texto = i.options.getString("cancion", true).trim();
    if (!texto) {
      await i.editReply("Decime al menos qué querés escuchar 🙂");
      return;
    }
    if (!ctx.radioHealthy()) {
      await i.editReply("La radio no está al aire — no hay cabina que atienda pedidos ahora.");
      return;
    }
    const userId = i.user.id;
    const check = ctx.requestThrottle.check(userId);
    if (!check.ok) {
      const msgs: Record<"user" | "global" | "cap", string> = {
        user: `⏳ Anoté uno tuyo hace poco. Probá de nuevo en ~${check.waitS}s.`,
        global: `⏳ La cabina toma pedidos de a uno por minuto — esperá ~${check.waitS}s.`,
        cap: `🛑 Se llegó al tope horario de pedidos de la estación. Volvé en ~${Math.ceil(check.waitS / 60)}m.`,
      };
      await i.editReply(msgs[check.kind]);
      return;
    }
    try {
      // requestedBy: el DJ puede nombrarlo en el aire ("X pidio este tema")
      const member = i.member as GuildMember | null;
      const rawName = member?.displayName ?? i.user.displayName ?? i.user.username;
      const res = await ctx.api.requestTrack(texto, rawName);
      if (res.success) {
        ctx.requestThrottle.commit(userId); // solo los aceptados gastan cap
        await i.editReply({ embeds: [pedirAckEmbed(texto)] });
      } else {
        await i.editReply({ embeds: [pedirErrorEmbed("REQUEST")] });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        await i.editReply({ embeds: [pedirErrorEmbed(err.code, err.retryAfterS)] });
      } else {
        await i.editReply({ embeds: [pedirErrorEmbed("HTTP")] });
      }
    }
  },
};

/* ── /estado ─────────────────────────────────────────────── */
const estado: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("estado")
    .setDescription("Estado del bot: guilds sintonizados, uptime, ping, stream"),
  handle: async (i, ctx) => {
    await defer(i);
    if (!(await guard(i, ctx, "estado", ctx.rlApiMaxPer10S, 10_000))) return;
    let streamOnline = false;
    try {
      streamOnline = (await ctx.api.nowPlaying()).streamOnline === true;
    } catch {
      /* radio caída */
    }
    const reply = estadoReply({
      guilds: ctx.manager.playingCount,
      uptimeS: Math.floor(process.uptime()),
      ping: Math.max(0, Math.round(i.client.ws.ping)),
      streamOnline,
      stationUrl: ctx.stationUrl || undefined,
    });
    await i.editReply(reply);
  },
};

export const commands: SlashCommand[] = [sintonizar, salir, suena, pedir, estado];

export function commandData(): unknown[] {
  return commands.map((c) => c.data);
}
