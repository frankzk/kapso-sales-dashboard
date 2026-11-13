// La guía de Aliclik deja «en devolución» la caja de Grupo GF que el
// motorizado todavía tiene «No entregado» (owner, 12-11-2026: «de acuerdo»;
// 0329, MOM §9.5).
//
// #KP203491 (Lima): Alexis reportó KP203491-S01 «No entregado · no contesta»
// el 07-11 y todavía la tiene (custodia `courier`). El 11-11 una asesora creó
// desde la ficha la guía del reintento por Aliclik, KP203491-S02, custodia
// `empresa`, armada desde stock. El pedido seguía en «Por reprogramar Lima» y en
// «Reintentos Aliclik». Ahora la S01 queda como la de «Sacar con salida nueva»
// (custodia `retorno` y `output_replaced`), su solicitud de Grupo GF se cierra y,
// al recibirla en oficina, vuelve a stock.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => null, getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/agent-names", () => ({ resolveAgentNames: async () => ({}) }));

import {
  GF_REPLACE_WITH_ALICLIK_RPC,
  isReplacedOwnOutput,
  officeReturnOutcome,
  ownBoxStillWithRider,
  replacedByGuideFrom,
  replacedByGuideNotice,
  replacedOutputIds,
} from "@/lib/gf-replaced-output";
import { resolveMacroStage, type MacroEventSnapshot, type MacroGuideSnapshot } from "@/lib/order-macro-stage";
import { limaRetryChain, type ChainAttempt } from "@/lib/lima-retry-chain";
import { retryChainOf } from "@/lib/repro-lima-access";
import { gfReturnDecision } from "@/lib/gf-returns-scan";
import { replacedReceivedMessage } from "@/lib/gf-scan-return";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const D = (day: string, h: string) => `2026-11-${day}T${h}:00.000Z`;

function guide(over: Partial<MacroGuideSnapshot>): MacroGuideSnapshot {
  return {
    id: "x",
    courier: "propio",
    delivery_status: "pendiente",
    attempts: 0,
    assigned_at: null,
    dispatched_at: null,
    out_for_delivery_at: null,
    rescheduled_at: null,
    returned_at: null,
    pickup_state: null,
    preparation_state: null,
    custody_state: null,
    ...over,
  };
}

// KP203491-S01: Alexis, caja del 07-11, «No entregado · no contesta».
const s01 = (over: Partial<MacroGuideSnapshot> = {}) => guide({
  id: "s01",
  courier: "propio",
  preparation_state: "listo_despacho",
  custody_state: "courier",
  assigned_at: D("07", "10:00"),
  dispatched_at: D("07", "14:00"),
  created_at: D("06", "10:00"),
  ...over,
});
// KP203491-S02: la guía de Aliclik del 11-11, desde stock, en la empresa.
const s02 = (over: Partial<MacroGuideSnapshot> = {}) => guide({
  id: "s02",
  courier: "aliclik",
  preparation_state: "rotulo_generado",
  custody_state: "empresa",
  assigned_at: D("11", "15:00"),
  created_at: D("11", "15:00"),
  ...over,
});
const failed: MacroEventSnapshot = {
  kind: "stop_reported", occurred_at: D("07", "20:00"), shipment_id: "s01",
  payload: { status: "no_entregado", outcome_reason: "no_contesta" },
};
const guideRegistered: MacroEventSnapshot = { kind: "guide_registered", occurred_at: D("11", "15:00"), shipment_id: null };
// Lo que deja `gf_replace_output_with_aliclik` (0329) sobre la S01.
const replacedByAliclik: MacroEventSnapshot = {
  kind: "output_replaced", occurred_at: D("11", "15:00"), shipment_id: "s01",
  payload: { replaced_by: "s02", replaced_by_code: "KP203491-S02", replaced_by_courier: "aliclik", request_closed: true },
};

function lima(guides: MacroGuideSnapshot[], events: MacroEventSnapshot[]) {
  return resolveMacroStage({
    order: {
      created_at: D("05", "10:00"), cancelled_at: null, financial_status: "pending", shipping_mode: "cod",
      region: "Lima", province: "Lima", district: "Surco", coverage: "lima",
    },
    guides,
    events,
    legacy: { general: "en_proceso", operational: "asignado_a_courier", since: D("05", "10:00") },
    paymentState: null,
  });
}

const isReproLima = (state: { stage: string; substage: string }) => state.stage === "en_curso" && state.substage === "por_reprogramar_lima";

