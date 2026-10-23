// Comprobantes electrónicos por RUC — la base y el barrido (MOM §35).
//
// Lo que DECIDE está en lib/invoicing/rules.ts (puro). Aquí se juntan los hechos
// de cada pedido (pagos, cuentas, estado de cuenta Yape, links de Flow, RUC y
// comprobantes previos), se vuelve a leer el pedido en Shopify, se pide el turno
// en la base (`invoice_claim`, 0257) y se llama a SimpleFact. Después se
// concilia lo que quedó sin respuesta.
//
// «Emitir esta boleta» (`emitInvoiceNow`, RUC en «Manual», owner 15-10-2026)
// es la misma emisión real del barrido para UN pedido, pedida por una persona:
// los mismos hechos, las mismas reglas, la misma relectura en Shopify, el mismo
// turno y la misma lectura de la respuesta. El código de esos pasos es uno solo
// (`prepareSale`, `claimArgs`, `sendClaimedSale`, `turnOffReason`): un candado
// que se agregue al barrido lo tiene también el botón. Y si el botón se ofrece
// lo decide una sola función (`invoiceEmitNowReadiness`), la misma para el
// drawer y para el «Emitir» de Ajustes.
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
  INVOICE_MODE_LABEL,
  INVOICE_REASONS,
  LIVE_REAL_STATUSES,
  buildSalePayload,
  classifySaleResponse,
  findSaleByNote,
  invoiceEligibility,
  invoiceNoteRef,
  invoiceSweepMode,
  type InvoiceAccount,
  type InvoiceEligibility,
  type InvoiceEnabledMode,
  type InvoiceExisting,
  type InvoiceIssuer,
  type InvoiceMode,
  type InvoiceOrderFacts,
  type InvoicePayment,
  type InvoiceReason,
  type InvoiceWriteMode,
  type SaleOutcome,
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
 * Candidatos por organización y modo en una pasada (`invoice_candidates`, 0260).
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
  // El RUC cambió de modo después de leer la lista: lo que sigue de él se mira
  // en la próxima pasada, con su modo nuevo.
  "modo_distinto",
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
 * 0260 trae `invoice_candidates` y vuelve a escribir el turno y los dos
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
  invoice_candidates: "0260",
} as const satisfies Record<string, "0257" | "0260">;

type InvoiceMigrationObject = keyof typeof INVOICE_MIGRATION_OBJECTS;

/** Un nombre de INVOICE_MIGRATION_OBJECTS como palabra entera (`order_invoices_old` no lo es). */
const INVOICE_MIGRATION_OBJECT = new RegExp(`\\b(?:${Object.keys(INVOICE_MIGRATION_OBJECTS).join("|")})\\b`);
const INVOICE_MIGRATION_OBJECT_ALL = new RegExp(INVOICE_MIGRATION_OBJECT.source, "g");

/**
 * Qué falta aplicar, por lo que nombra el error. Si todo lo que nombra es de la
 * 0260 (`invoice_candidates`), es la 0260: la 0257 está, porque sus tablas se
 * leyeron. Si nombra algo de la 0257, o nada, son las dos: la 0260 no se aplica
 * sin las tablas de la 0257.
 */
function missingInvoiceMigrations(text: string): string {
  const named = [...text.matchAll(INVOICE_MIGRATION_OBJECT_ALL)].map(
    (m) => INVOICE_MIGRATION_OBJECTS[m[0] as InvoiceMigrationObject],
  );
  return named.length > 0 && named.every((n) => n === "0260") ? "la migración 0260" : "las migraciones 0257 y 0260";
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
  /** `migration`: cuál falta, cuando se sabe por otro lado (la 0261, `claimMissingError`). */
  constructor(what: string, missing: string = what, migration?: string) {
    super(
      `Falta aplicar ${migration ? `la migración ${migration}` : missingInvoiceMigrations(missing)} de comprobantes (${what}).`,
    );
    this.name = "InvoiceMigrationMissingError";
  }
}

/**
 * La migración que le da al turno el modo que se pide y quién lo pidió
 * (`p_mode`, `p_created_by`): la 0261, con el modo «Manual». No crea nada con
 * nombre nuevo —cambia la firma de `invoice_claim`, con valores por defecto
 * para que el código que ya corre siga pidiendo el turno igual—, así que no
 * está en INVOICE_MIGRATION_OBJECTS: se reconoce por los parámetros que se
 * mandaron (`claimMissingError`).
 */
export const INVOICE_CLAIM_MODE_MIGRATION = "0261";

/** Los parámetros del turno que trae la 0261. */
const CLAIM_0261_PARAMS = ["p_mode", "p_created_by"] as const;

/**
 * La migración que le deja al turno dar una fila real de un pedido pagado antes
 * de «Emitir desde» (`p_backfill`, owner 15-10-2026): la 0269. Como la 0261, no
 * crea nada con nombre nuevo, así que se reconoce por el parámetro. Solo lo
 * manda «Emitir esta boleta» con un pedido de antes (`beforeStart`): sin la
 * 0269, lo demás se sigue emitiendo con el turno de once argumentos.
 */
export const INVOICE_CLAIM_BACKFILL_MIGRATION = "0269";

/**
 * El «no existe» del turno. Si se pidió con `p_backfill`, lo que falta es la
 * 0269: la 0261 ya corrió en producción. Si se pidió con `p_mode` o
 * `p_created_by`, lo que falta es la 0261: la 0257 y la 0260 crean el turno sin
 * esos parámetros, y PostgREST no encuentra esa firma (PGRST202). Quien llega
 * al turno ya leyó las tablas de la 0257, así que no son ellas. Sin esos
 * parámetros, como siempre.
 */
function claimMissingError(args: Record<string, unknown>): InvoiceMigrationMissingError {
  if ("p_backfill" in args) {
    return new InvoiceMigrationMissingError("invoice_claim con p_backfill", "invoice_claim", INVOICE_CLAIM_BACKFILL_MIGRATION);
  }
  const sent = CLAIM_0261_PARAMS.filter((p) => p in args);
  return sent.length
    ? new InvoiceMigrationMissingError(`invoice_claim con ${sent.join(" y ")}`, "invoice_claim", INVOICE_CLAIM_MODE_MIGRATION)
    : new InvoiceMigrationMissingError("invoice_claim");
}

