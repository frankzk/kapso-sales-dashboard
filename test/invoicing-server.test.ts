// Comprobantes electrónicos por RUC — la base y el barrido
// (lib/invoicing/server.ts, MOM §35).
//
// Aquí no hay red ni Supabase. La base es un doble en memoria que filtra de
// verdad (eq, in, gte, or…), anota cada consulta y aplica las dos reglas de la
// 0257 que importan para no emitir de más: `invoice_claim` (uno por pedido, el
// tope del día, el modo) y el candado de `order_invoices` (los estados solo
// avanzan). Shopify y SimpleFact son dobles inyectados: nunca se llama a nada.
//
// Lo que se fija es lo que no se puede deshacer después: una boleta enviada a
// SUNAT no se borra. El turno va ANTES del POST, un envío sin respuesta queda
// en duda y no se repite, un token rechazado apaga el RUC, una lectura que
// falla no emite, y ni el token ni la clienta salen en el reporte o el log.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INVOICE_MAX_PER_RUN,
  buildSalePayload,
  invoiceNoteRef,
  type InvoiceItem,
} from "@/lib/invoicing/rules";
import type { InvoiceOrderRead } from "@/lib/invoicing/shopify-order";
import type { SimplefactHttp } from "@/lib/invoicing/simplefact";
import {
  INVOICE_NOT_FOUND_ERROR,
  INVOICE_SHOPIFY_RECHECK_MS,
  invoiceExistingFrom,
  loadInvoiceIssuers,
  loadInvoiceOrderFacts,
  runInvoiceSweep,
  type InvoiceSweepDeps,
} from "@/lib/invoicing/server";

// ── Doble de Supabase ────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Filter = [string, ...unknown[]];
interface Q {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  cols: string | null;
  filters: Filter[];
  values?: unknown;
  returning: string | null;
  orderBy?: { col: string; ascending: boolean };
  limit?: number;
  onConflict?: string;
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const ta = Date.parse(String(a));
  const tb = Date.parse(String(b));
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return String(a).localeCompare(String(b));
}

/** Parte «a,b(c,d),e» en sus términos de primer nivel. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** Lo justo de la sintaxis `or` de PostgREST: col.eq.valor, and(...), or(...). */
function orPredicate(term: string): (row: Row) => boolean {
  const group = /^(and|or)\((.*)\)$/.exec(term);
  if (group) {
    const inner = splitTop(group[2]!).map(orPredicate);
    return group[1] === "and" ? (r) => inner.every((p) => p(r)) : (r) => inner.some((p) => p(r));
  }
  const [col, op, ...rest] = term.split(".");
  const value = rest.join(".");
  if (op !== "eq") throw new Error(`operador no soportado en el doble: ${term}`);
  return (r) => r[col!] !== null && r[col!] !== undefined && String(r[col!]) === value;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(([op, col, a, b]) => {
    const v = row[col as string];
    switch (op) {
      case "eq":
        return v === a;
      case "neq":
        return v !== a;
      case "in":
        return (a as unknown[]).includes(v);
      case "gte":
        return v !== null && v !== undefined && cmp(v, a) >= 0;
      case "gt":
        return v !== null && v !== undefined && cmp(v, a) > 0;
      case "lt":
        return v !== null && v !== undefined && cmp(v, a) < 0;
      case "lte":
        return v !== null && v !== undefined && cmp(v, a) <= 0;
      case "is":
        return a === null ? v === null || v === undefined : v === a;
      case "not":
        if (a === "is" && b === null) return v !== null && v !== undefined;
        throw new Error(`not(${String(a)}) no soportado en el doble`);
      case "or":
        return splitTop(col as string).some((t) => orPredicate(t)(row));
      default:
        throw new Error(`filtro no soportado en el doble: ${op}`);
    }
  });
}

function project(row: Row, cols: string | null): Row {
  if (!cols || cols.trim() === "*") return { ...row };
  const out: Row = {};
  for (const c of cols.split(",").map((s) => s.trim())) out[c] = row[c] ?? null;
  return out;
}

/** El candado de `order_invoices` (0257): los estados solo avanzan y lo enviado no cambia. */
function invoiceGuard(old: Row, values: Row): string | null {
  if (["simulada", "emitida", "externa"].includes(old.status as string)) return `Un comprobante ${String(old.status)} no cambia`;
  const next = (values.status ?? old.status) as string;
  const ok =
    next === old.status ||
    (old.status === "emitiendo" && ["emitida", "error", "en_duda"].includes(next)) ||
    (old.status === "en_duda" && ["emitida", "error"].includes(next));
  if (!ok) return `Transición de comprobante no permitida: ${String(old.status)} → ${next}`;
  for (const k of ["id", "org_id", "store_id", "order_id", "issuer_id", "ruc", "mode", "total", "paid_at", "basis", "request", "created_at"]) {
    if (k in values && JSON.stringify(values[k]) !== JSON.stringify(old[k])) return "Lo enviado de un comprobante no cambia";
  }
  return null;
}

const LIVE = ["emitiendo", "emitida", "en_duda", "externa"];

