// «Entregar a Swayp» · Lima (fase 3; owner 04-11-2026). Reglas puras.
//
// Swayp recoge las cajas de Lima en la oficina hacia las 07:00 del MISMO día
// de despacho, y las entregan Yohalis, Mildred o Yelitza (E1). Hasta ahora
// Kapta no registraba esa entrega: la custodia la ponía la sincronización de
// Swayp cuando su sistema cargaba la ruta (hacia las 05:45), tuviera o no la
// caja (las 9 «Bodega no despachó mercancía» con la caja armada).
//
// La entrega es UN cotejo, caja por caja delante del chofer, y se cierra con
// su nombre y cuántas cajas contó (E2, como la entrega a Aliclik). Manda lo
// cargado en Swayp (E3): Kapta no cambia el estado ni la custodia que reporta
// Swayp; registra quién entregó qué y a quién, y avisa las diferencias para que
// Seguimiento corrija ese mismo día. Lo que no sale lleva un motivo de una
// lista cerrada y su explicación (E4).
//
// Este archivo no importa lib/warehouse-swayp.ts (que sí lo importa a él): las
// etiquetas de día le llegan hechas. MOM §9.1, «Entrega a Swayp · Lima».

import { limaClock } from "@/lib/grupo-gf-courier";
import { SWAYP_STATES } from "@/lib/swayp-states";

/** La hora a la que pasa Swayp (E1, «a eso de las 7am de Lima»). */
export const SWAYP_PICKUP_LABEL = "07:00";

/** Estados de Swayp que ya cerraron la guía: la caja no se entrega (7 Entregada … 12). */
export const SWAYP_HANDOVER_CLOSED_STATES: ReadonlySet<number> = new Set([7, 8, 9, 10, 11, 12]);
/** Estados en los que Swayp tiene la guía en su ruta («la tiene en reparto»). */
export const SWAYP_ON_ROUTE_STATES: ReadonlySet<number> = new Set([4, 5, 6]);
/** Novedades de Swayp que dicen que la caja no salió de nuestra bodega (20) o que faltó inventario (18). */
export const SWAYP_UNDISPATCHED_NOVELTY_IDS: ReadonlySet<number> = new Set([18, 20]);

// ---------------------------------------------------------------------------
// Textos (el MOM los cita tal cual)
// ---------------------------------------------------------------------------

export const SWAYP_HANDOVER_BUTTON = (shortDay: string): string => `Entregar a Swayp · ${shortDay}`;
export const SWAYP_HANDOVER_NO_PERMISSION = "La entrega a Swayp la cierra quien tiene permiso de Despacho.";
export const SWAYP_HANDOVER_TITLE = (dayLabel: string): string => `Entrega a Swayp · ${dayLabel}`;
export const SWAYP_HANDOVER_HELP =
  `Escanea cada caja al dársela al chofer de Swayp (pasa hacia las ${SWAYP_PICKUP_LABEL}). La que no sale se marca «No sale» con su motivo.`;
export const SWAYP_HANDOVER_COUNTER = (done: number, total: number): string => `${done} de ${total} entregadas`;
export const SWAYP_HANDOVER_REMAINING = (missing: number): string =>
  missing === 0 ? "completa" : missing === 1 ? "falta 1" : `faltan ${missing}`;
