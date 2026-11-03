// Comprobantes electrónicos por RUC — la base y el barrido
// (lib/invoicing/server.ts, MOM §35).
//
// Aquí no hay red ni Supabase. La base es un doble en memoria que filtra de
// verdad (eq, in, gte, or…), anota cada consulta y aplica las dos reglas de la
// base que importan para no emitir de más: `invoice_claim` (uno por pedido, el
// tope del día, el modo; 0257, la versión de la 0260 y, con `p_mode` y
// `p_created_by`, la de la 0261) y el candado de `order_invoices` (los estados
// solo avanzan). Shopify y SimpleFact son dobles inyectados: nunca se llama a nada.
//
// Lo que se fija es lo que no se puede deshacer después: una boleta enviada a
// SUNAT no se borra. El turno va ANTES del POST, un envío sin respuesta queda
// en duda y no se repite, un token rechazado apaga el RUC, una lectura que
// falla no emite, y ni el token ni la clienta salen en el reporte o el log.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INVOICE_MAX_PER_RUN,
  LIVE_REAL_STATUSES,
  buildSalePayload,
  invoiceNoteRef,
  type InvoiceItem,
} from "@/lib/invoicing/rules";
import type { InvoiceOrderRead } from "@/lib/invoicing/shopify-order";
import { WOO_PREPAID_UNCONFIRMED_DETAIL } from "@/lib/invoicing/woocommerce-order";
import { CHECKOUT_GATEWAYS } from "@/lib/payment-gateway";
import type { SimplefactHttp } from "@/lib/invoicing/simplefact";
import {
  INVOICE_CLAIM_BACKFILL_MIGRATION,
  INVOICE_CLAIM_MODE_MIGRATION,
  INVOICE_MIGRATION_OBJECTS,
  INVOICE_NOT_FOUND_ERROR,
  INVOICE_SHOPIFY_RECHECK_MS,
  INVOICE_SWEEP_MAX_CANDIDATES,
  INVOICE_UNRECONCILED_BATCH,
  InvoiceMigrationMissingError,
  SHOPIFY_LEVEL_REASONS,
  emitInvoiceNow,
  invoiceEmitAllowedHere,
  invoiceEmitNowReadiness,
  invoiceExistingFrom,
  invoiceUnreconciledError,
  isInvoiceMigrationMissing,
  loadInvoiceEmitNowOffers,
  loadInvoiceIssuers,
  loadInvoiceOrderFacts,
  runInvoiceSweep,
  shopifyBlockedReasons,
  type InvoiceCheckRow,
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

/** El candado de `order_invoices` (0257, vigente en la 0260): los estados solo avanzan y lo enviado no cambia. */
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

/** El piso de la 0269: `timestamptz '2026-10-01 00:00:00-05'`. */
const PISO_0269 = "2026-10-01T05:00:00.000Z";

/** Lo que contesta la base cuando falta la 0257 o la 0260: la tabla o la función no existe. */
const MISSING = {
  "42P01": (name: string) => `relation "public.${name}" does not exist`,
  "42883": (name: string) => `function public.${name}() does not exist`,
  PGRST205: (name: string) => `Could not find the table 'public.${name}' in the schema cache`,
  PGRST202: (name: string) => `Could not find the function public.${name} in the schema cache`,
} as const;
type MissingCode = keyof typeof MISSING;

function fakeDb(initialNow: Date) {
  const tables: Record<string, Row[]> = {};
  const log: Q[] = [];
  const rpcLog: { fn: string; args: Record<string, unknown> }[] = [];
  const failWhen: Array<(q: Q) => boolean> = [];
  /** Como `failWhen`, con el error exacto de la base (su `code`): una columna que no existe. */
  const errorWhen: Array<(q: Q) => { code: string; message: string } | null> = [];
  /** Tablas y funciones que «no existen» todavía, con el código que contesta la base. */
  const missing = new Map<string, MissingCode>();
  const state = {
    rpcError: null as string | null,
    claimOverride: null as null | ((args: Record<string, unknown>) => unknown),
    candidatesError: null as string | null,
    /** La base no tiene la 0261: el turno no tiene `p_mode` ni `p_created_by`. */
    sin0261: false,
    /** La base no tiene la 0269: el turno no tiene `p_backfill` (sigue el de once argumentos). */
    sin0269: false,
  };
  // El reloj de la base (`now()`): `sweep` lo pone en el `now` de la pasada.
  const clock = { now: initialNow };
  const t = (name: string) => (tables[name] ??= []);
  const missingError = (name: string) => {
    const code = missing.get(name)!;
    return { data: null, error: { code, message: MISSING[code](name) } };
  };

  const exec = (q: Q): { data: unknown; error: { message: string; code?: string } | null } => {
    log.push(q);
    if (missing.has(q.table)) return missingError(q.table);
    if (failWhen.some((f) => f(q))) return { data: null, error: { message: `falla simulada en ${q.table}` } };
    for (const f of errorWhen) {
      const error = f(q);
      if (error) return { data: null, error };
    }
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

  /** `invoice_candidates` (0260, §4), con los mismos filtros y el mismo orden. */
  const candidates = (a: Record<string, unknown>): { order_id: string }[] => {
    if (!["simulacion", "real"].includes(a.p_mode as string) || !a.p_since) return [];
    const now = clock.now;
    const stores = new Set(
      t("stores")
        .filter((s) => s.org_id === a.p_org && s.status === "active" && (!a.p_store || s.id === a.p_store))
        .map((s) => s.id),
    );
    const windowStart = new Date(now.getTime() - 60 * 86_400_000).toISOString();
    const recheck = new Date(now.getTime() - 6 * 3_600_000).toISOString();
    const blocked = new Set((a.p_blocked as string[] | null) ?? []);
    const prepaid = (m: Row) => m.payment_gateway === "checkout" && m.financial_status === "paid";
    const mine = (m: Row) => t("order_invoices").filter((i) => i.order_id === m.order_id);
    return t("order_master")
      .filter((m) => stores.has(m.store_id))
      .filter((m) => m.payment_state === "pago_completo" || prepaid(m))
      .filter((m) => cmp(m.order_created_at, windowStart) >= 0)
      .filter((m) => !mine(m).some((i) => i.mode === "real" && LIVE.includes(i.status as string)))
      .filter((m) => a.p_mode === "real" || !mine(m).some((i) => i.mode === "simulacion"))
      // En real, un error sin reintento pedido: el turno diría `error_previo`.
      .filter((m) => a.p_mode !== "real" || !mine(m).some((i) => i.mode === "real" && i.status === "error" && !i.retry_requested_at))
      .filter(
        (m) =>
          !t("invoice_order_checks").some(
            (c) => c.order_id === m.order_id && c.mode === a.p_mode && blocked.has(c.reason as string) && cmp(c.checked_at, recheck) > 0,
          ),
      )
      .filter(
        (m) =>
          t("order_payments").some(
            (p) => p.order_id === m.order_id && p.validation_status === "validado" && !!p.registered_at && cmp(p.registered_at, a.p_since) >= 0,
          ) ||
          (prepaid(m) && cmp(m.order_created_at, a.p_since) >= 0),
      )
      .sort((x, y) => cmp(y.order_created_at, x.order_created_at) || String(x.order_id).localeCompare(String(y.order_id)))
      .slice(0, Math.max(0, Number(a.p_limit ?? 0)))
      .map((m) => ({ order_id: m.order_id as string }));
  };

  /**
   * `invoice_claim` (0260 §3, con lo que agrega la 0261), con las mismas
   * revisiones y en el mismo orden. La 0261: `p_mode` null es el modo del RUC
   * (en «Manual», una simulación); `real` solo si el RUC está en «Real» o
   * «Manual», `simulacion` solo si está en «Simulación» o «Manual», y si no,
   * `modo_distinto`. Lo demás se revisa con el modo de la FILA (el tope del día
   * cuenta las filas de ese modo), y `created_by` es `p_created_by`.
   *
   * La 0269: con `p_backfill`, una fila real de un RUC en «Manual» pedida por
   * alguien deja pasar lo pagado antes de «Emitir desde», si «Emitir desde» ya
   * llegó (`emit_from <= now()`, con el reloj de la base) y las dos fechas y
   * el primer dinero (la más temprana entre `paid_at` y `registered_at` de los
   * pagos validados; sin ellos, la fecha del pedido) son desde el 01/10/2026
   * 00:00 de Lima; la base del comprobante lo anota.
   */
  const claim = (a: Record<string, unknown>): unknown => {
    const now = clock.now;
    const store = t("stores").find((s) => s.id === a.p_store && s.status === "active");
    if (!store) return { reason: "tienda" };
    const order = t("orders").find((o) => o.id === a.p_order && o.store_id === a.p_store);
    if (!order) return { reason: "pedido" };
    if (order.cancelled_at) return { reason: "anulado" };
    if (Number(order.total_refunded ?? 0) !== 0) return { reason: "reembolsado" };
    if (String(order.currency ?? "").toUpperCase() !== "PEN") return { reason: "moneda" };
    // Cuándo quedó pagado, con los pagos de la base: todos los vivos validados y
    // el último registrado; sin pagos vivos, la fecha del pedido.
    const live = t("order_payments").filter((p) => p.order_id === a.p_order && p.validation_status !== "rechazado");
    if (live.some((p) => p.validation_status !== "validado")) return { reason: "pagos_en_revision" };
    const registered = live.map((p) => (p.registered_at ?? null) as string | null);
    const paid: string | null = !live.length
      ? ((order.processed_at ?? order.created_at ?? null) as string | null)
      : registered.includes(null)
        ? null
        : registered.reduce((x, y) => (cmp(y, x) > 0 ? y : x));
    const iss = t("invoice_issuers").find((i) => i.id === a.p_issuer);
    if (!iss || iss.org_id !== store.org_id) return { reason: "ruc_ajeno" };
    if (iss.mode === "apagado") return { reason: "ruc_apagado" };
    const asked = (a.p_mode ?? null) as string | null;
    if (asked !== null && !(asked === "real" ? ["real", "manual"] : asked === "simulacion" ? ["simulacion", "manual"] : []).includes(iss.mode as string)) {
      return { reason: "modo_distinto" };
    }
    const rowMode = asked ?? (iss.mode === "real" ? "real" : "simulacion");
    const total = Number(a.p_total);
    if (!(total > 0)) return { reason: "monto_cero" };
    if (total > 700) return { reason: "monto_mayor_700" };
    if (Math.abs(Number(order.total_amount) - total) >= 0.005) return { reason: "total_distinto" };
    if (!iss.emit_from || !a.p_paid_at || !paid) return { reason: "antes_de_inicio" };
    const before = cmp(a.p_paid_at, iss.emit_from) < 0 || cmp(paid, iss.emit_from) < 0;
    // El primer dinero (0269): `least(coalesce(paid_at, registered_at), registered_at)`
    // de cada pago validado, el menor; sin pagos validados, la fecha del pedido.
    const first: string | null = !live.length
      ? paid
      : live
          .map((p) => {
            const reg = p.registered_at as string;
            const rec = (p.paid_at ?? null) as string | null;
            return rec !== null && cmp(rec, reg) < 0 ? rec : reg;
          })
          .reduce((x, y) => (cmp(y, x) < 0 ? y : x));
    const backfill =
      a.p_backfill === true &&
      rowMode === "real" &&
      iss.mode === "manual" &&
      !!a.p_created_by &&
      cmp(iss.emit_from, now.toISOString()) <= 0 &&
      cmp(a.p_paid_at, PISO_0269) >= 0 &&
      cmp(paid, PISO_0269) >= 0 &&
      first !== null &&
      cmp(first, PISO_0269) >= 0;
    if (before && !backfill) return { reason: "antes_de_inicio" };
    if (!a.p_request || typeof a.p_request !== "object") return { reason: "sin_boleta" };
    const mine = t("order_invoices").filter((r) => r.order_id === a.p_order);
    if (mine.some((r) => r.mode === "real" && LIVE.includes(r.status as string))) return { reason: "ya_tiene" };
    if (rowMode === "simulacion") {
      if (mine.some((r) => r.mode === "simulacion")) return { reason: "ya_simulado" };
    } else {
      if (!iss.token_enc || iss.checked_ruc !== iss.ruc) return { reason: "sin_conexion" };
      if (mine.some((r) => r.mode === "real" && r.status === "error" && !r.retry_requested_at)) return { reason: "error_previo" };
    }
    const dayStart = `${new Date(now.getTime() - 5 * 3_600_000).toISOString().slice(0, 10)}T05:00:00.000Z`;
    const used = t("order_invoices").filter(
      (r) =>
        r.issuer_id === a.p_issuer &&
        r.mode === rowMode &&
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
      mode: rowMode,
      status: rowMode === "real" ? "emitiendo" : "simulada",
      order_name: a.p_order_name,
      total,
      paid_at: a.p_paid_at,
      basis: before ? { ...(a.p_basis as Row), pagado_antes_de_emitir_desde: true } : a.p_basis,
      request: a.p_request,
      response: null,
      http_status: null,
      error: null,
      retry_requested_at: null,
      created_by: a.p_created_by ?? null,
      created_at: now.toISOString(),
    });
    return { id: a.p_id, mode: rowMode };
  };

  const admin = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcLog.push({ fn, args });
      if (missing.has(fn)) return missingError(fn);
      if (fn === "invoice_candidates") {
        if (state.candidatesError) return { data: null, error: { message: state.candidatesError } };
        return { data: candidates(args), error: null };
      }
      if (fn !== "invoice_claim") throw new Error(`rpc inesperada: ${fn}`);
      // Sin la 0261, PostgREST no encuentra la firma con los parámetros nuevos.
      if (state.sin0261 && ("p_mode" in args || "p_created_by" in args)) {
        return {
          data: null,
          error: {
            code: "PGRST202",
            message: `Could not find the function public.invoice_claim(${Object.keys(args).sort().join(", ")}) in the schema cache`,
            hint: "Perhaps you meant to call the function public.invoice_claim(p_basis, p_id, p_issuer, p_order, p_order_name, p_paid_at, p_request, p_store, p_total)",
          },
        };
      }
      // Sin la 0269, tampoco la firma con `p_backfill`.
      if (state.sin0269 && "p_backfill" in args) {
        return {
          data: null,
          error: {
            code: "PGRST202",
            message: `Could not find the function public.invoice_claim(${Object.keys(args).sort().join(", ")}) in the schema cache`,
          },
        };
      }
      if (state.rpcError) return { data: null, error: { message: state.rpcError } };
      return { data: state.claimOverride ? state.claimOverride(args) : claim(args), error: null };
    },
  } as unknown as SupabaseClient;

  return { admin, tables, t, log, rpcLog, failWhen, errorWhen, state, missing, clock };
}

type Db = ReturnType<typeof fakeDb>;
const writes = (db: Db, table?: string) => db.log.filter((q) => q.op !== "select" && (!table || q.table === table));
/** Los turnos pedidos (`invoice_claim`), sin las lecturas de candidatos. */
const claims = (db: Db) => db.rpcLog.filter((r) => r.fn === "invoice_claim");
const candidateCalls = (db: Db) => db.rpcLog.filter((r) => r.fn === "invoice_candidates");
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

