export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ConfigError";
  }
}

interface SubwaveConfig {
  /** Base de la estación sin barra final, ej: https://radio.cundalf.com.ar */
  baseUrl: string;
  /** Password de oyente (HTTP Basic en el stream, x-station-auth en la API) */
  streamPassword: string;
  /** Montaje del stream, ej: /stream.mp3 */
  streamMount: string;
}

interface DiscordConfig {
  token: string;
  clientId: string;
}

export interface Config {
  discord: DiscordConfig;
  subwave: SubwaveConfig;
  /** 0 = desactivado */
  autoLeaveMs: number;
  defaultVolume: number;
  npPollMs: number;
  streamRetries: number;
  requestCooldownS: number;
  /** espaciado global entre pedidos del bot = per-listener spacing de la radio; 0 = off */
  requestGlobalSpacingS: number;
  /** tope global por hora = per-listener hourly cap de la radio; 0 = off */
  requestHourlyCap: number;
  /** anti-flapping: cooldown por guild para /sintonizar (segundos); 0 = off */
  rlTuneCooldownS: number;
  /** límite por guild para comandos que le pegan a la API (/suena, /estado): max hits cada 10s; 0 = off */
  rlApiMaxPer10S: number;
  guildId: string | null;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v || !v.trim()) {
    throw new ConfigError(`Falta variable de entorno requerida: ${key}`);
  }
  return v.trim();
}

function num(
  env: Record<string, string | undefined>,
  key: string,
  def: number,
  opts: { min: number; max: number },
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < opts.min || n > opts.max) {
    throw new ConfigError(`${key} inválido: "${raw}" (esperado ${opts.min}..${opts.max})`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const token = required(env, "DISCORD_TOKEN");
  const clientId = required(env, "DISCORD_CLIENT_ID");

  let baseUrl = required(env, "SUBWAVE_BASE_URL");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ConfigError("SUBWAVE_BASE_URL debe empezar con http:// o https://");
  }
  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  const streamPassword = required(env, "SUBWAVE_STREAM_PASSWORD");
  const streamMount = env["SUBWAVE_STREAM_MOUNT"]?.trim() || "/stream.mp3";
  if (!/^(\/|http)/.test(streamMount)) {
    throw new ConfigError("SUBWAVE_STREAM_MOUNT debe empezar con / o http");
  }

  const autoLeaveMinutes = num(env, "AUTO_LEAVE_MINUTES", 10, { min: 0, max: 1440 });
  const defaultVolume = num(env, "DEFAULT_VOLUME", 80, { min: 0, max: 100 });
  const npPollMs = num(env, "NP_POLL_MS", 30_000, { min: 5_000, max: 600_000 });
  const streamRetries = num(env, "STREAM_RETRIES", 6, { min: 1, max: 60 });
  const requestCooldownS = num(env, "REQUEST_COOLDOWN_S", 60, { min: 0, max: 3600 });
  const requestGlobalSpacingS = num(env, "REQUEST_GLOBAL_SPACING_S", 60, { min: 0, max: 3600 });
  const requestHourlyCap = num(env, "REQUEST_HOURLY_CAP", 8, { min: 0, max: 1000 });
  const rlTuneCooldownS = num(env, "RATE_LIMIT_TUNE_COOLDOWN_S", 20, { min: 0, max: 600 });
  const rlApiMaxPer10S = num(env, "RATE_LIMIT_API_MAX_PER_10S", 5, { min: 0, max: 100 });

  const guildId = env["GUILD_ID"]?.trim() || null;

  return {
    discord: { token, clientId },
    subwave: { baseUrl, streamPassword, streamMount },
    autoLeaveMs: autoLeaveMinutes * 60_000,
    defaultVolume,
    npPollMs,
    streamRetries,
    requestCooldownS,
    requestGlobalSpacingS,
    requestHourlyCap,
    rlTuneCooldownS,
    rlApiMaxPer10S,
    guildId,
  };
}

export function redactConfig(c: Config): Record<string, unknown> {
  const pwd = c.subwave.streamPassword;
  const masked = pwd.length <= 4 ? "***" : `${pwd.slice(0, 4)}***`;
  return {
    discord: {
      token: `${c.discord.token.slice(0, 3)}***`,
      clientId: c.discord.clientId,
    },
    subwave: {
      baseUrl: c.subwave.baseUrl,
      streamPassword: masked,
      streamMount: c.subwave.streamMount,
    },
    autoLeaveMs: c.autoLeaveMs,
    defaultVolume: c.defaultVolume,
    npPollMs: c.npPollMs,
    streamRetries: c.streamRetries,
    requestCooldownS: c.requestCooldownS,
    requestGlobalSpacingS: c.requestGlobalSpacingS,
    requestHourlyCap: c.requestHourlyCap,
    rlTuneCooldownS: c.rlTuneCooldownS,
    rlApiMaxPer10S: c.rlApiMaxPer10S,
    guildId: c.guildId,
  };
}