export const SWAYP_HANDOVER_SCAN_LABEL = "QR, rótulo, guía Swayp o número de pedido";
export const SWAYP_HANDOVER_SCANNED = (code: string): string => `${code} entregada a Swayp.`;
export const SWAYP_HANDOVER_ALREADY = (code: string): string => `${code} ya estaba escaneada.`;
export const SWAYP_HANDOVER_RESTORED = (code: string): string => `${code} vuelve a la entrega y queda escaneada.`;
export const SWAYP_HANDOVER_UNDONE = (code: string): string => `${code} vuelve a «por entregar».`;
/** La nota de la Actividad del pedido al escanear (la entrega se confirma al cerrar con el nombre del chofer). */
export const SWAYP_HANDOVER_SCAN_NOTE = "Caja escaneada en la entrega a Swayp.";
export const SWAYP_HANDOVER_NOT_DISPATCH_DAY = "Hoy Swayp no despacha: no hay entrega.";
export const SWAYP_HANDOVER_CLOSED = "La entrega de hoy ya se cerró: no se reabre.";
export const SWAYP_HANDOVER_NO_VINO_DONE = "Hoy ya se marcó «Swayp no vino»: no hay entrega que abrir.";
export const SWAYP_HANDOVER_NOT_FOUND = "No encontramos la entrega a Swayp de hoy: vuelve a abrirla.";
export const SWAYP_HANDOVER_EMPTY = "Swayp no lleva nada de Lima hoy: no hay entrega que abrir.";

// Por qué una caja no entra en la entrega de hoy.
export const SWAYP_HANDOVER_OTRO_COURIER = (code: string, courier: string): string =>
  `Esta salida es de ${courier} (${code}), no de Swayp: no la entregues.`;
export const SWAYP_HANDOVER_PROVINCIA = "Esta guía es de provincia: la arma Swayp en su bodega, no sale de aquí.";
export const SWAYP_HANDOVER_NO_LIMA = "Esta guía no es de Lima ni de provincia: revísala con Despacho antes de entregarla.";
export const SWAYP_HANDOVER_SIN_FECHA = "Esta guía no tiene fecha de despacho: no la entregues.";
export const SWAYP_HANDOVER_OTRO_DIA = (dayLabel: string): string => `Esta caja sale el ${dayLabel}, no hoy: no la entregues.`;
export const SWAYP_HANDOVER_CERRADA = (state: string): string =>
  `Swayp ya cerró esta guía en su sistema (${state}): no la entregues.`;
export const SWAYP_HANDOVER_YA_ENTREGADA = "Esta caja ya se entregó a Swayp.";
export const SWAYP_HANDOVER_OTRA_RUTA = "Esta caja está en la ruta de otro courier: sácala de esa ruta antes de entregarla a Swayp.";

// «No sale» (E4: «que quede bien explicado porqué no sale»).
export const SWAYP_NO_SALE_BUTTON = "No sale";
export const SWAYP_NO_SALE_QUESTION = (code: string): string => `¿Por qué no sale ${code}?`;
export const SWAYP_NO_SALE_DETAIL_LABEL = "Explica qué pasó";
export const SWAYP_NO_SALE_PREFIX = "No sale: ";
export const SWAYP_NO_SALE_DETAIL_MIN = 10;
export const SWAYP_NO_SALE_DETAIL_MAX = 300;
export const SWAYP_NO_SALE_PICK = "Elige por qué no sale.";
export const SWAYP_NO_SALE_EXPLAIN = `Explica qué pasó (al menos ${SWAYP_NO_SALE_DETAIL_MIN} letras).`;
export const SWAYP_NO_SALE_TOO_LONG = `El detalle es muy largo (máximo ${SWAYP_NO_SALE_DETAIL_MAX} letras).`;
export const SWAYP_NO_SALE_FOLLOWUP = "Seguimiento: cambia la fecha en Swayp o anula la guía hoy.";
export const SWAYP_NO_SALE_DONE = (code: string): string => `${code} no sale. ${SWAYP_NO_SALE_FOLLOWUP}`;
export const SWAYP_NO_SALE_UNDO = "Deshacer";

export const SWAYP_NO_SALE_REASONS = [
  { code: "no_encontrada", label: "No se encontró la caja en la oficina", detailRequired: false },
  { code: "sin_stock", label: "No hay stock para armarla", detailRequired: false },
  { code: "otro_courier", label: "La caja salió con otro courier", detailRequired: false },
  { code: "danada", label: "La caja está dañada o incompleta", detailRequired: false },
  { code: "chofer_no_llevo", label: "El chofer de Swayp no la llevó", detailRequired: true },
  { code: "pedido_anulado", label: "El pedido se anuló o la clienta canceló", detailRequired: false },
  { code: "otro", label: "Otro motivo", detailRequired: true },
] as const;

