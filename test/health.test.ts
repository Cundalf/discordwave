import { describe, expect, it } from "vitest";
import { RadioHealth } from "../src/radio/health.js";

describe("RadioHealth", () => {
  it("arranca asumido saludable (el bot no arranca con la radio toasted)", () => {
    expect(new RadioHealth().healthy).toBe(true);
  });

  it("markOffline impide falsos positivos yambia al tenant", () => {
    const h = new RadioHealth();
    h.markOffline("401");
    expect(h.healthy).toBe(false);
    expect(h.reason).toBe("401");
  });

  it("markOnline vuelve a verde y reporta el evento al callback", () => {
    const events: { state: string; reason: string | null }[] = [];
    const h = new RadioHealth((state, reason) => events.push({ state, reason }));
    h.markOffline("served");
    expect(h.healthy).toBe(false);
    h.markOnline();
    expect(h.healthy).toBe(true);
    // idempotente: onlinex2 no duplica evento
    h.markOnline();
    expect(events).toEqual([
      { state: "offline", reason: "served" },
      { state: "online", reason: null },
    ]);
  });

  it("on change en online inicial no es evento (no spamea al boot)", () => {
    const events: unknown[] = [];
    new RadioHealth((s) => events.push(s)); // sin mark inicial
    expect(events).toEqual([]);
  });
});
