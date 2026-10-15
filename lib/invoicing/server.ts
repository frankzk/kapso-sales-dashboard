// Comprobantes electrónicos por RUC — la base y el barrido (MOM §35).
//
// Lo que DECIDE está en lib/invoicing/rules.ts (puro). Aquí se juntan los hechos
// de cada pedido (pagos, cuentas, estado de cuenta Yape, links de Flow, RUC y
// comprobantes previos), se vuelve a leer el pedido en Shopify, se pide el turno
// en la base (`invoice_claim`, 0257) y se llama a SimpleFact. Después se
// concilia lo que quedó sin respuesta.
//
// Tres cosas mandan sobre este módulo:
//
//  1. FALLA CERRADA. Si no se pudo leer algo —pagos, cuentas, el estado de
//     cuenta, los links de Flow, los comprobantes previos, Shopify—, el pedido
//     no se emite en esa pasada (§35.3). `loadInvoiceOrderFacts` lanza ante
//     cualquier error de lectura en vez de devolver hechos a medias: un pago que
//     «no está» puede mandar la boleta al RUC equivocado.
//
//  2. EL TURNO ANTES DE LLAMAR. SimpleFact no tiene llave de idempotencia: la
//     misma venta mandada dos veces son dos boletas. `invoice_claim` deja la
//     fila en `emitiendo` ANTES del POST, y un envío sin respuesta queda
//     `en_duda`: se concilia buscando la nota «Kapta ‹ref›» en SimpleFact, nunca
//     se repite (el mismo criterio que `swayp_emission_claim`, 0209).
//
//  3. EL TOKEN NO SALE. Se descifra aquí, una vez por pasada y solo para un RUC
//     en real, y no va a ningún reporte, error ni log. `loadInvoiceIssuers` ni
//     siquiera trae el texto cifrado: dice si hay token con un booleano.
//
// SERVER-ONLY: usa el cliente service-role y `lib/crypto.ts`.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { limaDateKey } from "@/lib/aliclik-geo";
import { decrypt } from "@/lib/crypto";
import type { PaymentGateway } from "@/lib/payment-gateway";
import {
  INVOICE_MAX_PER_RUN,
  INVOICE_MODES,
  INVOICE_REASONS,
  LIVE_REAL_STATUSES,
  buildSalePayload,
  classifySaleResponse,
  findSaleByNote,
  invoiceEligibility,
  invoiceNoteRef,
  type InvoiceAccount,
  type InvoiceExisting,
  type InvoiceIssuer,
  type InvoiceMode,
  type InvoiceOrderFacts,
  type InvoicePayment,
  type InvoiceReason,
  type InvoiceWriteMode,
  type SimplefactSalePayload,
} from "@/lib/invoicing/rules";
import { fetchOrderForInvoice, webPrepaidConfirmed, type InvoiceOrderRead } from "@/lib/invoicing/shopify-order";
import {
  simplefactCreateSale,
  simplefactListSales,
  type SimplefactConn,
  type SimplefactHttp,
  type SimplefactListQuery,
} from "@/lib/invoicing/simplefact";

// ── Constantes ───────────────────────────────────────────────────────────────

/** De a cuántos ids se lee: el largo de la URL de PostgREST (como lib/order-master.ts). */
const ID_BATCH = 200;

/**
 * Candidatos por organización y modo en una pasada (`invoice_candidates`, 0258).
 * La base ya deja fuera lo resuelto —con comprobante real vivo o, en
 * simulación, con su simulación— y lo que Shopify bloqueó hace poco, así que el
 * límite es para lo que falta mirar: con ~26 pedidos pagados al día y los 60
 * días que mira la función, lo pendiente de verdad queda muy por debajo. Si
 * una lista llega al límite, el reporte lo dice (`lleno`).
 */
export const INVOICE_SWEEP_MAX_CANDIDATES = 500;

/**
 * Un pedido bloqueado por lo que dijo Shopify no se relee antes de 6 horas: el
 * barrido corre cada 10 minutos y releer en Shopify cada pedido editado, de
 * prueba o con propina gastaría la cuota de la API en lo mismo (§35.6).
 */
export const INVOICE_SHOPIFY_RECHECK_MS = 6 * 3_600_000;

/** Un `emitiendo` sin respuesta por más de esto se busca en SimpleFact. */
export const INVOICE_STALE_EMITTING_MS = 10 * 60_000;

/** La conciliación lee 100 ventas por página, hasta 5 páginas por día. */
export const INVOICE_RECONCILE_PAGE_SIZE = 100;
export const INVOICE_RECONCILE_MAX_PAGES = 5;

/** Lo que guarda el panel de un `emitiendo` que se buscó y no apareció. */
export const INVOICE_NOT_FOUND_ERROR = "Sin respuesta: se busca en SimpleFact";

/**
 * Lo que guarda un `emitiendo` que ninguna conciliación va a mirar (su RUC no
 * está en real o no tiene token, o es de antes de ayer) cuando pasa a
 * `en_duda`: la boleta puede existir, así que una persona la busca por su nota
 * antes de liberarla (§35.4).
 */
export function invoiceUnreconciledError(invoiceId: string): string {
  return `Sin respuesta de SimpleFact: búscala por su nota «${invoiceNoteRef(invoiceId)}» antes de liberarla`;
}

/** Cuántos `emitiendo` sin conciliación pasan a `en_duda` por pasada, del más viejo. */
export const INVOICE_UNRECONCILED_BATCH = 100;

/**
 * Los motivos que salen de la lectura del pedido en Shopify. Son los que el
 * barrido no relee antes de `INVOICE_SHOPIFY_RECHECK_MS`. `lectura_fallida` no
 * está a propósito: un corte de Shopify se reintenta en la próxima pasada.
 */
export const SHOPIFY_LEVEL_REASONS: ReadonlySet<InvoiceReason> = new Set<InvoiceReason>([
  "no_encontrado",
  "prueba",
  "editado",
  "cantidad_editada",
  "envio_editado",
  "propina",
  "gift_card",
  "linea_gratuita",
  "impuesto_encima",
  "demasiadas_lineas",
  "no_cuadra",
  "total_distinto",
  "pago_web_no_confirmado",
  "sin_token_shopify",
]);

/**
 * Motivos del turno que valen para todo el RUC, no para un pedido: el resto de
 * los pedidos de ese RUC tendría la misma respuesta en esta pasada.
 */
const ISSUER_WIDE_CLAIM_REASONS: ReadonlySet<InvoiceReason> = new Set<InvoiceReason>([
  "tope",
  "sin_conexion",
  "ruc_apagado",
  "ruc_ajeno",
]);

/**
 * Presupuesto de la pasada (la función tiene 60 s). Leer en Shopify cuesta
 * hasta 15 s y crear la venta hasta 25 s: un pedido nuevo no se empieza pasados
 * 20 s, y la conciliación no pide otra página pasados 40 s. Si aun así la
 * función se corta a mitad de un POST, la fila queda en `emitiendo` y la
 * conciliación de la próxima pasada la resuelve: nunca se repite.
 */
const ORDER_BUDGET_MS = 20_000;
const RECONCILE_BUDGET_MS = 40_000;

/** Lo que se guarda de la respuesta de SimpleFact: la lista entera no cabe en una fila. */
const RESPONSE_MAX_CHARS = 20_000;
const RESPONSE_RAW_CHARS = 2_000;

const DAY_MS = 86_400_000;

// ── Utilidades ───────────────────────────────────────────────────────────────

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * Un número de la base. null solo si no hay dato: un texto que no se entiende
 * queda NaN, y las reglas lo leen como «no se sabe» (un reembolso ilegible no
 * puede pasar por «sin reembolso»).
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const GATEWAYS: readonly PaymentGateway[] = ["checkout", "manual", "cod"];

function gatewayOf(value: unknown): PaymentGateway | null {
  return GATEWAYS.includes(value as PaymentGateway) ? (value as PaymentGateway) : null;
}

const REASONS = new Set<string>(INVOICE_REASONS);

function isReason(value: unknown): value is InvoiceReason {
  return typeof value === "string" && REASONS.has(value);
}