export type SwaypNoSaleCode = (typeof SWAYP_NO_SALE_REASONS)[number]["code"];

/** Motivo con el que Kapta retira sola una caja que Swayp cerró antes de cerrar la entrega. */
export const SWAYP_NO_SALE_AUTO_CLOSED = (state: string): string =>
  `${SWAYP_NO_SALE_PREFIX}Otro motivo. Swayp cerró la guía en su sistema (${state}) antes de la recogida.`;

// Cierre.
export const SWAYP_CLOSE_DRIVER_LABEL = "¿Quién recoge? (nombre del chofer de Swayp)";
export const SWAYP_CLOSE_COUNT_LABEL = "¿Cuántas cajas contó el chofer?";
export const SWAYP_CLOSE_BUTTON = "Cerrar entrega";
export const SWAYP_CLOSE_NEW_IN_LOT = (codes: string[]): string =>
  codes.length === 1
    ? `Entró ${codes[0]} al lote de hoy: entrégala o márcala «No sale».`
    : `Entraron ${codes.join(", ")} al lote de hoy: entrégalas o márcalas «No sale».`;
export const SWAYP_CLOSE_NOTHING = "Ninguna caja se escaneó: no hay entrega que cerrar.";
export const SWAYP_CLOSE_MISSING = (missing: number): string =>
  missing === 1
    ? "Falta 1: entrégala o márcala «No sale» con su motivo."
    : `Faltan ${missing}: entrégalas o márcalas «No sale» con su motivo.`;
export const SWAYP_CLOSE_DRIVER = "Escribe el nombre del chofer de Swayp.";
export const SWAYP_CLOSE_COUNT = "Escribe cuántas cajas contó el chofer.";
export const SWAYP_CLOSE_COUNT_MISMATCH = (counted: number, scanned: number): string =>
  `El chofer contó ${counted} y escaneaste ${scanned}. Cuenten de nuevo antes de cerrar.`;

// «Swayp no vino».
export const SWAYP_NO_VINO_BUTTON = "Swayp no vino";
export const SWAYP_NO_VINO_REASON = "Swayp no vino";
export const SWAYP_NO_VINO_CONFIRM = (boxes: number): string =>
  `¿Swayp no vino hoy? ${boxes === 1 ? "La caja se queda" : `Las ${boxes} cajas se quedan`} en la oficina y Seguimiento tiene que cambiar la fecha en Swayp.`;

// Estado de la entrega en la zona «Hoy» (reemplaza «Kapta no registra la entrega a Swayp.»).
export const SWAYP_ENTREGA_SIN_ABRIR = `Swayp recoge hacia las ${SWAYP_PICKUP_LABEL}. Entrega sin abrir.`;
export const SWAYP_ENTREGA_EN_CURSO = (done: number, total: number): string => `Entrega en curso: ${done} de ${total}.`;
export const SWAYP_ENTREGA_CERRADA = (input: { receivedBy: string; boxes: number; time: string | null; noSale: number }): string =>
  [
    "Entrega cerrada",
    `recogió ${input.receivedBy} (Swayp)`,
    input.boxes === 1 ? "1 caja" : `${input.boxes} cajas`,
    input.time,
    input.noSale ? (input.noSale === 1 ? "1 no salió" : `${input.noSale} no salieron`) : null,
  ].filter(Boolean).join(" · ");
export const SWAYP_ENTREGA_NO_VINO = (boxes: number): string =>
  `Swayp no vino hoy: ${boxes === 1 ? "la caja sigue" : `las ${boxes} cajas siguen`} en la oficina. Seguimiento: cambia la fecha en Swayp.`;

// Las filas de «Hoy».
export const SWAYP_ROW_ENTREGADA = (time: string | null, who: string | null): string =>
  ["Entregada a Swayp" + (time ? ` ${time}` : ""), who ? `escaneó ${who}` : null].filter(Boolean).join(" · ");
