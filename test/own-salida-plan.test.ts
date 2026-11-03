import { describe, expect, it } from "vitest";
import {
  fillOwnSalidas,
  hasNotebookDate,
  isGfNotebookCourier,
  notebookContradicts,
  ownSalidaNotice,
  ownSalidaRow,
  planOwnSalida,
  type OwnSalidaCandidate,
} from "@/lib/own-salida";
import { resolveMacroStage, type MacroGuideSnapshot } from "@/lib/order-macro-stage";
import { resolveOrderState, type GuideSnapshot } from "@/lib/order-status";

const tbd = (over: Partial<OwnSalidaCandidate> = {}): OwnSalidaCandidate => ({
  id: "s1", courier: "por_definir", created_via: "mom_manual_route", delivery_status: "pendiente", custody_state: "empresa",
  custody_transferred_at: null, returned_at: null, output_number: 1, preparation_state: "listo_despacho",
  ready_at: "2026-08-02T15:00:00Z", created_at: "2026-08-01T15:00:00Z", ...over,
});
const DELIVERED = "2026-08-03T17:00:00.000Z";
const plan = (salidas: OwnSalidaCandidate[], urpiReported = false) => planOwnSalida(salidas, { deliveredAt: DELIVERED, urpiReported });

describe("qué caja se llevó el motorizado de Grupo GF", () => {
  it("la única caja viva «por definir», lista ese día, es la suya", () => {
    expect(plan([tbd()])).toMatchObject({ kind: "rellenar", salida: { id: "s1" } });
  });
  it("lo ya anulado o devuelto no estorba", () => {
    expect(plan([tbd(), tbd({ id: "s0", courier: "fenix", delivery_status: "anulado", custody_state: "retorno" })]).kind).toBe("rellenar");
    expect(plan([tbd(), tbd({ id: "s0", courier: "propio", created_via: "mom_manual_route", delivery_status: "pendiente", returned_at: "2026-07-30T10:00:00Z" })]).kind).toBe("rellenar");
  });
  it("con otra salida viva no se sabe qué caja se llevó: no se toca", () => {
    expect(plan([tbd(), tbd({ id: "s2", courier: "tanders", created_via: "tanders", delivery_status: "en_ruta" })]).kind).toBe("otra_salida_viva");
    expect(plan([tbd(), tbd({ id: "s2", output_number: 2 })]).kind).toBe("otra_salida_viva");
    expect(plan([tbd({ courier: "tanders", created_via: "tanders" })]).kind).toBe("otra_salida_viva");
  });
  it("una «por definir» que ya cambió de custodia no se rellena", () => {
    expect(plan([tbd({ custody_transferred_at: "2026-08-02T10:00:00Z", custody_state: "courier" })]).kind).toBe("otra_salida_viva");
  });
  it("con una salida ya entregada, de quien sea, esa es la que entregó", () => {
    expect(plan([tbd(), tbd({ id: "s2", courier: "tanders", created_via: "tanders", delivery_status: "entregado" })]).kind).toBe("ya_entregada");
    expect(plan([tbd({ courier: "propio", created_via: "cuaderno_gf", delivery_status: "entregado" })]).kind).toBe("ya_entregada");
  });
  it("si la caja ya salió con el motorizado en su ruta, su verdad es la parada: nada que hacer", () => {
    const route = tbd({ courier: "propio", created_via: "mom_manual_route", delivery_status: "en_ruta", custody_state: "courier", custody_transferred_at: "2026-08-03T13:00:00Z" });
    expect(plan([route]).kind).toBe("salida_propia");
    expect(plan([route], true).kind).toBe("salida_propia");
    // Con una «por definir» al lado, esa sobra y la decide una persona.
    expect(plan([route, tbd({ id: "s2", output_number: 2 })]).kind).toBe("otra_salida_viva");
  });
  it("si Urpi reportó el pedido, la caja puede ser de Urpi: no se toca", () => {
    expect(plan([tbd()], true).kind).toBe("reportado_por_urpi");
  });
  it("si una fila posterior lo da por devuelto, anulado o sin salida, la caja pudo volver: no se toca", () => {
    expect(planOwnSalida([tbd()], { deliveredAt: DELIVERED, contradicted: true }).kind).toBe("contradicho");
    // La caja que ya salió en su ruta sigue siendo del motorizado: su verdad es la parada.
    const route = tbd({ courier: "propio", delivery_status: "en_ruta", custody_state: "courier", custody_transferred_at: "2026-08-03T13:00:00Z" });
    expect(planOwnSalida([route], { deliveredAt: DELIVERED, contradicted: true }).kind).toBe("salida_propia");
  });
  it("la caja tiene que haber estado lista el día del cuaderno", () => {
    expect(plan([tbd({ preparation_state: "rotulo_generado" })]).kind).toBe("caja_dudosa");
    // Lista dos días después de la entrega: es otra caja.
    expect(plan([tbd({ ready_at: "2026-08-05T15:00:00Z" })]).kind).toBe("caja_dudosa");
    // Sin `ready_at` manda su creación.
    expect(plan([tbd({ ready_at: null, created_at: "2026-08-10T15:00:00Z" })]).kind).toBe("caja_dudosa");
    // Hasta un día de holgura: el escaneo se hizo a la mañana siguiente.
    expect(plan([tbd({ ready_at: "2026-08-04T15:00:00Z" })]).kind).toBe("rellenar");
  });
  it("sin salida no se inventa una", () => {
    expect(plan([]).kind).toBe("sin_salida");
  });
});