/**
 * Si un error (de Supabase o lanzado aquí) dice que falta una migración de
 * comprobantes: un código de «no existe» cuyo mensaje o detalle nombra algo que
 * crean la 0257 o la 0260.
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
  paid_at: string | null;
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
      "id,order_id,kind,amount,validation_status,validated_at,registered_at,paid_at,vision",
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
      // La fecha del comprobante: solo para el piso de lo pagado antes de
      // «Emitir desde» (el primer dinero, `firstPaidAt`), no para la condición 8.
      paidAt: p.paid_at ?? null,
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
  /**
   * El modo del RUC al empezar la pasada. En `manual` la pasada solo simula
   * (`simuladas`) y concilia lo real que emitió una persona (`conciliadas`).
   */
  mode: InvoiceEnabledMode;
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
   * sin_ruc_encendido → ningún RUC en simulación, en manual ni en real.
   * sin_migracion     → falta la 0257 o la 0260: no hay nada que barrer.
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
  /** Su modo al empezar la pasada. */
  issuerMode: InvoiceEnabledMode;
  /**
   * Bajo qué modo lo barre la pasada: el de las filas que pide su turno, el de
   * su lista de candidatos y el de sus revisiones. En «Manual», simulación.
   */
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
// Un RUC que cambió de modo a mitad de la pasada (`modo_distinto`) tampoco: su
// modo nuevo puede ser uno sin token probado, y la próxima pasada lo mira con
// el modo que tenga.
const NO_RECONCILE = new Set<string>([STOP.apagado, STOP.espera, STOP.sinToken, "sin_conexion", "modo_distinto"]);

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

/** Los modos de una fila: lo que contesta el turno. */
const CLAIM_MODES: readonly InvoiceWriteMode[] = ["simulacion", "real"];

/** Los modos que mira el barrido: los encendidos. */
const SWEEP_MODES: readonly InvoiceEnabledMode[] = ["simulacion", "manual", "real"];

/**
 * Los modos que pueden tener comprobantes reales sin respuesta y un token
 * probado: el barrido los concilia, y no pasa a `en_duda` sus `emitiendo` de
 * hoy y de ayer. «Manual» también: el barrido no emite por él, pero la persona
 * que pulsa «Emitir esta boleta» sí, y esa boleta puede quedar en duda.
 */
const RECONCILE_MODES: ReadonlySet<string> = new Set<InvoiceEnabledMode>(["manual", "real"]);

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