export const SWAYP_ROW_NO_SALIO = (reason: string): string => `No salió: ${reason}`;
export const SWAYP_ROW_SIN_ENTREGA = "Sin entrega registrada.";
export const SWAYP_HOY_FALTA_ENTREGA =
  `Swayp pasa hacia las ${SWAYP_PICKUP_LABEL}: ármala y entrégala en «Entregar a Swayp», o márcala «No sale» con su motivo.`;
export const SWAYP_ALERT_NO_SALIO_EN_REPARTO =
  "Swayp la tiene en reparto y la caja no salió: Seguimiento cambia la fecha o anula la guía hoy, o Swayp reportará que no llegó.";
export const SWAYP_ALERT_NO_DESPACHO = (time: string | null, receivedBy: string | null): string =>
  `Swayp dice «Bodega no despachó mercancía», pero se le entregó${time ? ` a las ${time}` : ""}${receivedBy ? ` (recogió ${receivedBy})` : ""}. Reclámalo a Swayp.`;

// Fuera de la entrega.
/** El escáner de la estación, cuando la custodia la puso la sincronización de Swayp. */
export const SWAYP_SCAN_USE_HANDOVER = "Swayp ya cargó esta guía: escanéala en «Entregar a Swayp».";
/** La Mesa de Despacho ya no crea rutas de Swayp. */
export const SWAYP_MANIFEST_FROM_ALMACEN = "Swayp Lima se entrega desde Almacén › Swayp por salir.";
export const SWAYP_HANDOVER_ROUTE_LABEL = "Swayp Lima";
/** Una entrega de un día anterior que nadie cerró se cancela sola al abrir o cerrar la de hoy. */
export const SWAYP_HANDOVER_STALE_REASON = (dayLabel: string): string => `Entrega del ${dayLabel} sin cerrar`;

// ---------------------------------------------------------------------------
// Reglas
// ---------------------------------------------------------------------------

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** «07:04» en hora de Lima (horas que escribe Kapta, no las de Swayp). */
export function swaypHandoverTime(iso: string | null | undefined): string | null {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? hhmm(limaClock(new Date(t)).minute) : null;
}

/** El día de despacho de una guía: la fecha UTC de `next_followup_at` (igual que «Swayp por salir»). */
export function swaypHandoverDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null;
}

export function swaypStateName(state: number | null | undefined): string {
  return state != null ? SWAYP_STATES[state] ?? `estado ${state}` : "sin estado";
}

export interface SwaypHandoverShipment {
  courier: string | null;
  output_code: string | null;
  guide_code: string | null;
  swayp_state: number | null;
  custody_state: string | null;
  custody_transferred_by: string | null;
  next_followup_at: string | null;
}

export type SwaypHandoverVerdict = { ok: true; syncCustody: boolean } | { ok: false; error: string };

/**
 * ¿Esta salida entra en la entrega a Swayp del día `day`?
 *
 * La excepción de custodia es SOLO esta: Swayp carga su ruta hacia las 05:45 y
 * la sincronización pone custodia `courier` sin persona (`custody_transferred_by`
 * nulo) antes de que el chofer llegue a las 07:00. Esa caja sigue aquí y entra.
 * Si la custodia la pasó una persona, ya se entregó.
 */
