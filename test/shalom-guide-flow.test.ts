// El modal de la guía Shalom contra el servidor de verdad (sobre una base falsa).
//
// #KP202968 (06-11-2026): «este pedido ya tiene adelanto de pago y me sale esta
// nota y no me deja registrar». Aquí se prueba lo que el modal recibe y lo que
// pasa al pulsar, no el texto del código:
//   - el borrador del caso real: avisos, línea bajo la nota y sesión medida con
//     el reloj del servidor;
//   - un pedido en la lista de pago adelantado con el adelanto validado: el
//     modal recibe el bloqueo que el servidor aplica al crear, y no la promesa
//     de que el pago ya está;
//   - Shalom rechaza el token: se tira de todas las tiendas que lo guardan, y
//     «Conectar con Shalom» hace el login en vez de copiar el token muerto.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  // Antes de cualquier import: `encrypt` y la API key se leen del entorno.
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.SHALOM_API_KEY = "sk_test";
  return { db: null as unknown as import("./woocommerce-fake-db").FakeDb };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));
vi.mock("@/lib/permissions-access", () => ({
  getMasterPermissions: async () => ({ can: () => true }),
}));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => h.db.client(),
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (t: string) => h.db.from(t),
  }),
}));

import { FakeDb } from "./woocommerce-fake-db";

const { encrypt } = await import("@/lib/crypto");
const { ShalomClient } = await import("@/lib/shalom/client");
const { ShalomApiError } = await import("@/lib/shalom/types");
const { shalomSubmitMissing, SUBMIT_BLOCKED_REASON } = await import("@/lib/shalom/draft");
const { loadShalomDraft, connectShalomSession, createShalomGuide } = await import(
  "@/app/dashboard/pedidos/shalom-actions"
);

const ORG = "22222222-2222-4222-8222-222222222222";
const STORE = "dcab8bf5-23ec-49f5-8e20-f75a8f978297";
const SIBLING = "33333333-3333-4333-8333-333333333333";
const OTHER_ACCOUNT = "44444444-4444-4444-8444-444444444444";
const ORDER = "f0e08ede-6f54-49c3-acab-3c97fabf8560";
const PHONE = "51994921760";
const NOTE = "Sin contra entrega en su distrito: pedir el pago por adelantado antes de despachar.";
const MIN = 60_000;

function storeRow(id: string, token: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    org_id: ORG,
    shalom_pro_email: "tienda@ejemplo.com",
    shalom_pro_password_enc: encrypt("clave"),
    shalom_origin_terminal_id: 476,
    shalom_origin_terminal_name: "AV BOLIVAR",
    shalom_default_product_id: 1096,
    shalom_session_token_enc: token,
    shalom_session_expires_at: token ? new Date(Date.now() + 78 * MIN).toISOString() : null,
    ...over,
  };
}

function seed(over: { prepayListed?: boolean; note?: string | null; token?: string | null } = {}) {
  const token = over.token === undefined ? encrypt("ssk_vivo") : over.token;
  return new FakeDb({
    stores: [storeRow(STORE, token)],
    order_master: [
      {
        order_id: ORDER,
        store_id: STORE,
        order_name: "#KP202968",
        customer_name: "Natalia vilchez",
        customer_phone: PHONE,
        payment_state: "adelanto_validado",
        general_status: "pendiente",
        financial_status: "pending",
        total_refunded: 0,
        payment_gateway: "cod",
        district: "JAEN",
        province: "JAEN",
        region: "CAJAMARCA",
      },
    ],
    orders: [{ id: ORDER, raw: over.note === null ? {} : { note: over.note ?? NOTE } }],
    shalom_order_drafts: [
      {
        order_id: ORDER,
        document_type: "DNI",
        document: "46413109",
        destiny_terminal_id: 28,
        destiny_terminal_name: "CAJAMARCA / JAEN / JAEN / JAEN CO",
      },
    ],
    order_payments: [
      { order_id: ORDER, store_id: STORE, kind: "adelanto", amount: 30, validation_status: "validado" },
    ],
    shipments: [],
    prepay_list_entries: over.prepayListed
      ? [{ id: "e1", org_id: ORG, phone: PHONE, source: "manual", reason: "Rechazó dos veces", removed_at: null }]
      : [],
  });
}

/** Lo que el modal le pasa a `shalomSubmitMissing` con el formulario prellenado. */
function modalMissing(draft: Awaited<ReturnType<typeof loadShalomDraft>>, sessionReady: boolean) {
  if (!("draft" in draft)) throw new Error(draft.error);
  const d = draft.draft;
  return shalomSubmitMissing({
    loaded: true,
    blockers: d.blockers,
    softBlockers: d.softBlockers,
    overrideReason: "",
    sessionReady,
    sessionExpired: false,
    originTerminalId: d.originTerminalId,
    destinyTerminalId: d.prefilledTerminalId,
    productId: d.defaultProductId,
    quantity: 1,
    documentType: d.prefilledDocumentType ?? "DNI",
    document: d.prefilledDocument ?? "",
    name: d.receiverName,
    lastName: d.receiverLastName,
    phone: d.receiverPhone ?? "",
    pickupCodeError: null,
    pending: false,
    created: false,
  });
}