/** El log y el reporte no llevan celulares: un error de la base puede citar uno. */
function sinTelefonos(text: string): string {
  return text.replace(/(?<!\d)(?:\+?51[\s-]?)?9\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g, "[número]").slice(0, 300);
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

// ── Las migraciones de comprobantes todavía no están ─────────────────────────

/**
 * «La tabla o la función no existe»: Postgres (42P01, 42883) y PostgREST
 * (PGRST205, PGRST202: no está en su caché del esquema).
 */
const MISSING_SCHEMA_CODES: ReadonlySet<string> = new Set(["42P01", "42883", "PGRST205", "PGRST202"]);

/**
 * Lo que crean las migraciones de comprobantes, y cuál lo crea. La 0257 (las
 * tablas, la columna y el turno) ya corrió en producción y no se reescribe; la
 * 0258 trae `invoice_candidates` y vuelve a escribir el turno y los dos
 * candados. «No existe» solo es «falta una migración de comprobantes» si lo que
 * falta es uno de estos: una tabla de antes que desaparece (`orders`,
 * `order_payments`, `order_master` dentro de `invoice_candidates`…) es una base
 * rota, y tiene que verse en rojo, no pasar en verde como `sin_migracion`.
 */
export const INVOICE_MIGRATION_OBJECTS = {
  invoice_issuers: "0257",
  order_invoices: "0257",
  invoice_order_checks: "0257",
  invoice_claim: "0257",
  invoice_issuer_id: "0257",
  invoice_candidates: "0258",
} as const satisfies Record<string, "0257" | "0258">;

type InvoiceMigrationObject = keyof typeof INVOICE_MIGRATION_OBJECTS;

/** Un nombre de INVOICE_MIGRATION_OBJECTS como palabra entera (`order_invoices_old` no lo es). */
const INVOICE_MIGRATION_OBJECT = new RegExp(`\\b(?:${Object.keys(INVOICE_MIGRATION_OBJECTS).join("|")})\\b`);
const INVOICE_MIGRATION_OBJECT_ALL = new RegExp(INVOICE_MIGRATION_OBJECT.source, "g");

/**
 * Qué falta aplicar, por lo que nombra el error. Si todo lo que nombra es de la
 * 0258 (`invoice_candidates`), es la 0258: la 0257 está, porque sus tablas se
 * leyeron. Si nombra algo de la 0257, o nada, son las dos: la 0258 no se aplica
 * sin las tablas de la 0257.
 */
function missingInvoiceMigrations(text: string): string {
  const named = [...text.matchAll(INVOICE_MIGRATION_OBJECT_ALL)].map(
    (m) => INVOICE_MIGRATION_OBJECTS[m[0] as InvoiceMigrationObject],
  );
  return named.length > 0 && named.every((n) => n === "0258") ? "la migración 0258" : "las migraciones 0257 y 0258";
}

/**
 * Falta aplicar una migración de comprobantes. Esta rama se integra a main
 * desde otras sesiones y las migraciones se aplican a mano (DEPLOY.md): el
 * código puede llegar a producción antes que la base. Eso no es un error que
 * una persona tenga que mirar cada 10 minutos: el barrido lo reporta como
 * `skipped: "sin_migracion"` y no hace nada. `missing` es el texto que nombra lo
 * que falta (por defecto, `what`), y de él sale cuál migración se pide.
 */
export class InvoiceMigrationMissingError extends Error {
  constructor(what: string, missing: string = what) {
    super(`Falta aplicar ${missingInvoiceMigrations(missing)} de comprobantes (${what}).`);
    this.name = "InvoiceMigrationMissingError";
  }
}

/**
 * Si un error (de Supabase o lanzado aquí) dice que falta una migración de
 * comprobantes: un código de «no existe» cuyo mensaje o detalle nombra algo que
 * crean la 0257 o la 0258.
 *
 * El `hint` no se mira a propósito: PostgREST pone ahí lo que SÍ existe («Perhaps
 * you meant the table 'public.order_invoices'»). Que nombre una tabla de la 0257
 * prueba lo contrario: la 0257 está, y lo que falta es otra cosa.
 */
export function isInvoiceMigrationMissing(error: unknown): boolean {
  if (error instanceof InvoiceMigrationMissingError) return true;
  if (!error || typeof error !== "object") return false;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof code !== "string" || !MISSING_SCHEMA_CODES.has(code)) return false;
  return [message, details].some((text) => typeof text === "string" && INVOICE_MIGRATION_OBJECT.test(text));
}

/** El error de una lectura o escritura: «falta una migración», o el mensaje de la base. */
function dbError(what: string, error: { message: string; code?: string; details?: string | null }): Error {
  return isInvoiceMigrationMissing(error)
    ? new InvoiceMigrationMissingError(what, `${error.message} ${error.details ?? ""}`)
    : new Error(`${what}: ${error.message}`);
}

/** Los filtros extra de una lectura por lotes. */
interface InFilters {
  eq?: Record<string, string | boolean>;
  notNull?: string;
}

/**
 * `select cols from table where column in (ids…)`, por lotes. LANZA ante
 * cualquier error: quien llama decide no emitir, nunca emitir con lo que hubo.
 */