function fakeDb(now: Date) {
  const tables: Record<string, Row[]> = {};
  const log: Q[] = [];
  const rpcLog: { fn: string; args: Record<string, unknown> }[] = [];
  const failWhen: Array<(q: Q) => boolean> = [];
  const state = {
    rpcError: null as string | null,
    claimOverride: null as null | ((args: Record<string, unknown>) => unknown),
  };
  const t = (name: string) => (tables[name] ??= []);

  const exec = (q: Q): { data: unknown; error: { message: string } | null } => {
    log.push(q);
    if (failWhen.some((f) => f(q))) return { data: null, error: { message: `falla simulada en ${q.table}` } };
    const rows = t(q.table);
    if (q.op === "select") {
      let out = rows.filter((r) => matches(r, q.filters));
      if (q.orderBy) {
        const { col, ascending } = q.orderBy;
        out = [...out].sort((a, b) => (ascending ? 1 : -1) * cmp(a[col], b[col]));
      }
      if (q.limit !== undefined) out = out.slice(0, q.limit);
      return { data: out.map((r) => project(r, q.cols)), error: null };
    }
    if (q.op === "insert") {
      const list = (Array.isArray(q.values) ? q.values : [q.values]) as Row[];
      rows.push(...list.map((r) => ({ ...r })));
      return { data: q.returning ? list.map((r) => project(r, q.returning)) : null, error: null };
    }
    if (q.op === "update") {
      const values = q.values as Row;
      const hit = rows.filter((r) => matches(r, q.filters));
      if (q.table === "order_invoices") {
        for (const r of hit) {
          const why = invoiceGuard(r, values);
          if (why) return { data: null, error: { message: why } };
        }
      }
      for (const r of hit) Object.assign(r, values);
      return { data: q.returning ? hit.map((r) => project(r, q.returning)) : null, error: null };
    }
    if (q.op === "upsert") {
      const keys = (q.onConflict ?? "id").split(",");
      for (const value of (Array.isArray(q.values) ? q.values : [q.values]) as Row[]) {
        const prev = rows.find((r) => keys.every((k) => r[k] === value[k]));
        if (prev) Object.assign(prev, value);
        else rows.push({ ...value });
      }
      return { data: null, error: null };
    }
    throw new Error(`operación no soportada en el doble: ${q.op}`);
  };

  const from = (table: string) => {
    const q: Q = { table, op: "select", cols: null, filters: [], returning: null };
    const b: Record<string, unknown> = {};
    b.select = (cols: string) => {
      if (q.op === "select") q.cols = cols;
      else q.returning = cols;
      return b;
    };
    for (const m of ["eq", "neq", "in", "gte", "gt", "lt", "lte", "is", "not", "or"]) {
      b[m] = (...args: unknown[]) => {
        q.filters.push([m, ...args]);
        return b;
      };
    }
    b.order = (col: string, opts?: { ascending?: boolean }) => {
      q.orderBy = { col, ascending: opts?.ascending ?? true };
      return b;
    };
    b.limit = (n: number) => {
      q.limit = n;
      return b;
    };
    for (const m of ["insert", "update", "upsert", "delete"] as const) {
      b[m] = (values: unknown, opts?: { onConflict?: string }) => {
        q.op = m;
        q.values = values;
        q.onConflict = opts?.onConflict;
        return b;
      };
    }
    b.maybeSingle = async () => {
      const r = exec(q);
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(exec(q)).then(res, rej);
    return b;
  };

  /** `invoice_claim` (0257, §6), con las mismas revisiones y en el mismo orden. */
  const claim = (a: Record<string, unknown>): unknown => {
    const store = t("stores").find((s) => s.id === a.p_store && s.status === "active");
    if (!store) return { reason: "tienda" };
    const order = t("orders").find((o) => o.id === a.p_order && o.store_id === a.p_store);
    if (!order) return { reason: "pedido" };
    if (order.cancelled_at) return { reason: "anulado" };
    if (Number(order.total_refunded ?? 0) !== 0) return { reason: "reembolsado" };
    if (String(order.currency ?? "").toUpperCase() !== "PEN") return { reason: "moneda" };
    const iss = t("invoice_issuers").find((i) => i.id === a.p_issuer);
    if (!iss || iss.org_id !== store.org_id) return { reason: "ruc_ajeno" };
    if (iss.mode === "apagado") return { reason: "ruc_apagado" };
    const total = Number(a.p_total);
    if (!(total > 0)) return { reason: "monto_cero" };
    if (total > 700) return { reason: "monto_mayor_700" };
    if (Math.abs(Number(order.total_amount) - total) >= 0.005) return { reason: "total_distinto" };
    if (!iss.emit_from || !a.p_paid_at || cmp(a.p_paid_at, iss.emit_from) < 0) return { reason: "antes_de_inicio" };
    if (!a.p_request || typeof a.p_request !== "object") return { reason: "sin_boleta" };
    const mine = t("order_invoices").filter((r) => r.order_id === a.p_order);
    if (mine.some((r) => r.mode === "real" && LIVE.includes(r.status as string))) return { reason: "ya_tiene" };
    if (iss.mode === "simulacion") {
      if (mine.some((r) => r.mode === "simulacion")) return { reason: "ya_simulado" };
    } else {
      if (!iss.token_enc || iss.checked_ruc !== iss.ruc) return { reason: "sin_conexion" };
      if (mine.some((r) => r.mode === "real" && r.status === "error" && !r.retry_requested_at)) return { reason: "error_previo" };
    }
    const dayStart = `${new Date(now.getTime() - 5 * 3_600_000).toISOString().slice(0, 10)}T05:00:00.000Z`;
    const used = t("order_invoices").filter(
      (r) =>
        r.issuer_id === a.p_issuer &&
        r.mode === iss.mode &&
        ["simulada", "emitiendo", "emitida", "en_duda"].includes(r.status as string) &&
        cmp(r.created_at, dayStart) >= 0,
    ).length;
    if (used >= Number(iss.daily_limit)) return { reason: "tope" };
    t("order_invoices").push({
      id: a.p_id,
      org_id: store.org_id,
      store_id: a.p_store,
      order_id: a.p_order,
      issuer_id: a.p_issuer,
      ruc: iss.ruc,
      mode: iss.mode,
      status: iss.mode === "real" ? "emitiendo" : "simulada",
      order_name: a.p_order_name,
      total,
      paid_at: a.p_paid_at,
      basis: a.p_basis,
      request: a.p_request,
      response: null,
      http_status: null,
      error: null,
      retry_requested_at: null,
      created_at: now.toISOString(),
    });
    return { id: a.p_id, mode: iss.mode };
  };

  const admin = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcLog.push({ fn, args });
      if (fn !== "invoice_claim") throw new Error(`rpc inesperada: ${fn}`);
      if (state.rpcError) return { data: null, error: { message: state.rpcError } };
      return { data: state.claimOverride ? state.claimOverride(args) : claim(args), error: null };
    },
  } as unknown as SupabaseClient;

  return { admin, tables, t, log, rpcLog, failWhen, state };
}

type Db = ReturnType<typeof fakeDb>;
const writes = (db: Db, table?: string) => db.log.filter((q) => q.op !== "select" && (!table || q.table === table));
const has = (q: Q, ...f: Filter) => q.filters.some((g) => JSON.stringify(g) === JSON.stringify(f));

// ── Datos ────────────────────────────────────────────────────────────────────

const RUC_GF = "20556792829";
const RUC_OTRO = "20600000005";
const ORG = "org-gf";
const ORG2 = "org-otra";
const STORE = "store-kenku";
const STORE2 = "store-otra";
const ISS = "iss-gf";
const ISS2 = "iss-otro";

/** 15:00 de Lima del 14-10-2026. */
const NOW = new Date("2026-10-14T20:00:00.000Z");
/** «Emitir desde»: la medianoche de Lima del 14-10-2026. */
const DESDE = "2026-10-14T05:00:00.000Z";
const PAGADO = "2026-10-14T15:00:00.000Z";
const FECHA_PEDIDO = "2026-10-14T13:00:00.000Z";
/** Un token con la forma de uno real. No es de ninguna cuenta. */
const TOKEN = "tok-SECRETO-b00131b17becc9906f5081793e79a5d7";
const TOKEN_ENC = "v1:texto-cifrado-de-prueba";
/** La clienta: no puede aparecer en el reporte ni en el log. */
const CLIENTA = "María Reservada Quispe";

function world(opts: { mode?: "apagado" | "simulacion" | "real"; dailyLimit?: number } = {}): Db {
  const db = fakeDb(NOW);
  db.t("stores").push({ id: STORE, org_id: ORG, status: "active" });
  db.t("invoice_issuers").push({
    id: ISS,
    org_id: ORG,
    ruc: RUC_GF,
    legal_name: "GRUPO GF S.A.C.",
    simplefact_subdomain: "grupogf",
    token_enc: TOKEN_ENC,
    mode: opts.mode ?? "real",
    emit_from: DESDE,
    daily_limit: opts.dailyLimit ?? 40,
    checked_ruc: RUC_GF,
    check_error: null,
  });
  db.t("store_collection_accounts").push(
    { id: "acc-gf", store_id: STORE, label: "Grupo GF S.A.C.", aliases: [], phone_last_digits: "309", invoice_issuer_id: ISS, active: true },
    { id: "acc-flow", store_id: STORE, label: "Aurela Kenku", aliases: [], phone_last_digits: null, invoice_issuer_id: ISS, active: true },
    { id: "acc-dueno", store_id: STORE, label: "Gabriela Reaño Vera", aliases: [], phone_last_digits: "147", invoice_issuer_id: null, active: true },
  );
  return db;
}

/** Una segunda organización con su propio RUC en real. */
function addSecondOrg(db: Db): void {
  db.t("stores").push({ id: STORE2, org_id: ORG2, status: "active" });
  db.t("invoice_issuers").push({
    id: ISS2,
    org_id: ORG2,
    ruc: RUC_OTRO,
    legal_name: "OTRA RAZÓN SOCIAL S.A.C.",
    simplefact_subdomain: "otra",
    token_enc: TOKEN_ENC,
    mode: "real",
    emit_from: DESDE,
    daily_limit: 40,
    checked_ruc: RUC_OTRO,
    check_error: null,
  });
  db.t("store_collection_accounts").push({
    id: "acc-flow-2",
    store_id: STORE2,
    label: "Aurela Kenku",
    aliases: [],
    phone_last_digits: null,
    invoice_issuer_id: ISS2,
    active: true,
  });
}

interface OrderOpts {
  store?: string;
  total?: number;
  prepaid?: boolean;
  createdAt?: string;
  validatedAt?: string;
  /** El pago no dice a qué cuenta entró. */
  sinCuenta?: boolean;
  inMaster?: boolean;
}