const guideInput = {
  destinyTerminalId: 28,
  destinyTerminalName: "CAJAMARCA / JAEN / JAEN / JAEN CO",
  productId: 1096,
  documentType: "DNI" as const,
  document: "46413109",
  name: "Natalia",
  lastName: "vilchez",
  phone: PHONE,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadShalomDraft: #KP202968 tal como lo ve la operadora", () => {
  beforeEach(() => {
    h.db = seed();
  });

  it("ningún aviso de pago en ámbar, la nota con su línea verde y el botón sin otra razón", async () => {
    const res = await loadShalomDraft(ORDER);
    if (!("draft" in res)) throw new Error(res.error);
    const d = res.draft;
    expect(d.blockers).toEqual([]);
    expect(d.softBlockers).toEqual([]);
    expect(d.warnings).toEqual([
      "El documento y la agencia venían apuntados en «DNI y agencia Shalom» (46413109 · CAJAMARCA / JAEN / JAEN / JAEN CO). Verifícalos antes de crear.",
    ]);
    expect(d.shopifyNote).toBe(NOTE);
    expect(d.notePaymentLine).toBe(
      "El adelanto ya está validado (S/ 30): si la nota pide cobrar por adelantado, eso ya se cumplió. La clave de recojo se entrega cuando el pago completo esté validado.",
    );
    expect(modalMissing(res, d.sessionReady)).toEqual([]);
    expect(modalMissing(res, false)).toEqual(["Falta conectar con Shalom (pulsa «Conectar con Shalom»)."]);
  });

  it("la sesión viaja como duración medida con el reloj del servidor", async () => {
    const res = await loadShalomDraft(ORDER);
    if (!("draft" in res)) throw new Error(res.error);
    expect(res.draft.sessionReady).toBe(true);
    // 78 min menos el margen de 2 min de `sessionIsFresh`.
    expect(res.draft.sessionMsLeft).toBeGreaterThan(75 * MIN);
    expect(res.draft.sessionMsLeft).toBeLessThanOrEqual(76 * MIN);
    expect(res.draft).not.toHaveProperty("sessionExpiresAt");
  });

  it("sin nota no se lee `order_payments`: la línea no saldría", async () => {
    h.db = seed({ note: null });
    const res = await loadShalomDraft(ORDER);
    if (!("draft" in res)) throw new Error(res.error);
    expect(res.draft.notePaymentLine).toBeNull();
    expect(h.db.opsOn("order_payments")).toEqual([]);
  });
});

describe("loadShalomDraft: en la lista de pago adelantado con el adelanto validado", () => {
  beforeEach(() => {
    h.db = seed({ prepayListed: true });
  });

  it("el modal recibe el mismo bloqueo que aplica el servidor, y no la promesa", async () => {
    const res = await loadShalomDraft(ORDER);
    if (!("draft" in res)) throw new Error(res.error);
    const d = res.draft;
    expect(d.blockers).toHaveLength(1);
    expect(d.blockers[0]).toContain("Lista negra (agregada a mano: Rechazó dos veces): falta el pago total validado.");
    // Ni «ya se cumplió» bajo la nota ni avisos al lado del rojo.
    expect(d.notePaymentLine).toBeNull();
    expect(d.warnings).toEqual([]);
    // El botón queda gris con una razón que remite al rojo, aun con sesión.
    expect(modalMissing(res, true)).toEqual([SUBMIT_BLOCKED_REASON]);
    // La contingencia («Ya la creé en Shalom Pro») no lo mira hoy: no se toca.
    expect(d.contingencyBlockers).toEqual([]);

    // Y es exactamente lo que diría el servidor al pulsar.
    const created = await createShalomGuide(ORDER, guideInput);
    expect(created.error).toBe(d.blockers[0]);
  });
});

describe("Shalom rechaza el token: reconectar no readopta el muerto", () => {
  const dead = encrypt("ssk_muerto");
  const otherToken = encrypt("ssk_de_otra_cuenta");

  beforeEach(() => {
    h.db = seed({ token: dead });
    h.db.rows("stores").push(
      storeRow(SIBLING, dead),
      storeRow(OTHER_ACCOUNT, otherToken, { shalom_pro_email: "otra@ejemplo.com" }),
    );
  });

  it("crear devuelve sessionExpired, las copias se tiran y «Conectar» hace el login", async () => {
    vi.spyOn(ShalomClient.prototype, "createOrder").mockRejectedValue(
      new ShalomApiError("token vencido", 401, "shalom_auth_failed"),
    );
    const res = await createShalomGuide(ORDER, guideInput);
    expect(res.sessionExpired).toBe(true);
    expect(res.error).toBeTruthy();

    const byId = (id: string) => h.db.rows("stores").find((r) => r.id === id)!;
    expect(byId(STORE).shalom_session_token_enc).toBeNull();
    expect(byId(SIBLING).shalom_session_token_enc).toBeNull();
    // Otra cuenta, otro token: no es el rechazado.
    expect(byId(OTHER_ACCOUNT).shalom_session_token_enc).toBe(otherToken);

    // Lo que el modal pide después: conectar. Antes copiaba el token de la
    // hermana —el mismo muerto— y decía «✓ Conectado».
    const login = vi.spyOn(ShalomClient.prototype, "createSession").mockResolvedValue({
      session_token: "ssk_nuevo",
      expires_at: new Date(Date.now() + 120 * MIN).toISOString(),
    } as never);
    const connected = await connectShalomSession(STORE);
    expect(login).toHaveBeenCalledTimes(1);
    if (!("msLeft" in connected)) throw new Error(connected.error);
    expect(connected.msLeft).toBeGreaterThan(117 * MIN);
    expect(byId(STORE).shalom_session_token_enc).not.toBe(dead);
    expect(byId(SIBLING).shalom_session_token_enc).toBe(byId(STORE).shalom_session_token_enc);
  });

  it("con la sesión de la caché viva, conectar no hace login y devuelve lo que le queda", async () => {
    const login = vi.spyOn(ShalomClient.prototype, "createSession");
    const connected = await connectShalomSession(STORE);
    expect(login).not.toHaveBeenCalled();
    if (!("msLeft" in connected)) throw new Error(connected.error);
    expect(connected.msLeft).toBeGreaterThan(75 * MIN);
  });
});