function world(opts: { mode?: "apagado" | "simulacion" | "manual" | "real"; dailyLimit?: number } = {}): Db {
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
    checked_at: "2026-10-14T06:00:00.000Z",
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
  /** Cuándo entró el pago a Kapta: lo que decide «Emitir desde» (§35.3, condición 8). */
  registeredAt?: string;
  /** La fecha del comprobante (`paid_at`): solo cuenta para el piso de lo pagado antes de «Emitir desde». */
  receiptAt?: string | null;
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
      registered_at: o.registeredAt ?? PAGADO,
      paid_at: o.receiptAt ?? null,
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
      ? { financialStatus: "PAID", gatewayNames: [CHECKOUT_GATEWAYS[0]!], paidCents: totalCents, otherPaidCents: 0, netPaymentCents: totalCents, outstandingCents: 0 }
      : { financialStatus: "PENDING", gatewayNames: ["manual"], paidCents: 0, otherPaidCents: 0, netPaymentCents: 0, outstandingCents: totalCents },
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

const sweep = (db: Db, deps: ReturnType<typeof makeDeps>, opts: { dry?: boolean; storeId?: string } = {}) => {
  // La base corre con el mismo reloj que la pasada.
  db.clock.now = deps.now();
  return runInvoiceSweep(db.admin, { ...opts, deps });
};

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
        registered_at: "2026-10-14T15:30:00.000Z",
        paid_at: "2026-10-14T15:10:00.000Z",
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
        registered_at: "2026-10-14T12:00:00.000Z",
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
        registeredAt: PAGADO,
        // Sin fecha de comprobante en la base: null, no se inventa.
        paidAt: null,
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
        registeredAt: "2026-10-14T15:30:00.000Z",
        // La fecha del comprobante (`paid_at`), tal cual: el piso de la 0269.
        paidAt: "2026-10-14T15:10:00.000Z",
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
        registeredAt: "2026-10-14T12:00:00.000Z",
        paidAt: null,
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
    expect(claims(db)).toEqual([
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

  it("la segunda pasada no simula dos veces el mismo pedido: la base ya no lo devuelve", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    await sweep(db, makeDeps());
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(db.t("order_invoices")).toHaveLength(1);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toHaveLength(1);
    expect(report.orgs[0]).toMatchObject({ candidates: 0, reasons: {} });
  });

  it("si la base igual lo devolviera (otra pasada lo simuló entre la lista y los hechos), la regla dice ya_simulado", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    db.t("order_invoices").push({ id: "sim", order_id: "ord-1", issuer_id: ISS, mode: "simulacion", status: "simulada", created_at: NOW.toISOString() });
    // La lista se leyó antes de que existiera la simulación.
    const rpc = db.admin.rpc.bind(db.admin);
    (db.admin as unknown as { rpc: unknown }).rpc = async (fn: string, args: Record<string, unknown>) =>
      fn === "invoice_candidates" ? { data: [{ order_id: "ord-1" }], error: null } : rpc(fn, args);
    const deps = makeDeps();
    const report = await sweep(db, deps);
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
      expect(claims(db)).toHaveLength(1);
      expect(invoice(db, "ord-1")).toMatchObject({ status: "emitiendo" });
      return created(812);
    });
    const report = await sweep(db, deps);

    expect(deps.createSale).toHaveBeenCalledTimes(1);
    const [conn, payload] = deps.createSale.mock.calls[0] as unknown as [{ subdomain: string; token: string }, unknown];
    expect(conn).toEqual({ subdomain: "grupogf", token: TOKEN });
    expect(payload).toEqual(claims(db)[0]!.args.p_request);
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
    expect(claims(db)).toEqual([]);
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
    // El pedido en duda no vuelve a salir (la base ya no lo devuelve); el otro sí.
    expect(calls).toHaveLength(1);
    expect(calls[0]![1].notes).toContain("#KP1002");
    expect(db.t("order_invoices").filter((r) => r.order_id === "ord-1")).toHaveLength(1);
    expect(next.fetchOrder).toHaveBeenCalledTimes(1);
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
    expect(claims(db)).toHaveLength(1);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(check(db, "ord-1")).toMatchObject({ reason: "ya_tiene", issuer_id: ISS });
    expect(report.orgs[0]!.issuers[0]!.reasons).toEqual({ ya_tiene: 1 });
  });

  it("el turno mira los pagos de la base: uno nuevo sin validar da pagos_en_revision y no se llama; el lote sigue", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    const deps = makeDeps();
    deps.fetchOrder.mockImplementation(async (input) => {
      // Mientras se leía Shopify, entró un comprobante que nadie revisó todavía.
      if (input.shopifyOrderId === "shp-2") {
        db.t("order_payments").push({ id: "pay-2b", order_id: "ord-2", store_id: STORE, kind: "diferencia", amount: 1, validation_status: "pendiente_revision", registered_at: NOW.toISOString(), vision: {} });
      }
      return okRead(input.shopifyOrderId);
    });
    const report = await sweep(db, deps);
    // El turno lo pidió con la fecha de los hechos que leyó: la base dijo que no.
    expect(claims(db).find((c) => c.args.p_order === "ord-2")?.args.p_paid_at).toBe(PAGADO);
    expect(invoice(db, "ord-2")).toBeUndefined();
    expect(check(db, "ord-2")).toMatchObject({ reason: "pagos_en_revision", issuer_id: ISS });
    // Es del pedido, no del RUC: el otro pedido sale igual.
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(invoice(db, "ord-1")).toMatchObject({ status: "emitida" });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ emitidas: 1, stopped: null, reasons: { pagos_en_revision: 1 } });
    expect(report.errors).toEqual([]);
  });

  it("el turno mira los pagos de la base: si su último pago vivo es de antes de «Emitir desde», antes_de_inicio y no se llama", async () => {
    const db = world();
    addOrder(db, 1);
    const deps = makeDeps();
    deps.fetchOrder.mockImplementation(async (input) => {
      // La fecha que llegó al turno (PAGADO) ya no es la de la base.
      db.t("order_payments").find((p) => p.id === "pay-1")!.registered_at = "2026-10-14T04:59:59.000Z";
      return okRead(input.shopifyOrderId);
    });
    const report = await sweep(db, deps);
    expect(claims(db)[0]?.args.p_paid_at).toBe(PAGADO);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(db.t("order_invoices")).toEqual([]);
    expect(check(db, "ord-1")).toMatchObject({ reason: "antes_de_inicio", issuer_id: ISS });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ stopped: null, reasons: { antes_de_inicio: 1 } });
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
    const again = await sweep(db, next);
    expect(next.createSale).not.toHaveBeenCalled();
    // La base ya no lo devuelve en real (ni el emitido): espera que una persona
    // pida reintentar, sin ocupar un lugar ni releerse en Shopify.
    expect(next.fetchOrder).not.toHaveBeenCalled();
    expect(again.orgs[0]!.candidates).toBe(0);
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
    // La prueba de conexión se borra: volver a Real exige probar de nuevo.
    expect(issuerRow(db)).toMatchObject({ mode: "apagado", checked_ruc: null, checked_at: null });
    expect(issuerRow(db).check_error).toMatch(/Token rechazado \(401\)/);
    expect(db.t("order_invoices")).toHaveLength(1);
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "error", http_status: 401 });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ errores: 1, stopped: "apagado", pendientes: 2 });
    expect(report.errors.join(" ")).toMatch(/apagado/);
    // Con el token rechazado no se concilia.
    expect(deps.listSales).not.toHaveBeenCalled();
  });

  it.each([403, 404, 405])("%s: también apaga el RUC y borra su prueba de conexión", async (http) => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue({ http, body: { message: "No." } });
    const report = await sweep(db, deps);
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(issuerRow(db)).toMatchObject({ mode: "apagado", checked_ruc: null, checked_at: null });
    expect(String(issuerRow(db).check_error)).toContain(`(${http})`);
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ stopped: "apagado", pendientes: 1 });
  });

  it("el RUC apagado por la pasada no puede volver a Real sin otra prueba: la base lo exige", async () => {
    // Lo que hace invoice_issuers_real_ready (0257) con la fila que dejó el barrido.
    const realReady = (r: Row) => !!r.token_enc && !!r.emit_from && r.checked_ruc !== null && r.checked_ruc === r.ruc;
    const db = world();
    addOrder(db, 1);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue({ http: 401, body: { message: "Unauthenticated." } });
    await sweep(db, deps);
    expect(realReady(issuerRow(db))).toBe(false);
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
    expect(issuerRow(db)).toMatchObject({ mode: "apagado", checked_ruc: null, checked_at: null });
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
    expect(claims(db)).toHaveLength(1);
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
    expect(claims(db)).toHaveLength(2);
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
    expect(claims(db)).toHaveLength(1);
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
    expect(claims(db)).toHaveLength(INVOICE_MAX_PER_RUN);
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
    expect(claims(db)).toEqual([]);
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
    expect(claims(db)).toEqual([]);
    expect(check(db, "ord-1")).toMatchObject({ reason: "total_distinto", detail: "Shopify dice S/ 149.90; Kapta, S/ 150.00." });
  });

  it("un detalle que no cuadra no arma boleta", async () => {
    const db = world();
    addOrder(db, 1);
    const deps = makeDeps();
    const read = okRead("shp-1") as Extract<InvoiceOrderRead, { ok: true }>;
    deps.fetchOrder.mockResolvedValue({ ...read, items: [{ code: "A", name: "A", qty: 1, priceCents: 14_000 }] });
    await sweep(db, deps);
    expect(claims(db)).toEqual([]);
    expect(check(db, "ord-1")).toMatchObject({ reason: "no_cuadra" });
  });

  it("prepago web: sin la confirmación de Shopify no se emite; con ella, sí", async () => {
    const db = world();
    addOrder(db, 1, { prepaid: true });
    const deps = makeDeps();
    await sweep(db, deps);
    expect(claims(db)).toEqual([]);
    expect(check(db, "ord-1")).toMatchObject({ reason: "pago_web_no_confirmado" });

    // Pasadas las 6 horas, se relee y Shopify ya lo confirma.
    const later = new Date(NOW.getTime() + INVOICE_SHOPIFY_RECHECK_MS + 60_000);
    const next = makeDeps({ now: () => later });
    next.fetchOrder.mockResolvedValue(okRead("shp-1", 15_000, true));
    await sweep(db, next);
    expect(claims(db)).toHaveLength(1);
    expect(claims(db)[0]!.args).toMatchObject({
      p_paid_at: FECHA_PEDIDO,
      p_basis: { prepaid: true, payments: [{ id: null, source: "prepago_web", accountIds: ["acc-flow"] }] },
    });
    expect(invoice(db, "ord-1")).toMatchObject({ status: "emitida" });
  });

  it("un motivo de Shopify de hace menos de 6 horas: la base no lo devuelve; pasado ese plazo, se relee y se reescribe su fecha", async () => {
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
    expect(report.orgs[0]).toMatchObject({ candidates: 0, cached: 0 });
    expect(writes(db)).toEqual([]);

    db.t("invoice_order_checks")[0]!.checked_at = new Date(NOW.getTime() - INVOICE_SHOPIFY_RECHECK_MS - 1).toISOString();
    const again = makeDeps();
    again.fetchOrder.mockResolvedValue({ ok: false, reason: "editado" });
    await sweep(db, again);
    expect(again.fetchOrder).toHaveBeenCalledTimes(1);
    expect(check(db, "ord-1")).toMatchObject({ reason: "editado", checked_at: NOW.toISOString() });
  });

  it("bloqueado por Shopify hace poco bajo el OTRO modo: la base lo devuelve, pero tampoco se relee", async () => {
    // Un motivo de Shopify es del pedido en Shopify, no del modo.
    const db = world();
    addOrder(db, 1);
    db.t("invoice_order_checks").push({
      order_id: "ord-1",
      mode: "simulacion",
      store_id: STORE,
      issuer_id: ISS,
      reason: "propina",
      detail: null,
      checked_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    });
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
    expect(report.orgs[0]).toMatchObject({ candidates: 1, cached: 1 });
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
    expect(claims(db)).toEqual([]);
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

  it("un error real sin reintento pedido ya no es candidato en real: no ocupa lugar ni se relee", async () => {
    const db = world();
    addOrder(db, 1);
    db.t("order_invoices").push({ id: "e", order_id: "ord-1", issuer_id: ISS, mode: "real", status: "error", retry_requested_at: null, created_at: PAGADO });
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report.orgs[0]).toMatchObject({ candidates: 0, lleno: {} });
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
    // Pedido el reintento, vuelve a entrar y sale.
    db.t("order_invoices")[0]!.retry_requested_at = NOW.toISOString();
    await sweep(db, deps);
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(db.t("order_invoices").map((r) => r.status)).toEqual(["error", "emitida"]);
  });

  it("si la base igual lo devolviera (el error llegó entre la lista y los hechos), la regla dice error_previo", async () => {
    const db = world();
    addOrder(db, 1);
    db.t("order_invoices").push({ id: "e", order_id: "ord-1", issuer_id: ISS, mode: "real", status: "error", retry_requested_at: null, created_at: PAGADO });
    const rpc = db.admin.rpc.bind(db.admin);
    (db.admin as unknown as { rpc: unknown }).rpc = async (fn: string, args: Record<string, unknown>) =>
      fn === "invoice_candidates" ? { data: [{ order_id: "ord-1" }], error: null } : rpc(fn, args);
    const deps = makeDeps();
    await sweep(db, deps);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(check(db, "ord-1")).toMatchObject({ reason: "error_previo", issuer_id: ISS });
  });

  it("en simulación, un error real no lo saca de la lista: el turno de simulación no lo mira", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    db.t("order_invoices").push({ id: "e", order_id: "ord-1", issuer_id: ISS, mode: "real", status: "error", retry_requested_at: null, created_at: PAGADO });
    const report = await sweep(db, makeDeps());
    expect(report.orgs[0]!.candidates).toBe(1);
    expect(db.t("order_invoices").find((r) => r.mode === "simulacion")).toMatchObject({ status: "simulada" });
  });

  it(`una lista que llega a ${INVOICE_SWEEP_MAX_CANDIDATES} queda marcada «lleno» en su modo; una de uno menos, no`, async () => {
    const run = async (sizes: Partial<Record<string, number>>) => {
      const db = world();
      db.t("invoice_issuers").push({ ...issuerRow(db), id: "iss-sim", ruc: "20600000013", legal_name: "Z", mode: "simulacion" });
      const rpc = db.admin.rpc.bind(db.admin);
      (db.admin as unknown as { rpc: unknown }).rpc = async (fn: string, args: Record<string, unknown>) =>
        fn === "invoice_candidates"
          ? {
              data: Array.from({ length: sizes[args.p_mode as string] ?? 0 }, (_, i) => ({ order_id: `${String(args.p_mode)}-${i}` })),
              error: null,
            }
          : rpc(fn, args);
      return sweep(db, makeDeps());
    };
    const max = INVOICE_SWEEP_MAX_CANDIDATES;
    const soloReal = (await run({ real: max, simulacion: max - 1 })).orgs[0]!;
    expect(soloReal.candidates).toBe(2 * max - 1);
    expect(soloReal.lleno).toEqual({ real: true });
    expect((await run({ real: max - 1, simulacion: max })).orgs[0]!.lleno).toEqual({ simulacion: true });
    expect((await run({ real: max, simulacion: max })).orgs[0]!.lleno).toEqual({ real: true, simulacion: true });
    const ninguno = await run({ real: max - 1, simulacion: 0 });
    expect(ninguno.orgs[0]!.lleno).toEqual({});
    // No es un error: el cron no se pone rojo por esto.
    expect(ninguno.errors).toEqual([]);
    expect((await run({ real: max })).errors).toEqual([]);
  });

  it("un pedido de hace 50 días que se terminó de pagar hoy entra, aunque haya cientos más nuevos ya resueltos", async () => {
    // Antes eran los 300 más nuevos del Master (45 días) y los 300 pagos
    // validados más nuevos: con ~26 pagados al día, ~11 días, y los pedidos ya
    // emitidos ocupaban los lugares. Este pedido no entraba nunca.
    const db = world();
    for (let i = 1; i <= 320; i += 1) {
      const id = addOrder(db, 100 + i, { registeredAt: "2026-10-14T16:00:00.000Z", validatedAt: "2026-10-14T16:00:00.000Z" });
      db.t("order_invoices").push({ id: `ya-${i}`, order_id: id, issuer_id: ISS, mode: "real", status: "emitida", created_at: "2026-10-13T16:00:00.000Z" });
    }
    addOrder(db, 1, { createdAt: "2026-08-25T15:00:00.000Z" });
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report.orgs[0]!.candidates).toBe(1);
    expect(deps.fetchOrder).toHaveBeenCalledTimes(1);
    expect(invoice(db, "ord-1")).toMatchObject({ status: "emitida" });
  });

  it("pide los candidatos a la base: una vez por modo encendido, con el «Emitir desde» más antiguo de ese modo", async () => {
    const db = world();
    const base = issuerRow(db);
    db.t("invoice_issuers").push(
      { ...base, id: "iss-real-2", ruc: RUC_OTRO, legal_name: "B", emit_from: "2026-10-12T05:00:00.000Z", checked_ruc: RUC_OTRO },
      { ...base, id: "iss-sim", ruc: "20600000013", legal_name: "C", mode: "simulacion", emit_from: "2026-10-10T05:00:00.000Z" },
      // Sin fecha no emite: no cuenta para el «desde».
      { ...base, id: "iss-sim-sin-fecha", ruc: "20600000021", legal_name: "D", mode: "simulacion", emit_from: null },
    );
    await sweep(db, makeDeps());
    const blocked = [...SHOPIFY_LEVEL_REASONS].sort();
    expect(candidateCalls(db).map((c) => c.args)).toEqual([
      { p_org: ORG, p_mode: "real", p_since: "2026-10-12T05:00:00.000Z", p_limit: INVOICE_SWEEP_MAX_CANDIDATES, p_blocked: blocked, p_store: null },
      { p_org: ORG, p_mode: "simulacion", p_since: "2026-10-10T05:00:00.000Z", p_limit: INVOICE_SWEEP_MAX_CANDIDATES, p_blocked: blocked, p_store: null },
    ]);
    expect(INVOICE_SWEEP_MAX_CANDIDATES).toBe(500);
    // Una sola lista de motivos de Shopify, la de aquí: la base no tiene otra.
    expect(shopifyBlockedReasons()).toEqual(blocked);
    expect(blocked).toContain("editado");
    expect(blocked).not.toContain("lectura_fallida");
  });

  it("un modo cuyos RUC no tienen «Emitir desde» no tiene candidatos: ni se pregunta", async () => {
    const db = world({ mode: "simulacion" });
    issuerRow(db).emit_from = null;
    addOrder(db, 1);
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(candidateCalls(db)).toEqual([]);
    expect(report.orgs[0]!.candidates).toBe(0);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
  });

  it("con ?storeId la base mira solo esa tienda", async () => {
    const db = world();
    addOrder(db, 1);
    await sweep(db, makeDeps(), { storeId: STORE });
    expect(candidateCalls(db).map((c) => c.args.p_store)).toEqual([STORE]);
  });

  it("FALLA CERRADA: si la base no da los candidatos, esa organización no emite; otra sigue", async () => {
    const db = world();
    addSecondOrg(db);
    addOrder(db, 1);
    addOrder(db, 2, { store: STORE2 });
    const rpc = db.admin.rpc.bind(db.admin);
    (db.admin as unknown as { rpc: unknown }).rpc = async (fn: string, args: Record<string, unknown>) =>
      fn === "invoice_candidates" && args.p_org === ORG ? { data: null, error: { message: "statement timeout" } } : rpc(fn, args);
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(invoice(db, "ord-1")).toBeUndefined();
    expect(invoice(db, "ord-2")).toMatchObject({ status: "emitida", issuer_id: ISS2 });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(new RegExp(`^Organización ${ORG}: .*pedidos por revisar.*statement timeout`));
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
    expect(claims(db)).toEqual([]);
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

  it("no busca en SimpleFact lo de antes de ayer: el `emitiendo` pasa a en duda y lo ve una persona", async () => {
    const db = world();
    openRow(db, 1, "emitiendo", "2026-10-11T20:00:00.000Z");
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(deps.listSales).not.toHaveBeenCalled();
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "en_duda", error: invoiceUnreconciledError(uuidOf(1)) });
    expect(report.sin_respuesta).toBe(1);
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

describe("runInvoiceSweep: un `emitiendo` que nadie va a conciliar pasa a en duda (§35.4)", () => {
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
  function emitting(db: Db, n: number, createdAt: string, issuerId = ISS, store = STORE) {
    db.t("order_invoices").push({
      id: uuidOf(n),
      order_id: `ord-e${n}`,
      store_id: store,
      issuer_id: issuerId,
      mode: "real",
      status: "emitiendo",
      error: null,
      created_at: createdAt,
    });
  }
  const row = (db: Db, n: number) => db.t("order_invoices").find((r) => r.id === uuidOf(n))!;

  it("la nota de la boleta va en el mensaje, para buscarla en SimpleFact", () => {
    expect(invoiceUnreconciledError("6f1c2a3b-9d8e-4f00-a1b2-c3d4e5f60718")).toBe(
      "Sin respuesta de SimpleFact: búscala por su nota «Kapta 6f1c2a3b» antes de liberarla",
    );
  });

  it.each(["apagado", "simulacion"] as const)(
    "RUC en %s: pasa a en duda sin llamar a SimpleFact, aunque no haya nada que barrer",
    async (mode) => {
      const db = world({ mode });
      emitting(db, 1, minutesAgo(30));
      const deps = makeDeps();
      const report = await sweep(db, deps);
      expect(row(db, 1)).toMatchObject({ status: "en_duda", error: invoiceUnreconciledError(uuidOf(1)) });
      expect(report.sin_respuesta).toBe(1);
      expect(report.errors).toEqual([]);
      // «Apagado» no hace nada hacia afuera: ni se lee el token.
      expect(deps.listSales).not.toHaveBeenCalled();
      expect(deps.createSale).not.toHaveBeenCalled();
      expect(deps.decryptToken).not.toHaveBeenCalled();
      // Solo si seguía emitiendo al escribir.
      const update = writes(db, "order_invoices").find((q) => q.op === "update")!;
      expect(has(update, "eq", "id", uuidOf(1))).toBe(true);
      expect(has(update, "eq", "status", "emitiendo")).toBe(true);
      if (mode === "apagado") expect(report.skipped).toBe("sin_ruc_encendido");
    },
  );

  it("RUC en real sin token: pasa a en duda (la conciliación no puede leer la lista)", async () => {
    const db = world();
    issuerRow(db).token_enc = null;
    emitting(db, 1, minutesAgo(30));
    const deps = makeDeps();
    await sweep(db, deps);
    expect(row(db, 1)).toMatchObject({ status: "en_duda" });
    expect(deps.listSales).not.toHaveBeenCalled();
  });

  it("RUC en real con token, de hoy o de ayer: lo deja para la conciliación de la misma pasada", async () => {
    const db = world();
    emitting(db, 1, minutesAgo(30));
    // 00:00 de Lima del 13-10: el borde de la ventana de la conciliación.
    emitting(db, 2, "2026-10-13T05:00:00.000Z");
    const deps = makeDeps();
    deps.listSales.mockImplementation(async (_conn, q) => ({
      http: 200,
      body: { data: q.shortdate === "today" ? [sale(31, RUC_GF, invoiceNoteRef(uuidOf(1)))] : [] },
    }));
    const report = await sweep(db, deps);
    expect(row(db, 1)).toMatchObject({ status: "emitida", simplefact_id: 31 });
    // No apareció en la lista completa: la conciliación lo pasa a en duda con su texto.
    expect(row(db, 2)).toMatchObject({ status: "en_duda", error: INVOICE_NOT_FOUND_ERROR });
    expect(report.sin_respuesta).toBe(0);
  });

  it("un minuto antes de la ventana de la conciliación ya no lo mira nadie: pasa a en duda", async () => {
    const db = world();
    emitting(db, 1, "2026-10-13T04:59:00.000Z");
    const deps = makeDeps();
    await sweep(db, deps);
    expect(row(db, 1)).toMatchObject({ status: "en_duda", error: invoiceUnreconciledError(uuidOf(1)) });
    expect(deps.listSales).not.toHaveBeenCalled();
  });

  it("uno de hace menos de 10 minutos puede tener su POST en vuelo: no se toca", async () => {
    const db = world({ mode: "apagado" });
    emitting(db, 1, minutesAgo(5));
    const report = await sweep(db, makeDeps());
    expect(row(db, 1)).toMatchObject({ status: "emitiendo" });
    expect(report.sin_respuesta).toBe(0);
  });

  it("un en duda, un error o una simulación no se tocan: solo los `emitiendo` reales", async () => {
    const db = world({ mode: "apagado" });
    db.t("order_invoices").push(
      { id: uuidOf(1), order_id: "a", store_id: STORE, issuer_id: ISS, mode: "real", status: "en_duda", error: "x", created_at: minutesAgo(60) },
      { id: uuidOf(2), order_id: "b", store_id: STORE, issuer_id: ISS, mode: "real", status: "error", error: "y", created_at: minutesAgo(60) },
      { id: uuidOf(3), order_id: "c", store_id: STORE, issuer_id: ISS, mode: "simulacion", status: "simulada", error: null, created_at: minutesAgo(60) },
    );
    await sweep(db, makeDeps());
    expect(writes(db, "order_invoices")).toEqual([]);
    const read = db.log.find((q) => q.table === "order_invoices")!;
    expect(has(read, "eq", "mode", "real")).toBe(true);
    expect(has(read, "eq", "status", "emitiendo")).toBe(true);
  });

  it("con ?storeId solo los de esa tienda", async () => {
    const db = world({ mode: "simulacion" });
    addSecondOrg(db);
    issuerRow(db, ISS2).mode = "apagado";
    emitting(db, 1, minutesAgo(30));
    emitting(db, 2, minutesAgo(30), ISS2, STORE2);
    await sweep(db, makeDeps(), { storeId: STORE });
    expect(row(db, 1)).toMatchObject({ status: "en_duda" });
    expect(row(db, 2)).toMatchObject({ status: "emitiendo" });
  });

  it(`del más viejo al más nuevo, a lo más ${INVOICE_UNRECONCILED_BATCH} por pasada`, async () => {
    const db = world({ mode: "apagado" });
    for (let i = 1; i <= INVOICE_UNRECONCILED_BATCH + 5; i += 1) emitting(db, i, minutesAgo(300 - i));
    const report = await sweep(db, makeDeps());
    expect(report.sin_respuesta).toBe(INVOICE_UNRECONCILED_BATCH);
    expect(row(db, 1)).toMatchObject({ status: "en_duda" });
    expect(row(db, INVOICE_UNRECONCILED_BATCH + 5)).toMatchObject({ status: "emitiendo" });
  });

  it("dry no lo toca", async () => {
    const db = world({ mode: "apagado" });
    emitting(db, 1, minutesAgo(30));
    await sweep(db, makeDeps(), { dry: true });
    expect(row(db, 1)).toMatchObject({ status: "emitiendo" });
    expect(db.log.filter((q) => q.table === "order_invoices")).toEqual([]);
  });

  it("si no puede leer los RUC de esas filas no toca nada, lo reporta y sigue con el barrido", async () => {
    const db = world({ mode: "simulacion" });
    emitting(db, 1, minutesAgo(30));
    addOrder(db, 1);
    db.failWhen.push((q) => q.table === "invoice_issuers" && q.cols === "id,mode");
    const report = await sweep(db, makeDeps());
    expect(row(db, 1)).toMatchObject({ status: "emitiendo" });
    expect(report.errors.join(" ")).toMatch(/emitiendo/);
    expect(invoice(db, "ord-1")).toMatchObject({ status: "simulada" });
  });

  it("si no puede leer los `emitiendo`, lo reporta y sigue con el barrido", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    db.failWhen.push((q) => q.table === "order_invoices" && q.op === "select" && has(q, "eq", "status", "emitiendo"));
    const report = await sweep(db, makeDeps());
    expect(report.errors).toHaveLength(1);
    expect(invoice(db, "ord-1")).toMatchObject({ status: "simulada" });
  });
});

describe("invoice_candidates (0260) y el barrido dicen lo mismo", () => {
  // La crea la 0260; el turno vigente también es el de la 0260 (la 0257 que
  // corrió en producción no se reescribe).
  const sql = readFileSync(resolve(process.cwd(), "db/migrations/0260_invoices_hardening.sql"), "utf8");
  const fn = /create or replace function invoice_candidates\([\s\S]*?\n\$\$;/.exec(sql)?.[0] ?? "";
  const flat = fn.replace(/\s+/g, " ");

  it("recibe lo que manda el barrido, con esos nombres", () => {
    expect(fn).not.toBe("");
    for (const arg of ["p_org uuid", "p_mode text", "p_since timestamptz", "p_limit integer", "p_blocked text[]", "p_store uuid default null"]) {
      expect(flat).toContain(arg);
    }
    expect(flat).toContain("returns table (order_id uuid)");
    expect(flat).toContain("security invoker set search_path = public");
  });

  it("los motivos de Shopify vienen del barrido: la base no tiene su propia lista", () => {
    expect(flat).toContain("c.reason = any (coalesce(p_blocked, '{}'::text[]))");
    for (const reason of SHOPIFY_LEVEL_REASONS) expect(fn).not.toContain(`'${reason}'`);
  });

  it("las 6 horas sin releer en Shopify son las del barrido", () => {
    expect(INVOICE_SHOPIFY_RECHECK_MS % 3_600_000).toBe(0);
    expect(flat).toContain(`c.checked_at > now() - interval '${INVOICE_SHOPIFY_RECHECK_MS / 3_600_000} hours'`);
  });

  it("un comprobante real vivo es lo mismo que para la regla y el índice", () => {
    const live = /i\.mode = 'real' and i\.status in \(([^)]*)\)/.exec(flat);
    expect(live?.[1]?.split(",").map((x) => x.trim().replace(/'/g, ""))).toEqual([...LIVE_REAL_STATUSES]);
  });

  it("en real deja fuera el mismo error que el turno rechaza con `error_previo`", () => {
    expect(flat).toContain(
      "(p_mode <> 'real' or not exists ( select 1 from order_invoices i where i.order_id = m.order_id and i.mode = 'real' and i.status = 'error' and i.retry_requested_at is null ))",
    );
    const claim = /create or replace function invoice_claim\([\s\S]*?\n\$\$;/.exec(sql)?.[0]?.replace(/\s+/g, " ") ?? "";
    expect(claim).toContain(
      "where order_id = p_order and mode = 'real' and status = 'error' and retry_requested_at is null ) then return jsonb_build_object('reason', 'error_previo');",
    );
  });

  it("los 60 días que Shopify deja leer, y los pagados del Master", () => {
    expect(flat).toContain("m.order_created_at >= now() - interval '60 days'");
    expect(flat).toContain(
      "(m.payment_state = 'pago_completo' or (m.payment_gateway = 'checkout' and m.financial_status = 'paid'))",
    );
    // «Quedó pagado» es cuándo se registró el pago (§35.3, condición 8), no cuándo se validó.
    expect(flat).toContain("p.validation_status = 'validado' and p.registered_at >= p_since");
    expect(flat).not.toContain("validated_at");
  });
});

describe("runInvoiceSweep: el código llegó antes que la 0257 o la 0260", () => {
  const TABLES = ["invoice_issuers", "order_invoices", "invoice_order_checks"];

  it.each(["42P01", "PGRST205"] as const)("sin las tablas (%s): sin_migracion, sin errores y sin tocar nada", async (code) => {
    for (const dry of [false, true]) {
      const db = world();
      addOrder(db, 1);
      for (const table of TABLES) db.missing.set(table, code);
      const deps = makeDeps();
      const report = await sweep(db, deps, { dry });
      expect(report, `dry=${dry}`).toMatchObject({ skipped: "sin_migracion", orgs: [], errors: [] });
      expect(deps.fetchOrder).not.toHaveBeenCalled();
      expect(deps.createSale).not.toHaveBeenCalled();
      expect(writes(db)).toEqual([]);
    }
  });

  it.each(["42883", "PGRST202"] as const)("sin invoice_candidates, con la 0257 y sin la 0260 (%s): sin_migracion, sin errores", async (code) => {
    const db = world();
    addOrder(db, 1);
    db.missing.set("invoice_candidates", code);
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report).toMatchObject({ skipped: "sin_migracion", errors: [] });
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
  });

  it("sin invoice_claim: no se reservó nada ni se llamó a SimpleFact", async () => {
    const db = world();
    addOrder(db, 1);
    addOrder(db, 2);
    db.missing.set("invoice_claim", "PGRST202");
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report).toMatchObject({ skipped: "sin_migracion", errors: [] });
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(db.t("order_invoices")).toEqual([]);
  });

  it("otra falla de la base sigue siendo un error a la vista", async () => {
    const db = world();
    db.failWhen.push((q) => q.table === "order_invoices");
    db.failWhen.push((q) => q.table === "invoice_issuers");
    const report = await sweep(db, makeDeps());
    expect(report.skipped).toBeUndefined();
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it("las lecturas del panel lo dicen con un error que se reconoce", async () => {
    const db = world();
    db.missing.set("invoice_issuers", "PGRST205");
    const err = await loadInvoiceIssuers(db.admin, ORG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceMigrationMissingError);
    expect(isInvoiceMigrationMissing(err)).toBe(true);
    expect(isInvoiceMigrationMissing(new Error("42P01"))).toBe(false);
    // Sin una tabla de la 0257 faltan las dos: la 0260 no se aplica sin ella.
    expect((err as Error).message).toBe(
      "Falta aplicar las migraciones 0257 y 0260 de comprobantes (No se pudo leer invoice_issuers).",
    );
  });

  it("el error dice qué migración falta: sin `invoice_candidates`, solo la 0260", () => {
    // Con la 0257 aplicada y sin la 0260: lo que contesta PostgREST al barrido.
    const candidatos = new InvoiceMigrationMissingError(
      "No se pudieron leer los pedidos por revisar (real)",
      "Could not find the function public.invoice_candidates(p_blocked, p_limit, p_mode, p_org, p_since, p_store) in the schema cache",
    );
    expect(candidatos.message).toBe(
      "Falta aplicar la migración 0260 de comprobantes (No se pudieron leer los pedidos por revisar (real)).",
    );
    // Lo que crea la 0257 (el turno también: la 0260 solo lo vuelve a escribir).
    for (const name of ["invoice_issuers", "order_invoices", "invoice_order_checks", "invoice_claim", "invoice_issuer_id"]) {
      expect(INVOICE_MIGRATION_OBJECTS[name as keyof typeof INVOICE_MIGRATION_OBJECTS], name).toBe("0257");
      expect(new InvoiceMigrationMissingError(name).message, name).toBe(
        `Falta aplicar las migraciones 0257 y 0260 de comprobantes (${name}).`,
      );
    }
    expect(INVOICE_MIGRATION_OBJECTS.invoice_candidates).toBe("0260");
    // Si nombra algo de las dos, o nada, se piden las dos.
    expect(new InvoiceMigrationMissingError("x", "invoice_candidates: relation order_invoices does not exist").message).toContain(
      "las migraciones 0257 y 0260",
    );
    expect(new InvoiceMigrationMissingError("x", "algo que no se nombra").message).toContain("las migraciones 0257 y 0260");
    // Un nombre que solo empieza igual no cuenta.
    expect(new InvoiceMigrationMissingError("x", "invoice_candidates_old").message).toContain("las migraciones 0257 y 0260");
  });

  it("«no existe» solo es «falta una migración de comprobantes» si nombra algo que crean la 0257 o la 0260", () => {
    const si: object[] = [
      { code: "42P01", message: 'relation "public.order_invoices" does not exist' },
      { code: "42P01", message: 'relation "invoice_order_checks" does not exist' },
      { code: "PGRST205", message: "Could not find the table 'public.invoice_issuers' in the schema cache" },
      { code: "42883", message: "function public.invoice_candidates(uuid, text, timestamp with time zone, integer, text[], uuid) does not exist" },
      { code: "PGRST202", message: "Could not find the function public.invoice_claim(p_basis, p_id) in the schema cache" },
      // PostgREST pone la función buscada en `details`.
      {
        code: "PGRST202",
        message: "Could not find the function in the schema cache",
        details: "Searched for the function public.invoice_candidates with parameters p_blocked, p_limit",
      },
    ];
    // Cada cosa que crean la 0257 y la 0260, con el mensaje de Postgres.
    expect(Object.keys(INVOICE_MIGRATION_OBJECTS).sort()).toEqual(
      ["invoice_issuers", "order_invoices", "invoice_order_checks", "invoice_claim", "invoice_candidates", "invoice_issuer_id"].sort(),
    );
    for (const name of ["invoice_issuers", "order_invoices", "invoice_order_checks", "invoice_claim", "invoice_candidates", "invoice_issuer_id"]) {
      si.push({ code: "42P01", message: `relation "public.${name}" does not exist` });
    }
    const no: object[] = [
      // Una tabla de antes que falta es una base rota, no la 0257.
      { code: "42P01", message: 'relation "public.orders" does not exist' },
      { code: "PGRST205", message: "Could not find the table 'public.order_payments' in the schema cache" },
      // Dentro de una función de la 0257, lo que falta es otra cosa.
      { code: "42P01", message: 'relation "order_master" does not exist' },
      { code: "42883", message: "function hashtextextended(text, integer) does not exist" },
      // El hint dice lo que SÍ existe: que nombre una tabla de la 0257 prueba que está.
      {
        code: "PGRST205",
        message: "Could not find the table 'public.order_invoice' in the schema cache",
        hint: "Perhaps you meant the table 'public.order_invoices'",
      },
      // Un nombre que solo empieza igual no es el de la 0257.
      { code: "42P01", message: 'relation "public.order_invoices_respaldo" does not exist' },
      // Sin nombre no se sabe qué falta.
      { code: "42P01", message: "x" },
      // Otro código, aunque nombre la tabla.
      { code: "23505", message: 'duplicate key value violates unique constraint "order_invoices_one_real"' },
      { code: "42703", message: "column store_collection_accounts.invoice_issuer_id does not exist" },
    ];
    for (const e of si) expect(isInvoiceMigrationMissing(e), JSON.stringify(e)).toBe(true);
    for (const e of no) expect(isInvoiceMigrationMissing(e), JSON.stringify(e)).toBe(false);
  });

  it.each(["42P01", "PGRST205"] as const)(
    "falta una tabla de antes (%s): no es `sin_migracion`, es un error a la vista y no se emite",
    async (code) => {
      const db = world();
      addSecondOrg(db);
      addOrder(db, 1);
      addOrder(db, 2, { store: STORE2 });
      db.missing.set("order_payments", code);
      const deps = makeDeps();
      const report = await sweep(db, deps);
      expect(report.skipped).toBeUndefined();
      // Una por organización: ninguna emite sin saber sus pagos.
      expect(report.errors).toHaveLength(2);
      for (const e of report.errors) expect(e).toMatch(/^Organización .*order_payments/);
      expect(deps.fetchOrder).not.toHaveBeenCalled();
      expect(claims(db)).toEqual([]);
      expect(deps.createSale).not.toHaveBeenCalled();
    },
  );

  it("si invoice_candidates dice que falta una tabla de antes (order_master), es un error, no `sin_migracion`", async () => {
    const db = world();
    addOrder(db, 1);
    const rpc = db.admin.rpc.bind(db.admin);
    (db.admin as unknown as { rpc: unknown }).rpc = async (fn: string, args: Record<string, unknown>) =>
      fn === "invoice_candidates"
        ? { data: null, error: { code: "42P01", message: 'relation "order_master" does not exist' } }
        : rpc(fn, args);
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report.skipped).toBeUndefined();
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/order_master/);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
  });

  it("si invoice_claim dice que falta una tabla de antes (order_payments), es un error del turno: no se llama a SimpleFact", async () => {
    const db = world();
    addOrder(db, 1);
    const rpc = db.admin.rpc.bind(db.admin);
    (db.admin as unknown as { rpc: unknown }).rpc = async (fn: string, args: Record<string, unknown>) =>
      fn === "invoice_claim"
        ? { data: null, error: { code: "42P01", message: 'relation "order_payments" does not exist' } }
        : rpc(fn, args);
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report.skipped).toBeUndefined();
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(db.t("order_invoices")).toEqual([]);
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ errores: 1 });
    expect(report.errors.join(" ")).toMatch(/turno.*order_payments/);
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

// ── «Manual» (owner, 15-10-2026) ─────────────────────────────────────────────

describe("runInvoiceSweep: un RUC en «Manual» se barre como simulación y se concilia como real (§35.8)", () => {
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
  function realRow(db: Db, n: number, status: "emitiendo" | "en_duda", createdAt: string) {
    db.t("order_invoices").push({
      id: uuidOf(n),
      order_id: `ord-m${n}`,
      store_id: STORE,
      issuer_id: ISS,
      mode: "real",
      status,
      error: status === "en_duda" ? "SimpleFact contestó 500." : null,
      created_at: createdAt,
    });
  }

  it("simula con `p_mode = 'simulacion'` y nunca llama a SimpleFact para crear una venta", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    addOrder(db, 2);
    const deps = makeDeps();
    const report = await sweep(db, deps);

    expect(claims(db)).toHaveLength(2);
    for (const c of claims(db)) {
      expect(c.args.p_mode).toBe("simulacion");
      // El barrido no es una persona: no dice quién.
      expect("p_created_by" in c.args).toBe(false);
    }
    expect(db.t("order_invoices").map((r) => [r.mode, r.status])).toEqual([
      ["simulacion", "simulada"],
      ["simulacion", "simulada"],
    ]);
    expect(deps.createSale).not.toHaveBeenCalled();
    // Sin nada que conciliar, ni se descifra el token.
    expect(deps.decryptToken).not.toHaveBeenCalled();
    expect(deps.listSales).not.toHaveBeenCalled();
    // La lista que pide es la de simulación.
    expect(candidateCalls(db).map((c) => c.args.p_mode)).toEqual(["simulacion"]);
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ mode: "manual", simuladas: 2, emitidas: 0, stopped: null });
    expect(report.errors).toEqual([]);
  });

  it("sus revisiones van bajo «simulacion», como las del barrido que hace", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1, { total: 800 });
    await sweep(db, makeDeps());
    expect(check(db, "ord-1", "simulacion")).toMatchObject({ reason: "monto_mayor_700", issuer_id: ISS });
    expect(check(db, "ord-1", "real")).toBeUndefined();
  });

  it("concilia lo real que emitió una persona: un en duda de hoy que aparece pasa a emitida", async () => {
    const db = world({ mode: "manual" });
    realRow(db, 1, "en_duda", minutesAgo(60));
    const deps = makeDeps();
    deps.listSales.mockResolvedValue({ http: 200, body: { data: [sale(7, RUC_GF, `Pedido #KP1 · ${invoiceNoteRef(uuidOf(1))}`)] } });
    const report = await sweep(db, deps);
    expect(deps.listSales).toHaveBeenCalledWith({ subdomain: "grupogf", token: TOKEN }, { shortdate: "today", pageSize: 100, page: 1 });
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "emitida", simplefact_id: 7, serie: "B001", correlative: "7" });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ mode: "manual", conciliadas: 1 });
    expect(deps.createSale).not.toHaveBeenCalled();
  });

  it("un `emitiendo` de hoy con token lo busca la conciliación, no pasa a en duda a ciegas", async () => {
    const db = world({ mode: "manual" });
    realRow(db, 1, "emitiendo", minutesAgo(30));
    const deps = makeDeps();
    const report = await sweep(db, deps);
    // Se buscó en SimpleFact y no apareció en la lista completa.
    expect(deps.listSales).toHaveBeenCalledTimes(1);
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "en_duda", error: INVOICE_NOT_FOUND_ERROR });
    expect(report.sin_respuesta).toBe(0);
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ en_duda: 1 });
  });

  it("sin token: su `emitiendo` pasa a en duda sin llamar a nada, como en real", async () => {
    const db = world({ mode: "manual" });
    issuerRow(db).token_enc = null;
    realRow(db, 1, "emitiendo", minutesAgo(30));
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "en_duda", error: invoiceUnreconciledError(uuidOf(1)) });
    expect(report.sin_respuesta).toBe(1);
    expect(deps.listSales).not.toHaveBeenCalled();
  });

  it("se apaga solo como en real: la conciliación encuentra la venta con archivos de OTRO RUC", async () => {
    const db = world({ mode: "manual" });
    realRow(db, 1, "en_duda", minutesAgo(60));
    const deps = makeDeps();
    deps.listSales.mockResolvedValue({ http: 200, body: { data: [sale(9, "20601643316", invoiceNoteRef(uuidOf(1)))] } });
    const report = await sweep(db, deps);
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "emitida", ruc_mismatch: true });
    expect(issuerRow(db)).toMatchObject({ mode: "apagado", checked_ruc: null, checked_at: null });
    expect(String(issuerRow(db).check_error)).toContain("20601643316");
    expect(report.orgs[0]!.issuers[0]!.stopped).toBe("apagado");
  });

  it("si el turno diera una fila real, no se envía: queda como error (no salió nada) y el RUC para", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    addOrder(db, 2);
    db.state.claimOverride = (a) => {
      db.t("order_invoices").push({ id: a.p_id, order_id: a.p_order, issuer_id: ISS, mode: "real", status: "emitiendo", created_at: NOW.toISOString() });
      return { id: a.p_id, mode: "real" };
    };
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(claims(db)).toHaveLength(1);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(deps.decryptToken).not.toHaveBeenCalled();
    expect(db.t("order_invoices")[0]).toMatchObject({ status: "error", error: "No se envió: el turno dio una emisión real que no se pidió." });
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ stopped: "turno", errores: 1 });
  });

  it("si pasó a «Real» entre la lista y el turno: la base dice modo_distinto, no se envía, el RUC para y no concilia", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    addOrder(db, 2);
    realRow(db, 9, "en_duda", minutesAgo(60));
    const deps = makeDeps();
    deps.fetchOrder.mockImplementation(async (input) => {
      issuerRow(db).mode = "real";
      return okRead(input.shopifyOrderId);
    });
    const report = await sweep(db, deps);
    expect(claims(db)).toHaveLength(1);
    expect(claims(db)[0]!.args.p_mode).toBe("simulacion");
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(db.t("order_invoices").filter((r) => r.order_id !== "ord-m9")).toEqual([]);
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ stopped: "modo_distinto", pendientes: 1, reasons: { modo_distinto: 1 } });
    expect(check(db, "ord-1", "simulacion") ?? check(db, "ord-2", "simulacion")).toMatchObject({ reason: "modo_distinto" });
    // Con el modo cambiado a mitad de la pasada, la conciliación espera a la próxima.
    expect(deps.listSales).not.toHaveBeenCalled();
  });

  it("DECISIÓN: «Simulación» y «Real» piden el turno sin `p_mode`, y siguen andando sin la 0261", async () => {
    for (const mode of ["simulacion", "real"] as const) {
      const db = world({ mode });
      db.state.sin0261 = true;
      addOrder(db, 1);
      const deps = makeDeps();
      const report = await sweep(db, deps);
      expect(report.skipped, mode).toBeUndefined();
      expect(report.errors, mode).toEqual([]);
      expect(claims(db), mode).toHaveLength(1);
      expect(Object.keys(claims(db)[0]!.args).sort(), mode).toEqual(
        ["p_basis", "p_id", "p_issuer", "p_order", "p_order_name", "p_paid_at", "p_request", "p_store", "p_total"],
      );
      expect(invoice(db, "ord-1"), mode).toMatchObject(mode === "real" ? { status: "emitida" } : { status: "simulada" });
    }
  });

  it("en «Manual» sin la 0261 (no podría existir, pero si pasa): `sin_migracion`, nada reservado ni enviado", async () => {
    const db = world({ mode: "manual" });
    db.state.sin0261 = true;
    addOrder(db, 1);
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report).toMatchObject({ skipped: "sin_migracion", errors: [] });
    expect(db.t("order_invoices")).toEqual([]);
    expect(deps.createSale).not.toHaveBeenCalled();
  });

  it("en ?dry=1 tampoco escribe ni llama", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    const report = await sweep(db, deps, { dry: true });
    expect(claims(db)).toEqual([]);
    expect(writes(db)).toEqual([]);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(report.orgs[0]!.issuers[0]).toMatchObject({ mode: "manual", would_claim: 1 });
  });
});

