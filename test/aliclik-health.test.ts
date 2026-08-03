import { describe, expect, it } from "vitest";
import {
  resolveAliclikHealth,
  withinBusinessHoursPeru,
  HEALTH_FRESHNESS_MS,
} from "@/lib/aliclik-health";

const NOW = Date.parse("2026-08-03T18:00:00.000Z"); // 13:00 Perú

describe("resolveAliclikHealth", () => {
  it("verde cuando la última sonda OK es fresca", () => {
    const latest = { status: "operativo", checkedAt: new Date(NOW - 60_000).toISOString() };
    expect(resolveAliclikHealth(latest, NOW)).toBe("operativo");
  });

  it("rojo cuando la última sonda fresca reporta fallos", () => {
    const latest = { status: "fallos", checkedAt: new Date(NOW - 120_000).toISOString() };
    expect(resolveAliclikHealth(latest, NOW)).toBe("fallos");
  });

  it("gris cuando no hay ninguna sonda", () => {
    expect(resolveAliclikHealth(null, NOW)).toBe("sin_monitoreo");
  });

  it("gris cuando la última sonda es vieja (de noche o cron caído)", () => {
    const stale = { status: "operativo", checkedAt: new Date(NOW - HEALTH_FRESHNESS_MS - 1).toISOString() };
    expect(resolveAliclikHealth(stale, NOW)).toBe("sin_monitoreo");
  });

  it("gris ante una fecha del futuro (reloj torcido), no verde a ciegas", () => {
    const future = { status: "operativo", checkedAt: new Date(NOW + 5 * 60_000).toISOString() };
    expect(resolveAliclikHealth(future, NOW)).toBe("sin_monitoreo");
  });

  it("gris ante un status desconocido", () => {
    const weird = { status: "otra_cosa", checkedAt: new Date(NOW).toISOString() };
    expect(resolveAliclikHealth(weird, NOW)).toBe("sin_monitoreo");
  });
});

describe("withinBusinessHoursPeru", () => {
  const at = (utc: string) => withinBusinessHoursPeru(new Date(utc));

  it("dentro: 7am–11pm Perú", () => {
    expect(at("2026-08-03T12:00:00Z")).toBe(true); // 07:00 Perú
    expect(at("2026-08-03T18:00:00Z")).toBe(true); // 13:00 Perú
    expect(at("2026-08-04T03:30:00Z")).toBe(true); // 22:30 Perú
  });

  it("fuera: madrugada Perú", () => {
    expect(at("2026-08-03T09:00:00Z")).toBe(false); // 04:00 Perú
    expect(at("2026-08-04T05:00:00Z")).toBe(false); // 00:00 Perú
    expect(at("2026-08-04T04:30:00Z")).toBe(false); // 23:30 Perú
  });
});
