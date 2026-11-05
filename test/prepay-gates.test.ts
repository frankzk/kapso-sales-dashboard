// «Lista de pago adelantado» (MOM §41.5): la compuerta de un pedido, la pasada
// de la regla automática y DÓNDE está puesta la compuerta. Lo que se fija:
//   - un celular de la lista sin el pago completo no se confirma ni sale por
//     ningún courier; pagado completo pasa (cobro cero); «no se pudo leer» no
//     autoriza una guía; sin la 0309 nada se frena;
//   - la pasada: Simulación no agrega a nadie y guarda solo cuentas y números
//     de pedido; Activo agrega por lotes y una segunda pasada no duplica; una
//     baja a mano se respeta hasta un rechazo posterior;
//   - la compuerta está en cada camino: confirmar (la mesa, Chatby, agencia),
//     Aliclik (como regla de Kapta, para que el reintento de Lima vaya a Repro
//     Lima), Swayp en su última puerta, las salidas manuales, Grupo GF,
//     Shalom, «Generar pedido» y el bot.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { prepayGuideBlock, prepayOrderCheck, runPrepayAutoRule } from "@/lib/prepay-list-server";
import { PREPAY_LIST_LABEL } from "@/lib/prepay-list";
import { FakeDb, type Row } from "./woocommerce-fake-db";

const ORG = "22222222-2222-4222-8222-222222222222";
const STORE = "11111111-1111-4111-8111-111111111111";
const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

const listed = (over: Row = {}): Row => ({
  id: "e1",
  org_id: ORG,
  phone: "51987654321",
  source: "manual",
  reason: "Rechazó en la puerta y lo dijo por WhatsApp.",
  evidence: { kind: "manual" },
  added_at: "2026-11-01T00:00:00Z",
  removed_at: null,
  ...over,
});

const master = (over: Row = {}): Row => ({
  order_id: "o1",
  store_id: STORE,
  order_name: "#KP1",
  customer_phone: "51987654321",
  financial_status: "pending",
  total_refunded: 0,
  payment_state: "sin_pago",
  payment_gateway: "cod",
  ...over,
});

