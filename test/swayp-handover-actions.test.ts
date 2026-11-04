// «Entregar a Swayp» · Lima (fase 3, owner 04-11-2026; MOM §9.1). Las acciones
// de servidor contra una base en memoria: abrir concilia con el lote, el
// escaneo arma aunque la custodia la haya puesto la sincronización de Swayp, lo
// que no es del lote no entra (y se dice por qué), «No sale» guarda su motivo,
// el cierre exige el 100 %, el nombre y el conteo del chofer, y Grupo GF y la
// Mesa no cambian.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const state = vi.hoisted(() => ({
  allowed: true,
  db: {} as Record<string, Row[]>,
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  seq: 0,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect login"); } }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => state.allowed }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn() }));
vi.mock("@/lib/scan-cancelled", () => ({ cancelledScanNotice: async () => null }));
vi.mock("@/lib/legacy-sale-cancel-access", () => ({ legacySaleManifestBlock: async () => null }));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const tests: Array<(row: Row) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let value: any = null;
    let limit = Infinity;
    const q: any = {};
    const add = (test: (row: Row) => boolean) => { tests.push(test); return q; };
    const ilike = (pattern: string) => new RegExp(`^${String(pattern).replace(/\\([%_])/g, "$1").replace(/[.*+?^${}()|[\]]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
    q.select = () => q;
    q.eq = (c: string, v: unknown) => add((r) => r[c] === v);
    q.neq = (c: string, v: unknown) => add((r) => r[c] !== v);
    q.in = (c: string, vs: unknown[]) => add((r) => vs.includes(r[c]));
    q.is = (c: string, v: unknown) => add((r) => (v === null ? r[c] == null : r[c] === v));
    q.not = (c: string, operator: string, v: unknown) => add((r) => {
      if (operator === "is" && v === null) return r[c] != null;
      if (operator === "in") return !String(v).replace(/[()]/g, "").split(",").includes(String(r[c]));
      return r[c] !== v;
    });
    q.gte = (c: string, v: string) => add((r) => r[c] != null && Date.parse(r[c]) >= Date.parse(v));
    q.lt = (c: string, v: string) => add((r) => r[c] != null && Date.parse(r[c]) < Date.parse(v));
    q.ilike = (c: string, v: string) => add((r) => ilike(v).test(String(r[c] ?? "")));
    q.or = (expr: string) => {
      const parts = expr.split(",").map((part) => part.split(".ilike."));
      return add((r) => parts.some(([c, v]) => ilike(v!).test(String(r[c!] ?? ""))));
    };
    q.order = () => q;
    q.limit = (n: number) => { limit = n; return q; };
    q.insert = (v: any) => { op = "insert"; value = v; return q; };
    q.update = (v: any) => { op = "update"; value = v; return q; };
    const run = () => {
      const rows = (state.db[table] ??= []);
      if (op === "insert") {
        const list: Row[] = (Array.isArray(value) ? value : [value]).map((v: Row): Row => ({
          id: v.id ?? `${table}-${++state.seq}`,
          created_at: new Date().toISOString(),
          ...(table === "dispatch_manifests" ? { state: "draft", received_by: null, custody_completed_at: null, cancelled_at: null, cancellation_reason: null } : {}),
          ...(table === "dispatch_manifest_items" ? { removed_at: null, office_checked_at: null, office_checked_by: null, removal_reason: null } : {}),
          ...v,
        }));
        for (const row of list) {
          // Índices únicos: una salida activa en una sola ruta; una ruta sin motorizado por courier y día.
          const clash = table === "dispatch_manifest_items"
            ? rows.some((r) => r.shipment_id === row.shipment_id && !r.removed_at)
            : table === "dispatch_manifests"
              ? rows.some((r) => r.org_id === row.org_id && r.route_date === row.route_date && r.courier === row.courier && !r.rider_id && r.state !== "cancelled")
              : false;
          if (clash) return { data: null, error: { code: "23505", message: "duplicado" } };
        }
        rows.push(...list);
        return { data: list, error: null };
      }
      const hit = rows.filter((r) => tests.every((t) => t(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, value);
        return { data: hit, error: null };
      }
      return { data: hit.slice(0, limit), error: null };
    };
    q.maybeSingle = q.single = async () => {
      const result = run();
      return { data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: result.error };
    };
    q.then = (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject);
    return q;
  };
  const rpc = async (name: string, args: Record<string, any>) => {
    state.rpc.push({ name, args });
    if (name !== "finalize_dispatch_manifest") throw new Error(`RPC inesperado: ${name}`);
    const manifest = state.db.dispatch_manifests!.find((m) => m.id === args.p_manifest_id)!;
    const items = state.db.dispatch_manifest_items!.filter((i) => i.manifest_id === manifest.id && !i.removed_at);
    if (!items.length) return { data: null, error: { message: "La ruta no tiene paquetes activos." } };
    if (items.some((i) => !i.office_checked_at)) return { data: null, error: { message: "El cotejo de oficina no está completo." } };
    if (!manifest.received_by) return { data: null, error: { message: "Anota quién recoge." } };
    const now = new Date().toISOString();
    for (const item of items) {
      const s = state.db.shipments!.find((x) => x.id === item.shipment_id)!;
      Object.assign(s, { custody_state: "courier", custody_transferred_at: now, custody_transferred_by: args.p_actor });
    }
    Object.assign(manifest, { state: "in_custody", custody_completed_at: now, custody_completed_by: args.p_actor });
    return { data: items.map((i) => state.db.shipments!.find((x) => x.id === i.shipment_id)!.order_id), error: null };
  };
  const client = { from, rpc, auth: { getUser: async () => ({ data: { user: { id: "u-yelitza" } } }) } };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});

import {
  addShipmentToManifest,
  closeSwaypHandover,
  createDispatchManifest,
  markShipmentReady,
  markSwaypNoSale,
  markSwaypNoVino,
  openSwaypHandover,
  scanSwaypHandover,
  undoSwaypNoSale,
} from "@/app/dashboard/pedidos/despacho/actions";
import {
  SWAYP_CLOSE_COUNT_MISMATCH,
  SWAYP_CLOSE_MISSING,
  SWAYP_CLOSE_NOTHING,
  SWAYP_HANDOVER_CLOSED,
  SWAYP_HANDOVER_NOT_DISPATCH_DAY,
  SWAYP_HANDOVER_NO_VINO_DONE,
  SWAYP_HANDOVER_OTRO_DIA,
  SWAYP_HANDOVER_SCAN_NOTE,
  SWAYP_HANDOVER_SCANNED,
  SWAYP_MANIFEST_FROM_ALMACEN,
  SWAYP_NO_SALE_EXPLAIN,
  SWAYP_NO_SALE_PREFIX,
  SWAYP_NO_VINO_REASON,
  SWAYP_SCAN_USE_HANDOVER,
} from "@/lib/swayp-handover";

const WED = "2026-11-04";

function shipment(id: string, order: string, extra: Row = {}): Row {
  return {
    id,
    store_id: "s1",
    order_id: order,
    order_name: `#${order}`,
    courier: "fenix",
    output_code: id,
    output_number: 1,
    guide_code: `g-${id}`,
    qr_token: null,
    swayp_state: 1,
    delivery_status: "en_ruta",
    status_category: "in_route",
    custody_state: "empresa",
    custody_transferred_by: null,
    custody_transferred_at: null,
    preparation_state: "no_iniciado",
    ready_at: null,
    ready_by: null,
    next_followup_at: `${WED}T00:00:00+00:00`,
    created_at: "2026-11-03T15:00:00Z",
    customer_name: "Cliente",
    district: "Surco",
    ...extra,
  };
}

