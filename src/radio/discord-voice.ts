import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import type { Client } from "discord.js";
import type { GuildVoiceAdapter } from "./manager.js";

/**
 * Capa Discord real: implementa GuildVoiceAdapter con joinVoiceChannel +
 * AudioPlayer. Toda la lógica de spawn/teardown vive en manager.ts (testeada).
 */

/**
 * Gateway fix: usamos el `guild.voiceAdapterCreator` OFICIAL de discord.js (Guild.js).
 * Ese creator registra el adapter en `client.voice.adapters`, por donde discord.js
 * automaticamente reenvía VOICE_SERVER_UPDATE / VOICE_STATE_UPDATE a @discordjs/voice
 * (ClientVoiceManager). Un adapterCreator artesanal sin ese registro NUNCA llega a
 * Ready → "The operation was aborted".
 */
function resolveAdapterCreator(client: Client, guildId: string): DiscordGatewayAdapterCreator {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    throw new Error(`guild ${guildId} no está en el cache del client`);
  }
  if (!guild.voiceAdapterCreator) {
    throw new Error(`guild ${guildId} sin voiceAdapterCreator (¿discord.js roto?)`);
  }
  return guild.voiceAdapterCreator;
}

class DiscordAdapter implements GuildVoiceAdapter {
  readonly guildId: string;
  readonly #channelId: string;
  readonly #client: Client;
  #connection: VoiceConnection | null = null;
  #player: AudioPlayer | null = null;
  #destroyed = false;
  #idleCb: (() => void) | null = null;
  #destroyedCb: (() => void) | null = null;
  #adapterCreator: DiscordGatewayAdapterCreator | null = null;

  constructor(client: Client, guildId: string, channelId: string) {
    this.#client = client;
    this.guildId = guildId;
    this.#channelId = channelId;
    this.#player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
    });
    this.#player.on("error", () => {
      // error de reproducción en UN guild: teardown de ese guild solamente
      this.#idleCb?.();
    });
  }

  async join(): Promise<void> {
    // el creator OFICIAL de discord.js se resuelve aca, con el guild ya cacheado
    if (!this.#adapterCreator) {
      this.#adapterCreator = resolveAdapterCreator(this.#client, this.guildId);
    }
    const connection: VoiceConnection = joinVoiceChannel({
      channelId: this.#channelId,
      guildId: this.guildId,
      adapterCreator: this.#adapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    connection.subscribe(this.#player!);
    this.#connection = connection;

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.#destroyedCb?.();
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      try {
        connection.destroy();
      } catch {
        /* noop */
      }
      throw new Error(`no pude entrar al canal de voz: ${(err as Error).message}`);
    }
  }

  play(pcm: NodeJS.ReadableStream | null): void {
    if (!this.#player || !pcm) return;
    // pcm ya es un Readable de Node (stdout de ffmpeg)
    this.#player.play(createAudioResource(pcm as Readable, { inputType: StreamType.Raw }));
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    try {
      this.#player?.stop(true);
    } catch {
      /* noop */
    }
    try {
      this.#connection?.destroy();
    } catch {
      /* noop */
    }
    this.#connection = null;
    this.#player = null;
    this.#destroyedCb?.();
  }

  humanListeners(): number {
    if (this.#destroyed || !this.#connection) return 0;
    try {
      const guild = this.#client.guilds.cache.get(this.guildId);
      const channelId = (this.#connection as unknown as { joinConfig: { channelId: string } }).joinConfig
        .channelId;
      const ch = guild?.channels.cache.get(this.#channelId) ?? guild?.channels.cache.get(channelId);
      if (ch?.isVoiceBased()) {
        // oyentes = humanos no muteados por server (deafen personal no cuenta: no pueden oír)
        return ch.members.filter(
          (m) => !m.user.bot && !m.voice.serverDeaf && (m.voice.selfDeaf !== true || m.id === m.client.user?.id),
        ).size;
      }
    } catch {
      /* noop */
    }
    return 0;
  }

  onIdle(cb: () => void): void {
    this.#idleCb = cb;
  }

  onDestroyed(cb: () => void): void {
    this.#destroyedCb = cb;
  }

  /** cablea el idle real del player (stream cortado) al callback del manager */
  wirePlayerIdle(): void {
    this.#player?.on("error", (err) => {
      this.#idleCb?.();
      throw err;
    });
  }

  internalPlayer(): AudioPlayer | null {
    return this.#player;
  }
}

export { DiscordAdapter };
