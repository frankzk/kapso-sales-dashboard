// Comprobantes por RUC — el panel «Comprobante» del drawer (MOM §35.4, §35.7,
// §35.9).
//
// Lo que se fija aquí: lo ve quien ve el pedido y nunca lleva credenciales; una
// lectura caída no se pinta como «sin comprobante» ni como «lista para
// emitirse» (§35.3, falla cerrada); registrar uno externo, pedir un reintento y
// liberar uno en duda piden «Boletas y facturas» y solo valen desde el estado
// que corresponde; una emitida con archivos de otro RUC no se pinta como una
// emitida más; lo que Shopify frena no se dice «lista para emitirse»; la
// externa va con el RUC de la cuenta que recibió el pago; «Emitir esta boleta»
// existe solo con el RUC en «Manual», pide el permiso antes de nada, dice antes
// qué sale y no se envía dos veces; y el panel no arrastra node:crypto al
// navegador. La base, los permisos y las funciones del barrido (también
// `emitInvoiceNow`) van simulados (sus constantes no): aquí se mira el drawer.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Filter = [method: string, column: string, value: unknown];
interface Call {
  client: "server" | "admin";
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  cols?: string;
  returning?: string;
  payload?: unknown;
  filters: Filter[];
}
type DbError = { message: string; code?: string };
type Reply = { data: unknown; error: DbError | null };

const st = vi.hoisted(() => ({
  calls: [] as Call[],
  user: { id: "user-1" } as { id: string } | null,
  orgPerms: {} as Record<string, string[]>,
  permArgs: [] as unknown[][],
  issuers: [] as unknown[],
  issuersError: null as Error | null,
  issuerArgs: [] as unknown[][],
  facts: new Map<string, unknown>(),
  factsError: null as Error | null,
  factsArgs: [] as unknown[][],
  /** Lo que contesta `emitInvoiceNow` (la emisión del barrido, simulada aquí). */
  emitResult: null as unknown,
  emitThrows: null as Error | null,
  emitArgs: [] as unknown[][],
  db: {} as {
    orderMaster: unknown;
    orderMasterError: DbError | null;
    store: unknown;
    invoices: unknown[];
    invoicesError: DbError | null;
    checks: unknown[];
    checksError: DbError | null;
    requests: unknown[];
    requestsError: DbError | null;
    invoiceRef: unknown;
    order: unknown;
    orderError: DbError | null;
    insertError: DbError | null;
    updateData: unknown[];
    updateError: DbError | null;
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`redirect:${p}`);
  },
}));
vi.mock("@/lib/permissions-access", () => ({
  getMasterPermissions: async () => ({ can: () => true }),
  hasOrgPermission: async (...a: unknown[]) => {
    st.permArgs.push(a);
    const [orgId, permission] = a as [string, string];
    return (st.orgPerms[orgId] ?? []).includes(permission);
  },
}));
// El módulo del barrido lo escribe otro: aquí se usa su contrato, no su base.
// Sus constantes (`SHOPIFY_LEVEL_REASONS`) son las de verdad: si el barrido
// suma un motivo de Shopify, el panel tiene que saber qué decir de él.
vi.mock("@/lib/invoicing/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invoicing/server")>()),
  loadInvoiceIssuers: async (...a: unknown[]) => {
    st.issuerArgs.push(a);
    if (st.issuersError) throw st.issuersError;
    return st.issuers;
  },
  loadInvoiceOrderFacts: async (...a: unknown[]) => {
    st.factsArgs.push(a);
    if (st.factsError) throw st.factsError;
    return st.facts;
  },
  emitInvoiceNow: async (...a: unknown[]) => {
    st.emitArgs.push(a);
    if (st.emitThrows) throw st.emitThrows;
    return st.emitResult;
  },
}));
vi.mock("@/lib/db", () => {
  const reply = (c: Call): Reply => {
    const db = st.db;
    if (c.client === "server" && c.table === "order_master") return { data: db.orderMaster, error: db.orderMasterError };
    if (c.client === "server" && c.table === "stores") return { data: db.store, error: null };
    if (c.client === "admin" && c.table === "order_invoices") {
      if (c.op === "insert") return { data: null, error: db.insertError };
      if (c.op === "update") return { data: db.updateError ? null : db.updateData, error: db.updateError };
      if (c.cols === "id, request") return { data: db.requests, error: db.requestsError };
      if (c.cols?.startsWith("id, org_id")) return { data: db.invoiceRef, error: null };
      return { data: db.invoices, error: db.invoicesError };
    }
    if (c.client === "admin" && c.table === "invoice_order_checks") return { data: db.checks, error: db.checksError };
    if (c.client === "admin" && c.table === "orders") return { data: db.order, error: db.orderError };
    return { data: null, error: { message: `consulta inesperada: ${c.client} ${c.table}` } };
  };
  const builder = (client: Call["client"], table: string) => {
    const call: Call = { client, table, op: "select", filters: [] };
    const q: Record<string, unknown> = {};
    q.select = (cols: string) => {
      if (call.op === "select") call.cols = cols;
      else call.returning = cols;
      return q;
    };
    for (const op of ["insert", "update", "upsert", "delete"] as const) {
      q[op] = (p: unknown) => {
        call.op = op;
        call.payload = p;
        return q;
      };
    }
    for (const m of ["eq", "neq", "in", "is", "not", "gte", "lte", "gt", "lt", "order", "limit", "or", "match"]) {
      q[m] = (column: string, value: unknown) => {
        call.filters.push([m, String(column), value]);
        return q;
      };
    }
    const run = () => {
      st.calls.push(call);
      return reply(call);
    };
    q.maybeSingle = q.single = async () => run();
    q.then = (res: (r: Reply) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej);
    return q;
  };
  return {
    createAdminSupabase: () => ({ from: (t: string) => builder("admin", t) }),
    createServerSupabase: async () => ({
      auth: { getUser: async () => ({ data: { user: st.user } }) },
      from: (t: string) => builder("server", t),
    }),
  };
});

import {
  confirmDoubtfulInvoice,
  emitInvoiceAction,
  loadInvoicePanel,
  registerExternalInvoice,
  releaseDoubtfulInvoice,
  requestInvoiceRetry,
  type InvoicePanelData,
  type InvoicePanelRow,
} from "@/app/dashboard/pedidos/invoice-actions";
import {
  BACKFILL_REVIEW_TEXT,
  ConfirmDoubtForm,
  EmitInvoiceConfirm,
  EmitInvoiceControl,
  EmitOutcome,
  ExternalInvoiceForm,
  MANUAL_WHO_TEXT,
  OrderInvoicePanel,
  OrderInvoicePanelView,
  ReleaseDoubtForm,
  SHOPIFY_LATER_TEXT,
  SHOPIFY_MANUAL_TEXT,
  SHOPIFY_NO_TOKEN_TEXT,
  SHOPIFY_RETRY_TEXT,
  SIMPLEFACT_CHECK_LABEL,
  doubtConfirmation,
  emitBeforeStartText,
  emitConfirmation,
  externalInvoiceConfirmation,
  invoicePanelView,
  releaseDoubtText,
  reviewIssuerId,
  sendOnce,
  shopifyNextText,
} from "@/components/order-invoice-panel";
import { SHOPIFY_LEVEL_REASONS, invoiceEmitNowReadiness, shopifyBlockedReasons } from "@/lib/invoicing/server";
import {
  INVOICE_REASONS,
  INVOICE_REASON_LABEL,
  INVOICE_RELEASE_MIN_AGE_MS,
  INVOICE_RELEASE_UNKNOWN_TEXT,
  invoiceEligibility,
  invoiceNoteRef,
  invoiceReleaseWaitText,
  type InvoiceIssuer,
  type InvoiceOrderFacts,
  type InvoiceReason,
} from "@/lib/invoicing/rules";

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

const ORDER = "7b1d2c3e-1111-4222-8333-944455556666";
const STORE = "store-1";
const ORG = "org-1";
const INVOICE = "6f1c2a3b-aaaa-4bbb-8ccc-dddddddddddd";
const RUC = "20556792829";

const ISSUER: InvoiceIssuer = {
  id: "iss-1",
  orgId: ORG,
  ruc: RUC,
  legalName: "GRUPO GF S.A.C.",
  mode: "simulacion",
  emitFrom: "2026-10-14T00:00:00Z",
  dailyLimit: 40,
  hasToken: true,
  checkedRuc: RUC,
};

/** Otro RUC de la misma organización: con él no entró el pago del pedido de prueba. */
const OTRO_RUC = "20100000009";
const OTRO: InvoiceIssuer = { ...ISSUER, id: "iss-2", ruc: OTRO_RUC, legalName: "OTRA EMPRESA S.A.C.", checkedRuc: OTRO_RUC };

/** Un pedido que cumple todo (§35.3): pagado por link de Flow a la pasarela de Grupo GF. */
const factsFor = (over: Partial<InvoiceOrderFacts> = {}): InvoiceOrderFacts => ({
  orderId: ORDER,
  storeId: STORE,
  orderName: "#KP136181",
  total: 85,
  currency: "PEN",
  cancelledAt: null,
  totalRefunded: 0,
  financialStatus: "pending",
  paymentGateway: "manual",
  orderDate: "2026-10-14T10:00:00Z",
  customerName: null,
  payments: [
    {
      id: "pay-1",
      kind: "total",
      amount: 85,
      validationStatus: "validado",
      registeredAt: "2026-10-14T11:00:00Z",
      validatedAt: "2026-10-14T12:00:00Z",
      vision: null,
      flowLinked: true,
      statementDestination: null,
    },
  ],
  accounts: [{ id: "acc-flow", label: "Aurela Kenku", aliases: [], phoneLastDigits: null, issuerId: ISSUER.id }],
  issuers: [ISSUER],
  existing: { realLive: false, simulated: false, errorBlocked: false },
  ...over,
});

/** Una fila de `order_invoices` como la devuelve la base. */
const dbRow = (over: Record<string, unknown> = {}) => ({
  id: INVOICE,
  mode: "real",
  status: "emitida",
  ruc: RUC,
  total: "85.00",
  serie: "B001",
  correlative: "97",
  pdf_url: "https://grupogf.simplefact.pe/files/20556792829-03-B001-97.pdf",
  error: null,
  note: null,
  created_at: "2026-10-14T15:00:00Z",
  retry_requested_at: null,
  basis: { prepaid: false, payments: [{ id: "pay-1", amount: 85, source: "flow", accountIds: ["acc-flow"] }] },
  ruc_mismatch: false,
  ...over,
});

/** Una fila ya lista para el panel. */
const row = (over: Partial<InvoicePanelRow> = {}): InvoicePanelRow => ({
  id: INVOICE,
  mode: "real",
  status: "emitida",
  ruc: RUC,
  legalName: "GRUPO GF S.A.C.",
  total: 85,
  serie: "B001",
  correlative: "97",
  pdfUrl: "https://grupogf.simplefact.pe/files/20556792829-03-B001-97.pdf",
  error: null,
  note: null,
  createdAt: "2026-10-14T15:00:00Z",
  retryRequestedAt: null,
  manual: false,
  rucMismatch: false,
  items: null,
  releaseAvailableAt: null,
  ...over,
});

const panelData = (over: Partial<InvoicePanelData> = {}): InvoicePanelData => ({
  active: true,
  invoices: [],
  review: { state: "lista", ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "simulacion", issuerId: ISSUER.id },
  check: null,
  creditNote: null,
  issuers: [{ id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "simulacion" }],
  canManage: false,
  canEmitNow: true,
  emitNow: null,
  emitNowBlocked: null,
  ...over,
});

/** El HTML como texto: sin etiquetas y con los espacios juntos. */
const texto = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function pinta(data: InvoicePanelData): string {
  return renderToStaticMarkup(
    createElement(OrderInvoicePanelView, { orderId: ORDER, data, pending: false, run: async () => true }),
  );
}

const callsTo = (table: string, op?: Call["op"]) =>
  st.calls.filter((c) => c.table === table && (op === undefined || c.op === op));
const has = (c: Call | undefined, m: string, col: string, v?: unknown) =>
  (c?.filters ?? []).some(
    ([fm, fc, fv]) => fm === m && fc === col && (v === undefined || JSON.stringify(fv) === JSON.stringify(v)),
  );
const writes = () => st.calls.filter((c) => c.op !== "select");

beforeEach(() => {
  // Producción: «Emitir esta boleta» solo existe ahí (`invoiceEmitAllowedHere`).
  // Las pruebas de la vista previa lo cambian.
  vi.stubEnv("VERCEL_ENV", "production");
  st.calls = [];
  st.user = { id: "user-1" };
  st.orgPerms = { [ORG]: ["invoices.manage"] };
  st.permArgs = [];
  st.issuers = [ISSUER];
  st.issuersError = null;
  st.issuerArgs = [];
  st.facts = new Map([[ORDER, factsFor()]]);
  st.factsError = null;
  st.factsArgs = [];
  st.emitResult = null;
  st.emitThrows = null;
  st.emitArgs = [];
  st.db = {
    orderMaster: { order_id: ORDER, store_id: STORE },
    orderMasterError: null,
    store: { org_id: ORG, status: "active" },
    invoices: [],
    invoicesError: null,
    checks: [],
    checksError: null,
    requests: [],
    requestsError: null,
    invoiceRef: { id: INVOICE, org_id: ORG, order_id: ORDER, mode: "real", status: "error", retry_requested_at: null },
    order: { id: ORDER, store_id: STORE, name: "#KP136181", total_amount: "85.00" },
    orderError: null,
    insertError: null,
    updateData: [{ id: INVOICE }],
    updateError: null,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ── Lectura ─────────────────────────────────────────────────────────────────

describe("loadInvoicePanel: lo ve quien ve el pedido (§35.7)", () => {
  it("el pedido de prueba cumple las reglas (sanidad del andamiaje)", () => {
    expect(invoiceEligibility(factsFor()).ok).toBe(true);
  });

  it("sin acceso al pedido no lee nada de comprobantes", async () => {
    st.db.orderMaster = null;
    expect(await loadInvoicePanel(ORDER)).toEqual({ error: "Sin acceso a este pedido." });
    expect(st.calls.filter((c) => c.client === "admin")).toEqual([]);
    expect(st.factsArgs).toEqual([]);
    expect(st.issuerArgs).toEqual([]);
  });

  it("el acceso lo decide RLS: el pedido y la tienda se leen con el cliente del usuario", async () => {
    await loadInvoicePanel(ORDER);
    const master = callsTo("order_master")[0];
    expect(master?.client).toBe("server");
    expect(has(master, "eq", "order_id", ORDER)).toBe(true);
    expect(callsTo("stores")[0]?.client).toBe("server");
  });

  it("una lectura caída del pedido no se disfraza de «sin acceso»", async () => {
    st.db.orderMasterError = { message: "timeout" };
    expect(await loadInvoicePanel(ORDER)).toEqual({ error: "No se pudo leer el pedido: timeout" });
  });

  it("sin sesión manda a entrar", async () => {
    st.user = null;
    await expect(loadInvoicePanel(ORDER)).rejects.toThrow("redirect:/login");
  });

  it("sin comprobantes y con las reglas cumplidas: lista, con su RUC y su modo", async () => {
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res).toBe(true);
    if (!("data" in res)) return;
    expect(res.data.active).toBe(true);
    expect(res.data.invoices).toEqual([]);
    expect(res.data.review).toEqual({
      state: "lista",
      ruc: RUC,
      legalName: "GRUPO GF S.A.C.",
      mode: "simulacion",
      issuerId: ISSUER.id,
    });
    expect(res.data.canManage).toBe(true);
    expect(st.permArgs).toContainEqual([ORG, "invoices.manage"]);
    expect(st.factsArgs[0]?.[1]).toEqual([ORDER]);
    expect(st.issuerArgs[0]?.[1]).toBe(ORG);
  });

  it("sin el permiso lo ve igual, pero no puede gestionar", async () => {
    st.orgPerms = { [ORG]: [] };
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.canManage).toBe(false);
    expect("data" in res && res.data.review.state).toBe("lista");
  });

  it("los comprobantes del pedido, del más nuevo al más viejo, solo con lo que se enseña", async () => {
    st.db.invoices = [dbRow()];
    const res = await loadInvoicePanel(ORDER);
    const q = callsTo("order_invoices", "select")[0]!;
    expect(q.client).toBe("admin");
    expect(has(q, "eq", "order_id", ORDER)).toBe(true);
    expect(has(q, "order", "created_at", { ascending: false })).toBe(true);
    expect(q.cols!.split(",").map((c) => c.trim())).toEqual([
      "id",
      "mode",
      "status",
      "ruc",
      "total",
      "serie",
      "correlative",
      "pdf_url",
      "error",
      "note",
      "created_at",
      "retry_requested_at",
      "basis",
      "ruc_mismatch",
      // Cuándo quedó en duda: desde ahí se cuenta la espera para liberarlo.
      "updated_at",
    ]);
    expect("data" in res && res.data.invoices).toEqual([
      row({ legalName: "GRUPO GF S.A.C.", items: null }),
    ]);
  });

  it("nunca lleva credenciales: ni token ni nada que lo nombre", async () => {
    // Aunque el lector de RUC devolviera de más, al navegador va RUC y razón social.
    st.issuers = [{ ...ISSUER, token_enc: "v1:secreto", hasToken: true }];
    st.db.invoices = [dbRow()];
    const res = await loadInvoicePanel(ORDER);
    expect(JSON.stringify(res)).not.toMatch(/token|secreto/i);
    // El modo sí viaja: con él el panel sabe si el RUC está en «Manual».
    expect("data" in res && res.data.issuers).toEqual([
      { id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "simulacion" },
    ]);
    // Ninguna consulta del panel pide el token, ni la tabla de RUC directamente.
    expect(st.calls.some((c) => /token/i.test(`${c.cols ?? ""}${c.returning ?? ""}`))).toBe(false);
    expect(callsTo("invoice_issuers")).toEqual([]);
  });

  it("la última revisión del barrido viaja con el panel", async () => {
    st.db.checks = [{ mode: "simulacion", reason: "editado", detail: null, checked_at: "2026-10-14T14:50:00Z" }];
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.check).toEqual({
      mode: "simulacion",
      reason: "editado",
      detail: null,
      checkedAt: "2026-10-14T14:50:00Z",
    });
    const q = callsTo("invoice_order_checks")[0]!;
    expect(has(q, "eq", "order_id", ORDER)).toBe(true);
    expect(has(q, "order", "checked_at", { ascending: false })).toBe(true);
  });

  it("la simulada trae los ítems de la boleta que habría enviado", async () => {
    st.db.invoices = [dbRow({ mode: "simulacion", status: "simulada", serie: null, correlative: null, pdf_url: null })];
    st.db.requests = [
      {
        id: INVOICE,
        request: {
          items: [
            { code: "SKU-1", name: "Shampoo Birú", qty: 1, price: 75, tax_percent: 18 },
            { code: "ENVIO", name: "Servicio de envío", qty: 1, price: 10, tax_percent: 18 },
          ],
        },
      },
    ];
    const res = await loadInvoicePanel(ORDER);
    const q = callsTo("order_invoices", "select").find((c) => c.cols === "id, request")!;
    expect(has(q, "eq", "order_id", ORDER)).toBe(true);
    expect(has(q, "eq", "mode", "simulacion")).toBe(true);
    expect("data" in res && res.data.invoices[0]?.items).toEqual([
      { code: "SKU-1", name: "Shampoo Birú", qty: 1, price: 75 },
      { code: "ENVIO", name: "Servicio de envío", qty: 1, price: 10 },
    ]);
  });

  // FIX: un `en_duda` recién nacido se podía liberar al instante (§35.4). El
  // panel lleva desde cuándo se puede, para no ofrecer lo que el servidor rechaza.
  it("un `en_duda` lleva desde cuándo se puede liberar: 30 minutos desde que quedó en duda, al minuto", async () => {
    st.db.invoices = [dbRow({ status: "en_duda", serie: null, correlative: null, pdf_url: null, created_at: "2026-10-14T19:44:00Z", updated_at: "2026-10-14T19:45:10Z" })];
    let res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.invoices[0]?.releaseAvailableAt).toBe("2026-10-14T20:16:00.000Z");
    // Sin saber cuándo quedó en duda, null: el servidor tampoco lo libera.
    st.db.invoices = [dbRow({ status: "en_duda", serie: null, updated_at: null })];
    res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.invoices[0]?.releaseAvailableAt).toBeNull();
    // Solo en un `en_duda`.
    for (const status of ["emitida", "emitiendo", "error", "externa"]) {
      st.db.invoices = [dbRow({ status, updated_at: "2026-10-14T19:45:10Z" })];
      res = await loadInvoicePanel(ORDER);
      expect("data" in res && res.data.invoices[0]?.releaseAvailableAt, status).toBeNull();
    }
  });

  it("de una real no se pide lo enviado", async () => {
    st.db.invoices = [dbRow()];
    await loadInvoicePanel(ORDER);
    expect(callsTo("order_invoices", "select").some((c) => c.cols === "id, request")).toBe(false);
  });
});

