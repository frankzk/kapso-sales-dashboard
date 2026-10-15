"use server";

// Panel «Comprobante» del drawer (MOM §35.4, §35.7, §35.9).
//
// Cinco acciones: leer el estado del comprobante del pedido, registrar uno
// emitido fuera de Kapta, pedir que se vuelva a intentar uno que terminó en
// error y, de uno que quedó en duda, registrar la serie con que sí salió o
// liberarlo porque no salió. NO HAY «EMITIR»: emitir lo hace solo el barrido
// (§35.7). Un pedido que no cumple las reglas no se fuerza desde aquí.
//
// Lo que estas acciones cuidan, y por qué:
//
//  · VER ES DE QUIEN VE EL PEDIDO; TOCAR, DE «BOLETAS Y FACTURAS». La lectura
//    pasa por RLS (`authorizeOrder`) y las tablas de comprobantes se leen con el
//    service role, porque no tienen policy para el navegador (0257). Las cuatro
//    escrituras piden además `invoices.manage` en la organización del pedido:
//    decidir que una boleta existe o que no existe es un permiso de dinero.
//  · EL TOKEN NO SALE. Nada de aquí lee `token_enc`: los RUC llegan por
//    `loadInvoiceIssuers`, que ni siquiera lo trae, y al navegador solo viajan
//    el RUC y la razón social.
//  · LEER MAL NO ES «NO TIENE». Si los comprobantes no se pudieron leer, el
//    panel enseña el error, nunca «sin comprobante». Y si los hechos del pedido
//    no se pudieron leer, dice «No se pudo revisar» y no afirma que esté listo
//    para emitirse (§35.3, falla cerrada).
//  · LO QUE PASÓ NO SE REESCRIBE. Reintentar no toca la fila del error: le pone
//    quién lo pidió y el barrido escribe una fila nueva. La base lo exige
//    (`order_invoices_guard`), y aquí se filtra por el estado de partida para que
//    dos personas a la vez no pisen la decisión de la otra.

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import {
  SHOPIFY_LEVEL_REASONS,
  isInvoiceMigrationMissing,
  loadInvoiceIssuers,
  loadInvoiceOrderFacts,
} from "@/lib/invoicing/server";
import {
  INVOICE_REASONS,
  LIVE_REAL_STATUSES,
  creditNoteWarning,
  invoiceEligibility,
  type InvoiceIssuer,
  type InvoiceOrderFacts,
  type InvoiceReason,
  type InvoiceStatus,
  type InvoiceWriteMode,
} from "@/lib/invoicing/rules";

export interface InvoiceActionState {
  error?: string;
  notice?: string;
}

const SIN_ACCESO = "Sin acceso a este pedido.";
const SIN_PERMISO =
  "Sin permiso: los comprobantes los gestiona quien tiene «Boletas y facturas» (solo lo da el owner).";
const YA_TIENE = "Este pedido ya tiene un comprobante (o Kapta lo está emitiendo).";

/** Lo que queda escrito en el error de un `en_duda` que una persona liberó (§35.4). */
const LIBERADA = "Liberada a mano: no estaba en SimpleFact";

/** «B001-123», «F001-9»: la serie (letra y tres caracteres) y el número. */
const SERIE_NUMERO_RE = /^[A-Z]\w{3}-\d{1,8}$/i;

/**
 * Qué se revisó en SimpleFact antes de liberar o de confirmar un `en_duda`: sin
 * eso no se suelta ni se da por emitida.
 */
const RELEASE_NOTE_MIN = 5;
const NOTE_MAX = 500;

/**
 * Los hechos del pedido no se pudieron leer al registrar una externa: sin ellos
 * no se sabe a qué RUC entró el pago, y la fila no se corrige después.
 */
const SIN_COMPROBAR_RUC = "No se pudo comprobar a qué RUC entró el pago; intenta de nuevo.";

/** Lo que dice una escritura sobre un `en_duda` que otro resolvió entre la lectura y ella. */
const YA_NO_EN_DUDA = "El comprobante ya no está en duda: vuelve a abrir el pedido para ver su estado.";

/** Lo que una persona escribió como serie y número, ya validado. */
interface TypedSerie {
  serie: string;
  correlative: string;
  /** B = boleta (03), F = factura (01). */
  invoiceType: "01" | "03";
}

/**
 * «B001-123» como lo escribe una persona, validado igual en las dos acciones
 * que lo piden (la externa y la confirmación de un `en_duda`): sin espacios y
 * en mayúsculas, B o F, el número sin ceros a la izquierda y nunca 0.
 */