// ── «Emitir esta boleta» ─────────────────────────────────────────────────────

describe("emitInvoiceNow: «Emitir esta boleta», la emisión real del barrido para un pedido (§35.7)", () => {
  /** Quien pulsa: un usuario con `invoices.manage` (lo comprueba la acción del panel). */
  const OWNER = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const emit = (
    db: Db,
    deps: ReturnType<typeof makeDeps>,
    input: Partial<Parameters<typeof emitInvoiceNow>[1]> = {},
  ) => {
    db.clock.now = deps.now();
    return emitInvoiceNow(db.admin, { orderId: "ord-1", userId: OWNER, ...input }, deps);
  };
  // Solo producción emite (`invoiceEmitAllowedHere`); las pruebas de la vista
  // previa lo cambian.
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const nothingSent = (db: Db, deps: ReturnType<typeof makeDeps>) => {
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(db.t("order_invoices").filter((r) => r.mode === "real" && r.status === "emitiendo")).toEqual([]);
  };

  it("emite: el turno real con quién lo pidió va ANTES del único POST, y la fila queda emitida", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    deps.createSale.mockImplementation(async () => {
      expect(invoice(db, "ord-1")).toMatchObject({ mode: "real", status: "emitiendo", created_by: OWNER });
      return created(812);
    });
    const result = await emit(db, deps);

    const payload = buildSalePayload({
      invoiceId: uuidOf(1),
      orderName: "#KP1001",
      items: [{ code: "FAJA-M", name: "Faja Reductora - M", qty: 1, priceCents: 15_000 }],
      totalCents: 15_000,
    });
    expect(claims(db)).toEqual([
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
          p_mode: "real",
          p_created_by: OWNER,
        },
      },
    ]);
    expect(deps.fetchOrder).toHaveBeenCalledWith({ storeId: STORE, shopifyOrderId: "shp-1" });
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(deps.createSale).toHaveBeenCalledWith({ subdomain: "grupogf", token: TOKEN }, payload);
    expect(result).toEqual({
      ok: true,
      status: "emitida",
      invoiceId: uuidOf(1),
      serie: "B001",
      correlative: "812",
      pdfUrl: `https://grupogf.simplefact.pe/app/download/invoices/${RUC_GF}-03-B001-812.pdf`,
      error: null,
      rucMismatch: false,
    });
    expect(invoice(db, "ord-1")).toMatchObject({
      mode: "real",
      status: "emitida",
      created_by: OWNER,
      simplefact_id: 812,
      http_status: 200,
      ruc_mismatch: false,
      error: null,
    });
    const update = writes(db, "order_invoices").find((q) => q.op === "update")!;
    expect(has(update, "eq", "id", uuidOf(1))).toBe(true);
    expect(has(update, "eq", "status", "emitiendo")).toBe(true);
    // La revisión es del barrido: emitir a mano no la escribe.
    expect(writes(db, "invoice_order_checks")).toEqual([]);
    // El RUC sigue en «Manual».
    expect(issuerRow(db).mode).toBe("manual");
  });

  it("pide el mismo turno que el barrido en real: mismos parámetros, más el modo y quién", async () => {
    const barrido = world();
    addOrder(barrido, 1);
    await sweep(barrido, makeDeps());
    const manual = world({ mode: "manual" });
    addOrder(manual, 1);
    await emit(manual, makeDeps());
    const { p_mode, p_created_by, ...resto } = claims(manual)[0]!.args;
    expect([p_mode, p_created_by]).toEqual(["real", OWNER]);
    expect(resto).toEqual(claims(barrido)[0]!.args);
  });

  it("DECISIÓN: con el RUC en «Real» también emite, con los mismos candados", async () => {
    const db = world({ mode: "real" });
    addOrder(db, 1);
    const deps = makeDeps();
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: true, status: "emitida" });
    expect(claims(db)[0]!.args).toMatchObject({ p_mode: "real", p_created_by: OWNER });
    expect(deps.createSale).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["simulacion", "modo_distinto"],
    ["apagado", "ruc_apagado"],
  ] as const)("RUC en %s: %s, sin leer Shopify, sin turno y sin token", async (mode, reason) => {
    const db = world({ mode });
    addOrder(db, 1);
    const deps = makeDeps();
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: false, reason });
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(deps.decryptToken).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
    nothingSent(db, deps);
  });

  it.each<[string, (db: Db) => void, string]>([
    [
      "un pago sin validar",
      (db) => db.t("order_payments").push({ id: "pay-x", order_id: "ord-1", kind: "diferencia", amount: 1, validation_status: "pendiente_revision", registered_at: PAGADO, vision: {} }),
      "pagos_en_revision",
    ],
    // Antes del 01/10/2026 00:00 de Lima ni el botón va hacia atrás. Lo de
    // después y antes de «Emitir desde» pide la casilla (abajo).
    ["pagado antes de «Emitir desde» y del 01/10", (db) => (db.t("order_payments")[0]!.registered_at = "2026-10-01T04:59:59.000Z"), "antes_de_inicio"],
    ["pagado antes de «Emitir desde», sin la casilla", (db) => (db.t("order_payments")[0]!.registered_at = "2026-10-14T04:59:59.000Z"), "sin_revision_simplefact"],
    [
      "ya tiene uno real",
      (db) => db.t("order_invoices").push({ id: "ya", order_id: "ord-1", issuer_id: ISS, mode: "real", status: "emitida", created_at: NOW.toISOString() }),
      "ya_tiene",
    ],
    [
      "un error sin reintento",
      (db) => db.t("order_invoices").push({ id: "err", order_id: "ord-1", issuer_id: ISS, mode: "real", status: "error", retry_requested_at: null, created_at: NOW.toISOString() }),
      "error_previo",
    ],
    ["la prueba de conexión no confirmó el RUC", (db) => (issuerRow(db).checked_ruc = null), "sin_conexion"],
    ["más de S/ 700", (db) => ((db.t("orders")[0]!.total_amount = 800), (db.t("order_payments")[0]!.amount = 800)), "monto_mayor_700"],
    ["un pago que no se sabe a qué cuenta entró", (db) => db.t("flowcl_payment_links").splice(0), "pago_sin_cuenta"],
    ["anulado", (db) => (db.t("orders")[0]!.cancelled_at = NOW.toISOString()), "anulado"],
  ])("las reglas lo frenan (%s): %s, sin turno y sin SimpleFact", async (_label, arrange, reason) => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    arrange(db);
    const deps = makeDeps();
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: false, reason });
    expect(claims(db)).toEqual([]);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    nothingSent(db, deps);
  });

  it("una simulación previa no lo frena: la simulación no es una boleta", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    db.t("order_invoices").push({ id: "sim", order_id: "ord-1", issuer_id: ISS, mode: "simulacion", status: "simulada", created_at: NOW.toISOString() });
    const result = await emit(db, makeDeps());
    expect(result).toMatchObject({ ok: true, status: "emitida" });
  });

  it.each<[string, (deps: ReturnType<typeof makeDeps>) => void, string, RegExp | null]>([
    ["editado en Shopify", (d) => d.fetchOrder.mockResolvedValue({ ok: false, reason: "editado" }), "editado", null],
    ["Shopify no contesta", (d) => d.fetchOrder.mockResolvedValue({ ok: false, reason: "lectura_fallida", detail: "Tiempo agotado." }), "lectura_fallida", /Tiempo agotado/],
    ["otro total en Shopify", (d) => d.fetchOrder.mockImplementation(async (i) => okRead(i.shopifyOrderId, 14_000)), "total_distinto", /S\/ 140\.00; Kapta, S\/ 150\.00/],
    [
      "un detalle que no suma",
      (d) => d.fetchOrder.mockImplementation(async (i) => ({ ...(okRead(i.shopifyOrderId) as Extract<InvoiceOrderRead, { ok: true }>), items: [{ code: "X", name: "X", qty: 1, priceCents: 14_999 }] })),
      "no_cuadra",
      null,
    ],
  ])("Shopify lo frena (%s): %s, sin turno y sin SimpleFact", async (_label, arrange, reason, detail) => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    arrange(deps);
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: false, reason });
    if (detail) expect(result.ok === false && result.detail).toMatch(detail);
    expect(claims(db)).toEqual([]);
    nothingSent(db, deps);
    expect(writes(db, "invoice_order_checks")).toEqual([]);
  });

  it("un prepago web que Shopify no confirma cobrado por Flow no se emite", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1, { prepaid: true });
    const deps = makeDeps();
    expect(await emit(db, deps)).toMatchObject({ ok: false, reason: "pago_web_no_confirmado" });
    nothingSent(db, deps);
    deps.fetchOrder.mockImplementation(async (i) => okRead(i.shopifyOrderId, 15_000, true));
    expect(await emit(db, deps)).toMatchObject({ ok: true, status: "emitida" });
  });

  it("el turno lo frena: el tope del día cuenta lo real, no lo simulado", async () => {
    const db = world({ mode: "manual", dailyLimit: 1 });
    addOrder(db, 1);
    // Una simulación de hoy no ocupa el tope de lo real.
    db.t("order_invoices").push({ id: "sim", order_id: "ord-otro", issuer_id: ISS, mode: "simulacion", status: "simulada", created_at: NOW.toISOString() });
    expect(await emit(db, makeDeps())).toMatchObject({ ok: true, status: "emitida" });

    addOrder(db, 2);
    const deps = makeDeps();
    expect(await emit(db, deps, { orderId: "ord-2" })).toEqual({ ok: false, reason: "tope" });
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(invoice(db, "ord-2")).toBeUndefined();
  });

  it("si el barrido u otra persona lo tomó mientras se leía Shopify, la base dice ya_tiene y no se llama", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    deps.fetchOrder.mockImplementation(async (input) => {
      db.t("order_invoices").push({ id: "otra", order_id: "ord-1", mode: "real", status: "emitiendo", issuer_id: ISS, created_at: NOW.toISOString() });
      return okRead(input.shopifyOrderId);
    });
    expect(await emit(db, deps)).toEqual({ ok: false, reason: "ya_tiene" });
    expect(claims(db)).toHaveLength(1);
    expect(deps.createSale).not.toHaveBeenCalled();
  });

  it("500: en duda; pulsar otra vez dice ya_tiene, sin un segundo turno ni un segundo POST", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue({ http: 500, body: { message: "Server Error" } });
    const first = await emit(db, deps);
    expect(first).toMatchObject({ ok: true, status: "en_duda", invoiceId: uuidOf(1), serie: null, pdfUrl: null, rucMismatch: false });
    expect(first.ok && first.error).toMatch(/500/);
    expect(invoice(db, "ord-1")).toMatchObject({ mode: "real", status: "en_duda", http_status: 500, created_by: OWNER });

    const second = await emit(db, deps);
    expect(second).toEqual({ ok: false, reason: "ya_tiene" });
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(claims(db)).toHaveLength(1);
    expect(db.t("order_invoices")).toHaveLength(1);
    // Y la conciliación del barrido la encuentra por su nota.
    const sweepDeps = makeDeps();
    sweepDeps.listSales.mockResolvedValue({ http: 200, body: { data: [sale(31, RUC_GF, `Pedido #KP1001 · ${invoiceNoteRef(uuidOf(1))}`)] } });
    await sweep(db, sweepDeps);
    expect(invoice(db, "ord-1")).toMatchObject({ status: "emitida", simplefact_id: 31 });
    expect(sweepDeps.createSale).not.toHaveBeenCalled();
  });

  it("emitida a mano, el barrido en «Manual» ya no la simula ni la emite", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    await emit(db, makeDeps());
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(report.orgs[0]!.candidates).toBe(0);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(db.t("order_invoices").map((r) => [r.mode, r.status])).toEqual([["real", "emitida"]]);
  });

  it("401: error, el RUC se apaga con el motivo y su prueba se borra, y lo dice", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue({ http: 401, body: { message: `Unauthenticated ${TOKEN}` } });
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: true, status: "error", serie: null, rucMismatch: false });
    const error = result.ok ? result.error ?? "" : "";
    expect(error).toMatch(/Token rechazado \(401\)/);
    expect(error).toContain("El RUC quedó apagado");
    expect(error).not.toContain(TOKEN);
    expect(issuerRow(db)).toMatchObject({ mode: "apagado", checked_ruc: null, checked_at: null });
    expect(String(issuerRow(db).check_error)).toMatch(/401/);
    expect(String(issuerRow(db).check_error)).not.toContain(TOKEN);
    expect(invoice(db, "ord-1")).toMatchObject({ status: "error", http_status: 401 });
    expect(JSON.stringify(db.t("order_invoices"))).not.toContain(TOKEN);
  });

  it("archivos de OTRO RUC: emitida marcada, `rucMismatch`, y el RUC se apaga solo", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue(created(44, "20601643316"));
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: true, status: "emitida", rucMismatch: true, serie: "B001", correlative: "44" });
    expect(result.ok && result.error).toMatch(/20601643316/);
    expect(invoice(db, "ord-1")).toMatchObject({ status: "emitida", ruc_mismatch: true });
    expect(issuerRow(db)).toMatchObject({ mode: "apagado", checked_ruc: null });
  });

  it("429: error, y el RUC no se apaga", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue({ http: 429, body: { message: "Too Many Attempts." } });
    expect(await emit(db, deps)).toMatchObject({ ok: true, status: "error", error: "SimpleFact pidió esperar (429)." });
    expect(issuerRow(db).mode).toBe("manual");
  });

  it("sin la 0261: `sin_migracion` que nombra la 0261, sin fila y sin POST", async () => {
    const db = world({ mode: "manual" });
    db.state.sin0261 = true;
    addOrder(db, 1);
    const deps = makeDeps();
    const result = await emit(db, deps);
    expect(INVOICE_CLAIM_MODE_MIGRATION).toBe("0261");
    expect(result).toEqual({
      ok: false,
      reason: "sin_migracion",
      detail: "Falta aplicar la migración 0261 de comprobantes (invoice_claim con p_mode y p_created_by).",
    });
    expect(db.t("order_invoices")).toEqual([]);
    nothingSent(db, deps);
  });

  it("sin las tablas de la 0257: `sin_migracion` que nombra la 0257 y la 0260, sin leer Shopify", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    db.missing.set("order_invoices", "PGRST205");
    const deps = makeDeps();
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: false, reason: "sin_migracion" });
    expect(result.ok === false && result.detail).toContain("las migraciones 0257 y 0260");
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
  });

  it("FALLA CERRADA: si no se pueden leer los pagos, no lanza, no lee Shopify y no pide turno", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    db.failWhen.push((q) => q.table === "order_payments");
    const deps = makeDeps();
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: false, reason: "lectura_fallida" });
    expect(result.ok === false && result.detail).toMatch(/order_payments/);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
    nothingSent(db, deps);
  });

  it("un pedido que no existe: `pedido`", async () => {
    const db = world({ mode: "manual" });
    const deps = makeDeps();
    expect(await emit(db, deps, { orderId: "ord-404" })).toMatchObject({ ok: false, reason: "pedido" });
    expect(claims(db)).toEqual([]);
  });

  it("un token que no se descifra: sin_conexion, sin leer Shopify ni pedir turno", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps({ decryptToken: () => { throw new Error(`clave equivocada ${TOKEN_ENC}`); } });
    const result = await emit(db, deps);
    expect(result).toEqual({ ok: false, reason: "sin_conexion", detail: "No se pudo descifrar el token de SimpleFact." });
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
    nothingSent(db, deps);
  });

  it("sin saber quién pulsa no pide el turno", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    expect(await emit(db, deps, { userId: " " })).toMatchObject({ ok: false, reason: "turno_fallido" });
    expect(claims(db)).toEqual([]);
    nothingSent(db, deps);
  });

  it("si el turno no responde, o contesta algo raro: turno_fallido y no se llama", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    db.state.rpcError = "connection reset";
    const deps = makeDeps();
    expect(await emit(db, deps)).toMatchObject({ ok: false, reason: "turno_fallido", detail: "El turno falló (connection reset)." });
    db.state.rpcError = null;
    db.state.claimOverride = () => ({ id: "otro-id", mode: "real" });
    expect(await emit(db, deps)).toMatchObject({ ok: false, reason: "turno_fallido" });
    // Una simulación cuando se pidió real tampoco se envía.
    db.state.claimOverride = (a) => ({ id: a.p_id, mode: "simulacion" });
    expect(await emit(db, deps)).toMatchObject({ ok: false, reason: "turno_fallido" });
    expect(deps.createSale).not.toHaveBeenCalled();
  });

  it("si el envío lanza, no se sabe si salió: en duda, nunca un no", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    deps.createSale.mockRejectedValue(new Error("socket hang up"));
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: true, status: "en_duda", invoiceId: uuidOf(1) });
    expect(invoice(db, "ord-1")).toMatchObject({ status: "en_duda", http_status: null });
    expect(String(invoice(db, "ord-1")!.error)).toContain("socket hang up");
  });

  it("si algo lanza después del turno, no lanza: en duda, y la fila sigue «emitiendo» para la conciliación", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    deps.createSale.mockResolvedValue({
      get http(): number {
        throw new Error("respuesta rota");
      },
      body: null,
    } as SimplefactHttp);
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: true, status: "en_duda", invoiceId: uuidOf(1), serie: null });
    expect(result.ok && result.error).toContain(invoiceNoteRef(uuidOf(1)));
    expect(invoice(db, "ord-1")).toMatchObject({ status: "emitiendo" });
  });

  it("si no se puede guardar la respuesta: dice lo que contestó SimpleFact y que la fila sigue «emitiendo»", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    db.failWhen.push((q) => q.table === "order_invoices" && q.op === "update");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps();
    const result = await emit(db, deps);
    expect(result).toMatchObject({ ok: true, status: "emitida", serie: "B001", correlative: "500" });
    expect(result.ok && result.error).toMatch(/No se pudo guardar la respuesta en Kapta/);
    expect(invoice(db, "ord-1")).toMatchObject({ status: "emitiendo" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ni el token ni la clienta salen en lo que contesta ni en la consola", async () => {
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const results: unknown[] = [];
    for (const res of [
      { http: 401, body: { message: `Unauthenticated ${TOKEN}` } },
      { http: 500, body: { message: `boom ${TOKEN}` } },
      { http: null, body: null, error: `cortado ${TOKEN}` },
    ] as SimplefactHttp[]) {
      const db = world({ mode: "manual" });
      addOrder(db, 1);
      db.failWhen.push((q) => q.table === "invoice_issuers" && q.op === "update");
      const deps = makeDeps();
      deps.createSale.mockResolvedValue(res);
      results.push(await emit(db, deps));
      expect(JSON.stringify(db.t("order_invoices"))).not.toContain(TOKEN);
    }
    const text = JSON.stringify(results);
    for (const secret of [TOKEN, TOKEN_ENC, CLIENTA, "987654321"]) {
      expect(text).not.toContain(secret);
      for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
    }
  });

  // La red de lo que sale: si algo lanza DESPUÉS de descifrar el token, el
  // `catch` de afuera arma la respuesta con el mensaje del error. Ese mensaje
  // puede traer el token (una librería que repite la petición) o el celular de
  // la clienta (un error de la base que cita la fila): se limpia con `redact` y
  // `sinTelefonos` antes de devolverlo, y no va a la consola.
  it("si algo lanza después de descifrar el token, ni el token ni un celular salen en lo que contesta ni en la consola", async () => {
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const CELULARES = ["987654321", "+51 912 345 678", "912 345 678"];
    const boom = (donde: string) => new Error(`${donde}: Authorization: Bearer ${TOKEN} · clienta 987654321 (+51 912 345 678)`);

    // Antes del turno: la relectura en Shopify lanza.
    const antes = world({ mode: "manual" });
    addOrder(antes, 1);
    const depsAntes = makeDeps();
    depsAntes.fetchOrder.mockRejectedValue(boom("shopify"));
    const sinTurno = await emit(antes, depsAntes);
    expect(depsAntes.decryptToken).toHaveBeenCalledTimes(1);
    expect(sinTurno).toMatchObject({ ok: false, reason: "lectura_fallida" });
    expect(claims(antes)).toEqual([]);

    // Después del turno: leer la respuesta de SimpleFact lanza.
    const despues = world({ mode: "manual" });
    addOrder(despues, 1);
    const depsDespues = makeDeps();
    depsDespues.createSale.mockResolvedValue({
      get http(): number {
        throw boom("respuesta");
      },
      body: null,
    } as SimplefactHttp);
    const enDuda = await emit(despues, depsDespues);
    expect(enDuda).toMatchObject({ ok: true, status: "en_duda", invoiceId: uuidOf(1) });

    // El mensaje llega, limpio: se sabe qué pasó sin saber el token ni el celular.
    const detalle = [sinTurno.ok ? "" : sinTurno.detail, enDuda.ok ? enDuda.error : ""].join(" | ");
    expect(detalle).toContain("shopify: Authorization: Bearer [token] · clienta [número] ([número])");
    expect(detalle).toContain("respuesta: Authorization: Bearer [token] · clienta [número] ([número])");
    const text = JSON.stringify([sinTurno, enDuda]);
    for (const secret of [TOKEN, ...CELULARES]) {
      expect(text, secret).not.toContain(secret);
      for (const spy of spies) expect(JSON.stringify(spy.mock.calls), secret).not.toContain(secret);
    }
  });
});

