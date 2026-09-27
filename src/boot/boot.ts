import { Client, Events, GatewayIntentBits, type GuildMember } from "discord.js";
import { loadConfig, redactConfig } from "../config/index.js";
import { ApiClient } from "../api/client.js";
import { RadioManager, type GuildVoiceAdapter, type RadioPipeline } from "../radio/manager.js";
import { StreamPipeline } from "../radio/pipeline.js";
import { RadioHealth } from "../radio/health.js";
import { DiscordAdapter } from "../radio/discord-voice.js";
import { commands, type CommandContext } from "../commands/index.js";
import { GuildRateLimiter } from "../commands/ratelimit.js";
import { RequestThrottle } from "../commands/pedir-throttle.js";
import { PermissionFlagsBits } from "discord.js";
import { UserFacingError } from "../util/user-facing-error.js";
import { ffmpegPath } from "../radioutil/ffmpeg-bin.js";

export interface BootHandle {
  client: Client;
  manager: RadioManager;
  /** apaga limpio: presence off → sweeps off → shutdown manager (0 streams) → destroy client */
  stop(): Promise<void>;
}

export async function boot(): Promise<BootHandle> {
  const config = loadConfig(process.env);
  console.log("[boot] config:", JSON.stringify(redactConfig(config)));

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const api = new ApiClient(config.subwave.baseUrl, config.subwave.streamPassword);
  const health = new RadioHealth((state) => {
    if (state === "offline") {
      console.warn("[radio] salud: la radio NO está al aire");
      presenceTimer && stopPresence();
      client.user?.setPresence({
        activities: [{ name: "la radio no está al aire", type: 2 }],
        status: "dnd",
      });
    }
    // "online" se refleja solo vía setIdlePresence/track del ciclo normal
  });

  let ready = false;
  let presenceTimer: NodeJS.Timeout | null = null;

  const startPresence = () => {
    if (presenceTimer) return;
    const tick = async () => {
      try {
        const np = await api.nowPlaying();
        const t = np.nowPlaying;
        const label = t.title ? `${t.artist ? `${t.artist} — ` : ""}${t.title}` : "Onda Fuzz";
        client.user?.setPresence({
          activities: [{ name: label.slice(0, 100), type: 2 }], // Listening
          status: "online",
        });
      } catch {
        client.user?.setPresence({
          activities: [{ name: "la radio offline 🔻", type: 2 }],
          status: "idle",
        });
      }
    };
    void tick();
    presenceTimer = setInterval(() => void tick(), config.npPollMs);
  };

  const stopPresence = () => {
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
  };

  /** visible pero 0 poll: si la radio está caída muestra dnd en vez de idle */
  const setIdlePresence = () => {
    if (!health.healthy) {
      client.user?.setPresence({
        activities: [{ name: "la radio no está al aire", type: 2 }],
        status: "dnd",
      });
      return;
    }
    client.user?.setPresence({
      activities: [{ name: "la radio — /sintonizar", type: 2 }],
      status: "idle",
    });
  };

  const manager = new RadioManager({
    adapterFactory: (guildId, channelId): GuildVoiceAdapter =>
      new DiscordAdapter(client, guildId, channelId),
    pipelineFactory: (guildId): RadioPipeline =>
      new StreamPipeline({
        guildId,
        baseUrl: config.subwave.baseUrl,
        streamMount: config.subwave.streamMount,
        streamPassword: config.subwave.streamPassword,
        ffmpegPath: ffmpegPath(),
        onEnded: (reason) => {
          // el stream murió solo (corte neto, no stop normal) → radio abajo
          health.markOffline(reason);
        },
        log: {
          info: (s) => console.log(`[pipeline] ${s}`),
          warn: (s) => console.warn(`[pipeline] ${s}`),
          error: (s) => console.error(`[pipeline] ${s}`),
        },
      }),
    onOpenStream: (guildId) => {
      console.log(`[radio] stream abierto para guild ${guildId} (radio listeners +1)`);
      startPresence();
    },
    onCloseStream: (guildId) => {
      console.log(`[radio] stream cerrado para guild ${guildId} (radio listeners -1)`);
      if (manager.playingCount === 0) {
        stopPresence();
        setIdlePresence();
      }
    },
    autoLeaveMs: config.autoLeaveMs,
    now: Date.now,
    log: {
      info: (s) => console.log(`[radio] ${s}`),
      warn: (s) => console.warn(`[radio] ${s}`),
      error: (s) => console.error(`[radio] ${s}`),
    },
  });

  async function tuneChannel(member: GuildMember, channelId: string): Promise<void> {
    if (!member.guild?.id) throw new UserFacingError("Este comando va en un servidor.");

    // validar permisos de voz ANTES de intentar join (sino entra/sale feo)
    const channel = member.guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) {
      throw new UserFacingError("¿Dónde estás? No encuentro ese canal de voz.");
    }
    const me = member.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.Connect)) {
      throw new UserFacingError("No tengo permiso de **Conectar** en ese canal — arréglalo en Configuración del canal → Permisos.");
    }
    if (!perms.has(PermissionFlagsBits.Speak)) {
      throw new UserFacingError("En ese canal puedo entrar pero no puedo **Hablar** (Configuración del canal → Hablar).");
    }

    const r = await manager.tune(member.guild.id, channelId);
    if (r.status === "already-playing") {
      return; // ya suena en ese server (quizás otro canal): el caller avisa
    }
    if (r.status === "channel-error") {
      // pipeline no abrió: es estado de la radio, no error de código
      health.markOffline(`tune: ${r.reason}`);
      throw new UserFacingError(r.reason); // userFacingMessage lo traduce
    }
    if (r.status === "error") throw new Error(`join falló: ${r.reason}`);
    // el stream se abrió: la radio está en el aire (aunque recién hayan pasado
    // por un corte, el pipeline real termine de arrancar y refresque la salud)
    health.markOnline();
  }

  const ctx: CommandContext & { radioHealthy: () => boolean } = {
    radioHealthy: () => health.healthy,
    client,
    api,
    manager,
    tuneChannel,
    stationUrl: config.subwave.baseUrl,
    defaultVolume: config.defaultVolume,
    requestThrottle: new RequestThrottle({
      cooldownS: config.requestCooldownS,
      spacingS: config.requestGlobalSpacingS,
      hourlyCap: config.requestHourlyCap,
    }),
    rlTuneCooldownS: config.rlTuneCooldownS,
    rlApiMaxPer10S: config.rlApiMaxPer10S,
    rateLimiter: new GuildRateLimiter(Date.now),
  };

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = commands.find((c) => c.data.name === interaction.commandName);
    if (!cmd) return;
    try {
      await cmd.handle(interaction, ctx);
    } catch (err) {
      console.error(`[cmd ${interaction.commandName}]`, err);
      const deferred = !interaction.replied;
      if (deferred) {
        await interaction
          .deferReply()
          .then(() => interaction.editReply("💥 Algo rompió. Probá de nuevo."))
          .catch(() => undefined);
      }
    }
  });

  // sweep de canales que quedaron sin oyentes humanos
  const sweepTimer = setInterval(() => manager.sweepEmpty(), 60_000);
  sweepTimer.unref?.();

  // presence solo con oyentes: 0 guilds → bot invisible y sin polling
  const presenceGuard = setInterval(() => {
    if (
      manager.playingCount === 0 &&
      (client.user?.presence.status ?? "invisible") !== "invisible"
    ) {
      stopPresence();
      client.user?.setPresence({ status: "invisible", activities: [] });
    }
  }, config.npPollMs * 2);
  presenceGuard.unref?.();

  client.once(Events.ClientReady, () => {
    ready = true;
    console.log(`[boot] listo como ${client.user?.tag} (idle: 0 poll hasta que alguien sintonice)`);
    setIdlePresence();
  });

  async function stop(): Promise<void> {
    console.log("[boot] apagando: cortando todos los streams...");
    stopPresence();
    client.user?.setPresence({ status: "invisible", activities: [] });
    clearInterval(sweepTimer);
    clearInterval(presenceGuard);
    await manager.shutdown();
    if (ready) {
      try {
        await client.destroy();
      } catch {
        /* noop */
      }
    }
    console.log("[boot] apagado limpio: 0 conexiones a la radio");
  }

  await client.login(config.discord.token);

  return { client, manager, stop };
}