/** Un pedido pagado por link de Flow (cuenta de la pasarela → GRUPO GF). */
function addOrder(db: Db, n: number, o: OrderOpts = {}): string {
  const id = `ord-${n}`;
  const store = o.store ?? STORE;
  const total = o.total ?? 150;
  const createdAt = o.createdAt ?? FECHA_PEDIDO;
  db.t("orders").push({
    id,
    store_id: store,
    shopify_order_id: `shp-${n}`,
    name: `#KP${1000 + n}`,
    total_amount: total,
    currency: "PEN",
    cancelled_at: null,
    total_refunded: 0,
    financial_status: o.prepaid ? "paid" : "pending",
    payment_gateway: o.prepaid ? "checkout" : "manual",
    processed_at: createdAt,
    created_at: createdAt,
  });
  if (o.inMaster !== false) {
    db.t("order_master").push({
      order_id: id,
      store_id: store,
      customer_name: CLIENTA,
      customer_phone: "987654321",
      payment_state: o.prepaid ? "sin_pago" : "pago_completo",
      payment_gateway: o.prepaid ? "checkout" : "manual",
      financial_status: o.prepaid ? "paid" : "pending",
      order_created_at: createdAt,
    });
  }
  if (!o.prepaid) {
    db.t("order_payments").push({
      id: `pay-${n}`,
      order_id: id,
      store_id: store,
      kind: "total",
      amount: total,
      validation_status: "validado",
      validated_at: o.validatedAt ?? PAGADO,
      vision: {},
    });
    if (!o.sinCuenta) db.t("flowcl_payment_links").push({ id: `link-${n}`, order_id: id, payment_id: `pay-${n}` });
  }
  return id;
}

function okRead(shopifyOrderId: string, totalCents = 15_000, paid = false): InvoiceOrderRead {
  const items: InvoiceItem[] = [{ code: "FAJA-M", name: "Faja Reductora - M", qty: 1, priceCents: totalCents }];
  return {
    ok: true,
    orderGid: `gid://shopify/Order/${shopifyOrderId.replace(/\D/g, "")}`,
    name: `#KP${shopifyOrderId}`,
    totalCents,
    items,
    payment: paid
      ? { financialStatus: "PAID", gatewayNames: ["Checkout Flow"], paidCents: totalCents, netPaymentCents: totalCents, outstandingCents: 0 }
      : { financialStatus: "PENDING", gatewayNames: ["manual"], paidCents: 0, netPaymentCents: 0, outstandingCents: totalCents },
  };
}

/** La venta que contesta SimpleFact, con el RUC en el nombre de sus archivos. */
function sale(id: number, ruc = RUC_GF, notes: string | null = null) {
  return {
    id,
    invoice_type: "03",
    serie: "B001",
    correlative: String(id),
    status: "processing",
    customer_name: "CLIENTES VARIOS",
    notes,
    xml_url: `https://grupogf.simplefact.pe/app/download/invoices/${ruc}-03-B001-${id}.xml`,
    pdf_url: `https://grupogf.simplefact.pe/app/download/invoices/${ruc}-03-B001-${id}.pdf`,
    bill: { status: "accepted" },
  };
}

const created = (id: number, ruc = RUC_GF): SimplefactHttp => ({ http: 200, body: { success: true, data: sale(id, ruc) } });