describe("la compuerta de un pedido (`prepayOrderCheck`)", () => {
  const db = (entries: Row[], order: Row = master()) =>
    new FakeDb({ stores: [{ id: STORE, org_id: ORG }], prepay_list_entries: entries, order_master: [order] });

  it("de la lista y sin el pago completo: frena, con el mensaje del punto", async () => {
    for (const payment_state of ["sin_pago", "adelanto_validado", "diferencia_cargada"]) {
      const check = await prepayOrderCheck(db([listed()], master({ payment_state })).client(), "o1", "guia");
      expect(check.state, payment_state).toBe("blocked");
    }
    const check = await prepayOrderCheck(db([listed()]).client(), "o1", "confirmar");
    expect(check.state === "blocked" && check.message).toContain(PREPAY_LIST_LABEL);
    expect(await prepayGuideBlock(db([listed()]).client(), "o1")).toContain("cobro cero");
  });

  it("pagado completo pasa (comprobantes o checkout): sale con cobro cero", async () => {
    expect(await prepayOrderCheck(db([listed()], master({ payment_state: "pago_completo" })).client(), "o1", "guia")).toEqual({
      state: "ok",
      listed: true,
      fullyPaid: true,
    });
    expect(
      await prepayOrderCheck(db([listed()], master({ financial_status: "paid", payment_gateway: "checkout" })).client(), "o1", "guia"),
    ).toEqual({ state: "ok", listed: true, fullyPaid: true });
  });

  it("dice si el pedido ya está pagado completo también fuera de la lista (Swayp solo pone cobro cero si está en la lista)", async () => {
    expect(await prepayOrderCheck(db([], master({ payment_state: "pago_completo" })).client(), "o1", "guia")).toEqual({
      state: "ok",
      listed: false,
      fullyPaid: true,
    });
    expect(await prepayOrderCheck(db([], master({ payment_state: "adelanto_validado" })).client(), "o1", "guia")).toEqual({
      state: "ok",
      listed: false,
      fullyPaid: false,
    });
  });

  it("no listado, quitado o de otra organización: pasa", async () => {
    const pass = { state: "ok", listed: false, fullyPaid: false };
    expect(await prepayOrderCheck(db([]).client(), "o1", "guia")).toEqual(pass);
    expect(await prepayOrderCheck(db([listed({ removed_at: "2026-11-02T00:00:00Z", removed_reason: "Era otra persona" })]).client(), "o1", "guia")).toEqual(pass);
    expect(await prepayOrderCheck(db([listed({ org_id: "33333333-3333-4333-8333-333333333333" })]).client(), "o1", "guia")).toEqual(pass);
    // Un celular que no se puede normalizar nunca está en la lista.
    expect(await prepayOrderCheck(db([listed()], master({ customer_phone: "014445566" })).client(), "o1", "guia")).toEqual(pass);
  });

  it("«no se pudo leer» no autoriza una guía; sin la 0309 nada se frena", async () => {
    const d = db([listed()]);
    d.failOn = (table) => (table === "prepay_list_entries" ? { message: "timeout" } : null);
    expect((await prepayOrderCheck(d.client(), "o1", "guia")).state).toBe("unread");
    expect(await prepayGuideBlock(d.client(), "o1")).toMatch(/No se pudo comprobar/);
    d.failOn = (table) => (table === "prepay_list_entries" ? { code: "PGRST205", message: "Could not find the table" } : null);
    expect(await prepayGuideBlock(d.client(), "o1")).toBeNull();
  });

  it("acepta la fila ya leída (no vuelve a leer el pedido)", async () => {
    const d = db([listed()]);
    expect((await prepayOrderCheck(d.client(), master() as never, "guia")).state).toBe("blocked");
    expect(d.ops.some((op) => op.table === "order_master")).toBe(false);
  });
});