describe("loadInvoicePanel: leer mal no es «no tiene» (§35.3, falla cerrada)", () => {
  it("si los hechos del pedido no se pudieron leer, no revisa: ni «lista» ni motivo", async () => {
    st.factsError = new Error("No se pudo leer order_payments: timeout");
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review).toEqual({
      state: "sin_revisar",
      error: "No se pudo leer order_payments: timeout",
    });
    if (!("data" in res)) return;
    const html = texto(pinta(res.data));
    expect(html).not.toContain("Lista para emitirse");
    expect(html).toContain("No se pudo revisar si lleva comprobante: No se pudo leer order_payments: timeout");
  });

  it("un pedido que el lector no devolvió tampoco se da por revisado", async () => {
    st.facts = new Map();
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review.state).toBe("sin_revisar");
  });

  it("los comprobantes que no se pudieron leer son un error, no una lista vacía", async () => {
    st.db.invoicesError = { message: "permission denied" };
    expect(await loadInvoicePanel(ORDER)).toEqual({ error: "No se pudieron leer los comprobantes: permission denied" });
  });

  it("la revisión del barrido, los RUC y la simulada tampoco se tragan su error", async () => {
    st.db.checksError = { message: "timeout" };
    expect(await loadInvoicePanel(ORDER)).toEqual({ error: "No se pudo leer la última revisión: timeout" });
    st.db.checksError = null;
    st.issuersError = new Error("No se pudo leer invoice_issuers: timeout");
    expect(await loadInvoicePanel(ORDER)).toEqual({
      error: "No se pudieron leer los RUC: No se pudo leer invoice_issuers: timeout",
    });
    st.issuersError = null;
    st.db.invoices = [dbRow({ mode: "simulacion", status: "simulada" })];
    st.db.requestsError = { message: "timeout" };
    expect(await loadInvoicePanel(ORDER)).toEqual({ error: "No se pudo leer la boleta simulada: timeout" });
  });

  it.each([
    { code: "42P01", message: 'relation "public.order_invoices" does not exist' },
    { code: "PGRST205", message: "Could not find the table 'public.order_invoices' in the schema cache" },
  ])("sin la 0257 en la base el panel no se dibuja (%s)", async (error) => {
    st.db.invoicesError = error;
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.active).toBe(false);
  });

  it("una organización sin RUC ni comprobantes no dibuja el panel (§29.15)", async () => {
    st.issuers = [];
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.active).toBe(false);
    expect(renderToStaticMarkup(createElement(OrderInvoicePanel, { orderId: ORDER, pending: false, run: async () => true }))).toBe("");
  });

  it("en una tienda que no está activa no se dice «lista»: el barrido no pasa por ella", async () => {
    st.db.store = { org_id: ORG, status: "inactive" };
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review).toEqual({ state: "no", reason: "tienda", detail: null, issuerId: ISSUER.id });
  });

  it("un pedido que no cumple dice el primer motivo de §35.3, con su detalle", async () => {
    st.facts = new Map([[ORDER, factsFor({ accounts: [{ ...factsFor().accounts[0]!, issuerId: null }] })]]);
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review).toEqual({
      state: "no",
      reason: "cuenta_sin_ruc",
      detail: "Aurela Kenku no tiene RUC.",
      // Sin RUC no hay a cuál preelegir en «Ya tiene comprobante».
      issuerId: null,
    });
  });

  it("el de más de S/ 700 no sale solo, pero trae el RUC del pago: «Ya tiene comprobante» lo preelige", async () => {
    const caro = factsFor({
      total: 850,
      issuers: [ISSUER, OTRO],
      payments: [{ ...factsFor().payments[0]!, amount: 850 }],
    });
    const elig = invoiceEligibility(caro);
    expect(elig).toMatchObject({ ok: false, reason: "monto_mayor_700" });
    // OTRO primero: si el formulario tomara el primero de la lista, se notaría.
    st.issuers = [OTRO, ISSUER];
    st.facts = new Map([[ORDER, caro]]);
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review).toEqual({
      state: "no",
      reason: "monto_mayor_700",
      detail: elig.ok ? null : (elig.detail ?? null),
      issuerId: ISSUER.id,
    });
    if (!("data" in res)) return;
    expect(reviewIssuerId(res.data.review)).toBe(ISSUER.id);
    const form = renderToStaticMarkup(
      createElement(ExternalInvoiceForm, {
        issuers: res.data.issuers,
        defaultIssuerId: reviewIssuerId(res.data.review),
        pending: false,
        onSubmit: async () => true,
        onCancel: () => {},
      }),
    );
    expect(form).toContain(`<option value="${ISSUER.id}" selected="">${RUC} · GRUPO GF S.A.C.</option>`);
    expect(form).not.toContain(`<option value="${OTRO.id}" selected="">`);
  });
});

describe("loadInvoicePanel: una emitida con archivos de otro RUC (FIX F)", () => {
  it("trae la marca `ruc_mismatch` y su error", async () => {
    const error = `SimpleFact contestó con archivos del RUC ${OTRO_RUC}, no del ${RUC}.`;
    st.db.invoices = [dbRow({ ruc_mismatch: true, error })];
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.invoices[0]).toMatchObject({ status: "emitida", rucMismatch: true, error });
    st.db.invoices = [dbRow()];
    const bien = await loadInvoicePanel(ORDER);
    expect("data" in bien && bien.data.invoices[0]?.rucMismatch).toBe(false);
  });
});

/** Lo que guarda el barrido en `invoice_order_checks`. */
const checkRow = (reason: string, over: Record<string, unknown> = {}) => ({
  mode: "simulacion",
  reason,
  detail: null,
  checked_at: "2026-10-14T14:50:00Z",
  ...over,
});

/** Cómo se dice cada motivo de Shopify. Un motivo nuevo sin fila aquí hace fallar la prueba. */
const SHOPIFY_RETRY_EXPECTED: Record<string, boolean> = {
  prueba: false,
  editado: false,
  cantidad_editada: false,
  envio_editado: false,
  propina: false,
  gift_card: false,
  linea_gratuita: false,
  impuesto_encima: false,
  demasiadas_lineas: false,
  no_cuadra: false,
  total_distinto: false,
  pago_web_no_confirmado: false,
  no_encontrado: false,
  lectura_fallida: true,
  sin_token_shopify: true,
};

describe("loadInvoicePanel: lo que frena Shopify no es «lista» (FIX G)", () => {
  it("las reglas de Kapta se cumplen pero la última pasada lo frenó en Shopify: eso manda", async () => {
    st.db.checks = [checkRow("editado")];
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review).toEqual({
      state: "shopify",
      ruc: RUC,
      legalName: "GRUPO GF S.A.C.",
      mode: "simulacion",
      issuerId: ISSUER.id,
      reason: "editado",
      detail: null,
      checkedAt: "2026-10-14T14:50:00Z",
      retry: false,
      waitsHours: true,
    });
    // Hacen falta las dos revisiones (una por modo), no solo la más nueva.
    expect((callsTo("invoice_order_checks")[0]?.filters ?? []).some(([m]) => m === "limit")).toBe(false);
  });

  it.each([...SHOPIFY_LEVEL_REASONS, "lectura_fallida" as InvoiceReason])(
    "«%s» de Shopify frena, y se sabe si se reintenta solo",
    async (reason) => {
      expect(SHOPIFY_RETRY_EXPECTED[reason], `falta decir cómo se enseña «${reason}»`).toBeDefined();
      st.db.checks = [checkRow(reason, { detail: reason === "no_cuadra" ? "Faltan S/ 0.01." : null })];
      const res = await loadInvoicePanel(ORDER);
      expect("data" in res && res.data.review).toMatchObject({
        state: "shopify",
        reason,
        retry: SHOPIFY_RETRY_EXPECTED[reason],
      });
    },
  );

  // El texto lo manda la lista del barrido: si un motivo entra o sale de
  // `SHOPIFY_LEVEL_REASONS` (el `p_blocked` de la base), lo que se promete cambia
  // con él. Recorre TODOS los motivos, no una copia de la lista.
  it.each([...INVOICE_REASONS])("«%s»: el panel promete lo que hace el barrido", async (reason) => {
    st.db.checks = [checkRow(reason, { detail: reason === "no_cuadra" ? "Faltan S/ 0.01." : null })];
    const res = await loadInvoicePanel(ORDER);
    if (!("data" in res)) throw new Error(res.error);
    const review = res.data.review;
    const shopify = SHOPIFY_LEVEL_REASONS.has(reason) || reason === "lectura_fallida";
    expect(review.state).toBe(shopify ? "shopify" : "lista");
    if (review.state !== "shopify") return;
    const t = texto(pinta(res.data));
    expect(review.waitsHours).toBe(SHOPIFY_LEVEL_REASONS.has(reason));
    if (SHOPIFY_LEVEL_REASONS.has(reason)) {
      // No se relee en 6 horas: nada de «la próxima pasada».
      expect(t).not.toMatch(/próxima pasada/i);
      expect(t).toContain(review.retry ? "Se vuelve a revisar en unas horas" : SHOPIFY_MANUAL_TEXT);
    } else {
      // Se relee en la próxima pasada, y se dice una vez.
      expect(t.match(/próxima pasada/gi)).toHaveLength(1);
    }
  });

  it("la lista del panel es la que salta la base: `p_blocked` y 6 horas", () => {
    expect(shopifyBlockedReasons()).toEqual([...SHOPIFY_LEVEL_REASONS].sort());
    expect(read("lib/invoicing/server.ts")).toContain("p_blocked: shopifyBlockedReasons(),");
    // `invoice_candidates` la crea la 0260 (la 0257 que corrió en producción no la tenía).
    const sql = read("db/migrations/0260_invoices_hardening.sql").replace(/\s+/g, " ");
    expect(sql).toContain("and c.reason = any (coalesce(p_blocked, '{}'::text[])) and c.checked_at > now() - interval '6 hours'");
  });

  it("cada motivo que el panel clasifica es de Shopify (la tabla no se queda con sobras)", () => {
    const shopify = new Set<string>([...SHOPIFY_LEVEL_REASONS, "lectura_fallida"]);
    expect(Object.keys(SHOPIFY_RETRY_EXPECTED).filter((r) => !shopify.has(r))).toEqual([]);
  });

  it("un motivo del turno (el tope) no frena las reglas: sigue lista y se enseña aparte", async () => {
    st.db.checks = [checkRow("tope")];
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review.state).toBe("lista");
    expect("data" in res && res.data.check?.reason).toBe("tope");
  });

  it("un motivo que no se conoce no se inventa como bloqueo", async () => {
    st.db.checks = [checkRow("algo_nuevo")];
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review.state).toBe("lista");
  });

  it("si Kapta ya dice que no, ese es el motivo: Shopify viene después", async () => {
    st.db.checks = [checkRow("editado")];
    st.facts = new Map([[ORDER, factsFor({ cancelledAt: "2026-10-14T18:00:00Z" })]]);
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review).toMatchObject({ state: "no", reason: "anulado" });
  });

  it("la revisión del otro modo frena si es de Shopify y más nueva (el barrido la respeta)", async () => {
    st.db.checks = [
      checkRow("editado", { mode: "real", checked_at: "2026-10-14T15:00:00Z" }),
      checkRow("tope", { checked_at: "2026-10-14T14:00:00Z" }),
    ];
    let res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review).toMatchObject({ state: "shopify", reason: "editado", mode: "simulacion" });
    // Sin revisión propia, también.
    st.db.checks = [checkRow("editado", { mode: "real" })];
    res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review.state).toBe("shopify");
    // Una propia más nueva que no es de Shopify: Shopify ya se volvió a leer y pasó.
    st.db.checks = [
      checkRow("tope", { checked_at: "2026-10-14T15:00:00Z" }),
      checkRow("editado", { mode: "real", checked_at: "2026-10-14T14:00:00Z" }),
    ];
    res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review.state).toBe("lista");
    // `lectura_fallida` del otro modo no cuenta: el barrido la reintenta siempre.
    st.db.checks = [checkRow("lectura_fallida", { mode: "real" })];
    res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review.state).toBe("lista");
  });
});

describe("loadInvoicePanel: nota de crédito (§35.9)", () => {
  it("un pago del comprobante que dejó de estar validado pide revisar", async () => {
    st.db.invoices = [dbRow()];
    st.facts = new Map([
      [ORDER, factsFor({ payments: [{ ...factsFor().payments[0]!, validationStatus: "rechazado" }] })],
    ]);
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.creditNote).toBe(
      "Un pago del comprobante ya no está validado: revisa si corresponde una nota de crédito.",
    );
  });

  it("anulado o reembolsado después de emitir también", async () => {
    st.db.invoices = [dbRow()];
    st.facts = new Map([[ORDER, factsFor({ cancelledAt: "2026-10-14T18:00:00Z" })]]);
    let res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.creditNote).toMatch(/se anuló después del comprobante/);
    st.facts = new Map([[ORDER, factsFor({ totalRefunded: 20 })]]);
    res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.creditNote).toMatch(/tiene un reembolso/);
  });

  it("con sus pagos validados, o sin comprobante vivo, no hay aviso", async () => {
    st.db.invoices = [dbRow()];
    let res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.creditNote).toBeNull();
    st.db.invoices = [dbRow({ status: "error", serie: null, correlative: null, pdf_url: null })];
    st.facts = new Map([[ORDER, factsFor({ cancelledAt: "2026-10-14T18:00:00Z" })]]);
    res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.creditNote).toBeNull();
  });

  it("una externa avisa si se anuló, aunque no tenga pagos en qué basarse", async () => {
    st.db.invoices = [dbRow({ status: "externa", basis: { manual: true }, pdf_url: null })];
    st.facts = new Map([[ORDER, factsFor({ cancelledAt: "2026-10-14T18:00:00Z" })]]);
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.creditNote).toMatch(/se anuló/);
    expect("data" in res && res.data.invoices[0]?.manual).toBe(true);
  });
});

// ── Escrituras ──────────────────────────────────────────────────────────────