function parseSerieNumber(serieNumber: string): TypedSerie | { error: string } {
  const typed = String(serieNumber ?? "").replace(/\s+/g, "").toUpperCase();
  if (!SERIE_NUMERO_RE.test(typed)) {
    return { error: "Escribe la serie y el número como en SimpleFact: B001-123." };
  }
  const [serie, number] = typed.split("-") as [string, string];
  // B = boleta (03), F = factura (01). Otra letra no es un comprobante de venta.
  const invoiceType = serie.startsWith("B") ? "03" : serie.startsWith("F") ? "01" : null;
  if (!invoiceType) return { error: "La serie empieza con B (boleta) o con F (factura)." };
  const correlative = number.replace(/^0+(?=\d)/, "");
  if (correlative === "0") return { error: "El número del comprobante no puede ser 0." };
  return { serie, correlative, invoiceType };
}

// ── Acceso ───────────────────────────────────────────────────────────────────

interface OrderContext {
  userId: string;
  orderId: string;
  storeId: string;
  orgId: string;
  storeActive: boolean;
}

/**
 * Confirma que el usuario puede ver este pedido: la consulta va por RLS, así que
 * un pedido de otra tienda no aparece. Un error de lectura NO es «sin acceso»:
 * se dice que no se pudo leer, para no mandar a revisar permisos que están bien.
 */
async function authorizeOrder(orderId: string): Promise<{ ctx: OrderContext } | { error: string }> {
  if (!orderId) return { error: SIN_ACCESO };
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data, error } = await sb
    .from("order_master")
    .select("order_id, store_id")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) return { error: `No se pudo leer el pedido: ${error.message}` };
  const storeId = (data as { store_id?: string | null } | null)?.store_id;
  if (!storeId) return { error: SIN_ACCESO };
  const { data: store, error: storeError } = await sb
    .from("stores")
    .select("org_id, status")
    .eq("id", storeId)
    .maybeSingle();
  if (storeError) return { error: `No se pudo leer la tienda: ${storeError.message}` };
  const orgId = (store as { org_id?: string | null } | null)?.org_id;
  if (!orgId) return { error: SIN_ACCESO };
  return {
    ctx: {
      userId: user.id,
      orderId,
      storeId,
      orgId: String(orgId),
      storeActive: (store as { status?: string | null }).status === "active",
    },
  };
}

interface InvoiceRef {
  id: string;
  org_id: string;
  order_id: string;
  mode: string;
  status: string;
  retry_requested_at: string | null;
  /** 03 boleta, 01 factura: la serie que confirme un `en_duda` tiene que ser de ese tipo. */
  invoice_type: string | null;
}

/**
 * El comprobante, el pedido (que el usuario tiene que poder ver) y el permiso.
 * El comprobante se lee con el service role porque la tabla no tiene policy;
 * por eso la respuesta a «no existe» y a «no es tuyo» es la misma.
 */
async function authorizeInvoice(
  invoiceId: string,
): Promise<{ ctx: OrderContext; invoice: InvoiceRef } | { error: string }> {
  if (!invoiceId) return { error: "Ese comprobante no existe." };
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("order_invoices")
    .select("id, org_id, order_id, mode, status, retry_requested_at, invoice_type")
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) return { error: `No se pudo leer el comprobante: ${error.message}` };
  const invoice = data as InvoiceRef | null;
  if (!invoice) return { error: "Ese comprobante no existe." };
  const auth = await authorizeOrder(invoice.order_id);
  if ("error" in auth) return auth;
  // El comprobante es de la organización del pedido: otra cosa no debería
  // existir, y si existiera, no se toca desde la ficha de otro.
  if (invoice.org_id !== auth.ctx.orgId) return { error: SIN_ACCESO };
  if (!(await hasOrgPermission(auth.ctx.orgId, "invoices.manage"))) return { error: SIN_PERMISO };
  return { ctx: auth.ctx, invoice };
}

/**
 * La base todavía no tiene la 0257: el panel no se dibuja, no falla. Es la
 * misma regla del barrido (`isInvoiceMigrationMissing`): solo cuenta como
 * «falta una migración» si lo que falta es algo que crean la 0257 o la 0258 (el
 * panel solo lee tablas de la 0257); cualquier otra tabla ausente es un error de
 * verdad y se dice.
 */
function isMissingInvoiceTable(error: unknown): boolean {
  return isInvoiceMigrationMissing(error);
}

// ── Lectura ──────────────────────────────────────────────────────────────────

/** Un ítem de la boleta simulada, como se habría enviado (precio con IGV). */
export interface InvoicePanelItem {
  code: string;
  name: string;
  qty: number;
  price: number;
}

