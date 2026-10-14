// Comprobantes por RUC — el panel «Comprobante» del drawer (MOM §35.4, §35.7,
// §35.9).
//
// Lo que se fija aquí: lo ve quien ve el pedido y nunca lleva credenciales; una
// lectura caída no se pinta como «sin comprobante» ni como «lista para
// emitirse» (§35.3, falla cerrada); registrar uno externo, pedir un reintento y
// liberar uno en duda piden «Boletas y facturas» y solo valen desde el estado
// que corresponde; y el panel no arrastra node:crypto al navegador. La base,
// los permisos y el módulo del barrido van simulados: aquí se mira el drawer.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/invoicing/server", () => ({
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
  loadInvoicePanel,
  registerExternalInvoice,
  releaseDoubtfulInvoice,
  requestInvoiceRetry,
  type InvoicePanelData,
  type InvoicePanelRow,
} from "@/app/dashboard/pedidos/invoice-actions";
import {
  ExternalInvoiceForm,
  OrderInvoicePanel,
  OrderInvoicePanelView,
  ReleaseDoubtForm,
  invoicePanelView,
} from "@/components/order-invoice-panel";
import {
  INVOICE_REASON_LABEL,
  invoiceEligibility,
  invoiceNoteRef,
  type InvoiceIssuer,
  type InvoiceOrderFacts,
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
  items: null,
  ...over,
});

const panelData = (over: Partial<InvoicePanelData> = {}): InvoicePanelData => ({
  active: true,
  invoices: [],
  review: { state: "lista", ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "simulacion" },
  check: null,
  creditNote: null,
  issuers: [{ id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C." }],
  canManage: false,
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
    expect(res.data.review).toEqual({ state: "lista", ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "simulacion" });
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
    expect("data" in res && res.data.issuers).toEqual([{ id: ISSUER.id, ruc: RUC, legalName: "GRUPO GF S.A.C." }]);
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
    expect("data" in res && res.data.review).toEqual({ state: "no", reason: "tienda", detail: null });
  });

  it("un pedido que no cumple dice el primer motivo de §35.3, con su detalle", async () => {
    st.facts = new Map([[ORDER, factsFor({ accounts: [{ ...factsFor().accounts[0]!, issuerId: null }] })]]);
    const res = await loadInvoicePanel(ORDER);
    expect("data" in res && res.data.review).toEqual({
      state: "no",
      reason: "cuenta_sin_ruc",
      detail: "Aurela Kenku no tiene RUC.",
    });
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
});

describe("releaseDoubtfulInvoice: «No está en SimpleFact: volver a intentar» (§35.4)", () => {
  beforeEach(() => {
    st.db.invoiceRef = { id: INVOICE, org_id: ORG, order_id: ORDER, mode: "real", status: "en_duda", retry_requested_at: null };
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

  it("leer, registrar, reintentar y liberar: no hay «Emitir» (emite solo el barrido)", () => {
    expect([...bodies.keys()].sort()).toEqual([
      "loadInvoicePanel",
      "registerExternalInvoice",
      "releaseDoubtfulInvoice",
      "requestInvoiceRetry",
    ]);
    expect(ACTIONS).not.toMatch(/invoice_claim|simplefactCreateSale|runInvoiceSweep|\.rpc\(/);
  });

  it("cada una que escribe pregunta «invoices.manage» antes de su escritura", () => {
    const WRITES = /\.(insert|update|upsert|delete)\(/;
    const conEscritura = [...bodies].filter(([, body]) => WRITES.test(body));
    expect(conEscritura.map(([name]) => name).sort()).toEqual([
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
    const otro = texto(pinta(panelData({ invoices: [enDuda], canManage: false })));
    expect(otro).not.toContain("No está en SimpleFact: volver a intentar");
    expect(otro).toContain("la revisa quien tiene «Boletas y facturas»");
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
          review: { state: "no", reason: "ya_simulado", detail: null },
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
          review: { state: "lista", ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "real" },
        }),
      ),
    );
    expect(t).toContain("Lista para emitirse en la próxima pasada (RUC 20556792829, modo Real).");
    expect(t).toContain("Simulada: lo que habría enviado");
  });

  it("error: quien gestiona ve «Volver a intentar»; los demás, quién lo hace", () => {
    const error = row({ status: "error", serie: null, correlative: null, pdfUrl: null, error: "El total no cuadra." });
    const data = { invoices: [error], review: { state: "no" as const, reason: "error_previo" as const, detail: null } };
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
      pinta(panelData({ review: { state: "no", reason: "pago_sin_cuenta", detail: "Cobro del courier sin estado de cuenta Yape." } })),
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
    const check = { mode: "simulacion", reason: "editado", detail: null, checkedAt: "2026-10-14T14:50:00Z" };
    const distinta = texto(pinta(panelData({ check })));
    expect(distinta).toContain(`Última pasada (Simulación,`);
    expect(distinta).toContain(INVOICE_REASON_LABEL.editado);
    const igual = texto(pinta(panelData({ check, review: { state: "no", reason: "editado", detail: null } })));
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

  it("liberar pide escribir qué se revisó en SimpleFact", () => {
    const html = renderToStaticMarkup(
      createElement(ReleaseDoubtForm, { pending: false, onSubmit: async () => true, onCancel: () => {} }),
    );
    expect(texto(html)).toContain("Qué revisaste en SimpleFact");
    expect(html).toContain("<textarea");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Liberar y volver a intentar<\/button>/);
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