describe("registerExternalInvoice: «Ya tiene comprobante» (§35.4)", () => {
  it("pide «Boletas y facturas» en la organización del pedido", async () => {
    st.orgPerms = { [ORG]: ["master.edit"], "otra-org": ["invoices.manage"] };
    const res = await registerExternalInvoice(ORDER, ISSUER.id, "B001-123", "");
    expect(res.error).toMatch(/^Sin permiso/);
    expect(st.permArgs).toEqual([[ORG, "invoices.manage"]]);
    expect(writes()).toEqual([]);
  });

  it("sin acceso al pedido no llega ni a preguntar el permiso", async () => {
    st.db.orderMaster = null;
    expect(await registerExternalInvoice(ORDER, ISSUER.id, "B001-123", "")).toEqual({
      error: "Sin acceso a este pedido.",
    });
    expect(st.permArgs).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("registra la externa con el RUC, el total del pedido y quién la registró", async () => {
    const res = await registerExternalInvoice(ORDER, ISSUER.id, " b001-123 ", "  La emitió Rosa con DNI  ");
    expect(res).toEqual({ notice: "Comprobante B001-123 registrado: Kapta no emitirá otro por este pedido." });
    const insert = callsTo("order_invoices", "insert")[0]!;
    expect(insert.client).toBe("admin");
    const payload = insert.payload as Record<string, unknown>;
    expect(payload.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect({ ...payload, id: "x" }).toEqual({
      id: "x",
      org_id: ORG,
      store_id: STORE,
      order_id: ORDER,
      issuer_id: ISSUER.id,
      ruc: RUC,
      mode: "real",
      status: "externa",
      invoice_type: "03",
      order_name: "#KP136181",
      total: 85,
      basis: { manual: true },
      serie: "B001",
      correlative: "123",
      note: "La emitió Rosa con DNI",
      created_by: "user-1",
    });
    // El total sale de `orders`, no de lo que diga el navegador.
    expect(has(callsTo("orders")[0], "eq", "id", ORDER)).toBe(true);
  });

  it("F es factura (01); los ceros a la izquierda del número no cuentan; sin nota va null", async () => {
    await registerExternalInvoice(ORDER, ISSUER.id, "F001-0009", "   ");
    const payload = callsTo("order_invoices", "insert")[0]!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ invoice_type: "01", serie: "F001", correlative: "9", note: null });
  });

  it.each(["123", "B01-1", "B001-", "B001-123456789", "B0011-12", "B001 123", "-123", "B001-12a"])(
    "«%s» no es una serie y número",
    async (typed) => {
      const res = await registerExternalInvoice(ORDER, ISSUER.id, typed, "");
      expect(res).toEqual({ error: "Escribe la serie y el número como en SimpleFact: B001-123." });
      expect(writes()).toEqual([]);
    },
  );

  it("una serie que no empieza con B ni F no es boleta ni factura", async () => {
    expect(await registerExternalInvoice(ORDER, ISSUER.id, "E001-12", "")).toEqual({
      error: "La serie empieza con B (boleta) o con F (factura).",
    });
    expect(await registerExternalInvoice(ORDER, ISSUER.id, "B001-0000", "")).toEqual({
      error: "El número del comprobante no puede ser 0.",
    });
    expect(writes()).toEqual([]);
  });

  it("el RUC tiene que ser de la organización del pedido", async () => {
    expect(await registerExternalInvoice(ORDER, "iss-de-otra-org", "B001-1", "")).toEqual({
      error: "Ese RUC no es de la organización del pedido.",
    });
    expect(st.issuerArgs[0]?.[1]).toBe(ORG);
    expect(writes()).toEqual([]);
  });

  it("sin monto no se registra (la base exige total > 0)", async () => {
    st.db.order = { id: ORDER, store_id: STORE, name: "#KP1", total_amount: "0.00" };
    expect((await registerExternalInvoice(ORDER, ISSUER.id, "B001-1", "")).error).toMatch(/no tiene monto/);
    st.db.order = { id: ORDER, store_id: STORE, name: "#KP1", total_amount: null };
    expect((await registerExternalInvoice(ORDER, ISSUER.id, "B001-1", "")).error).toMatch(/no tiene monto/);
    expect(writes()).toEqual([]);
  });

  it("si ya hay un comprobante vivo, la base lo dice y se traduce", async () => {
    st.db.insertError = { code: "23505", message: "duplicate key value violates unique constraint" };
    expect(await registerExternalInvoice(ORDER, ISSUER.id, "B001-123", "")).toEqual({
      error: "Este pedido ya tiene un comprobante (o Kapta lo está emitiendo).",
    });
  });
});

describe("registerExternalInvoice: el RUC es el de la cuenta que recibió el pago (FIX H)", () => {
  beforeEach(() => {
    st.issuers = [ISSUER, OTRO];
    st.facts = new Map([[ORDER, factsFor({ issuers: [ISSUER, OTRO] })]]);
  });

  const MISMO_RUC = `El pago entró a una cuenta del RUC ${RUC}: registra el comprobante de ese RUC.`;

  it("con el pago en una cuenta de Grupo GF, la boleta de otro RUC no se registra", async () => {
    expect(await registerExternalInvoice(ORDER, OTRO.id, "B001-123", "")).toEqual({ error: MISMO_RUC });
    expect(writes()).toEqual([]);
    expect(st.factsArgs[0]?.[1]).toEqual([ORDER]);
  });

  it("el de más de S/ 700 (el caso de la externa) también: las reglas saben el RUC aunque no emitan", async () => {
    const caro = factsFor({
      total: 850,
      issuers: [ISSUER, OTRO],
      payments: [{ ...factsFor().payments[0]!, amount: 850 }],
    });
    expect(invoiceEligibility(caro)).toMatchObject({ ok: false, reason: "monto_mayor_700", issuerId: ISSUER.id });
    st.facts = new Map([[ORDER, caro]]);
    expect(await registerExternalInvoice(ORDER, OTRO.id, "B001-123", "")).toEqual({ error: MISMO_RUC });
    expect(writes()).toEqual([]);
    expect((await registerExternalInvoice(ORDER, ISSUER.id, "B001-123", "")).notice).toMatch(/registrado/);
    expect((callsTo("order_invoices", "insert")[0]!.payload as Record<string, unknown>).issuer_id).toBe(ISSUER.id);
  });

  it("si las reglas no saben el RUC (cuenta sin RUC), vale el que elige quien registra", async () => {
    st.facts = new Map([
      [ORDER, factsFor({ issuers: [ISSUER, OTRO], accounts: [{ ...factsFor().accounts[0]!, issuerId: null }] })],
    ]);
    expect((await registerExternalInvoice(ORDER, OTRO.id, "B001-123", "")).notice).toMatch(/registrado/);
    expect((callsTo("order_invoices", "insert")[0]!.payload as Record<string, unknown>).ruc).toBe(OTRO_RUC);
  });

  it("con RUC mezclados las reglas tampoco lo saben: vale el que elige quien registra", async () => {
    // Dos cuentas de la pasarela, cada una de un RUC: el pago por Flow no dice de cuál.
    const mezclados = factsFor({
      issuers: [ISSUER, OTRO],
      accounts: [
        factsFor().accounts[0]!,
        { id: "acc-flow-2", label: "Otra pasarela", aliases: [], phoneLastDigits: null, issuerId: OTRO.id },
      ],
    });
    expect(invoiceEligibility(mezclados)).toMatchObject({ ok: false, reason: "ruc_mezclados" });
    st.facts = new Map([[ORDER, mezclados]]);
    expect((await registerExternalInvoice(ORDER, OTRO.id, "B001-123", "")).notice).toMatch(/registrado/);
  });

  // FIX: una lectura caída de los hechos caía en «no se sabe» y dejaba registrar
  // cualquier RUC. La externa no se corrige después: una caída de la base dejaba
  // al pedido, para siempre, con la boleta de una empresa que no cobró.
  const SIN_COMPROBAR = "No se pudo comprobar a qué RUC entró el pago; intenta de nuevo.";

  it("si los hechos no se pudieron leer, no se registra: ni otro RUC ni el que sería (falla cerrada)", async () => {
    st.factsError = new Error("No se pudo leer order_payments: timeout");
    expect(await registerExternalInvoice(ORDER, OTRO.id, "B001-123", "")).toEqual({ error: SIN_COMPROBAR });
    expect(await registerExternalInvoice(ORDER, ISSUER.id, "B001-123", "")).toEqual({ error: SIN_COMPROBAR });
    expect(writes()).toEqual([]);
    // Ni siquiera llega a leer el pedido para armar la fila.
    expect(callsTo("orders")).toEqual([]);
    // Cuando la lectura vuelve, se registra como siempre.
    st.factsError = null;
    expect((await registerExternalInvoice(ORDER, ISSUER.id, "B001-123", "")).notice).toMatch(/registrado/);
  });

  it("si el lector no devolvió el pedido, tampoco: no se comprobó nada", async () => {
    st.facts = new Map();
    expect(await registerExternalInvoice(ORDER, OTRO.id, "B001-124", "")).toEqual({ error: SIN_COMPROBAR });
    expect(writes()).toEqual([]);
  });

  it("con el RUC correcto se registra como siempre", async () => {
    expect((await registerExternalInvoice(ORDER, ISSUER.id, "B001-123", "")).notice).toMatch(/registrado/);
  });
});

/** Lo que se dice después de «Volver a intentar» o de liberar, sin saber el modo del RUC. */
const NEXT_UNKNOWN =
  "con el RUC en Real se vuelve a intentar en la próxima pasada, y en Manual vuelve a aparecer «Emitir esta boleta» en el pedido, si sigue cumpliendo las reglas.";

/** El modo del RUC del pedido y lo que se promete después de reintentar o liberar. */
const NEXT_ATTEMPT: Array<[string, () => void, string]> = [
  [
    "Real: el barrido, en la próxima pasada",
    () => (st.facts = new Map([[ORDER, factsFor({ issuers: [{ ...ISSUER, mode: "real" }] })]])),
    "se vuelve a intentar en la próxima pasada, si el pedido sigue cumpliendo las reglas.",
  ],
  [
    "Manual: vuelve el botón, no la pasada",
    () => (st.facts = new Map([[ORDER, factsFor({ issuers: [{ ...ISSUER, mode: "manual" }] })]])),
    "vuelve a aparecer «Emitir esta boleta» en el pedido, si sigue cumpliendo las reglas.",
  ],
  [
    "Manual, aunque ya tenga su simulada",
    () =>
      (st.facts = new Map([
        [ORDER, factsFor({ issuers: [{ ...ISSUER, mode: "manual" }], existing: { realLive: false, simulated: true, errorBlocked: false } })],
      ])),
    "vuelve a aparecer «Emitir esta boleta» en el pedido, si sigue cumpliendo las reglas.",
  ],
  ["Simulación: los dos caminos", () => {}, NEXT_UNKNOWN],
  [
    "las reglas no llegan a saber el RUC: los dos caminos",
    () =>
      (st.facts = new Map([
        [ORDER, factsFor({ issuers: [{ ...ISSUER, mode: "manual" }], payments: [{ ...factsFor().payments[0]!, validationStatus: "pendiente_revision" }] })],
      ])),
    NEXT_UNKNOWN,
  ],
];

describe("requestInvoiceRetry: «Volver a intentar» (§35.4)", () => {
  it("pide «Boletas y facturas» y no escribe sin él", async () => {
    st.orgPerms = { [ORG]: [] };
    expect((await requestInvoiceRetry(INVOICE)).error).toMatch(/^Sin permiso/);
    expect(st.permArgs).toEqual([[ORG, "invoices.manage"]]);
    expect(writes()).toEqual([]);
  });

  it("el comprobante tiene que ser de un pedido que el usuario ve", async () => {
    st.db.orderMaster = null;
    expect(await requestInvoiceRetry(INVOICE)).toEqual({ error: "Sin acceso a este pedido." });
    expect(has(callsTo("order_master")[0], "eq", "order_id", ORDER)).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("ni de otra organización aunque el pedido se vea", async () => {
    st.db.invoiceRef = { id: INVOICE, org_id: "otra-org", order_id: ORDER, mode: "real", status: "error", retry_requested_at: null };
    expect(await requestInvoiceRetry(INVOICE)).toEqual({ error: "Sin acceso a este pedido." });
    expect(writes()).toEqual([]);
  });

  it("un comprobante que no existe no se reintenta", async () => {
    st.db.invoiceRef = null;
    expect(await requestInvoiceRetry(INVOICE)).toEqual({ error: "Ese comprobante no existe." });
  });

  it.each(["emitida", "en_duda", "emitiendo", "externa", "simulada"])("desde %s no se reintenta", async (status) => {
    st.db.invoiceRef = { id: INVOICE, org_id: ORG, order_id: ORDER, mode: "real", status, retry_requested_at: null };
    expect(await requestInvoiceRetry(INVOICE)).toEqual({
      error: "Solo se vuelve a intentar un comprobante que terminó en error.",
    });
    expect(writes()).toEqual([]);
  });

  it("un error con el reintento ya pedido no se pide dos veces", async () => {
    st.db.invoiceRef = {
      id: INVOICE,
      org_id: ORG,
      order_id: ORDER,
      mode: "real",
      status: "error",
      retry_requested_at: "2026-10-14T13:00:00Z",
    };
    expect(await requestInvoiceRetry(INVOICE)).toEqual({ error: "Ya se pidió volver a intentar este comprobante." });
    expect(writes()).toEqual([]);
  });

  it("desde un error sin reintento: anota quién y cuándo, y filtra por el estado de partida", async () => {
    const res = await requestInvoiceRetry(INVOICE);
    expect(res.notice).toMatch(/próxima pasada/);
    const update = callsTo("order_invoices", "update")[0]!;
    expect(update.client).toBe("admin");
    const payload = update.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["retry_requested_at", "retry_requested_by"]);
    expect(payload.retry_requested_by).toBe("user-1");
    expect(Number.isFinite(Date.parse(String(payload.retry_requested_at)))).toBe(true);
    expect(has(update, "eq", "id", INVOICE)).toBe(true);
    expect(has(update, "eq", "status", "error")).toBe(true);
    expect(has(update, "is", "retry_requested_at", null)).toBe(true);
  });

  it("si otra persona lo pidió entre la lectura y la escritura, se dice", async () => {
    st.db.updateData = [];
    expect(await requestInvoiceRetry(INVOICE)).toEqual({ error: "Ya se pidió volver a intentar este comprobante." });
  });

  // FIX: decía «se vuelve a intentar en la próxima pasada» también con el RUC
  // en Manual, donde el barrido solo simula y no lo intenta: lo que vuelve es
  // el botón, y lo pulsa una persona.
  it.each(NEXT_ATTEMPT)("lo que pasa después depende del modo del RUC del pedido (%s)", async (_mode, arrange, next) => {
    arrange();
    const res = await requestInvoiceRetry(INVOICE);
    expect(res).toEqual({ notice: `Listo: ${next}` });
    // El modo es el del RUC que las reglas le dan al pedido: se leen sus hechos.
    expect(st.factsArgs.at(-1)?.[1]).toEqual([ORDER]);
  });

  it("si no se pudo leer el modo, el reintento queda pedido igual y se dicen los dos caminos", async () => {
    st.factsError = new Error("timeout");
    const res = await requestInvoiceRetry(INVOICE);
    expect(res).toEqual({ notice: `Listo: ${NEXT_UNKNOWN}` });
    expect(callsTo("order_invoices", "update")).toHaveLength(1);
  });
});

/** 15:00 de Lima del 14-10-2026: la hora de las pruebas de liberar un `en_duda`. */
const AHORA = new Date("2026-10-14T20:00:00.000Z");
const haceMin = (min: number, seg = 0) => new Date(AHORA.getTime() - min * 60_000 - seg * 1000).toISOString();

describe("releaseDoubtfulInvoice: «No está en SimpleFact: volver a intentar» (§35.4)", () => {
  /** Un `en_duda`: el turno a `created_at` y en duda desde `updated_at`. */
  const enDuda = (over: Record<string, unknown> = {}) => ({
    id: INVOICE,
    org_id: ORG,
    order_id: ORDER,
    mode: "real",
    status: "en_duda",
    retry_requested_at: null,
    created_at: haceMin(61),
    updated_at: haceMin(60),
    ...over,
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AHORA);
    st.db.invoiceRef = enDuda();
  });

  it("pide «Boletas y facturas»", async () => {
    st.orgPerms = { [ORG]: ["master.edit"] };
    expect((await releaseDoubtfulInvoice(INVOICE, "Busqué la nota y no aparece")).error).toMatch(/^Sin permiso/);
    expect(writes()).toEqual([]);
  });

  it.each(["error", "emitida", "emitiendo", "externa"])("desde %s no se libera", async (status) => {
    st.db.invoiceRef = { id: INVOICE, org_id: ORG, order_id: ORDER, mode: "real", status, retry_requested_at: null };
    expect(await releaseDoubtfulInvoice(INVOICE, "Busqué la nota y no aparece")).toEqual({
      error: "Solo se libera un comprobante que está en duda.",
    });
    expect(writes()).toEqual([]);
  });

  it.each(["", "   ", "ok", " nada "])("sin decir qué se revisó no se suelta («%s»)", async (note) => {
    expect(await releaseDoubtfulInvoice(INVOICE, note)).toEqual({
      error: "Escribe qué revisaste en SimpleFact: queda junto al comprobante.",
    });
    expect(writes()).toEqual([]);
  });

  it("pasa a error con el reintento pedido, quién lo resolvió y qué revisó", async () => {
    const res = await releaseDoubtfulInvoice(INVOICE, "  Busqué «Kapta 6f1c2a3b» hoy y ayer: no está  ");
    expect(res.notice).toMatch(/^Liberado/);
    const update = callsTo("order_invoices", "update")[0]!;
    const payload = update.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: "error",
      error: "Liberada a mano: no estaba en SimpleFact",
      note: "Busqué «Kapta 6f1c2a3b» hoy y ayer: no está",
      resolved_by: "user-1",
      retry_requested_by: "user-1",
    });
    expect(payload.resolved_at).toBe(payload.retry_requested_at);
    expect(Object.keys(payload).sort()).toEqual([
      "error",
      "note",
      "resolved_at",
      "resolved_by",
      "retry_requested_at",
      "retry_requested_by",
      "status",
    ]);
    expect(has(update, "eq", "id", INVOICE)).toBe(true);
    expect(has(update, "eq", "status", "en_duda")).toBe(true);
  });

  it("si la conciliación la resolvió entre tanto, no se pisa", async () => {
    st.db.updateData = [];
    expect((await releaseDoubtfulInvoice(INVOICE, "Busqué la nota y no aparece")).error).toMatch(/ya no está en duda/);
  });

  // FIX: «Liberado: se vuelve a intentar en la próxima pasada» también en
  // Manual, donde la pasada no lo intenta.
  it.each(NEXT_ATTEMPT)("lo que pasa después depende del modo del RUC del pedido (%s)", async (_mode, arrange, next) => {
    arrange();
    const res = await releaseDoubtfulInvoice(INVOICE, "Busqué la nota y no aparece");
    expect(res).toEqual({ notice: `Liberado: ${next}` });
    expect(st.factsArgs.at(-1)?.[1]).toEqual([ORDER]);
  });

  it("si no se pudo leer el modo, queda liberado igual y se dicen los dos caminos", async () => {
    st.factsError = new Error("timeout");
    expect(await releaseDoubtfulInvoice(INVOICE, "Busqué la nota y no aparece")).toEqual({ notice: `Liberado: ${NEXT_UNKNOWN}` });
    expect(callsTo("order_invoices", "update")).toHaveLength(1);
  });

  // FIX: un `en_duda` recién nacido se podía liberar al instante. Un POST que se
  // cortó por tiempo puede haber llegado a SimpleFact sin que todavía lo liste:
  // liberarlo y volver a pulsar «Emitir esta boleta» eran dos boletas.
  describe("no se libera recién en duda: 30 minutos desde que quedó en duda", () => {
    const NOTA = "Busqué la nota y no aparece";

    it("la espera es de 30 minutos", () => {
      expect(INVOICE_RELEASE_MIN_AGE_MS).toBe(30 * 60_000);
    });

    it("en duda hace 14:50: dice hasta qué hora de Lima esperar, y no escribe nada", async () => {
      // En duda desde las 14:45:10 de Lima → se libera desde las 15:16 (al minuto, hacia arriba).
      st.db.invoiceRef = enDuda({ created_at: haceMin(15), updated_at: haceMin(14, 50) });
      const res = await releaseDoubtfulInvoice(INVOICE, NOTA);
      expect(res).toEqual({
        error:
          "Espera hasta las 15:16 (hora de Lima): SimpleFact puede tardar en mostrar una boleta que sí recibió. Mientras tanto Kapta la sigue buscando.",
      });
      expect(res.error).toBe(invoiceReleaseWaitText("2026-10-14T20:16:00.000Z"));
      expect(writes()).toEqual([]);
      // Ni pregunta el modo: no hay nada que contar después.
      expect(st.factsArgs).toEqual([]);
    });

    it("a la hora que dijo, ya se libera; un segundo antes, no", async () => {
      st.db.invoiceRef = enDuda({ created_at: haceMin(31), updated_at: haceMin(30) });
      expect(await releaseDoubtfulInvoice(INVOICE, NOTA)).toMatchObject({ notice: expect.stringMatching(/^Liberado/) });
      st.calls = [];
      st.db.invoiceRef = enDuda({ created_at: haceMin(31), updated_at: haceMin(29, 59) });
      // 14:30:01 + 30 min = 15:00:01 → «hasta las 15:01».
      expect((await releaseDoubtfulInvoice(INVOICE, NOTA)).error).toMatch(/^Espera hasta las 15:01 \(hora de Lima\)/);
      expect(writes()).toEqual([]);
    });

    it("el reloj empieza cuando quedó en duda (`updated_at`), no con el turno", async () => {
      // El turno fue hace 40 minutos, pero quedó en duda hace 10 (la
      // conciliación lo pasó de «emitiendo» a «en duda»): falta.
      st.db.invoiceRef = enDuda({ created_at: haceMin(40), updated_at: haceMin(10) });
      expect((await releaseDoubtfulInvoice(INVOICE, NOTA)).error).toMatch(/^Espera hasta las 15:20 /);
      expect(writes()).toEqual([]);
    });

    it("lee cuándo se pidió el turno y cuándo quedó en duda", async () => {
      await releaseDoubtfulInvoice(INVOICE, NOTA);
      const ref = callsTo("order_invoices", "select")[0]!;
      expect(ref.cols!.split(",").map((c) => c.trim())).toEqual(
        expect.arrayContaining(["status", "created_at", "updated_at"]),
      );
    });

    it.each([
      ["sin updated_at", { updated_at: null }],
      ["un updated_at que no se entiende", { updated_at: "ayer" }],
    ])("si no se sabe desde cuándo está en duda (%s), no se libera", async (_label, over) => {
      st.db.invoiceRef = enDuda(over);
      expect(await releaseDoubtfulInvoice(INVOICE, NOTA)).toEqual({ error: INVOICE_RELEASE_UNKNOWN_TEXT });
      expect(writes()).toEqual([]);
    });

    it("confirmar que SÍ está en SimpleFact no espera: registrar una boleta que existe no emite otra", async () => {
      st.db.invoiceRef = { ...enDuda({ created_at: haceMin(1), updated_at: haceMin(0, 30) }), invoice_type: "03" };
      const res = await confirmDoubtfulInvoice(INVOICE, "B001-97", "Encontrada en las ventas de hoy con la nota Kapta 6f1c2a3b");
      expect(res.notice).toMatch(/^Comprobante B001-97 registrado como emitido/);
      expect(callsTo("order_invoices", "update")).toHaveLength(1);
    });
  });
});