describe("una fila posterior del cuaderno desmiente la entrega (la guarda `cuaderno_contradicho` de la 0270)", () => {
  it("solo una de un día posterior, con efecto devolución, anulación o sin salida", () => {
    for (const effect of ["devolucion", "anulacion", "sin_salida"]) {
      expect(notebookContradicts([{ fecha: "2026-08-05", effect }], DELIVERED)).toBe(true);
    }
    // El mismo día, uno anterior, sin fecha o con otro efecto: no la desmienten.
    expect(notebookContradicts([{ fecha: "2026-08-03", effect: "devolucion" }], DELIVERED)).toBe(false);
    expect(notebookContradicts([{ fecha: "2026-08-01", effect: "anulacion" }], DELIVERED)).toBe(false);
    expect(notebookContradicts([{ fecha: null, effect: "devolucion" }], DELIVERED)).toBe(false);
    expect(notebookContradicts([{ fecha: "2026-08-05", effect: "entrega" }, { fecha: "2026-08-06", effect: null }], DELIVERED)).toBe(false);
  });
});

describe("de quién es la entrega y qué se escribe", () => {
  it("Reparto propio y Alexis son Grupo GF; Urpi y los demás, no", () => {
    expect(isGfNotebookCourier("propio")).toBe(true);
    expect(isGfNotebookCourier(" Alexis ")).toBe(true);
    for (const courier of ["urpi", "tanders", "shalom", "por_definir", "", null, undefined]) expect(isGfNotebookCourier(courier)).toBe(false);
  });
  it("sin el día del cuaderno no hay relleno", () => {
    expect(hasNotebookDate("2026-08-03")).toBe(true);
    for (const fecha of ["", null, undefined, "03/08/2026", "2026-8-3", 20260803]) expect(hasNotebookDate(fecha)).toBe(false);
  });
  it("la fila: motorizado propio, entregada con el día del cuaderno y su origen", () => {
    // La misma guía que fija scripts/sql/cuaderno_s01_fill_smoke.sql para la 0270.
    expect(ownSalidaRow("#CS01", "c2700001-0000-4000-8000-000000000000", DELIVERED)).toEqual({
      courier: "propio", created_via: "cuaderno_gf", guide_code: "MOM-CS01-PROPIO-C2700001", delivery_status: "entregado",
      status_category: "delivered", delivered_source: "cuaderno_gf", dispatched_at: DELIVERED, closed_at: DELIVERED,
    });
  });
  it("el aviso cuenta lo rellenado y lo que hay que mirar a mano", () => {
    expect(ownSalidaNotice({ filled: ["a", "b"], sinSalida: ["c"], otraSalidaViva: ["d"], porRevisar: ["e"], errors: ["f"] })).toEqual([
      "2 caja(s) «Por definir» pasaron a Grupo GF entregada",
      "2 con su caja «Por definir» sin rellenar: revisa su salida a mano",
      "1 salida(s) no se pudieron actualizar: revísalas a mano",
    ]);
    expect(ownSalidaNotice({ filled: [], sinSalida: ["c"], otraSalidaViva: [], porRevisar: [], errors: [] })).toEqual([]);
  });
});