async function selectIn<T>(
  admin: SupabaseClient,
  table: string,
  cols: string,
  column: string,
  ids: string[],
  filters: InFilters = {},
): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk(unique(ids), ID_BATCH)) {
    let query = admin.from(table).select(cols).in(column, part);
    for (const [key, value] of Object.entries(filters.eq ?? {})) query = query.eq(key, value);
    if (filters.notNull) query = query.not(filters.notNull, "is", null);
    const { data, error } = await query;
    if (error) throw dbError(`No se pudo leer ${table}`, error);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

// ── Las empresas emisoras ────────────────────────────────────────────────────

const ISSUER_COLUMNS = "id,org_id,ruc,legal_name,mode,emit_from,daily_limit,checked_ruc";

interface IssuerRow {
  id: string;
  org_id: string;
  ruc: string;
  legal_name: string;
  mode: string;
  emit_from: string | null;
  daily_limit: number | string;
  checked_ruc: string | null;
}

function issuerFromRow(row: IssuerRow, withToken: Set<string>): InvoiceIssuer {
  return {
    id: row.id,
    orgId: row.org_id,
    ruc: row.ruc,
    legalName: row.legal_name,
    // Un modo que no se entiende no emite.
    mode: (INVOICE_MODES as readonly string[]).includes(row.mode) ? (row.mode as InvoiceMode) : "apagado",
    emitFrom: row.emit_from,
    dailyLimit: Number(row.daily_limit),
    hasToken: withToken.has(row.id),
    checkedRuc: row.checked_ruc,
  };
}

/**
 * Los RUC de varias organizaciones. Si tienen token se pregunta aparte, por
 * id: el texto cifrado no sale de la base por esta vía.
 */
async function loadIssuersOf(admin: SupabaseClient, orgIds: string[]): Promise<InvoiceIssuer[]> {
  const orgs = unique(orgIds.filter(Boolean));
  if (!orgs.length) return [];
  const rows = await selectIn<IssuerRow>(admin, "invoice_issuers", ISSUER_COLUMNS, "org_id", orgs);
  if (!rows.length) return [];
  const withToken = new Set(
    (await selectIn<{ id: string }>(admin, "invoice_issuers", "id", "org_id", orgs, { notNull: "token_enc" })).map(
      (r) => r.id,
    ),
  );
  return rows
    .map((row) => issuerFromRow(row, withToken))
    .sort((a, b) => a.legalName.localeCompare(b.legalName) || a.id.localeCompare(b.id));
}

/**
 * Las empresas emisoras de la organización, sin el token: solo `hasToken`.
 * Lanza si no se pudieron leer.
 */
export async function loadInvoiceIssuers(admin: SupabaseClient, orgId: string): Promise<InvoiceIssuer[]> {
  return loadIssuersOf(admin, [orgId]);
}

// ── Los hechos de cada pedido ────────────────────────────────────────────────

const ORDER_COLUMNS =
  "id,store_id,shopify_order_id,name,total_amount,currency,cancelled_at,total_refunded,financial_status,payment_gateway,processed_at,created_at";

interface OrderRow {
  id: string;
  store_id: string;
  shopify_order_id: string | null;
  name: string | null;
  total_amount: number | string | null;
  currency: string | null;
  cancelled_at: string | null;
  total_refunded: number | string | null;
  financial_status: string | null;
  payment_gateway: string | null;
  processed_at: string | null;
  created_at: string | null;
}

interface PaymentRow {
  id: string;
  order_id: string;
  kind: string;
  amount: number | string | null;
  validation_status: string;
  validated_at: string | null;
  registered_at: string | null;
  vision: unknown;
}

interface AccountRow {
  id: string;
  store_id: string;
  label: string;
  aliases: string[] | null;
  phone_last_digits: string | null;
  invoice_issuer_id: string | null;
}

interface InvoiceRow {
  order_id: string;
  mode: string;
  status: string;
  retry_requested_at: string | null;
  created_at: string;
}

/** Lo que hay en Kapta de comprobantes para un pedido (§35.3, condiciones 9 y 10). */
export function invoiceExistingFrom(rows: InvoiceRow[]): InvoiceExisting {
  const real = rows
    .filter((r) => r.mode === "real")
    .sort((a, b) => (time(b.created_at) ?? 0) - (time(a.created_at) ?? 0));
  const latest = real[0];
  return {
    realLive: real.some((r) => (LIVE_REAL_STATUSES as readonly string[]).includes(r.status)),
    simulated: rows.some((r) => r.mode === "simulacion"),
    errorBlocked: !!latest && latest.status === "error" && !latest.retry_requested_at,
  };
}

interface LoadedOrder {
  facts: InvoiceOrderFacts;
  shopifyOrderId: string | null;
}

async function loadOrders(admin: SupabaseClient, orderIds: string[]): Promise<Map<string, LoadedOrder>> {
  const out = new Map<string, LoadedOrder>();
  const ids = unique(orderIds.filter(Boolean));
  if (!ids.length) return out;

  const orders = await selectIn<OrderRow>(admin, "orders", ORDER_COLUMNS, "id", ids);
  if (!orders.length) return out;
  const found = orders.map((o) => o.id);
  const storeIds = unique(orders.map((o) => o.store_id));

  const [stores, masters, payments, accounts, invoices] = await Promise.all([
    selectIn<{ id: string; org_id: string | null }>(admin, "stores", "id,org_id", "id", storeIds),
    // El nombre de la clienta solo sirve para reconocerlo en la nota de un Yape
    // (`yapeRecipientReading`): no se guarda ni sale en ningún reporte.
    selectIn<{ order_id: string; customer_name: string | null }>(
      admin,
      "order_master",
      "order_id,customer_name",
      "order_id",
      found,
    ),
    selectIn<PaymentRow>(
      admin,
      "order_payments",
      "id,order_id,kind,amount,validation_status,validated_at,registered_at,vision",
      "order_id",
      found,
    ),
    selectIn<AccountRow>(
      admin,
      "store_collection_accounts",
      "id,store_id,label,aliases,phone_last_digits,invoice_issuer_id",
      "store_id",
      storeIds,
      { eq: { active: true } },
    ),
    selectIn<InvoiceRow>(admin, "order_invoices", "order_id,mode,status,retry_requested_at,created_at", "order_id", found),
  ]);

  // A qué cuenta entró cada pago validado (§35.2, filas 1 y 2 de la tabla).
  const validatedIds = payments.filter((p) => p.validation_status === "validado").map((p) => p.id);
  const [flowLinks, matches] = await Promise.all([
    selectIn<{ payment_id: string | null }>(admin, "flowcl_payment_links", "payment_id", "payment_id", validatedIds),
    selectIn<{ payment_id: string; movement_key: string }>(
      admin,
      "yape_statement_matches",
      "payment_id,movement_key",
      "payment_id",
      validatedIds,
      { eq: { validated: true } },
    ),
  ]);
  const movements = await selectIn<{ movement_key: string; destination: string | null }>(
    admin,
    "yape_statement_movements",
    "movement_key,destination",
    "movement_key",
    matches.map((m) => m.movement_key),
  );
  const destinationByKey = new Map(movements.map((m) => [m.movement_key, m.destination]));
  const destinationByPayment = new Map<string, string | null>();
  for (const match of matches) {
    // La llave foránea lo garantiza; si igual faltara, no se adivina la cuenta.
    if (!destinationByKey.has(match.movement_key)) {
      throw new Error("No se pudo leer yape_statement_movements: falta el movimiento de un cruce validado");
    }
    destinationByPayment.set(match.payment_id, destinationByKey.get(match.movement_key) ?? null);
  }
  const flowLinked = new Set(flowLinks.map((l) => l.payment_id).filter((id): id is string => !!id));

  const orgByStore = new Map(stores.map((s) => [s.id, s.org_id]));
  const issuers = await loadIssuersOf(
    admin,
    stores.map((s) => s.org_id).filter((id): id is string => !!id),
  );

  const nameByOrder = new Map(masters.map((m) => [m.order_id, m.customer_name]));
  const paymentsByOrder = new Map<string, InvoicePayment[]>();
  for (const p of payments) {
    const list = paymentsByOrder.get(p.order_id) ?? [];
    list.push({
      id: p.id,
      kind: p.kind,
      amount: num(p.amount),
      validationStatus: p.validation_status,
      validatedAt: p.validated_at,
      // Cuándo quedó pagado el pedido sale del último pago REGISTRADO (§35.3,
      // condición 8): es la fecha que mira `invoice_candidates`.
      registeredAt: p.registered_at,
      vision: p.vision,
      flowLinked: flowLinked.has(p.id),
      statementDestination: destinationByPayment.get(p.id) ?? null,
    });
    paymentsByOrder.set(p.order_id, list);
  }
  // Ordenadas por id: si dos cuentas empatan en la lectura, gana siempre la
  // misma (la base no garantiza el orden).
  const accountsByStore = new Map<string, InvoiceAccount[]>();
  for (const a of [...accounts].sort((x, y) => x.id.localeCompare(y.id))) {
    const list = accountsByStore.get(a.store_id) ?? [];
    list.push({
      id: a.id,
      label: a.label,
      aliases: a.aliases ?? [],
      phoneLastDigits: a.phone_last_digits ?? null,
      issuerId: a.invoice_issuer_id ?? null,
    });
    accountsByStore.set(a.store_id, list);
  }
  const invoicesByOrder = new Map<string, InvoiceRow[]>();
  for (const row of invoices) {
    const list = invoicesByOrder.get(row.order_id) ?? [];
    list.push(row);
    invoicesByOrder.set(row.order_id, list);
  }

  for (const o of orders) {
    const orgId = orgByStore.get(o.store_id) ?? null;
    out.set(o.id, {
      shopifyOrderId: o.shopify_order_id,
      facts: {
        orderId: o.id,
        storeId: o.store_id,
        orderName: o.name,
        total: num(o.total_amount),
        currency: o.currency,
        cancelledAt: o.cancelled_at,
        totalRefunded: num(o.total_refunded),
        financialStatus: o.financial_status,
        paymentGateway: gatewayOf(o.payment_gateway),
        orderDate: o.processed_at ?? o.created_at,
        customerName: nameByOrder.get(o.id) ?? null,
        payments: paymentsByOrder.get(o.id) ?? [],
        accounts: accountsByStore.get(o.store_id) ?? [],
        // Una tienda sin organización no tiene RUC: el pedido sale `cuenta_sin_ruc`.
        issuers: orgId ? issuers.filter((i) => i.orgId === orgId) : [],
        existing: invoiceExistingFrom(invoicesByOrder.get(o.id) ?? []),
      },
    });
  }
  return out;
}

/**
 * Los hechos de cada pedido para `invoiceEligibility`, por lotes. Un pedido que
 * no existe no está en el mapa. LANZA si cualquier lectura falla: con un pago,
 * una cuenta o un comprobante previo de menos, la regla podría emitir.
 */
export async function loadInvoiceOrderFacts(
  admin: SupabaseClient,
  orderIds: string[],
): Promise<Map<string, InvoiceOrderFacts>> {
  const loaded = await loadOrders(admin, orderIds);
  return new Map([...loaded].map(([id, l]) => [id, l.facts]));
}

// ── El barrido ───────────────────────────────────────────────────────────────

/** Lo que el barrido toca fuera de la base. Las pruebas lo cambian por dobles. */
export interface InvoiceSweepDeps {
  fetchOrder: (input: { storeId: string; shopifyOrderId: string }) => Promise<InvoiceOrderRead>;
  createSale: (conn: SimplefactConn, payload: SimplefactSalePayload) => Promise<SimplefactHttp>;
  listSales: (conn: SimplefactConn, query: SimplefactListQuery) => Promise<SimplefactHttp>;
  decryptToken: (tokenEnc: string) => string;
  now: () => Date;
  randomUUID: () => string;
}

export interface InvoiceIssuerSweepReport {
  issuerId: string;
  ruc: string;
  mode: InvoiceWriteMode;
  simuladas: number;
  emitidas: number;
  en_duda: number;
  errores: number;
  conciliadas: number;
  /** En `?dry=1`: los que habrían pedido turno. */
  would_claim: number;
  /** Elegibles que quedaron para la próxima pasada: tope de la pasada, RUC detenido o sin tiempo. */
  pendientes: number;
  /** Por qué no se emitieron los pedidos de este RUC. Solo códigos. */
  reasons: Record<string, number>;
  /** Por qué este RUC dejó de emitir en esta pasada. */
  stopped: string | null;
}

export interface InvoiceOrgSweepReport {
  orgId: string;
  stores: number;
  candidates: number;
  /**
   * Los modos cuya lista de `invoice_candidates` vino llena: exactamente
   * `INVOICE_SWEEP_MAX_CANDIDATES` pedidos. La base la cortó, así que lo más
   * viejo pendiente no se miró en esta pasada (ni se mirará mientras lo de
   * arriba no se resuelva). No es un error, pero va en la línea del log del
   * cron para que se vea: `"lleno":{"real":true}`.
   */
  lleno: Partial<Record<InvoiceWriteMode, true>>;
  /**
   * Saltados por un motivo de Shopify de hace menos de 6 horas. La base ya no
   * devuelve los bloqueados en el modo que se pregunta (`invoice_candidates`):
   * aquí quedan los que Shopify bloqueó bajo el OTRO modo.
   */
  cached: number;
  /** Motivos de los pedidos cuyo RUC encendido no se llegó a saber (sin cuenta, RUC apagado…). */
  reasons: Record<string, number>;
  issuers: InvoiceIssuerSweepReport[];
}

/**
 * El reporte de una pasada. Sin datos de clientas: solo ids de organización y
 * de RUC, códigos de motivo y conteos. `errors` no vacío = algo que una persona
 * tiene que mirar (la ruta responde 502).
 */
export interface InvoiceSweepReport {
  dry: boolean;
  at: string;
  /**
   * sin_ruc_encendido → ningún RUC en simulación ni en real.
   * sin_migracion     → falta la 0257 o la 0258: no hay nada que barrer.
   */
  skipped?: "sin_ruc_encendido" | "sin_migracion";
  /**
   * `emitiendo` sin respuesta que ninguna conciliación iba a mirar y pasaron a
   * `en_duda` al empezar la pasada (solo fuera de `dry`).
   */
  sin_respuesta?: number;
  orgs: InvoiceOrgSweepReport[];
  errors: string[];
}

export function defaultInvoiceSweepDeps(admin: SupabaseClient): InvoiceSweepDeps {
  return {
    fetchOrder: (input) => fetchOrderForInvoice(input, { admin }),
    createSale: simplefactCreateSale,
    listSales: simplefactListSales,
    decryptToken: (tokenEnc) => decrypt(tokenEnc),
    now: () => new Date(),
    randomUUID: () => randomUUID(),
  };
}

/** Un RUC encendido dentro de la pasada. */
interface RunIssuer {
  id: string;
  ruc: string;
  mode: InvoiceWriteMode;
  emitFrom: string | null;
  report: InvoiceIssuerSweepReport;
  /** Comprobantes pedidos en esta pasada (o que se habrían pedido, en dry). */
  taken: number;
  stopped: string | null;
  /** La conexión, cargada la primera vez que se necesita. null = no se pudo. */
  conn?: SimplefactConn | null;
}

/**
 * Cómo dejó de emitir un RUC (además de los motivos del turno que valen para
 * todo el RUC). Los de `NO_RECONCILE` tampoco concilian: con el token rechazado,
 * de otro RUC o sin confirmar, o con SimpleFact pidiendo esperar, leer la lista
 * de ventas no sirve o empeora las cosas.
 */
const STOP = {
  max: "tope_de_la_pasada",
  apagado: "apagado",
  espera: "simplefact_pidio_esperar",
  enDuda: "en_duda",
  sinToken: "sin_token",
  base: "base",
  turno: "turno",
} as const;
const NO_RECONCILE = new Set<string>([STOP.apagado, STOP.espera, STOP.sinToken, "sin_conexion"]);

interface CheckRow {
  order_id: string;
  mode: string;
  reason: string;
  detail: string | null;
  issuer_id: string | null;
  checked_at: string;
}

interface PendingCheck {
  order_id: string;
  mode: InvoiceWriteMode;
  store_id: string;
  issuer_id: string | null;
  reason: InvoiceReason;
  detail: string | null;
}

const CLAIM_MODES: readonly InvoiceWriteMode[] = ["simulacion", "real"];

/** Quita los tokens de todo texto de un valor, llaves incluidas. */
function redactDeep(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[redact(k)] = redactDeep(v, redact);
    return out;
  }
  return value;
}