describe("confirmDoubtfulInvoice: «Sí está en SimpleFact: registrar su serie» (§35.4)", () => {
  // Un `en_duda` que una persona SÍ encontró en SimpleFact. Antes la única
  // salida era liberarlo, y liberar una boleta que existe es emitir otra.
  const enDuda = (over: Record<string, unknown> = {}) => ({
    id: INVOICE,
    org_id: ORG,
    order_id: ORDER,
    mode: "real",
    status: "en_duda",
    retry_requested_at: null,
    invoice_type: "03",
    ...over,
  });
  const NOTA = "Encontrada en las ventas de ayer con la nota Kapta 6f1c2a3b";

  beforeEach(() => {
    st.db.invoiceRef = enDuda();
  });

  it("pasa a emitida con su serie, dónde se encontró y quién; filtra por el estado de partida", async () => {
    const res = await confirmDoubtfulInvoice(INVOICE, " b001-0097 ", `  ${NOTA}  `);
    expect(res).toEqual({
      notice: "Comprobante B001-97 registrado como emitido: Kapta no emitirá otro por este pedido.",
    });
    const update = callsTo("order_invoices", "update")[0]!;
    expect(update.client).toBe("admin");
    const payload = update.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: "emitida",
      serie: "B001",
      correlative: "97",
      note: NOTA,
      resolved_by: "user-1",
    });
    expect(Number.isFinite(Date.parse(String(payload.resolved_at)))).toBe(true);
    // Solo eso: el RUC, el total, el tipo y lo enviado no cambian (0257).
    expect(Object.keys(payload).sort()).toEqual(["correlative", "note", "resolved_at", "resolved_by", "serie", "status"]);
    expect(has(update, "eq", "id", INVOICE)).toBe(true);
    expect(has(update, "eq", "status", "en_duda")).toBe(true);
    // El tipo de la fila se lee con ella.
    expect(callsTo("order_invoices", "select")[0]?.cols).toContain("invoice_type");
  });

  it("si la conciliación (u otra persona) la resolvió entre tanto, no se pisa y se dice", async () => {
    st.db.updateData = [];
    expect(await confirmDoubtfulInvoice(INVOICE, "B001-97", NOTA)).toEqual({
      error: "El comprobante ya no está en duda: vuelve a abrir el pedido para ver su estado.",
    });
  });

  it("pide «Boletas y facturas» en la organización del pedido, antes de escribir", async () => {
    st.orgPerms = { [ORG]: ["master.edit"], "otra-org": ["invoices.manage"] };
    expect((await confirmDoubtfulInvoice(INVOICE, "B001-97", NOTA)).error).toMatch(/^Sin permiso/);
    expect(st.permArgs).toEqual([[ORG, "invoices.manage"]]);
    expect(writes()).toEqual([]);
  });

  it("el comprobante tiene que ser de un pedido que el usuario ve, y de su organización", async () => {
    st.db.orderMaster = null;
    expect(await confirmDoubtfulInvoice(INVOICE, "B001-97", NOTA)).toEqual({ error: "Sin acceso a este pedido." });
    expect(st.permArgs).toEqual([]);
    st.db.orderMaster = { order_id: ORDER, store_id: STORE };
    st.db.invoiceRef = enDuda({ org_id: "otra-org" });
    expect(await confirmDoubtfulInvoice(INVOICE, "B001-97", NOTA)).toEqual({ error: "Sin acceso a este pedido." });
    st.db.invoiceRef = null;
    expect(await confirmDoubtfulInvoice(INVOICE, "B001-97", NOTA)).toEqual({ error: "Ese comprobante no existe." });
    expect(writes()).toEqual([]);
  });

  it.each(["error", "emitida", "emitiendo", "externa", "simulada"])("desde %s no se confirma", async (status) => {
    st.db.invoiceRef = enDuda({ status });
    expect(await confirmDoubtfulInvoice(INVOICE, "B001-97", NOTA)).toEqual({
      error: "Solo se confirma un comprobante que está en duda.",
    });
    expect(writes()).toEqual([]);
  });

  it("una boleta (03) no se confirma con una serie de factura, ni al revés", async () => {
    expect(await confirmDoubtfulInvoice(INVOICE, "F001-97", NOTA)).toEqual({
      error: "Este comprobante es una boleta: su serie empieza con B.",
    });
    st.db.invoiceRef = enDuda({ invoice_type: "01" });
    expect(await confirmDoubtfulInvoice(INVOICE, "B001-97", NOTA)).toEqual({
      error: "Este comprobante es una factura: su serie empieza con F.",
    });
    expect(writes()).toEqual([]);
    expect((await confirmDoubtfulInvoice(INVOICE, "F001-97", NOTA)).notice).toMatch(/^Comprobante F001-97/);
  });

  it("si no se sabe de qué tipo es la fila, no se adivina", async () => {
    st.db.invoiceRef = enDuda({ invoice_type: null });
    expect((await confirmDoubtfulInvoice(INVOICE, "B001-97", NOTA)).error).toMatch(/boleta o factura: no se confirma/);
    expect(writes()).toEqual([]);
  });

  it.each(["97", "B01-1", "B001-", "B001-123456789", "B001 97", "B001-9a"])(
    "«%s» no es una serie y número, como en «Ya tiene comprobante»",
    async (typed) => {
      expect(await confirmDoubtfulInvoice(INVOICE, typed, NOTA)).toEqual({
        error: "Escribe la serie y el número como en SimpleFact: B001-123.",
      });
      expect(writes()).toEqual([]);
    },
  );

  it("ni otra letra ni el número 0", async () => {
    expect((await confirmDoubtfulInvoice(INVOICE, "E001-97", NOTA)).error).toBe(
      "La serie empieza con B (boleta) o con F (factura).",
    );
    expect((await confirmDoubtfulInvoice(INVOICE, "B001-000", NOTA)).error).toBe(
      "El número del comprobante no puede ser 0.",
    );
    expect(writes()).toEqual([]);
  });

  it.each(["", "   ", "ok", " ayer "])("sin decir dónde se encontró no se da por emitida («%s»)", async (note) => {
    expect(await confirmDoubtfulInvoice(INVOICE, "B001-97", note)).toEqual({
      error: "Escribe dónde la encontraste en SimpleFact: queda junto al comprobante.",
    });
    expect(writes()).toEqual([]);
  });

  it("un error de la base se dice, no se da por registrada", async () => {
    st.db.updateError = { message: "Transición de comprobante no permitida: error → emitida" };
    expect(await confirmDoubtfulInvoice(INVOICE, "B001-97", NOTA)).toEqual({
      error: "No se pudo registrar la serie: Transición de comprobante no permitida: error → emitida",
    });
  });
});