// Doble mínimo de Supabase para la lectura y el UPDATE condicionado de writeCourierGuide.
function fakeAdmin(tables: {
  shipments: Record<string, any>[];
  urpi_report_rows?: Record<string, any>[];
  // Las filas como las devuelve la lectura: `fecha` y `estado` ya sacados de `values`.
  sheet_rows?: Record<string, any>[];
  sheets?: Record<string, any>[];
  sheet_domain_statuses?: Record<string, any>[];
}) {
  const events: any[] = [];
  const reads: string[] = [];
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = [];
    let patch: any = null, insert: any = null, single = false;
    const q: any = {
      select: () => q,
      eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: any[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      is: (k: string, v: any) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      update: (p: any) => { patch = p; return q; },
      insert: (row: any) => { insert = row; return q; },
      maybeSingle: () => { single = true; return q; },
      then: (resolve: any) => {
        if (insert) { events.push(insert); return Promise.resolve({ data: null, error: null }).then(resolve); }
        reads.push(table);
        const source = (tables as Record<string, Record<string, any>[] | undefined>)[table] ?? [];
        const rows = source.filter((r) => filters.every((f) => f(r)));
        if (patch) rows.forEach((r) => Object.assign(r, patch));
        // Copias, como una base: lo leído no cambia cuando después se actualiza la fila.
        const copies = rows.map((r) => ({ ...r }));
        return Promise.resolve({ data: single ? copies[0] ?? null : copies, error: null }).then(resolve);
      },
    };
    return q;
  };
  return { admin: { from } as any, events, reads };
}

