// El escaneo del manifiesto de devolución (0307), con la base, el buscador, el
// reporte de paradas y la recepción simulados: que la regla 4 («Llegó a oficina
// sin reporte») reporte primero por la vía única y después reciba; que un
// reporte fallido quede como observación sin recibir; que una salida de otra
// tienda se rechace antes de escribir nada; y que lo no encontrado pida nota.
// También la foto: con 20 no se sube otra.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { fn: string; args: Record<string, unknown> };

const state = vi.hoisted(() => ({
  header: { id: "rm-1", org_id: "org-1", courier: "propio", rider_id: "rider-alexis", state: "open", label: "Devolución · Alexis · 04/11", photo_paths: [] as string[] },
  candidates: [] as Record<string, unknown>[],
  facts: null as unknown,
  report: { ok: true } as { ok: boolean; error?: string },
  reports: [] as Record<string, unknown>[],
  rpcs: [] as Call[],
  uploads: [] as string[],
  storeIds: new Set(["store-1"]),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "persona" }) }));
vi.mock("@/lib/scan-cancelled", () => ({ cancelledScanNotice: async () => null }));
vi.mock("@/lib/repro-lima-program", () => ({ REPRO_LIMA_PATH: "/dashboard/pedidos/repro-lima" }));
vi.mock("@/lib/return-manifest-access", () => ({
  RETURN_MANIFESTS_PATH: "/dashboard/pedidos/devoluciones",
  returnManifestPath: (id: string) => `/dashboard/pedidos/devoluciones/manifiestos/${id}`,
  returnManifestAccess: async () => ({ ok: true, userId: "persona", storeIds: state.storeIds }),
}));
vi.mock("@/lib/dispatch-scan-lookup", () => ({
  SCAN_NOT_FOUND: "No encontramos una salida con ese QR, guía o número de pedido.",
  ambiguousScanError: () => "Ese número de pedido tiene varias salidas: escanea el QR.",
  findScanCandidatesWith: async () => ({ candidates: state.candidates, byOrderName: false, hold: null }),
}));
vi.mock("@/lib/stop-report", () => ({
  writeStopReport: async (_admin: unknown, input: Record<string, unknown>) => {
    state.reports.push(input);
    state.rpcs.push({ fn: "writeStopReport", args: {} });
    return state.report;
  },
}));
vi.mock("@/lib/gf-office-receipt", () => ({
  loadGfBoxFacts: async () => state.facts,
  afterGfOfficeReceipt: async () => ({ outcome: "por_asignar", reproParts: [] }),
}));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "limit", "order", "update"]) q[m] = () => q;
    q.maybeSingle = async () => (table === "return_manifests" ? { data: state.header, error: null } : { data: null, error: null });
    q.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
    return q;
  };
  const admin = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcs.push({ fn, args });
      if (fn === "return_manifest_receive") {
        return { data: { line_id: "line-1", order_id: "order-1", receipt_outcome: "por_asignar", flags: args.p_flags }, error: null };
      }
      return { data: "line-1", error: null };
    },
    storage: {
      createBucket: async () => ({}),
      from: () => ({ upload: async (path: string) => { state.uploads.push(path); return { error: null }; } }),
    },
  };
  return { createAdminSupabase: () => admin, createServerSupabase: async () => ({ from }) };
});

import { scanReturnManifest } from "@/app/dashboard/pedidos/devoluciones/manifest-actions";
import { POST as uploadPhoto } from "@/app/api/pedidos/devoluciones/manifiestos/[id]/foto/route";

const SHIPMENT = (over: Record<string, unknown> = {}) => ({
  id: "ship-1", store_id: "store-1", courier: "propio", guide_code: "MOM-KP1", output_code: "KP1-S01", output_number: 1,
  custody_state: "courier", preparation_state: "listo_despacho", order_id: "order-1", order_name: "#KP1", ...over,
});

const FACTS = (stop: Record<string, unknown> | null, routeStatus: string | null = "en_curso") => ({
  item: { id: "item-1", manifestId: "box-1" },
  box: { riderId: "rider-alexis", riderName: "Alexis", routeDate: "2026-11-02", deliveryRouteId: "route-1" },
  stop: stop ? { id: "stop-1", status: "pendiente", outcomeReason: null, routeId: "route-1", orderId: "order-1", photoPath: null, voucherPath: null, ...stop } : null,
  routeStatus,
  receivedInOffice: false,
  replaced: false,
  saleEnded: false,
});

beforeEach(() => {
  state.header = { id: "rm-1", org_id: "org-1", courier: "propio", rider_id: "rider-alexis", state: "open", label: "Devolución · Alexis · 04/11", photo_paths: [] };
  state.candidates = [SHIPMENT()];
  state.facts = FACTS({ status: "no_entregado", outcomeReason: "no_contesta" });
  state.report = { ok: true };
  state.reports = [];
  state.rpcs = [];
  state.uploads = [];
  state.storeIds = new Set(["store-1"]);
});