/** Una fila de `order_invoices`, solo con lo que se enseña. */
export interface InvoicePanelRow {
  id: string;
  mode: InvoiceWriteMode;
  status: InvoiceStatus;
  ruc: string;
  /** La razón social del RUC, si sigue dado de alta. */
  legalName: string | null;
  total: number;
  serie: string | null;
  correlative: string | null;
  pdfUrl: string | null;
  error: string | null;
  note: string | null;
  createdAt: string;
  retryRequestedAt: string | null;
  /** Registrada por una persona como emitida fuera de Kapta (`basis.manual`). */
  manual: boolean;
  /**
   * SimpleFact contestó con archivos de OTRO RUC (`ruc_mismatch`): la boleta
   * existe, pero no de la empresa que recibió el pago. El motivo va en `error`.
   */
  rucMismatch: boolean;
  /** Solo en una simulada: los ítems de la boleta que habría enviado. */
  items: InvoicePanelItem[] | null;
}

/**
 * Lo que dicen HOY las reglas de §35.3 con lo que hay en Kapta, y lo último que
 * el barrido leyó de Shopify. No relee Shopify: eso lo hace el barrido justo
 * antes de emitir.
 *
 * `issuerId` es el RUC que decidieron las reglas, cuando se llegó a saber: el
 * de la cuenta que recibió el pago. «Ya tiene comprobante» lo trae elegido.
 */
export type InvoicePanelReview =
  | { state: "lista"; ruc: string; legalName: string; mode: InvoiceWriteMode; issuerId: string }
  /**
   * Las reglas de Kapta se cumplen, pero la última pasada lo frenó por lo que
   * dijo Shopify (`SHOPIFY_LEVEL_REASONS` o `lectura_fallida`). El barrido lo
   * sigue saltando: decir «lista» aquí sería mentir.
   * `retry`: se vuelve a intentar solo (Shopify no se leyó o la tienda no
   * tiene conexión); si no, no sale sola y se emite a mano.
   * `waitsHours`: el barrido no vuelve a leer Shopify por este motivo hasta 6
   * horas después de `checkedAt` —es de `SHOPIFY_LEVEL_REASONS`, la misma
   * lista que recibe la base como `p_blocked`—; false, lo relee en la próxima
   * pasada (`lectura_fallida`). Con él, el panel no promete «la próxima
   * pasada» a lo que no se va a mirar en horas.
   */
  | {
      state: "shopify";
      ruc: string;
      legalName: string;
      mode: InvoiceWriteMode;
      issuerId: string;
      reason: InvoiceReason;
      detail: string | null;
      checkedAt: string;
      retry: boolean;
      waitsHours: boolean;
    }
  | { state: "no"; reason: InvoiceReason; detail: string | null; issuerId: string | null }
  /** No se pudieron leer los hechos: no se afirma nada (falla cerrada). */
  | { state: "sin_revisar"; error: string };

/** La última revisión del barrido (`invoice_order_checks`): una caché, no un hecho. */
export interface InvoicePanelCheck {
  mode: string;
  reason: string;
  detail: string | null;
  checkedAt: string;
}

export interface InvoicePanelData {
  /**
   * false: la base no tiene las tablas (0257) o la organización no tiene ningún
   * RUC ni comprobantes — una tienda cliente factura fuera de Kapta (§29.15).
   * El panel no se dibuja.
   */
  active: boolean;
  /** Del más nuevo al más viejo. */
  invoices: InvoicePanelRow[];
  review: InvoicePanelReview;
  check: InvoicePanelCheck | null;
  /** «Revisa si corresponde una nota de crédito» (§35.9), o null. */
  creditNote: string | null;
  /** Los RUC de la organización, para registrar uno externo. Sin token. */
  issuers: { id: string; ruc: string; legalName: string }[];
  /** Tiene «Boletas y facturas» en la organización del pedido. */
  canManage: boolean;
}

const INVOICE_PANEL_COLUMNS =
  "id, mode, status, ruc, total, serie, correlative, pdf_url, error, note, created_at, retry_requested_at, basis, ruc_mismatch";

interface InvoiceDbRow {
  id: string;
  mode: string;
  status: string;
  ruc: string;
  total: number | string;
  serie: string | null;
  correlative: string | null;
  pdf_url: string | null;
  error: string | null;
  note: string | null;
  created_at: string;
  retry_requested_at: string | null;
  basis: unknown;
  ruc_mismatch: boolean | null;
}

interface CheckDbRow {
  mode: string;
  reason: string;
  detail: string | null;
  checked_at: string;
}

const KNOWN_REASONS = new Set<string>(INVOICE_REASONS);