describe("#KP203491: la guía de Aliclik saca el pedido de «Por reprogramar Lima»", () => {
  it("antes del arreglo: con la S01 todavía con el motorizado, el «No entregado» manda", () => {
    expect(isReproLima(lima([s01(), s02()], [failed, guideRegistered]))).toBe(true);
  });

  it("con la S01 en devolución por la guía de Aliclik, el pedido sigue a la guía", () => {
    const replaced = s01({ custody_state: "retorno" });
    const state = lima([replaced, s02()], [failed, guideRegistered, replacedByAliclik]);
    expect(isReproLima(state)).toBe(false);
    expect(state.stage).toBe("preparacion");
    // Armada, Por despachar; recogida por Aliclik, En curso con la guía.
    expect(lima([replaced, s02({ preparation_state: "listo_despacho" })], [failed, replacedByAliclik]).stage).toBe("por_despachar");
    const picked = s02({ preparation_state: "listo_despacho", custody_state: "courier", dispatched_at: D("12", "10:00") });
    const inCourse = lima([replaced, picked], [failed, replacedByAliclik]);
    expect(inCourse.stage).toBe("en_curso");
    expect(inCourse.substage).not.toBe("por_reprogramar_lima");
  });

  it("la marca es el evento: la custodia `retorno` sola no reemplaza", () => {
    const ids = replacedOutputIds([failed, replacedByAliclik]);
    expect(isReplacedOwnOutput({ id: "s01", courier: "propio", delivery_status: "pendiente", custody_state: "retorno" }, ids)).toBe(true);
    expect(isReplacedOwnOutput({ id: "s01", courier: "propio", delivery_status: "pendiente", custody_state: "retorno" }, new Set())).toBe(false);
  });

  it("la cadena de reintentos ya no propone otro intento: el pedido no está en la etapa", () => {
    const alexis: ChainAttempt = { carrier: "alexis", reason: "no_contesta", at: "2026-11-07T17:00:00.000Z" };
    const chain = limaRetryChain([alexis], new Date("2026-11-11T16:00:00.000Z"));
    expect(chain).toMatchObject({ state: "siguiente", attempt: 2, next: "autoecom" });
    const box = { kind: "con_motorizado" as const, riderName: "Alexis", since: "2026-11-07" };
    const before = lima([s01(), s02()], [failed, guideRegistered]);
    const after = lima([s01({ custody_state: "retorno" }), s02()], [failed, guideRegistered, replacedByAliclik]);
    expect(retryChainOf({ retryChain: chain, cancelled: false, inStage: isReproLima(before), box }, null, "2026-11-11")).not.toBeNull();
    expect(retryChainOf({ retryChain: chain, cancelled: false, inStage: isReproLima(after), box }, null, "2026-11-11")).toBeNull();
  });

  it("la parada fallida de Alexis sigue contando: si AUTOECOM también falla, toca ALIDRIVER (3 de 3)", () => {
    const chain = limaRetryChain([
      { carrier: "alexis", reason: "no_contesta", at: "2026-11-07T17:00:00.000Z" },
      { carrier: "autoecom", reason: "no_contesta", at: "2026-11-12T15:00:00.000Z" },
    ], new Date("2026-11-13T15:00:00.000Z"));
    expect(chain).toMatchObject({ state: "siguiente", attempt: 3, of: 3, next: "alidriver" });
  });
});

describe("«Recibir en oficina» de la S01: a stock, no a «por asignar»", () => {
  it("la base la deja devuelta y la recepción la lee reemplazada", () => {
    expect(officeReturnOutcome("devuelto", true)).toBe("a_stock_reemplazada");
    expect(officeReturnOutcome("empresa", false)).toBe("por_asignar");
  });

  it("el escaneo de Devoluciones la recibe a stock y el aviso nombra la guía de Aliclik", () => {
    const facts = { box: { riderName: "Alexis", routeDate: "2026-11-07", stopStatus: "no_entregado" }, custodyState: "retorno", receivedInOffice: false, replaced: true };
    expect(gfReturnDecision("KP203491-S01", facts)).toEqual({ kind: "recibir", toStock: true });
    expect(replacedReceivedMessage("KP203491-S01", "Alexis", "2026-11-07", "KP203491-S02")).toContain("El pedido sale con KP203491-S02");
  });
});

describe("cuándo se le pregunta a la base y qué se dice", () => {
  it("solo con una caja de Grupo GF todavía con el motorizado entre las salidas vivas", () => {
    expect(ownBoxStillWithRider([{ courier: "propio", delivery_status: "pendiente", custody_state: "courier" }])).toBe(true);
    expect(ownBoxStillWithRider([{ courier: "propio", delivery_status: "pendiente", custody_state: "empresa" }])).toBe(false);
    expect(ownBoxStillWithRider([{ courier: "propio", delivery_status: "pendiente", custody_state: "retorno" }])).toBe(false);
    expect(ownBoxStillWithRider([{ courier: "propio", delivery_status: "pendiente", custody_state: "courier", returned_at: "2026-11-10T10:00:00Z" }])).toBe(false);
    expect(ownBoxStillWithRider([{ courier: "tanders", delivery_status: "en_ruta", custody_state: "courier" }])).toBe(false);
    expect(ownBoxStillWithRider([])).toBe(false);
  });

  it("lee la respuesta de la base y lo dice en el aviso de la guía", () => {
    const replaced = replacedByGuideFrom({
      order_id: "o", replaced: [{ shipment_id: "s01", old_code: "KP203491-S01", rider: "Alexis", request_id: "r" }, { nope: 1 }],
      skipped: [],
    });
    expect(replaced).toEqual([{ shipmentId: "s01", oldCode: "KP203491-S01", riderName: "Alexis" }]);
    expect(replacedByGuideNotice(replaced)).toBe(
      "KP203491-S01 sigue con Alexis: queda en devolución y su solicitud de Grupo GF se cerró. Al recibirla en oficina se desarma y vuelve a stock.",
    );
    expect(replacedByGuideFrom({ replaced: [], skipped: "no_es_lima" })).toEqual([]);
    expect(replacedByGuideFrom(null)).toEqual([]);
    expect(replacedByGuideNotice([])).toBeNull();
  });
});