describe("la pasada de la regla automática (`runPrepayAutoRule`)", () => {
  const NOW = new Date("2026-11-05T15:00:00Z");
  const seed = (extra: Record<string, Row[]> = {}) =>
    new FakeDb({
      stores: [{ id: STORE, org_id: ORG }],
      prepay_list_settings: [{ org_id: ORG, auto_mode: "simulacion" }],
      prepay_list_entries: [],
      order_master: [
        { order_id: "o1", store_id: STORE, order_name: "#KP1", customer_phone: "51987654321", order_created_at: "2026-10-01T00:00:00Z" },
        { order_id: "o2", store_id: STORE, order_name: "#KP2", customer_phone: "51911111111", order_created_at: "2026-10-02T00:00:00Z" },
        {
          order_id: "o3",
          store_id: STORE,
          order_name: "#KP3",
          customer_phone: "51922222222",
          order_created_at: "2026-10-03T00:00:00Z",
          pickup_state: "devuelto_al_origen",
          returned_at: "2026-10-20T00:00:00Z",
        },
        // Fuera de la ventana de seis meses.
        { order_id: "o4", store_id: STORE, order_name: "#KP4", customer_phone: "51933333333", order_created_at: "2026-01-01T00:00:00Z" },
      ],
      shipments: [
        { id: "g1", store_id: STORE, order_id: "o1", courier: "aliclik", reported_status: "REFUSED · DISPATCHED", closed_at: "2026-10-04T00:00:00Z", created_at: "2026-10-02T00:00:00Z" },
        { id: "g2", store_id: STORE, order_id: "o2", courier: "aliclik", reported_status: "NOT_RESPOND · DISPATCHED", created_at: "2026-10-03T00:00:00Z" },
        { id: "g4", store_id: STORE, order_id: "o4", courier: "aliclik", reported_status: "REFUSED", created_at: "2026-06-01T00:00:00Z" },
      ],
      delivery_stops: [{ id: "st1", store_id: STORE, order_id: "o2", status: "no_entregado", outcome_reason: "rechazado", reported_at: "2026-10-06T00:00:00Z" }],
      ...extra,
    });

  it("Simulación: dice quién entraría, sin agregar a nadie y sin celulares en el resumen", async () => {
    const db = seed();
    const report = await runPrepayAutoRule(db.client(), { now: NOW });
    expect(report.error).toBeNull();
    const summary = report.orgs[0]!.summary!;
    expect(summary).toMatchObject({ mode: "simulacion", wouldAdd: 3, alreadyListed: 0, respectedRemovals: 0 });
    expect(summary.byKind).toEqual({ rechazo_en_puerta: 2, no_recogio_en_agencia: 1 });
    expect([...summary.samples].sort()).toEqual(["#KP1", "#KP2", "#KP3"]);
    expect(db.rows("prepay_list_entries")).toHaveLength(0);
    const saved = db.rows("prepay_list_settings")[0]!;
    expect(saved.last_simulation).toMatchObject({ wouldAdd: 3 });
    expect(JSON.stringify(saved.last_simulation)).not.toMatch(/519\d{8}/);
  });

  it("Activo: agrega por lotes, con su evidencia; otra pasada no duplica", async () => {
    const db = seed({ prepay_list_settings: [{ org_id: ORG, auto_mode: "activo" }] });
    const first = await runPrepayAutoRule(db.client(), { now: NOW });
    expect(first.orgs[0]!.summary).toMatchObject({ mode: "activo", wouldAdd: 3, inserted: 3 });
    const rows = db.rows("prepay_list_entries");
    expect(rows.map((r) => r.phone).sort()).toEqual(["51911111111", "51922222222", "51987654321"]);
    const kp1 = rows.find((r) => r.phone === "51987654321")!;
    expect(kp1).toMatchObject({ source: "auto", added_by: null, org_id: ORG });
    expect(kp1.removed_at ?? null).toBeNull();
    expect(kp1.reason).toBe("Rechazó en la puerta 1 pedido (#KP1).");
    expect(kp1.evidence.orders[0]).toMatchObject({ order_id: "o1", order_name: "#KP1", kind: "rechazo_en_puerta", detail: "Aliclik: REFUSED" });
    // Las filas insertadas no traen `removed_at`: en la base es null. Se fija aquí
    // para la segunda pasada.
    for (const r of rows) r.removed_at = null;
    const second = await runPrepayAutoRule(db.client(), { now: NOW });
    expect(second.orgs[0]!.summary).toMatchObject({ wouldAdd: 0, alreadyListed: 3, inserted: 0 });
    expect(db.rows("prepay_list_entries")).toHaveLength(3);
    expect(db.rows("prepay_list_settings")[0]!.last_run).toMatchObject({ inserted: 0 });
  });

  it("una baja a mano se respeta hasta un rechazo posterior", async () => {
    const removed = listed({
      phone: "51987654321",
      source: "auto",
      added_at: "2026-10-05T00:00:00Z",
      removed_at: "2026-10-10T00:00:00Z",
      removed_reason: "Pagó todo y fue un error del motorizado",
      evidence: { kind: "auto", orders: [{ order_id: "o1" }] },
    });
    const db = seed({ prepay_list_settings: [{ org_id: ORG, auto_mode: "activo" }], prepay_list_entries: [removed] });
    const run = await runPrepayAutoRule(db.client(), { now: NOW });
    expect(run.orgs[0]!.summary).toMatchObject({ wouldAdd: 2, respectedRemovals: 1 });
    expect(db.rows("prepay_list_entries").filter((r) => r.phone === "51987654321")).toHaveLength(1);

    // Un rechazo nuevo de la misma clienta, después de la baja: vuelve.
    db.rows("order_master").push({ order_id: "o9", store_id: STORE, order_name: "#KP9", customer_phone: "987654321", order_created_at: "2026-10-25T00:00:00Z" });
    db.rows("delivery_stops").push({ id: "st9", store_id: STORE, order_id: "o9", status: "no_entregado", outcome_reason: "rechazado", reported_at: "2026-10-28T00:00:00Z" });
    for (const r of db.rows("prepay_list_entries")) r.removed_at ??= null;
    await runPrepayAutoRule(db.client(), { now: NOW });
    const back = db.rows("prepay_list_entries").filter((r) => r.phone === "51987654321" && r.removed_at == null);
    expect(back).toHaveLength(1);
    expect(back[0]!.evidence.orders.map((o: Row) => o.order_id)).toEqual(["o9"]);
  });

  it("una baja se respeta aunque el reporte del courier mueva la fecha del mismo rechazo", async () => {
    // Un alta MANUAL (su evidencia no nombra pedidos) quitada el 01-11, con lo
    // que ya se sabía guardado: o1 rechazó antes. Después Aliclik vuelve a
    // reportar la guía (su `last_report_at` pasa la baja) y la guía no cerró:
    // es el mismo rechazo, y no lo vuelve a meter.
    const removed = listed({
      added_at: "2026-10-20T00:00:00Z",
      removed_at: "2026-11-01T00:00:00Z",
      removed_reason: "Lo pidió la asesora con motivo",
      removed_known_order_ids: ["o1"],
    });
    const db = seed({ prepay_list_settings: [{ org_id: ORG, auto_mode: "activo" }], prepay_list_entries: [removed] });
    const g1 = db.rows("shipments").find((r) => r.id === "g1")!;
    g1.closed_at = null;
    g1.last_report_at = "2026-11-04T00:00:00Z";
    const run = await runPrepayAutoRule(db.client(), { now: NOW });
    expect(run.orgs[0]!.summary).toMatchObject({ respectedRemovals: 1 });
    expect(db.rows("prepay_list_entries").filter((r) => r.phone === "51987654321")).toHaveLength(1);

    // En cambio, una guía de Swayp creada ANTES de la baja y rechazada después
    // sí es nueva: su pedido no estaba en lo sabido, aunque su fecha sea vieja.
    db.rows("order_master").push({ order_id: "o7", store_id: STORE, order_name: "#KP7", customer_phone: "51987654321", order_created_at: "2026-10-25T00:00:00Z" });
    db.rows("shipments").push({ id: "g7", store_id: STORE, order_id: "o7", courier: "fenix", reported_status: "Swayp · No ha comprado ningún producto (15)", created_at: "2026-10-26T00:00:00Z" });
    for (const r of db.rows("prepay_list_entries")) r.removed_at ??= null;
    await runPrepayAutoRule(db.client(), { now: NOW });
    const back = db.rows("prepay_list_entries").filter((r) => r.phone === "51987654321" && r.removed_at == null);
    expect(back).toHaveLength(1);
    expect(back[0]!.evidence.orders.map((o: Row) => o.order_id)).toEqual(["o7"]);
  });

  it("si no se pudo guardar el resumen, lo dice (el cron contesta 502)", async () => {
    const db = seed();
    db.failOn = (table, op) => (table === "prepay_list_settings" && op === "upsert" ? { message: "jsonb rechazado" } : null);
    const report = await runPrepayAutoRule(db.client(), { now: NOW });
    expect(report.error).toMatch(/no se pudo guardar el resumen: jsonb rechazado/);
    expect(report.orgs[0]!.error).toMatch(/no se pudo guardar el resumen/);
  });

  it("Apagado no hace nada; sin la 0309 tampoco falla", async () => {
    const db = seed({ prepay_list_settings: [{ org_id: ORG, auto_mode: "apagado" }] });
    expect(await runPrepayAutoRule(db.client(), { now: NOW })).toEqual({ orgs: [], error: null });
    expect(db.ops.some((op) => op.table === "shipments")).toBe(false);
    const missing = seed();
    missing.failOn = (table) => (table === "prepay_list_settings" ? { code: "42P01", message: "does not exist" } : null);
    expect(await runPrepayAutoRule(missing.client(), { now: NOW })).toEqual({ orgs: [], error: null });
  });
});