describe("las escrituras piden permiso antes de escribir (§35.7, como escrituras-piden-permiso)", () => {
  const ACTIONS = read("app/dashboard/pedidos/invoice-actions.ts");

  /** Cuerpo de cada `export async function` del archivo, hasta su `}` final. */
  function exportedBodies(src: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const match of src.matchAll(/\nexport async function (\w+)\(/g)) {
      const end = src.indexOf("\n}\n", match.index!);
      out.set(match[1]!, src.slice(match.index!, end < 0 ? src.length : end + 2));
    }
    return out;
  }
  const bodies = exportedBodies(ACTIONS);

  it("leer, registrar, reintentar, confirmar, liberar y emitir a mano: emitir pasa SOLO por `emitInvoiceNow`", () => {
    expect([...bodies.keys()].sort()).toEqual([
      "confirmDoubtfulInvoice",
      "emitInvoiceAction",
      "loadInvoicePanel",
      "registerExternalInvoice",
      "releaseDoubtfulInvoice",
      "requestInvoiceRetry",
    ]);
    // Ni el turno ni SimpleFact por su cuenta: la emisión es la del barrido.
    expect(ACTIONS).not.toMatch(/invoice_claim|simplefactCreateSale|runInvoiceSweep|\.rpc\(/);
    expect(ACTIONS.match(/\bemitInvoiceNow\(/g)).toHaveLength(1);
    // Con lo que vio la persona y solo en «Manual»: lo comprueba `emitInvoiceNow`.
    expect(bodies.get("emitInvoiceAction")).toMatch(
      /emitInvoiceNow\(admin, \{\s*orderId: ctx\.orderId,\s*userId: ctx\.userId,\s*manualOnly: true,\s*expected: \{ issuerId: shownIssuer, totalCents: shownCents, simplefactChecked \},\s*\}\)/,
    );
    // Y ya no lee los hechos por su cuenta: una sola lectura, la que se envía.
    expect(bodies.get("emitInvoiceAction")).not.toMatch(/loadInvoiceOrderFacts|invoiceEligibility/);
  });

  it("cada una que escribe (o emite) pregunta «invoices.manage» antes de su escritura", () => {
    // Emitir escribe la fila del turno y llama a SimpleFact: cuenta como escritura.
    const WRITES = /\.(insert|update|upsert|delete)\(|emitInvoiceNow\(/;
    const conEscritura = [...bodies].filter(([, body]) => WRITES.test(body));
    expect(conEscritura.map(([name]) => name).sort()).toEqual([
      "confirmDoubtfulInvoice",
      "emitInvoiceAction",
      "registerExternalInvoice",
      "releaseDoubtfulInvoice",
      "requestInvoiceRetry",
    ]);
    for (const [name, body] of conEscritura) {
      const gate = body.search(/hasOrgPermission\(ctx\.orgId, "invoices\.manage"\)|await authorizeInvoice\(/);
      expect(gate, name).toBeGreaterThan(0);
      expect(gate, name).toBeLessThan(body.search(WRITES));
    }
    const helper = ACTIONS.slice(ACTIONS.indexOf("async function authorizeInvoice("));
    expect(helper.slice(0, helper.indexOf("\n}\n"))).toContain('hasOrgPermission(auth.ctx.orgId, "invoices.manage")');
  });

  it("no lee la tabla de RUC por su cuenta: el token no tiene por dónde salir", () => {
    // El código sin sus comentarios: lo que se prueba es lo que corre.
    const code = ACTIONS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain('from("invoice_issuers")');
    expect(code).not.toMatch(/token_enc|@\/lib\/crypto/);
  });
});

// ── El panel ────────────────────────────────────────────────────────────────

describe("el panel: el comprobante real vivo", () => {
  it("emitida: serie, total, RUC y el PDF", () => {
    const html = pinta(panelData({ invoices: [row()], canManage: true }));
    const t = texto(html);
    expect(t).toContain("Comprobante");
    expect(t).toContain("Emitida B001-97 · S/ 85.00 · RUC 20556792829");
    expect(t).toContain("GRUPO GF S.A.C.");
    expect(html).toContain('href="https://grupogf.simplefact.pe/files/20556792829-03-B001-97.pdf"');
    expect(t).toContain("Ver PDF");
    // Con un comprobante vivo no se ofrece registrar otro ni se repasan las reglas.
    expect(t).not.toContain("Ya tiene comprobante");
    expect(t).not.toContain("Lista para emitirse");
  });

  it("un PDF que no es https no se enlaza", () => {
    const html = pinta(panelData({ invoices: [row({ pdfUrl: "javascript:alert(1)" })] }));
    expect(html).not.toContain("javascript:");
    expect(texto(html)).not.toContain("Ver PDF");
  });

  it("emitiendo: dice que espera a SimpleFact y que nunca se manda dos veces", () => {
    const t = texto(pinta(panelData({ invoices: [row({ status: "emitiendo", serie: null, correlative: null, pdfUrl: null })] })));
    expect(t).toContain("Emitiendo · S/ 85.00 · RUC 20556792829");
    expect(t).toContain("nunca se manda dos veces");
  });

  it("en duda: explica, da la nota para buscarla y, a quien gestiona, la salida", () => {
    const enDuda = row({ status: "en_duda", serie: null, correlative: null, pdfUrl: null, error: "SimpleFact no respondió." });
    const gestor = texto(pinta(panelData({ invoices: [enDuda], canManage: true })));
    expect(gestor).toContain("En duda · S/ 85.00 · RUC 20556792829");
    expect(gestor).toContain("la boleta puede existir");
    expect(gestor).toContain(`«${invoiceNoteRef(INVOICE)}»`);
    expect(gestor).toContain("SimpleFact no respondió.");
    expect(gestor).toContain("No está en SimpleFact: volver a intentar");
    expect(gestor).toContain("Sí está en SimpleFact: registrar su serie");
    const otro = texto(pinta(panelData({ invoices: [enDuda], canManage: false })));
    expect(otro).not.toContain("No está en SimpleFact: volver a intentar");
    expect(otro).not.toContain("Sí está en SimpleFact");
    expect(otro).toContain("la revisa quien tiene «Boletas y facturas»");
  });

  it("en duda: las dos salidas son de quien gestiona, y solo de un en_duda", () => {
    const enDuda = row({ status: "en_duda", serie: null, correlative: null, pdfUrl: null });
    expect(invoicePanelView(panelData({ invoices: [enDuda], canManage: true }))).toMatchObject({
      canConfirm: true,
      canRelease: true,
    });
    expect(invoicePanelView(panelData({ invoices: [enDuda], canManage: false }))).toMatchObject({
      canConfirm: false,
      canRelease: false,
    });
    for (const status of ["emitida", "emitiendo", "externa"] as const) {
      const view = invoicePanelView(panelData({ invoices: [row({ status })], canManage: true }));
      expect(view.canConfirm, status).toBe(false);
      expect(texto(pinta(panelData({ invoices: [row({ status })], canManage: true })))).not.toContain(
        "Sí está en SimpleFact",
      );
    }
    // El panel manda la serie y la nota a la acción, con el id de la fila.
    expect(read("components/order-invoice-panel.tsx")).toContain(
      "run(() => confirmDoubtfulInvoice(live.id, input.serieNumber, input.note))",
    );
  });

  it("externa: con su serie y que la registró una persona", () => {
    const t = texto(
      pinta(
        panelData({
          invoices: [row({ status: "externa", serie: "B001", correlative: "123", pdfUrl: null, manual: true, note: "Con DNI" })],
        }),
      ),
    );
    expect(t).toContain("Emitida fuera de Kapta B001-123 · S/ 85.00 · RUC 20556792829");
    expect(t).toContain("Registrada a mano");
    expect(t).toContain("Nota: Con DNI");
  });

  it("el aviso de nota de crédito va arriba, en ámbar", () => {
    const html = pinta(
      panelData({
        invoices: [row()],
        creditNote: "El pedido se anuló después del comprobante: revisa si corresponde una nota de crédito.",
      }),
    );
    expect(texto(html)).toContain("revisa si corresponde una nota de crédito");
    expect(html).toContain("bg-warn-wash");
  });
});

describe("el panel: emitida con otro RUC (FIX F)", () => {
  const error = `SimpleFact contestó con archivos del RUC ${OTRO_RUC}, no del ${RUC}.`;

  it("no se pinta como una emitida normal: chapa roja y el aviso con el error", () => {
    const html = pinta(panelData({ invoices: [row({ rucMismatch: true, error })] }));
    const t = texto(html);
    expect(t).toContain("Emitida con otro RUC");
    expect(html).toMatch(/<span[^>]*bg-crit-bg[^>]*>Emitida con otro RUC<\/span>/);
    expect(t).toContain(
      `SimpleFact la emitió con otro RUC: SimpleFact contestó con archivos del RUC ${OTRO_RUC}, no del ${RUC}. Revísala en SimpleFact: puede necesitar anularse o una nota de crédito.`,
    );
    expect(html).toMatch(/<div role="alert"[^>]*bg-crit-wash/);
    // El error no se repite debajo de la boleta.
    expect(t.split("SimpleFact contestó con archivos").length - 1).toBe(1);
    expect(invoicePanelView(panelData({ invoices: [row({ rucMismatch: true, error })] })).badge).toEqual({
      tone: "crit",
      label: "Emitida con otro RUC",
    });
  });

  it("sin el error guardado, igual avisa", () => {
    const t = texto(pinta(panelData({ invoices: [row({ rucMismatch: true, error: null })] })));
    expect(t).toContain("SimpleFact la emitió con otro RUC. Revísala en SimpleFact");
  });

  it("una emitida de su RUC sigue verde y sin aviso", () => {
    const html = pinta(panelData({ invoices: [row()] }));
    expect(texto(html)).not.toContain("otro RUC");
    expect(html).not.toContain('role="alert"');
    expect(invoicePanelView(panelData({ invoices: [row()] })).badge).toEqual({ tone: "ok", label: "Emitida" });
  });
});

describe("el panel: lo que frena Shopify (FIX G)", () => {
  const frenada = (reason: InvoiceReason, retry: boolean, detail: string | null = null) =>
    panelData({
      review: {
        state: "shopify",
        ruc: RUC,
        legalName: "GRUPO GF S.A.C.",
        mode: "real",
        issuerId: ISSUER.id,
        reason,
        detail,
        checkedAt: "2026-10-14T14:50:00Z",
        retry,
        waitsHours: SHOPIFY_LEVEL_REASONS.has(reason),
      },
      check: { mode: "real", reason, detail, checkedAt: "2026-10-14T14:50:00Z" },
      canManage: true,
    });

  it("lo que no cambia con otra pasada: no sale sola, se emite a mano y se registra", () => {
    const data = frenada("editado", false);
    const t = texto(pinta(data));
    expect(t).not.toContain("Lista para emitirse");
    expect(t).not.toContain("Por emitir");
    expect(t).toContain(INVOICE_REASON_LABEL.editado);
    expect(t).toContain(SHOPIFY_MANUAL_TEXT);
    expect(SHOPIFY_MANUAL_TEXT).toBe(
      "No se emite sola: se emite a mano en SimpleFact y se registra con «Ya tiene comprobante».",
    );
    expect(t).toContain("Última pasada (Real,");
    // La última pasada no se repite debajo: es lo mismo que ya se dijo.
    expect(t.split("Última pasada").length - 1).toBe(1);
    // Y se ofrece registrar la que se emita a mano.
    expect(t).toContain("Ya tiene comprobante");
    expect(invoicePanelView(data).badge).toEqual({ tone: "warn", label: "Se emite a mano" });
  });

  // FIX: decía «Se vuelve a intentar en la próxima pasada», pero el barrido no
  // relee Shopify por `sin_token_shopify` en 6 horas (`p_blocked`).
  it("sin conexión con Shopify se reintenta solo, pero en horas, no en la próxima pasada", () => {
    const data = frenada("sin_token_shopify", true);
    const t = texto(pinta(data));
    expect(t).toContain(INVOICE_REASON_LABEL.sin_token_shopify);
    expect(t).toContain(SHOPIFY_NO_TOKEN_TEXT);
    expect(SHOPIFY_NO_TOKEN_TEXT).toBe(
      "Se vuelve a revisar en unas horas, cuando la tienda tenga conexión con Shopify.",
    );
    expect(t).not.toMatch(/próxima pasada/i);
    expect(t).not.toContain("se emite a mano");
    expect(t).not.toContain("Lista para emitirse");
    expect(invoicePanelView(data).badge).toEqual({ tone: "warn", label: "Espera a Shopify" });
  });

  it("qué pasa ahora sale de lo que hace el barrido: a mano, en horas o en la próxima pasada", () => {
    const review = (reason: InvoiceReason, retry: boolean, waitsHours: boolean, detail: string | null = null) =>
      ({ ...(frenada(reason, retry, detail).review as object), waitsHours }) as Parameters<typeof shopifyNextText>[0];
    expect(shopifyNextText(review("editado", false, true))).toBe(SHOPIFY_MANUAL_TEXT);
    expect(shopifyNextText(review("sin_token_shopify", true, true))).toBe(SHOPIFY_NO_TOKEN_TEXT);
    // Un motivo nuevo que se reintenta y espera horas: en horas, sin inventar por qué.
    expect(shopifyNextText(review("no_encontrado", true, true))).toBe(SHOPIFY_LATER_TEXT);
    expect(SHOPIFY_LATER_TEXT).toBe("Se vuelve a revisar en unas horas.");
    // `lectura_fallida` ya lo dice en su motivo: no se repite.
    expect(shopifyNextText(review("lectura_fallida", true, false))).toBeNull();
    // Uno que se relee en la próxima pasada y no lo dice: se dice.
    expect(shopifyNextText(review("no_encontrado", true, false))).toBe(SHOPIFY_RETRY_TEXT);
    expect(SHOPIFY_RETRY_TEXT).toBe("Se vuelve a intentar en la próxima pasada.");
  });

  it("«no se pudo leer» ya dice que se reintenta: no se repite", () => {
    const t = texto(pinta(frenada("lectura_fallida", true)));
    expect(t).toContain(INVOICE_REASON_LABEL.lectura_fallida);
    expect(t.match(/próxima pasada/gi)).toHaveLength(1);
  });

  it("con el detalle de Shopify", () => {
    const t = texto(pinta(frenada("no_cuadra", false, "Faltan S/ 0.01.")));
    expect(t).toContain(`${INVOICE_REASON_LABEL.no_cuadra} Faltan S/ 0.01.`);
  });
});

describe("el panel: simulación, errores y lo que dicen las reglas", () => {
  it("simulada: lo que habría enviado, con RUC, total e ítems", () => {
    const t = texto(
      pinta(
        panelData({
          invoices: [
            row({
              mode: "simulacion",
              status: "simulada",
              serie: null,
              correlative: null,
              pdfUrl: null,
              items: [
                { code: "SKU-1", name: "Shampoo Birú", qty: 2, price: 37.5 },
                { code: "ENVIO", name: "Servicio de envío", qty: 1, price: 10 },
              ],
            }),
          ],
          review: { state: "no", reason: "ya_simulado", detail: null, issuerId: ISSUER.id },
        }),
      ),
    );
    expect(t).toContain("Simulada: lo que habría enviado · S/ 85.00 · RUC 20556792829");
    expect(t).toContain("No se envió a SimpleFact.");
    expect(t).toContain("SKU-1 Shampoo Birú 2 S/ 37.50");
    expect(t).toContain("ENVIO Servicio de envío 1 S/ 10.00");
    // «Ya tiene su simulación» no se repite encima de la simulación.
    expect(t).not.toContain(INVOICE_REASON_LABEL.ya_simulado);
  });

  it("una simulada no impide la real: con el RUC ya en real, sigue «lista»", () => {
    const t = texto(
      pinta(
        panelData({
          invoices: [row({ mode: "simulacion", status: "simulada", items: [] })],
          review: { state: "lista", ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "real", issuerId: ISSUER.id },
        }),
      ),
    );
    expect(t).toContain("Lista para emitirse en la próxima pasada (RUC 20556792829, modo Real).");
    expect(t).toContain("Simulada: lo que habría enviado");
  });

  it("error: quien gestiona ve «Volver a intentar»; los demás, quién lo hace", () => {
    const error = row({ status: "error", serie: null, correlative: null, pdfUrl: null, error: "El total no cuadra." });
    const data = {
      invoices: [error],
      review: { state: "no" as const, reason: "error_previo" as const, detail: null, issuerId: ISSUER.id },
    };
    const gestor = texto(pinta(panelData({ ...data, canManage: true })));
    expect(gestor).toContain("Error · S/ 85.00 · RUC 20556792829");
    expect(gestor).toContain("El total no cuadra.");
    expect(gestor).toContain("Volver a intentar");
    expect(gestor).toContain(INVOICE_REASON_LABEL.error_previo);
    const otro = texto(pinta(panelData({ ...data, canManage: false })));
    expect(otro).not.toMatch(/>\s*Volver a intentar\s*</);
    expect(otro).toContain("lo pide quien tiene «Boletas y facturas»");
  });

  it("un error con el reintento pedido dice cuándo y no ofrece pedirlo otra vez", () => {
    const error = row({ status: "error", error: "x", retryRequestedAt: "2026-10-14T16:00:00Z" });
    const view = invoicePanelView(panelData({ invoices: [error], canManage: true }));
    expect(view.canRetry).toBe(false);
    const t = texto(pinta(panelData({ invoices: [error], canManage: true })));
    expect(t).toContain("Se pidió volver a intentar el");
  });

  it("los errores viejos quedan como historia debajo del comprobante vivo", () => {
    const viejo = row({ id: "old-1", status: "error", error: "Token rechazado (401).", createdAt: "2026-10-13T15:00:00Z" });
    const view = invoicePanelView(panelData({ invoices: [row(), viejo], canManage: true }));
    expect(view.live?.id).toBe(INVOICE);
    expect(view.failed).toBeNull();
    expect(view.history.map((h) => h.id)).toEqual(["old-1"]);
    expect(view.canRetry).toBe(false);
    expect(texto(pinta(panelData({ invoices: [row(), viejo] })))).toContain("Intentos anteriores");
  });

  it("sin nada y lista: la próxima pasada, con su RUC y su modo", () => {
    const t = texto(pinta(panelData()));
    expect(t).toContain("Lista para emitirse en la próxima pasada (RUC 20556792829, modo Simulación).");
    expect(t).toContain("se guarda sin enviarla");
  });

  it("sin nada y no cumple: la frase del barrido y su detalle", () => {
    const t = texto(
      pinta(
        panelData({
          review: { state: "no", reason: "pago_sin_cuenta", detail: "Cobro del courier sin estado de cuenta Yape.", issuerId: null },
        }),
      ),
    );
    expect(t).toContain(`${INVOICE_REASON_LABEL.pago_sin_cuenta} Cobro del courier sin estado de cuenta Yape.`);
    expect(t).not.toContain("Lista para emitirse");
  });

  it("sin revisar: lo dice y no afirma nada más", () => {
    const t = texto(pinta(panelData({ review: { state: "sin_revisar", error: "timeout" } })));
    expect(t).toContain("No se pudo revisar si lleva comprobante: timeout");
    expect(t).not.toContain("Lista para emitirse");
    for (const label of Object.values(INVOICE_REASON_LABEL)) expect(t).not.toContain(label);
  });

  it("la última pasada se enseña solo si dice otra cosa que la revisión de ahora", () => {
    // Un motivo del turno (el tope) no frena las reglas: va aparte, debajo de «lista».
    const check = { mode: "simulacion", reason: "tope", detail: null, checkedAt: "2026-10-14T14:50:00Z" };
    const distinta = texto(pinta(panelData({ check })));
    expect(distinta).toContain("Lista para emitirse en la próxima pasada");
    expect(distinta).toContain(`Última pasada (Simulación,`);
    expect(distinta).toContain(INVOICE_REASON_LABEL.tope);
    const igual = texto(
      pinta(
        panelData({
          check: { ...check, reason: "pago_sin_cuenta" },
          review: { state: "no", reason: "pago_sin_cuenta", detail: null, issuerId: null },
        }),
      ),
    );
    expect(igual).not.toContain("Última pasada");
    // Con un comprobante vivo, la revisión vieja no importa.
    expect(texto(pinta(panelData({ check, invoices: [row()] })))).not.toContain("Última pasada");
  });
});

describe("el panel: «Ya tiene comprobante»", () => {
  it("lo ve quien gestiona, sin comprobante vivo y con algún RUC", () => {
    expect(texto(pinta(panelData({ canManage: true })))).toContain("Ya tiene comprobante");
    expect(texto(pinta(panelData({ canManage: false })))).not.toContain("Ya tiene comprobante");
    expect(texto(pinta(panelData({ canManage: true, issuers: [] })))).not.toContain("Ya tiene comprobante");
    for (const status of ["emitida", "emitiendo", "en_duda", "externa"] as const) {
      expect(invoicePanelView(panelData({ canManage: true, invoices: [row({ status })] })).canRegisterExternal).toBe(false);
    }
    // Un error o una simulación no son comprobante: se puede registrar el de fuera.
    expect(invoicePanelView(panelData({ canManage: true, invoices: [row({ status: "error" })] })).canRegisterExternal).toBe(true);
  });

  it("el formulario: RUC (sin token), serie y número, nota; sin serie no se envía", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalInvoiceForm, {
        issuers: [{ id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C." }],
        defaultIssuerId: ISSUER.id,
        pending: false,
        onSubmit: async () => true,
        onCancel: () => {},
      }),
    );
    expect(html).toContain(`<option value="${ISSUER.id}" selected="">${RUC} · GRUPO GF S.A.C.</option>`);
    expect(html).toContain('placeholder="B001-123"');
    expect(texto(html)).toContain("Kapta no emitirá otra por este pedido");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Registrar<\/button>/);
  });

  // FIX H: la externa no se corrige después. Antes venía elegido el primer RUC
  // por orden alfabético, y un clic sin mirar registraba la boleta de otra empresa.
  it("sin un RUC que digan las reglas, no viene ninguno elegido: hay que elegirlo", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalInvoiceForm, {
        issuers: [
          { id: OTRO.id, ruc: OTRO_RUC, legalName: "OTRA EMPRESA S.A.C." },
          { id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C." },
        ],
        pending: false,
        onSubmit: async () => true,
        onCancel: () => {},
      }),
    );
    expect(html).toContain('<option value="" disabled="" selected="">Elige el RUC</option>');
    expect(html).not.toMatch(/<option value="iss-[^"]*" selected="">/);
    expect(html).toMatch(/<select required=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Registrar<\/button>/);
    expect(texto(html)).not.toContain("Se registra como comprobante");
  });

  it("viene elegido el RUC que decidieron las reglas, no el primero de la lista", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalInvoiceForm, {
        issuers: [
          { id: OTRO.id, ruc: OTRO_RUC, legalName: "OTRA EMPRESA S.A.C." },
          { id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C." },
        ],
        defaultIssuerId: ISSUER.id,
        pending: false,
        onSubmit: async () => true,
        onCancel: () => {},
      }),
    );
    expect(html).toContain(`<option value="${ISSUER.id}" selected="">`);
    expect(html).not.toContain(`<option value="${OTRO.id}" selected="">`);
    // Uno que ya no es de la organización no se elige.
    const ajeno = renderToStaticMarkup(
      createElement(ExternalInvoiceForm, {
        issuers: [{ id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C." }],
        defaultIssuerId: "iss-borrado",
        pending: false,
        onSubmit: async () => true,
        onCancel: () => {},
      }),
    );
    expect(ajeno).toContain('<option value="" disabled="" selected="">Elige el RUC</option>');
  });

  it("el RUC de las reglas viaja con la revisión: lista, frenada por Shopify o con motivo", () => {
    expect(reviewIssuerId(panelData().review)).toBe(ISSUER.id);
    expect(reviewIssuerId({ state: "no", reason: "monto_mayor_700", detail: null, issuerId: ISSUER.id })).toBe(ISSUER.id);
    expect(reviewIssuerId({ state: "no", reason: "ruc_mezclados", detail: null, issuerId: null })).toBeNull();
    expect(reviewIssuerId({ state: "sin_revisar", error: "timeout" })).toBeNull();
    // El panel se lo pasa al formulario.
    expect(read("components/order-invoice-panel.tsx")).toContain("defaultIssuerId={reviewIssuerId(review)}");
  });

  it("antes de registrar dice qué se registra y que no se corrige después", () => {
    expect(externalInvoiceConfirmation({ ruc: RUC, legalName: "GRUPO GF S.A.C." }, " b001-123 ")).toBe(
      `Se registra como comprobante de GRUPO GF S.A.C. (RUC ${RUC}), serie B001-123. No se puede corregir después.`,
    );
    expect(externalInvoiceConfirmation(null, "B001-123")).toBeNull();
    expect(externalInvoiceConfirmation({ ruc: RUC, legalName: "GRUPO GF S.A.C." }, "   ")).toBeNull();
    // El formulario la enseña, y sin ella no se puede pulsar «Registrar».
    const form = read("components/order-invoice-panel.tsx");
    expect(form).toContain("const confirmation = externalInvoiceConfirmation(chosen, serieNumber);");
    expect(form).toMatch(/\{confirmation && <p[^>]*>\{confirmation\}<\/p>\}/);
    expect(form).toContain("disabled={pending || !confirmation}");
  });

  it("confirmar un en_duda pide la serie y dónde se encontró, y dice antes qué queda", () => {
    const enDuda = row({ status: "en_duda", serie: null, correlative: null, pdfUrl: null });
    const html = renderToStaticMarkup(
      createElement(ConfirmDoubtForm, { row: enDuda, pending: false, onSubmit: async () => true, onCancel: () => {} }),
    );
    const t = texto(html);
    // Se busca por su nota, en el RUC y por el total de la fila.
    expect(t).toContain(`«${invoiceNoteRef(INVOICE)}», del RUC ${RUC} y por S/ 85.00`);
    expect(t).toContain("Kapta no emitirá otra por este pedido");
    expect(t).toContain("Dónde la encontraste en SimpleFact");
    expect(html).toContain('placeholder="B001-123"');
    expect(html).toContain("<textarea");
    // Sin serie ni nota no se puede pulsar.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Registrar como emitida<\/button>/);
    expect(t).not.toContain("Queda como emitida");
    const form = read("components/order-invoice-panel.tsx");
    expect(form).toContain("const confirmation = doubtConfirmation(row, serieNumber);");
    expect(form).toContain("disabled={pending || !confirmation || !note.trim()}");
  });

  it("lo que queda al confirmar, dicho como lo normaliza el servidor", () => {
    expect(doubtConfirmation({ ruc: RUC, legalName: "GRUPO GF S.A.C." }, " b001-97 ")).toBe(
      `Queda como emitida: B001-97 de GRUPO GF S.A.C. (RUC ${RUC}). No se puede corregir después.`,
    );
    expect(doubtConfirmation({ ruc: RUC, legalName: null }, "B001-97")).toBe(
      `Queda como emitida: B001-97 de RUC ${RUC}. No se puede corregir después.`,
    );
    expect(doubtConfirmation({ ruc: RUC, legalName: "GRUPO GF S.A.C." }, "   ")).toBeNull();
  });

  it("liberar pide escribir qué se revisó en SimpleFact", () => {
    const html = renderToStaticMarkup(
      createElement(ReleaseDoubtForm, { pending: false, onSubmit: async () => true, onCancel: () => {} }),
    );
    expect(texto(html)).toContain("Qué revisaste en SimpleFact");
    expect(html).toContain("<textarea");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Liberar y volver a intentar<\/button>/);
  });

  // FIX: prometía «la próxima pasada» también con el RUC en Manual, donde el
  // barrido no emite: lo que vuelve es «Emitir esta boleta».
  it("liberar dice qué pasa después según el modo del RUC del pedido", () => {
    const antes = "Libérala solo si confirmaste en SimpleFact que la boleta no existe: ";
    expect(releaseDoubtText("real")).toBe(
      `${antes}pasa a error y se vuelve a intentar en la próxima pasada. Si existiera, saldría otra.`,
    );
    expect(releaseDoubtText("manual")).toBe(
      `${antes}pasa a error y vuelve a aparecer «Emitir esta boleta» en el pedido. Si existiera, saldría otra.`,
    );
    expect(releaseDoubtText("manual")).not.toMatch(/próxima pasada/);
    // Sin saber el modo (o en un modo que no emite), los dos caminos.
    for (const mode of [null, "simulacion", "apagado"] as const) {
      const t = releaseDoubtText(mode);
      expect(t, String(mode)).toContain("con el RUC en Real, se vuelve a intentar en la próxima pasada");
      expect(t, String(mode)).toContain("en Manual, vuelve a aparecer «Emitir esta boleta» en el pedido");
    }
    const html = (mode: "real" | "manual" | null) =>
      texto(renderToStaticMarkup(createElement(ReleaseDoubtForm, { mode, pending: false, onSubmit: async () => true, onCancel: () => {} })));
    expect(html("manual")).toContain(releaseDoubtText("manual"));
    expect(html("real")).toContain(releaseDoubtText("real"));
    expect(texto(renderToStaticMarkup(createElement(ReleaseDoubtForm, { pending: false, onSubmit: async () => true, onCancel: () => {} })))).toContain(
      releaseDoubtText(null),
    );
  });

  it("el panel le pasa el modo del RUC que dicen las reglas del pedido", () => {
    const enDuda = row({ status: "en_duda", serie: null, correlative: null, pdfUrl: null });
    const review = { state: "no", reason: "ya_tiene", detail: null, issuerId: ISSUER.id } as const;
    const issuers = (mode: InvoiceIssuer["mode"]) => [{ id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C.", mode }];
    expect(invoicePanelView(panelData({ invoices: [enDuda], review, issuers: issuers("manual") })).rucMode).toBe("manual");
    expect(invoicePanelView(panelData({ invoices: [enDuda], review, issuers: issuers("real") })).rucMode).toBe("real");
    // Sin revisar, o con un RUC que no está, no se sabe.
    expect(invoicePanelView(panelData({ invoices: [enDuda], review: { state: "sin_revisar", error: "x" }, issuers: issuers("manual") })).rucMode).toBeNull();
    expect(invoicePanelView(panelData({ invoices: [enDuda], review: { ...review, issuerId: "otro" }, issuers: issuers("manual") })).rucMode).toBeNull();
    expect(read("components/order-invoice-panel.tsx")).toMatch(/<ReleaseDoubtForm\s+mode=\{view\.rucMode\}/);
  });
});

// ── Lo que el navegador no puede importar, y dónde va montado ────────────────

/** El archivo de un import `@/…`, o null si no es del repo. */
function resolveModule(spec: string): string | null {
  if (!spec.startsWith("@/")) return null;
  const base = spec.slice(2);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(resolve(process.cwd(), candidate))) return candidate;
  }
  return null;
}