/** Ids de comprobante con distinto prefijo: la nota «Kapta ‹ref›» usa los primeros 8. */
function uuidOf(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function makeDeps(over: { now?: () => Date; decryptToken?: InvoiceSweepDeps["decryptToken"] } = {}) {
  let n = 0;
  return {
    fetchOrder: vi.fn<InvoiceSweepDeps["fetchOrder"]>(async (input) => okRead(input.shopifyOrderId)),
    // Cada cuenta contesta con archivos de su propio RUC.
    createSale: vi.fn<InvoiceSweepDeps["createSale"]>(async (conn) =>
      created(500, conn.subdomain === "otra" ? RUC_OTRO : RUC_GF),
    ),
    listSales: vi.fn<InvoiceSweepDeps["listSales"]>(async () => ({ http: 200, body: { data: [] } })),
    decryptToken: vi.fn<InvoiceSweepDeps["decryptToken"]>(
      over.decryptToken ??
        ((enc) => {
          if (enc !== TOKEN_ENC) throw new Error("no descifra");
          return TOKEN;
        }),
    ),
    now: over.now ?? (() => NOW),
    randomUUID: () => uuidOf(++n),
  };
}

const sweep = (db: Db, deps: ReturnType<typeof makeDeps>, opts: { dry?: boolean; storeId?: string } = {}) =>
  runInvoiceSweep(db.admin, { ...opts, deps });

const invoice = (db: Db, orderId: string) => db.t("order_invoices").find((r) => r.order_id === orderId);
const check = (db: Db, orderId: string, mode = "real") =>
  db.t("invoice_order_checks").find((r) => r.order_id === orderId && r.mode === mode);
const issuerRow = (db: Db, id = ISS) => db.t("invoice_issuers").find((r) => r.id === id)!;

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Los RUC ──────────────────────────────────────────────────────────────────

describe("loadInvoiceIssuers: el token no sale (§35.6)", () => {
  it("dice si hay token con un booleano y nunca trae el texto cifrado", async () => {
    const db = world();
    db.t("invoice_issuers").push({
      id: "iss-sin-token",
      org_id: ORG,
      ruc: RUC_OTRO,
      legal_name: "OTRA RAZÓN SOCIAL S.A.C.",
      simplefact_subdomain: "otra",
      token_enc: null,
      mode: "apagado",
      emit_from: null,
      daily_limit: "40",
      checked_ruc: null,
    });
    const issuers = await loadInvoiceIssuers(db.admin, ORG);
    expect(issuers).toEqual([
      {
        id: ISS,
        orgId: ORG,
        ruc: RUC_GF,
        legalName: "GRUPO GF S.A.C.",
        mode: "real",
        emitFrom: DESDE,
        dailyLimit: 40,
        hasToken: true,
        checkedRuc: RUC_GF,
      },
      {
        id: "iss-sin-token",
        orgId: ORG,
        ruc: RUC_OTRO,
        legalName: "OTRA RAZÓN SOCIAL S.A.C.",
        mode: "apagado",
        emitFrom: null,
        dailyLimit: 40,
        hasToken: false,
        checkedRuc: null,
      },
    ]);
    expect(JSON.stringify(issuers)).not.toContain(TOKEN_ENC);
    // Ninguna lectura pide la columna cifrada: la presencia se pregunta con un filtro.
    for (const q of db.log) expect(q.cols ?? "").not.toContain("token_enc");
    expect(db.log.some((q) => has(q, "not", "token_enc", "is", null))).toBe(true);
  });

  it("un modo que no se entiende es «apagado»", async () => {
    const db = world();
    issuerRow(db).mode = "turbo";
    expect((await loadInvoiceIssuers(db.admin, ORG))[0]!.mode).toBe("apagado");
  });

  it("lanza si no se pudieron leer", async () => {
    const db = world();
    db.failWhen.push((q) => q.table === "invoice_issuers");
    await expect(loadInvoiceIssuers(db.admin, ORG)).rejects.toThrow(/invoice_issuers/);
  });
});

// ── Los hechos ───────────────────────────────────────────────────────────────

describe("loadInvoiceOrderFacts: los hechos de cada pedido (§35.2, §35.3)", () => {
  function factsWorld(): Db {
    const db = world();
    addOrder(db, 1);
    // Un segundo pago, validado por el estado de cuenta Yape.
    db.t("order_payments").push(
      {
        id: "pay-yape",
        order_id: "ord-1",
        store_id: STORE,
        kind: "diferencia",
        amount: "30.50",
        validation_status: "validado",
        validated_at: "2026-10-14T16:00:00.000Z",
        vision: { extracted: { recipient_name: "Grupo GF S.A.C." } },
      },
      {
        id: "pay-rechazado",
        order_id: "ord-1",
        store_id: STORE,
        kind: "adelanto",
        amount: 10,
        validation_status: "rechazado",
        validated_at: null,
        vision: {},
      },
    );
    db.t("yape_statement_matches").push(
      { payment_id: "pay-yape", movement_key: "mov-1", validated: true },
      // Un cruce que no se terminó de validar no dice nada, aunque el pago esté validado.
      { payment_id: "pay-1", movement_key: "mov-2", validated: false },
    );
    db.t("yape_statement_movements").push(
      { movement_key: "mov-1", destination: "GRUPO GF S.A.C." },
      { movement_key: "mov-2", destination: "Otra cuenta" },
    );
    db.t("store_collection_accounts").push({
      id: "acc-inactiva",
      store_id: STORE,
      label: "Cuenta vieja",
      aliases: null,
      phone_last_digits: "111",
      invoice_issuer_id: ISS,
      active: false,
    });
    db.t("order_invoices").push(
      { order_id: "ord-1", mode: "simulacion", status: "simulada", retry_requested_at: null, created_at: "2026-10-14T10:00:00.000Z" },
      { order_id: "ord-1", mode: "real", status: "error", retry_requested_at: "2026-10-14T11:00:00.000Z", created_at: "2026-10-14T10:30:00.000Z" },
    );
    return db;
  }

  it("arma los hechos con todo lo que decide el RUC, sin el token", async () => {
    const db = factsWorld();
    const facts = (await loadInvoiceOrderFacts(db.admin, ["ord-1", "ord-1", "no-existe"])).get("ord-1")!;
    expect(facts).toMatchObject({
      orderId: "ord-1",
      storeId: STORE,
      orderName: "#KP1001",
      total: 150,
      currency: "PEN",
      cancelledAt: null,
      totalRefunded: 0,
      financialStatus: "pending",
      paymentGateway: "manual",
      orderDate: FECHA_PEDIDO,
      customerName: CLIENTA,
      existing: { realLive: false, simulated: true, errorBlocked: false },
    });
    expect(facts.payments).toEqual([
      {
        id: "pay-1",
        kind: "total",
        amount: 150,
        validationStatus: "validado",
        validatedAt: PAGADO,
        vision: {},
        flowLinked: true,
        statementDestination: null,
      },
      {
        id: "pay-yape",
        kind: "diferencia",
        amount: 30.5,
        validationStatus: "validado",
        validatedAt: "2026-10-14T16:00:00.000Z",
        vision: { extracted: { recipient_name: "Grupo GF S.A.C." } },
        flowLinked: false,
        statementDestination: "GRUPO GF S.A.C.",
      },
      {
        id: "pay-rechazado",
        kind: "adelanto",
        amount: 10,
        validationStatus: "rechazado",
        validatedAt: null,
        vision: {},
        flowLinked: false,
        statementDestination: null,
      },
    ]);
    // Solo las cuentas activas, ordenadas por id, con su RUC.
    expect(facts.accounts).toEqual([
      { id: "acc-dueno", label: "Gabriela Reaño Vera", aliases: [], phoneLastDigits: "147", issuerId: null },
      { id: "acc-flow", label: "Aurela Kenku", aliases: [], phoneLastDigits: null, issuerId: ISS },
      { id: "acc-gf", label: "Grupo GF S.A.C.", aliases: [], phoneLastDigits: "309", issuerId: ISS },
    ]);
    expect(facts.issuers).toEqual([expect.objectContaining({ id: ISS, hasToken: true, mode: "real" })]);
    expect(JSON.stringify(facts)).not.toContain(TOKEN_ENC);
  });

  it("la fecha del pedido es `processed_at` y, si falta, `created_at`", async () => {
    const db = world();
    addOrder(db, 1);
    db.t("orders")[0]!.processed_at = null;
    db.t("orders")[0]!.created_at = "2026-10-13T09:00:00.000Z";
    expect((await loadInvoiceOrderFacts(db.admin, ["ord-1"])).get("ord-1")!.orderDate).toBe("2026-10-13T09:00:00.000Z");
  });

  it("un monto ilegible no pasa por cero: queda NaN y las reglas lo leen como «no se sabe»", async () => {
    const db = world();
    addOrder(db, 1);
    db.t("orders")[0]!.total_refunded = "no-es-numero";
    db.t("orders")[0]!.payment_gateway = "otra-pasarela";
    const facts = (await loadInvoiceOrderFacts(db.admin, ["ord-1"])).get("ord-1")!;
    expect(Number.isNaN(facts.totalRefunded)).toBe(true);
    expect(facts.paymentGateway).toBeNull();
  });

  it("una tienda sin organización no tiene RUC", async () => {
    const db = world();
    addOrder(db, 1);
    db.t("stores")[0]!.org_id = null;
    expect((await loadInvoiceOrderFacts(db.admin, ["ord-1"])).get("ord-1")!.issuers).toEqual([]);
  });

  it.each([
    "orders",
    "stores",
    "order_master",
    "order_payments",
    "store_collection_accounts",
    "order_invoices",
    "flowcl_payment_links",
    "yape_statement_matches",
    "yape_statement_movements",
    "invoice_issuers",
  ])("FALLA CERRADA: si no se puede leer %s, lanza en vez de devolver hechos a medias", async (table) => {
    const db = factsWorld();
    db.failWhen.push((q) => q.table === table);
    await expect(loadInvoiceOrderFacts(db.admin, ["ord-1"])).rejects.toThrow(table);
  });

  it("FALLA CERRADA: un cruce validado sin su movimiento no adivina la cuenta", async () => {
    const db = factsWorld();
    db.tables.yape_statement_movements = [];
    await expect(loadInvoiceOrderFacts(db.admin, ["ord-1"])).rejects.toThrow(/movimiento/);
  });

  it("lee por lotes de 200 ids", async () => {
    const db = world();
    const ids = Array.from({ length: 450 }, (_, i) => `x-${i}`);
    await loadInvoiceOrderFacts(db.admin, ids);
    const reads = db.log.filter((q) => q.table === "orders");
    expect(reads.map((q) => (q.filters.find((f) => f[0] === "in")![2] as string[]).length)).toEqual([200, 200, 50]);
  });

  it("sin pedidos no lee nada", async () => {
    const db = world();
    expect((await loadInvoiceOrderFacts(db.admin, [])).size).toBe(0);
    expect(db.log).toEqual([]);
  });
});

describe("invoiceExistingFrom: lo que ya hay (§35.3, condiciones 9 y 10)", () => {
  const row = (mode: string, status: string, created_at: string, retry: string | null = null) => ({
    order_id: "o",
    mode,
    status,
    retry_requested_at: retry,
    created_at,
  });

  it.each(["emitiendo", "emitida", "en_duda", "externa"])("un real %s es vivo", (status) => {
    expect(invoiceExistingFrom([row("real", status, PAGADO)]).realLive).toBe(true);
  });

  it("un error no es vivo; una simulación no es real", () => {
    expect(invoiceExistingFrom([row("real", "error", PAGADO, PAGADO), row("simulacion", "simulada", PAGADO)])).toEqual({
      realLive: false,
      simulated: true,
      errorBlocked: false,
    });
  });

  it("bloquea solo si el ÚLTIMO intento real es un error sin reintento pedido", () => {
    expect(invoiceExistingFrom([row("real", "error", PAGADO)]).errorBlocked).toBe(true);
    expect(invoiceExistingFrom([row("real", "error", PAGADO, NOW.toISOString())]).errorBlocked).toBe(false);
    // Un error viejo ya reintentado y el reintento terminó en error sin pedir otro: bloquea.
    expect(
      invoiceExistingFrom([
        row("real", "error", "2026-10-14T10:00:00.000Z", "2026-10-14T11:00:00.000Z"),
        row("real", "error", "2026-10-14T12:00:00.000Z"),
      ]).errorBlocked,
    ).toBe(true);
    // El último es un reintento con reintento pedido: no bloquea aunque haya uno viejo.
    expect(
      invoiceExistingFrom([
        row("real", "error", "2026-10-14T12:00:00.000Z", "2026-10-14T13:00:00.000Z"),
        row("real", "error", "2026-10-14T10:00:00.000Z", "2026-10-14T11:00:00.000Z"),
      ]).errorBlocked,
    ).toBe(false);
    // Una simulación nunca bloquea lo real.
    expect(invoiceExistingFrom([row("simulacion", "simulada", NOW.toISOString())]).errorBlocked).toBe(false);
  });
});

// ── El barrido ───────────────────────────────────────────────────────────────

describe("runInvoiceSweep: qué RUC barre", () => {
  it("sin un RUC en simulación o en real no hace nada", async () => {
    const db = world({ mode: "apagado" });
    addOrder(db, 1);
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report).toMatchObject({ skipped: "sin_ruc_encendido", orgs: [], errors: [] });
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(db.rpcLog).toEqual([]);
  });

  it("?storeId mira solo los RUC de la organización de esa tienda", async () => {
    const db = world();
    addSecondOrg(db);
    addOrder(db, 1);
    addOrder(db, 2, { store: STORE2 });
    const deps = makeDeps();
    const report = await sweep(db, deps, { storeId: STORE2 });
    expect(report.orgs.map((o) => o.orgId)).toEqual([ORG2]);
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(invoice(db, "ord-1")).toBeUndefined();
    expect(invoice(db, "ord-2")).toMatchObject({ status: "emitida", issuer_id: ISS2 });
  });

  it("?storeId de una tienda que no existe: nada que barrer", async () => {
    const db = world();
    const report = await sweep(db, makeDeps(), { storeId: "00000000-0000-4000-8000-000000000000" });
    expect(report.skipped).toBe("sin_ruc_encendido");
  });

  it("si no puede leer los RUC, lo dice y no hace nada más", async () => {
    const db = world();
    addOrder(db, 1);
    db.failWhen.push((q) => q.table === "invoice_issuers");
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report.errors).toHaveLength(1);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
  });
});

