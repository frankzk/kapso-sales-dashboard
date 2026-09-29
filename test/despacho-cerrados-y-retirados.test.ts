import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSED_FOR_ASSIGNMENT_STAGES, takenIsAssignable } from "@/lib/dispatch-day";

/**
 * 29-09-2026: tres pedidos anulados (#KP136160, #KP136100, #KP136653) seguían
 * asignables en «Desde la lista», y cinco solicitudes quedaron «scheduled»
 * sin caja después de «Quitar» (#KP136039, #KP136010, #KP135989, #KP137239,
 * #KP137430).
 */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("un tomado cerrado no se asigna", () => {
  it("Por cerrar y Finalizado quedan fuera; la cola y Por reprogramar Lima no", () => {
    expect(CLOSED_FOR_ASSIGNMENT_STAGES).toEqual(["por_cerrar", "finalizado"]);
    expect(takenIsAssignable("finalizado")).toBe(false);
    expect(takenIsAssignable("por_cerrar")).toBe(false);
    expect(takenIsAssignable("por_despachar")).toBe(true);
    expect(takenIsAssignable("preparacion")).toBe(true);
    expect(takenIsAssignable("en_curso")).toBe(true);
  });

  it("sin etapa en el Master no se esconde", () => {
    expect(takenIsAssignable(null)).toBe(true);
    expect(takenIsAssignable(undefined)).toBe(true);
  });

  it("la pantalla lo pasa a seguimiento y el servidor lo rechaza", () => {
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain(".filter((o) => !o.route && takenIsAssignable(o.macroStage))");
    expect(board).toContain(".filter((o) => o.route || !takenIsAssignable(o.macroStage))");
    const action = read("app/dashboard/courier/actions.ts");
    const core = action.slice(action.indexOf("async function assignRouteCore("), action.indexOf("async function routeCashForecast("));
    expect(core).toContain("if (!takenIsAssignable(stageByOrder.get(request.order_id)))");
  });

  it("la solicitud no se cancela sola al cerrarse el pedido", () => {
    const action = read("app/dashboard/courier/actions.ts");
    expect(action).not.toMatch(/status: "cancelled"[^\n]*finalizado/);
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("La solicitud no se cancela sola al cerrarse el\npedido");
  });
});

describe("quitar de la caja devuelve la solicitud a «por asignar»", () => {
  it("removeManifestItem revierte scheduled → accepted con evento", () => {
    const despacho = read("app/dashboard/pedidos/despacho/actions.ts");
    const body = despacho.slice(despacho.indexOf("export async function removeManifestItem("), despacho.indexOf("async function finalizeBoxIfComplete("));
    expect(body).toContain('.update({ status: "accepted", observation: cleanReason.slice(0, 300) })');
    expect(body).toContain('.eq("status", "scheduled")');
    expect(body).toContain('kind: "route_removed"');
  });

  it("mover a otra caja deja la solicitud en scheduled", () => {
    const action = read("app/dashboard/courier/actions.ts");
    const move = action.slice(action.indexOf("export async function moveManifestItem("), action.indexOf("export type ScanAssignStatus"));
    expect(move).toContain('.update({ observation: null, status: "scheduled" })');
  });

  it("0200 repara las huérfanas una sola vez y con rastro", () => {
    const sql = read("db/migrations/0200_gf_orphan_scheduled_requests.sql");
    expect(sql).toContain("r.status = 'scheduled'");
    expect(sql).toContain("i.removed_at is null");
    expect(sql).toContain("insert into logistics_request_events");
    expect(sql).toContain("'route_removed_repair'");
  });
});