/**
 * Lo que llega al navegador desde `entry`: sus imports de valor, recursivos. Un
 * archivo "use server" llega como referencia: lo que él importa no viaja.
 */
function clientGraph(entry: string): Map<string, { src: string; server: boolean }> {
  const seen = new Map<string, { src: string; server: boolean }>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    const src = read(file);
    const server = /^\s*["']use server["']/.test(src);
    seen.set(file, { src, server });
    if (server) continue;
    const specs = [
      ...[...src.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?\sfrom\s+["']([^"']+)["']/gm)]
        .filter((m) => !m[1])
        .map((m) => m[2]!),
      ...[...src.matchAll(/^import\s+["']([^"']+)["']/gm)].map((m) => m[1]!),
    ];
    for (const spec of specs) {
      if (/^(node:)?crypto$/.test(spec)) {
        seen.set(`${file} → ${spec}`, { src: "", server: false });
        continue;
      }
      const next = resolveModule(spec);
      if (next) stack.push(next);
    }
  }
  return seen;
}

describe("el panel no arrastra node:crypto al navegador", () => {
  const PANEL = "components/order-invoice-panel.tsx";

  it("no importa lib/crypto ni el módulo del barrido", () => {
    const src = read(PANEL);
    expect(src).not.toMatch(/from "@\/lib\/crypto"/);
    expect(src).not.toMatch(/from "@\/lib\/invoicing\/server"/);
    expect(src).not.toMatch(/from "@\/lib\/invoicing\/simplefact"/);
    expect(src).not.toMatch(/from "@\/lib\/invoicing\/shopify-order"/);
    expect(src).not.toMatch(/from "(node:)?crypto"/);
  });

  it("ni a través de lo que importa", () => {
    const graph = clientGraph(PANEL);
    expect(graph.has("lib/invoicing/rules.ts")).toBe(true);
    // Las acciones son "use server": llegan como referencia, no como código.
    expect(graph.get("app/dashboard/pedidos/invoice-actions.ts")?.server).toBe(true);
    expect(graph.has("lib/invoicing/server.ts")).toBe(false);
    expect(graph.has("lib/crypto.ts")).toBe(false);
    expect([...graph.keys()].filter((k) => k.includes("→"))).toEqual([]);
  });

  it("los tipos de las acciones se importan, no se copian", () => {
    expect(read(PANEL)).toContain('from "@/app/dashboard/pedidos/invoice-actions"');
  });
});

describe("el drawer lo monta bajo el cobro (§35.7)", () => {
  const drawer = read("components/order-drawer.tsx");

  it("dentro de la sección «pagos», después del panel de cobro, con el run del drawer", () => {
    const start = drawer.indexOf('data-drawer-section="pagos"');
    expect(start).toBeGreaterThan(0);
    const end = drawer.indexOf("data-drawer-section=", start + 1);
    const block = drawer.slice(start, end);
    const cobro = block.indexOf("<PickupKeyPanel");
    const comprobante = block.indexOf("<OrderInvoicePanel orderId={orderId} pending={pending} run={run} />");
    expect(cobro).toBeGreaterThan(0);
    expect(comprobante).toBeGreaterThan(cobro);
    expect(drawer.match(/<OrderInvoicePanel\b/g)).toHaveLength(1);
  });

  it("el panel carga lo suyo y enseña su fallo con un reintento", () => {
    const src = read("components/order-invoice-panel.tsx");
    expect(src.match(/loadInvoicePanel\(orderId\)/g)).toHaveLength(1);
    expect(src).toContain("catch {");
    expect(src).toContain("Intentar nuevamente");
    // Validar un pago en «Cobro» cambia si lleva boleta: el panel se entera.
    expect(src).toContain("subscribePaymentPanelChange(orderId");
  });
});

// ── «Emitir esta boleta» (owner, 15-10-2026: el modo «Manual») ───────────────

/** Grupo GF en «Manual»: el barrido simula y una persona emite pedido por pedido. */
const MANUAL: InvoiceIssuer = { ...ISSUER, mode: "manual" };
const manualFacts = (over: Partial<InvoiceOrderFacts> = {}): InvoiceOrderFacts =>
  factsFor({ issuers: [MANUAL], ...over });
/** Lo que vio la persona en la confirmación: el RUC y el total del pedido de prueba. */
const SHOWN = { issuerId: ISSUER.id, total: 85 };
const PDF = "https://grupogf.simplefact.pe/files/20556792829-03-B001-97.pdf";
/** Lo que contesta `emitInvoiceNow` cuando SimpleFact emitió la boleta. */
const EMITIDA = {
  ok: true,
  status: "emitida",
  invoiceId: INVOICE,
  serie: "B001",
  correlative: "97",
  pdfUrl: PDF,
  error: null,
  rucMismatch: false,
};

describe("emitInvoiceAction: quién puede y cuándo (§35.7, Manual)", () => {
  beforeEach(() => {
    st.issuers = [MANUAL];
    st.facts = new Map([[ORDER, manualFacts()]]);
    st.emitResult = { ...EMITIDA };
  });

  it("el pedido de prueba se emite a mano: RUC en Manual y las reglas como emisión real (sanidad)", () => {
    const elig = invoiceEligibility(manualFacts(), { emitNow: true });
    expect(elig.ok && elig.mode).toBe("real");
    expect(elig.ok && elig.totalCents).toBe(8500);
  });

  it("emite con la emisión del barrido: el cliente del servidor, el pedido, quién pulsó y lo que vio", async () => {
    const r = await emitInvoiceAction(ORDER, SHOWN);
    expect(r).toEqual({ notice: "Emitida B001-97", pdfUrl: PDF });
    expect(st.emitArgs).toHaveLength(1);
    const [admin, input, deps] = st.emitArgs[0]!;
    expect(typeof (admin as { from?: unknown }).from).toBe("function");
    // Solo en «Manual», y lo que vio la persona, en céntimos: lo compara
    // `emitInvoiceNow` con SU lectura, la que se envía.
    expect(input).toEqual({
      orderId: ORDER,
      userId: "user-1",
      manualOnly: true,
      // Sin la casilla «Revisé en SimpleFact…»: un pedido normal no la pide.
      expected: { issuerId: ISSUER.id, totalCents: 8500, simplefactChecked: false },
    });
    // Sin dependencias de más: las de verdad, las mismas del barrido.
    expect(deps).toBeUndefined();
  });

  // FIX: la acción leía los hechos por su cuenta, comparaba lo que vio la
  // persona con ESA lectura, y `emitInvoiceNow` leía otra vez sin comparar
  // nada: entre las dos lecturas el pedido podía cambiar y salía una boleta que
  // nadie confirmó. Ahora hay una sola lectura, la de `emitInvoiceNow`.
  it("no lee los hechos por su cuenta: la única lectura es la de `emitInvoiceNow`, que compara", async () => {
    await emitInvoiceAction(ORDER, SHOWN);
    expect(st.factsArgs).toEqual([]);
    expect(st.calls.filter((c) => c.client === "admin")).toEqual([]);
    expect(st.emitArgs).toHaveLength(1);
  });

  // FIX: las vistas previas comparten la base y la llave de cifrado con
  // producción, y el barrido ya no emitía fuera de ella; este botón sí.
  it.each([["preview"], ["development"], [""], [undefined]])(
    "fuera de producción (VERCEL_ENV=%s) no emite, sin leer nada ni preguntar el permiso",
    async (env) => {
      vi.stubEnv("VERCEL_ENV", env);
      expect(await emitInvoiceAction(ORDER, SHOWN)).toEqual({
        error: "Emitir solo funciona en producción: este despliegue es una vista previa.",
      });
      expect(INVOICE_REASON_LABEL.no_produccion).toBe("Emitir solo funciona en producción: este despliegue es una vista previa.");
      expect(st.calls).toEqual([]);
      expect(st.permArgs).toEqual([]);
      expect(st.factsArgs).toEqual([]);
      expect(st.emitArgs).toEqual([]);
    },
  );

  it("sin acceso al pedido no pregunta el permiso, no lee nada con el service role y no emite", async () => {
    st.db.orderMaster = null;
    expect(await emitInvoiceAction(ORDER, SHOWN)).toEqual({ error: "Sin acceso a este pedido." });
    expect(st.permArgs).toEqual([]);
    expect(st.factsArgs).toEqual([]);
    expect(st.emitArgs).toEqual([]);
    expect(st.calls.filter((c) => c.client === "admin")).toEqual([]);
  });

  it("pide «Boletas y facturas» en la organización del pedido ANTES de leer con el service role o emitir", async () => {
    st.orgPerms = { [ORG]: [], "org-2": ["invoices.manage"] };
    const r = await emitInvoiceAction(ORDER, SHOWN);
    expect(r.error).toMatch(/^Sin permiso: los comprobantes los gestiona quien tiene «Boletas y facturas»/);
    expect(st.permArgs).toEqual([[ORG, "invoices.manage"]]);
    expect(st.factsArgs).toEqual([]);
    expect(st.emitArgs).toEqual([]);
    expect(st.calls.filter((c) => c.client === "admin")).toEqual([]);
  });

  it("sin sesión manda a entrar; una lectura caída del pedido se dice y no emite", async () => {
    st.user = null;
    await expect(emitInvoiceAction(ORDER, SHOWN)).rejects.toThrow("redirect:/login");
    st.user = { id: "user-1" };
    st.db.orderMasterError = { message: "timeout" };
    expect(await emitInvoiceAction(ORDER, SHOWN)).toEqual({ error: "No se pudo leer el pedido: timeout" });
    expect(st.emitArgs).toEqual([]);
  });

  it("en una tienda que no está activa no se emite: el barrido tampoco pasa por ella", async () => {
    st.db.store = { org_id: ORG, status: "paused" };
    expect(await emitInvoiceAction(ORDER, SHOWN)).toEqual({ error: INVOICE_REASON_LABEL.tienda });
    expect(st.emitArgs).toEqual([]);
  });

  it("solo en «Manual»: lo pide a `emitInvoiceNow`, y su «no» se dice con la frase de siempre", async () => {
    // En Real emite el barrido; en Simulación y en Apagado no se emite. Lo
    // decide `emitInvoiceNow` con su lectura (test/invoicing-server.test.ts).
    const casos: Array<[unknown, string]> = [
      [
        { ok: false, reason: "modo_distinto", detail: "El RUC está en «Real»: a mano solo se emite en «Manual»." },
        `${INVOICE_REASON_LABEL.modo_distinto} El RUC está en «Real»: a mano solo se emite en «Manual».`,
      ],
      [
        { ok: false, reason: "modo_distinto", detail: "El RUC está en «Simulación»." },
        `${INVOICE_REASON_LABEL.modo_distinto} El RUC está en «Simulación».`,
      ],
      [{ ok: false, reason: "ruc_apagado" }, INVOICE_REASON_LABEL.ruc_apagado],
    ];
    for (const [result, error] of casos) {
      st.emitResult = result;
      expect(await emitInvoiceAction(ORDER, SHOWN)).toEqual({ error });
    }
    expect(st.emitArgs.every(([, input]) => (input as { manualOnly?: boolean }).manualOnly === true)).toBe(true);
  });

  it("lo que vio la persona es lo que sale: si `emitInvoiceNow` dice que cambió, no se emitió", async () => {
    const cambio =
      "El pedido cambió desde que lo abriste (el RUC o el total): vuelve a abrirlo y revisa la boleta antes de emitirla.";
    expect(INVOICE_REASON_LABEL.pedido_cambio).toBe(cambio);
    st.emitResult = { ok: false, reason: "pedido_cambio" };
    expect(await emitInvoiceAction(ORDER, SHOWN)).toEqual({ error: cambio });
    // Lo que vio viaja tal cual, en céntimos.
    st.emitArgs = [];
    await emitInvoiceAction(ORDER, { issuerId: OTRO.id, total: 120.5 });
    expect((st.emitArgs[0]![1] as { expected: unknown }).expected).toEqual({
      issuerId: OTRO.id,
      totalCents: 12050,
      simplefactChecked: false,
    });
    // El total al céntimo: 85 y 85.001 son lo mismo; lo que se envía son céntimos.
    st.emitArgs = [];
    await emitInvoiceAction(ORDER, { ...SHOWN, total: 85.001 });
    expect((st.emitArgs[0]![1] as { expected: unknown }).expected).toEqual({
      issuerId: ISSUER.id,
      totalCents: 8500,
      simplefactChecked: false,
    });
  });

  it("sin lo que vio, no hay con qué comparar: no se emite a ciegas, y ni se lee el pedido con el service role", async () => {
    const cambio = /^El pedido cambió desde que lo abriste \(el RUC o el total\)/;
    expect((await emitInvoiceAction(ORDER, undefined as never)).error).toMatch(cambio);
    expect((await emitInvoiceAction(ORDER, { issuerId: "", total: 85 })).error).toMatch(cambio);
    expect((await emitInvoiceAction(ORDER, { ...SHOWN, total: Number.NaN })).error).toMatch(cambio);
    expect((await emitInvoiceAction(ORDER, { ...SHOWN, total: 0 })).error).toMatch(cambio);
    expect(st.factsArgs).toEqual([]);
    expect(st.emitArgs).toEqual([]);
    expect(st.calls.filter((c) => c.client === "admin")).toEqual([]);
  });

  it("los motivos de las reglas como emisión real se dicen con la frase del panel y su detalle", async () => {
    const casos: InvoiceReason[] = ["ya_tiene", "error_previo", "sin_conexion", "monto_mayor_700", "antes_de_inicio"];
    for (const reason of casos) {
      st.emitResult = { ok: false, reason };
      expect(await emitInvoiceAction(ORDER, SHOWN), reason).toEqual({ error: INVOICE_REASON_LABEL[reason] });
    }
    st.emitResult = { ok: false, reason: "pago_sin_cuenta", detail: "Te yapearon: no dice a qué cuenta." };
    expect(await emitInvoiceAction(ORDER, SHOWN)).toEqual({
      error: `${INVOICE_REASON_LABEL.pago_sin_cuenta} Te yapearon: no dice a qué cuenta.`,
    });
  });

  it("si `emitInvoiceNow` dice que no es producción, también se dice", async () => {
    st.emitResult = { ok: false, reason: "no_produccion" };
    expect(await emitInvoiceAction(ORDER, SHOWN)).toEqual({ error: INVOICE_REASON_LABEL.no_produccion });
  });
});