export function swaypHandoverVerdict(
  s: SwaypHandoverShipment,
  ctx: { day: string; operation: string | null; courierLabel: string; dayLabelOf: (day: string) => string },
): SwaypHandoverVerdict {
  const code = s.output_code ?? s.guide_code ?? "esta salida";
  if ((s.courier ?? "").toLowerCase() !== "fenix") return { ok: false, error: SWAYP_HANDOVER_OTRO_COURIER(code, ctx.courierLabel) };
  if (ctx.operation === "provincia_cod") return { ok: false, error: SWAYP_HANDOVER_PROVINCIA };
  if (ctx.operation !== "lima") return { ok: false, error: SWAYP_HANDOVER_NO_LIMA };
  const day = swaypHandoverDay(s.next_followup_at);
  if (!day) return { ok: false, error: SWAYP_HANDOVER_SIN_FECHA };
  if (day !== ctx.day) return { ok: false, error: SWAYP_HANDOVER_OTRO_DIA(ctx.dayLabelOf(day)) };
  const custody = s.custody_state ?? "empresa";
  if ((s.swayp_state != null && SWAYP_HANDOVER_CLOSED_STATES.has(s.swayp_state)) || custody === "retorno" || custody === "devuelto") {
    return { ok: false, error: SWAYP_HANDOVER_CERRADA(swaypStateName(s.swayp_state)) };
  }
  if (custody === "empresa") return { ok: true, syncCustody: false };
  // Solo con Swayp en 1 a 6: su sistema la tiene cargada y todavía no la cerró.
  if (custody === "courier" && !s.custody_transferred_by && s.swayp_state != null && s.swayp_state >= 1 && s.swayp_state <= 6) {
    return { ok: true, syncCustody: true };
  }
  return { ok: false, error: SWAYP_HANDOVER_YA_ENTREGADA };
}

export interface SwaypNoSaleReason {
  code: SwaypNoSaleCode;
  label: string;
  detailRequired: boolean;
}

export function swaypNoSaleReason(code: string | null | undefined): SwaypNoSaleReason | null {
  return (SWAYP_NO_SALE_REASONS.find((reason) => reason.code === code) as SwaypNoSaleReason | undefined) ?? null;
}

/** El error de un «No sale» incompleto, o null. */
export function swaypNoSaleError(code: string | null | undefined, detail: string | null | undefined): string | null {
  const reason = swaypNoSaleReason(code);
  if (!reason) return SWAYP_NO_SALE_PICK;
  const clean = (detail ?? "").trim();
  if (clean.length > SWAYP_NO_SALE_DETAIL_MAX) return SWAYP_NO_SALE_TOO_LONG;
  if (reason.detailRequired && clean.length < SWAYP_NO_SALE_DETAIL_MIN) return SWAYP_NO_SALE_EXPLAIN;
  return null;
}

function sentence(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return /[.!?…]$/.test(clean) ? clean : `${clean}.`;
}

/** Lo que se guarda en `removal_reason`: «No sale: <motivo>. <detalle>». */
export function swaypNoSaleText(code: SwaypNoSaleCode, detail: string | null | undefined): string {
  const reason = swaypNoSaleReason(code)!;
  const clean = (detail ?? "").trim();
  return `${SWAYP_NO_SALE_PREFIX}${reason.label}.${clean ? ` ${sentence(clean)}` : ""}`;
}

/** El motivo legible sin el prefijo («No se encontró la caja en la oficina. …»). */
export function swaypNoSaleReasonText(removalReason: string | null | undefined): string | null {
  if (!removalReason) return null;
  return removalReason.startsWith(SWAYP_NO_SALE_PREFIX) ? removalReason.slice(SWAYP_NO_SALE_PREFIX.length) : removalReason;
}

/** El motivo de un texto guardado, si es uno de la lista. */
export function swaypNoSaleCodeOf(removalReason: string | null | undefined): SwaypNoSaleCode | null {
  const text = swaypNoSaleReasonText(removalReason);
  if (!text) return null;
  return SWAYP_NO_SALE_REASONS.find((reason) => text === `${reason.label}.` || text.startsWith(`${reason.label}. `))?.code ?? null;
}

/** La nota de la Actividad del pedido cuando una caja no sale. */
export function swaypNoSaleNote(removalReason: string): string {
  return `No salió con Swayp: ${swaypNoSaleReasonText(removalReason)} ${SWAYP_NO_SALE_FOLLOWUP}`;
}

/**
 * El motivo que Kapta propone cuando ya sabe por qué no sale: la caja salió con
 * la otra salida del pedido (la regla de paradero de «Swayp por salir»).
 */