describe("runInvoiceSweep: simulación (§35.6)", () => {
  it("pide el turno con los parámetros exactos, guarda la boleta y NO llama a SimpleFact", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    const deps = makeDeps();
    const report = await sweep(db, deps);

    const payload = buildSalePayload({
      invoiceId: uuidOf(1),
      orderName: "#KP1001",
      items: [{ code: "FAJA-M", name: "Faja Reductora - M", qty: 1, priceCents: 15_000 }],
      totalCents: 15_000,
    });
    expect(db.rpcLog).toEqual([
      {
        fn: "invoice_claim",
        args: {
          p_id: uuidOf(1),
          p_issuer: ISS,
          p_store: STORE,
          p_order: "ord-1",
          p_total: 150,
          p_paid_at: PAGADO,
          p_order_name: "#KP1001",
          p_basis: {
            prepaid: false,
            payments: [{ id: "pay-1", amount: 150, source: "flow", accountIds: ["acc-flow"], validatedAt: PAGADO }],
          },
          p_request: payload,
        },
      },
    ]);
    expect(deps.fetchOrder).toHaveBeenCalledWith({ storeId: STORE, shopifyOrderId: "shp-1" });
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(deps.listSales).not.toHaveBeenCalled();
    // Ni siquiera se descifra el token: la simulación no lo necesita.
    expect(deps.decryptToken).not.toHaveBeenCalled();
    expect(invoice(db, "ord-1")).toMatchObject({ mode: "simulacion", status: "simulada", request: payload });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ mode: "simulacion", simuladas: 1, emitidas: 0 });
    expect(report.errors).toEqual([]);
  });

  it("la segunda pasada no simula dos veces el mismo pedido", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    await sweep(db, makeDeps());
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(db.t("order_invoices")).toHaveLength(1);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(report.orgs[0]!.issuers[0]!.reasons).toEqual({ ya_simulado: 1 });
    expect(check(db, "ord-1", "simulacion")).toMatchObject({ reason: "ya_simulado", issuer_id: ISS });
  });
});