// ── emitInvoiceNow: lo que se vio, solo Manual y solo producción ─────────────

describe("emitInvoiceNow: lo que vio la persona es lo que sale, solo en Manual y solo en producción (§35.7)", () => {
  const OWNER = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  /** Lo que confirmó la persona en el pedido de prueba: el RUC de GRUPO GF y S/ 150. */
  const VIO = { issuerId: ISS, totalCents: 15_000 };
  const emit = (
    db: Db,
    deps: ReturnType<typeof makeDeps>,
    input: Partial<Parameters<typeof emitInvoiceNow>[1]> = {},
  ) => {
    db.clock.now = deps.now();
    return emitInvoiceNow(db.admin, { orderId: "ord-1", userId: OWNER, manualOnly: true, expected: VIO, ...input }, deps);
  };
  /** Ni el token, ni Shopify, ni el turno, ni SimpleFact, ni una fila. */
  const nadaDeNada = (db: Db, deps: ReturnType<typeof makeDeps>) => {
    expect(deps.decryptToken).not.toHaveBeenCalled();
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(db.t("order_invoices")).toEqual([]);
  };
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lo que vio coincide con lo que sale: emite, con un solo turno y un solo POST", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    expect(await emit(db, deps)).toMatchObject({ ok: true, status: "emitida" });
    expect(claims(db)[0]!.args).toMatchObject({ p_issuer: VIO.issuerId, p_total: VIO.totalCents / 100 });
    expect(deps.createSale).toHaveBeenCalledTimes(1);
  });

  // FIX: la acción comparaba lo que vio la persona con SU lectura y
  // `emitInvoiceNow` volvía a leer sin comparar: si el pedido cambiaba entre las
  // dos, salía una boleta que nadie confirmó.
  it.each<[string, (db: Db) => void]>([
    // Se agregó un pago y cambió el total: la persona vio S/ 150.
    ["el total cambió", (db) => ((db.t("orders")[0]!.total_amount = 140), (db.t("order_payments")[0]!.amount = 140))],
    // La cuenta del pago pasó a otro RUC de la organización.
    [
      "la cuenta del pago es ahora de otro RUC",
      (db) => {
        db.t("invoice_issuers").push({ ...issuerRow(db), id: ISS2, ruc: RUC_OTRO, legal_name: "OTRA", simplefact_subdomain: "otra", checked_ruc: RUC_OTRO });
        db.t("store_collection_accounts").find((a) => a.id === "acc-flow")!.invoice_issuer_id = ISS2;
      },
    ],
  ])("si %s desde que lo vio, `pedido_cambio`: sin token, sin Shopify, sin turno y sin POST", async (_label, cambiar) => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    cambiar(db);
    const deps = makeDeps();
    expect(await emit(db, deps)).toEqual({ ok: false, reason: "pedido_cambio" });
    nadaDeNada(db, deps);
  });

  it.each<[string, unknown]>([
    ["otro RUC", { issuerId: ISS2, totalCents: 15_000 }],
    ["otro total", { issuerId: ISS, totalCents: 14_999 }],
    ["un RUC vacío", { issuerId: "", totalCents: 15_000 }],
    ["un total con fracción de céntimo", { issuerId: ISS, totalCents: 15_000.4 }],
    ["un total que no es número", { issuerId: ISS, totalCents: Number.NaN }],
    ["un RUC que no es texto", { issuerId: 7, totalCents: 15_000 }],
  ])("lo confirmado no coincide (%s): `pedido_cambio`, y no se llama a nada", async (_label, expected) => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    const deps = makeDeps();
    expect(await emit(db, deps, { expected: expected as never })).toEqual({ ok: false, reason: "pedido_cambio" });
    nadaDeNada(db, deps);
  });

  it("el botón sin lo que se confirmó (`expected` ausente o nulo) no emite: `pedido_cambio`, y no se llama a nada", async () => {
    for (const expected of [undefined, null]) {
      const db = world({ mode: "manual" });
      addOrder(db, 1);
      const deps = makeDeps();
      expect(await emit(db, deps, { expected: expected as never })).toEqual({ ok: false, reason: "pedido_cambio" });
      nadaDeNada(db, deps);
    }
  });

  it("las reglas van primero: un pedido que ya no cumple dice por qué, no que cambió", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    db.t("orders")[0]!.cancelled_at = NOW.toISOString();
    const deps = makeDeps();
    expect(await emit(db, deps, { expected: { issuerId: ISS2, totalCents: 1 } })).toMatchObject({ ok: false, reason: "anulado" });
    nadaDeNada(db, deps);
  });

  it("con `manualOnly`, en «Real» no emite: `modo_distinto` con el porqué, sin token ni Shopify", async () => {
    const db = world({ mode: "real" });
    addOrder(db, 1);
    const deps = makeDeps();
    expect(await emit(db, deps)).toEqual({
      ok: false,
      reason: "modo_distinto",
      detail: "El RUC está en «Real»: a mano solo se emite en «Manual».",
    });
    nadaDeNada(db, deps);
    // Sin `manualOnly`, la DECISIÓN de siempre: en «Real» también emite.
    expect(await emit(db, deps, { manualOnly: undefined })).toMatchObject({ ok: true, status: "emitida" });
  });

  it("con `manualOnly`, Simulación y Apagado dicen lo de las reglas", async () => {
    for (const [mode, reason] of [["simulacion", "modo_distinto"], ["apagado", "ruc_apagado"]] as const) {
      const db = world({ mode });
      addOrder(db, 1);
      const deps = makeDeps();
      expect(await emit(db, deps), mode).toMatchObject({ ok: false, reason });
      nadaDeNada(db, deps);
    }
  });

  // FIX: una vista previa comparte la base y `ENCRYPTION_KEY` con producción;
  // el barrido no emitía fuera de ella, pero «Emitir esta boleta» sí.
  it.each([["preview"], ["development"], [""], [undefined]])(
    "fuera de producción (VERCEL_ENV=%s): `no_produccion`, sin leer nada de la base",
    async (env) => {
      vi.stubEnv("VERCEL_ENV", env);
      expect(invoiceEmitAllowedHere()).toBe(false);
      const db = world({ mode: "manual" });
      addOrder(db, 1);
      const deps = makeDeps();
      expect(await emit(db, deps)).toEqual({ ok: false, reason: "no_produccion" });
      expect(db.log).toEqual([]);
      expect(db.rpcLog).toEqual([]);
      nadaDeNada(db, deps);
    },
  );

  it("solo `VERCEL_ENV=production` es producción", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(invoiceEmitAllowedHere()).toBe(true);
    for (const env of ["Production", "PRODUCTION", " production", "prod"]) {
      vi.stubEnv("VERCEL_ENV", env);
      expect(invoiceEmitAllowedHere(), env).toBe(false);
    }
  });
});

