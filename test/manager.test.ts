import { describe, expect, it, vi } from "vitest";
import { RadioManager, type GuildVoiceAdapter, type RadioPipeline } from "../src/radio/manager.js";

/**
 * Fakes del mundo de voz/pipeline: el manager no conoce discord.js ni ffmpeg.
 * Probamos las invariantes: stream solo con guild escuchando, teardown
 * cascada, sweep de huérfanos, contadores.
 */

class FakePipeline implements RadioPipeline {
  static created: FakePipeline[] = [];
  started = 0;
  stopped = 0;
  #endedCb: ((reason: string) => void) | null = null;
  constructor(public guildId: string) {
    FakePipeline.created.push(this);
  }
  async start(): Promise<void> {
    this.started++;
  }
  pcmStream(): NodeJS.ReadableStream | null {
    return null;
  }
  stop(): void {
    this.stopped++;
  }
  // helpers de test
  onEnded(cb: (reason: string) => void): void {
    this.#endedCb = cb;
  }
  simulateEnd(reason = "corte"): void {
    this.#endedCb?.(reason);
  }
}

class FakeAdapter implements GuildVoiceAdapter {
  joined = 0;
  destroyed = 0;
  played: NodeJS.ReadableStream | null = null;
  playCalls = 0;
  humans = 1;
  #idleCb: (() => void) | null = null;
  #destroyedCb: (() => void) | null = null;
  constructor(public guildId: string, public channelId: string) {}
  async join(): Promise<void> {
    this.joined++;
  }
  play(pcm: NodeJS.ReadableStream | null): void {
    this.played = pcm;
    this.playCalls++;
  }
  destroy(): void {
    this.destroyed++;
  }
  humanListeners(): number {
    return this.humans;
  }
  onIdle(cb: () => void): void {
    this.#idleCb = cb;
  }
  onDestroyed(cb: () => void): void {
    this.#destroyedCb = cb;
  }
  // helpers
  simulateIdle(): void {
    this.#idleCb?.();
  }
  simulateDestroyed(): void {
    this.#destroyedCb?.();
  }
}

function rig(now = () => 0) {
  const adapters = new Map<string, FakeAdapter>();
  const pipelines = new Map<string, FakePipeline>();
  const manager = new RadioManager({
    adapterFactory: (guildId, channelId) => {
      const a = new FakeAdapter(guildId, channelId);
      adapters.set(guildId, a);
      return a;
    },
    pipelineFactory: (guildId) => {
      const p = new FakePipeline(guildId);
      pipelines.set(guildId, p);
      return p;
    },
    autoLeaveMs: 0,
    now,
  });
  return { manager, adapters, pipelines };
}