/** Lo que se guarda de lo que contestó SimpleFact: entero si es razonable, si no el comienzo. */
function storedResponse(res: SimplefactHttp, redact: (text: string) => string): unknown {
  const raw = res.body ?? (res.error ? { error: res.error } : null);
  if (raw === null || raw === undefined) return null;
  const body = redactDeep(raw, redact);
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    return { raw: "La respuesta no se pudo guardar." };
  }
  return text.length <= RESPONSE_MAX_CHARS ? body : { raw: text.slice(0, RESPONSE_RAW_CHARS), truncated: true };
}

function soles(cents: number): string {
  return (cents / 100).toFixed(2);
}

function emptyIssuerReport(i: { id: string; ruc: string; mode: InvoiceWriteMode }): InvoiceIssuerSweepReport {
  return {
    issuerId: i.id,
    ruc: i.ruc,
    mode: i.mode,
    simuladas: 0,
    emitidas: 0,
    en_duda: 0,
    errores: 0,
    conciliadas: 0,
    would_claim: 0,
    pendientes: 0,
    reasons: {},
    stopped: null,
  };
}

/**
 * Una pasada del barrido (MOM §35.3, §35.4): por cada organización con un RUC
 * en simulación o en real, revisa sus pedidos pagados, simula o emite, y
 * concilia lo que quedó sin respuesta. Antes, fuera de `dry`, pasa a `en_duda`
 * los `emitiendo` sin respuesta que ninguna conciliación va a mirar.
 *
 *   dry      → revisa, lee en Shopify y arma la boleta, pero no escribe nada en
 *              la base ni llama a SimpleFact (tampoco concilia).
 *   storeId  → solo esa tienda (y los RUC de su organización).
 *
 * No lanza por un problema de una organización: lo anota en `errors` y sigue
 * con la siguiente. Si falta la 0257 o la 0258, no hace nada y lo dice en
 * `skipped`.
 */