function seed() {
  state.db = {
    stores: [{ id: "s1", org_id: "org1", name: "Kenku Peru" }, { id: "s2", org_id: "org1", name: "Aurela" }],
    order_master: ["KP1", "KP2", "KP3", "KP5"].map((o) => ({ order_id: o, store_id: "s1", macro_operation: "lima", general_status: "en_proceso", order_name: `#${o}` }))
      .concat([{ order_id: "KP4", store_id: "s1", macro_operation: "provincia_cod", general_status: "en_proceso", order_name: "#KP4" }]),
    orders: [],
    shipments: [
      // Armada y en la empresa.
      shipment("KP1-S01", "KP1", { preparation_state: "listo_despacho", ready_at: "2026-11-03T20:00:00Z", ready_by: "u-noche" }),
      // Swayp la cargó a las 05:47 (custodia de la sincronización, sin persona) y nunca se armó.
      shipment("KP2-S02", "KP2", { custody_state: "courier", swayp_state: 5, custody_transferred_at: "2026-11-04T05:47:29+00:00" }),
      // Su S01 salió con Grupo GF el 02-11.
      shipment("KP2-S01", "KP2", { courier: "propio", custody_state: "courier", custody_transferred_by: "u-gf", preparation_state: "listo_despacho", next_followup_at: null, guide_code: "MOM-KP2" }),
      // Swayp la repartió y devolvió antes de su día (KP143987-S02).
      shipment("KP3-S02", "KP3", { custody_state: "retorno", swayp_state: 8 }),
      // Provincia: la arma la bodega de Swayp.
      shipment("KP4-S01", "KP4"),
      // Sale el jueves.
      shipment("KP5-S01", "KP5", { next_followup_at: "2026-11-05T00:00:00+00:00" }),
    ],
    dispatch_manifests: [],
    dispatch_manifest_items: [],
    dispatch_events: [],
    order_events: [],
  };
}