describe("runInvoiceSweep: emisión real (§35.4)", () => {
  it("el turno va ANTES del POST, una sola llamada, y la fila queda emitida", async () => {
    const db = world();
    addOrder(db, 1);
    const deps = makeDeps();
    deps.createSale.mockImplementation(async () => {
      // Al momento de llamar, la fila ya existe en `emitiendo`.
      expect(db.rpcLog).toHaveLength(1);
      expect(invoice(db, "ord-1")).toMatchObject({ status: "emitiendo" });
      return created(812);
    });
    const report = await sweep(db, deps);

    expect(deps.createSale).toHaveBeenCalledTimes(1);
    const [conn, payload] = deps.createSale.mock.calls[0] as unknown as [{ subdomain: string; token: string }, unknown];
    expect(conn).toEqual({ subdomain: "grupogf", token: TOKEN });
    expect(payload).toEqual(db.rpcLog[0]!.args.p_request);
    expect(invoice(db, "ord-1")).toMatchObject({
      status: "emitida",
      http_status: 200,
      simplefact_id: 812,
      serie: "B001",
      correlative: "812",
      pdf_url: `https://grupogf.simplefact.pe/app/download/invoices/${RUC_GF}-03-B001-812.pdf`,
      xml_url: `https://grupogf.simplefact.pe/app/download/invoices/${RUC_GF}-03-B001-812.xml`,
      sunat_status: "accepted",
      ruc_mismatch: false,
      error: null,
    });
    // Se actualiza solo si sigue en `emitiendo`.
    const update = writes(db, "order_invoices").find((q) => q.op === "update")!;
    expect(has(update, "eq", "id", uuidOf(1))).toBe(true);
    expect(has(update, "eq", "status", "emitiendo")).toBe(true);
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ emitidas: 1, en_duda: 0, errores: 0 });
    expect(report.errors).toEqual([]);
  });

  it("el token se descifra una vez por pasada", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    const deps = makeDeps();
    deps.createSale.mockResolvedValueOnce(created(1)).mockResolvedValueOnce(created(2));
    await sweep(db, deps);
    expect(deps.createSale).toHaveBeenCalledTimes(2);
    expect(deps.decryptToken).toHaveBeenCalledTimes(1);
  });

  it("un token que no se descifra no pide turno: no queda una fila `emitiendo` que nunca se envió", async () => {
    const db = world();
    addOrder(db, 1);
    const deps = makeDeps({ decryptToken: () => { throw new Error("clave equivocada"); } });
    const report = await sweep(db, deps);
    expect(db.rpcLog).toEqual([]);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ stopped: "sin_token", pendientes: 1 });
    expect(report.errors.join(" ")).toMatch(/descifrar/);
    expect(report.errors.join(" ")).not.toContain("clave equivocada");
  });

  it("500: queda en duda, no se repite en la misma pasada ni en la siguiente", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue({ http: 500, body: { message: "Server Error" } });
    const report = await sweep(db, deps);

    expect(deps.createSale).toHaveBeenCalledTimes(1);
    const first = db.t("order_invoices")[0]!;
    expect(first).toMatchObject({ status: "en_duda", http_status: 500, response: { message: "Server Error" } });
    expect(first.error).toMatch(/500/);
    // Una emisión en duda corta el lote de ese RUC.
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ en_duda: 1, stopped: "en_duda", pendientes: 1 });

    const next = makeDeps();
    next.createSale.mockResolvedValue(created(9));
    await sweep(db, next);
    const calls = next.createSale.mock.calls as unknown as [unknown, { notes: string }][];
    // El pedido en duda no vuelve a salir; el otro sí.
    expect(calls).toHaveLength(1);
    expect(calls[0]![1].notes).toContain("#KP1002");
    expect(db.t("order_invoices").filter((r) => r.order_id === "ord-1")).toHaveLength(1);
    expect(check(db, "ord-1")).toMatchObject({ reason: "ya_tiene" });
  });

  it("sin respuesta (http null): en duda, con el motivo del transporte", async () => {
    const db = world();
    addOrder(db, 1);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue({ http: null, body: null, error: "SimpleFact no respondió en 25000 ms" });
    await sweep(db, deps);
    expect(invoice(db, "ord-1")).toMatchObject({
      status: "en_duda",
      http_status: null,
      error: "SimpleFact no respondió. (SimpleFact no respondió en 25000 ms)",
      response: { error: "SimpleFact no respondió en 25000 ms" },
    });
  });

  it("si otra pasada tomó el pedido entre la lectura y el turno, la base dice ya_tiene y no se llama", async () => {
    const db = world();
    addOrder(db, 1);
    const deps = makeDeps();
    deps.fetchOrder.mockImplementation(async (input) => {
      // Otra pasada reservó el turno mientras se leía Shopify.
      db.t("order_invoices").push({ id: "otra", order_id: "ord-1", mode: "real", status: "emitiendo", issuer_id: ISS, created_at: NOW.toISOString() });
      return okRead(input.shopifyOrderId);
    });
    const report = await sweep(db, deps);
    expect(db.rpcLog).toHaveLength(1);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(check(db, "ord-1")).toMatchObject({ reason: "ya_tiene", issuer_id: ISS });
    expect(report.orgs[0]!.issuers[0]!.reasons).toEqual({ ya_tiene: 1 });
  });

  it("422: error sin boleta; no se reintenta solo y el lote sigue", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    const deps = makeDeps();
    deps.createSale
      .mockResolvedValueOnce({ http: 422, body: { message: "El campo items es inválido." } })
      .mockResolvedValueOnce(created(3));
    const report = await sweep(db, deps);
    expect(deps.createSale).toHaveBeenCalledTimes(2);
    expect(db.t("order_invoices").map((r) => r.status).sort()).toEqual(["emitida", "error"]);
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ errores: 1, emitidas: 1, stopped: null });
    const next = makeDeps();
    await sweep(db, next);
    expect(next.createSale).not.toHaveBeenCalled();
    const errored = db.t("order_invoices").find((r) => r.status === "error")!;
    expect(check(db, errored.order_id as string)).toMatchObject({ reason: "error_previo" });
  });

  it("401: apaga el RUC con el motivo a la vista y no intenta los demás pedidos de ese RUC", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    addOrder(db, 3);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue({ http: 401, body: { message: "Unauthenticated." } });
    const report = await sweep(db, deps);
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(issuerRow(db)).toMatchObject({ mode: "apagado" });
    expect(issuerRow(db).check_error).toMatch(/Token rechazado \(401\)/);
    expect(db.t("order_invoices")).toHaveLength(1);
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "error", http_status: 401 });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ errores: 1, stopped: "apagado", pendientes: 2 });
    expect(report.errors.join(" ")).toMatch(/apagado/);
    // Con el token rechazado no se concilia.
    expect(deps.listSales).not.toHaveBeenCalled();
  });

  it("429: corta toda la emisión de la pasada, también la de otra organización", async () => {
    const db = world();
    addSecondOrg(db);
    addOrder(db, 1);
    addOrder(db, 2, { store: STORE2 });
    const deps = makeDeps();
    deps.createSale.mockResolvedValue({ http: 429, body: { message: "Too Many Attempts." } });
    const report = await sweep(db, deps);
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(issuerRow(db)).toMatchObject({ mode: "real" });
    expect(report.orgs.map((o) => o.issuers[0]!.pendientes)).toEqual([0, 1]);
    expect(report.orgs[0]!.issuers[0]!.stopped).toBe("simplefact_pidio_esperar");
    expect(report.errors.join(" ")).toMatch(/429/);
  });

  it("una venta con archivos de OTRO RUC: se guarda marcada y el RUC se apaga solo", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue(created(44, "20601643316"));
    const report = await sweep(db, deps);
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "emitida", ruc_mismatch: true, simplefact_id: 44 });
    expect(db.t("order_invoices")[0]!.error).toMatch(/20601643316/);
    expect(issuerRow(db).mode).toBe("apagado");
    expect(issuerRow(db).check_error).toMatch(/20601643316/);
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ emitidas: 1, stopped: "apagado", pendientes: 1 });
  });

  it("el tope del día lo dice la base: se guarda el motivo, no se llama y el RUC para", async () => {
    const db = world({ dailyLimit: 1 });
    db.t("order_invoices").push({
      id: "ya",
      order_id: "ord-viejo",
      issuer_id: ISS,
      mode: "real",
      status: "emitida",
      created_at: "2026-10-14T14:00:00.000Z",
    });
    addOrder(db, 1);
    addOrder(db, 2);
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(db.rpcLog).toHaveLength(1);
    expect(check(db, "ord-2") ?? check(db, "ord-1")).toMatchObject({ reason: "tope", issuer_id: ISS });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ stopped: "tope", pendientes: 1, reasons: { tope: 1 } });
  });

  it("si la base ya lo tiene en real pero el token no se puede leer, cierra el turno como error: no se envió nada", async () => {
    // El RUC estaba en simulación al leer la lista y pasó a real antes del turno.
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    db.state.claimOverride = (a) => {
      db.t("order_invoices").push({ id: a.p_id, order_id: a.p_order, issuer_id: ISS, mode: "real", status: "emitiendo", created_at: NOW.toISOString() });
      return { id: a.p_id, mode: "real" };
    };
    const deps = makeDeps({ decryptToken: () => { throw new Error("x"); } });
    const report = await sweep(db, deps);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(invoice(db, "ord-1")).toMatchObject({ status: "error", error: "No se envió: no se pudo leer el token de SimpleFact." });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ errores: 1, stopped: "sin_token" });
  });

  it("si el turno no responde, no se llama a SimpleFact y se sigue con el siguiente", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    db.state.rpcError = "connection reset";
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(db.rpcLog).toHaveLength(2);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(report.errors).toHaveLength(2);
    expect(report.orgs[0]!.issuers[0]!.errores).toBe(2);
  });

  it("un turno que contesta algo raro detiene el RUC", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    db.state.claimOverride = () => ({ id: "otro-id", mode: "real" });
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(db.rpcLog).toHaveLength(1);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(report.orgs[0]!.issuers[0]!.stopped).toBe("turno");
  });

  it("si no se puede guardar la respuesta, la fila queda emitiendo (la concilia la próxima pasada) y el RUC para", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    db.failWhen.push((q) => q.table === "order_invoices" && q.op === "update");
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(invoice(db, "ord-1") ?? invoice(db, "ord-2")).toMatchObject({ status: "emitiendo" });
    expect(report.orgs[0]!.issuers[0]!.stopped).toBe("base");
    expect(report.errors.join(" ")).toMatch(/no se pudo guardar/);
  });

  it(`a lo más ${INVOICE_MAX_PER_RUN} comprobantes por RUC en una pasada`, async () => {
    const db = world({ mode: "simulacion" });
    for (let i = 1; i <= 20; i += 1) addOrder(db, i);
    const report = await sweep(db, makeDeps());
    expect(db.rpcLog).toHaveLength(INVOICE_MAX_PER_RUN);
    expect(db.t("order_invoices")).toHaveLength(INVOICE_MAX_PER_RUN);
    expect(report.orgs[0]!.issuers[0]).toMatchObject({
      simuladas: INVOICE_MAX_PER_RUN,
      pendientes: 20 - INVOICE_MAX_PER_RUN,
      stopped: "tope_de_la_pasada",
    });
  });
});