describe("las piezas en el código", () => {
  const migration = read("db/migrations/0329_gf_replaced_by_aliclik.sql");
  const fn = migration.slice(migration.indexOf("create or replace function public.gf_replace_output_with_aliclik"), migration.indexOf("revoke all"));

  it("la 0329: retorno y output_replaced en la salida anterior, sin security definer y solo del servidor", () => {
    expect(GF_REPLACE_WITH_ALICLIK_RPC).toBe("gf_replace_output_with_aliclik");
    expect(fn).toContain("update shipments set custody_state = 'retorno' where id = v_old.id;");
    expect(fn).toMatch(/insert into order_events[\s\S]*'output_replaced'[\s\S]*'replaced_by', v_new\.id, 'replaced_by_code', v_new\.output_code/);
    expect(fn).toMatch(/insert into dispatch_events[\s\S]*'output_replaced'/);
    expect(fn).not.toContain("security definer");
    expect(migration).toContain("revoke all on function public.gf_replace_output_with_aliclik(uuid, uuid) from public, anon, authenticated;");
    expect(migration).toContain("grant execute on function public.gf_replace_output_with_aliclik(uuid, uuid) to service_role;");
  });

  it("solo la caja con el motorizado, «No entregado» antes de la guía, sin recibir ni reemplazar, en Lima", () => {
    expect(fn).toContain("coverage = 'lima'");
    expect(fn).toContain("v_old.custody_state is distinct from 'courier' or v_old.returned_at is not null");
    expect(fn).toContain("if gf_output_replaced(v_old.id) then");
    expect(fn).toContain("v_stop.status <> 'no_entregado'");
    expect(fn).toContain("coalesce(v_stop.reported_at, v_stop.created_at) >= v_guide_at");
  });

  it("la solicitud de Grupo GF se CIERRA y no pasa a la guía; la parada no se toca", () => {
    expect(fn).toMatch(/update logistics_requests\s+set status = 'cancelled', observation = v_note\s+where shipment_id = v_old\.id and status not in \('cancelled', 'completed'\)/);
    expect(fn).not.toMatch(/update logistics_requests[^;]*set shipment_id/);
    expect(fn).not.toMatch(/update delivery_stops/);
    expect(fn).not.toMatch(/delete from/);
  });

  it("el barrido corre la misma función, la guía más antigua primero", () => {
    const backfill = migration.slice(migration.indexOf("do $$"));
    expect(backfill).toContain("perform public.gf_replace_output_with_aliclik(r.id, null);");
    expect(backfill).toContain("order by greatest(a.created_at, a.assigned_at), a.id");
  });

  it("la creación de la guía la llama antes de recalcular el Master, y el rescate de la huérfana también", () => {
    const guide = read("lib/aliclik-guide.ts");
    const create = guide.slice(guide.indexOf("export async function createAliclikGuideFor"));
    const call = create.indexOf("replaceOwnBoxWithAliclikGuide(admin, written.shipmentId, ctx.userId)");
    expect(call).toBeGreaterThan(0);
    expect(create.indexOf("ownBoxStillWithRider(finalOutputPolicy.estorban)")).toBeGreaterThan(0);
    expect(call).toBeLessThan(create.lastIndexOf("await recomputeOrderMasterSafe(admin, [orderId]);"));
    const cron = read("app/api/cron/aliclik-reconcile/route.ts");
    expect(cron).toContain("replaceOwnBoxWithAliclikGuide(admin, insertedId, null)");
    const server = read("lib/gf-replaced-by-guide.ts");
    expect(server).toContain('import "server-only";');
    expect(server).toContain("admin.rpc(GF_REPLACE_WITH_ALICLIK_RPC");
  });

  it("el smoke está en verify-db, el DEPLOY lo explica y el MOM lo documenta", () => {
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/gf_replaced_by_aliclik_smoke.sql");
    expect(read("DEPLOY.md")).toContain("0329_gf_replaced_by_aliclik.sql");
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("La guía de Aliclik deja en devolución la caja de Grupo GF");
    expect(mom).toContain("gf_replace_output_with_aliclik");
  });
});