// ── ¿Se ofrece «Emitir esta boleta»? El drawer y Ajustes ─────────────────────

describe("loadInvoiceEmitNowOffers: el «Emitir» de Ajustes sale solo cuando el drawer ofrecería «Emitir esta boleta» (§35.7)", () => {
  const OFERTA = {
    issuerId: ISS,
    ruc: RUC_GF,
    legalName: "GRUPO GF S.A.C.",
    total: 150,
    // Pagado desde «Emitir desde»: no es de antes, y las fechas van en ISO.
    beforeStart: false,
    paidAt: PAGADO,
    firstPaidAt: PAGADO,
    emitFrom: DESDE,
  };
  /** La simulada que el barrido en «Manual» escribió para el pedido: la fila de Ajustes que lleva «Emitir». */
  const simulada = (db: Db, orderId: string, createdAt = "2026-10-14T19:00:00.000Z") =>
    db.t("order_invoices").push({
      id: `sim-${orderId}`,
      order_id: orderId,
      store_id: STORE,
      issuer_id: ISS,
      mode: "simulacion",
      status: "simulada",
      created_at: createdAt,
    });
  /** Otro RUC de la organización, con su prueba de conexión hecha. */
  const otroRuc = (db: Db, mode: "manual" | "real" | "simulacion") =>
    db.t("invoice_issuers").push({
      id: ISS2,
      org_id: ORG,
      ruc: RUC_OTRO,
      legal_name: "OTRA RAZÓN SOCIAL S.A.C.",
      simplefact_subdomain: "otra",
      token_enc: TOKEN_ENC,
      mode,
      emit_from: DESDE,
      daily_limit: 40,
      checked_ruc: RUC_OTRO,
      check_error: null,
    });
  /**
   * Lo que haría el drawer con la misma base: lee lo que lee `loadInvoicePanel`
   * (los hechos, los comprobantes del pedido, sus revisiones y si la tienda está
   * activa) y pregunta a la función que comparten.
   */
  async function drawer(db: Db, orderId: string) {
    const facts = (await loadInvoiceOrderFacts(db.admin, [orderId])).get(orderId);
    if (!facts) return null;
    const ready = invoiceEmitNowReadiness({
      facts,
      invoices: db
        .t("order_invoices")
        .filter((r) => r.order_id === orderId)
        .map((r) => ({ mode: String(r.mode), status: String(r.status), createdAt: String(r.created_at) })),
      checks: db.t("invoice_order_checks").filter((c) => c.order_id === orderId) as unknown as InvoiceCheckRow[],
      storeActive: db.t("stores").find((s) => s.id === facts.storeId)?.status === "active",
    });
    return ready.ok ? ready.offer : null;
  }
  const shopifyCheck = (db: Db, reason: string, checkedAt: string, mode = "simulacion") =>
    db.t("invoice_order_checks").push({ order_id: "ord-1", mode, reason, detail: null, issuer_id: ISS, checked_at: checkedAt });
  // Solo producción ofrece «Emitir» (`invoiceEmitAllowedHere`).
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // FIX: Ajustes ofrecía «Emitir» en una vista previa, donde la acción no emite.
  it("fuera de producción no ofrece ninguno, y no lee nada", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    simulada(db, "ord-1");
    expect([...(await loadInvoiceEmitNowOffers(db.admin, ["ord-1"])).values()]).toEqual([OFERTA]);
    for (const env of ["preview", "development", undefined]) {
      vi.stubEnv("VERCEL_ENV", env);
      db.log.splice(0);
      expect((await loadInvoiceEmitNowOffers(db.admin, ["ord-1"])).size, String(env)).toBe(0);
      expect(db.log, String(env)).toEqual([]);
    }
  });

  const casos: Array<[string, (db: Db) => void, typeof OFERTA | null]> = [
    ["lista: RUC en Manual, las reglas como emisión real, tienda activa y sin bloqueo", () => {}, OFERTA],
    ["no cumple las reglas: pasa de S/ 700", (db) => ((db.t("orders")[0]!.total_amount = 800), (db.t("order_payments")[0]!.amount = 800)), null],
    [
      "no cumple las reglas: un pago sin validar",
      (db) => db.t("order_payments").push({ id: "pay-x", order_id: "ord-1", kind: "diferencia", amount: 1, validation_status: "pendiente_revision", registered_at: PAGADO, vision: {} }),
      null,
    ],
    ["sin la conexión probada (cuenta como emisión real)", (db) => (issuerRow(db).checked_ruc = null), null],
    [
      "un error sin reintento",
      (db) => db.t("order_invoices").push({ id: "err", order_id: "ord-1", issuer_id: ISS, mode: "real", status: "error", retry_requested_at: null, created_at: "2026-10-14T18:00:00.000Z" }),
      null,
    ],
    [
      "con un comprobante real vivo",
      (db) => db.t("order_invoices").push({ id: "viva", order_id: "ord-1", issuer_id: ISS, mode: "real", status: "en_duda", created_at: "2026-10-14T19:30:00.000Z" }),
      null,
    ],
    ["Shopify lo frenó en la última pasada (después de la simulada)", (db) => shopifyCheck(db, "editado", "2026-10-14T19:30:00.000Z"), null],
    ["Shopify lo frenó con la revisión del otro modo, más nueva", (db) => shopifyCheck(db, "prueba", "2026-10-14T19:30:00.000Z", "real"), null],
    ["un corte de Shopify en la última pasada", (db) => shopifyCheck(db, "lectura_fallida", "2026-10-14T19:30:00.000Z"), null],
    ["un bloqueo de Shopify ANTES de la simulada ya quedó atrás", (db) => shopifyCheck(db, "no_encontrado", "2026-10-12T10:00:00.000Z"), OFERTA],
    ["un motivo que no es de Shopify (el tope) no lo frena", (db) => shopifyCheck(db, "tope", "2026-10-14T19:30:00.000Z"), OFERTA],
    ["el RUC pasó a Real: ahí emite el barrido", (db) => (issuerRow(db).mode = "real"), null],
    ["el RUC pasó a Simulación", (db) => (issuerRow(db).mode = "simulacion"), null],
    [
      "cambió el RUC del pedido: su cuenta ahora es de un RUC en Real (la simulada sigue siendo del de Manual)",
      (db) => (otroRuc(db, "real"), (db.t("store_collection_accounts").find((a) => a.id === "acc-flow")!.invoice_issuer_id = ISS2)),
      null,
    ],
    [
      "cambió el RUC del pedido a otro también en Manual: sale con el RUC nuevo, el que se enviaría",
      (db) => (otroRuc(db, "manual"), (db.t("store_collection_accounts").find((a) => a.id === "acc-flow")!.invoice_issuer_id = ISS2)),
      { ...OFERTA, issuerId: ISS2, ruc: RUC_OTRO, legalName: "OTRA RAZÓN SOCIAL S.A.C." },
    ],
    ["la tienda está pausada", (db) => (db.t("stores")[0]!.status = "paused"), null],
  ];

  it.each(casos)("%s", async (_label, arrange, esperado) => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    simulada(db, "ord-1");
    arrange(db);
    const offers = await loadInvoiceEmitNowOffers(db.admin, ["ord-1"]);
    expect(offers.get("ord-1") ?? null).toEqual(esperado);
    // Y es exactamente lo que diría el drawer del mismo pedido.
    expect(offers.get("ord-1") ?? null).toEqual(await drawer(db, "ord-1"));
    // Preguntar no escribe ni llama a nada.
    expect(writes(db)).toEqual([]);
    expect(db.rpcLog).toEqual([]);
  });

  it("los pedidos de la lista se leen de una vez: una lectura de pedidos y de revisiones para todos", async () => {
    const db = world({ mode: "manual" });
    addOrder(db, 1);
    addOrder(db, 2, { total: 800 });
    simulada(db, "ord-1");
    simulada(db, "ord-2");
    const offers = await loadInvoiceEmitNowOffers(db.admin, ["ord-1", "ord-2", "ord-404", "ord-1"]);
    expect([...offers]).toEqual([["ord-1", OFERTA]]);
    const ordersReads = db.log.filter((q) => q.table === "orders");
    expect(ordersReads).toHaveLength(1);
    expect(has(ordersReads[0]!, "in", "id", ["ord-1", "ord-2", "ord-404"])).toBe(true);
    expect(db.log.filter((q) => q.table === "invoice_order_checks")).toHaveLength(1);
    expect(db.log.filter((q) => q.table === "order_payments")).toHaveLength(1);
  });

  it.each(["invoice_order_checks", "order_invoices", "order_payments", "stores", "invoice_issuers"])(
    "FALLA CERRADA: si no se puede leer %s, lanza (Ajustes no ofrece ningún botón)",
    async (table) => {
      const db = world({ mode: "manual" });
      addOrder(db, 1);
      simulada(db, "ord-1");
      db.failWhen.push((q) => q.table === table);
      await expect(loadInvoiceEmitNowOffers(db.admin, ["ord-1"])).rejects.toThrow(table);
    },
  );

  it("sin pedidos no lee nada", async () => {
    const db = world({ mode: "manual" });
    expect(await loadInvoiceEmitNowOffers(db.admin, [])).toEqual(new Map());
    expect(db.log).toEqual([]);
  });
});