/**
 * Lo que el barrido leyó en Shopify y lo frena. `lectura_fallida` no está en
 * `SHOPIFY_LEVEL_REASONS` (el barrido la reintenta en cada pasada), pero
 * mientras sea lo último que pasó, el pedido no está «listo»: tampoco salió.
 */
function isShopifySide(reason: string): reason is InvoiceReason {
  return KNOWN_REASONS.has(reason) && (SHOPIFY_LEVEL_REASONS.has(reason as InvoiceReason) || reason === "lectura_fallida");
}

/**
 * Lo que dijo Shopify y no cambia con otra pasada: el pedido NO sale solo, se
 * emite a mano en SimpleFact y se registra con «Ya tiene comprobante». El resto
 * (`lectura_fallida`, `sin_token_shopify`) se vuelve a intentar solo.
 *
 * Lista cerrada a propósito, y un motivo nuevo que nadie clasificó cae del lado
 * de «se vuelve a intentar»: mandar a emitir a mano algo que el barrido podría
 * emitir después es el camino a dos boletas por un pedido, y eso es lo que no
 * puede pasar (§35.1). La prueba del drawer obliga a clasificar cada motivo de
 * `SHOPIFY_LEVEL_REASONS`.
 */
const SHOPIFY_MANUAL_REASONS: ReadonlySet<InvoiceReason> = new Set<InvoiceReason>([
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
  "no_encontrado",
]);

