// «Tu cliente respondió» (owner, 16-11-2026; 0351): qué leads avisa el aviso
// flotante a quien agendó «Volver a llamar».

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { callbackReturnsFor, type CallbackReturnCallRow, type CallbackReturnLeadRow } from "@/lib/callback-returns";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const STORE = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-11-16T20:03:00.000Z"); // 15:03 en Lima

const lead = (over: Partial<CallbackReturnLeadRow> = {}): CallbackReturnLeadRow => ({
  id: "lead-1", store_id: STORE, name: "Cliente", phone: "51999999999", status: "contactado_dejo_wsp",
  last_inbound_at: "2026-11-16T20:01:30.000Z", next_followup_at: "2026-11-16T15:00:00.000Z",
  claimed_by: null, claimed_at: null, ...over,
});
const booking = (over: Partial<CallbackReturnCallRow> = {}): CallbackReturnCallRow => ({
  id: "call-1", lead_id: "lead-1", vendedora: ME, occurred_at: "2026-11-16T02:26:38.000Z",
  next_followup_at: "2026-11-16T15:00:00.000Z", ...over,
});
const run = (leads: CallbackReturnLeadRow[], calls: CallbackReturnCallRow[], userId = ME, routed = true) =>
  callbackReturnsFor({ userId, leads, calls, nowMs: NOW, routedStores: new Set(routed ? [STORE] : []) });

describe("callbackReturnsFor", () => {
  it("caso del 16-11-2026: cita vencida, la clienta escribe y se le avisa a quien agendó", () => {
    expect(run([lead()], [booking()])).toEqual([{
      id: "lead-1", storeId: STORE, name: "Cliente", phone: "51999999999", view: "por_llamar",
      repliedAt: "2026-11-16T20:01:30.000Z", reservedUntil: "2026-11-16T20:11:30.000Z",
      followupAt: "2026-11-16T15:00:00.000Z", reserved: true,
    }]);
  });

  it("a otra asesora no se le avisa", () => {
    expect(run([lead()], [booking()], OTHER)).toEqual([]);
  });

  it("la dueña es la última llamada con la misma fecha agendada", () => {
    const calls = [booking(), booking({ id: "call-2", vendedora: OTHER, occurred_at: "2026-11-16T03:00:00.000Z" })];
    expect(run([lead()], calls)).toEqual([]);
    expect(run([lead()], calls, OTHER)).toHaveLength(1);
    // Una llamada con otra fecha no la cambia.
    expect(run([lead()], [booking(), booking({ id: "call-3", vendedora: OTHER, occurred_at: "2026-11-16T03:00:00.000Z", next_followup_at: "2026-11-20T15:00:00.000Z" })])).toHaveLength(1);
  });

  it("un mensaje anterior a la cita o de hace 10 minutos o más no avisa", () => {
    expect(run([lead({ last_inbound_at: "2026-11-16T02:00:00.000Z" })], [booking()])).toEqual([]);
    expect(run([lead({ last_inbound_at: "2026-11-16T19:53:00.000Z" })], [booking()])).toEqual([]);
  });

  it("si ya lo abrió después del mensaje no hace falta avisarle", () => {
    expect(run([lead({ claimed_by: ME, claimed_at: "2026-11-16T20:02:00.000Z" })], [booking()])).toEqual([]);
    expect(run([lead({ claimed_by: ME, claimed_at: "2026-11-16T19:58:00.000Z" })], [booking()])).toHaveLength(1);
  });

  it("los Yapes abren en su pestaña y sin reparto no se promete apartado", () => {
    const [item] = run([lead({ status: "yape_por_verificar" })], [booking()], ME, false);
    expect(item).toMatchObject({ view: "yape", reserved: false });
  });
});

describe("el aviso y su lectura", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("se monta para las asesoras y lee por la ruta de lecturas", () => {
    expect(read("components/dashboard-shell.tsx")).toContain("<CallbackReturnAlerts enabled={yapeAlertsEnabled} />");
    expect(read("app/api/leads/read/route.ts")).toContain("listCallbackReturns: z.tuple([]),");
    expect(read("components/callback-return-alerts.tsx")).toContain("Tu cliente respondió");
  });
});