// ── Lo pagado antes de «Emitir desde», con el botón (owner, 15-10-2026) ──────

describe("emitInvoiceNow: lo pagado antes de «Emitir desde» sale con el botón y la casilla «Revisé en SimpleFact…» (§35.3, §35.7)", () => {
  const OWNER = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  /** Pagado el 10/10/2026 10:00 de Lima: después del 01/10 y antes de «Emitir desde» (14/10). */
  const ANTES = "2026-10-10T15:00:00.000Z";
  /** Lo que confirmó la persona, con la casilla marcada. */
  const REVISADO = { issuerId: ISS, totalCents: 15_000, simplefactChecked: true };
  const emit = (
    db: Db,
    deps: ReturnType<typeof makeDeps>,
    input: Partial<Parameters<typeof emitInvoiceNow>[1]> = {},
  ) => {
    db.clock.now = deps.now();
    return emitInvoiceNow(db.admin, { orderId: "ord-1", userId: OWNER, manualOnly: true, expected: REVISADO, ...input }, deps);
  };
  /** Ni el token, ni Shopify, ni el turno, ni SimpleFact, ni una fila. */
  const nadaDeNada = (db: Db, deps: ReturnType<typeof makeDeps>) => {
    expect(deps.decryptToken).not.toHaveBeenCalled();
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
    expect(deps.createSale).not.toHaveBeenCalled();
    expect(db.t("order_invoices")).toEqual([]);
  };
  const deAntes = (mode: "manual" | "real" = "manual", registeredAt = ANTES) => {
    const db = world({ mode });
    addOrder(db, 1, { registeredAt });
    return db;
  };
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sin la casilla: `sin_revision_simplefact`, sin token, sin Shopify, sin turno y sin POST", async () => {
    for (const expected of [
      { issuerId: ISS, totalCents: 15_000 },
      { issuerId: ISS, totalCents: 15_000, simplefactChecked: false },
      // Solo un `true` de verdad cuenta.
      { issuerId: ISS, totalCents: 15_000, simplefactChecked: "true" },
      { issuerId: ISS, totalCents: 15_000, simplefactChecked: 1 },
    ]) {
      const db = deAntes();
      const deps = makeDeps();
      expect(await emit(db, deps, { expected: expected as never }), JSON.stringify(expected)).toEqual({
        ok: false,
        reason: "sin_revision_simplefact",
      });
      nadaDeNada(db, deps);
    }
  });

  it("sin `expected` (no es el botón): tampoco sale, aunque el RUC esté en Manual", async () => {
    const db = deAntes();
    const deps = makeDeps();
    expect(await emit(db, deps, { manualOnly: undefined, expected: undefined })).toEqual({
      ok: false,
      reason: "sin_revision_simplefact",
    });
    nadaDeNada(db, deps);
  });

  it("lo que cambió va primero: si confirmó otro total, `pedido_cambio`, con o sin la casilla", async () => {
    const db = deAntes();
    const deps = makeDeps();
    expect(await emit(db, deps, { expected: { ...REVISADO, totalCents: 14_000 } })).toEqual({
      ok: false,
      reason: "pedido_cambio",
    });
    nadaDeNada(db, deps);
  });

  it("con la casilla: el turno va con `p_backfill: true`, un solo POST, y la fila lo anota", async () => {
    const db = deAntes();
    const deps = makeDeps();
    expect(await emit(db, deps)).toMatchObject({ ok: true, status: "emitida", serie: "B001" });
    expect(claims(db)).toHaveLength(1);
    expect(claims(db)[0]!.args).toMatchObject({
      p_paid_at: ANTES,
      p_mode: "real",
      p_created_by: OWNER,
      p_backfill: true,
    });
    expect(deps.createSale).toHaveBeenCalledTimes(1);
    expect(invoice(db, "ord-1")).toMatchObject({
      mode: "real",
      status: "emitida",
      created_by: OWNER,
      basis: { pagado_antes_de_emitir_desde: true },
    });
  });

  it("un pedido pagado desde «Emitir desde» no manda `p_backfill`, ni en false", async () => {
    const db = deAntes("manual", PAGADO);
    const deps = makeDeps();
    // Con la casilla marcada de más, tampoco: no es de antes.
    expect(await emit(db, deps)).toMatchObject({ ok: true, status: "emitida" });
    expect("p_backfill" in claims(db)[0]!.args).toBe(false);
    expect(invoice(db, "ord-1")!.basis).not.toHaveProperty("pagado_antes_de_emitir_desde");
  });

  it("sin la 0269: lo normal se sigue emitiendo; uno de antes dice `sin_migracion` con la 0269, sin fila ni POST", async () => {
    expect(INVOICE_CLAIM_BACKFILL_MIGRATION).toBe("0269");
    // Lo normal no manda `p_backfill`: el turno de once argumentos lo atiende.
    const normal = deAntes("manual", PAGADO);
    normal.state.sin0269 = true;
    expect(await emit(normal, makeDeps())).toMatchObject({ ok: true, status: "emitida" });
    // Uno de antes, sí: y no se reserva ni se envía nada.
    const db = deAntes();
    db.state.sin0269 = true;
    const deps = makeDeps();
    expect(await emit(db, deps)).toEqual({
      ok: false,
      reason: "sin_migracion",
      detail: "Falta aplicar la migración 0269 de comprobantes (invoice_claim con p_backfill).",
    });
    expect(claims(db)).toHaveLength(1);
    expect(db.t("order_invoices")).toEqual([]);
    expect(deps.createSale).not.toHaveBeenCalled();
  });

  it("antes del 01/10/2026 00:00 de Lima, ni con la casilla: `antes_de_inicio`, sin turno", async () => {
    const db = deAntes("manual", "2026-10-01T04:59:59.999Z");
    const deps = makeDeps();
    expect(await emit(db, deps)).toEqual({ ok: false, reason: "antes_de_inicio" });
    nadaDeNada(db, deps);
    // Justo en el piso, sí.
    const enElPiso = deAntes("manual", "2026-10-01T05:00:00.000Z");
    expect(await emit(enElPiso, makeDeps())).toMatchObject({ ok: true, status: "emitida" });
    expect(claims(enElPiso)[0]!.args).toMatchObject({ p_backfill: true });
  });

  it("con el RUC en Real no hay excepción: `antes_de_inicio`, también sin `manualOnly`", async () => {
    for (const manualOnly of [true, undefined]) {
      const db = deAntes("real");
      const deps = makeDeps();
      expect(await emit(db, deps, { manualOnly }), String(manualOnly)).toEqual({ ok: false, reason: "antes_de_inicio" });
      nadaDeNada(db, deps);
    }
  });

  it("los demás candados siguen: un comprobante real vivo da `ya_tiene` antes de pedir la casilla", async () => {
    const db = deAntes();
    db.t("order_invoices").push({ id: "ya", order_id: "ord-1", issuer_id: ISS, mode: "real", status: "externa", created_at: NOW.toISOString() });
    const deps = makeDeps();
    expect(await emit(db, deps, { expected: { issuerId: ISS, totalCents: 15_000 } })).toEqual({ ok: false, reason: "ya_tiene" });
    expect(claims(db)).toEqual([]);
    expect(deps.createSale).not.toHaveBeenCalled();
  });

  it("el barrido nunca va hacia atrás: ni en Manual ni en Real pide el turno con `p_backfill`, ni guarda `sin_revision_simplefact`", async () => {
    for (const mode of ["manual", "real"] as const) {
      const db = deAntes(mode);
      addOrder(db, 2);
      const deps = makeDeps();
      await sweep(db, deps);
      // El de antes ni es candidato; el de hoy sí.
      expect(claims(db).map((c) => c.args.p_order), mode).toEqual(["ord-2"]);
      expect(claims(db).some((c) => "p_backfill" in c.args), mode).toBe(false);
      expect(invoice(db, "ord-1"), mode).toBeUndefined();
      expect(db.t("invoice_order_checks").map((c) => c.reason), mode).not.toContain("sin_revision_simplefact");
    }
  });

  it("el «Emitir» de Ajustes y el drawer lo ofrecen igual, diciendo que es de antes y las dos fechas", async () => {
    const db = deAntes();
    db.t("order_invoices").push({
      id: "sim-ord-1",
      order_id: "ord-1",
      store_id: STORE,
      issuer_id: ISS,
      mode: "simulacion",
      status: "simulada",
      created_at: "2026-10-12T19:00:00.000Z",
    });
    const oferta = {
      issuerId: ISS,
      ruc: RUC_GF,
      legalName: "GRUPO GF S.A.C.",
      total: 150,
      beforeStart: true,
      paidAt: ANTES,
      firstPaidAt: ANTES,
      emitFrom: DESDE,
    };
    expect((await loadInvoiceEmitNowOffers(db.admin, ["ord-1"])).get("ord-1")).toEqual(oferta);
    const facts = (await loadInvoiceOrderFacts(db.admin, ["ord-1"])).get("ord-1")!;
    expect(invoiceEmitNowReadiness({ facts, invoices: [], checks: [], storeActive: true })).toEqual({ ok: true, offer: oferta });
    // Una fecha con otra escritura sale en ISO.
    issuerRow(db).emit_from = "2026-10-14T00:00:00-05:00";
    expect((await loadInvoiceEmitNowOffers(db.admin, ["ord-1"])).get("ord-1")).toMatchObject({ emitFrom: DESDE });
    // En Real, ni de antes ni de después hay botón; antes del piso, tampoco.
    issuerRow(db).mode = "real";
    expect((await loadInvoiceEmitNowOffers(db.admin, ["ord-1"])).size).toBe(0);
    issuerRow(db).mode = "manual";
    db.t("order_payments")[0]!.registered_at = "2026-09-30T12:00:00.000Z";
    expect((await loadInvoiceEmitNowOffers(db.admin, ["ord-1"])).size).toBe(0);
    // Ni cuando el comprobante dice que la plata se movió antes del piso,
    // aunque se registrara después.
    db.t("order_payments")[0]!.registered_at = ANTES;
    db.t("order_payments")[0]!.paid_at = "2026-09-29T15:00:00.000Z";
    expect((await loadInvoiceEmitNowOffers(db.admin, ["ord-1"])).size).toBe(0);
    // Con el comprobante del 08/10, sí, y la oferta dice desde cuándo buscar.
    db.t("order_payments")[0]!.paid_at = "2026-10-08T23:05:00.000Z";
    expect((await loadInvoiceEmitNowOffers(db.admin, ["ord-1"])).get("ord-1")).toEqual({
      ...oferta,
      firstPaidAt: "2026-10-08T23:05:00.000Z",
    });
  });

  it("el piso cuenta desde el primer dinero: un comprobante del 29/09 registrado el 10/10 no sale, ni con la casilla", async () => {
    // Lo que dice el comprobante (`paid_at`) es anterior al 01/10 de Lima: la
    // plata se movió cuando las boletas se emitían a mano.
    for (const receiptAt of ["2026-09-29T15:00:00.000Z", "2026-10-01T04:59:59.999Z"]) {
      const db = world({ mode: "manual" });
      addOrder(db, 1, { registeredAt: ANTES, receiptAt });
      const deps = makeDeps();
      expect(await emit(db, deps), receiptAt).toEqual({ ok: false, reason: "antes_de_inicio" });
      nadaDeNada(db, deps);
    }
    // Sin fecha de comprobante cuenta el registro; un comprobante posterior al
    // registro no corre la fecha: cuenta la más temprana de las dos.
    for (const receiptAt of [null, "2026-10-12T15:00:00.000Z", "2026-10-01T05:00:00.000Z"]) {
      const db = world({ mode: "manual" });
      addOrder(db, 1, { registeredAt: "2026-10-05T15:00:00.000Z", receiptAt });
      const deps = makeDeps();
      expect(await emit(db, deps), String(receiptAt)).toMatchObject({ ok: true, status: "emitida" });
      expect(claims(db)[0]!.args, String(receiptAt)).toMatchObject({ p_backfill: true });
    }
    // Un pedido pagado desde «Emitir desde» no mira el comprobante: la
    // condición 8 no cambia.
    const despues = world({ mode: "manual" });
    addOrder(despues, 1, { registeredAt: PAGADO, receiptAt: "2026-09-29T15:00:00.000Z" });
    expect(await emit(despues, makeDeps())).toMatchObject({ ok: true, status: "emitida" });
    expect("p_backfill" in claims(despues)[0]!.args).toBe(false);
  });

  it("el turno también mide el primer dinero: si el código se equivocara, la base no da la fila", async () => {
    // El código ve un pago del 10/10 sin comprobante; la base, al pedir el
    // turno, ya tiene la fecha del comprobante del 29/09 (se leyó tarde).
    const db = deAntes();
    const deps = makeDeps();
    deps.fetchOrder.mockImplementationOnce(async (input) => {
      db.t("order_payments")[0]!.paid_at = "2026-09-29T15:00:00.000Z";
      return okRead(input.shopifyOrderId);
    });
    expect(await emit(db, deps)).toMatchObject({ ok: false, reason: "antes_de_inicio" });
    expect(claims(db)).toHaveLength(1);
    expect(db.t("order_invoices")).toEqual([]);
    expect(deps.createSale).not.toHaveBeenCalled();
  });

  describe("con «Emitir desde» en el futuro (Ajustes lo acepta), nada pagado antes de él sale, ni con el botón", () => {
    /** «Emitir desde» el 20/10/2026 00:00 de Lima: después de hoy (NOW, el 14/10). */
    const EL_20 = "2026-10-20T05:00:00.000Z";
    beforeEach(() => {
      // Las reglas miran el reloj de ahora (`invoiceEligibility` sin `now`); la
      // base, el de `deps.now()`. Los dos, el mismo.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("ni con la casilla: `antes_de_inicio`, sin token, sin Shopify, sin turno y sin POST; y sin botón en el panel ni en Ajustes", async () => {
      // Pagado el 10/10 (desde el piso) y pagado hoy, después del cambio: los dos
      // son de antes del 20/10, y ninguno se adelanta.
      for (const registeredAt of [ANTES, PAGADO]) {
        const db = deAntes("manual", registeredAt);
        issuerRow(db).emit_from = EL_20;
        const deps = makeDeps();
        expect(await emit(db, deps), registeredAt).toEqual({ ok: false, reason: "antes_de_inicio" });
        nadaDeNada(db, deps);
        db.t("order_invoices").push({
          id: "sim-ord-1",
          order_id: "ord-1",
          store_id: STORE,
          issuer_id: ISS,
          mode: "simulacion",
          status: "simulada",
          created_at: "2026-10-14T19:00:00.000Z",
        });
        expect((await loadInvoiceEmitNowOffers(db.admin, ["ord-1"])).size, registeredAt).toBe(0);
        const facts = (await loadInvoiceOrderFacts(db.admin, ["ord-1"])).get("ord-1")!;
        expect(invoiceEmitNowReadiness({ facts, invoices: [], checks: [], storeActive: true }), registeredAt).toMatchObject({
          ok: false,
          rules: { reason: "antes_de_inicio" },
        });
      }
    });

    it("cuando «Emitir desde» llega, lo de antes ya sale con el botón y la casilla", async () => {
      vi.setSystemTime(new Date(EL_20));
      const db = deAntes();
      issuerRow(db).emit_from = EL_20;
      const deps = makeDeps({ now: () => new Date(EL_20) });
      expect(await emit(db, deps)).toMatchObject({ ok: true, status: "emitida" });
      expect(claims(db)[0]!.args).toMatchObject({ p_backfill: true, p_created_by: OWNER });
      expect(invoice(db, "ord-1")).toMatchObject({ basis: { pagado_antes_de_emitir_desde: true } });
    });

    it("el turno también lo mide: si «Emitir desde» pasó al futuro mientras se leía Shopify, la base no da la fila", async () => {
      // Las reglas vieron «Emitir desde» el 14/10, ya llegado; el owner lo movió
      // al 20/10 en Ajustes antes del turno. La base lo lee bajo el candado.
      const db = deAntes();
      const deps = makeDeps();
      deps.fetchOrder.mockImplementationOnce(async (input) => {
        issuerRow(db).emit_from = EL_20;
        return okRead(input.shopifyOrderId);
      });
      expect(await emit(db, deps)).toEqual({ ok: false, reason: "antes_de_inicio" });
      expect(claims(db)).toHaveLength(1);
      expect(claims(db)[0]!.args).toMatchObject({ p_backfill: true });
      expect(db.t("order_invoices")).toEqual([]);
      expect(deps.createSale).not.toHaveBeenCalled();
    });
  });
});

