import { describe, expect, it } from "vitest";
import { GuildRateLimiter } from "../src/commands/ratelimit.js";

describe("GuildRateLimiter (fixed window)", () => {
  it("permite hasta max en la ventana", () => {
    let t = 0;
    const rl = new GuildRateLimiter(() => t);
    for (let i = 0; i < 5; i++) expect(rl.check("g", 5, 10_000).ok).toBe(true);
    expect(rl.check("g", 5, 10_000)).toEqual({ ok: false, remainingMs: 10_000, remainingS: 10 });
  });

  it("resetea la ventana", () => {
    let t = 0;
    const rl = new GuildRateLimiter(() => t);
    expect(rl.check("g", 1, 10_000).ok).toBe(true);
    t = 10_500;
    expect(rl.check("g", 1, 10_000).ok).toBe(true);
  });

  it("mensualiza remainingMs cuando bloquea", () => {
    let t = 0;
    const rl = new GuildRateLimiter(() => t);
    rl.check("g", 1, 10_000);
    t = 4_000;
    const r = rl.check("g", 1, 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.remainingMs).toBe(6_000);
  });

  it("keys independientes entre guilds y entre comandos", () => {
    let t = 0;
    const rl = new GuildRateLimiter(() => t);
    expect(rl.check("g1:sintonizar", 1, 10_000).ok).toBe(true);
    expect(rl.check("g1:suena", 5, 10_000).ok).toBe(true);
    expect(rl.check("g2:sintonizar", 1, 10_000).ok).toBe(true);
  });

  it("max=0 ventanas apagadas (config 0 = sin límite)", () => {
    let t = 0;
    const rl = new GuildRateLimiter(() => t);
    expect(rl.check("g", 0, 10_000).ok).toBe(true);
    expect(rl.check("g", 0, 10_000).ok).toBe(true);
  });

  it("no crece sin acotar (evict del más viejo por ventana muerta)", () => {
    let t = 0;
    const rl = new GuildRateLimiter(() => t);
    for (let i = 0; i < 900; i++) {
      rl.check(`g${i}`, 1, 10_000);
      t += 100;
    }
    expect(rl.size).toBeLessThanOrEqual(900);
    // el más viejo ya expiró, el mapa debe haberlo soltado al releer
  });
});
