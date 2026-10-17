import { describe, expect, it } from "vitest";
import { RequestThrottle } from "../src/commands/pedir-throttle.js";

/**
 * Alinea el throttle local del bot con los límites server-side de la radio:
 *   - cooldown por usuario (bot)
 *   - espaciado GLOBAL entre pedidos (la radio ve 1 sola IP: todos los users
 *     de Discord comparten el "per-listener" de la radio)
 *   - tope horario global = per-listener hourly cap de la radio (8/h default)
 */
const S = 1000;

function rig(opts: ParameterOf = {}) {
  let t = 1_000_000;
  const th = new RequestThrottle({ now: () => t, ...opts });
  return {
    th,
    advance: (s: number) => {
      t += s * S;
    },
  };
}
type ParameterOf = {
  cooldownS?: number;
  spacingS?: number;
  hourlyCap?: number;
};

describe("RequestThrottle", () => {
  it("cooldown por usuario activo cuando es el único límite", () => {
    const { th, advance } = rig({ cooldownS: 60, spacingS: 0, hourlyCap: 0 });
    expect(th.check("u1")).toEqual({ ok: true });
    th.commit("u1");
    advance(10);
    const r = th.check("u1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("user");
      expect(r.waitS).toBe(50);
    }
  });

  it("espaciado GLOBAL: usuarios distintos comparten el per-listener de la radio", () => {
    const { th, advance } = rig({ cooldownS: 60, spacingS: 60, hourlyCap: 0 });
    expect(th.check("a").ok).toBe(true);
    th.commit("a");
    advance(10);
    const r = th.check("b"); // otro usuario, mismo IP de salida → igual espera
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("global");
      expect(r.waitS).toBe(50);
    }
  });

  it("tope horario global (per-listener hourly cap): pasa N, bloquea la N+1", () => {
    const { th, advance } = rig({ cooldownS: 60, spacingS: 60, hourlyCap: 3 });
    // 3 pedidos espaciados legalmente
    for (const u of ["u1", "u2", "u3"]) {
      expect(th.check(u).ok).toBe(true);
      th.commit(u);
      advance(61);
    }
    const r = th.check("u4");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("debía bloquear");
    expect(r.kind).toBe("cap");
    // el primero entró en t0; expira 3600s después; ya pasaron 3×61s
    expect(r.waitS).toBe(3600 - 3 * 61);
  });

  it("el cap se libera al madurar la hora del pedido más viejo", () => {
    const { th, advance } = rig({ cooldownS: 0, spacingS: 0, hourlyCap: 1 });
    expect(th.check("u1").ok).toBe(true);
    th.commit("u1");
    advance(3601);
    expect(th.check("u2").ok).toBe(true);
  });

  it("orden de chequeo: usuario → global → cap (mensaje más útil primero)", () => {
    const { th, advance } = rig({ cooldownS: 60, spacingS: 60, hourlyCap: 1 });
    expect(th.check("a").ok).toBe(true); // consume el cap
    th.commit("a");
    advance(5);
    // 'a' mismo usuario: cooldown (wait 55) pisa al global (55) y al cap
    const r = th.check("a");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("debía bloquear");
    expect(r.kind).toBe("user");
  });

  it("todo en 0 → sin throttle local (lazy: la radio igual cuida con 429s)", () => {
    const { th } = rig({ cooldownS: 0, spacingS: 0, hourlyCap: 0 });
    expect(th.check("x").ok).toBe(true);
    expect(th.check("x").ok).toBe(true);
  });

  it("commit es manual: check no gasta el cap", () => {
    const { th } = rig({ cooldownS: 0, spacingS: 0, hourlyCap: 1 });
    th.check("a"); // solo check
    expect(th.check("b").ok).toBe(true); // no gastó (el commit lo hace /pedir al 202)
  });
});