const items = () => state.db.dispatch_manifest_items!;
const ship = (id: string) => state.db.shipments!.find((s) => s.id === id)!;

beforeEach(() => {
  vi.useFakeTimers();
  // Miércoles 4 nov, 07:05 de Lima: el chofer de Swayp llegó.
  vi.setSystemTime(new Date("2026-11-04T12:05:00Z"));
  state.allowed = true;
  state.rpc = [];
  state.seq = 0;
  seed();
});

describe("abrir la entrega", () => {
  it("crea la entrega del día como «Entrega al courier» y la llena con el lote vivo de Lima", async () => {
    const opened = await openSwaypHandover();
    expect(opened.error).toBeUndefined();
    const manifest = state.db.dispatch_manifests![0]!;
    expect(manifest).toMatchObject({ org_id: "org1", courier: "fenix", kind: "entrega_courier", route_date: WED, route_label: "Swayp Lima", rider_id: null });
    expect(opened.manifestId).toBe(manifest.id);
    // Entran la armada y la que cargó la sincronización; no la que Swayp ya cerró,
    // ni provincia, ni la del jueves, ni la salida de Grupo GF.
    expect(items().map((i) => i.shipment_id).sort()).toEqual(["KP1-S01", "KP2-S02"]);
  });

  it("es idempotente: reabrir no duplica filas ni rutas", async () => {
    await openSwaypHandover();
    await openSwaypHandover();
    expect(state.db.dispatch_manifests).toHaveLength(1);
    expect(items()).toHaveLength(2);
  });

  it("sin permiso de Despacho no lee ni escribe", async () => {
    state.allowed = false;
    expect((await openSwaypHandover()).error).toContain("permiso");
    expect(state.db.dispatch_manifests).toEqual([]);
  });

  it("el domingo no hay entrega", async () => {
    vi.setSystemTime(new Date("2026-11-08T12:05:00Z"));
    expect((await openSwaypHandover()).error).toBe(SWAYP_HANDOVER_NOT_DISPATCH_DAY);
  });
});

describe("escanear al entregar", () => {
  it("arma la caja que Swayp ya cargó y la deja escaneada, con su nota en la Actividad", async () => {
    const { manifestId } = await openSwaypHandover();
    const result = await scanSwaypHandover(manifestId!, "KP2-S02");
    expect(result.notice).toBe(SWAYP_HANDOVER_SCANNED("KP2-S02"));
    expect(items().find((i) => i.shipment_id === "KP2-S02")).toMatchObject({ office_checked_by: "u-yelitza" });
    expect(ship("KP2-S02")).toMatchObject({ preparation_state: "listo_despacho", ready_by: "u-yelitza" });
    // Manda lo cargado en Swayp: el escaneo no toca la custodia ni el estado.
    expect(ship("KP2-S02")).toMatchObject({ custody_state: "courier", swayp_state: 5, custody_transferred_by: null });
    expect(state.db.order_events!.find((e) => e.shipment_id === "KP2-S02")).toMatchObject({ kind: "office_checked", note: SWAYP_HANDOVER_SCAN_NOTE });
  });

  it("lo que no es del lote de hoy no entra, y el texto dice por qué", async () => {
    const { manifestId } = await openSwaypHandover();
    expect((await scanSwaypHandover(manifestId!, "KP5-S01")).error).toBe(SWAYP_HANDOVER_OTRO_DIA("jueves 5 nov"));
    expect((await scanSwaypHandover(manifestId!, "KP3-S02")).error).toBe("Swayp ya cerró esta guía en su sistema (Devolución): no la entregues.");
    expect((await scanSwaypHandover(manifestId!, "KP4-S01")).error).toBe("Esta guía es de provincia: la arma Swayp en su bodega, no sale de aquí.");
    // La S01 de Grupo GF: nunca entra; se nombra la salida de Swayp del pedido o se dice que no es de Swayp.
    const gf = await scanSwaypHandover(manifestId!, "KP2-S01");
    expect(gf.error).toMatch(/KP2-S02|no es de Swayp|no la entregues/);
    expect(items()).toHaveLength(2);
    expect(items().every((i) => !i.office_checked_at)).toBe(true);
  });
});