export async function runInvoiceSweep(
  admin: SupabaseClient,
  opts: { dry?: boolean; storeId?: string; deps?: Partial<InvoiceSweepDeps> } = {},
): Promise<InvoiceSweepReport> {
  const deps: InvoiceSweepDeps = { ...defaultInvoiceSweepDeps(admin), ...opts.deps };
  const dry = opts.dry === true;
  const now = deps.now();
  const started = Date.now();
  const report: InvoiceSweepReport = { dry, at: now.toISOString(), orgs: [], errors: [] };
  // Los tokens descifrados en esta pasada. Todo texto que sale —el reporte, el
  // error que se guarda, el motivo de un RUC apagado— se limpia de ellos: el
  // cliente de SimpleFact ya limpia lo que contesta, pero un 401 que repite el
  // token no puede terminar en el log del cron por un descuido en otra capa.
  const secrets = new Set<string>();
  const redact = (text: string) => {
    let out = text;
    for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[token]");
    return out;
  };
  const fail = (text: string) => report.errors.push(sinTelefonos(redact(text)));

  try {
    await sweepAll({ admin, deps, dry, now, started, storeId: opts.storeId ?? null, report, fail, redact, secrets });
  } catch (err) {
    // Sin la 0257 no hay RUC, ni comprobantes, ni turno; sin la 0258, ni la
    // lista de pedidos por revisar: nada que barrer y nada que una persona
    // tenga que mirar. Cualquier otra cosa sí lanza.
    if (!isInvoiceMigrationMissing(err)) throw err;
    report.skipped = "sin_migracion";
  }
  return report;
}

interface SweepContext {
  admin: SupabaseClient;
  deps: InvoiceSweepDeps;
  dry: boolean;
  now: Date;
  started: number;
  storeId: string | null;
  report: InvoiceSweepReport;
  fail: (text: string) => void;
  redact: (text: string) => string;
  secrets: Set<string>;
}

async function sweepAll(ctx: SweepContext): Promise<void> {
  const { admin, deps, dry, now, started, storeId, report, fail, redact, secrets } = ctx;

  // a. La organización de ?storeId.
  let onlyOrg: string | null = null;
  if (storeId) {
    const { data, error } = await admin.from("stores").select("id,org_id").eq("id", storeId).maybeSingle();
    if (error) {
      fail(`No se pudo leer la tienda: ${error.message}`);
      return;
    }
    onlyOrg = (data as { org_id?: string | null } | null)?.org_id ?? null;
    if (!onlyOrg) {
      report.skipped = "sin_ruc_encendido";
      return;
    }
  }

  // b. Antes que nada, y aunque ningún RUC esté encendido: los `emitiendo` que
  // nadie va a conciliar. Un RUC en «Apagado» no hace nada hacia afuera, pero
  // su fila a medio enviar no puede quedarse así para siempre.
  if (!dry) await settleUnreconciledEmitting(ctx);

  // c. Los RUC encendidos.
  let issuersQuery = admin.from("invoice_issuers").select(ISSUER_COLUMNS).in("mode", [...CLAIM_MODES]);
  if (onlyOrg) issuersQuery = issuersQuery.eq("org_id", onlyOrg);
  const { data: issuerData, error: issuerError } = await issuersQuery;
  if (issuerError) {
    if (isInvoiceMigrationMissing(issuerError)) throw new InvoiceMigrationMissingError("invoice_issuers");
    fail(`No se pudieron leer los RUC: ${issuerError.message}`);
    return;
  }
  const enabled = ((issuerData ?? []) as IssuerRow[]).filter((r) =>
    (CLAIM_MODES as readonly string[]).includes(r.mode),
  );
  if (!enabled.length) {
    report.skipped = "sin_ruc_encendido";
    return;
  }
  const byOrg = new Map<string, IssuerRow[]>();
  for (const row of enabled) byOrg.set(row.org_id, [...(byOrg.get(row.org_id) ?? []), row]);

  // 429 de SimpleFact: no se emite nada más en esta pasada, en ningún RUC.
  const run = { stopped: false };

  for (const [orgId, rows] of [...byOrg].sort(([a], [b]) => a.localeCompare(b))) {
    const issuers = new Map<string, RunIssuer>();
    for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
      const mode = row.mode as InvoiceWriteMode;
      issuers.set(row.id, {
        id: row.id,
        ruc: row.ruc,
        mode,
        emitFrom: row.emit_from,
        report: emptyIssuerReport({ id: row.id, ruc: row.ruc, mode }),
        taken: 0,
        stopped: null,
      });
    }
    const orgReport: InvoiceOrgSweepReport = {
      orgId,
      stores: 0,
      candidates: 0,
      lleno: {},
      cached: 0,
      reasons: {},
      issuers: [...issuers.values()].map((i) => i.report),
    };
    report.orgs.push(orgReport);
    try {
      await sweepOrg({
        admin,
        deps,
        dry,
        now,
        started,
        storeId,
        orgId,
        issuers,
        orgReport,
        run,
        fail,
        redact,
        secrets,
      });
    } catch (err) {
      // Falta la 0257 o la 0258: no es de esta organización, corta la pasada.
      if (isInvoiceMigrationMissing(err)) throw err;
      fail(`Organización ${orgId}: ${err instanceof Error ? err.message : "error del barrido"}`);
    }
  }
}

/** Desde cuándo concilia una pasada: las 00:00 de Lima de ayer (§35.4). */
function reconcileSince(now: Date): string {
  const yesterdayKey = limaDateKey(new Date(now.getTime() - DAY_MS));
  return new Date(`${yesterdayKey}T00:00:00-05:00`).toISOString();
}

interface EmittingRow {
  id: string;
  issuer_id: string;
  created_at: string;
}

/**
 * Un `emitiendo` es una boleta que pudo haber salido: la función se cortó a
 * mitad del POST, o no se pudo guardar lo que contestó SimpleFact. Lo resuelve
 * la conciliación (`reconcileIssuer`), pero solo la de un RUC en real con token
 * y solo con las ventas de hoy y de ayer de SimpleFact. Uno cuyo RUC pasó a
 * «Apagado» o a «Simulación» (la marcha atrás del owner, una prueba de conexión
 * fallida, un 401), o que es de antes de ayer, no lo miraba nadie, y el panel no
 * tiene acción para un `emitiendo`: se quedaba así para siempre, bloqueando el
 * pedido sin que nadie lo viera.
 *
 * Aquí pasa a `en_duda`, sin llamar a nada afuera: la boleta puede existir, así
 * que no se repite, y una persona la busca por su nota en SimpleFact antes de
 * liberarla desde el panel. Solo los de más de 10 minutos (uno más nuevo puede
 * tener su POST en vuelo) y solo si siguen en `emitiendo` al escribir.
 */
async function settleUnreconciledEmitting(ctx: SweepContext): Promise<void> {
  const { admin, now, storeId, report, fail } = ctx;
  const staleBefore = new Date(now.getTime() - INVOICE_STALE_EMITTING_MS).toISOString();
  let query = admin
    .from("order_invoices")
    .select("id,issuer_id,created_at")
    .eq("mode", "real")
    .eq("status", "emitiendo")
    .lt("created_at", staleBefore);
  if (storeId) query = query.eq("store_id", storeId);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(INVOICE_UNRECONCILED_BATCH);
  if (error) {
    if (isInvoiceMigrationMissing(error)) throw new InvoiceMigrationMissingError("order_invoices");
    fail(`No se pudieron leer los comprobantes «emitiendo» sin respuesta (${error.message}).`);
    return;
  }
  report.sin_respuesta = 0;
  const rows = (data ?? []) as EmittingRow[];
  if (!rows.length) return;

  // Qué RUC concilia esta pasada: en real y con token (como `sweepOrg`, g).
  let reconciled: Set<string>;
  try {
    const ids = unique(rows.map((r) => r.issuer_id));
    const [modes, withToken] = await Promise.all([
      selectIn<{ id: string; mode: string }>(admin, "invoice_issuers", "id,mode", "id", ids),
      selectIn<{ id: string }>(admin, "invoice_issuers", "id", "id", ids, { notNull: "token_enc" }),
    ]);
    const hasToken = new Set(withToken.map((r) => r.id));
    reconciled = new Set(modes.filter((r) => r.mode === "real" && hasToken.has(r.id)).map((r) => r.id));
  } catch (err) {
    if (isInvoiceMigrationMissing(err)) throw err;
    // Sin saber el RUC no se toca nada: la próxima pasada lo vuelve a intentar.
    fail(`No se pudieron revisar los comprobantes «emitiendo» sin respuesta (${err instanceof Error ? err.message : "error"}).`);
    return;
  }

  const windowStart = Date.parse(reconcileSince(now));
  for (const row of rows) {
    const created = time(row.created_at);
    if (reconciled.has(row.issuer_id) && created !== null && created >= windowStart) continue;
    const saved = await admin
      .from("order_invoices")
      .update({ status: "en_duda", error: invoiceUnreconciledError(row.id) })
      .eq("id", row.id)
      .eq("status", "emitiendo")
      .select("id");
    if (saved.error) {
      fail(`No se pudo pasar a «en duda» un comprobante sin respuesta (${saved.error.message}).`);
      continue;
    }
    if (((saved.data ?? []) as unknown[]).length) report.sin_respuesta += 1;
  }
}