export function swaypSuggestedNoSale(
  where: { kind: string; sibling: { code: string; courier: string } | null } | null | undefined,
): { code: SwaypNoSaleCode; detail: string } | null {
  if (where?.kind === "hermana_fuera" && where.sibling) {
    return { code: "otro_courier", detail: `La caja salió como ${where.sibling.code} con ${where.sibling.courier}.` };
  }
  return null;
}

/** Por qué no se puede cerrar la entrega, o null. */
export function swaypCloseError(input: {
  /** Programadas vivas del lote que no tienen fila en la entrega (entraron después de abrirla). */
  newInLot: string[];
  active: number;
  scanned: number;
  driverName: string | null | undefined;
  driverCount: number | null | undefined;
}): string | null {
  if (input.newInLot.length) return SWAYP_CLOSE_NEW_IN_LOT(input.newInLot);
  if (input.active === 0 || input.scanned === 0) return SWAYP_CLOSE_NOTHING;
  if (input.scanned < input.active) return SWAYP_CLOSE_MISSING(input.active - input.scanned);
  if ((input.driverName ?? "").trim().length < 3) return SWAYP_CLOSE_DRIVER;
  const count = input.driverCount;
  if (count == null || !Number.isInteger(count) || count < 0) return SWAYP_CLOSE_COUNT;
  if (count !== input.scanned) return SWAYP_CLOSE_COUNT_MISMATCH(count, input.scanned);
  return null;
}

/** La novedad de Swayp que dice que la caja no salió (20) o que faltó inventario (18). */
export function swaypSaysUndispatched(reportedStatus: string | null | undefined): boolean {
  const id = /\((\d+)\)\s*$/.exec(reportedStatus ?? "")?.[1];
  return id ? SWAYP_UNDISPATCHED_NOVELTY_IDS.has(Number(id)) : false;
}

// ---------------------------------------------------------------------------
// La entrega del día, para «Hoy» y el panel
// ---------------------------------------------------------------------------

export type SwaypHandoverItemStatus = "entregada" | "no_sale" | "por_entregar";

export interface SwaypHandoverItem {
  shipmentId: string;
  status: SwaypHandoverItemStatus;
  /** Escaneo (entregada) o retiro (no_sale). */
  at: string | null;
  time: string | null;
  by: string | null;
  /** Solo «No sale»: «No se encontró la caja en la oficina. …». */
  reason: string | null;
  reasonCode: SwaypNoSaleCode | null;
}

export type SwaypHandoverState = "abierta" | "cerrada" | "no_vino";

export interface SwaypHandover {
  manifestId: string;
  state: SwaypHandoverState;
  receivedBy: string | null;
  closedAt: string | null;
  closedTime: string | null;
  /** Filas activas (entregadas + por entregar). */
  total: number;
  delivered: number;
  noSale: number;
  missing: number;
  items: SwaypHandoverItem[];
  /** La línea de estado de la zona «Hoy». */
  statusLine: string;
  statusTone: "neutral" | "warn" | "crit" | "ok";
}