describe("«No sale» con su motivo (E4)", () => {
  it("exige explicar «Otro motivo» y guarda el motivo con su explicación y el aviso a Seguimiento", async () => {
    const { manifestId } = await openSwaypHandover();
    expect((await markSwaypNoSale(manifestId!, "KP1-S01", "otro", "")).error).toBe(SWAYP_NO_SALE_EXPLAIN);
    const done = await markSwaypNoSale(manifestId!, "KP1-S01", "no_encontrada", "No estaba en el sitio de Swayp");
    expect(done.error).toBeUndefined();
    const row = items().find((i) => i.shipment_id === "KP1-S01")!;
    expect(row.removal_reason).toBe(`${SWAYP_NO_SALE_PREFIX}No se encontró la caja en la oficina. No estaba en el sitio de Swayp.`);
    expect(state.db.order_events!.find((e) => e.kind === "package_removed")).toMatchObject({
      note: "No salió con Swayp: No se encontró la caja en la oficina. No estaba en el sitio de Swayp. Seguimiento: cambia la fecha en Swayp o anula la guía hoy.",
      payload: expect.objectContaining({ reason_code: "no_encontrada" }),
    });
    // Se puede deshacer antes de cerrar.
    expect((await undoSwaypNoSale(manifestId!, "KP1-S01")).error).toBeUndefined();
    expect(items().find((i) => i.shipment_id === "KP1-S01")!.removed_at).toBeNull();
  });
});

describe("cerrar con el nombre y el conteo del chofer (E2)", () => {
  it("no cierra con faltas ni con el conteo distinto; cerrada, la custodia lleva a la persona y no se reabre", async () => {
    const { manifestId } = await openSwaypHandover();
    await scanSwaypHandover(manifestId!, "KP2-S02");
    expect((await closeSwaypHandover(manifestId!, "Juan Pérez", 2)).error).toBe(SWAYP_CLOSE_MISSING(1));
    await markSwaypNoSale(manifestId!, "KP1-S01", "chofer_no_llevo", "No le cabía en la moto");
    expect((await closeSwaypHandover(manifestId!, "Juan Pérez", 2)).error).toBe(SWAYP_CLOSE_COUNT_MISMATCH(2, 1));
    expect(state.rpc).toEqual([]);
    const closed = await closeSwaypHandover(manifestId!, "Juan Pérez", 1);
    expect(closed.error).toBeUndefined();
    expect(state.db.dispatch_manifests![0]).toMatchObject({ state: "in_custody", received_by: "Juan Pérez" });
    expect(ship("KP2-S02")).toMatchObject({ custody_state: "courier", custody_transferred_by: "u-yelitza" });
    // La que no salió se queda como Swayp la tenga (E3).
    expect(ship("KP1-S01")).toMatchObject({ custody_state: "empresa" });
    expect(state.db.dispatch_events!.find((e) => e.kind === "handed_to_courier")!.payload).toEqual({ received_by: "Juan Pérez", driver_count: 1 });
    expect((await openSwaypHandover()).error).toBe(SWAYP_HANDOVER_CLOSED);
    expect((await scanSwaypHandover(manifestId!, "KP1-S01")).error).toBe(SWAYP_HANDOVER_CLOSED);
  });

  it("lo que Swayp cerró entretanto se retira solo con su motivo: el cierre nunca pisa una custodia `retorno`", async () => {
    const { manifestId } = await openSwaypHandover();
    await scanSwaypHandover(manifestId!, "KP2-S02");
    await scanSwaypHandover(manifestId!, "KP1-S01");
    Object.assign(ship("KP2-S02"), { swayp_state: 8, custody_state: "retorno" });
    Object.assign(ship("KP1-S01"), { swayp_state: 8, custody_state: "retorno" });
    expect((await closeSwaypHandover(manifestId!, "Juan Pérez", 0)).error).toBe(SWAYP_CLOSE_NOTHING);
    expect(items().every((i) => i.removed_at && String(i.removal_reason).includes("Swayp cerró la guía"))).toBe(true);
    expect(state.rpc).toEqual([]);
    expect(ship("KP2-S02").custody_state).toBe("retorno");
  });
});