describe("rellenar la caja en la base", () => {
  it("escribe la salida entregada de Grupo GF sobre la caja y deja el rastro; lo demás se cuenta", async () => {
    const shipments = [
      { ...tbd({ id: "aaaaaaaa-0000-4000-8000-000000000001" }), order_id: "o1", store_id: "kenku", output_code: "KP1-S01", qr_token: "qr-1" },
      { ...tbd({ id: "bbbbbbbb-0000-4000-8000-000000000002", courier: "tanders", created_via: "tanders", delivery_status: "en_ruta" }), order_id: "o2", store_id: "kenku" },
      { ...tbd({ id: "cccccccc-0000-4000-8000-000000000003" }), order_id: "o4", store_id: "kenku" },
      { ...tbd({ id: "dddddddd-0000-4000-8000-000000000004", preparation_state: "rotulo_generado" }), order_id: "o5", store_id: "kenku" },
      { ...tbd({ id: "eeeeeeee-0000-4000-8000-000000000005", courier: "propio", delivery_status: "en_ruta", custody_state: "courier", custody_transferred_at: "2026-08-03T13:00:00Z" }), order_id: "o6", store_id: "kenku" },
    ];
    const { admin, events } = fakeAdmin({ shipments, urpi_report_rows: [{ order_id: "o4" }] });
    const result = await fillOwnSalidas(admin, [
      { orderId: "o1", orderName: "#KP1", courier: "alexis", deliveredAt: DELIVERED },
      { orderId: "o2", orderName: "#KP2", courier: "propio", deliveredAt: DELIVERED },
      { orderId: "o3", orderName: "#KP3", courier: "propio", deliveredAt: DELIVERED },
      { orderId: "o4", orderName: "#KP4", courier: "propio", deliveredAt: DELIVERED },
      { orderId: "o5", orderName: "#KP5", courier: "propio", deliveredAt: DELIVERED },
      { orderId: "o6", orderName: "#KP6", courier: "propio", deliveredAt: DELIVERED },
    ]);
    expect(result).toEqual({ filled: ["o1"], sinSalida: ["o3"], otraSalidaViva: ["o2"], porRevisar: ["o4", "o5"], errors: [] });
    expect(shipments[0]).toMatchObject({
      courier: "propio", created_via: "cuaderno_gf", delivery_status: "entregado", status_category: "delivered", delivered_source: "cuaderno_gf",
      guide_code: "MOM-KP1-PROPIO-AAAAAAAA", dispatched_at: DELIVERED, closed_at: DELIVERED,
      // La caja: consecutivo, código, QR, preparación y custodia, intactos.
      output_number: 1, output_code: "KP1-S01", qr_token: "qr-1", preparation_state: "listo_despacho", custody_state: "empresa",
    });
    expect(shipments[1]).toMatchObject({ courier: "tanders", delivery_status: "en_ruta" });
    expect(shipments[2]).toMatchObject({ courier: "por_definir", delivery_status: "pendiente" });
    expect(shipments[3]).toMatchObject({ courier: "por_definir", delivery_status: "pendiente" });
    expect(shipments[4]).toMatchObject({ courier: "propio", delivery_status: "en_ruta" });
    expect(events).toEqual([
      expect.objectContaining({ kind: "route_output_filled", order_id: "o1", courier: "propio", shipment_id: "aaaaaaaa-0000-4000-8000-000000000001", payload: { outputCode: "KP1-S01", previousCourier: "por_definir" } }),
    ]);
  });
  it("una fila posterior de cualquier hoja que lo da por devuelto deja la caja para revisar", async () => {
    const shipments = [
      { ...tbd({ id: "aaaaaaaa-0000-4000-8000-000000000001" }), order_id: "o1", store_id: "kenku" },
      { ...tbd({ id: "bbbbbbbb-0000-4000-8000-000000000002" }), order_id: "o2", store_id: "kenku" },
    ];
    const { admin, events } = fakeAdmin({
      shipments,
      sheet_rows: [
        // o1: entregado el 03-08 en la hoja de Alexis y devuelto el 05-08 en Reparto propio.
        { order_id: "o1", sheet_id: "alexis", fecha: "2026-08-03", estado: "entregado" },
        { order_id: "o1", sheet_id: "propio", fecha: "2026-08-05", estado: "devuelto" },
        // o2: la devolución es del día anterior a la entrega: no la desmiente.
        { order_id: "o2", sheet_id: "propio", fecha: "2026-08-02", estado: "devuelto" },
      ],
      sheets: [{ id: "alexis", domain_id: "d-ext" }, { id: "propio", domain_id: "d-gf" }],
      sheet_domain_statuses: [
        { domain_id: "d-ext", code: "entregado", effect: "entrega" },
        { domain_id: "d-gf", code: "devuelto", effect: "devolucion" },
      ],
    });
    const result = await fillOwnSalidas(admin, [
      { orderId: "o1", orderName: "#KP1", courier: "alexis", deliveredAt: DELIVERED },
      { orderId: "o2", orderName: "#KP2", courier: "alexis", deliveredAt: DELIVERED },
    ]);
    expect(result).toEqual({ filled: ["o2"], sinSalida: [], otraSalidaViva: [], porRevisar: ["o1"], errors: [] });
    expect(shipments[0]).toMatchObject({ courier: "por_definir", delivery_status: "pendiente" });
    expect(events.map((event) => event.order_id)).toEqual(["o2"]);
  });
  it("una entrega que no es de Grupo GF no lee ni toca nada", async () => {
    const shipments = [{ ...tbd({ id: "aaaaaaaa-0000-4000-8000-000000000001" }), order_id: "o1", store_id: "kenku" }];
    const { admin, events, reads } = fakeAdmin({ shipments });
    const result = await fillOwnSalidas(admin, [{ orderId: "o1", orderName: "#KP1", courier: "urpi", deliveredAt: DELIVERED }]);
    expect(result).toEqual({ filled: [], sinSalida: [], otraSalidaViva: [], porRevisar: [], errors: [] });
    expect(reads).toEqual([]);
    expect(events).toEqual([]);
    expect(shipments[0]).toMatchObject({ courier: "por_definir", delivery_status: "pendiente" });
  });
  it("si entre la lectura y la escritura la caja cambió, no crea otra", async () => {
    const shipments = [{ ...tbd({ id: "aaaaaaaa-0000-4000-8000-000000000001" }), order_id: "o1", store_id: "kenku" }];
    const { admin } = fakeAdmin({ shipments });
    // Simula la carrera: el UPDATE ya no encuentra la fila «por definir».
    const original = admin.from;
    let reads = 0;
    admin.from = (table: string) => { const q = original(table); if (table === "shipments" && ++reads === 2) shipments[0]!.courier = "tanders"; return q; };
    const result = await fillOwnSalidas(admin, [{ orderId: "o1", orderName: "#KP1", courier: "propio", deliveredAt: DELIVERED }]);
    expect(result.filled).toEqual([]);
    expect(result.errors).toEqual(["o1"]);
    expect(shipments).toHaveLength(1);
  });
});