interface OrgContext {
  admin: SupabaseClient;
  deps: InvoiceSweepDeps;
  dry: boolean;
  now: Date;
  started: number;
  storeId: string | null;
  orgId: string;
  issuers: Map<string, RunIssuer>;
  orgReport: InvoiceOrgSweepReport;
  run: { stopped: boolean };
  fail: (text: string) => void;
  redact: (text: string) => string;
  /** Los tokens de la pasada, para `redact`. */
  secrets: Set<string>;
}

/**
 * Los motivos de Shopify como los recibe `invoice_candidates`: una sola lista,
 * la de aquí, para que la base y el barrido no dejen de releer cosas distintas.
 */
export function shopifyBlockedReasons(): string[] {
  return [...SHOPIFY_LEVEL_REASONS].sort();
}

/**
 * Los pedidos a revisar (§35.4, «Qué mira el barrido»), de `invoice_candidates`
 * (0258): una llamada por cada modo con un RUC encendido en la organización, con
 * el «Emitir desde» más antiguo de los RUC de ese modo. Ningún pedido pagado
 * antes de ese momento puede salir en ese modo, y un RUC sin fecha no emite:
 * sin fecha, ese modo no tiene candidatos. Del más nuevo al más viejo, sin
 * repetir. Lanza si la base no contesta: sin la lista no se emite. Una lista
 * que llega al límite queda anotada en `orgReport.lleno`.
 */
async function loadCandidates(ctx: OrgContext): Promise<string[]> {
  const { admin, issuers, orgReport } = ctx;
  const ids: string[] = [];
  // Real primero: si el límite se llenara, que falte una simulación y no una boleta.
  for (const mode of ["real", "simulacion"] as const) {
    const starts = [...issuers.values()]
      .filter((i) => i.mode === mode)
      .map((i) => time(i.emitFrom))
      .filter((t): t is number => t !== null);
    if (!starts.length) continue;
    const { data, error } = await admin.rpc("invoice_candidates", {
      p_org: ctx.orgId,
      p_mode: mode,
      p_since: new Date(Math.min(...starts)).toISOString(),
      p_limit: INVOICE_SWEEP_MAX_CANDIDATES,
      p_blocked: shopifyBlockedReasons(),
      p_store: ctx.storeId,
    });
    if (error) throw dbError(`No se pudieron leer los pedidos por revisar (${mode})`, error);
    const rows = (data ?? []) as { order_id: string | null }[];
    // Llena: pudo quedar algo pendiente más allá del límite. Sin esta marca, una
    // lista cortada no se distingue en el log de una que trajo todo.
    if (rows.length >= INVOICE_SWEEP_MAX_CANDIDATES) orgReport.lleno[mode] = true;
    ids.push(...rows.map((r) => r.order_id ?? ""));
  }
  return unique(ids.filter(Boolean));
}