describe("runInvoiceSweep: la lectura de Shopify justo antes (§35.3)", () => {
  it("una lectura que falla no pide turno: guarda el motivo y se reintenta en la próxima pasada", async () => {
    const db = world();
    addOrder(db, 1);
    const deps = makeDeps();
    deps.fetchOrder.mockResolvedValue({ ok: false, reason: "lectura_fallida", detail: "Shopify no respondió a tiempo." });
    const report = await sweep(db, deps);
    expect(db.rpcLog).toEqual([]);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(check(db, "ord-1")).toMatchObject({
      reason: "lectura_fallida",
      detail: "Shopify no respondió a tiempo.",
      issuer_id: ISS,
      store_id: STORE,
      checked_at: NOW.toISOString(),
    });
    expect(report.orgs[0]!.issuers[0]!.reasons).toEqual({ lectura_fallida: 1 });
    // `lectura_fallida` no es de Shopify-que-dijo-que-no: la próxima pasada relee.
    const next = makeDeps();
    await sweep(db, next);
    expect(next.fetchOrder).toHaveBeenCalledTimes(1);
  });

  it("total distinto: no pide turno", async () => {
    const db = world();
    addOrder(db, 1);
    const deps = makeDeps();
    deps.fetchOrder.mockResolvedValue(okRead("shp-1", 14_990));
    await sweep(db, deps);
    expect(db.rpcLog).toEqual([]);
    expect(check(db, "ord-1")).toMatchObject({ reason: "total_distinto", detail: "Shopify dice S/ 149.90; Kapta, S/ 150.00." });
  });

  it("un detalle que no cuadra no arma boleta", async () => {
    const db = world();
    addOrder(db, 1);
    const deps = makeDeps();
    const read = okRead("shp-1") as Extract<InvoiceOrderRead, { ok: true }>;
    deps.fetchOrder.mockResolvedValue({ ...read, items: [{ code: "A", name: "A", qty: 1, priceCents: 14_000 }] });
    await sweep(db, deps);
    expect(db.rpcLog).toEqual([]);
    expect(check(db, "ord-1")).toMatchObject({ reason: "no_cuadra" });
  });

  it("prepago web: sin la confirmación de Shopify no se emite; con ella, sí", async () => {
    const db = world();
    addOrder(db, 1, { prepaid: true });
    const deps = makeDeps();
    await sweep(db, deps);
    expect(db.rpcLog).toEqual([]);
    expect(check(db, "ord-1")).toMatchObject({ reason: "pago_web_no_confirmado" });

    // Pasadas las 6 horas, se relee y Shopify ya lo confirma.
    const later = new Date(NOW.getTime() + INVOICE_SHOPIFY_RECHECK_MS + 60_000);
    const next = makeDeps({ now: () => later });
    next.fetchOrder.mockResolvedValue(okRead("shp-1", 15_000, true));
    await sweep(db, next);
    expect(db.rpcLog).toHaveLength(1);
    expect(db.rpcLog[0]!.args).toMatchObject({
      p_paid_at: FECHA_PEDIDO,
      p_basis: { prepaid: true, payments: [{ id: null, source: "prepago_web", accountIds: ["acc-flow"] }] },
    });
    expect(invoice(db, "ord-1")).toMatchObject({ status: "emitida" });
  });

  it("un motivo de Shopify de hace menos de 6 horas no se relee; pasado ese plazo, sí, y se reescribe su fecha", async () => {
    const db = world();
    addOrder(db, 1);
    db.t("invoice_order_checks").push({
      order_id: "ord-1",
      mode: "real",
      store_id: STORE,
      issuer_id: ISS,
      reason: "editado",
      detail: null,
      checked_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    });
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(report.orgs[0]).toMatchObject({ candidates: 1, cached: 1 });
    expect(writes(db)).toEqual([]);

    db.t("invoice_order_checks")[0]!.checked_at = new Date(NOW.getTime() - INVOICE_SHOPIFY_RECHECK_MS - 1).toISOString();
    const again = makeDeps();
    again.fetchOrder.mockResolvedValue({ ok: false, reason: "editado" });
    await sweep(db, again);
    expect(again.fetchOrder).toHaveBeenCalledTimes(1);
    expect(check(db, "ord-1")).toMatchObject({ reason: "editado", checked_at: NOW.toISOString() });
  });

  it("dry relee Shopify (es solo lectura) pero no escribe nada ni llama a SimpleFact", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2, { sinCuenta: true });
    db.t("order_invoices").push({ id: uuidOf(99), order_id: "ord-viejo", issuer_id: ISS, mode: "real", status: "en_duda", created_at: NOW.toISOString() });
    const deps = makeDeps();
    const report = await sweep(db, deps, { dry: true });
    expect(deps.fetchOrder).toHaveBeenCalledTimes(1);
    expect(writes(db)).toEqual([]);
    expect(db.rpcLog).toEqual([]);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(deps.listSales).not.toHaveBeenCalled();
    expect(deps.decryptToken).not.toHaveBeenCalled();
    expect(report).toMatchObject({ dry: true, errors: [] });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ would_claim: 1, emitidas: 0 });
    expect(report.orgs[0]!.reasons).toEqual({ pago_sin_cuenta: 1 });
  });
});

describe("runInvoiceSweep: la revisión de cada pedido (§35.6)", () => {
  it("escribe solo cuando el motivo cambia, en una sola escritura por organización", async () => {
    const db = world();
    addOrder(db, 1, { sinCuenta: true });
    addOrder(db, 2, { sinCuenta: true });
    await sweep(db, makeDeps());
    const upserts = writes(db, "invoice_order_checks");
    expect(upserts).toHaveLength(1);
    expect((upserts[0]!.values as unknown[]).length).toBe(2);
    expect(upserts[0]!.onConflict).toBe("order_id,mode");
    expect(check(db, "ord-1")).toMatchObject({ reason: "pago_sin_cuenta", issuer_id: null, store_id: STORE });

    db.log.length = 0;
    await sweep(db, makeDeps());
    expect(writes(db, "invoice_order_checks")).toEqual([]);

    // El pago pasa a tener cuenta y el pedido ya no es de esa revisión.
    db.t("flowcl_payment_links").push({ id: "l", order_id: "ord-1", payment_id: "pay-1" });
    db.log.length = 0;
    await sweep(db, makeDeps());
    expect(invoice(db, "ord-1")).toMatchObject({ status: "emitida" });
  });

  it("DECISIÓN: un pedido sin RUC conocido se revisa bajo el modo del RUC encendido de la organización", async () => {
    const sim = world({ mode: "simulacion" });
    addOrder(sim, 1, { sinCuenta: true });
    await sweep(sim, makeDeps());
    expect(sim.t("invoice_order_checks").map((c) => c.mode)).toEqual(["simulacion"]);

    // Uno en real y otro en simulación: «real», la pregunta que importa.
    const mixed = world({ mode: "simulacion" });
    mixed.t("invoice_issuers").push({
      ...issuerRow(mixed),
      id: "iss-b",
      ruc: RUC_OTRO,
      legal_name: "B",
      mode: "real",
      checked_ruc: RUC_OTRO,
    });
    addOrder(mixed, 1, { sinCuenta: true });
    await sweep(mixed, makeDeps());
    expect(mixed.t("invoice_order_checks").map((c) => c.mode)).toEqual(["real"]);
  });

  it("un pedido de un RUC apagado se revisa bajo el modo de la organización, con ese RUC", async () => {
    const db = world();
    db.t("invoice_issuers").push({ ...issuerRow(db), id: "iss-apagado", ruc: RUC_OTRO, legal_name: "B", mode: "apagado" });
    db.t("store_collection_accounts").find((a) => a.id === "acc-flow")!.invoice_issuer_id = "iss-apagado";
    addOrder(db, 1);
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(check(db, "ord-1", "real")).toMatchObject({ reason: "ruc_apagado", issuer_id: "iss-apagado" });
    // No es un RUC de la pasada: el motivo se cuenta en la organización.
    expect(report.orgs[0]!.reasons).toEqual({ ruc_apagado: 1 });
  });

  it("un último intento en error sin reintento pedido no se vuelve a intentar (error_previo)", async () => {
    const db = world();
    addOrder(db, 1);
    db.t("order_invoices").push({ id: "e", order_id: "ord-1", issuer_id: ISS, mode: "real", status: "error", retry_requested_at: null, created_at: PAGADO });
    const deps = makeDeps();
    await sweep(db, deps);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(check(db, "ord-1")).toMatchObject({ reason: "error_previo", issuer_id: ISS });
  });

  it("un pedido viejo que se terminó de pagar hoy también entra (aunque no esté entre los recientes del Master)", async () => {
    const db = world();
    addOrder(db, 1, { createdAt: "2026-08-01T15:00:00.000Z", inMaster: false });
    const deps = makeDeps();
    await sweep(db, deps);
    expect(invoice(db, "ord-1")).toMatchObject({ status: "emitida" });
  });

  it("los candidatos del Master: pagados completos o prepago web, de los últimos 45 días, los 300 más nuevos", async () => {
    const db = world();
    addOrder(db, 1);
    await sweep(db, makeDeps());
    const q = db.log.find((x) => x.table === "order_master" && x.cols === "order_id")!;
    expect(has(q, "in", "store_id", [STORE])).toBe(true);
    expect(has(q, "or", "payment_state.eq.pago_completo,and(payment_gateway.eq.checkout,financial_status.eq.paid)")).toBe(true);
    expect(has(q, "gte", "order_created_at", "2026-08-30T20:00:00.000Z")).toBe(true);
    expect(q.orderBy).toEqual({ col: "order_created_at", ascending: false });
    expect(q.limit).toBe(300);
  });

  it("solo las tiendas activas", async () => {
    const db = world();
    db.t("stores")[0]!.status = "paused";
    addOrder(db, 1);
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report.orgs[0]).toMatchObject({ stores: 0, candidates: 0 });
    expect(deps.fetchOrder).not.toHaveBeenCalled();
  });
});

