import { describe, expect, it } from "vitest";
import { loadConfig, redactConfig, ConfigError } from "../src/config/index.js";

const baseEnv = {
  DISCORD_TOKEN: "abc.123.token",
  DISCORD_CLIENT_ID: "999",
  SUBWAVE_BASE_URL: "https://radio.cundalf.com.ar",
  SUBWAVE_STREAM_PASSWORD: "GlobexAspen",
};

describe("loadConfig", () => {
  it("carga y aplica defaults", () => {
    const c = loadConfig({ ...baseEnv });
    expect(c.discord.token).toBe("abc.123.token");
    expect(c.subwave.baseUrl).toBe("https://radio.cundalf.com.ar");
    expect(c.subwave.streamMount).toBe("/stream.mp3");
    expect(c.autoLeaveMs).toBe(10 * 60_000);
    expect(c.defaultVolume).toBe(80);
    expect(c.npPollMs).toBe(30_000);
    expect(c.streamRetries).toBe(6);
    expect(c.requestCooldownS).toBe(60); // alineado al spacing de la radio
  });

  it("falla sin DISCORD_TOKEN", () => {
    const { DISCORD_TOKEN, ...sinToken } = baseEnv;
    void DISCORD_TOKEN;
    expect(() => loadConfig(sinToken)).toThrow(ConfigError);
    expect(() => loadConfig(sinToken)).toThrow(/DISCORD_TOKEN/);
  });

  it("falla con baseUrl sin scheme", () => {
    expect(() => loadConfig({ ...baseEnv, SUBWAVE_BASE_URL: "radio.cundalf.com.ar" })).toThrow(/http/);
  });

  it("trimea slash final del baseUrl", () => {
    const c = loadConfig({ ...baseEnv, SUBWAVE_BASE_URL: "https://radio.cundalf.com.ar/" });
    expect(c.subwave.baseUrl).toBe("https://radio.cundalf.com.ar");
  });

  it("falla con password vacío cuando se exige auth (radio privada)", () => {
    expect(() => loadConfig({ ...baseEnv, SUBWAVE_STREAM_PASSWORD: "" })).toThrow(/SUBWAVE_STREAM_PASSWORD/);
  });

  it("autoLeaveMinutes=0 desactiva auto-leave (0 ms)", () => {
    const c = loadConfig({ ...baseEnv, AUTO_LEAVE_MINUTES: "0" });
    expect(c.autoLeaveMs).toBe(0);
  });

  it("convierte minutos a ms", () => {
    const c = loadConfig({ ...baseEnv, AUTO_LEAVE_MINUTES: "3" });
    expect(c.autoLeaveMs).toBe(180_000);
  });

  it("invalida volumen fuera de rango", () => {
    expect(() => loadConfig({ ...baseEnv, DEFAULT_VOLUME: "150" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, DEFAULT_VOLUME: "-1" })).toThrow(ConfigError);
  });

  it("streamMount argentina custom valida scheme interno", () => {
    const c = loadConfig({ ...baseEnv, SUBWAVE_STREAM_MOUNT: "/stream.mp3" });
    expect(c.subwave.streamMount).toBe("/stream.mp3");
  });
});

describe("rate limits", () => {
  it("defaults sensatos por guild", () => {
    const c = loadConfig({ ...baseEnv });
    expect(c.rlTuneCooldownS).toBe(20); // anti-flapping sintonizar/salir
    expect(c.rlApiMaxPer10S).toBe(5); // /suena y /estado
  });

  it("configurables; 0 desactiva", () => {
    const c = loadConfig({ ...baseEnv, RATE_LIMIT_TUNE_COOLDOWN_S: "45", RATE_LIMIT_API_MAX_PER_10S: "2" });
    expect(c.rlTuneCooldownS).toBe(45);
    expect(c.rlApiMaxPer10S).toBe(2);
    expect(loadConfig({ ...baseEnv, RATE_LIMIT_TUNE_COOLDOWN_S: "0" }).rlTuneCooldownS).toBe(0);
  });

  it("throttle de /pedir alineado con la radio (60s spacing, cap 8/h)", () => {
    const c = loadConfig({ ...baseEnv });
    expect(c.requestGlobalSpacingS).toBe(60);
    expect(c.requestHourlyCap).toBe(8);
    expect(loadConfig({ ...baseEnv, REQUEST_HOURLY_CAP: "20", REQUEST_GLOBAL_SPACING_S: "90" })).toMatchObject({
      requestHourlyCap: 20,
      requestGlobalSpacingS: 90,
    });
  });
});

describe("redactConfig", () => {  it("nunca expone token ni password", () => {
    const c = loadConfig({ ...baseEnv });
    const r = redactConfig(c);
    expect(JSON.stringify(r)).not.toContain("abc.123.token");
    expect(JSON.stringify(r)).not.toContain("GlobexAspen");
    expect(JSON.stringify(r)).toContain("Glob***");
  });
});