describe("runInvoiceSweep: una boleta leída de la foto del pedido (MOM §35.10)", () => {
  // Shopify cierra Kenku y Aurela el 28-10-2026; `fetchOrderForInvoice` lee la
  // foto que se tomó mientras Shopify respondía. La boleta sale igual, y su base
  // (`order_invoices.basis`) deja dicho de qué foto salió.
  it("pide el turno con la hora de la foto en la base; lo demás, igual", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    const deps = makeDeps();
    const live = okRead("shp-1") as Extract<InvoiceOrderRead, { ok: true }>;
    deps.fetchOrder.mockResolvedValue({ ...live, snapshot: { fetchedAt: "2026-10-26T20:04:31.000Z" } });
    await sweep(db, deps);
    expect(claims(db)).toHaveLength(1);
    expect(claims(db)[0]!.args.p_basis).toEqual({
      prepaid: false,
      payments: [{ id: "pay-1", amount: 150, source: "flow", accountIds: ["acc-flow"], validatedAt: PAGADO }],
      foto_shopify: "2026-10-26T20:04:31.000Z",
    });
    expect(invoice(db, "ord-1")).toMatchObject({ status: "simulada" });
  });

  it("leída en vivo, la base no lleva la marca", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    await sweep(db, makeDeps());
    expect(claims(db)[0]!.args.p_basis).not.toHaveProperty("foto_shopify");
  });
});

