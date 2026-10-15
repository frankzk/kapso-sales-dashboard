"use server";

// Panel «Comprobante» del drawer (MOM §35.4, §35.7, §35.9).
//
// Seis acciones: leer el estado del comprobante del pedido, registrar uno
// emitido fuera de Kapta, pedir que se vuelva a intentar uno que terminó en
// error, de uno que quedó en duda registrar la serie con que sí salió o
// liberarlo porque no salió y, con el RUC en «Manual», «Emitir esta boleta».
//
// EMITIR A MANO ES SOLO DE «MANUAL» (owner, 15-10-2026). En «Real» emite el
// barrido y aquí no hay botón; en «Simulación» no se emite. «Emitir esta
// boleta» no fuerza nada: corre la MISMA emisión real del barrido
// (`emitInvoiceNow`, lib/invoicing/server.ts) con los mismos candados, y un
// pedido que no cumple las reglas tampoco sale por aquí. Esta capa no llama al
// turno ni a SimpleFact por su cuenta: solo pide el permiso, le pasa a
// `emitInvoiceNow` lo que la persona vio (que lo compara con SU lectura) y
// traduce lo que pasó. Y solo en producción: una vista previa comparte la base
// y la llave de cifrado, y desde ella saldría una boleta real.
//
// Lo que estas acciones cuidan, y por qué:
//
//  · VER ES DE QUIEN VE EL PEDIDO; TOCAR, DE «BOLETAS Y FACTURAS». La lectura
//    pasa por RLS (`authorizeOrder`) y las tablas de comprobantes se leen con el
//    service role, porque no tienen policy para el navegador (0257). Las cinco
//    escrituras piden además `invoices.manage` en la organización del pedido:
//    decidir que una boleta existe o que no existe, o mandarla a SUNAT, es un
//    permiso de dinero.
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
  emitInvoiceNow,
  invoiceEmitAllowedHere,
  invoiceEmitNowReadiness,
  invoiceShopifyBlock,
  isInvoiceMigrationMissing,
  loadInvoiceIssuers,
  loadInvoiceOrderFacts,
  type InvoiceCheckRow,
  type InvoiceEmitNowResult,
} from "@/lib/invoicing/server";
import {
  INVOICE_REASON_LABEL,
  LIVE_REAL_STATUSES,
  creditNoteWarning,
  invoiceEligibility,
  invoiceNoteRef,
  invoiceReleaseAvailableAt,
  invoiceReleaseBlock,
  type InvoiceIssuer,
  type InvoiceMode,
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
  created_at: string | null;
  /** En un `en_duda`, cuándo quedó en duda (`invoiceReleaseAvailableAt`). */
  updated_at: string | null;
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
    .select("id, org_id, order_id, mode, status, retry_requested_at, invoice_type, created_at, updated_at")
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
 * «falta una migración» si lo que falta es algo que crean la 0257 o la 0260 (el
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
  /**
   * Solo en un `en_duda`: desde cuándo se puede liberar con «No está en
   * SimpleFact: volver a intentar» (ISO, al minuto; `invoiceReleaseAvailableAt`).
   * Antes de esa hora el servidor no lo libera y dice
   * `invoiceReleaseWaitText(releaseAvailableAt)`. «Sí está en SimpleFact:
   * registrar su serie» no espera. null en otro estado, o en un `en_duda` del
   * que no se supo cuándo quedó en duda: ahí el servidor tampoco lo libera.
   */
  releaseAvailableAt: string | null;
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

/**
 * «Emitir esta boleta» está disponible, y lo que se va a enviar: lo que el
 * panel dice en la confirmación y lo que el servidor vuelve a comparar antes de
 * emitir (`emitInvoiceAction`). `total` es el de las reglas evaluadas como una
 * emisión real, en soles.
 *
 * `beforeStart`: quedó pagado antes de «Emitir desde» (owner, 15-10-2026). La
 * confirmación dice cuándo quedó pagado (`paidAt`), cuándo se movió el primer
 * dinero (`firstPaidAt`) y desde cuándo emite el RUC (`emitFrom`), en ISO, y
 * pide marcar «Revisé en SimpleFact y este pedido no tiene boleta». El
 * servidor (`invoiceEmitNowReadiness`) siempre los manda. Sin ellos el panel
 * no pide la casilla, y si el pedido es de antes, el servidor no emite
 * (`sin_revision_simplefact`): falla cerrada.
 */
export interface InvoicePanelEmitNow {
  issuerId: string;
  ruc: string;
  legalName: string;
  total: number;
  beforeStart?: boolean;
  paidAt?: string | null;
  firstPaidAt?: string | null;
  emitFrom?: string | null;
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
  /**
   * Los RUC de la organización, para registrar uno externo y para saber si el
   * del pedido está en «Manual». Sin token.
   */
  issuers: { id: string; ruc: string; legalName: string; mode: InvoiceMode }[];
  /** Tiene «Boletas y facturas» en la organización del pedido. */
  canManage: boolean;
  /**
   * Este despliegue puede emitir: es producción (`invoiceEmitAllowedHere`). En
   * una vista previa es false, `emitNow` es null y, si el botón habría salido,
   * `emitNowBlocked` dice `no_produccion`.
   */
  canEmitNow: boolean;
  /**
   * «Emitir esta boleta» (`emitNowOf`): solo a quien gestiona, en producción,
   * con el RUC del pedido en «Manual», sin comprobante real vivo, con las
   * reglas cumplidas como una emisión real y sin un bloqueo de Shopify vigente.
   * null: no hay botón.
   */
  emitNow: InvoicePanelEmitNow | null;
  /**
   * Con el RUC en «Manual», por qué no hay botón cuando el panel no lo dice de
   * otra forma (sin conexión probada, o una vista previa). Solo a quien
   * gestiona.
   */
  emitNowBlocked: { reason: InvoiceReason; detail: string | null } | null;
}

const INVOICE_PANEL_COLUMNS =
  "id, mode, status, ruc, total, serie, correlative, pdf_url, error, note, created_at, retry_requested_at, basis, ruc_mismatch, updated_at";

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
  updated_at: string | null;
}

/** La última revisión del barrido, como la lee el panel: una por modo. */
type CheckDbRow = InvoiceCheckRow;

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

const inactive = (canManage: boolean, canEmitNow: boolean): InvoicePanelData => ({
  active: false,
  invoices: [],
  review: { state: "sin_revisar", error: "" },
  check: null,
  creditNote: null,
  issuers: [],
  canManage,
  canEmitNow,
  emitNow: null,
  emitNowBlocked: null,
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
  // Una vista previa no ofrece «Emitir esta boleta»: la acción diría que no.
  const canEmitNow = invoiceEmitAllowedHere();

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
    return { data: inactive(canManage, canEmitNow) };
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
    if (isMissingInvoiceTable(cause)) return { data: inactive(canManage, canEmitNow) };
    return { error: `No se pudieron leer los RUC: ${message}` };
  }

  const rows = (invoicesRes.data ?? []) as unknown as InvoiceDbRow[];
  if (!issuers.length && !rows.length) return { data: inactive(canManage, canEmitNow) };

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
    // Un `en_duda` recién nacido no se libera (§35.4): el panel dice hasta cuándo.
    releaseAvailableAt:
      r.status === "en_duda" ? invoiceReleaseAvailableAt({ createdAt: r.created_at, updatedAt: r.updated_at }) : null,
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

  // «Emitir esta boleta»: sin los hechos no hay botón (falla cerrada).
  const emit = facts
    ? emitNowOf({ facts, invoices, checks, canManage, storeActive: ctx.storeActive, review, canEmitNow })
    : { emitNow: null, emitNowBlocked: null };

  return {
    data: {
      active: true,
      invoices,
      review,
      check: checkRow
        ? { mode: checkRow.mode, reason: checkRow.reason, detail: checkRow.detail, checkedAt: checkRow.checked_at }
        : null,
      creditNote,
      issuers: issuers.map((i) => ({ id: i.id, ruc: i.ruc, legalName: i.legalName, mode: i.mode })),
      canManage,
      canEmitNow,
      ...emit,
    },
  };
}

/**
 * ¿Hay «Emitir esta boleta» para este pedido? (owner, 15-10-2026). Quien mira
 * tiene que tener «Boletas y facturas»; lo demás —la tienda activa, sin
 * comprobante real vivo, las reglas como una emisión real, el RUC del pedido
 * en «Manual» y sin un bloqueo de Shopify— lo decide `invoiceEmitNowReadiness`
 * (lib/invoicing/server.ts), la MISMA función que decide el «Emitir» de los
 * últimos comprobantes de Ajustes: los dos botones salen o no salen juntos.
 *
 * Aquí, además, el porqué cuando no hay botón y el panel no lo dice de otra
 * forma (`emitNowBlocked`). Y fuera de producción (`canEmitNow` false) no hay
 * botón: donde lo habría, se dice `no_produccion`, porque la acción lo
 * rechazaría igual.
 *
 * Esto solo decide si se enseña el botón. Lo que se envía lo decide el servidor
 * al pulsar, con todo leído de nuevo (`emitInvoiceAction`).
 */
function emitNowOf(input: {
  facts: InvoiceOrderFacts;
  invoices: InvoicePanelRow[];
  checks: CheckDbRow[];
  canManage: boolean;
  storeActive: boolean;
  review: InvoicePanelReview;
  canEmitNow: boolean;
}): Pick<InvoicePanelData, "emitNow" | "emitNowBlocked"> {
  const none = { emitNow: null, emitNowBlocked: null };
  const { facts, invoices, checks, canManage, storeActive, review, canEmitNow } = input;
  if (!canManage || !storeActive) return none;
  const ready = invoiceEmitNowReadiness({ facts, invoices, checks, storeActive });
  if (ready.ok) {
    if (!canEmitNow) return { emitNow: null, emitNowBlocked: { reason: "no_produccion", detail: null } };
    return { emitNow: ready.offer, emitNowBlocked: null };
  }
  // Con el RUC en «Manual», el porqué cuando el panel no lo dice ya: la
  // revisión es la del barrido (que simula) y no mira la conexión ni los
  // errores reales. Un error sin reintento ya se ve con su «Volver a
  // intentar». Lo que no son las reglas (la tienda, un comprobante vivo,
  // Shopify) el panel ya lo dice a su manera.
  const why = ready.rules;
  const shown = review.state === "no" ? review.reason : null;
  if (!why || why.issuer?.mode !== "manual" || why.reason === shown || why.reason === "error_previo") return none;
  return { emitNow: null, emitNowBlocked: { reason: why.reason, detail: why.detail } };
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
  const blocked = invoiceShopifyBlock(checks, mode);
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
 * El modo del RUC que las reglas le dan HOY al pedido (§35.2): el de la cuenta
 * que recibió el pago, del que saldría la boleta. null si no se pudo leer o las
 * reglas no llegan a saberlo. Solo elige qué se le dice a la persona después de
 * «Volver a intentar» o de liberar un `en_duda` (`nextAttemptText`): no decide
 * nada, así que una lectura caída no frena la acción, que ya se hizo.
 */
async function orderRucMode(
  admin: ReturnType<typeof createAdminSupabase>,
  orderId: string,
): Promise<InvoiceMode | null> {
  try {
    const facts = (await loadInvoiceOrderFacts(admin, [orderId])).get(orderId);
    if (!facts) return null;
    const elig = invoiceEligibility(facts);
    const issuer = elig.ok ? elig.issuer : facts.issuers.find((i) => i.id === elig.issuerId);
    return issuer?.mode ?? null;
  } catch {
    return null;
  }
}

/**
 * Qué pasa después de «Volver a intentar» o de liberar un `en_duda`, según el
 * modo del RUC del pedido (§35.7). En «Real» lo vuelve a intentar el barrido en
 * la próxima pasada. En «Manual» el barrido solo simula y NO lo intenta: lo que
 * vuelve es «Emitir esta boleta» en el pedido, y lo pulsa una persona. Antes se
 * decía «la próxima pasada» también en Manual, y se esperaba una boleta que
 * nunca iba a salir sola. Sin saber el modo, se dicen los dos.
 */
function nextAttemptText(mode: InvoiceMode | null): string {
  if (mode === "real") return "se vuelve a intentar en la próxima pasada, si el pedido sigue cumpliendo las reglas.";
  if (mode === "manual") return "vuelve a aparecer «Emitir esta boleta» en el pedido, si sigue cumpliendo las reglas.";
  return "con el RUC en Real se vuelve a intentar en la próxima pasada, y en Manual vuelve a aparecer «Emitir esta boleta» en el pedido, si sigue cumpliendo las reglas.";
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
 * barrido (en «Real») o quien pulsa «Emitir esta boleta» (en «Manual») escribe
 * una fila nueva y esta se queda como historia.
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
  return { notice: `Listo: ${nextAttemptText(await orderRucMode(createAdminSupabase(), ctx.orderId))}` };
}

/**
 * «No está en SimpleFact: volver a intentar» (§35.4): un `en_duda` puede
 * existir, así que nunca se reintenta solo. Si una persona confirma en
 * SimpleFact que la boleta no está, lo libera dejando escrito qué revisó: pasa
 * a `error` con el reintento ya pedido.
 *
 * NO RECIÉN EN DUDA (INVOICE_RELEASE_MIN_AGE_MS, 30 minutos desde que quedó en
 * duda). Un POST cortado por tiempo puede haber llegado, y SimpleFact tardar en
 * listarlo: liberarlo en ese rato y volver a pulsar «Emitir esta boleta» son
 * dos boletas. Mientras tanto la conciliación la sigue buscando. Si no se sabe
 * desde cuándo está en duda, no se libera (falla cerrada). La espera es solo
 * para liberar: confirmar que SÍ está (`confirmDoubtfulInvoice`) no emite otra.
 *
 * El candado de la escritura sigue siendo el estado de partida (`en_duda`): de
 * una fila en duda solo se escribe para sacarla de la duda, así que su
 * `updated_at` no se mueve entre esta lectura y la escritura sin que cambie
 * también su estado.
 */
export async function releaseDoubtfulInvoice(invoiceId: string, note: string): Promise<InvoiceActionState> {
  const auth = await authorizeInvoice(invoiceId);
  if ("error" in auth) return { error: auth.error };
  const { ctx, invoice } = auth;
  if (invoice.status !== "en_duda") return { error: "Solo se libera un comprobante que está en duda." };
  const wait = invoiceReleaseBlock({ createdAt: invoice.created_at, updatedAt: invoice.updated_at }, new Date());
  if (wait) return { error: wait };
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
  return { notice: `Liberado: ${nextAttemptText(await orderRucMode(createAdminSupabase(), ctx.orderId))}` };
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

// ── «Emitir esta boleta» ─────────────────────────────────────────────────────

/** Lo que contesta «Emitir esta boleta»: el aviso y, si salió, su PDF. */
export interface EmitInvoiceState extends InvoiceActionState {
  /** El PDF de la boleta que SimpleFact acaba de emitir. Solo https. */
  pdfUrl?: string;
}

/**
 * Lo que la persona vio en la confirmación: el RUC y el total. `emitInvoiceNow`
 * lo vuelve a comparar con lo que se va a enviar, con su propia lectura.
 *
 * `simplefactChecked`: marcó «Revisé en SimpleFact y este pedido no tiene
 * boleta». Lo pide un pedido pagado antes de «Emitir desde»; en los demás no
 * cuenta.
 */
export interface EmitInvoiceShown {
  issuerId: string;
  total: number;
  simplefactChecked?: boolean;
}

/**
 * Lo que vio la persona y lo que se iba a enviar dejaron de coincidir: el
 * pedido, sus pagos o la cuenta del RUC cambiaron desde que se abrió. Es la
 * frase de `pedido_cambio`, el motivo con que lo dice `emitInvoiceNow`: una
 * sola, la diga quien la diga.
 */
const EMIT_CAMBIO = INVOICE_REASON_LABEL.pedido_cambio;

/** emitInvoiceNow lanzó, aunque su contrato es no lanzar: no se sabe si salió. */
const EMIT_SIN_SABER =
  "No se supo qué pasó con la emisión. Vuelve a abrir el pedido antes de intentar de nuevo: si quedó «Emitiendo» o «En duda», búscala en SimpleFact por su nota.";

/** Un motivo con la frase del panel y del barrido, y su detalle. */
function reasonText(reason: InvoiceReason, detail?: string | null): string {
  const label = INVOICE_REASON_LABEL[reason] ?? reason;
  return detail ? `${label} ${detail}` : label;
}

/**
 * Las frases del barrido que prometen lo que hace el barrido: «se vuelve a
 * intentar en la próxima pasada», «sale mañana». «Emitir esta boleta» emite con
 * el RUC en «Manual», donde el barrido solo simula: nada de eso sale solo, y lo
 * que sigue es volver a pulsar. Con su frase, la persona esperaba una boleta
 * que nunca iba a salir.
 */
const EMIT_NOW_REASON_LABEL: Partial<Record<InvoiceReason, string>> = {
  lectura_fallida:
    "No se pudo leer el pedido y no se emitió nada. En Manual no se reintenta solo: vuelve a pulsar «Emitir esta boleta».",
  tope: "Se llegó al tope diario del RUC y no se emitió. En Manual no sale sola: mañana se emite con «Emitir esta boleta».",
};

/** Un motivo de «Emitir esta boleta», con la frase del panel salvo las que prometen al barrido. */
function emitReasonText(reason: InvoiceReason, detail?: string | null): string {
  const label = EMIT_NOW_REASON_LABEL[reason];
  if (!label) return reasonText(reason, detail);
  return detail ? `${label} ${detail}` : label;
}

/**
 * Lo que pasó, en lo que lee quien pulsó. Solo una boleta que salió bien, de su
 * RUC y sin nada más que decir, es un aviso verde; todo lo demás va como error,
 * para que se lea: una en duda se busca en SimpleFact antes de nada, una con
 * archivos de otro RUC puede necesitar anularse, y un «no» de SimpleFact o un
 * bloqueo no emitieron nada.
 */
function emitResultState(result: InvoiceEmitNowResult): EmitInvoiceState {
  if (!result.ok) return { error: emitReasonText(result.reason, result.detail) };
  const extra = result.error?.trim() ? result.error.trim() : null;
  if (result.status === "emitida") {
    const serie = result.serie ? (result.correlative ? `${result.serie}-${result.correlative}` : result.serie) : null;
    const head = serie ? `Emitida ${serie}` : "Emitida (SimpleFact no devolvió la serie)";
    const pdf = result.pdfUrl && /^https:\/\//i.test(result.pdfUrl.trim()) ? result.pdfUrl.trim() : undefined;
    const withPdf = (state: EmitInvoiceState): EmitInvoiceState => (pdf ? { ...state, pdfUrl: pdf } : state);
    if (result.rucMismatch) {
      return withPdf({
        error: [
          `${head}, pero con archivos de otro RUC. Revísala en SimpleFact: puede necesitar anularse o una nota de crédito.`,
          extra,
        ]
          .filter(Boolean)
          .join(" "),
      });
    }
    return withPdf(extra ? { error: `${head}. ${extra}` } : { notice: head });
  }
  if (result.status === "en_duda") {
    return {
      error: [
        `SimpleFact no respondió: queda En duda; búscala por su nota «${invoiceNoteRef(result.invoiceId)}» antes de nada.`,
        extra ? `Detalle: ${extra}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  if (result.status === "error") {
    return { error: `SimpleFact no la emitió: ${extra ?? "no dio el motivo."}` };
  }
  // Un estado que no es ninguno de los tres: no se afirma nada (falla cerrada).
  return { error: EMIT_SIN_SABER };
}

/**
 * «Emitir esta boleta» (MOM §35.7, owner 15-10-2026): con el RUC del pedido en
 * «Manual», una persona con «Boletas y facturas» emite ESTE pedido. Las
 * primeras boletas reales salen una a una y se revisan en SimpleFact antes de
 * pasar a «Real».
 *
 * La emisión es `emitInvoiceNow`, la misma del barrido en real: los hechos, las
 * reglas como emisión real, la relectura en Shopify, el turno con quién pulsó
 * (`created_by`), UNA llamada a SimpleFact y las reglas que apagan el RUC. Aquí,
 * antes, solo lo que es de quien pulsa:
 *
 *  0. Es producción (`invoiceEmitAllowedHere`), antes de leer nada: una vista
 *     previa comparte la base y la llave de cifrado con producción, y desde
 *     ella saldría una boleta real. El barrido tampoco emite fuera de ella.
 *  1. Ve el pedido (RLS) y tiene `invoices.manage` en su organización, ANTES
 *     de leer nada con el service role o de escribir.
 *  2. Trae lo que vio en la confirmación (`shown`): sin eso no hay con qué
 *     comparar.
 *  3. La tienda está activa: el barrido tampoco emite en una apagada.
 *
 * Y le pide a `emitInvoiceNow` dos cosas que comprueba con SU lectura del
 * pedido, la misma con la que arma la boleta, antes del token, de Shopify y del
 * turno:
 *
 *  · `manualOnly`: el RUC está en «Manual». En «Real» emite el barrido: este
 *    botón sería una segunda puerta a la misma boleta (`modo_distinto`).
 *  · `expected`: lo que se va a enviar es lo que vio en la confirmación, el RUC
 *    y el total. Si el pedido o la cuenta del RUC cambiaron desde que lo abrió,
 *    no se emite (`pedido_cambio`): la boleta que va a SUNAT no se borra, y la
 *    persona confirmó otra. Y si marcó que lo revisó en SimpleFact
 *    (`simplefactChecked`): un pedido pagado antes de «Emitir desde» no sale
 *    sin eso (`sin_revision_simplefact`). Solo un `true` cuenta.
 *
 * Antes esta acción leía los hechos por su cuenta y comparaba con ESA lectura;
 * `emitInvoiceNow` leía de nuevo y no comparaba nada, y entre una lectura y la
 * otra el pedido podía cambiar. Ahora hay una sola lectura, y es la que se
 * envía. Si no se pudo leer, no se emite (falla cerrada).
 */
export async function emitInvoiceAction(orderId: string, shown: EmitInvoiceShown): Promise<EmitInvoiceState> {
  // Una vista previa no manda boletas a SUNAT: antes de leer o escribir nada.
  if (!invoiceEmitAllowedHere()) return { error: INVOICE_REASON_LABEL.no_produccion };

  const auth = await authorizeOrder(orderId);
  if ("error" in auth) return { error: auth.error };
  const { ctx } = auth;
  if (!(await hasOrgPermission(ctx.orgId, "invoices.manage"))) return { error: SIN_PERMISO };

  // Sin lo que vio la persona no hay con qué comparar: no se emite a ciegas.
  const shownIssuer = typeof shown?.issuerId === "string" ? shown.issuerId : "";
  const shownCents = Math.round(Number(shown?.total) * 100);
  if (!shownIssuer || !Number.isFinite(shownCents) || shownCents <= 0) return { error: EMIT_CAMBIO };
  // La casilla «Revisé en SimpleFact…»: solo un `true`. Un "true" o un 1 no es
  // una casilla marcada.
  const simplefactChecked = shown?.simplefactChecked === true;

  if (!ctx.storeActive) return { error: INVOICE_REASON_LABEL.tienda };

  const admin = createAdminSupabase();
  let result: InvoiceEmitNowResult;
  try {
    result = await emitInvoiceNow(admin, {
      orderId: ctx.orderId,
      userId: ctx.userId,
      manualOnly: true,
      expected: { issuerId: shownIssuer, totalCents: shownCents, simplefactChecked },
    });
  } catch (cause) {
    // No debería lanzar. Si lo hace, el turno pudo haberse pedido: no se dice
    // ni que salió ni que no salió, y el panel, al releerse, enseña lo que hay.
    // Al log va solo el tipo del error: su texto pudo haber tocado el token.
    console.error(`[invoices] emitir a mano: emitInvoiceNow lanzó (${cause instanceof Error ? cause.name : typeof cause}).`);
    return { error: EMIT_SIN_SABER };
  }
  return emitResultState(result);
}
