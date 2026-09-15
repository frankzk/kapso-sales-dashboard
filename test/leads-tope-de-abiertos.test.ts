import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_OPEN_LEADS, claimBlockedByCap, claimsBlocking } from "@/lib/leads";

/**
 * Máximo dos leads tomados a la vez por asesora, en la sección de Leads.
 *
 * Decidido el 14-09-2026 sobre 461 reservas y 15 asesoras: promedio 1,18
 * simultáneas, mediana 1, p95 2, pico 5 en tres personas. El 87,4% de las
 * reservas son de una sola; el tope de 2 no las toca y frena las rachas de 3,
 * 4 y 5 (17 de 462).
 *
 * Solo aplica a `leads`. Envíos tiene su propia reserva y el Master de
 * Pedidos no tiene ninguna.
 */

const NOW = new Date("2026-09-14T22:00:00.000Z");
const hace = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const YO = "asesora-1";

const server = readFileSync(resolve(process.cwd(), "app/dashboard/leads/actions.ts"), "utf8");
const ui = readFileSync(resolve(process.cwd(), "components/leads.tsx"), "utf8");

describe("la regla, pura", () => {
  it("el tope es 2", () => {
    expect(MAX_OPEN_LEADS).toBe(2);
  });

  it("con dos vivas ajenas al que pide, bloquea", () => {
    const claims = [
      { id: "a", claimed_by: YO, claimed_at: hace(1) },
      { id: "b", claimed_by: YO, claimed_at: hace(3) },
    ];
    expect(claimBlockedByCap(claims, YO, "c", NOW)).toBe(true);
  });

  it("reabrir uno que ya es mío no cuenta contra el tope", () => {
    const claims = [
      { id: "a", claimed_by: YO, claimed_at: hace(1) },
      { id: "b", claimed_by: YO, claimed_at: hace(3) },
    ];
    // Pide «a», que ya tiene: estorba solo «b», y cabe.
    expect(claimsBlocking(claims, YO, "a", NOW).map((c) => c.id)).toEqual(["b"]);
    expect(claimBlockedByCap(claims, YO, "a", NOW)).toBe(false);
  });

  it("una reserva vencida por TTL ya no estorba", () => {
    // Pestaña cerrada sin soltar: a los diez minutos deja de contar, igual que
    // hoy deja de mostrarse como «Tomado».
    const claims = [
      { id: "a", claimed_by: YO, claimed_at: hace(1) },
      { id: "b", claimed_by: YO, claimed_at: hace(11) },
    ];
    expect(claimBlockedByCap(claims, YO, "c", NOW)).toBe(false);
  });

  it("las reservas de OTRA asesora no cuentan en mi tope", () => {
    const claims = [
      { id: "a", claimed_by: "otra", claimed_at: hace(1) },
      { id: "b", claimed_by: "otra", claimed_at: hace(1) },
      { id: "c", claimed_by: YO, claimed_at: hace(1) },
    ];
    expect(claimBlockedByCap(claims, YO, "d", NOW)).toBe(false);
  });

  it("sin reservas, no bloquea", () => {
    expect(claimBlockedByCap([], YO, "a", NOW)).toBe(false);
  });
});

describe("la acción del servidor", () => {
  it("cuenta las propias, vivas, sin la del lead que se pide", () => {
    const fn = server.slice(server.indexOf("export async function claimLead"));
    const cuerpo = fn.slice(0, 2600);
    expect(cuerpo).toContain('.eq("claimed_by", ctx.userId)');
    expect(cuerpo).toContain('.gt("claimed_at", cutoff)');
    expect(cuerpo).toContain('.neq("id", leadId)');
    expect(cuerpo).toContain("if (abiertos.length >= MAX_OPEN_LEADS) {");
  });

  it("el aviso nombra los leads que hay que soltar", () => {
    // «No» a secas obliga a adivinar cuál cerrar.
    expect(server).toContain("Cierra uno para tomar este.");
    expect(server).toContain('abiertos.map((l) => l.name?.trim() || l.phone || "un lead")');
  });

  it("el tope se comprueba ANTES de escribir la reserva", () => {
    const fn = server.slice(server.indexOf("export async function claimLead"));
    expect(fn.indexOf("MAX_OPEN_LEADS")).toBeLessThan(fn.indexOf(".update({ claimed_by: ctx.userId"));
  });
});

describe("la reserva se suelta aunque la pestaña se cierre", () => {
  it("hay un beacon en pagehide, como en Envíos", () => {
    // Sin esto el tope castigaría cerrar pestañas: dos cerradas a lo bruto son
    // diez minutos bloqueada por leads que ya no mira.
    expect(ui).toContain('window.addEventListener("pagehide", onPageHide);');
    expect(ui).toContain('"/api/leads/release-claim"');
    expect(ui).toContain("navigator.sendBeacon?.(");
  });

  it("y la ruta del beacon solo suelta lo propio", () => {
    const ruta = readFileSync(resolve(process.cwd(), "app/api/leads/release-claim/route.ts"), "utf8");
    expect(ruta).toContain('.eq("claimed_by", userId)');
    expect(ruta).toContain("if (!userId) return new Response(null, { status: 401 });");
  });
});