describe("runInvoiceSweep y emitInvoiceNow: un pedido de WooCommerce (MOM §35.11)", () => {
  // La plataforma la dice `orders.platform`, nunca la forma del id: un pedido de
  // WooCommerce se relee en WooCommerce y su base lo deja dicho; uno de Shopify
  // se pide exactamente como antes, sin `platform`.
  const OWNER = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const LEIDO = "2026-10-14T19:59:00.000Z";
  const VIO = { issuerId: ISS, totalCents: 15_000 };

  function addWooOrder(db: Db, n: number, o: OrderOpts = {}): string {
    const id = addOrder(db, n, o);
    const row = db.t("orders").find((r) => r.id === id)!;
    row.platform = "woocommerce";
    row.shopify_order_id = `wc-aur-${11000 + n}`;
    row.name = `#AUR90000${n}`;
    return id;
  }

  function wooRead(input: { shopifyOrderId: string }, totalCents = 15_000): InvoiceOrderRead {
    return {
      ok: true,
      orderGid: input.shopifyOrderId,
      name: "#AUR900001",
      totalCents,
      items: [{ code: "36710849", name: "Bividi Camiseta de Alta Compresión", qty: 1, priceCents: totalCents }],
      payment: {
        financialStatus: "processing",
        gatewayNames: ["Pago contra entrega"],
        paidCents: 0,
        otherPaidCents: 0,
        netPaymentCents: 0,
        outstandingCents: totalCents,
      },
      woocommerce: { readAt: LEIDO },
    };
  }

  it("el barrido lo pide con `platform: \"woocommerce\"` y la base del comprobante dice de dónde salió", async () => {
    const db = world({ mode: "simulacion" });
    addWooOrder(db, 1);
    addOrder(db, 2);
    const deps = makeDeps();
    deps.fetchOrder.mockImplementation(async (input) =>
      input.platform === "woocommerce" ? wooRead(input) : okRead(input.shopifyOrderId),
    );
    await sweep(db, deps);
    expect(deps.fetchOrder).toHaveBeenCalledWith({ storeId: STORE, shopifyOrderId: "wc-aur-11001", platform: "woocommerce" });
    // El de Shopify, exactamente como siempre: sin `platform`.
    expect(deps.fetchOrder).toHaveBeenCalledWith({ storeId: STORE, shopifyOrderId: "shp-2" });
    const byOrder = new Map(claims(db).map((c) => [c.args.p_order, c.args]));
    expect(byOrder.get("ord-1")!.p_basis).toEqual({
      prepaid: false,
      payments: [{ id: "pay-1", amount: 150, source: "flow", accountIds: ["acc-flow"], validatedAt: PAGADO }],
      plataforma: "woocommerce",
      lectura_woocommerce: LEIDO,
    });
    expect(byOrder.get("ord-2")!.p_basis).not.toHaveProperty("plataforma");
    expect(byOrder.get("ord-2")!.p_basis).not.toHaveProperty("lectura_woocommerce");
    expect(invoice(db, "ord-1")).toMatchObject({ status: "simulada" });
    // La boleta lleva el nombre del pedido de Kapta y los ítems de WooCommerce.
    expect(JSON.stringify(byOrder.get("ord-1")!.p_request)).toContain("#AUR900001");
    expect(JSON.stringify(byOrder.get("ord-1")!.p_request)).toContain("Bividi Camiseta de Alta Compresión");
  });

  it("el total de WooCommerce distinto del de Kapta no sale, y el detalle nombra a WooCommerce", async () => {
    const db = world({ mode: "simulacion" });
    addWooOrder(db, 1);
    const deps = makeDeps();
    deps.fetchOrder.mockImplementation(async (input) => wooRead(input, 14_000));
    await sweep(db, deps);
    expect(claims(db)).toEqual([]);
    expect(check(db, "ord-1", "simulacion")).toMatchObject({
      reason: "total_distinto",
      detail: "WooCommerce dice S/ 140.00; Kapta, S/ 150.00.",
    });
  });

  it("un prepago web de WooCommerce no sale solo: `pago_web_no_confirmado`, con el porqué", async () => {
    const db = world({ mode: "simulacion" });
    addWooOrder(db, 1, { prepaid: true });
    const deps = makeDeps();
    deps.fetchOrder.mockImplementation(async (input) => wooRead(input));
    await sweep(db, deps);
    expect(deps.fetchOrder).toHaveBeenCalledTimes(1);
    expect(claims(db)).toEqual([]);
    expect(check(db, "ord-1", "simulacion")).toMatchObject({
      reason: "pago_web_no_confirmado",
      detail: WOO_PREPAID_UNCONFIRMED_DETAIL,
    });
  });

  it("sin las claves de WooCommerce, `sin_claves_woo`: no se relee en 6 horas, como `sin_token_shopify`", async () => {
    const db = world({ mode: "simulacion" });
    addWooOrder(db, 1);
    const deps = makeDeps();
    deps.fetchOrder.mockResolvedValue({ ok: false, reason: "sin_claves_woo" });
    await sweep(db, deps);
    expect(check(db, "ord-1", "simulacion")).toMatchObject({ reason: "sin_claves_woo" });
    expect(SHOPIFY_LEVEL_REASONS.has("sin_claves_woo")).toBe(true);
    expect(shopifyBlockedReasons()).toContain("sin_claves_woo");
  });

  describe("«Emitir esta boleta»", () => {
    beforeEach(() => {
      vi.stubEnv("VERCEL_ENV", "production");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });
    const emit = (db: Db, deps: ReturnType<typeof makeDeps>) => {
      db.clock.now = deps.now();
      return emitInvoiceNow(db.admin, { orderId: "ord-1", userId: OWNER, manualOnly: true, expected: VIO }, deps);
    };

    it("la misma emisión real, con la lectura de WooCommerce en la base", async () => {
      const db = world({ mode: "manual" });
      addWooOrder(db, 1);
      const deps = makeDeps();
      deps.fetchOrder.mockImplementation(async (input) => wooRead(input));
      expect(await emit(db, deps)).toMatchObject({ ok: true, status: "emitida" });
      expect(deps.fetchOrder).toHaveBeenCalledWith({ storeId: STORE, shopifyOrderId: "wc-aur-11001", platform: "woocommerce" });
      expect(claims(db)[0]!.args.p_basis).toMatchObject({ plataforma: "woocommerce", lectura_woocommerce: LEIDO });
      expect(deps.createSale).toHaveBeenCalledTimes(1);
    });

    it("si la lectura de WooCommerce lo frena, el motivo lleva la plataforma y no sale nada", async () => {
      const db = world({ mode: "manual" });
      addWooOrder(db, 1);
      const deps = makeDeps();
      const detail = "El detalle suma S/ 1.00; WooCommerce dice S/ 2.00.";
      deps.fetchOrder.mockResolvedValue({ ok: false, reason: "no_cuadra", detail });
      expect(await emit(db, deps)).toEqual({ ok: false, reason: "no_cuadra", detail, platform: "woocommerce" });
      expect(claims(db)).toEqual([]);
      expect(deps.createSale).not.toHaveBeenCalled();
    });

    it("uno de Shopify frenado igual no lleva plataforma: lo de siempre", async () => {
      const db = world({ mode: "manual" });
      addOrder(db, 1);
      const deps = makeDeps();
      deps.fetchOrder.mockResolvedValue({ ok: false, reason: "editado" });
      expect(await emit(db, deps)).toEqual({ ok: false, reason: "editado" });
      expect(deps.fetchOrder).toHaveBeenCalledWith({ storeId: STORE, shopifyOrderId: "shp-1" });
    });
  });

  it("los hechos de un pedido de Shopify no cambian: sin `platform`", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    addWooOrder(db, 2);
    const facts = await loadInvoiceOrderFacts(db.admin, ["ord-1", "ord-2"]);
    expect(facts.get("ord-1")).not.toHaveProperty("platform");
    expect(facts.get("ord-2")).toMatchObject({ platform: "woocommerce" });
    expect(db.log.some((q) => q.table === "orders" && (q.cols ?? "").split(",").includes("platform"))).toBe(true);
  });

  it("sin la 0274 (no hay `orders.platform`), se leen sin ella y todos son de Shopify", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    db.errorWhen.push((q) =>
      q.table === "orders" && (q.cols ?? "").split(",").includes("platform")
        ? { code: "42703", message: "column orders.platform does not exist" }
        : null,
    );
    const deps = makeDeps();
    await sweep(db, deps);
    expect(deps.fetchOrder).toHaveBeenCalledWith({ storeId: STORE, shopifyOrderId: "shp-1" });
    expect(claims(db)).toHaveLength(1);
  });

  it("cualquier otro error al leer los pedidos frena: no se relee ni se emite nada", async () => {
    const db = world({ mode: "simulacion" });
    addOrder(db, 1);
    db.errorWhen.push((q) => (q.table === "orders" ? { code: "XX000", message: "platform: se cayó" } : null));
    const deps = makeDeps();
    const report = await sweep(db, deps);
    expect(deps.fetchOrder).not.toHaveBeenCalled();
    expect(claims(db)).toEqual([]);
    expect(report.errors.length).toBeGreaterThan(0);
  });
});