describe("emitInvoiceAction: lo que pasó, en palabras", () => {
  beforeEach(() => {
    st.issuers = [MANUAL];
    st.facts = new Map([[ORDER, manualFacts()]]);
  });
  const emite = async (result: unknown) => {
    st.emitResult = result;
    return emitInvoiceAction(ORDER, SHOWN);
  };

  it("emitida: «Emitida B001-97» y su PDF; un PDF que no es https no viaja", async () => {
    expect(await emite(EMITIDA)).toEqual({ notice: "Emitida B001-97", pdfUrl: PDF });
    expect(await emite({ ...EMITIDA, pdfUrl: "http://otro.example/x.pdf" })).toEqual({ notice: "Emitida B001-97" });
    expect(await emite({ ...EMITIDA, pdfUrl: "javascript:alert(1)" })).toEqual({ notice: "Emitida B001-97" });
  });

  it("emitida pero con algo que leer (no se guardó, el RUC se apagó): va como error, con su serie", async () => {
    const r = await emite({ ...EMITIDA, error: "No se pudo guardar la respuesta en Kapta: el comprobante sigue «Emitiendo»." });
    expect(r).toEqual({
      error: "Emitida B001-97. No se pudo guardar la respuesta en Kapta: el comprobante sigue «Emitiendo».",
      pdfUrl: PDF,
    });
  });

  it("emitida con archivos de otro RUC: en rojo, con el aviso de revisarla y el RUC apagado", async () => {
    const r = await emite({
      ...EMITIDA,
      rucMismatch: true,
      error: `SimpleFact contestó con archivos del RUC ${OTRO_RUC}, no del ${RUC}. El RUC quedó apagado: prueba la conexión antes de volver a encenderlo.`,
    });
    expect(r.notice).toBeUndefined();
    expect(r.error).toBe(
      `Emitida B001-97, pero con archivos de otro RUC. Revísala en SimpleFact: puede necesitar anularse o una nota de crédito. SimpleFact contestó con archivos del RUC ${OTRO_RUC}, no del ${RUC}. El RUC quedó apagado: prueba la conexión antes de volver a encenderlo.`,
    );
    expect(r.pdfUrl).toBe(PDF);
  });

  it("en duda: queda En duda y se busca por su nota antes de nada", async () => {
    const r = await emite({
      ...EMITIDA,
      status: "en_duda",
      serie: null,
      correlative: null,
      pdfUrl: null,
      error: "SimpleFact no respondió (timeout).",
    });
    expect(r).toEqual({
      error: `SimpleFact no respondió: queda En duda; búscala por su nota «${invoiceNoteRef(INVOICE)}» antes de nada. Detalle: SimpleFact no respondió (timeout).`,
    });
    expect(invoiceNoteRef(INVOICE)).toBe("Kapta 6f1c2a3b");
  });

  it("error: lo que dijo SimpleFact, sin inventar una serie", async () => {
    const r = await emite({ ...EMITIDA, status: "error", serie: null, correlative: null, pdfUrl: null, error: "Token rechazado (401)." });
    expect(r).toEqual({ error: "SimpleFact no la emitió: Token rechazado (401)." });
    expect(await emite({ ...EMITIDA, status: "error", serie: null, error: null })).toEqual({
      error: "SimpleFact no la emitió: no dio el motivo.",
    });
  });

  // FIX: «Se llegó al tope diario del RUC: sale mañana.» y «No se pudo leer el
  // pedido: se vuelve a intentar en la próxima pasada.» son lo que hace el
  // barrido en Real. Con el RUC en Manual nada de eso sale solo: se vuelve a
  // pulsar.
  it("no se envió nada en Manual: lo que promete el barrido no se promete, se vuelve a pulsar", async () => {
    const tope = await emite({ ok: false, reason: "tope" });
    expect(tope).toEqual({
      error: "Se llegó al tope diario del RUC y no se emitió. En Manual no sale sola: mañana se emite con «Emitir esta boleta».",
    });
    const lectura = await emite({ ok: false, reason: "lectura_fallida", detail: "Shopify no respondió." });
    expect(lectura).toEqual({
      error:
        "No se pudo leer el pedido y no se emitió nada. En Manual no se reintenta solo: vuelve a pulsar «Emitir esta boleta». Shopify no respondió.",
    });
    for (const r of [tope, lectura]) {
      expect(r.error).not.toMatch(/próxima pasada|sale mañana/);
    }
  });

  it("no se envió nada: el motivo con la frase del panel y su detalle", async () => {
    expect(await emite({ ok: false, reason: "editado", detail: "La línea 2 cambió." })).toEqual({
      error: `${INVOICE_REASON_LABEL.editado} La línea 2 cambió.`,
    });
    expect(await emite({ ok: false, reason: "sin_migracion", detail: "Falta aplicar la migración 0261." })).toEqual({
      error: `${INVOICE_REASON_LABEL.sin_migracion} Falta aplicar la migración 0261.`,
    });
  });

  it("si no se sabe qué pasó, no se afirma nada: ni que salió ni que no", async () => {
    const sinSaber = /^No se supo qué pasó con la emisión\. Vuelve a abrir el pedido antes de intentar de nuevo/;
    expect((await emite({ ...EMITIDA, status: "emitiendo" })).error).toMatch(sinSaber);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    st.emitThrows = new Error("se cortó con el token tok-secreto-123");
    const r = await emitInvoiceAction(ORDER, SHOWN);
    expect(r.error).toMatch(sinSaber);
    expect(r.notice).toBeUndefined();
    // Al log no va el texto del error: pudo haber tocado el token.
    expect(JSON.stringify(log.mock.calls)).not.toContain("tok-secreto");
    log.mockRestore();
  });
});

describe("loadInvoicePanel: «Emitir esta boleta» solo en Manual", () => {
  beforeEach(() => {
    st.issuers = [MANUAL];
    st.facts = new Map([[ORDER, manualFacts()]]);
  });
  const load = async () => {
    const res = await loadInvoicePanel(ORDER);
    if (!("data" in res)) throw new Error(res.error);
    return res.data;
  };
  const BOTON = {
    issuerId: ISSUER.id,
    ruc: RUC,
    legalName: "GRUPO GF S.A.C.",
    total: 85,
    // Pagado desde «Emitir desde»: no pide la casilla. Las fechas, en ISO.
    beforeStart: false,
    paidAt: "2026-10-14T11:00:00.000Z",
    emitFrom: "2026-10-14T00:00:00.000Z",
  };

  it("con el RUC en Manual, las reglas cumplidas como emisión real y el permiso: hay botón, con lo que se enviará", async () => {
    const data = await load();
    expect(data.emitNow).toEqual(BOTON);
    expect(data.emitNowBlocked).toBeNull();
    // La revisión sigue siendo la del barrido, que en Manual simula.
    expect(data.review).toMatchObject({ state: "lista", mode: "simulacion" });
    expect(data.issuers).toEqual([{ id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "manual" }]);
  });

  // FIX: el botón se ofrecía también en una vista previa, que comparte la base
  // y la llave de cifrado con producción.
  it("en una vista previa no hay botón: `canEmitNow` es false y, donde habría botón, se dice por qué", async () => {
    expect((await load()).canEmitNow).toBe(true);
    for (const env of ["preview", "development", undefined]) {
      vi.stubEnv("VERCEL_ENV", env);
      const data = await load();
      expect(data.canEmitNow, String(env)).toBe(false);
      expect(data.emitNow, String(env)).toBeNull();
      expect(data.emitNowBlocked, String(env)).toEqual({ reason: "no_produccion", detail: null });
    }
    // Lo demás no cambia: si lo frenan las reglas, se dice lo de las reglas.
    st.facts = new Map([[ORDER, manualFacts({ issuers: [{ ...MANUAL, checkedRuc: null }] })]]);
    expect(await load()).toMatchObject({ canEmitNow: false, emitNow: null, emitNowBlocked: { reason: "sin_conexion" } });
    // Y sin el permiso, ni el porqué.
    st.orgPerms = { [ORG]: [] };
    st.facts = new Map([[ORDER, manualFacts()]]);
    expect(await load()).toMatchObject({ canEmitNow: false, emitNow: null, emitNowBlocked: null });
  });

  it("en Real, en Simulación o Apagado no hay botón", async () => {
    for (const mode of ["real", "simulacion", "apagado"] as const) {
      st.facts = new Map([[ORDER, factsFor({ issuers: [{ ...ISSUER, mode }] })]]);
      const data = await load();
      expect(data.emitNow, mode).toBeNull();
      expect(data.emitNowBlocked, mode).toBeNull();
    }
  });

  it("sin el permiso no hay botón, ni el porqué", async () => {
    st.orgPerms = { [ORG]: [] };
    expect((await load()).emitNow).toBeNull();
    st.facts = new Map([[ORDER, manualFacts({ issuers: [{ ...MANUAL, hasToken: false }] })]]);
    expect((await load()).emitNowBlocked).toBeNull();
  });

  it("con un comprobante real vivo no hay botón, aunque los hechos no lo sepan todavía", async () => {
    for (const status of ["emitiendo", "emitida", "en_duda", "externa"]) {
      st.db.invoices = [dbRow({ status })];
      expect((await load()).emitNow, status).toBeNull();
    }
  });

  it("una simulación no lo quita: el botón va al lado de lo que habría enviado", async () => {
    st.facts = new Map([[ORDER, manualFacts({ existing: { realLive: false, simulated: true, errorBlocked: false } })]]);
    st.db.invoices = [dbRow({ mode: "simulacion", status: "simulada", serie: null, correlative: null, pdf_url: null })];
    expect((await load()).emitNow).toEqual(BOTON);
  });

  it("en una tienda que no está activa, o sin los hechos, no hay botón (falla cerrada)", async () => {
    st.db.store = { org_id: ORG, status: "paused" };
    expect((await load()).emitNow).toBeNull();
    st.db.store = { org_id: ORG, status: "active" };
    st.factsError = new Error("timeout");
    const data = await load();
    expect(data.review.state).toBe("sin_revisar");
    expect(data.emitNow).toBeNull();
    expect(data.emitNowBlocked).toBeNull();
  });

  it("un error sin reintento quita el botón; el porqué ya lo dice su «Volver a intentar»", async () => {
    st.facts = new Map([[ORDER, manualFacts({ existing: { realLive: false, simulated: false, errorBlocked: true } })]]);
    const data = await load();
    expect(data.emitNow).toBeNull();
    expect(data.emitNowBlocked).toBeNull();
  });

  it("sin la conexión probada no hay botón, y a quien gestiona se le dice por qué", async () => {
    st.facts = new Map([[ORDER, manualFacts({ issuers: [{ ...MANUAL, checkedRuc: null }] })]]);
    const data = await load();
    expect(data.emitNow).toBeNull();
    expect(data.emitNowBlocked).toEqual({ reason: "sin_conexion", detail: null });
    // Lo que la revisión ya dice no se repite.
    st.facts = new Map([[ORDER, manualFacts({ cancelledAt: "2026-10-14T16:00:00Z" })]]);
    expect(await load()).toMatchObject({ emitNow: null, emitNowBlocked: null, review: { state: "no", reason: "anulado" } });
  });

  it("si la última pasada lo frenó en Shopify, no hay botón", async () => {
    const shopify = (reason: string, mode = "simulacion", checked_at = "2026-10-14T14:50:00Z") => ({
      mode,
      reason,
      detail: null,
      checked_at,
    });
    for (const reason of ["editado", "no_encontrado", "sin_token_shopify", "lectura_fallida"]) {
      st.db.checks = [shopify(reason)];
      expect((await load()).emitNow, reason).toBeNull();
    }
    // La del otro modo también, si es de Shopify y la más nueva (como el panel).
    st.db.checks = [shopify("prueba", "real", "2026-10-14T15:00:00Z"), shopify("tope", "simulacion", "2026-10-14T14:00:00Z")];
    expect((await load()).emitNow).toBeNull();
    // Un motivo que no es de Shopify (el tope del día) no quita el botón.
    st.db.checks = [shopify("tope")];
    expect((await load()).emitNow).toEqual(BOTON);
  });

  // FIX: Ajustes decidía su «Emitir» por su cuenta. Ahora el drawer y Ajustes
  // preguntan a la misma función (`invoiceEmitNowReadiness`); aquí se fija que
  // el drawer dice exactamente lo que ella dice, y test/invoicing-server.test.ts
  // fija que Ajustes también (`loadInvoiceEmitNowOffers`).
  it("el botón es exactamente lo que dice `invoiceEmitNowReadiness`, la función que comparte con Ajustes", async () => {
    const simulada = dbRow({ mode: "simulacion", status: "simulada", serie: null, correlative: null, pdf_url: null });
    const casos: Array<[string, () => void]> = [
      ["lista", () => {}],
      ["pasa de S/ 700", () => (st.facts = new Map([[ORDER, manualFacts({ total: 800, payments: [{ ...factsFor().payments[0]!, amount: 800 }] })]]))],
      ["sin conexión", () => (st.facts = new Map([[ORDER, manualFacts({ issuers: [{ ...MANUAL, checkedRuc: null }] })]]))],
      ["en Real", () => (st.facts = new Map([[ORDER, factsFor({ issuers: [{ ...ISSUER, mode: "real" }] })]]))],
      ["tienda pausada", () => (st.db.store = { org_id: ORG, status: "paused" })],
      ["real viva", () => (st.db.invoices = [dbRow({ status: "en_duda" })])],
      ["Shopify lo frenó", () => (st.db.checks = [checkRow("editado")])],
      ["Shopify lo frenó antes de la simulada", () => ((st.db.checks = [checkRow("editado", { checked_at: "2026-10-12T10:00:00Z" })]), (st.db.invoices = [simulada]))],
      ["el tope no frena", () => (st.db.checks = [checkRow("tope")])],
    ];
    for (const [label, arrange] of casos) {
      st.facts = new Map([[ORDER, manualFacts()]]);
      st.db.store = { org_id: ORG, status: "active" };
      st.db.invoices = [];
      st.db.checks = [];
      arrange();
      const data = await load();
      const ready = invoiceEmitNowReadiness({
        facts: st.facts.get(ORDER) as InvoiceOrderFacts,
        invoices: data.invoices,
        checks: st.db.checks as never,
        storeActive: (st.db.store as { status: string }).status === "active",
      });
      expect(data.emitNow, label).toEqual(ready.ok ? ready.offer : null);
    }
    // Y no tiene una copia propia de las reglas del botón.
    const ACTIONS = read("app/dashboard/pedidos/invoice-actions.ts");
    const ofrece = ACTIONS.slice(ACTIONS.indexOf("function emitNowOf("), ACTIONS.indexOf("\n}\n", ACTIONS.indexOf("function emitNowOf(")));
    expect(ofrece).toContain("const ready = invoiceEmitNowReadiness({ facts, invoices, checks, storeActive });");
    expect(ofrece).not.toContain("invoiceEligibility(");
    expect(ofrece).not.toContain("ShopifyBlock(");
  });

  it("una simulación DESPUÉS del bloqueo de Shopify lo deja atrás: volvió a leer Shopify y armó la boleta", async () => {
    st.facts = new Map([[ORDER, manualFacts({ existing: { realLive: false, simulated: true, errorBlocked: false } })]]);
    st.db.checks = [{ mode: "simulacion", reason: "no_encontrado", detail: null, checked_at: "2026-10-12T10:00:00Z" }];
    const simulada = (created_at: string) =>
      dbRow({ mode: "simulacion", status: "simulada", serie: null, correlative: null, pdf_url: null, created_at });
    st.db.invoices = [simulada("2026-10-14T15:00:00Z")];
    expect((await load()).emitNow).toEqual(BOTON);
    // Una de antes del bloqueo no: lo último que se supo de Shopify es el bloqueo.
    st.db.invoices = [simulada("2026-10-11T15:00:00Z")];
    expect((await load()).emitNow).toBeNull();
  });
});