async function sweepOrg(ctx: OrgContext): Promise<void> {
  const { admin, deps, dry, now, started, orgId, issuers, orgReport, run, fail, redact } = ctx;

  // b. Las tiendas activas de la organización. `invoice_candidates` ya mira
  // solo esas; aquí sirven para el reporte y para la que se pausó en medio.
  let storesQuery = admin.from("stores").select("id").eq("org_id", orgId).eq("status", "active");
  if (ctx.storeId) storesQuery = storesQuery.eq("id", ctx.storeId);
  const { data: storeData, error: storeError } = await storesQuery;
  if (storeError) throw new Error(`No se pudieron leer las tiendas: ${storeError.message}`);
  const storeIds = ((storeData ?? []) as { id: string }[]).map((s) => s.id);
  orgReport.stores = storeIds.length;
  if (!storeIds.length) return;
  const activeStores = new Set(storeIds);

  const candidates = await loadCandidates(ctx);
  orgReport.candidates = candidates.length;

  // c. La última revisión de cada pedido: para escribir solo lo que cambió, y
  // para no releer en Shopify lo que Shopify bloqueó hace poco bajo el otro
  // modo (`invoice_candidates` ya no devuelve lo bloqueado en el suyo).
  const checks = await selectIn<CheckRow>(
    admin,
    "invoice_order_checks",
    "order_id,mode,reason,detail,issuer_id,checked_at",
    "order_id",
    candidates,
  );
  const checkByKey = new Map(checks.map((c) => [`${c.order_id}|${c.mode}`, c]));
  const recheckAfter = now.getTime() - INVOICE_SHOPIFY_RECHECK_MS;
  // Un motivo de Shopify es del pedido en Shopify, no del modo: vale bajo
  // cualquiera de los dos.
  const shopifyBlocked = new Set(
    checks
      .filter((c) => isReason(c.reason) && SHOPIFY_LEVEL_REASONS.has(c.reason) && (time(c.checked_at) ?? 0) > recheckAfter)
      .map((c) => c.order_id),
  );
  const toReview = candidates.filter((id) => !shopifyBlocked.has(id));
  orgReport.cached = candidates.length - toReview.length;

  // d. Los hechos. Lanza si algo no se pudo leer: la organización no emite en
  // esta pasada.
  const loaded = await loadOrders(admin, toReview);

  // DECISIÓN: el modo bajo el que se guarda la revisión de un pedido cuyo RUC no
  // se llegó a saber (sin cuenta, RUC mezclados) o está apagado. La tabla es por
  // pedido y modo, y ese pedido no tiene modo propio: se usa el del RUC
  // encendido de la organización y, si hubiera uno en real y otro en
  // simulación, «real», que es la pregunta que importa (¿por qué no salió la
  // boleta?). Con un solo RUC encendido —Grupo GF— es simplemente su modo.
  const orgMode: InvoiceWriteMode = [...issuers.values()].some((i) => i.mode === "real") ? "real" : "simulacion";
  const pending: PendingCheck[] = [];
  const note = (
    facts: InvoiceOrderFacts,
    reason: InvoiceReason,
    detail: string | null | undefined,
    issuerId: string | null | undefined,
  ) => {
    const issuer = issuerId ? issuers.get(issuerId) : undefined;
    bump(issuer ? issuer.report.reasons : orgReport.reasons, reason);
    pending.push({
      order_id: facts.orderId,
      mode: issuer?.mode ?? orgMode,
      store_id: facts.storeId,
      issuer_id: issuerId ?? null,
      reason,
      detail: detail ?? null,
    });
  };

  const stopIssuer = (issuer: RunIssuer, why: string) => {
    if (!issuer.stopped) issuer.stopped = why;
    issuer.report.stopped = issuer.stopped;
  };

  /** La conexión del RUC: una vez por pasada. El token no sale de aquí. */
  const connFor = async (issuer: RunIssuer): Promise<SimplefactConn | null> => {
    if (issuer.conn !== undefined) return issuer.conn;
    issuer.conn = null;
    const { data, error } = await admin
      .from("invoice_issuers")
      .select("simplefact_subdomain,token_enc")
      .eq("id", issuer.id)
      .maybeSingle();
    const row = data as { simplefact_subdomain?: string | null; token_enc?: string | null } | null;
    if (error || !row?.token_enc || !row.simplefact_subdomain) {
      fail(`RUC ${issuer.ruc}: no se pudo leer su conexión con SimpleFact.`);
      return null;
    }
    let token: string;
    try {
      token = deps.decryptToken(row.token_enc);
    } catch {
      // Sin el mensaje: no se repite nada de lo que tocó el descifrado.
      fail(`RUC ${issuer.ruc}: no se pudo descifrar el token de SimpleFact.`);
      return null;
    }
    ctx.secrets.add(token.trim());
    issuer.conn = { subdomain: row.simplefact_subdomain, token };
    return issuer.conn;
  };

  /**
   * Apaga el RUC con el motivo a la vista (§35.4) y lo detiene en esta pasada.
   * También borra la prueba de conexión: si quedaba la vieja, el owner podía
   * volver a «Real» sin probar de nuevo y emitir otra boleta con el token
   * rechazado o de otra empresa. Real exige una prueba que leyó el mismo RUC
   * (0257), así que vuelve solo con «Probar conexión». El motivo se queda.
   */
  const turnOff = async (issuer: RunIssuer, why: string) => {
    stopIssuer(issuer, STOP.apagado);
    fail(`RUC ${issuer.ruc} apagado: ${why}`);
    const { error } = await admin
      .from("invoice_issuers")
      .update({ mode: "apagado", checked_ruc: null, checked_at: null, check_error: redact(why).slice(0, 500) })
      .eq("id", issuer.id);
    if (error) fail(`RUC ${issuer.ruc}: no se pudo apagar (${error.message}).`);
  };

  // e. Pedido por pedido, del más nuevo al más viejo.
  for (const orderId of toReview) {
    const entry = loaded.get(orderId);
    if (!entry) continue;
    const { facts } = entry;
    if (!activeStores.has(facts.storeId)) continue;

    const elig = invoiceEligibility(facts);
    if (!elig.ok) {
      note(facts, elig.reason, elig.detail, elig.issuerId);
      continue;
    }
    const issuer = issuers.get(elig.issuer.id);
    // Se encendió después de leer la lista de RUC: entra en la próxima pasada.
    if (!issuer) continue;
    if (issuer.stopped || issuer.taken >= INVOICE_MAX_PER_RUN || (elig.mode === "real" && run.stopped)) {
      if (!issuer.stopped && issuer.taken >= INVOICE_MAX_PER_RUN) stopIssuer(issuer, STOP.max);
      issuer.report.pendientes += 1;
      continue;
    }
    if (Date.now() - started > ORDER_BUDGET_MS) {
      issuer.report.pendientes += 1;
      continue;
    }
    // El token antes del turno: un turno sin token dejaría una fila `emitiendo`
    // que nunca se envió.
    if (elig.mode === "real" && !dry && !(await connFor(issuer))) {
      stopIssuer(issuer, STOP.sinToken);
      issuer.report.pendientes += 1;
      continue;
    }

    // Justo antes de emitir, Shopify (§35.3): los ítems al céntimo.
    const read = await deps.fetchOrder({ storeId: facts.storeId, shopifyOrderId: entry.shopifyOrderId ?? "" });
    if (!read.ok) {
      note(facts, read.reason, read.detail, issuer.id);
      continue;
    }
    if (read.totalCents !== elig.totalCents) {
      note(
        facts,
        "total_distinto",
        `Shopify dice S/ ${soles(read.totalCents)}; Kapta, S/ ${soles(elig.totalCents)}.`,
        issuer.id,
      );
      continue;
    }
    if (elig.basis.prepaid && !webPrepaidConfirmed(read)) {
      note(facts, "pago_web_no_confirmado", null, issuer.id);
      continue;
    }
    const invoiceId = deps.randomUUID();
    const orderName = facts.orderName ?? read.name;
    const payload = buildSalePayload({ invoiceId, orderName, items: read.items, totalCents: elig.totalCents });
    if (!payload) {
      note(facts, "no_cuadra", null, issuer.id);
      continue;
    }
    if (dry) {
      issuer.taken += 1;
      issuer.report.would_claim += 1;
      continue;
    }

    // f. El turno, dentro de la base: modo, conexión, monto, inicio, uno por
    // pedido y el tope del día, con un candado por RUC.
    const claim = await admin.rpc("invoice_claim", {
      p_id: invoiceId,
      p_issuer: issuer.id,
      p_store: facts.storeId,
      p_order: facts.orderId,
      p_total: elig.totalCents / 100,
      p_paid_at: elig.paidAt,
      p_order_name: orderName,
      p_basis: elig.basis,
      p_request: payload,
    });
    if (claim.error) {
      // Sin la función no se reservó nada ni se llamó: falta la 0257 (y la 0258).
      if (isInvoiceMigrationMissing(claim.error)) throw new InvoiceMigrationMissingError("invoice_claim");
      // Sin respuesta del turno no se llama: si la fila llegó a quedar en
      // `emitiendo`, la conciliación la pasa a `en_duda` y la ve una persona.
      issuer.report.errores += 1;
      fail(`RUC ${issuer.ruc}: el turno de ${orderName ?? "un pedido"} falló (${claim.error.message}).`);
      continue;
    }
    const answer = (claim.data ?? {}) as { id?: unknown; mode?: unknown; reason?: unknown };
    if (isReason(answer.reason)) {
      note(facts, answer.reason, null, issuer.id);
      if (ISSUER_WIDE_CLAIM_REASONS.has(answer.reason)) stopIssuer(issuer, answer.reason);
      continue;
    }
    if (answer.id !== invoiceId || !(CLAIM_MODES as readonly unknown[]).includes(answer.mode)) {
      issuer.report.errores += 1;
      stopIssuer(issuer, STOP.turno);
      fail(`RUC ${issuer.ruc}: invoice_claim contestó algo que no se entiende.`);
      continue;
    }
    issuer.taken += 1;
    if (answer.mode === "simulacion") {
      issuer.report.simuladas += 1;
      continue;
    }

    // Real: el modo que manda es el de la base. Si el RUC pasó a real después
    // de leer la lista, recién aquí se carga su conexión.
    const conn = await connFor(issuer);
    if (!conn) {
      // No se envió nada: es un no cierto, no una duda.
      stopIssuer(issuer, STOP.sinToken);
      issuer.report.errores += 1;
      const closed = await admin
        .from("order_invoices")
        .update({ status: "error", error: "No se envió: no se pudo leer el token de SimpleFact." })
        .eq("id", invoiceId)
        .eq("status", "emitiendo")
        .select("id");
      if (closed.error) fail(`RUC ${issuer.ruc}: no se pudo cerrar un turno sin enviar (${closed.error.message}).`);
      continue;
    }
    const res = await deps.createSale(conn, payload);
    const outcome = classifySaleResponse(res.http, res.body, issuer.ruc);
    const base = { response: storedResponse(res, redact), http_status: res.http };
    let update: Record<string, unknown>;
    if (outcome.status === "emitida") {
      update = {
        ...base,
        status: "emitida",
        simplefact_id: outcome.simplefactId,
        serie: outcome.serie,
        correlative: outcome.correlative,
        pdf_url: outcome.pdfUrl,
        xml_url: outcome.xmlUrl,
        sunat_status: outcome.sunatStatus,
        ruc_mismatch: outcome.rucMismatch,
        error: outcome.rucMismatch ? `SimpleFact contestó con archivos del RUC ${outcome.ruc}, no del ${issuer.ruc}.` : null,
      };
      issuer.report.emitidas += 1;
    } else {
      const detail = res.error && res.error !== outcome.error ? `${outcome.error} (${res.error})` : outcome.error;
      update = { ...base, status: outcome.status, error: redact(detail).slice(0, 500) };
      if (outcome.status === "error") issuer.report.errores += 1;
      else issuer.report.en_duda += 1;
    }
    const saved = await admin
      .from("order_invoices")
      .update(update)
      .eq("id", invoiceId)
      .eq("status", "emitiendo")
      .select("id");
    if (saved.error || !((saved.data ?? []) as unknown[]).length) {
      // La fila se queda en `emitiendo`: la conciliación la resuelve. Con la
      // base fallando no se sigue llamando a SimpleFact en esta pasada.
      stopIssuer(issuer, STOP.base);
      fail(`RUC ${issuer.ruc}: no se pudo guardar la respuesta de SimpleFact de ${orderName ?? "un pedido"}${saved.error ? ` (${saved.error.message})` : ""}.`);
    }

    if (outcome.status === "emitida" && outcome.rucMismatch) {
      await turnOff(issuer, `SimpleFact emitió con archivos del RUC ${outcome.ruc}: el token no es de este RUC.`);
    } else if (outcome.status === "error" && outcome.stop === "issuer") {
      await turnOff(issuer, outcome.error);
    } else if (outcome.status === "error" && outcome.stop === "run") {
      run.stopped = true;
      stopIssuer(issuer, STOP.espera);
      fail(`RUC ${issuer.ruc}: ${outcome.error} No se emite nada más en esta pasada.`);
    } else if (outcome.status === "en_duda") {
      // Como Swayp: una emisión en duda corta el lote. Si SimpleFact está caído,
      // seguir solo llena de dudas que alguien tiene que conciliar.
      stopIssuer(issuer, STOP.enDuda);
    }
  }

  if (dry) return;

  // La revisión de cada pedido, en una sola escritura. Solo lo que cambió; un
  // motivo de Shopify se reescribe siempre, porque su fecha es la que evita
  // releerlo antes de 6 horas.
  const checkedAt = now.toISOString();
  const changed = pending.filter((p) => {
    const prev = checkByKey.get(`${p.order_id}|${p.mode}`);
    return (
      !prev ||
      SHOPIFY_LEVEL_REASONS.has(p.reason) ||
      prev.reason !== p.reason ||
      (prev.detail ?? null) !== p.detail ||
      (prev.issuer_id ?? null) !== p.issuer_id
    );
  });
  for (const part of chunk(changed, ID_BATCH)) {
    const { error } = await admin
      .from("invoice_order_checks")
      .upsert(
        part.map((p) => ({ ...p, checked_at: checkedAt })),
        { onConflict: "order_id,mode" },
      );
    if (error) fail(`Organización ${orgId}: no se pudo guardar la revisión de los pedidos (${error.message}).`);
  }

  // g. Conciliación de lo que quedó sin respuesta.
  for (const issuer of issuers.values()) {
    if (issuer.mode !== "real" || (issuer.stopped && NO_RECONCILE.has(issuer.stopped))) continue;
    await reconcileIssuer(ctx, issuer, connFor, turnOff);
  }
}