function emptyIssuerReport(i: { id: string; ruc: string; mode: InvoiceEnabledMode }): InvoiceIssuerSweepReport {
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
 * en simulación, en manual o en real, revisa sus pedidos pagados, simula o
 * emite, y concilia lo que quedó sin respuesta. Un RUC en «Manual» se barre
 * como en «Simulación» (nunca llama a SimpleFact para crear una venta) y se
 * concilia como en «Real»: lo real de él lo emite una persona. Antes, fuera de
 * `dry`, pasa a `en_duda` los `emitiendo` sin respuesta que ninguna
 * conciliación va a mirar.
 *
 *   dry      → revisa, lee en Shopify y arma la boleta, pero no escribe nada en
 *              la base ni llama a SimpleFact (tampoco concilia).
 *   storeId  → solo esa tienda (y los RUC de su organización).
 *
 * No lanza por un problema de una organización: lo anota en `errors` y sigue
 * con la siguiente. Si falta la 0257 o la 0260, no hace nada y lo dice en
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
  const redact = (text: string) => redactSecrets(text, secrets);
  const fail = (text: string) => report.errors.push(sinTelefonos(redact(text)));

  try {
    await sweepAll({ admin, deps, dry, now, started, storeId: opts.storeId ?? null, report, fail, redact, secrets });
  } catch (err) {
    // Sin la 0257 no hay RUC, ni comprobantes, ni turno; sin la 0260, ni la
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

  // c. Los RUC encendidos: en simulación, en manual o en real.
  let issuersQuery = admin.from("invoice_issuers").select(ISSUER_COLUMNS).in("mode", [...SWEEP_MODES]);
  if (onlyOrg) issuersQuery = issuersQuery.eq("org_id", onlyOrg);
  const { data: issuerData, error: issuerError } = await issuersQuery;
  if (issuerError) {
    if (isInvoiceMigrationMissing(issuerError)) throw new InvoiceMigrationMissingError("invoice_issuers");
    fail(`No se pudieron leer los RUC: ${issuerError.message}`);
    return;
  }
  const enabled = ((issuerData ?? []) as IssuerRow[]).filter((r) =>
    (SWEEP_MODES as readonly string[]).includes(r.mode),
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
      const issuerMode = row.mode as InvoiceEnabledMode;
      issuers.set(row.id, {
        id: row.id,
        ruc: row.ruc,
        issuerMode,
        // `enabled` ya dejó fuera «Apagado» y lo que no se entiende.
        mode: invoiceSweepMode(issuerMode)!,
        emitFrom: row.emit_from,
        report: emptyIssuerReport({ id: row.id, ruc: row.ruc, mode: issuerMode }),
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
      // Falta la 0257 o la 0260: no es de esta organización, corta la pasada.
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
 * la conciliación (`reconcileIssuer`), pero solo la de un RUC en real o en
 * manual con token y solo con las ventas de hoy y de ayer de SimpleFact. Uno
 * cuyo RUC pasó a «Apagado» o a «Simulación» (la marcha atrás del owner, una
 * prueba de conexión fallida, un 401), o que es de antes de ayer, no lo miraba
 * nadie, y el panel no tiene acción para un `emitiendo`: se quedaba así para
 * siempre, bloqueando el pedido sin que nadie lo viera.
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

  // Qué RUC concilia esta pasada: en real o en manual, y con token (como
  // `sweepOrg`, g). Una boleta que emitió una persona con el RUC en «Manual» se
  // busca en SimpleFact igual que una del barrido.
  let reconciled: Set<string>;
  try {
    const ids = unique(rows.map((r) => r.issuer_id));
    const [modes, withToken] = await Promise.all([
      selectIn<{ id: string; mode: string }>(admin, "invoice_issuers", "id,mode", "id", ids),
      selectIn<{ id: string }>(admin, "invoice_issuers", "id", "id", ids, { notNull: "token_enc" }),
    ]);
    const hasToken = new Set(withToken.map((r) => r.id));
    reconciled = new Set(modes.filter((r) => RECONCILE_MODES.has(r.mode) && hasToken.has(r.id)).map((r) => r.id));
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
 * (0260): una llamada por cada modo con un RUC encendido en la organización, con
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
    const loaded = await loadIssuerConn(admin, deps, issuer.id);
    if (!loaded.ok) {
      fail(
        loaded.why === "descifrado"
          ? `RUC ${issuer.ruc}: no se pudo descifrar el token de SimpleFact.`
          : `RUC ${issuer.ruc}: no se pudo leer su conexión con SimpleFact.`,
      );
      return null;
    }
    ctx.secrets.add(loaded.conn.token.trim());
    issuer.conn = loaded.conn;
    return issuer.conn;
  };

  /**
   * Apaga el RUC con el motivo a la vista (§35.4) y lo detiene en esta pasada.
   * La escritura es `turnOffIssuer`, la misma de «Emitir esta boleta».
   */
  const turnOff = async (issuer: RunIssuer, why: string) => {
    stopIssuer(issuer, STOP.apagado);
    fail(`RUC ${issuer.ruc} apagado: ${why}`);
    const error = await turnOffIssuer(admin, issuer.id, why, redact);
    if (error) fail(`RUC ${issuer.ruc}: no se pudo apagar (${error}).`);
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
    const prepared = await prepareSale(deps, facts, elig, entry.shopifyOrderId);
    if (!prepared.ok) {
      note(facts, prepared.reason, prepared.detail, issuer.id);
      continue;
    }
    const { invoiceId, orderName, payload } = prepared;
    if (dry) {
      issuer.taken += 1;
      issuer.report.would_claim += 1;
      continue;
    }

    // f. El turno, dentro de la base: modo, conexión, monto, inicio, uno por
    // pedido y el tope del día, con un candado por RUC.
    //
    // DECISIÓN: el turno de un RUC en «Manual» se pide con `p_mode =
    // 'simulacion'` (0261): el barrido nunca envía por él, y si el RUC pasó a
    // «Real» entre la lista y el turno, la base contesta `modo_distinto` en vez
    // de dejar una fila real que el barrido evaluó como simulación. El de un
    // RUC en «Simulación» o en «Real» se pide como siempre, sin `p_mode` (null:
    // el modo del RUC): así el barrido sigue simulando y emitiendo aunque este
    // código llegue a producción antes que la 0261, y un RUC en «Manual» no
    // existe sin ella (la 0257 no admite ese modo).
    const askedMode: InvoiceWriteMode | null = issuer.issuerMode === "manual" ? "simulacion" : null;
    const args = claimArgs(facts, elig, prepared, askedMode ? { mode: askedMode } : {});
    const claim = await admin.rpc("invoice_claim", args);
    if (claim.error) {
      // Sin la función (o sin su firma con `p_mode`) no se reservó nada ni se
      // llamó: falta la 0257 y la 0260, o la 0261.
      if (isInvoiceMigrationMissing(claim.error)) throw claimMissingError(args);
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
    if (
      answer.id !== invoiceId ||
      !(CLAIM_MODES as readonly unknown[]).includes(answer.mode) ||
      (askedMode !== null && answer.mode !== askedMode)
    ) {
      issuer.report.errores += 1;
      stopIssuer(issuer, STOP.turno);
      fail(`RUC ${issuer.ruc}: invoice_claim contestó algo que no se entiende.`);
      // Un turno real que no se pidió (el de un RUC en «Manual» pidió
      // simulación) no se envía, y la fila no se queda en `emitiendo`: nada
      // salió, así que es un error cierto, no una duda.
      if (answer.id === invoiceId && answer.mode === "real") {
        const error = await closeUnsent(admin, invoiceId, "No se envió: el turno dio una emisión real que no se pidió.");
        if (error) fail(`RUC ${issuer.ruc}: no se pudo cerrar un turno sin enviar (${error}).`);
      }
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
      const error = await closeUnsent(admin, invoiceId, "No se envió: no se pudo leer el token de SimpleFact.");
      if (error) fail(`RUC ${issuer.ruc}: no se pudo cerrar un turno sin enviar (${error}).`);
      continue;
    }
    const sent = await sendClaimedSale({ admin, deps, conn, ruc: issuer.ruc, invoiceId, payload, redact });
    const { outcome } = sent;
    if (outcome.status === "emitida") issuer.report.emitidas += 1;
    else if (outcome.status === "error") issuer.report.errores += 1;
    else issuer.report.en_duda += 1;
    if (!sent.saved) {
      // La fila se queda en `emitiendo`: la conciliación la resuelve. Con la
      // base fallando no se sigue llamando a SimpleFact en esta pasada.
      stopIssuer(issuer, STOP.base);
      fail(`RUC ${issuer.ruc}: no se pudo guardar la respuesta de SimpleFact de ${orderName ?? "un pedido"}${sent.saveError ? ` (${sent.saveError})` : ""}.`);
    }

    const offWhy = turnOffReason(outcome);
    if (offWhy) {
      await turnOff(issuer, offWhy);
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

  // g. Conciliación de lo que quedó sin respuesta: la de un RUC en real y la de
  // uno en manual, que tiene las boletas que emitió una persona.
  for (const issuer of issuers.values()) {
    if (!RECONCILE_MODES.has(issuer.issuerMode) || (issuer.stopped && NO_RECONCILE.has(issuer.stopped))) continue;
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

// ── Una emisión real: la misma en el barrido y en «Emitir esta boleta» ───────

type EligibleOrder = Extract<InvoiceEligibility, { ok: true }>;

/** Quita los tokens descifrados de un texto (solo los de 8 caracteres o más). */
function redactSecrets(text: string, secrets: ReadonlySet<string>): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[token]");
  return out;
}

/** La boleta lista para pedir el turno, o por qué no. */
type PreparedSale =
  | {
      ok: true;
      invoiceId: string;
      orderName: string | null;
      payload: SimplefactSalePayload;
      /** Si el pedido se leyó de su foto (MOM §35.10): cuándo se tomó. Va en la base del comprobante. */
      snapshotFetchedAt: string | null;
    }
  | { ok: false; reason: InvoiceReason; detail: string | null };

/**
 * Lo que va entre las reglas y el turno (§35.3): vuelve a leer el pedido en
 * Shopify, exige que su total sea el de Kapta y, en el prepago web, que Flow lo
 * haya cobrado entero, y arma la boleta al céntimo con un id nuevo. No escribe
 * nada ni llama a SimpleFact.
 */
async function prepareSale(
  deps: InvoiceSweepDeps,
  facts: InvoiceOrderFacts,
  elig: EligibleOrder,
  shopifyOrderId: string | null,
): Promise<PreparedSale> {
  const read = await deps.fetchOrder({ storeId: facts.storeId, shopifyOrderId: shopifyOrderId ?? "" });
  if (!read.ok) return { ok: false, reason: read.reason, detail: read.detail ?? null };
  if (read.totalCents !== elig.totalCents) {
    return {
      ok: false,
      reason: "total_distinto",
      detail: `Shopify dice S/ ${soles(read.totalCents)}; Kapta, S/ ${soles(elig.totalCents)}.`,
    };
  }
  if (elig.basis.prepaid && !webPrepaidConfirmed(read)) return { ok: false, reason: "pago_web_no_confirmado", detail: null };
  const invoiceId = deps.randomUUID();
  const orderName = facts.orderName ?? read.name;
  const payload = buildSalePayload({ invoiceId, orderName, items: read.items, totalCents: elig.totalCents });
  if (!payload) return { ok: false, reason: "no_cuadra", detail: null };
  return { ok: true, invoiceId, orderName, payload, snapshotFetchedAt: read.snapshot?.fetchedAt ?? null };
}

/**
 * Los parámetros del turno (`invoice_claim`). `mode` (`p_mode`) y `createdBy`
 * (`p_created_by`) son de la 0261 y solo van si se dan: sin ellos el turno es
 * el de siempre, con el modo del RUC y sin quién.
 *
 * `p_backfill` (0269) va SOLO con un pedido pagado antes de «Emitir desde»
 * (`beforeStart`, que solo da `emitNow`) y con quien lo pidió: el barrido
 * nunca lo manda. Nunca va en false: así lo demás se sigue pidiendo con el
 * turno de once argumentos aunque la 0269 no esté.
 */
function claimArgs(
  facts: InvoiceOrderFacts,
  elig: EligibleOrder,
  prepared: Extract<PreparedSale, { ok: true }>,
  extra: { mode?: InvoiceWriteMode; createdBy?: string } = {},
): Record<string, unknown> {
  return {
    p_id: prepared.invoiceId,
    p_issuer: elig.issuer.id,
    p_store: facts.storeId,
    p_order: facts.orderId,
    p_total: elig.totalCents / 100,
    p_paid_at: elig.paidAt,
    p_order_name: prepared.orderName,
    // Una boleta armada con la foto del pedido (MOM §35.10) lo deja dicho en su
    // base, con la hora de la foto. Leída en vivo, la base es la de siempre.
    p_basis: prepared.snapshotFetchedAt ? { ...elig.basis, foto_shopify: prepared.snapshotFetchedAt } : elig.basis,
    p_request: prepared.payload,
    ...(extra.mode ? { p_mode: extra.mode } : {}),
    ...(extra.createdBy ? { p_created_by: extra.createdBy } : {}),
    ...(elig.beforeStart && extra.createdBy ? { p_backfill: true } : {}),
  };
}

type IssuerConnLoad = { ok: true; conn: SimplefactConn } | { ok: false; why: "lectura" | "descifrado" };

/**
 * El subdominio y el token en claro de un RUC. Quien lo llama agrega el token a
 * lo que se limpia de todo texto que sale. Si el descifrado falla no se guarda
 * su mensaje: no se repite nada de lo que tocó.
 */
async function loadIssuerConn(admin: SupabaseClient, deps: InvoiceSweepDeps, issuerId: string): Promise<IssuerConnLoad> {
  const { data, error } = await admin
    .from("invoice_issuers")
    .select("simplefact_subdomain,token_enc")
    .eq("id", issuerId)
    .maybeSingle();
  const row = data as { simplefact_subdomain?: string | null; token_enc?: string | null } | null;
  if (error || !row?.token_enc || !row.simplefact_subdomain) return { ok: false, why: "lectura" };
  try {
    return { ok: true, conn: { subdomain: row.simplefact_subdomain, token: deps.decryptToken(row.token_enc) } };
  } catch {
    return { ok: false, why: "descifrado" };
  }
}

/**
 * Cierra como `error` un turno real que no se envió (no se pudo leer el token,
 * o el turno dio una emisión que no se pidió): nada salió, así que es un no
 * cierto, no una duda. Solo si sigue en `emitiendo`. Devuelve el error de la
 * base, o null.
 */
async function closeUnsent(admin: SupabaseClient, invoiceId: string, why: string): Promise<string | null> {
  const closed = await admin
    .from("order_invoices")
    .update({ status: "error", error: why })
    .eq("id", invoiceId)
    .eq("status", "emitiendo")
    .select("id");
  return closed.error ? closed.error.message : null;
}

interface SentSale {
  outcome: SaleOutcome;
  /** Lo que quedó (o debía quedar) en `order_invoices.error`, sin el token. */
  error: string | null;
  /** La fila pasó de `emitiendo` a lo que contestó SimpleFact. */
  saved: boolean;
  saveError: string | null;
}

/**
 * El envío de un turno real ya reservado (§35.4): UNA llamada a SimpleFact, lo
 * que quiere decir lo que contestó, y la fila al estado que corresponde, solo si
 * sigue en `emitiendo`. Nunca reintenta. Si el envío lanza, no se sabe si la
 * venta se creó: es una duda (`en_duda`), nunca un no.
 */
async function sendClaimedSale(input: {
  admin: SupabaseClient;
  deps: InvoiceSweepDeps;
  conn: SimplefactConn;
  ruc: string;
  invoiceId: string;
  payload: SimplefactSalePayload;
  redact: (text: string) => string;
}): Promise<SentSale> {
  const { admin, deps, conn, ruc, invoiceId, payload, redact } = input;
  let res: SimplefactHttp;
  try {
    res = await deps.createSale(conn, payload);
  } catch (err) {
    res = { http: null, body: null, error: `El envío se cortó: ${err instanceof Error ? err.message : "error desconocido"}` };
  }
  const outcome = classifySaleResponse(res.http, res.body, ruc);
  const base = { response: storedResponse(res, redact), http_status: res.http };
  let update: Record<string, unknown>;
  let error: string | null;
  if (outcome.status === "emitida") {
    error = outcome.rucMismatch ? `SimpleFact contestó con archivos del RUC ${outcome.ruc}, no del ${ruc}.` : null;
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
      error,
    };
  } else {
    const detail = res.error && res.error !== outcome.error ? `${outcome.error} (${res.error})` : outcome.error;
    error = redact(detail).slice(0, 500);
    update = { ...base, status: outcome.status, error };
  }
  const saved = await admin
    .from("order_invoices")
    .update(update)
    .eq("id", invoiceId)
    .eq("status", "emitiendo")
    .select("id");
  return {
    outcome,
    error,
    saved: !saved.error && ((saved.data ?? []) as unknown[]).length > 0,
    saveError: saved.error ? saved.error.message : null,
  };
}

/**
 * Si lo que contestó SimpleFact apaga el RUC (§35.4), por qué: una venta con
 * archivos de otro RUC (el token no es de este RUC), un token rechazado o una
 * cuenta que no responde. null si no lo apaga.
 */
function turnOffReason(outcome: SaleOutcome): string | null {
  if (outcome.status === "emitida" && outcome.rucMismatch) {
    return `SimpleFact emitió con archivos del RUC ${outcome.ruc}: el token no es de este RUC.`;
  }
  if (outcome.status === "error" && outcome.stop === "issuer") return outcome.error;
  return null;
}

/**
 * Apaga el RUC con el motivo a la vista (§35.4), esté en «Real» o en «Manual».
 * También borra la prueba de conexión: si quedaba la vieja, el owner podía
 * volver a encenderlo sin probar de nuevo y emitir otra boleta con el token
 * rechazado o de otra empresa. Real (0257) y Manual (0261) exigen una prueba
 * que leyó el mismo RUC, así que vuelve solo con «Probar conexión». El motivo
 * se queda. Devuelve el error de la base, o null.
 */
async function turnOffIssuer(
  admin: SupabaseClient,
  issuerId: string,
  why: string,
  redact: (text: string) => string,
): Promise<string | null> {
  const { error } = await admin
    .from("invoice_issuers")
    .update({ mode: "apagado", checked_ruc: null, checked_at: null, check_error: redact(why).slice(0, 500) })
    .eq("id", issuerId);
  return error ? error.message : null;
}

// ── «Emitir esta boleta» ─────────────────────────────────────────────────────

/**
 * ¿Este despliegue puede mandar boletas a SUNAT? Solo producción
 * (`VERCEL_ENV === "production"`).
 *
 * Una vista previa de Vercel comparte con producción la base y la llave de
 * cifrado (`ENCRYPTION_KEY`): descifra el token de SimpleFact igual, y una
 * boleta pedida desde ella es tan real como cualquiera. El barrido ya no emite
 * fuera de producción (app/api/cron/invoices/route.ts); «Emitir esta boleta»
 * tampoco. Sin `VERCEL_ENV` (en local) tampoco: falla cerrada.
 *
 * Lo usan la acción del panel (antes de leer nada), `emitInvoiceNow` (otra
 * vez, por si alguien la llama desde otro lado), el panel (`canEmitNow`) y el
 * «Emitir» de Ajustes (`loadInvoiceEmitNowOffers`), para no ofrecer un botón que
 * va a decir que no.
 */
export function invoiceEmitAllowedHere(): boolean {
  return process.env.VERCEL_ENV === "production";
}

/**
 * Lo que contesta «Emitir esta boleta».
 *
 *   ok: true  → se reservó el turno real y se llamó a SimpleFact UNA vez:
 *               `emitida` (serie, correlativo y PDF), `en_duda` (no se sabe si
 *               salió: la concilia el barrido por su nota «Kapta ‹ref›») o
 *               `error` (SimpleFact dijo que no, con su mensaje). `error` dice
 *               además lo que la persona tiene que saber: otro RUC en los
 *               archivos, el RUC que quedó apagado, una respuesta sin guardar.
 *   ok: false → NO se llamó a SimpleFact. `reason` es el código del panel y del
 *               barrido (INVOICE_REASON_LABEL) y `detail`, el porqué.
 */
export type InvoiceEmitNowResult =
  | {
      ok: true;
      status: "emitida" | "en_duda" | "error";
      invoiceId: string;
      serie: string | null;
      correlative: string | null;
      pdfUrl: string | null;
      error: string | null;
      rucMismatch: boolean;
    }
  | { ok: false; reason: InvoiceReason; detail?: string };

interface EmitNowState {
  /** El token descifrado, para limpiarlo de todo texto que sale. */
  secrets: Set<string>;
  /** El id del turno real reservado. Desde ahí, lo que falle es una duda. */
  claimed: string | null;
}

function blocked(reason: InvoiceReason, detail?: string | null): InvoiceEmitNowResult {
  return detail ? { ok: false, reason, detail } : { ok: false, reason };
}

/**
 * «Emitir esta boleta» (MOM §35.7, owner 15-10-2026): una persona con
 * `invoices.manage` emite UN pedido de un RUC en «Manual». Es la emisión real
 * del barrido, paso por paso y con el mismo código: los hechos del pedido,
 * `invoiceEligibility` evaluada como emisión real (`emitNow`), el token, la
 * relectura en Shopify con el total y el prepago web, la boleta con un id nuevo,
 * el turno (`invoice_claim` con `p_mode = 'real'` y `p_created_by` = quien
 * pulsó, 0261), UNA llamada a SimpleFact, la lectura de la respuesta, la fila
 * (solo si sigue en `emitiendo`) y las reglas que apagan el RUC. Los mismos
 * candados: un comprobante real vivo por pedido (el índice único de la 0257),
 * el tope del día de lo real y el turno que revisa todo de nuevo en la base.
 * Quien llama comprueba el permiso (`invoices.manage`); aquí no hay sesión.
 *
 * DECISIÓN: con el RUC en «Real» también emite (los mismos candados que el
 * barrido); el panel solo enseña el botón en «Manual», donde el barrido no
 * emite. En «Simulación» contesta `modo_distinto`; en «Apagado», `ruc_apagado`.
 * Con `manualOnly` (el botón del panel, `emitInvoiceAction`), en «Real» también
 * contesta `modo_distinto`: ahí emite el barrido, y el botón sería una segunda
 * puerta a la misma boleta.
 *
 * LO QUE SE VIO ES LO QUE SE ENVÍA. `expected` es lo que la persona confirmó:
 * el RUC y el total. Se compara con SU lectura —la misma con la que se arma la
 * boleta y se pide el turno—, justo después de las reglas y antes del token, de
 * Shopify y del turno. Si no coincide, `pedido_cambio` y no se llama a nada.
 * Antes lo comparaba la acción con una lectura propia, y entre esa lectura y
 * esta el pedido podía cambiar: salía una boleta que nadie confirmó.
 *
 * PAGADO ANTES DE «EMITIR DESDE» (owner, 15-10-2026). Con el RUC en «Manual»,
 * las reglas dejan pasar lo pagado desde el 01/10/2026 (`beforeStart`). Antes
 * de Kapta las boletas se emitían a mano en SimpleFact, así que, justo después
 * de comparar lo que vio, hace falta que la persona haya marcado que lo revisó
 * ahí (`expected.simplefactChecked`); si no, `sin_revision_simplefact` y no se
 * llama a nada. El turno va con `p_backfill` y la base exige lo mismo (0269).
 *
 * SOLO EN PRODUCCIÓN (`invoiceEmitAllowedHere`). La acción ya lo pide antes de
 * leer nada; aquí se vuelve a pedir, primero que todo, por si alguien la llama
 * desde otro lado. Se lee del entorno y no de `deps`: `deps` son los dobles de
 * lo que se toca afuera, y un interruptor ahí lo podría encender cualquier
 * llamador (o una prueba copiada). El entorno no se pasa por parámetro.
 *
 * No escribe `invoice_order_checks`, que es la revisión del barrido: quien pulsó
 * lee el motivo ahora. Y no respeta las 6 horas sin releer en Shopify: una
 * persona que pulsa quiere la lectura de ahora, y es un pedido, no una lista.
 *
 * NUNCA LANZA. Si algo no se pudo leer antes del turno, no se pide el turno ni
 * se llama a nada (`lectura_fallida`; sin una migración, `sin_migracion`).
 * SimpleFact solo se llama si el turno dio una fila real. Si algo lanzara
 * después del turno, la fila se queda en `emitiendo` y contesta `en_duda`: la
 * conciliación la busca por su nota, nunca se repite.
 */
export interface InvoiceEmitNowInput {
  orderId: string;
  /** Quien pulsó: queda en la fila (`created_by`). Sin él no se pide el turno. */
  userId: string;
  /**
   * Lo que la persona confirmó: el RUC y el total en céntimos. Si las reglas,
   * con la lectura de aquí, dicen otro, no se emite (`pedido_cambio`).
   *
   * `simplefactChecked`: marcó «Revisé en SimpleFact y este pedido no tiene
   * boleta». Hace falta, y solo cuenta un `true`, cuando el pedido quedó pagado
   * antes de «Emitir desde» (`beforeStart`); si no, `sin_revision_simplefact`.
   */
  expected?: { issuerId: string; totalCents: number; simplefactChecked?: boolean };
  /** Solo con el RUC en «Manual»: en «Real» emite el barrido (`modo_distinto`). */
  manualOnly?: boolean;
}

export async function emitInvoiceNow(
  admin: SupabaseClient,
  input: InvoiceEmitNowInput,
  deps: Partial<InvoiceSweepDeps> = {},
): Promise<InvoiceEmitNowResult> {
  const state: EmitNowState = { secrets: new Set(), claimed: null };
  const redact = (text: string) => redactSecrets(text, state.secrets);
  try {
    const full: InvoiceSweepDeps = { ...defaultInvoiceSweepDeps(admin), ...deps };
    return await emitNow(admin, full, input, state, redact);
  } catch (err) {
    const message = sinTelefonos(redact(err instanceof Error ? err.message : String(err)));
    if (state.claimed) {
      return {
        ok: true,
        status: "en_duda",
        invoiceId: state.claimed,
        serie: null,
        correlative: null,
        pdfUrl: null,
        error: `${invoiceUnreconciledError(state.claimed)}. (${message})`,
        rucMismatch: false,
      };
    }
    if (isInvoiceMigrationMissing(err)) return blocked("sin_migracion", message);
    return blocked("lectura_fallida", `No se pudo leer el pedido en Kapta: no se emitió nada (${message}).`);
  }
}

/**
 * ¿Lo que confirmó la persona es lo que saldría? El mismo RUC y el mismo total
 * al céntimo. Un `expected` mal formado no coincide con nada (falla cerrada).
 */
function sameAsExpected(elig: EligibleOrder, expected: NonNullable<InvoiceEmitNowInput["expected"]>): boolean {
  return (
    typeof expected.issuerId === "string" &&
    expected.issuerId !== "" &&
    Number.isInteger(expected.totalCents) &&
    expected.issuerId === elig.issuer.id &&
    expected.totalCents === elig.totalCents
  );
}

async function emitNow(
  admin: SupabaseClient,
  deps: InvoiceSweepDeps,
  input: InvoiceEmitNowInput,
  state: EmitNowState,
  redact: (text: string) => string,
): Promise<InvoiceEmitNowResult> {
  // Una vista previa no emite: antes de leer nada (`invoiceEmitAllowedHere`).
  if (!invoiceEmitAllowedHere()) return blocked("no_produccion");

  // Quién pulsó queda en la fila (`created_by`): sin saberlo no se pide el turno.
  if (typeof input.userId !== "string" || !input.userId.trim()) {
    return blocked("turno_fallido", "No se sabe quién emite: no se pidió el turno.");
  }

  // 1. Los hechos. Lanza si algo no se pudo leer, y no se emite (falla cerrada).
  const loaded = (await loadOrders(admin, [input.orderId])).get(input.orderId);
  if (!loaded) return blocked("pedido", "No se encontró el pedido.");
  const { facts, shopifyOrderId } = loaded;

  // 2. Las reglas de §35.3, como una emisión real: un RUC en «Manual» o «Real».
  const elig = invoiceEligibility(facts, { emitNow: true });
  if (!elig.ok) return blocked(elig.reason, elig.detail);
  const { issuer } = elig;

  // 2b. El botón del panel, solo en «Manual». En «Real» emite el barrido.
  if (input.manualOnly && issuer.mode !== "manual") {
    return blocked(
      "modo_distinto",
      `El RUC está en «${INVOICE_MODE_LABEL[issuer.mode] ?? issuer.mode}»: a mano solo se emite en «Manual».`,
    );
  }

  // 2c. Lo que vio la persona es lo que sale: el RUC y el total de ESTA lectura,
  // antes del token, de Shopify y del turno. La boleta que va a SUNAT no se
  // borra, y si el pedido cambió desde que lo abrió, confirmó otra.
  // Quien pulsa siempre confirma algo: el botón (`manualOnly`) sin lo que se
  // confirmó no emite. Si no, una llamada que olvidara mandarlo emitiría sin
  // comparar.
  if (input.manualOnly && !input.expected) return blocked("pedido_cambio");
  if (input.expected && !sameAsExpected(elig, input.expected)) return blocked("pedido_cambio");

  // 2d. Pagado antes de «Emitir desde» (owner, 15-10-2026): antes de Kapta las
  // boletas se emitían a mano en SimpleFact, y Kapta no sabe si este pedido ya
  // tiene una. Dos boletas son dos veces el impuesto: sin que la persona diga
  // que lo buscó ahí y no está, no sale. Antes del token, de Shopify y del turno.
  if (elig.beforeStart && input.expected?.simplefactChecked !== true) return blocked("sin_revision_simplefact");

  // 3. El token antes del turno, como el barrido: un turno sin token dejaría una
  // fila `emitiendo` que nunca se envió.
  const conn = await loadIssuerConn(admin, deps, issuer.id);
  if (!conn.ok) {
    return blocked(
      "sin_conexion",
      conn.why === "descifrado"
        ? "No se pudo descifrar el token de SimpleFact."
        : "No se pudo leer la conexión del RUC con SimpleFact.",
    );
  }
  state.secrets.add(conn.conn.token.trim());

  // 4. Justo antes de emitir, Shopify (§35.3): los ítems al céntimo.
  const prepared = await prepareSale(deps, facts, elig, shopifyOrderId);
  if (!prepared.ok) return blocked(prepared.reason, prepared.detail);

  // 5. El turno: una fila REAL, con quién la pidió. La base vuelve a revisar
  // todo, con el candado del RUC y el tope del día de lo real. Un pedido de
  // antes de «Emitir desde» va con `p_backfill` (0269): la base vuelve a exigir
  // la excepción entera.
  const args = claimArgs(facts, elig, prepared, { mode: "real", createdBy: input.userId });
  const claim = await admin.rpc("invoice_claim", args);
  if (claim.error) {
    // Sin la firma con `p_mode` y `p_created_by`: falta la 0261. Sin la de
    // `p_backfill`: falta la 0269, y solo un pedido de antes lo nota.
    if (isInvoiceMigrationMissing(claim.error)) return blocked("sin_migracion", claimMissingError(args).message);
    return blocked("turno_fallido", `El turno falló (${sinTelefonos(claim.error.message)}).`);
  }
  const answer = (claim.data ?? {}) as { id?: unknown; mode?: unknown; reason?: unknown };
  if (isReason(answer.reason)) return blocked(answer.reason);
  if (answer.id !== prepared.invoiceId || answer.mode !== "real") {
    return blocked("turno_fallido", "El turno contestó algo que no se entiende: no se envió nada.");
  }
  state.claimed = prepared.invoiceId;

  // 6. UNA llamada a SimpleFact, y la fila a lo que contestó.
  const sent = await sendClaimedSale({
    admin,
    deps,
    conn: conn.conn,
    ruc: issuer.ruc,
    invoiceId: prepared.invoiceId,
    payload: prepared.payload,
    redact,
  });
  const { outcome } = sent;
  const notes: string[] = sent.error ? [sent.error] : [];
  if (!sent.saved) {
    notes.push("No se pudo guardar la respuesta en Kapta: el comprobante sigue «Emitiendo» y la conciliación lo resuelve.");
    console.error(
      `[invoices] emitir a mano: no se pudo guardar la respuesta de SimpleFact (${sinTelefonos(redact(sent.saveError ?? "la fila ya no estaba emitiendo"))}).`,
    );
  }

  // 7. Las reglas que apagan el RUC, como en el barrido.
  const offWhy = turnOffReason(outcome);
  if (offWhy) {
    const error = await turnOffIssuer(admin, issuer.id, offWhy, redact);
    if (error) {
      notes.push("El RUC tenía que apagarse y no se pudo: apágalo en Ajustes.");
      console.error(`[invoices] emitir a mano: no se pudo apagar el RUC ${issuer.ruc} (${sinTelefonos(redact(error))}).`);
    } else {
      notes.push("El RUC quedó apagado: prueba la conexión antes de volver a encenderlo.");
    }
  }

  return {
    ok: true,
    status: outcome.status,
    invoiceId: prepared.invoiceId,
    serie: outcome.status === "emitida" ? outcome.serie : null,
    correlative: outcome.status === "emitida" ? outcome.correlative : null,
    pdfUrl: outcome.status === "emitida" ? outcome.pdfUrl : null,
    error: notes.length ? notes.join(" ") : null,
    rucMismatch: outcome.status === "emitida" && outcome.rucMismatch,
  };
}

// ── ¿Se ofrece «Emitir esta boleta»? El drawer y Ajustes ─────────────────────

/** La última revisión del barrido de un pedido (`invoice_order_checks`): una por modo. */
export interface InvoiceCheckRow {
  mode: string;
  reason: string;
  detail: string | null;
  checked_at: string;
}

/** Un comprobante del pedido, con lo que mira el botón: modo, estado y cuándo se escribió. */
export interface InvoiceEmitNowRow {
  mode: string;
  status: string;
  createdAt: string;
}

/**
 * Lo que sale si se pulsa: el RUC y el total de las reglas evaluadas como una
 * emisión real. Es lo que dice la confirmación y lo que `emitInvoiceAction`
 * vuelve a comparar antes de emitir.
 *
 * `beforeStart`: quedó pagado antes de «Emitir desde» (la excepción de
 * `INVOICE_BACKFILL_FROM`). La confirmación lo dice, con cuándo quedó pagado
 * (`paidAt`), cuándo se movió el primer dinero (`firstPaidAt`, la fecha más
 * temprana entre el comprobante y el registro de sus pagos: desde ahí se busca
 * en SimpleFact) y desde cuándo emite el RUC (`emitFrom`), y pide marcar que
 * se revisó en SimpleFact. Las fechas en ISO, o null si no se entienden.
 */
export interface InvoiceEmitNowOffer {
  issuerId: string;
  ruc: string;
  legalName: string;
  total: number;
  beforeStart: boolean;
  paidAt: string | null;
  firstPaidAt: string | null;
  emitFrom: string | null;
}

/** Una fecha como ISO («2026-10-14T15:00:00.000Z»), o null si no se entiende. */
function isoOrNull(value: string | null | undefined): string | null {
  const t = time(value);
  return t === null ? null : new Date(t).toISOString();
}

/**
 * ok: hay botón, y esto es lo que sale. Si no, `rules` es lo que dijeron las
 * reglas (con el RUC, si se llegó a saber) cuando son ellas las que lo frenan;
 * null cuando lo frena otra cosa —la tienda, un comprobante real vivo, el modo
 * del RUC o Shopify—, que el panel ya dice a su manera.
 */
export type InvoiceEmitNowReadiness =
  | { ok: true; offer: InvoiceEmitNowOffer }
  | { ok: false; rules: { reason: InvoiceReason; detail: string | null; issuer: InvoiceIssuer | null } | null };

/**
 * Lo que el barrido leyó en Shopify y lo frena. `lectura_fallida` no está en
 * `SHOPIFY_LEVEL_REASONS` (el barrido la reintenta en cada pasada), pero
 * mientras sea lo último que pasó, el pedido no está «listo»: tampoco salió.
 */
function isShopifySide(reason: string): reason is InvoiceReason {
  return isReason(reason) && (SHOPIFY_LEVEL_REASONS.has(reason) || reason === "lectura_fallida");
}

/**
 * ¿Lo frena Shopify? Las reglas de Kapta no leen Shopify: lo lee el barrido
 * justo antes de pedir el turno, y si lo frena, deja el motivo en
 * `invoice_order_checks` y no lo vuelve a leer en 6 horas. Mientras ese sea lo
 * último que pasó, «lista para emitirse» es falso: el barrido lo salta.
 *
 * Manda la revisión del modo del RUC. La del otro modo cuenta solo si es un
 * motivo de Shopify y es más nueva que la propia: el barrido también la respeta
 * («un motivo de Shopify es del pedido en Shopify, no del modo», `sweepOrg`).
 * Una revisión propia más nueva que no es de Shopify (el tope, por ejemplo)
 * quiere decir que Shopify ya se volvió a leer y dejó pasar el pedido.
 */
export function invoiceShopifyBlock<C extends InvoiceCheckRow>(
  checks: readonly C[],
  mode: InvoiceWriteMode,
): (C & { reason: InvoiceReason }) | null {
  const own = checks.find((c) => c.mode === mode);
  if (own && isShopifySide(own.reason)) return { ...own, reason: own.reason };
  const other = checks.find((c) => c.mode !== mode && isReason(c.reason) && SHOPIFY_LEVEL_REASONS.has(c.reason));
  // Una fecha que no se entiende cuenta como la más vieja.
  if (other && (!own || (time(other.checked_at) ?? 0) > (time(own.checked_at) ?? 0))) {
    return { ...other, reason: other.reason as InvoiceReason };
  }
  return null;
}

/**
 * ¿Lo frena Shopify para emitir a mano? Es el bloqueo que enseña el panel
 * (`invoiceShopifyBlock`) con el modo bajo el que el barrido revisa un RUC en
 * «Manual»: simulación, porque ahí escribe sus revisiones.
 *
 * Con una diferencia: un comprobante que se escribió DESPUÉS de esa revisión
 * la deja atrás. Un pedido simulado ya no vuelve a la lista del barrido, así que
 * su revisión no se reescribe: sin esto, un «no se encontró en Shopify» de hace
 * dos días escondería el botón para siempre aunque la simulación de después
 * haya leído Shopify y armado la boleta. Una externa no cuenta: no leyó Shopify.
 */
function emitNowShopifyBlock(checks: readonly InvoiceCheckRow[], invoices: readonly InvoiceEmitNowRow[]): boolean {
  const blocked = invoiceShopifyBlock(checks, "simulacion");
  if (!blocked) return false;
  const since = time(blocked.checked_at) ?? 0;
  return !invoices.some((i) => i.status !== "externa" && (time(i.createdAt) ?? 0) > since);
}

/**
 * ¿Hay «Emitir esta boleta» para este pedido? (MOM §35.7, owner 15-10-2026).
 * UN SOLO LUGAR lo decide: el botón del drawer (`emitNowOf`,
 * app/dashboard/pedidos/invoice-actions.ts) y el «Emitir» de los últimos
 * comprobantes de Ajustes (`loadInvoiceEmitNowOffers`). Antes Ajustes lo decidía
 * por su cuenta, solo con el modo del RUC de la simulada, y ofrecía emitir
 * pedidos que el drawer no dejaba: uno que ya no cumplía las reglas, frenado por
 * Shopify, de una tienda apagada o cuyo RUC ya no estaba en «Manual».
 *
 * Todo esto, y si falta uno, no hay botón:
 *
 *  · la tienda está activa (el barrido tampoco emite en una apagada);
 *  · no hay comprobante real vivo: uno por pedido, aunque el índice de la base
 *    lo garantice igual;
 *  · las reglas de §35.3 se cumplen evaluadas COMO UNA EMISIÓN REAL
 *    (`emitNow`): cuentan el error sin reintento y la conexión probada, y una
 *    simulación no frena;
 *  · el RUC que dicen HOY las reglas —el de la cuenta que recibió el pago, no
 *    el de una simulada vieja— está en «Manual». En «Real» emite el barrido y un
 *    botón sería una segunda puerta a la misma boleta; en «Simulación» y en
 *    «Apagado» no se emite;
 *  · Shopify no lo frena (`emitNowShopifyBlock`): un botón al lado de «Se emite
 *    a mano» o de «Espera a Shopify» se contradice, y el servidor relee Shopify
 *    igual antes de emitir.
 *
 * Un pedido pagado antes de «Emitir desde», pero desde el 01/10/2026
 * (`INVOICE_BACKFILL_FROM`), también lleva botón: las reglas como emisión real
 * con el RUC en «Manual» lo dejan pasar. La oferta lo dice (`beforeStart`), y
 * la confirmación pide marcar que se revisó en SimpleFact.
 *
 * Quién mira (`invoices.manage`) lo pone quien llama. Esto solo decide si se
 * enseña el botón: lo que se envía lo decide el servidor al pulsar, con todo
 * leído de nuevo (`emitInvoiceAction`).
 */
export function invoiceEmitNowReadiness(input: {
  facts: InvoiceOrderFacts;
  invoices: readonly InvoiceEmitNowRow[];
  checks: readonly InvoiceCheckRow[];
  storeActive: boolean;
}): InvoiceEmitNowReadiness {
  const { facts, invoices, checks, storeActive } = input;
  const no = (rules: Extract<InvoiceEmitNowReadiness, { ok: false }>["rules"] = null): InvoiceEmitNowReadiness => ({
    ok: false,
    rules,
  });
  if (!storeActive) return no();
  if (invoices.some((i) => i.mode === "real" && (LIVE_REAL_STATUSES as readonly string[]).includes(i.status))) {
    return no();
  }
  const elig = invoiceEligibility(facts, { emitNow: true });
  if (!elig.ok) {
    const issuer = facts.issuers.find((i) => i.id === elig.issuerId) ?? null;
    return no({ reason: elig.reason, detail: elig.detail ?? null, issuer });
  }
  if (elig.issuer.mode !== "manual") return no();
  if (emitNowShopifyBlock(checks, invoices)) return no();
  return {
    ok: true,
    offer: {
      issuerId: elig.issuer.id,
      ruc: elig.issuer.ruc,
      legalName: elig.issuer.legalName,
      total: elig.totalCents / 100,
      beforeStart: elig.beforeStart,
      paidAt: isoOrNull(elig.paidAt),
      firstPaidAt: isoOrNull(elig.firstPaidAt),
      emitFrom: isoOrNull(elig.issuer.emitFrom),
    },
  };
}

/**
 * «Emitir» en los últimos comprobantes de Ajustes (§35.7): de estos pedidos,
 * los que tendrían ahora «Emitir esta boleta» en el drawer, con lo que saldría.
 * Es `invoiceEmitNowReadiness` con lo mismo que lee el drawer —los hechos, los
 * comprobantes del pedido, sus revisiones y si la tienda está activa—, leído
 * de una vez para toda la lista: una sola llamada a `loadInvoiceOrderFacts`.
 *
 * LANZA si algo no se pudo leer (falla cerrada): quien llama no ofrece ningún
 * botón. Un pedido que no existe no está en el mapa.
 *
 * Fuera de producción no ofrece ninguno, sin leer nada: la acción lo rechazaría
 * igual (`invoiceEmitAllowedHere`), y un botón que dice que no es una trampa.
 */
export async function loadInvoiceEmitNowOffers(
  admin: SupabaseClient,
  orderIds: string[],
): Promise<Map<string, InvoiceEmitNowOffer>> {
  const out = new Map<string, InvoiceEmitNowOffer>();
  if (!invoiceEmitAllowedHere()) return out;
  const ids = unique(orderIds.filter(Boolean));
  if (!ids.length) return out;
  const [facts, invoices, checks] = await Promise.all([
    loadInvoiceOrderFacts(admin, ids),
    selectIn<{ order_id: string; mode: string; status: string; created_at: string }>(
      admin,
      "order_invoices",
      "order_id,mode,status,created_at",
      "order_id",
      ids,
    ),
    selectIn<InvoiceCheckRow & { order_id: string }>(
      admin,
      "invoice_order_checks",
      "order_id,mode,reason,detail,checked_at",
      "order_id",
      ids,
    ),
  ]);
  if (!facts.size) return out;
  const stores = await selectIn<{ id: string; status: string | null }>(
    admin,
    "stores",
    "id,status",
    "id",
    unique([...facts.values()].map((f) => f.storeId)),
  );
  const active = new Set(stores.filter((s) => s.status === "active").map((s) => s.id));
  for (const [orderId, f] of facts) {
    const ready = invoiceEmitNowReadiness({
      facts: f,
      invoices: invoices
        .filter((r) => r.order_id === orderId)
        .map((r) => ({ mode: r.mode, status: r.status, createdAt: r.created_at })),
      checks: checks.filter((c) => c.order_id === orderId),
      storeActive: active.has(f.storeId),
    });
    if (ready.ok) out.set(orderId, ready.offer);
  }
  return out;
}