export interface SwaypHandoverManifestRow {
  id: string;
  state: string;
  received_by: string | null;
  custody_completed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

export interface SwaypHandoverItemRow {
  shipment_id: string;
  office_checked_at: string | null;
  office_checked_by: string | null;
  removed_at: string | null;
  removed_by: string | null;
  removal_reason: string | null;
}

/** La entrega del día a partir de su manifiesto y sus filas (todas, también las retiradas). */
export function buildSwaypHandover(
  manifest: SwaypHandoverManifestRow,
  rows: readonly SwaypHandoverItemRow[],
  names: Readonly<Record<string, string>>,
): SwaypHandover {
  const cancelled = manifest.state === "cancelled";
  const closed = manifest.state === "in_custody";
  const items: SwaypHandoverItem[] = rows.map((row) => {
    // Una ruta cancelada («Swayp no vino») retira todo con «Ruta cancelada: …»: no es un «No sale».
    if (row.removed_at && !cancelled) {
      return {
        shipmentId: row.shipment_id,
        status: "no_sale",
        at: row.removed_at,
        time: swaypHandoverTime(row.removed_at),
        by: row.removed_by ? names[row.removed_by] ?? null : null,
        reason: swaypNoSaleReasonText(row.removal_reason),
        reasonCode: swaypNoSaleCodeOf(row.removal_reason),
      };
    }
    const scanned = !cancelled && !!row.office_checked_at;
    return {
      shipmentId: row.shipment_id,
      status: scanned ? "entregada" : "por_entregar",
      at: scanned ? row.office_checked_at : null,
      time: scanned ? swaypHandoverTime(row.office_checked_at) : null,
      by: scanned && row.office_checked_by ? names[row.office_checked_by] ?? null : null,
      reason: null,
      reasonCode: null,
    };
  });
  const delivered = items.filter((item) => item.status === "entregada").length;
  const noSale = items.filter((item) => item.status === "no_sale").length;
  const total = cancelled ? rows.length : items.length - noSale;
  const missing = cancelled ? 0 : total - delivered;
  const closedTime = swaypHandoverTime(manifest.custody_completed_at);
  const state: SwaypHandoverState = cancelled ? "no_vino" : closed ? "cerrada" : "abierta";
  const statusLine =
    state === "no_vino"
      ? SWAYP_ENTREGA_NO_VINO(total)
      : state === "cerrada"
        ? SWAYP_ENTREGA_CERRADA({ receivedBy: manifest.received_by?.trim() || "sin nombre", boxes: delivered, time: closedTime, noSale })
        : SWAYP_ENTREGA_EN_CURSO(delivered, total);
  return {
    manifestId: manifest.id,
    state,
    receivedBy: manifest.received_by?.trim() || null,
    closedAt: manifest.custody_completed_at,
    closedTime,
    total,
    delivered,
    noSale,
    missing,
    items,
    statusLine,
    statusTone: state === "no_vino" ? "crit" : state === "cerrada" ? "ok" : "neutral",
  };
}

export interface SwaypHandoverRowTone {
  kind: "neutral" | "warn" | "crit" | "ok";
  text: string;
}

/**
 * Qué dice «Hoy» de una guía del lote frente a la entrega (E3: manda lo cargado
 * en Swayp; Kapta solo avisa). Las alertas van por estado, no por hora: las horas
 * de Swayp en Kapta llevan 5 h de desfase.
 */
export function swaypHandoverRowLine(
  handover: SwaypHandover | null,
  s: { id: string; swayp_state: number | null; custody_state?: string | null; reported_status?: string | null },
): SwaypHandoverRowTone | null {
  if (!handover) return null;
  const item = handover.items.find((row) => row.shipmentId === s.id);
  if (handover.state === "no_vino") return null;
  if (!item || item.status === "por_entregar") {
    // Swayp la cerró antes de la recogida (KP143987-S02): no entra, y se dice por qué.
    const closedInSwayp = (s.swayp_state != null && SWAYP_HANDOVER_CLOSED_STATES.has(s.swayp_state))
      || s.custody_state === "retorno" || s.custody_state === "devuelto";
    if (!item && closedInSwayp) return { kind: "warn", text: SWAYP_HANDOVER_CERRADA(swaypStateName(s.swayp_state)) };
    return handover.state === "cerrada" ? { kind: "warn", text: SWAYP_ROW_SIN_ENTREGA } : null;
  }
  if (item.status === "no_sale") {
    const text = SWAYP_ROW_NO_SALIO(item.reason ?? "sin motivo.");
    return s.swayp_state != null && SWAYP_ON_ROUTE_STATES.has(s.swayp_state)
      ? { kind: "crit", text: `${text} ${SWAYP_ALERT_NO_SALIO_EN_REPARTO}` }
      : { kind: "warn", text };
  }
  if (handover.state === "cerrada" && swaypSaysUndispatched(s.reported_status)) {
    return { kind: "crit", text: SWAYP_ALERT_NO_DESPACHO(item.time, handover.receivedBy) };
  }
  return { kind: "ok", text: SWAYP_ROW_ENTREGADA(item.time, item.by) };
}