describe("el panel: «Emitir esta boleta»", () => {
  const MANUAL_ISSUERS: InvoicePanelData["issuers"] = [
    { id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "manual" },
  ];
  const conBoton = (over: Partial<InvoicePanelData> = {}) =>
    panelData({
      canManage: true,
      issuers: MANUAL_ISSUERS,
      emitNow: { issuerId: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C.", total: 85 },
      ...over,
    });
  const BOTON_RE = /<button[^>]*>Emitir esta boleta<\/button>/;

  it("con el botón: primario, habilitado y con su chapa", () => {
    const html = pinta(conBoton());
    expect(html).toMatch(BOTON_RE);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Emitir esta boleta<\/button>/);
    expect(invoicePanelView(conBoton()).badge).toEqual({ tone: "info", label: "Lista para emitir" });
    // La confirmación no se enseña hasta pulsar.
    expect(texto(html)).not.toContain("Sí, emitir");
  });

  it("de lo que decidió el servidor al panel: solo en Manual hay botón", async () => {
    for (const mode of ["manual", "real", "simulacion", "apagado"] as const) {
      st.issuers = [{ ...ISSUER, mode }];
      st.facts = new Map([[ORDER, factsFor({ issuers: [{ ...ISSUER, mode }] })]]);
      const res = await loadInvoicePanel(ORDER);
      if (!("data" in res)) throw new Error(res.error);
      expect(BOTON_RE.test(pinta(res.data)), mode).toBe(mode === "manual");
    }
  });

  it("sin el permiso, con un comprobante vivo o sin lo que decidió el servidor, no hay botón", () => {
    expect(pinta(conBoton({ canManage: false }))).not.toMatch(BOTON_RE);
    expect(pinta(conBoton({ invoices: [row({ status: "en_duda" })] }))).not.toMatch(BOTON_RE);
    expect(pinta(conBoton({ emitNow: null }))).not.toMatch(BOTON_RE);
    expect(invoicePanelView(conBoton({ invoices: [row()] })).canEmitNow).toBe(false);
  });

  it("deshabilitado mientras el drawer trabaja", () => {
    const html = renderToStaticMarkup(
      createElement(OrderInvoicePanelView, { orderId: ORDER, data: conBoton(), pending: true, run: async () => true }),
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Emitir esta boleta<\/button>/);
    const suelto = renderToStaticMarkup(
      createElement(EmitInvoiceControl, {
        emit: { ruc: RUC, legalName: "GRUPO GF S.A.C.", total: 85 },
        pending: true,
        onEmit: async () => {},
        label: "Emitir",
      }),
    );
    expect(suelto).toMatch(/<button[^>]*disabled=""[^>]*>Emitir<\/button>/);
  });

  it("con la simulada, el botón va justo después de lo que habría enviado", () => {
    const simulada = row({
      mode: "simulacion",
      status: "simulada",
      serie: null,
      correlative: null,
      pdfUrl: null,
      items: [{ code: "SKU-1", name: "Shampoo Birú", qty: 1, price: 85 }],
    });
    const t = texto(
      pinta(
        conBoton({
          invoices: [simulada],
          review: { state: "no", reason: "ya_simulado", detail: null, issuerId: ISSUER.id },
        }),
      ),
    );
    expect(t).toContain("Shampoo Birú");
    expect(t.indexOf("Shampoo Birú")).toBeLessThan(t.indexOf("Emitir esta boleta"));
    expect(t).not.toContain(INVOICE_REASON_LABEL.ya_simulado);
  });

  it("la confirmación dice qué sale, por cuánto, a quién y de qué RUC, y que no se borra", () => {
    expect(emitConfirmation({ ruc: RUC, legalName: "GRUPO GF S.A.C.", total: 85 })).toBe(
      `Se emite una boleta de S/ 85.00 a CLIENTES VARIOS con el RUC ${RUC} (GRUPO GF S.A.C.). Va a SUNAT y no se puede borrar.`,
    );
    const html = renderToStaticMarkup(
      createElement(EmitInvoiceConfirm, {
        emit: { ruc: RUC, legalName: "GRUPO GF S.A.C.", total: 120.5 },
        busy: false,
        simplefactChecked: false,
        onSimplefactChecked: () => {},
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    const t = texto(html);
    expect(t).toContain(
      `Se emite una boleta de S/ 120.50 a CLIENTES VARIOS con el RUC ${RUC} (GRUPO GF S.A.C.). Va a SUNAT y no se puede borrar.`,
    );
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>Sí, emitir<\/button>/);
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>Cancelar<\/button>/);
  });

  it("mientras sale: «Emitiendo…», sin «Sí, emitir» y sin cancelar", () => {
    const html = renderToStaticMarkup(
      createElement(EmitInvoiceConfirm, {
        emit: { ruc: RUC, legalName: "GRUPO GF S.A.C.", total: 85 },
        busy: true,
        simplefactChecked: false,
        onSimplefactChecked: () => {},
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Emitiendo…<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancelar<\/button>/);
    expect(html).not.toContain("Sí, emitir");
  });

  it("nunca dos envíos: el segundo «Sí, emitir» antes de que vuelva el primero no sale", async () => {
    const lock = { current: false };
    let suelta!: (v: string) => void;
    const send = vi.fn(() => new Promise<string>((r) => (suelta = r)));
    const primero = sendOnce(lock, send);
    expect(lock.current).toBe(true);
    expect(await sendOnce(lock, send)).toBeNull();
    expect(await sendOnce(lock, send)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    suelta("listo");
    expect(await primero).toBe("listo");
    // Vuelta la respuesta, se suelta, también si lo enviado lanzó.
    expect(lock.current).toBe(false);
    await expect(sendOnce(lock, async () => Promise.reject(new Error("caída")))).rejects.toThrow("caída");
    expect(lock.current).toBe(false);
    expect(await sendOnce(lock, async () => "otra")).toBe("otra");
  });

  it("el botón pasa por el candado, y el panel emite con lo que vio y se relee después", () => {
    const src = read("components/order-invoice-panel.tsx");
    const control = src.slice(src.indexOf("export function EmitInvoiceControl("), src.indexOf("export function EmitInvoiceConfirm("));
    expect(control).toContain("const lock = useRef(false);");
    expect(control).toMatch(/const confirmar = \(\) =>\s*void sendOnce\(lock, async \(\) => \{\s*setSending\(true\);/);
    expect(control).toContain("const busy = pending || sending;");
    expect(control).toContain("onConfirm={confirmar}");
    expect(src).toContain(
      "await run(() =>\n              emitInvoiceAction(orderId, { issuerId: emit.issuerId, total: emit.total, simplefactChecked }),\n            );\n            await onEmitted?.();",
    );
    expect(src).toContain("<OrderInvoicePanelView orderId={orderId} data={data} pending={pending} run={run} onEmitted={cargar} />");
  });

  it("en Manual, «lista» es para simularse: la boleta real la emite una persona", () => {
    const t = texto(pinta(panelData({ issuers: [{ id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "manual" }] })));
    expect(t).toContain(`Lista para simularse en la próxima pasada (RUC ${RUC}, modo Manual).`);
    expect(t).toContain(MANUAL_WHO_TEXT);
    expect(t).not.toContain("Lista para emitirse");
    // Fuera de Manual, como siempre.
    expect(texto(pinta(panelData()))).toContain("Lista para emitirse en la próxima pasada");
  });

  it("a quien gestiona, por qué no hay botón cuando nada más lo dice; a quien no, quién emite", () => {
    const t = texto(
      pinta(panelData({ canManage: true, issuers: MANUAL_ISSUERS, emitNowBlocked: { reason: "sin_conexion", detail: null } })),
    );
    expect(t).toContain(`«Emitir esta boleta» no está disponible: ${INVOICE_REASON_LABEL.sin_conexion}`);
    const simulada = row({ mode: "simulacion", status: "simulada", serie: null, correlative: null, pdfUrl: null, items: [] });
    const ajeno = texto(
      pinta(
        panelData({
          issuers: MANUAL_ISSUERS,
          invoices: [simulada],
          review: { state: "no", reason: "ya_simulado", detail: null, issuerId: ISSUER.id },
        }),
      ),
    );
    expect(ajeno).toContain(MANUAL_WHO_TEXT);
    expect(ajeno).not.toContain("Emitir esta boleta»");
  });

  it("lo que contestó, donde no hay cabecera (Ajustes): el aviso y «Ver PDF»", () => {
    const ok = renderToStaticMarkup(createElement(EmitOutcome, { state: { notice: "Emitida B001-97", pdfUrl: PDF } }));
    expect(texto(ok)).toBe("Emitida B001-97 · Ver PDF");
    expect(ok).toContain(`href="${PDF}"`);
    expect(ok).toContain('role="status"');
    const mal = renderToStaticMarkup(
      createElement(EmitOutcome, { state: { error: "SimpleFact no la emitió: Token rechazado (401).", pdfUrl: "http://x" } }),
    );
    expect(mal).toContain('role="alert"');
    expect(mal).toContain("text-crit-fg");
    expect(mal).not.toContain("Ver PDF");
    expect(renderToStaticMarkup(createElement(EmitOutcome, { state: {} }))).toBe("");
  });
});

// ── Lo pagado antes de «Emitir desde» (owner, 15-10-2026) ────────────────────

describe("«Emitir esta boleta» de un pedido pagado antes de «Emitir desde»: la casilla «Revisé en SimpleFact…»", () => {
  /** Grupo GF en «Manual», con «Emitir desde» a las 00:00 de Lima del 14/10. */
  const DESDE = "2026-10-14T05:00:00.000Z";
  const MANUAL_DESDE: InvoiceIssuer = { ...MANUAL, emitFrom: DESDE };
  /** Pagado el 10/10/2026 10:00 de Lima: después del 01/10 y antes de «Emitir desde». */
  const ANTES = "2026-10-10T15:00:00.000Z";
  const pagadoEl = (registeredAt: string) =>
    manualFacts({ issuers: [MANUAL_DESDE], payments: [{ ...factsFor().payments[0]!, registeredAt }] });
  const OFERTA_ANTES = {
    issuerId: ISSUER.id,
    ruc: RUC,
    legalName: "GRUPO GF S.A.C.",
    total: 85,
    beforeStart: true,
    paidAt: ANTES,
    emitFrom: DESDE,
  };
  const TEXTO_ANTES =
    "Quedó pagado el 10/10/2026 10:00, antes de «Emitir desde» (14/10/2026 00:00). Kapta no sabe si ya se emitió a mano: búscalo en SimpleFact antes de emitir.";
  const load = async () => {
    const res = await loadInvoicePanel(ORDER);
    if (!("data" in res)) throw new Error(res.error);
    return res.data;
  };
  const confirma = (emit: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(EmitInvoiceConfirm, {
        emit: { ruc: RUC, legalName: "GRUPO GF S.A.C.", total: 85, ...emit },
        busy: false,
        simplefactChecked: false,
        onSimplefactChecked: () => {},
        onConfirm: () => {},
        onCancel: () => {},
        ...over,
      }),
    );
  const SI_HABILITADO = /<button(?![^>]*disabled="")[^>]*>Sí, emitir<\/button>/;
  const SI_DESHABILITADO = /<button[^>]*disabled=""[^>]*>Sí, emitir<\/button>/;
  const CASILLA = /<input[^>]*type="checkbox"[^>]*>/;

  beforeEach(() => {
    st.issuers = [MANUAL_DESDE];
    st.facts = new Map([[ORDER, pagadoEl(ANTES)]]);
    st.emitResult = { ...EMITIDA };
  });

  it("el drawer ofrece el botón, con `beforeStart` y las dos fechas, y la revisión sigue diciendo `antes_de_inicio`", async () => {
    const data = await load();
    expect(data.emitNow).toEqual(OFERTA_ANTES);
    expect(data.emitNowBlocked).toBeNull();
    // La revisión es la del barrido: lo de antes no sale solo.
    expect(data.review).toMatchObject({ state: "no", reason: "antes_de_inicio" });
    // Antes del 01/10/2026 00:00 de Lima, ni botón ni otro porqué: la revisión ya lo dice.
    st.facts = new Map([[ORDER, pagadoEl("2026-10-01T04:59:59.999Z")]]);
    expect(await load()).toMatchObject({ emitNow: null, emitNowBlocked: null, review: { reason: "antes_de_inicio" } });
    // En Real, tampoco: ahí emite el barrido, que nunca va hacia atrás.
    st.facts = new Map([[ORDER, manualFacts({ issuers: [{ ...MANUAL_DESDE, mode: "real" }], payments: pagadoEl(ANTES).payments })]]);
    expect((await load()).emitNow).toBeNull();
  });

  it("emitInvoiceAction manda la casilla a `emitInvoiceNow` solo si es un `true`", async () => {
    const casos: Array<[unknown, boolean]> = [
      [true, true],
      [false, false],
      [undefined, false],
      ["true", false],
      [1, false],
    ];
    for (const [marcada, viaja] of casos) {
      st.emitArgs = [];
      await emitInvoiceAction(ORDER, { issuerId: ISSUER.id, total: 85, simplefactChecked: marcada as never });
      expect((st.emitArgs[0]![1] as { expected: unknown }).expected, String(marcada)).toEqual({
        issuerId: ISSUER.id,
        totalCents: 8500,
        simplefactChecked: viaja,
      });
    }
  });

  it("si `emitInvoiceNow` dice que falta la casilla, se dice con su frase", async () => {
    st.emitResult = { ok: false, reason: "sin_revision_simplefact" };
    expect(await emitInvoiceAction(ORDER, { issuerId: ISSUER.id, total: 85 })).toEqual({
      error: "Quedó pagado antes de «Emitir desde»: falta confirmar que en SimpleFact no tiene boleta.",
    });
  });

  it("lo que agrega la confirmación: cuándo quedó pagado y desde cuándo emite el RUC, en hora de Lima", () => {
    expect(emitBeforeStartText(OFERTA_ANTES)).toBe(TEXTO_ANTES);
    // Sin `beforeStart`, nada.
    expect(emitBeforeStartText({ ...OFERTA_ANTES, beforeStart: false })).toBeNull();
    expect(emitBeforeStartText({ paidAt: ANTES, emitFrom: DESDE })).toBeNull();
    // Sin las fechas, lo mismo sin ellas.
    expect(emitBeforeStartText({ beforeStart: true, paidAt: null, emitFrom: "pronto" })).toBe(
      "Quedó pagado antes de «Emitir desde». Kapta no sabe si ya se emitió a mano: búscalo en SimpleFact antes de emitir.",
    );
    expect(SIMPLEFACT_CHECK_LABEL).toBe("Revisé en SimpleFact y este pedido no tiene boleta");
  });

  it("con `beforeStart`: el texto y la casilla, sin marcar, y «Sí, emitir» deshabilitado hasta marcarla", () => {
    const sinMarcar = confirma(OFERTA_ANTES);
    const t = texto(sinMarcar);
    expect(t).toContain(TEXTO_ANTES);
    expect(t).toContain(SIMPLEFACT_CHECK_LABEL);
    // Una casilla de verdad, dentro de su etiqueta, sin marcar.
    expect(sinMarcar).toMatch(new RegExp(`<label[^>]*><input[^>]*type="checkbox"[^>]*/?>${SIMPLEFACT_CHECK_LABEL}</label>`));
    expect(sinMarcar.match(CASILLA)![0]).not.toContain("checked");
    expect(sinMarcar).toMatch(SI_DESHABILITADO);
    // Marcada: «Sí, emitir» se puede pulsar.
    const marcada = confirma(OFERTA_ANTES, { simplefactChecked: true });
    expect(marcada.match(CASILLA)![0]).toContain('checked=""');
    expect(marcada).toMatch(SI_HABILITADO);
    // Mientras sale, ni la casilla ni el botón.
    const saliendo = confirma(OFERTA_ANTES, { simplefactChecked: true, busy: true });
    expect(saliendo.match(CASILLA)![0]).toContain('disabled=""');
    expect(saliendo).not.toContain("Sí, emitir");
  });

  it("sin `beforeStart` no cambia nada: ni texto ni casilla, y «Sí, emitir» se puede pulsar", () => {
    for (const emit of [{ beforeStart: false, paidAt: ANTES, emitFrom: DESDE }, {}]) {
      const html = confirma(emit);
      expect(html, JSON.stringify(emit)).not.toMatch(CASILLA);
      expect(texto(html)).not.toContain(SIMPLEFACT_CHECK_LABEL);
      expect(texto(html)).not.toContain("Kapta no sabe si ya se emitió a mano");
      expect(html).toMatch(SI_HABILITADO);
    }
  });

  it("la casilla nace sin marcar cada vez, se desmarca al cancelar y al volver, y viaja a `onEmit`", () => {
    const src = read("components/order-invoice-panel.tsx");
    const control = src.slice(src.indexOf("export function EmitInvoiceControl("), src.indexOf("export function EmitInvoiceConfirm("));
    expect(control).toContain("const [simplefactChecked, setSimplefactChecked] = useState(false);");
    expect(control).toContain("await onEmit(simplefactChecked);");
    // Al abrir, al cancelar y al volver la respuesta.
    expect(control.match(/setSimplefactChecked\(false\);/g)).toHaveLength(3);
    expect(control).toMatch(/onClick=\{\(\) => \{\s*setSimplefactChecked\(false\);\s*setConfirming\(true\);/);
    expect(control).toMatch(/onCancel=\{\(\) => \{\s*setSimplefactChecked\(false\);\s*setConfirming\(false\);/);
    expect(control).toMatch(/finally \{\s*setSending\(false\);\s*setConfirming\(false\);\s*setSimplefactChecked\(false\);/);
    const confirm = src.slice(src.indexOf("export function EmitInvoiceConfirm("), src.indexOf("export function EmitOutcome("));
    expect(confirm).toContain("disabled={busy || (beforeStart !== null && !simplefactChecked)}");
  });

  it("el panel: el botón con su chapa, y la revisión dice que con él sí se puede", async () => {
    const data = await load();
    const html = pinta(data);
    expect(html).toMatch(/<button[^>]*>Emitir esta boleta<\/button>/);
    expect(invoicePanelView(data)).toMatchObject({ canEmitNow: true, backfillOffered: true, badge: { label: "Lista para emitir" } });
    expect(texto(html)).toContain(`${INVOICE_REASON_LABEL.antes_de_inicio} ${BACKFILL_REVIEW_TEXT}`);
    expect(BACKFILL_REVIEW_TEXT).toBe("No sale sola: se puede emitir con «Emitir esta boleta» después de revisar SimpleFact.");
  });

  it("la revisión solo agrega la frase con `antes_de_inicio` y el botón de un pedido de antes a la vista", () => {
    const antes = { state: "no" as const, reason: "antes_de_inicio" as const, detail: null, issuerId: ISSUER.id };
    const MANUAL_ISSUERS: InvoicePanelData["issuers"] = [{ id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "manual" }];
    const con = (over: Partial<InvoicePanelData> = {}) =>
      texto(pinta(panelData({ canManage: true, issuers: MANUAL_ISSUERS, review: antes, emitNow: OFERTA_ANTES, ...over })));
    expect(con()).toContain(BACKFILL_REVIEW_TEXT);
    // Sin botón (sin el permiso, fuera de producción, sin oferta, con uno vivo): no.
    expect(con({ canManage: false })).not.toContain(BACKFILL_REVIEW_TEXT);
    expect(con({ canEmitNow: false })).not.toContain(BACKFILL_REVIEW_TEXT);
    expect(con({ emitNow: null })).not.toContain(BACKFILL_REVIEW_TEXT);
    expect(con({ invoices: [row({ status: "emitida" })] })).not.toContain(BACKFILL_REVIEW_TEXT);
    // Un botón que no es de un pedido de antes: no.
    expect(con({ emitNow: { ...OFERTA_ANTES, beforeStart: false } })).not.toContain(BACKFILL_REVIEW_TEXT);
    // Otro motivo: no.
    expect(con({ review: { ...antes, reason: "tope" } })).not.toContain(BACKFILL_REVIEW_TEXT);
    // Y `antes_de_inicio` sigue diciendo lo de siempre.
    expect(con({ emitNow: null })).toContain(INVOICE_REASON_LABEL.antes_de_inicio);
  });

  it("al pulsar, el panel manda la casilla con lo que vio", () => {
    const src = read("components/order-invoice-panel.tsx");
    expect(src).toContain("onEmit={async (simplefactChecked) => {");
    expect(src).toContain("emitInvoiceAction(orderId, { issuerId: emit.issuerId, total: emit.total, simplefactChecked })");
  });
});