interface OpenInvoiceRow {
  id: string;
  status: string;
  created_at: string;
}

/**
 * Busca en las ventas de hoy y de ayer de SimpleFact la nota «Kapta ‹ref›» de
 * cada comprobante `en_duda`, o `emitiendo` sin respuesta hace más de 10
 * minutos. La que aparece pasa a `emitida`; un `emitiendo` que no aparece pasa
 * a `en_duda` y lo ve una persona. Si la lista no se pudo leer entera, nada se
 * toca: «no está» solo se concluye con la lista completa.
 */
async function reconcileIssuer(
  ctx: OrgContext,
  issuer: RunIssuer,
  connFor: (issuer: RunIssuer) => Promise<SimplefactConn | null>,
  turnOff: (issuer: RunIssuer, why: string) => Promise<void>,
): Promise<void> {
  const { admin, deps, now, started, fail } = ctx;
  const todayKey = limaDateKey(now);
  // La misma ventana que deja fuera `settleUnreconciledEmitting`: lo de antes
  // ya pasó a `en_duda` al empezar la pasada.
  const since = reconcileSince(now);

  const { data, error } = await admin
    .from("order_invoices")
    .select("id,status,created_at")
    .eq("issuer_id", issuer.id)
    .eq("mode", "real")
    .in("status", ["emitiendo", "en_duda"])
    .gte("created_at", since);
  if (error) {
    fail(`RUC ${issuer.ruc}: no se pudieron leer los comprobantes por conciliar (${error.message}).`);
    return;
  }
  const staleBefore = now.getTime() - INVOICE_STALE_EMITTING_MS;
  // Un `emitiendo` reciente puede tener su POST en vuelo: no se toca.
  const open = ((data ?? []) as OpenInvoiceRow[]).filter(
    (r) => r.status === "en_duda" || (r.status === "emitiendo" && (time(r.created_at) ?? Infinity) < staleBefore),
  );
  if (!open.length) return;

  const conn = await connFor(issuer);
  if (!conn) return;

  // Siempre hoy; ayer si algo es de ayer. Una venta de ayer a las 23:59 puede
  // haber quedado registrada hoy, así que lo de ayer se busca en los dos días.
  const days: Array<"today" | "yesterday"> = ["today"];
  if (open.some((r) => limaDateKey(new Date(r.created_at)) !== todayKey)) days.push("yesterday");

  const sales: unknown[] = [];
  let complete = true;
  for (const shortdate of days) {
    for (let page = 1; page <= INVOICE_RECONCILE_MAX_PAGES; page += 1) {
      if (Date.now() - started > RECONCILE_BUDGET_MS) {
        fail(`RUC ${issuer.ruc}: sin tiempo para conciliar en esta pasada.`);
        return;
      }
      const res = await deps.listSales(conn, { shortdate, pageSize: INVOICE_RECONCILE_PAGE_SIZE, page });
      const list = res.body && typeof res.body === "object" ? (res.body as { data?: unknown }).data : undefined;
      if (res.http === null || res.http < 200 || res.http >= 300 || !Array.isArray(list)) {
        fail(
          `RUC ${issuer.ruc}: no se pudo leer la lista de ventas de SimpleFact (${res.http ?? "sin respuesta"}); se concilia en la próxima pasada.`,
        );
        return;
      }
      sales.push(...list);
      if (list.length < INVOICE_RECONCILE_PAGE_SIZE) break;
      // Más de 500 ventas en un día: lo que no aparece puede estar más allá.
      if (page === INVOICE_RECONCILE_MAX_PAGES) complete = false;
    }
  }

  const listed = { data: sales };
  for (const row of open) {
    const sale = findSaleByNote(listed, row.id);
    if (sale) {
      const outcome = classifySaleResponse(200, { success: true, data: sale }, issuer.ruc);
      if (outcome.status !== "emitida") {
        fail(`RUC ${issuer.ruc}: la venta de un comprobante por conciliar no trae su id de SimpleFact.`);
        continue;
      }
      const saved = await admin
        .from("order_invoices")
        .update({
          status: "emitida",
          simplefact_id: outcome.simplefactId,
          serie: outcome.serie,
          correlative: outcome.correlative,
          pdf_url: outcome.pdfUrl,
          xml_url: outcome.xmlUrl,
          sunat_status: outcome.sunatStatus,
          ruc_mismatch: outcome.rucMismatch,
          error: outcome.rucMismatch ? `SimpleFact tiene la venta con archivos del RUC ${outcome.ruc}, no del ${issuer.ruc}.` : null,
        })
        .eq("id", row.id)
        .in("status", ["emitiendo", "en_duda"])
        .select("id");
      if (saved.error) {
        fail(`RUC ${issuer.ruc}: no se pudo guardar una conciliación (${saved.error.message}).`);
        continue;
      }
      if (((saved.data ?? []) as unknown[]).length) issuer.report.conciliadas += 1;
      if (outcome.rucMismatch) {
        await turnOff(issuer, `SimpleFact tiene una venta con archivos del RUC ${outcome.ruc}: el token no es de este RUC.`);
        return;
      }
    } else if (complete && row.status === "emitiendo") {
      const saved = await admin
        .from("order_invoices")
        .update({ status: "en_duda", error: INVOICE_NOT_FOUND_ERROR })
        .eq("id", row.id)
        .eq("status", "emitiendo")
        .select("id");
      if (saved.error) {
        fail(`RUC ${issuer.ruc}: no se pudo pasar a «en duda» un comprobante sin respuesta (${saved.error.message}).`);
        continue;
      }
      if (((saved.data ?? []) as unknown[]).length) issuer.report.en_duda += 1;
    }
  }
}
