import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORCED_REFRESH_MS,
  QUIET_REFRESH_MS,
  URGENT_COUNTS,
  decideQueueRefresh,
} from "@/lib/leads-live-refresh";

/**
 * Cuándo recargar el tablero de Leads.
 *
 * EL COSTE. Cada recarga vuelve a bajar la cola entera de «Por llamar» (~2.500
 * leads, cuarenta columnas). El sondeo de la firma cada 30 s evitaba recargar
 * cuando nada cambió, pero en horario de atención cada mensaje de WhatsApp
 * mueve la firma. Medido el 10-09-2026: 24,5 millones de filas de `leads` en
 * 24 horas. Ahora lo urgente («Atender ahora», Yapes) recarga al momento y el
 * resto espera dos minutos.
 */

const T0 = 1_000_000;
const base = {
  prevSignature: "10:a",
  nextSignature: "11:b",
  prevCounts: { handoff: 2, yape: 1 },
  nextCounts: { handoff: 2, yape: 1 },
  lastRefreshAt: T0,
  now: T0 + 30_000,
};

describe("decideQueueRefresh", () => {
  it("un handoff o un Yape nuevo recarga YA, sin esperar la calma", () => {
    expect(decideQueueRefresh({ ...base, nextCounts: { handoff: 3, yape: 1 } })).toBe("urgent");
    expect(decideQueueRefresh({ ...base, nextCounts: { handoff: 2, yape: 0 } })).toBe("urgent");
    expect(URGENT_COUNTS).toEqual(["handoff", "yape"]);
  });

  it("un cambio tranquilo dentro de los dos minutos espera", () => {
    expect(decideQueueRefresh(base)).toBe("skip");
    expect(decideQueueRefresh({ ...base, now: T0 + QUIET_REFRESH_MS - 1 })).toBe("skip");
  });

  it("pasados los dos minutos, el cambio tranquilo sí recarga", () => {
    expect(decideQueueRefresh({ ...base, now: T0 + QUIET_REFRESH_MS })).toBe("quiet");
  });

  it("sin cambio de firma no recarga, aunque haya pasado la calma", () => {
    expect(decideQueueRefresh({ ...base, nextSignature: "10:a", now: T0 + QUIET_REFRESH_MS + 1 })).toBe("skip");
  });

  it("cada cinco minutos recarga pase lo que pase: por si la firma se quedara ciega", () => {
    expect(decideQueueRefresh({ ...base, nextSignature: "10:a", now: T0 + FORCED_REFRESH_MS })).toBe("forced");
    expect(FORCED_REFRESH_MS).toBe(5 * 60_000);
    expect(QUIET_REFRESH_MS).toBe(2 * 60_000);
  });

  it("sin firma previa se comporta como antes: recarga", () => {
    expect(decideQueueRefresh({ ...base, prevSignature: null })).toBe("quiet");
  });

  it("sin contadores previos no hay urgencia que detectar: manda la calma", () => {
    expect(decideQueueRefresh({ ...base, prevCounts: null })).toBe("skip");
  });
});

describe("el tablero la usa", () => {
  const src = readFileSync(resolve(process.cwd(), "components/leads.tsx"), "utf8");

  it("decide con la función pura y NO adelanta la firma cuando salta por calma", () => {
    expect(src).toContain("const decision = decideQueueRefresh({");
    const i = src.indexOf('if (decision === "skip") return;');
    const j = src.indexOf("signatureRef.current = next.signature;");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  it("y el panel de gráficos se recarga como mucho cada cinco minutos", () => {
    expect(src).toContain("const INSIGHTS_MIN_REFRESH_MS = 5 * 60_000;");
    expect(src).toContain("Date.now() - last.at < INSIGHTS_MIN_REFRESH_MS");
  });
});