describe("scanReturnManifest", () => {
  it("un «No entregado» de este motorizado se recibe con la recepción del manifiesto, sin reportar nada", async () => {
    const res = await scanReturnManifest("rm-1", "KP1-S01");
    expect(res).toMatchObject({ ok: true, kind: "recibido", lineId: "line-1", receiptOutcome: "por_asignar" });
    expect(state.rpcs.map((c) => c.fn)).toEqual(["return_manifest_receive"]);
    expect(state.rpcs[0]!.args).toMatchObject({ p_manifest_id: "rm-1", p_item_id: "item-1", p_actor: "persona", p_scanned_code: "KP1-S01", p_flags: [] });
  });

  it("regla 4: parada pendiente con la ruta en curso → reporta «No entregado · otro», sin cobro, y DESPUÉS recibe con «sin_reporte»", async () => {
    state.facts = FACTS({ status: "pendiente" }, "en_curso");
    const res = await scanReturnManifest("rm-1", "KP1-S01");
    expect(res).toMatchObject({ ok: true, kind: "recibido", flags: ["sin_reporte"] });
    expect(state.rpcs.map((c) => c.fn)).toEqual(["writeStopReport", "return_manifest_receive"]);
    expect(state.reports[0]).toEqual({
      stopId: "stop-1",
      status: "no_entregado",
      paymentMethod: null,
      collectedAmount: null,
      outcomeReason: "otro",
      note: "Llegó a oficina sin reporte · Devolución · Alexis · 04/11",
      actor: "persona",
    });
    expect(state.rpcs[1]!.args).toMatchObject({ p_item_id: "item-1", p_flags: ["sin_reporte"] });
    expect(res.notice).toContain("llegó sin reporte: se reportó «No entregado · Llegó a oficina sin reporte» y se recibió");
  });

  it("regla 4 con el reporte fallido: observación «sin reporte», no se recibe", async () => {
    state.facts = FACTS({ status: "pendiente" }, "en_curso");
    state.report = { ok: false, error: "La ruta ya se cerró." };
    const res = await scanReturnManifest("rm-1", "KP1-S01");
    expect(res).toMatchObject({ ok: true, kind: "observacion", flags: ["sin_reporte"] });
    expect(state.rpcs.map((c) => c.fn)).toEqual(["writeStopReport", "return_manifest_note"]);
    expect(state.rpcs[1]!.args).toMatchObject({ p_outcome: "held", p_flags: ["sin_reporte"], p_shipment_id: "ship-1", p_item_id: "item-1" });
    expect(state.rpcs.some((c) => c.fn === "return_manifest_receive")).toBe(false);
  });

  it("parada pendiente con la ruta ya cerrada: observación, sin reportar ni recibir", async () => {
    state.facts = FACTS({ status: "pendiente" }, "cerrada");
    const res = await scanReturnManifest("rm-1", "KP1-S01");
    expect(res).toMatchObject({ ok: true, kind: "observacion", flags: ["sin_reporte"] });
    expect(state.rpcs.map((c) => c.fn)).toEqual(["return_manifest_note"]);
  });

  it("una salida de otra tienda se rechaza antes de escribir nada", async () => {
    state.candidates = [SHIPMENT({ store_id: "store-otra" })];
    const res = await scanReturnManifest("rm-1", "KP1-S01");
    expect(res).toEqual({ ok: false, kind: "error", error: "No tienes acceso a la tienda de esa salida." });
    expect(state.rpcs).toEqual([]);
    expect(state.reports).toEqual([]);
  });

  it("no encontrada: observación «no identificada» que pide nota, sin salida", async () => {
    state.candidates = [];
    const res = await scanReturnManifest("rm-1", "XX-999");
    expect(res).toMatchObject({ ok: true, kind: "observacion", flags: ["no_identificada"], needsNote: true });
    expect(state.rpcs).toEqual([{ fn: "return_manifest_note", args: expect.objectContaining({ p_flags: ["no_identificada"], p_note: null }) }]);
    expect(state.rpcs[0]!.args).not.toHaveProperty("p_shipment_id");
  });

  it("dos salidas por número de pedido: pide el QR y no escribe", async () => {
    state.candidates = [SHIPMENT({ id: "a", custody_state: "courier" }), SHIPMENT({ id: "b", output_code: "KP1-S02", custody_state: "courier" })];
    const res = await scanReturnManifest("rm-1", "KP1");
    expect(res).toMatchObject({ ok: false, kind: "error" });
    expect(state.rpcs).toEqual([]);
  });

  it("anulado en la tienda ya recibido y a inventario, escaneado otra vez: informativa, no bloquea", async () => {
    state.candidates = [SHIPMENT({ custody_state: "devuelto" })];
    state.facts = { ...FACTS(null), item: null, box: null, saleEnded: true };
    const res = await scanReturnManifest("rm-1", "KP1-S01");
    expect(res).toMatchObject({ ok: true, kind: "informativa", flags: ["ya_recibida"], needsNote: false });
    expect(state.rpcs).toEqual([{ fn: "return_manifest_note", args: expect.objectContaining({ p_outcome: "info", p_flags: ["ya_recibida"] }) }]);
  });

  it("un manifiesto cerrado no recibe", async () => {
    state.header = { ...state.header, state: "closed" };
    expect(await scanReturnManifest("rm-1", "KP1-S01")).toMatchObject({ ok: false, kind: "error" });
    expect(state.rpcs).toEqual([]);
  });
});

describe("la foto del manifiesto", () => {
  const post = () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "acta.jpg", { type: "image/jpeg" }));
    return uploadPhoto({ formData: async () => form } as never, { params: Promise.resolve({ id: "rm-1" }) });
  };

  it("con 20 fotos dice que no caben y no sube nada", async () => {
    state.header = { ...state.header, state: "closed", photo_paths: Array.from({ length: 20 }, (_, i) => `p${i}.jpg`) };
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Ya tiene 20 fotos: no caben más." });
    expect(state.uploads).toEqual([]);
  });

  it("con menos de 20 la sube (también cerrado)", async () => {
    state.header = { ...state.header, state: "closed", photo_paths: ["p0.jpg"] };
    const res = await post();
    expect(res.status).toBe(200);
    expect(state.uploads).toHaveLength(1);
  });
});