describe("dónde está la compuerta (una por camino, ninguno sin ella)", () => {
  it("Aliclik: en `aliclikCreateGates`, como regla de Kapta, después del prepago y antes del §8.2", () => {
    const src = read("lib/aliclik-guide.ts");
    const gates = src.slice(src.indexOf("export async function aliclikCreateGates("), src.indexOf("export function aliclikRecipientBlock("));
    const prepaid = gates.indexOf("if (prepaidBlock) return blocked(prepaidBlock);");
    const prepay = gates.indexOf('prepayOrderCheck(admin, ctx.row as unknown as PrepayOrderRow, "guia")');
    const door = gates.indexOf("aliclikDoorBan(confirmationBrief.doorRejections)");
    expect(prepaid).toBeGreaterThan(0);
    expect(prepay).toBeGreaterThan(prepaid);
    expect(door).toBeGreaterThan(prepay);
    expect(gates).toContain('if (prepay.state === "blocked") {\n    return blocked(');
    expect(gates).toContain('if (prepay.state === "unread") return unread(prepay.message);');
  });

  it("Swayp: en la última puerta antes de pedir la guía, para todos sus caminos", () => {
    const src = read("lib/swayp-reenvio.ts");
    const fn = src.slice(src.indexOf("export async function createFenixGuideViaApi("), src.indexOf("export async function swaypSinVinculo("));
    expect(fn).toContain('const prepay = await prepayOrderCheck(args.admin, args.orderId, "guia");');
    expect(fn).toContain('if (prepay.state !== "ok") return { ok: false, reason: prepay.message };');
    expect(fn.indexOf("prepayOrderCheck")).toBeLessThan(fn.indexOf("swaypDestinationRefusal"));
    // El cliente de la lista pagado completo sale con cobro cero: el `codAmount` de cada camino se pisa en la última puerta.
    expect(fn).toContain("const codAmount = prepay.listed && prepay.fullyPaid ? 0 : args.codAmount;");
    expect(fn).toMatch(/buildSwaypGuideInput\(\{\s*\.\.\.args,\s*codAmount,/);
  });

  it("salidas manuales, Grupo GF y Shalom", () => {
    const pedidos = read("app/dashboard/pedidos/actions.ts");
    const manual = pedidos.slice(pedidos.indexOf("export async function createManualRouteOutput("), pedidos.indexOf("export async function setOlvaTracking("));
    expect(manual).toContain("const prepayBlock = await prepayGuideBlock(admin, ctx.row as unknown as PrepayOrderRow);");
    const courier = read("app/dashboard/courier/actions.ts");
    const take = courier.slice(courier.indexOf("async function takeOrdersCore("));
    expect(take.slice(0, 6000)).toContain("const prepayBlock = await prepayGuideBlock(admin, row as unknown as PrepayOrderRow);");
    // «Sacar con salida nueva» arma otra salida contra entrega: la misma compuerta, antes de abrir la solicitud.
    const replace = courier.slice(courier.indexOf("export async function replaceOwnOutputs("));
    const gate = replace.indexOf("const prepayBlock = await prepayGuideBlock(admin, row as unknown as PrepayOrderRow);");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(replace.indexOf('.from("logistics_requests")\n          .insert('));
    expect(gate).toBeLessThan(replace.indexOf("writeCourierGuide("));
    const shalom = read("app/dashboard/pedidos/shalom-actions.ts");
    const create = shalom.slice(shalom.indexOf("export async function createShalomGuide("), shalom.indexOf("export async function cancelShalomGuide("));
    expect(create).toContain("const prepayBlock = await prepayGuideBlock(admin, row as unknown as PrepayOrderRow);");
    expect(create.indexOf("prepayGuideBlock")).toBeLessThan(create.indexOf("shalomSoftBlockers(row.payment_state)"));
  });

  it("confirmar: solo «Confirmó el pedido», antes de registrar el intento y de guardar la coordenada", () => {
    const pedidos = read("app/dashboard/pedidos/actions.ts");
    const fn = pedidos.slice(pedidos.indexOf("export async function registerConfirmationAttempt("), pedidos.indexOf("async function ensureDispatchCoordinate("));
    const gate = fn.indexOf('if (result.confirms) {\n    const prepay = await prepayOrderCheck(createAdminSupabase(), ctx.row as unknown as PrepayOrderRow, "confirmar");');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(fn.indexOf("ensureDispatchCoordinate(ctx"));
    expect(gate).toBeLessThan(fn.indexOf('rpc("register_confirmation_attempt_v1"'));
  });

  it("las confirmaciones automáticas lo dejan para una persona (Chatby y la confirmación expresa de agencia)", () => {
    const chatby = read("lib/chatby-autoconfirm-server.ts");
    const tryGuide = chatby.slice(chatby.indexOf("async function tryChatbyGuide("));
    expect(tryGuide).toContain('const prepay = await prepayOrderCheck(admin, row as unknown as PrepayOrderRow, "confirmar");');
    expect(tryGuide).toContain('if (prepay.state !== "ok") return { kind: "hold", reason: "guia_no_creada", detail: prepay.message, state: "para_persona" };');
    // Antes de cotizar: también en la simulación.
    expect(tryGuide.indexOf("prepayOrderCheck")).toBeLessThan(tryGuide.indexOf("previewAliclikGuideFor"));
    const agencia = read("lib/confirmacion-agencia-access.ts");
    expect(agencia).toContain('const prepay = await prepayOrderCheck(admin, orderId, "confirmar");');
    expect(agencia.indexOf("prepayOrderCheck(admin")).toBeLessThan(agencia.indexOf('kind: "confirmed"'));
  });

  it("«Generar pedido» y el bot no crean contra entrega para la lista", () => {
    const leads = read("app/dashboard/leads/actions.ts");
    const gen = leads.slice(leads.indexOf("export async function generateOrder("));
    const block = gen.indexOf("const prepayBlock = await generateOrderPrepayBlock(admin, ctx.storeId,");
    expect(block).toBeGreaterThan(0);
    expect(block).toBeLessThan(gen.indexOf("loadStoreOrderPlatform(admin, ctx.storeId)"));
    const bot = read("lib/bot-orders.ts");
    expect(bot.indexOf('fail("prepay_required"')).toBeGreaterThan(bot.indexOf('fail("store_inactive"'));
    expect(bot.indexOf('fail("prepay_required"')).toBeLessThan(bot.indexOf("const claimed = await claimBotOrder("));
    // «Recuperar carrito» completa un borrador contra entrega: la misma compuerta, antes de Shopify.
    const recover = leads.slice(leads.indexOf("export async function recoverCart("));
    const rb = recover.indexOf("const prepayBlock = await generateOrderPrepayBlock(admin, ctx.storeId, [l.phone]);");
    expect(rb).toBeGreaterThan(0);
    expect(rb).toBeLessThan(recover.indexOf("completeDraftOrder({"));
  });

  it("la ficha del pedido y la del lead muestran el aviso; el link de Flow es por el total y no se manda solo", () => {
    expect(read("components/order-drawer.tsx")).toContain("<PrepayListBanner");
    expect(read("components/leads-drawer.tsx")).toContain('<PrepayListBanner status={prepayStatus} context="lead" />');
    const link = read("app/dashboard/pedidos/prepay-actions.ts");
    // El cobro lo decide `prepayLinkPlan` (el total, o la diferencia si ya hay adelanto).
    expect(link).toContain("const plan = prepayLinkPlan(payments, order.order_total);");
    expect(link).toContain("if (!plan.ok) return { error: plan.error };");
    expect(link).toContain('if (process.env.VERCEL_ENV !== "production") return { error: "Disponible solo en producción." };');
    expect(link).not.toMatch(/sendWhatsapp|sendWhatsappText/);
  });

  it("el texto de Aliclik prepagado ya no manda a Tanders (no crea guías nuevas)", () => {
    expect(read("lib/aliclik-money.ts")).toContain("En Lima mándalo por Grupo GF (motorizado propio) o por Swayp con cobro cero");
  });
});