describe("después del relleno, el Master", () => {
  // La caja del cuaderno antes y después: lo que escribe `ownSalidaRow` encima.
  const box: GuideSnapshot = {
    id: "aaaaaaaa-0000-4000-8000-000000000001", courier: "por_definir", guide_code: "MOM-KP1-POR_DEFINIR-AAAAAAAA", delivery_status: "pendiente",
    attempts: 0, assigned_at: null, dispatched_at: null, out_for_delivery_at: null, rescheduled_at: null, closed_at: null, returned_at: null,
    pickup_state: null, agency_branch: null, agency_arrived_at: null, agency_expires_at: null, custody_state: "empresa",
    custody_transferred_at: null, created_at: "2026-08-01T15:00:00Z", updated_at: "2026-10-21T15:00:00Z",
  };
  const filled: GuideSnapshot = { ...box, ...ownSalidaRow("#KP1", box.id, DELIVERED), updated_at: "2026-10-21T15:00:00Z" };
  const override = { general_status: "entregado" as const, operational_status: "entregado", occurred_at: DELIVERED };
  const events = [{ kind: "status_override", occurred_at: DELIVERED, courier: "alexis", new_status: "entregado", new_operational: "entregado" }];
  const order = { created_at: "2026-07-30T15:00:00Z", cancelled_at: null, financial_status: "pending", shipping_mode: "cod" };

  it("da la entrega el día del cuaderno, no el del relleno, y la atribuye a Grupo GF", () => {
    const state = resolveOrderState({ order, guides: [filled], events, override, now: "2026-10-21T16:00:00Z" });
    expect(state).toMatchObject({ general: "entregado", source: "manual", deliveredAt: DELIVERED, deliveredCourier: "propio", currentCourier: "propio" });
  });
  it("saca el pedido de «Salida adicional activa» hacia Pendiente de liquidación", () => {
    const macro = (guide: GuideSnapshot) => resolveMacroStage({
      order: { ...order, region: "Lima", province: "Lima", district: "Miraflores", coverage: "lima" },
      guides: [{ ...guide, preparation_state: "listo_despacho" } as MacroGuideSnapshot],
      events: events.map((event) => ({ kind: event.kind, occurred_at: event.occurred_at })),
      legacy: { general: "entregado", operational: "entregado", since: DELIVERED },
      paymentState: null,
      now: "2026-10-21T16:00:00Z",
    });
    expect(macro(box)).toMatchObject({ stage: "por_cerrar", substage: "salida_adicional_activa" });
    expect(macro(filled)).toMatchObject({ stage: "por_cerrar", substage: "pendiente_liquidacion" });
    expect(macro(filled).reasons).not.toContain("salida_adicional_activa");
  });
});