describe("runInvoiceSweep: falla cerrada por organización", () => {
  it("si no se pueden leer los hechos, la organización no emite; otra organización sigue", async () => {
    const db = world();
    addSecondOrg(db);
    addOrder(db, 1);
    addOrder(db, 2, { store: STORE2 });
    db.failWhen.push((q) => q.table === "order_payments" && q.op === "select" && has(q, "in", "order_id", ["ord-1"]));
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(invoice(db, "ord-1")).toBeUndefined();
    expect(invoice(db, "ord-2")).toMatchObject({ status: "emitida", issuer_id: ISS2 });
    expect(report.errors, JSON.stringify(report.errors)).toHaveLength(1);
    expect(report.errors[0]).toMatch(new RegExp(`^Organización ${ORG}: .*order_payments`));
  });

  it("si no se pueden leer las revisiones previas, tampoco emite", async () => {
    const db = world();
    addOrder(db, 1);
    db.failWhen.push((q) => q.table === "invoice_order_checks" && q.op === "select");
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(db.rpcLog).toEqual([]);
    expect(report.errors).toHaveLength(1);
  });
});

describe("runInvoiceSweep: conciliación (§35.4)", () => {
  function openRow(db: Db, n: number, status: "emitiendo" | "en_duda", createdAt: string) {
    db.t("order_invoices").push({
      id: uuidOf(n),
      order_id: `ord-c${n}`,
      issuer_id: ISS,
      mode: "real",
      status,
      error: status === "en_duda" ? "SimpleFact contestó 500." : null,
      created_at: createdAt,
    });
  }
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

  it("encuentra la nota en las ventas de hoy: pasa a emitida; un emitiendo viejo que no aparece pasa a en duda", async () => {
    const db = world();
    openRow(db, 1, "en_duda", minutesAgo(60));
    openRow(db, 2, "emitiendo", minutesAgo(20));
    openRow(db, 3, "emitiendo", minutesAgo(5));
    openRow(db, 4, "en_duda", minutesAgo(90));
    const deps = makeDeps();
    deps.listSales.mockResolvedValue({
      http: 200,
      body: { data: [sale(7, RUC_GF, `Pedido #KP1 · ${invoiceNoteRef(uuidOf(1))}`), sale(8, RUC_GF, "otra venta")] },
    });
    const report = await sweep(db, deps);

    expect(deps.listSales).toHaveBeenCalledTimes(1);
    expect(deps.listSales).toHaveBeenCalledWith({ subdomain: "grupogf", token: TOKEN }, { shortdate: "today", pageSize: 100, page: 1 });
    const byId = (n: number) => db.t("order_invoices").find((r) => r.id === uuidOf(n))!;
    expect(byId(1)).toMatchObject({ status: "emitida", simplefact_id: 7, serie: "B001", correlative: "7", ruc_mismatch: false, error: null });
    expect(byId(2)).toMatchObject({ status: "en_duda", error: INVOICE_NOT_FOUND_ERROR });
    // Reciente: su POST puede estar en vuelo.
    expect(byId(3)).toMatchObject({ status: "emitiendo" });
    // En duda y no aparece: lo ve una persona.
    expect(byId(4)).toMatchObject({ status: "en_duda", error: "SimpleFact contestó 500." });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ conciliadas: 1, en_duda: 1 });
    expect(report.errors).toEqual([]);
  });

  it("lo de ayer se busca en ayer y en hoy, y pagina de a 100 hasta la última", async () => {
    const db = world();
    // 23:00 de Lima del 13-10.
    openRow(db, 1, "en_duda", "2026-10-14T04:00:00.000Z");
    const deps = makeDeps();
    const filler = Array.from({ length: 100 }, (_, i) => sale(1000 + i));
    deps.listSales.mockImplementation(async (_conn, query) => {
      if (query.shortdate === "today" && query.page === 1) return { http: 200, body: { data: filler } };
      if (query.shortdate === "today" && query.page === 2) return { http: 200, body: { data: [] } };
      return { http: 200, body: { data: [sale(5, RUC_GF, `Pedido #KP9 · ${invoiceNoteRef(uuidOf(1))}`)] } };
    });
    await sweep(db, deps);
    expect(deps.listSales.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { shortdate: "today", pageSize: 100, page: 1 },
      { shortdate: "today", pageSize: 100, page: 2 },
      { shortdate: "yesterday", pageSize: 100, page: 1 },
    ]);
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "emitida", simplefact_id: 5 });
  });

  it("no mira lo de antes de ayer: eso ya es de una persona", async () => {
    const db = world();
    openRow(db, 1, "emitiendo", "2026-10-11T20:00:00.000Z");
    const deps = makeDeps();
    await sweep(db, deps);
    expect(deps.listSales).not.toHaveBeenCalled();
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "emitiendo" });
  });

  it.each([
    ["sin respuesta", { http: null, body: null, error: "timeout" }],
    ["un 500", { http: 500, body: { message: "Server Error" } }],
    ["un 200 que no es la lista", { http: 200, body: { raw: "<html>portal</html>" } }],
  ] as [string, SimplefactHttp][])("si la lista no se puede leer (%s), no toca nada y lo reporta", async (_label, res) => {
    const db = world();
    openRow(db, 1, "emitiendo", minutesAgo(30));
    openRow(db, 2, "en_duda", minutesAgo(30));
    const deps = makeDeps();
    deps.listSales.mockResolvedValue(res);
    const report = await sweep(db, deps);
    expect(db.t("order_invoices").map((r) => r.status)).toEqual(["emitiendo", "en_duda"]);
    expect(writes(db, "order_invoices")).toEqual([]);
    expect(report.errors.join(" ")).toMatch(/lista de ventas/);
  });

  it("más de 500 ventas en un día: lo que aparece se concilia, lo que no, no se concluye", async () => {
    const db = world();
    openRow(db, 1, "emitiendo", minutesAgo(30));
    openRow(db, 2, "emitiendo", minutesAgo(30));
    const deps = makeDeps();
    deps.listSales.mockImplementation(async (_c, q) => ({
      http: 200,
      body: {
        data: Array.from({ length: 100 }, (_, i) =>
          q.page === 3 && i === 0 ? sale(77, RUC_GF, invoiceNoteRef(uuidOf(1))) : sale(q.page! * 1000 + i),
        ),
      },
    }));
    await sweep(db, deps);
    expect(deps.listSales).toHaveBeenCalledTimes(5);
    expect(db.t("order_invoices").map((r) => r.status)).toEqual(["emitida", "emitiendo"]);
  });

  it("no concilia un RUC en simulación", async () => {
    const db = world({ mode: "simulacion" });
    openRow(db, 1, "en_duda", minutesAgo(30));
    const deps = makeDeps();
    await sweep(db, deps);
    expect(deps.listSales).not.toHaveBeenCalled();
  });
});

describe("runInvoiceSweep: el token y la clienta no salen (§35.6)", () => {
  it("ni en el reporte ni en la consola, con emisiones, errores y conciliaciones", async () => {
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const db = world();
    addSecondOrg(db);
    addOrder(db, 1);
    addOrder(db, 2, { store: STORE2 });
    addOrder(db, 3, { sinCuenta: true });
    db.t("order_invoices").push({ id: uuidOf(90), order_id: "ord-x", issuer_id: ISS, mode: "real", status: "en_duda", created_at: NOW.toISOString() });
    const deps = makeDeps();
    deps.createSale
      .mockResolvedValueOnce(created(1))
      .mockResolvedValueOnce({ http: 401, body: { message: `Unauthenticated ${TOKEN}` } });
    deps.listSales.mockResolvedValue({ http: 500, body: null });
    const report = await sweep(db, deps);

    const text = JSON.stringify(report);
    for (const secret of [TOKEN, TOKEN_ENC, CLIENTA, "987654321"]) {
      expect(text).not.toContain(secret);
      for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
    }
    expect(deps.createSale).toHaveBeenCalledTimes(2);
    // Tampoco en lo que se guarda: la respuesta, el error, el motivo del RUC apagado.
    expect(JSON.stringify(db.t("order_invoices"))).not.toContain(TOKEN);
    expect(JSON.stringify(db.t("invoice_issuers"))).not.toContain(TOKEN);
    expect(issuerRow(db, ISS2)).toMatchObject({ mode: "apagado" });
    expect(String(issuerRow(db, ISS2).check_error)).toContain("[token]");
  });
});