describe("RadioManager", () => {
  it("tune: join → pipeline.start → play, en ese orden (stream NUNCA antes del join)", async () => {
    const { manager, adapters, pipelines } = rig();
    const events: string[] = [];
    const origJoin = FakeAdapter.prototype.join;
    const origStart = FakePipeline.prototype.start;
    FakeAdapter.prototype.join = async function () {
      events.push("join");
      return origJoin.call(this);
    };
    FakePipeline.prototype.start = async function () {
      events.push("stream-open");
      return origStart.call(this);
    };
    try {
      const r = await manager.tune("g1", "c1");
      expect(r.status).toBe("playing");
      expect(events.indexOf("join")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("join")).toBeLessThan(events.indexOf("stream-open"));
      expect(pipelines.get("g1")?.started).toBe(1);
      expect(adapters.get("g1")?.playCalls).toBe(1);
    } finally {
      FakeAdapter.prototype.join = origJoin;
      FakePipeline.prototype.start = origStart;
    }
  });

  it("tune con pipeline que falla al abrir: deshace todo y reporta channel-error", async () => {
    const { manager, adapters } = rig();
    const origStart = FakePipeline.prototype.start;
    FakePipeline.prototype.start = async function () {
      throw new Error("401");
    };
    try {
      const r = await manager.tune("g1", "c1");
      expect(r.status).toBe("channel-error");
      expect(String((r as { reason?: string }).reason)).toContain("401");
      // deshizo el join: adapter destruido y fuera del mapa
      expect(adapters.get("g1")?.destroyed).toBe(1);
      expect(manager.playingCount).toBe(0);
    } finally {
      FakePipeline.prototype.start = origStart;
    }
  });

  it("leave: mata pipeline y destroza adapter; playingCount vuelve a 0", async () => {
    const { manager, adapters, pipelines } = rig();
    await manager.tune("g1", "c1");
    expect(manager.playingCount).toBe(1);
    await manager.leave("g1");
    expect(manager.playingCount).toBe(0);
    expect(pipelines.get("g1")?.stopped).toBe(1);
    expect(adapters.get("g1")?.destroyed).toBe(1);
  });

  it("pipeline que muere solo dispara teardown cascada (leave interno)", async () => {
    const { manager, adapters, pipelines } = rig();
    await manager.tune("g1", "c1");
    pipelines.get("g1")?.simulateEnd("401");
    await vi.waitFor(() => {
      expect(manager.playingCount).toBe(0);
      expect(adapters.get("g1")?.destroyed).toBe(1);
    });
  });

  it("no deja spawnear pipeline doble para el mismo guild", async () => {
    const { manager, pipelines } = rig();
    await manager.tune("g1", "c1");
    const before = pipelines.get("g1")?.started;
    await manager.tune("g1", "c1");
    expect(pipelines.get("g1")?.started).toBe(before); // already-playing no re-spawnea
  });

  it("sweep: guild sin humanos > grace → auto-leave; con humanos no", async () => {
    let now = 0;
    const { adapters, pipelines } = rig(() => now);
    // re-crear con grace 60s amarrado al reloj del test
    const m2 = new RadioManager({
      adapterFactory: (g, c) => {
        const a = new FakeAdapter(g, c);
        adapters.set(g, a);
        return a;
      },
      pipelineFactory: (g) => {
        const p = new FakePipeline(g);
        pipelines.set(g, p);
        return p;
      },
      autoLeaveMs: 60_000,
      now: () => now,
    });
    await m2.tune("gX", "cX");
    const a = adapters.get("gX")!;
    a.humans = 0;
    now = 30_000;
    expect(m2.sweepEmpty()).toEqual([]); // marca emptySince=30k, aún en gracia
    now = 95_000;
    expect(m2.sweepEmpty()).toEqual(["gX"]); // 95k-30k = 65k > 60k gracia
    expect(pipelines.get("gX")?.stopped).toBe(1);
    // el id ya no está
    expect(m2.playingGuildIds).not.toContain("gX");
  });

  it("sweep con autoLeave 0: nunca auto-mata", async () => {
    let now = 0;
    const { manager, adapters } = rig(() => now);
    await manager.tune("g1", "c1");
    adapters.get("g1")!.humans = 0;
    now = 999_999;
    expect(manager.sweepEmpty()).toEqual([]);
    expect(manager.playingCount).toBe(1);
  });

  it("shutdown cierra todos los pipelines (SIGTERM → 0 fetch a la radio)", async () => {
    const { manager, pipelines } = rig();
    await manager.tune("g1", "c1");
    await manager.tune("g2", "c2");
    await manager.shutdown();
    expect(manager.playingCount).toBe(0);
    expect(pipelines.get("g1")?.stopped).toBe(1);
    expect(pipelines.get("g2")?.stopped).toBe(1);
  });

  it("conexión de voz caída (kick de Discord) → teardown cascada con pipeline.stop", async () => {
    const { manager, adapters, pipelines } = rig();
    await manager.tune("g1", "c1");
    adapters.get("g1")!.simulateDestroyed();
    await vi.waitFor(() => {
      expect(pipelines.get("g1")?.stopped).toBe(1);
      expect(manager.playingCount).toBe(0);
    });
  });

  it("leave durante el join: no llega a abrir pipeline", async () => {
    const { manager, adapters, pipelines } = rig();
    const origJoin = FakeAdapter.prototype.join;
    let release!: () => void;
    FakeAdapter.prototype.join = function () {
      this.joined++;
      return new Promise<void>((r) => {
        release = r;
      });
    };
    try {
      const tuning = manager.tune("g1", "c1");
      await vi.waitFor(() => expect(release).toBeTruthy());
      await manager.leave("g1");
      release();
      const r = await tuning;
      expect(r.status).toBe("error");
      expect(manager.playingCount).toBe(0);
      expect(pipelines.has("g1")).toBe(false); // nunca se creó
      expect(adapters.get("g1")?.destroyed).toBeGreaterThanOrEqual(1);
    } finally {
      FakeAdapter.prototype.join = origJoin;
    }
  });

  it("leave durante el start: corta el pipeline en vuelo y no queda guild", async () => {
    const { manager, pipelines } = rig();
    const origStart = FakePipeline.prototype.start;
    let release!: () => void;
    FakePipeline.prototype.start = function () {
      this.started++;
      return new Promise<void>((r) => {
        release = r;
      });
    };
    try {
      const tuning = manager.tune("g1", "c1");
      await vi.waitFor(() => expect(release).toBeTruthy());
      await manager.leave("g1");
      release();
      const r = await tuning;
      expect(r.status).toBe("error");
      expect(pipelines.get("g1")!.stopped).toBeGreaterThanOrEqual(1);
      expect(manager.playingCount).toBe(0);
    } finally {
      FakePipeline.prototype.start = origStart;
    }
  });

  it("play() que revienta: pipeline detenido igual (nada queda sonando)", async () => {
    const { manager, adapters, pipelines } = rig();
    const origPlay = FakeAdapter.prototype.play;
    FakeAdapter.prototype.play = function () {
      throw new Error("player roto");
    };
    try {
      const r = await manager.tune("g1", "c1");
      expect(r.status).toBe("error");
      expect(pipelines.get("g1")?.stopped).toBe(1);
      expect(adapters.get("g1")?.destroyed).toBe(1);
      expect(manager.playingCount).toBe(0);
    } finally {
      FakeAdapter.prototype.play = origPlay;
    }
  });
});