describe("revisión del 04-11-2026", () => {
  it("una entrega de un día anterior sin cerrar se cancela sola y suelta sus cajas", async () => {
    state.db.dispatch_manifests!.push({
      id: "old", org_id: "org1", courier: "fenix", kind: "entrega_courier", route_date: "2026-11-03", rider_id: null,
      state: "office_check", received_by: null, custody_completed_at: null, cancelled_at: null, cancellation_reason: null,
    });
    // KP1-S01 quedó activa en la del martes y hoy vuelve a salir.
    state.db.dispatch_manifest_items!.push({ id: "old-1", manifest_id: "old", shipment_id: "KP1-S01", store_id: "s1", removed_at: null, office_checked_at: null });
    const { manifestId } = await openSwaypHandover();
    expect(state.db.dispatch_manifests!.find((m) => m.id === "old")).toMatchObject({ state: "cancelled", cancellation_reason: "Entrega del martes 3 nov sin cerrar" });
    expect(state.db.dispatch_manifest_items!.find((i) => i.id === "old-1")!.removal_reason).toBe("Ruta cancelada: Entrega del martes 3 nov sin cerrar");
    expect(items().filter((i) => i.manifest_id === manifestId).map((i) => i.shipment_id).sort()).toEqual(["KP1-S01", "KP2-S02"]);
  });

  it("si Swayp cerró una guía después de abrir la entrega, escanearla no la arma ni la entrega", async () => {
    const { manifestId } = await openSwaypHandover();
    Object.assign(ship("KP2-S02"), { swayp_state: 9 });
    expect((await scanSwaypHandover(manifestId!, "KP2-S02")).error).toBe("Swayp ya cerró esta guía en su sistema (Devolución confirmada): no la entregues.");
    expect(ship("KP2-S02").preparation_state).toBe("no_iniciado");
    expect(items().find((i) => i.shipment_id === "KP2-S02")!.office_checked_at).toBeNull();
  });

  it("el aviso del escáner de la estación es solo para Lima con Swayp en 1 a 6", async () => {
    Object.assign(ship("KP4-S01"), { custody_state: "courier", swayp_state: 5 });
    expect((await markShipmentReady("KP4-S01")).error).not.toBe(SWAYP_SCAN_USE_HANDOVER);
    Object.assign(ship("KP2-S02"), { swayp_state: 7 });
    expect((await markShipmentReady("KP2-S02")).error).not.toBe(SWAYP_SCAN_USE_HANDOVER);
  });
});

describe("«Swayp no vino»", () => {
  it("cancela la entrega con ese motivo y no se vuelve a abrir", async () => {
    const { manifestId } = await openSwaypHandover();
    expect((await markSwaypNoVino(manifestId!)).error).toBeUndefined();
    expect(state.db.dispatch_manifests![0]).toMatchObject({ state: "cancelled", cancellation_reason: SWAYP_NO_VINO_REASON });
    expect((await openSwaypHandover()).error).toBe(SWAYP_HANDOVER_NO_VINO_DONE);
  });
});

describe("fuera de la entrega", () => {
  it("la Mesa no crea ni llena rutas de Swayp", async () => {
    expect((await createDispatchManifest({ courier: "fenix", routeDate: WED })).error).toBe(SWAYP_MANIFEST_FROM_ALMACEN);
    const { manifestId } = await openSwaypHandover();
    expect((await addShipmentToManifest(manifestId!, "KP1-S01")).error).toBe(SWAYP_MANIFEST_FROM_ALMACEN);
  });

  it("el escáner de la estación manda a «Entregar a Swayp» la caja que Swayp ya cargó", async () => {
    expect((await markShipmentReady("KP2-S02")).error).toBe(SWAYP_SCAN_USE_HANDOVER);
    expect(ship("KP2-S02").preparation_state).toBe("no_iniciado");
  });
});
