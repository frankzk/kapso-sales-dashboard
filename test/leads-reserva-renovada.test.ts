// La reserva de un lead se renueva mientras la ficha está abierta (MOM,
// 14-10-2026). Antes vencía a los 10 minutos de abrirla aunque la asesora
// siguiera con la clienta, y otra podía tomarlo encima: Daphne y Ross tenían
// el mismo lead a la vez.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIM_HEARTBEAT_MS, CLAIM_TTL_MINUTES, shouldRenewClaim } from "@/lib/leads";

const server = readFileSync(resolve(process.cwd(), "app/dashboard/leads/actions.ts"), "utf8");
const ui = readFileSync(resolve(process.cwd(), "components/leads.tsx"), "utf8");

describe("cuándo se renueva", () => {
  it("el latido es más corto que la reserva: nunca vence con la ficha en uso", () => {
    expect(CLAIM_HEARTBEAT_MS).toBe(3 * 60_000);
    expect(CLAIM_HEARTBEAT_MS).toBeLessThan(CLAIM_TTL_MINUTES * 60_000);
  });

  it("solo si la asesora tocó la página en los últimos 10 minutos", () => {
    const now = Date.parse("2026-10-14T20:00:00Z");
    expect(shouldRenewClaim(now - 2 * 60_000, now)).toBe(true);
    expect(shouldRenewClaim(now - 9 * 60_000, now)).toBe(true);
    // Una ficha olvidada abierta suelta el lead sola, como antes.
    expect(shouldRenewClaim(now - 10 * 60_000, now)).toBe(false);
    expect(shouldRenewClaim(now - 60 * 60_000, now)).toBe(false);
  });
});

describe("la renovación en el servidor", () => {
  const fn = server.slice(server.indexOf("export async function renewLeadClaim"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));

  it("renueva solo la reserva PROPIA y todavía viva", () => {
    expect(body).toContain('.eq("claimed_by", ctx.userId)');
    expect(body).toContain('.gt("claimed_at", cutoff)');
  });

  it("si otra la tomó, no se la quita: dice quién la tiene", () => {
    expect(body).toContain("tomó este lead mientras lo tenías abierto");
    expect(body).not.toMatch(/update\(\{\s*claimed_by/);
  });
});

describe("la ficha", () => {
  it("late mientras está abierta y avisa si perdió el lead", () => {
    expect(ui).toContain("renewLeadClaim(openLeadId)");
    expect(ui).toContain("shouldRenewClaim(lastActivityRef.current, Date.now())");
    expect(ui).toContain("CLAIM_HEARTBEAT_MS");
    expect(ui).toContain("if (res.error && activeLeadIdRef.current === openLeadId) setBanner(res.error);");
  });
});

describe("MOM", () => {
  it("documenta la reserva renovada", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("La reserva de la ficha abierta también se renueva (14-10-2026)");
  });
});