function time(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : 0;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Los pagos en que se basó el comprobante: los que, si dejan de valer, piden nota de crédito. */
function basisPaymentIds(basis: unknown): string[] {
  const payments = obj(basis).payments;
  if (!Array.isArray(payments)) return [];
  return payments.map((p) => obj(p).id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Los ítems de la boleta guardada (`request.items`), en el formato de SimpleFact. */
function itemsOf(request: unknown): InvoicePanelItem[] {
  const items = obj(request).items;
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const item = obj(raw);
    return {
      code: typeof item.code === "string" ? item.code : "",
      name: typeof item.name === "string" ? item.name : "",
      qty: Number(item.qty),
      price: Number(item.price),
    };
  });
}

const inactive = (canManage: boolean): InvoicePanelData => ({
  active: false,
  invoices: [],
  review: { state: "sin_revisar", error: "" },
  check: null,
  creditNote: null,
  issuers: [],
  canManage,
});

/**
 * Estado del comprobante del pedido para el drawer. Lo ve quien ve el pedido;
 * nunca devuelve credenciales (§35.7).
 */
export async function loadInvoicePanel(orderId: string): Promise<{ data: InvoicePanelData } | { error: string }> {
  const auth = await authorizeOrder(orderId);
  if ("error" in auth) return { error: auth.error };
  const { ctx } = auth;
  const admin = createAdminSupabase();

  const [invoicesRes, checksRes, canManage] = await Promise.all([
    admin
      .from("order_invoices")
      .select(INVOICE_PANEL_COLUMNS)
      .eq("order_id", orderId)
      .order("created_at", { ascending: false }),
    // Una por modo (la llave es pedido + modo): a lo más dos. Hacen falta las
    // dos: la del modo del RUC dice si Shopify lo frena (`reviewOf`).
    admin
      .from("invoice_order_checks")
      .select("mode, reason, detail, checked_at")
      .eq("order_id", orderId)
      .order("checked_at", { ascending: false }),
    hasOrgPermission(ctx.orgId, "invoices.manage"),
  ]);
  if (isMissingInvoiceTable(invoicesRes.error) || isMissingInvoiceTable(checksRes.error)) {
    return { data: inactive(canManage) };
  }
  // UN FALLO DE LECTURA NO ES UNA RESPUESTA: una lista vacía se pintaría como
  // «sin comprobante» y ofrecería registrar otro (payment-actions.ts, #AUR175525).
  if (invoicesRes.error) return { error: `No se pudieron leer los comprobantes: ${invoicesRes.error.message}` };
  if (checksRes.error) return { error: `No se pudo leer la última revisión: ${checksRes.error.message}` };

  let issuers: InvoiceIssuer[];
  try {
    issuers = await loadInvoiceIssuers(admin, ctx.orgId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isMissingInvoiceTable(cause)) return { data: inactive(canManage) };
    return { error: `No se pudieron leer los RUC: ${message}` };
  }

  const rows = (invoicesRes.data ?? []) as unknown as InvoiceDbRow[];
  if (!issuers.length && !rows.length) return { data: inactive(canManage) };

  // Lo que habría enviado la simulación. `request` solo se pide de la simulada:
  // de una real ya se enseña la serie y el PDF.
  const simulated = rows.filter((r) => r.status === "simulada").map((r) => r.id);
  const itemsById = new Map<string, InvoicePanelItem[]>();
  if (simulated.length) {
    const { data, error } = await admin
      .from("order_invoices")
      .select("id, request")
      .eq("order_id", orderId)
      .eq("mode", "simulacion");
    if (error) return { error: `No se pudo leer la boleta simulada: ${error.message}` };
    for (const row of (data ?? []) as { id: string; request: unknown }[]) itemsById.set(row.id, itemsOf(row.request));
  }

  const legalNameByRuc = new Map(issuers.map((i) => [i.ruc, i.legalName]));
  const invoices: InvoicePanelRow[] = rows.map((r) => ({
    id: r.id,
    mode: r.mode === "real" ? "real" : "simulacion",
    status: r.status as InvoiceStatus,
    ruc: r.ruc,
    legalName: legalNameByRuc.get(r.ruc) ?? null,
    total: Number(r.total),
    serie: r.serie,
    correlative: r.correlative,
    pdfUrl: r.pdf_url,
    error: r.error,
    note: r.note,
    createdAt: r.created_at,
    retryRequestedAt: r.retry_requested_at,
    manual: obj(r.basis).manual === true,
    rucMismatch: r.ruc_mismatch === true,
    items: r.status === "simulada" ? itemsById.get(r.id) ?? [] : null,
  }));

  // Lo que dicen hoy las reglas. FALLA CERRADA: si algo no se pudo leer, el
  // panel no dice «lista para emitirse» ni ningún motivo; dice que no revisó.
  const checks = (checksRes.data ?? []) as CheckDbRow[];
  let facts: InvoiceOrderFacts | null = null;
  let review: InvoicePanelReview;
  try {
    facts = (await loadInvoiceOrderFacts(admin, [orderId])).get(orderId) ?? null;
    review = facts
      ? reviewOf(facts, ctx.storeActive, checks)
      : { state: "sin_revisar", error: "No se encontró el pedido." };
  } catch (cause) {
    review = { state: "sin_revisar", error: cause instanceof Error ? cause.message : String(cause) };
  }

  // Nota de crédito (§35.9): lo emitido no se toca, pero si después un pago
  // dejó de valer o el pedido se anuló o se reembolsó, alguien tiene que mirar.
  const live = invoices.find(
    (i) => i.mode === "real" && (LIVE_REAL_STATUSES as readonly string[]).includes(i.status),
  );
  let creditNote: string | null = null;
  if (live && facts) {
    const refunded = Number(facts.totalRefunded ?? 0);
    creditNote = creditNoteWarning({
      status: live.status,
      mode: live.mode,
      basisPaymentIds: basisPaymentIds(rows.find((r) => r.id === live.id)?.basis),
      validatedPaymentIds: facts.payments.filter((p) => p.validationStatus === "validado").map((p) => p.id),
      cancelled: Boolean(facts.cancelledAt),
      // Un reembolso ilegible cuenta como reembolso: avisar de más es mirar.
      refunded: !Number.isFinite(refunded) || refunded !== 0,
    });
  }

  // La más nueva de las dos, como hasta ahora: el panel la enseña aparte si
  // dice otra cosa que la revisión (el tope, por ejemplo).
  const checkRow = checks[0];

  return {
    data: {
      active: true,
      invoices,
      review,
      check: checkRow
        ? { mode: checkRow.mode, reason: checkRow.reason, detail: checkRow.detail, checkedAt: checkRow.checked_at }
        : null,
      creditNote,
      issuers: issuers.map((i) => ({ id: i.id, ruc: i.ruc, legalName: i.legalName })),
      canManage,
    },
  };
}

/**
 * Las reglas de §35.3 sobre los hechos del pedido, y lo último que el barrido
 * leyó en Shopify, en lo que enseña el panel.
 */
function reviewOf(facts: InvoiceOrderFacts, storeActive: boolean, checks: CheckDbRow[]): InvoicePanelReview {
  const elig = invoiceEligibility(facts);
  if (!elig.ok) return { state: "no", reason: elig.reason, detail: elig.detail ?? null, issuerId: elig.issuerId ?? null };
  const { issuer, mode } = elig;
  // El barrido solo recorre las tiendas activas: listo en una apagada sería mentir.
  if (!storeActive) return { state: "no", reason: "tienda", detail: null, issuerId: issuer.id };
  const blocked = shopifyBlock(checks, mode);
  if (blocked) {
    return {
      state: "shopify",
      ruc: issuer.ruc,
      legalName: issuer.legalName,
      mode,
      issuerId: issuer.id,
      reason: blocked.reason,
      detail: blocked.detail,
      checkedAt: blocked.checked_at,
      retry: !SHOPIFY_MANUAL_REASONS.has(blocked.reason),
      // Lo dice la lista del barrido, no el panel: un motivo que entra o sale de
      // ella cambia aquí solo lo que se promete.
      waitsHours: SHOPIFY_LEVEL_REASONS.has(blocked.reason),
    };
  }
  return { state: "lista", ruc: issuer.ruc, legalName: issuer.legalName, mode, issuerId: issuer.id };
}

/**
 * ¿Lo frena Shopify? Las reglas de Kapta no leen Shopify: lo lee el barrido
 * justo antes de pedir el turno, y si lo frena, deja el motivo en
 * `invoice_order_checks` y no lo vuelve a leer en 6 horas. Mientras ese sea lo
 * último que pasó, «lista para emitirse» es falso: el barrido lo salta.
 *
 * Manda la revisión del modo del RUC. La del otro modo cuenta solo si es un
 * motivo de Shopify y es más nueva que la propia: el barrido también la respeta
 * («un motivo de Shopify es del pedido, no del modo», lib/invoicing/server.ts).
 * Una revisión propia más nueva que no es de Shopify (el tope, por ejemplo)
 * quiere decir que Shopify ya se volvió a leer y dejó pasar el pedido.
 */
function shopifyBlock(
  checks: CheckDbRow[],
  mode: InvoiceWriteMode,
): (CheckDbRow & { reason: InvoiceReason }) | null {
  const own = checks.find((c) => c.mode === mode);
  if (own && isShopifySide(own.reason)) return { ...own, reason: own.reason };
  const other = checks.find(
    (c) => c.mode !== mode && KNOWN_REASONS.has(c.reason) && SHOPIFY_LEVEL_REASONS.has(c.reason as InvoiceReason),
  );
  if (other && (!own || time(other.checked_at) > time(own.checked_at))) {
    return { ...other, reason: other.reason as InvoiceReason };
  }
  return null;
}

// ── Escrituras ───────────────────────────────────────────────────────────────

/**
 * El RUC que las reglas de §35.3 le dan al pedido, cuando se llega a saber: el
 * de la cuenta que recibió el pago. Con un pago sin cuenta, una cuenta sin RUC
 * o RUC mezclados no se sabe, y no se adivina: `issuer: null`.
 *
 * FALLA CERRADA: si los hechos no se pudieron leer (o el lector no devolvió el
 * pedido), `ok: false`, que NO es «no se sabe». Antes caía en null y se
 * aceptaba cualquier RUC: una caída de la base dejaba registrar, para siempre,
 * la boleta de una empresa que no cobró.
 */
async function expectedIssuer(
  admin: ReturnType<typeof createAdminSupabase>,
  orderId: string,
): Promise<{ ok: true; issuer: { id: string; ruc: string } | null } | { ok: false }> {
  let facts: InvoiceOrderFacts | undefined;
  try {
    facts = (await loadInvoiceOrderFacts(admin, [orderId])).get(orderId);
  } catch (cause) {
    // Se rechaza sin decir más a quien registra, pero queda dicho por qué: un
    // fallo que no se va bloquearía ese pedido sin que nadie supiera la razón.
    // El mensaje es de la base (tablas y columnas), sin datos de la clienta.
    console.error(
      `[invoices] comprobante externo: no se pudo comprobar el RUC del pago — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return { ok: false };
  }
  if (!facts) return { ok: false };
  const elig = invoiceEligibility(facts);
  const issuer = elig.ok ? elig.issuer : facts.issuers.find((i) => i.id === elig.issuerId);
  return { ok: true, issuer: issuer ? { id: issuer.id, ruc: issuer.ruc } : null };
}

/**
 * «Ya tiene comprobante» (§35.4): una persona emitió la boleta a mano en
 * SimpleFact —por ejemplo, la de un pedido de más de S/ 700 con DNI— y la
 * registra aquí. Queda una fila `externa` y Kapta no vuelve a emitir por ese
 * pedido: el índice único de la base lo garantiza.
 */
export async function registerExternalInvoice(
  orderId: string,
  issuerId: string,
  serieNumber: string,
  note: string,
): Promise<InvoiceActionState> {
  const auth = await authorizeOrder(orderId);
  if ("error" in auth) return { error: auth.error };
  const { ctx } = auth;
  if (!(await hasOrgPermission(ctx.orgId, "invoices.manage"))) return { error: SIN_PERMISO };

  const parsed = parseSerieNumber(serieNumber);
  if ("error" in parsed) return { error: parsed.error };
  const { serie, correlative, invoiceType } = parsed;
  const cleanNote = String(note ?? "").trim().slice(0, NOTE_MAX);

  const admin = createAdminSupabase();
  let issuer: InvoiceIssuer | undefined;
  try {
    issuer = (await loadInvoiceIssuers(admin, ctx.orgId)).find((i) => i.id === issuerId);
  } catch (cause) {
    return { error: `No se pudieron leer los RUC: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!issuer) return { error: "Ese RUC no es de la organización del pedido." };

  // EL RUC LO DECIDE A DÓNDE ENTRÓ EL PAGO, NO QUIEN REGISTRA (§35.2). Una
  // externa no se corrige después (`order_invoices_guard`): si las reglas ya
  // saben de qué RUC es el dinero, la boleta de otro no se registra. Si las
  // reglas no lo saben (cuenta sin RUC, RUC mezclados), vale el que se eligió.
  // Pero si los hechos NO SE PUDIERON LEER, no se registra: «no se pudo
  // comprobar» no es «no se sabe», y una externa con el RUC equivocado no tiene
  // arreglo. Una lectura caída se reintenta; una boleta ajena, no.
  const check = await expectedIssuer(admin, ctx.orderId);
  if (!check.ok) return { error: SIN_COMPROBAR_RUC };
  const expected = check.issuer;
  if (expected && expected.id !== issuer.id) {
    return { error: `El pago entró a una cuenta del RUC ${expected.ruc}: registra el comprobante de ese RUC.` };
  }

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("id, store_id, name, total_amount")
    .eq("id", ctx.orderId)
    .maybeSingle();
  if (orderError) return { error: `No se pudo leer el pedido: ${orderError.message}` };
  const row = order as { store_id: string; name: string | null; total_amount: number | string | null } | null;
  if (!row || row.store_id !== ctx.storeId) return { error: SIN_ACCESO };
  const total = Number(row.total_amount);
  // La base exige total > 0 (0257): se dice antes de chocar con ella.
  if (row.total_amount === null || !Number.isFinite(total) || total <= 0) {
    return { error: "El pedido no tiene monto: no se registra un comprobante por S/ 0." };
  }

  const { error } = await admin.from("order_invoices").insert({
    id: randomUUID(),
    org_id: ctx.orgId,
    store_id: ctx.storeId,
    order_id: ctx.orderId,
    issuer_id: issuer.id,
    ruc: issuer.ruc,
    mode: "real",
    status: "externa",
    invoice_type: invoiceType,
    order_name: row.name,
    total: Math.round(total * 100) / 100,
    basis: { manual: true },
    serie,
    correlative,
    note: cleanNote || null,
    created_by: ctx.userId,
  });
  if (error) {
    if (error.code === "23505") return { error: YA_TIENE };
    return { error: `No se pudo registrar el comprobante: ${error.message}` };
  }
  return { notice: `Comprobante ${serie}-${correlative} registrado: Kapta no emitirá otro por este pedido.` };
}

/**
 * «Volver a intentar» (§35.4): un `error` es que SimpleFact dijo que no, así que
 * no hay boleta, pero no se reintenta solo. Una persona lo pide, una vez; el
 * barrido escribe una fila nueva y esta se queda como historia.
 */
export async function requestInvoiceRetry(invoiceId: string): Promise<InvoiceActionState> {
  const auth = await authorizeInvoice(invoiceId);
  if ("error" in auth) return { error: auth.error };
  const { ctx, invoice } = auth;
  if (invoice.status !== "error") return { error: "Solo se vuelve a intentar un comprobante que terminó en error." };
  if (invoice.retry_requested_at) return { error: "Ya se pidió volver a intentar este comprobante." };

  const now = new Date().toISOString();
  const { data, error } = await createAdminSupabase()
    .from("order_invoices")
    .update({ retry_requested_at: now, retry_requested_by: ctx.userId })
    .eq("id", invoice.id)
    .eq("status", "error")
    .is("retry_requested_at", null)
    .select("id");
  if (error) return { error: `No se pudo pedir el reintento: ${error.message}` };
  // Otra persona lo pidió entre la lectura y la escritura: la suya vale.
  if (!(data as unknown[] | null)?.length) return { error: "Ya se pidió volver a intentar este comprobante." };
  return { notice: "Listo: se vuelve a intentar en la próxima pasada, si el pedido sigue cumpliendo las reglas." };
}

/**
 * «No está en SimpleFact: volver a intentar» (§35.4): un `en_duda` puede
 * existir, así que nunca se reintenta solo. Si una persona confirma en
 * SimpleFact que la boleta no está, lo libera dejando escrito qué revisó: pasa
 * a `error` con el reintento ya pedido.
 */
export async function releaseDoubtfulInvoice(invoiceId: string, note: string): Promise<InvoiceActionState> {
  const auth = await authorizeInvoice(invoiceId);
  if ("error" in auth) return { error: auth.error };
  const { ctx, invoice } = auth;
  if (invoice.status !== "en_duda") return { error: "Solo se libera un comprobante que está en duda." };
  const cleanNote = String(note ?? "").trim().slice(0, NOTE_MAX);
  if (cleanNote.length < RELEASE_NOTE_MIN) {
    return { error: "Escribe qué revisaste en SimpleFact: queda junto al comprobante." };
  }

  const now = new Date().toISOString();
  const { data, error } = await createAdminSupabase()
    .from("order_invoices")
    .update({
      status: "error",
      error: LIBERADA,
      note: cleanNote,
      resolved_by: ctx.userId,
      resolved_at: now,
      retry_requested_by: ctx.userId,
      retry_requested_at: now,
    })
    .eq("id", invoice.id)
    .eq("status", "en_duda")
    .select("id");
  if (error) return { error: `No se pudo liberar el comprobante: ${error.message}` };
  // La conciliación la encontró (o alguien la liberó) entre la lectura y ahora.
  if (!(data as unknown[] | null)?.length) return { error: YA_NO_EN_DUDA };
  return { notice: "Liberado: se vuelve a intentar en la próxima pasada, si el pedido sigue cumpliendo las reglas." };
}

/**
 * «Sí está en SimpleFact: registrar su serie» (§35.4): un `en_duda` cuya boleta
 * una persona SÍ encontró en SimpleFact (por su nota «Kapta ‹ref›»), y que la
 * conciliación no llegó a cerrar —su RUC ya no está en Real, es de antes de
 * ayer, o no aparece en las páginas que lee—. Sin esto, la única salida era
 * liberarla, y liberar una boleta que existe es emitir otra.
 *
 * Pasa a `emitida` con la serie y el número que salieron, y deja escrito dónde
 * se encontró. Es la misma fila: el RUC, el total, el tipo y lo enviado no
 * cambian (`order_invoices_guard` deja `en_duda` → `emitida` y nada más). La
 * letra de la serie tiene que ser la del tipo de la fila: una F no confirma una
 * boleta. No hay forma de corregirla después, así que se filtra por el estado
 * de partida: si la conciliación o otra persona la resolvió entre tanto, gana
 * la suya.
 */
export async function confirmDoubtfulInvoice(
  invoiceId: string,
  serieNumber: string,
  note: string,
): Promise<InvoiceActionState> {
  const auth = await authorizeInvoice(invoiceId);
  if ("error" in auth) return { error: auth.error };
  const { ctx, invoice } = auth;
  if (invoice.status !== "en_duda") return { error: "Solo se confirma un comprobante que está en duda." };

  const parsed = parseSerieNumber(serieNumber);
  if ("error" in parsed) return { error: parsed.error };
  const { serie, correlative, invoiceType } = parsed;
  // El tipo es el de lo que se envió. Un tipo que no se reconoce no se adivina:
  // no se confirma nada (falla cerrada).
  const expectedType = invoice.invoice_type === "01" || invoice.invoice_type === "03" ? invoice.invoice_type : null;
  if (!expectedType) return { error: "No se pudo saber si este comprobante es boleta o factura: no se confirma." };
  if (invoiceType !== expectedType) {
    return {
      error:
        expectedType === "03"
          ? "Este comprobante es una boleta: su serie empieza con B."
          : "Este comprobante es una factura: su serie empieza con F.",
    };
  }
  const cleanNote = String(note ?? "").trim().slice(0, NOTE_MAX);
  if (cleanNote.length < RELEASE_NOTE_MIN) {
    return { error: "Escribe dónde la encontraste en SimpleFact: queda junto al comprobante." };
  }

  const { data, error } = await createAdminSupabase()
    .from("order_invoices")
    .update({
      status: "emitida",
      serie,
      correlative,
      note: cleanNote,
      resolved_by: ctx.userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", invoice.id)
    .eq("status", "en_duda")
    .select("id");
  if (error) return { error: `No se pudo registrar la serie: ${error.message}` };
  // La conciliación la encontró (o alguien la liberó) entre la lectura y ahora.
  if (!(data as unknown[] | null)?.length) return { error: YA_NO_EN_DUDA };
  return { notice: `Comprobante ${serie}-${correlative} registrado como emitido: Kapta no emitirá otro por este pedido.` };
}
