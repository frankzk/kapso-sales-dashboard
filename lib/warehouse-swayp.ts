// Almacén: «Swayp por salir · Lima» (fase 1, SOLO LECTURA; owner 03-11-2026).
// Reglas PURAS: sin IO, para el servidor, la estación de almacén y la puerta
// «Guía Swayp directa» de la asesora. El reloj entra siempre como parámetro.
//
// Por qué existe: toda guía Swayp nace `en_ruta` / `in_route` con su fecha de
// despacho en `next_followup_at` (lib/swayp-directa.ts, lib/swayp-reenvio.ts),
// así que sale de «Por armar» al instante (`hasExternalCustody`,
// lib/order-macro-stage.ts) y el almacén no la veía en ninguna lista. Las
// asesoras creaban guías para mañana sin avisar y el almacén no sabía qué
// faltaba. Esta lista dice, por día de despacho, cuántas hay, cuántas se
// armaron y CUÁL falta, con nombre, dónde está la caja y quién creó la guía.
//
// Decisiones del owner (03-11-2026):
// - D1. Las guías Swayp de Lima y Callao las arma nuestro almacén y Swayp las
//   recoge en la oficina; las de provincia las arma la bodega regional de
//   Swayp. Quién arma lo dice `order_master.macro_operation` («lima» incluye
//   Callao), nunca `shipments.city`: hay hijas de provincia con `city` nulo.
// - D2. El límite práctico es el corte del turno noche de la víspera (21:20,
//   lib/warehouse-shift.ts): Swayp toma la guía pasada la medianoche y desde que
//   la custodia pasa a `courier` el escáner ya no acepta la caja.
// - D3. Lo creado después de las 17:00 de la víspera (Swayp cierra su ruta de
//   16:00 a 17:00, MOM §9.1) es «Agregada tarde»; después de las 21:20, aviso
//   fuerte a la asesora y el siguiente día de despacho preseleccionado. Nada
//   bloquea.
// - D4. La caja armada con otra salida (la S01 de Grupo GF) no cuenta: la S02
//   de Swayp es FALTA hasta que se escanee con su rótulo.
// - D5. El lote del lunes lo arma el turno noche del domingo. La zona del
//   próximo día se titula «Próximo despacho · lunes 9 nov» cuando no es mañana.
//
// «Hoy», «Próximo», «Programadas», «Armadas», «Faltan» y «Salieron» son
// etiquetas de esta pantalla, no estados ni subetapas: no se guardan y no
// cambian el Master. Nada de aquí suma en «Por armar», en el número de Lima de
// «Por empacar» ni en «Entregas a couriers».

import { limaClock, nextDay } from "@/lib/grupo-gf-courier";
import { WAREHOUSE_SHIFTS, formatMinutes } from "@/lib/warehouse-shift";
import { firstSwaypDispatchDay, isSwaypDispatchDay } from "@/lib/swayp-dispatch-days";
import { SWAYP_STATES } from "@/lib/swayp-states";
import { courierDisplayName } from "@/lib/dispatched-with";
import { OPERATION_LABELS } from "@/lib/dispatch-routing";
import type { DispatchShipment } from "@/lib/dispatch-access";

// ---------------------------------------------------------------------------
// Horas que mandan
// ---------------------------------------------------------------------------

/** 17:00 de la víspera: Swayp cierra su ruta entre las 16:00 y las 17:00 (MOM §9.1). */
export const SWAYP_ROUTE_CLOSE_MINUTE = 17 * 60;
export const SWAYP_ROUTE_CLOSE_LABEL = "17:00";

const NIGHT_SHIFT = WAREHOUSE_SHIFTS.find((shift) => shift.id === "noche")!;
/** 21:20 de la víspera: el corte del turno noche (lib/warehouse-shift.ts), el límite real (D2). */
export const SWAYP_NIGHT_CUTOFF_MINUTE = NIGHT_SHIFT.cutoffMinutes;
export const SWAYP_NIGHT_CUTOFF_LABEL = NIGHT_SHIFT.cutoff;

/**
 * La relectura sola: cada 5 minutos, con la pestaña visible, de 16:00 a 21:30
 * de Lima (de cuando Swayp cierra su ruta hasta pasado el corte del turno noche).
 */
export const SWAYP_AUTO_REFRESH_MS = 5 * 60_000;
export const SWAYP_AUTO_REFRESH_FROM_MINUTE = 16 * 60;
export const SWAYP_AUTO_REFRESH_UNTIL_MINUTE = 21 * 60 + 30;

/** El estado de Swayp que es «Cancelada» (lib/swayp-states.ts). El mapa no define otra cancelación. */
export const SWAYP_CANCELLED_STATES: ReadonlySet<number> = new Set([10]);
/**
 * Los estados en que la guía termina `anulado` / `closed` DESPUÉS de que Swayp
 * tuvo la caja (`mapSwaypState`, lib/swayp.ts): 9 y 12, «Devolución
 * confirmada…» (los de `SWAYP_RETURN_STATES` que la sincronización cierra), y
 * 11, «Indemnizada». No son «Guía anulada en Kapta»: la caja salió con Swayp, y
 * en «Hoy» cuentan como lo que ya avanzó (revisión del 03-11-2026: los 319
 * anulado/closed/9 de 45 días eran devoluciones, no anulaciones).
 */
export const SWAYP_CLOSED_AFTER_PICKUP_STATES: ReadonlySet<number> = new Set([9, 11, 12]);
/** Hasta este estado Swayp todavía no tomó la guía en su sistema (1 Generada, 2 Preparada). */
export const SWAYP_NOT_TAKEN_MAX_STATE = 2;

// ---------------------------------------------------------------------------
// Textos (el MOM los cita tal cual)
// ---------------------------------------------------------------------------

export const SWAYP_TITLE = "Swayp por salir · Lima";
export const SWAYP_HELP =
  "Guías Swayp de Lima y Callao. La caja se arma aquí y Swayp la recoge en la oficina. Se cuenta por día de despacho y no suma en «Por armar».";
export const SWAYP_READ_AT = (time: string): string => `Leído ${time}`;
export const SWAYP_REFRESH = "Actualizar";
export const SWAYP_ERROR = "No pudimos cargar «Swayp por salir».";
/** Falló una relectura con un lote ya en pantalla: lo que se ve sí cargó, a su hora. */
export const SWAYP_REFRESH_ERROR = "No pudimos actualizar «Swayp por salir».";
export const SWAYP_RETRY = "Reintentar";
export const SWAYP_EMPTY = (day: string): string => `Swayp no lleva nada de Lima el ${day}.`;

export const SWAYP_HOY_TITLE = (day: string): string => `Hoy · ${day}`;
export const SWAYP_MANANA_TITLE = (day: string): string => `Mañana · ${day}`;
export const SWAYP_PROXIMO_TITLE = (day: string): string => `Próximo despacho · ${day}`;

/** Las cifras de la zona (navegan: «Las Cifras Navegan», DESIGN.md). */
export const SWAYP_FIGURE_LABEL = {
  programadas: "Programadas",
  armadas: "Armadas",
  faltan: "Faltan",
  agregadasTarde: "Agregadas tarde",
} as const;

// Chapas de las filas.
export const SWAYP_CHIP_SIN_ARMAR = "Sin armar";
export const SWAYP_CHIP_SALIDA_NUEVA = "Salida nueva";
export const SWAYP_CHIP_ERA_POR_DEFINIR = "Era «por definir»";
export const SWAYP_CHIP_ARMADA_POR_DEFINIR = "Armada como «por definir»";
/** «Agregada 20:43, después de las 17:00». Informa; no bloquea (D3). */
export const SWAYP_CHIP_LATE = (time: string): string => `Agregada ${time}, después de las ${SWAYP_ROUTE_CLOSE_LABEL}`;

// Renglones de la fila.
export const SWAYP_GUIDE_LINE = (code: string, guide: string | null): string =>
  guide && guide !== code ? `${code} · guía ${guide}` : code;
export const SWAYP_CREATED_LINE = (name: string, when: string | null): string =>
  `Creó la guía: ${name}${when ? ` · ${when}` : ""}`;
export const SWAYP_CREATOR_UNKNOWN = "sin registro";
/** La emisión del automático de Swayp (`swayp_guide_emissions.automatic`, MOM §11.13): no tiene persona. */
export const SWAYP_CREATOR_AUTOMATIC = "el automático";

// Dónde está la caja física (R11), en este orden.
export const SWAYP_WHERE_POR_DEFINIR = (code: string): string =>
  `Es la caja «por definir» ${code}: ármala y escanéala; el rótulo no cambia.`;
export const SWAYP_WHERE_HERMANA_ARMADA = (sibling: string, courier: string, code: string, siblingShort: string): string =>
  `La caja está armada como ${sibling} (${courier}): ponle el rótulo ${code}, escanéalo y avisa a Despacho que la ${siblingShort} no sale.`;
export const SWAYP_WHERE_HERMANA_VOLVIO = (sibling: string, courier: string, code: string): string =>
  `La ${sibling} (${courier}) volvió a la oficina: si la caja está entera, úsala con el rótulo ${code}; si no, ármala desde stock.`;
/**
 * La caja se armó con una hermana que salió con su courier y no se entregó (la
 * S01 de Grupo GF con el motorizado, o la de Tanders que viene de regreso).
 * Revisión del 03-11-2026 (14 de 31 faltas de 45 días); pendiente de que el
 * owner confirme el texto (MOM §9.1).
 */
export const SWAYP_WHERE_HERMANA_FUERA = (sibling: string, courier: string, code: string): string =>
  `La caja salió como ${sibling} (${courier}) y no se entregó: pide a Despacho que la traiga de vuelta, ponle el rótulo ${code} y escanéalo; si no vuelve a tiempo, ármala desde stock.`;
export const SWAYP_WHERE_STOCK = (code: string): string =>
  `No hay caja armada en Kapta para esta salida: ármala desde stock con el rótulo ${code}.`;

// Salieron de la lista (R8): nunca desaparece en silencio.
export const SWAYP_SALIO_CANCELADA = "Swayp la canceló";
export const SWAYP_SALIO_ANULADA = "Guía anulada en Kapta";
export const SWAYP_SALIO_PEDIDO_ANULADO = "Pedido anulado en la tienda";
export const SWAYP_SALIO_FECHA = (day: string, changedAt?: string | null): string =>
  `Fecha cambiada: ahora sale el ${day}${changedAt ? ` (cambió el ${changedAt})` : ""}`;
export const SWAYP_SALIO_ARMADA = "Estaba armada: sácala del sitio de Swayp.";

// Revisar (R1): ni Lima ni provincia. Se lista y no cuenta.
export const SWAYP_REVISAR_TITLE = "Revisar";
export const SWAYP_REVISAR_HELP =
  "Guías Swayp de este día cuyo pedido no es de Lima ni de provincia (agencia o sin clasificar): ábrelas y revisa la dirección. No cuentan.";
export const SWAYP_REVISAR_LINE = (operation: string): string => `Operación del pedido: ${operation}`;

// Pie de provincia (no cuenta).
export const SWAYP_PROVINCIA = (total: number, day: string, cities: string): string =>
  total === 1
    ? `Provincia: 1 guía Swayp sale el ${day} desde la bodega de Swayp (${cities}). No se empaca aquí.`
    : `Provincia: ${total} guías Swayp salen el ${day} desde bodegas de Swayp (${cities}). No se empacan aquí.`;
export const SWAYP_CITY_UNKNOWN = "Sin ciudad";

// Tono de la zona «Próximo» (siempre con texto, nunca solo color).
export const SWAYP_TONE_ANTES_VISPERA = (vispera: string): string =>
  `Lo arma el turno noche del ${vispera}, antes del corte de las ${SWAYP_NIGHT_CUTOFF_LABEL}.`;
export const SWAYP_TONE_VISPERA =
  `Swayp cierra su ruta entre las 16:00 y las ${SWAYP_ROUTE_CLOSE_LABEL}. Déjalo listo antes del corte de las ${SWAYP_NIGHT_CUTOFF_LABEL}.`;
export const SWAYP_TONE_CORTE = (left: string): string =>
  `Faltan ${left} para el corte de las ${SWAYP_NIGHT_CUTOFF_LABEL}: déjalo listo.`;
export const SWAYP_TONE_CERRO = (missing: number): string =>
  `El turno noche cerró con ${missing} sin armar: avisa a Seguimiento.`;
export const SWAYP_TONE_COMPLETO = "Lote completo.";
/**
 * Todas las faltas que quedan ya las tomó Swayp (custodia `courier`, estado 3
 * o más): el escáner ya no las acepta (`markShipmentReady` pide custodia
 * `empresa`), así que «déjalo listo» sería falso. La frase de «Hoy» para la que
 * Swayp ya tomó, contada (revisión del 03-11-2026; KP143987-S02 la tomó Swayp
 * el 03-11 a las 00:37 para el 04-11). Pendiente de que el owner la confirme.
 */
export const SWAYP_TONE_TOMADAS = (taken: number): string =>
  taken === 1
    ? "1 no se armó y Swayp ya la tomó en su sistema: si la caja sigue aquí, avisa hoy a Seguimiento."
    : `${taken} no se armaron y Swayp ya las tomó en su sistema: si las cajas siguen aquí, avisa hoy a Seguimiento.`;

// Zona «Hoy» (para cuadrar; no hay cifra de «recogidas»).
export const SWAYP_HOY_NOTE = "Kapta no registra la entrega a Swayp.";
export const SWAYP_HOY_STATE_LINE = (label: string, time: string | null): string =>
  `Swayp: ${label}${time ? ` · ${time}` : ""}`;
export const SWAYP_STATE_UNKNOWN = "sin estado";
export const SWAYP_HOY_FALTA_AQUI = "Sale hoy y no está armada: ármala, escanéala y avisa a Seguimiento.";
export const SWAYP_HOY_FALTA_TOMADA =
  "No se armó y Swayp ya la tomó en su sistema: si la caja sigue aquí, avisa hoy a Seguimiento.";

// Celda «Swayp · Lima» del marco «Por empacar» (no suma al número de Lima).
export const SWAYP_CELL_TITLE = "Swayp · Lima";
export const SWAYP_CELL_COMPLETE = "Completo";
export const SWAYP_CELL_ERROR = "No se pudo leer";
/**
 * Lo urgente de «Hoy» sube a la celda y al enlace de la cabecera: salidas de
 * hoy sin armar que siguen en la empresa y Swayp aún no tomó (revisión del
 * 03-11-2026: «Hoy» va al lado o debajo de «Próximo» y la celda solo miraba
 * «Próximo»).
 */
export const SWAYP_HOY_URGENT = (missing: number): string => `Hoy: ${missing} sin armar`;
/**
 * La celda Lima de «Por empacar» en cero mientras el lote Swayp de Lima tiene
 * faltas: esas cajas también se empacan aquí (D1), aunque no sumen (R9).
 */
export const SWAYP_LIMA_PANEL_ZERO = "En cero en «Por armar».";

// Escáner: el segundo aviso tras `markShipmentReady`, calculado en el cliente.
export const SWAYP_SCAN_COMPLETO = (day: string, total: number): string =>
  `Swayp ${day} · ${total} de ${total} armadas. Lote completo: júntalas en el sitio de Swayp.`;
export const SWAYP_SCAN_FALTAN = (day: string, armed: number, total: number, missing: string): string =>
  `Swayp ${day} · ${armed} de ${total} armadas · ${missing}.`;
export const SWAYP_SCAN_ROTULO_VIEJO = (sibling: string, courier: string, code: string): string =>
  `Ese rótulo es ${sibling} (${courier}). El pedido sale por Swayp con ${code}: imprime ese rótulo y escanéalo.`;
export const SWAYP_SCAN_CANCELADA = "Swayp canceló esta guía: no la juntes con el lote.";
export const SWAYP_SCAN_ANULADA = "Esta guía está anulada: no la juntes con el lote.";
export const SWAYP_SCAN_FECHA = (day: string): string => `Esta guía ahora sale el ${day}: guárdala aparte.`;
export const SWAYP_SCAN_FUERA = (proximo: string, withToday: boolean): string =>
  `Esta caja Swayp no sale ${withToday ? `hoy ni el ${proximo}` : `el ${proximo}`}: guárdala aparte y revisa la fecha en el pedido.`;
/** Cuántos códigos nombra el aviso antes de «y N más». */
export const SWAYP_SCAN_LIST_MAX = 3;

/** La chapa de «Armados hoy» de una caja de un lote cargado: «Swayp · mié 4 nov». */
export const SWAYP_ARMED_CHIP = (shortDay: string): string => `Swayp · ${shortDay}`;

// Asesora: puerta «Guía Swayp directa» (solo destinos de Lima o Callao).
export const SWAYP_ASESORA_CREATED = (day: string): string =>
  `Entró al lote Swayp de Lima del ${day}. Almacén lo ve en «Swayp por salir».`;
export const SWAYP_ASESORA_TARDE = "El almacén ya está cerrando ese lote: la verá como agregada tarde.";
export const SWAYP_ASESORA_NOCHE =
  "Ya no hay turno de almacén hoy y Swayp la toma en su sistema pasada la medianoche. Elige el siguiente día o avisa a Almacén.";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type SwaypZoneKind = "hoy" | "proximo";
export type SwaypToneKind = "neutral" | "warn" | "crit" | "ok";
export type SwaypChipTone = "neutral" | "info" | "ok" | "warn" | "crit";

/** Un tono va siempre con su frase: nunca solo color. */
export interface SwaypTone {
  kind: SwaypToneKind;
  text: string;
}

export interface SwaypChip {
  tone: SwaypChipTone;
  text: string;
}

export interface SwaypCounts {
  programadas: number;
  armadas: number;
  faltan: number;
  agregadasTarde: number;
}

/** Lo común a una guía de la lista. */
export interface SwaypGuideRow {
  shipmentId: string;
  orderId: string | null;
  storeId: string;
  storeName: string;
  /** El código de la salida (KP143987-S02), o la guía si no tiene. */
  code: string;
  guideCode: string | null;
  orderName: string;
  customerName: string;
  district: string | null;
  product: string | null;
  /** «KP143987-S02 · guía 50000165022». */
  title: string;
  /** «Cliente Ejemplo · San Bartolo». */
  customerLine: string;
  /** «#KP143987 · <tienda> · <producto>». */
  orderLine: string;
  /** Hora REAL de creación de la guía (emisión o primera gestión), nunca `shipments.created_at`. */
  guideCreatedAt: string | null;
  createdBy: string | null;
  /** «Creó la guía: <nombre> · martes 3 nov 00:11». */
  createdLine: string;
  /** Creada después de las 17:00 de la víspera (R7). */
  late: boolean;
  chips: SwaypChip[];
  /** Solo «Hoy»: «Swayp: Generada · 00:38». */
  swaypLine: string | null;
  /** «Imprimir rótulo» de esta salida. */
  labelHref: string;
}

export type SwaypWhereKind = "por_definir" | "hermana_armada" | "hermana_volvio" | "hermana_fuera" | "desde_stock";

export interface SwaypWhereabouts {
  kind: SwaypWhereKind;
  text: string;
  /** La hermana que la regla usó (b, c y la que salió con su courier). */
  sibling: { shipmentId: string; code: string; courier: string } | null;
}

export interface SwaypFaltaRow extends SwaypGuideRow {
  /** La salida nació con la guía (y no es una «por definir» rellenada). */
  newSalida: boolean;
  /** Swayp ya la tomó en su sistema (`swaypTaken`): el escáner ya no la acepta. */
  taken: boolean;
  /**
   * Dónde está la caja (R11). null si Swayp ya la tomó: pedir que se arme y se
   * escanee sería falso, porque `markShipmentReady` exige custodia `empresa`.
   */
  where: SwaypWhereabouts | null;
  /**
   * Qué hacer con la que no se armó: en «Hoy», siempre (crítico si sigue aquí y
   * Swayp no la tomó); en «Próximo», solo si Swayp ya la tomó.
   */
  actionLine: SwaypTone | null;
}

export interface SwaypArmadaRow extends SwaypGuideRow {
  readyAt: string | null;
  readyBy: string | null;
  /** Se escaneó antes de que existiera la guía (la caja «por definir»). */
  armedBeforeGuide: boolean;
  /** «KP1-S01 · armada lunes 2 nov 17:19 · <quién armó> · Cliente Ejemplo · Surco». */
  line: string;
}

export type SwaypExitReason = "swayp_cancelo" | "guia_anulada" | "pedido_anulado" | "fecha_cambiada";

export interface SwaypSalioRow {
  shipmentId: string;
  orderId: string | null;
  storeName: string;
  code: string;
  guideCode: string | null;
  orderName: string;
  customerName: string;
  district: string | null;
  reason: SwaypExitReason;
  /** «Swayp la canceló», «Fecha cambiada: ahora sale el viernes 6 nov»… */
  text: string;
  /** Solo «Fecha cambiada»: el día en que sale ahora. */
  newDay: string | null;
  wasArmed: boolean;
  /** «Estaba armada: sácala del sitio de Swayp.» si lo estaba. */
  armedText: string | null;
}

export interface SwaypRevisarRow {
  shipmentId: string;
  orderId: string | null;
  storeName: string;
  code: string;
  guideCode: string | null;
  orderName: string;
  customerName: string;
  district: string | null;
  operation: string | null;
  /** «Operación del pedido: Agencia». */
  text: string;
}

export interface SwaypProvincia {
  total: number;
  porCiudad: { city: string; count: number }[];
  /** null si no hay ninguna. */
  text: string | null;
  /** Para que el escáner no las trate como «fuera de lote». */
  shipmentIds: string[];
}

/** La celda «Swayp · Lima» de «Por empacar». La pantalla usa la de «Próximo». */
export interface SwaypCell {
  title: string;
  /** «Falta 1», «Faltan 2», «Completo» o «0». */
  big: string;
  /** «miércoles 4 nov · 9 programadas · 8 armadas». */
  sub: string;
  tone: SwaypTone | null;
}

export interface SwaypZone {
  kind: SwaypZoneKind;
  /** El día de despacho (YYYY-MM-DD, la fecha UTC de `next_followup_at`). */
  day: string;
  /** «miércoles 4 nov». */
  dayLabel: string;
  /** «mié 4 nov». */
  shortLabel: string;
  /** «Hoy · martes 3 nov», «Mañana · miércoles 4 nov», «Próximo despacho · lunes 9 nov». */
  title: string;
  /** El día calendario anterior (R6): cuándo lo arma el turno noche. */
  vispera: string;
  /** «Swayp miércoles 4 nov: 9 programadas · 8 armadas · falta 1». */
  headline: string;
  counts: SwaypCounts;
  /** Todas, sin tope ni paginación (R5). */
  faltan: SwaypFaltaRow[];
  armadas: SwaypArmadaRow[];
  salieron: SwaypSalioRow[];
  revisar: SwaypRevisarRow[];
  /** Solo «Próximo»: el tono según la hora de Lima respecto de la víspera. */
  tone: SwaypTone | null;
  /** Solo «Hoy»: «Kapta no registra la entrega a Swayp.». */
  note: string | null;
  /** «Swayp no lleva nada de Lima el miércoles 4 nov.». */
  empty: string;
  provincia: SwaypProvincia;
  cell: SwaypCell;
}

export interface WarehouseSwaypData {
  /** Hoy en Lima (YYYY-MM-DD). */
  today: string;
  nowIso: string;
  /** «17:42» (hora de Lima de la lectura): la pantalla dice «Leído 17:42». */
  leidoAt: string;
  /** null el domingo: Swayp no despacha. */
  hoy: SwaypZone | null;
  proximo: SwaypZone;
  /** Más de una tienda a la vista. */
  showStore: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Filas crudas (las lee lib/warehouse-swayp-access.ts)
// ---------------------------------------------------------------------------

export interface SwaypShipmentRow {
  id: string;
  store_id: string;
  courier: string | null;
  guide_code: string | null;
  swayp_guide?: string | null;
  swayp_state: number | null;
  delivery_status: string | null;
  status_category: string | null;
  order_id: string | null;
  order_name: string | null;
  customer_name: string | null;
  product: string | null;
  district: string | null;
  city: string | null;
  province: string | null;
  next_followup_at: string | null;
  created_at: string | null;
  output_code: string | null;
  output_number: number | null;
  preparation_state: string | null;
  custody_state: string | null;
  ready_at: string | null;
  ready_by: string | null;
  custody_transferred_at: string | null;
  dispatched_at: string | null;
  returned_at: string | null;
}

export interface SwaypOrderRow {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  macro_operation: string | null;
  general_status: string | null;
  product_titles: string[] | null;
  district: string | null;
  province?: string | null;
  region?: string | null;
  /** `orders.cancelled_at`: la cancelación en la tienda. */
  cancelled_at?: string | null;
}

export interface SwaypEmissionRow {
  id: string;
  source_key: string;
  order_id: string | null;
  store_id: string | null;
  automatic: boolean | null;
  state: string | null;
  guide_code: string | null;
  child_id: string | null;
  created_at: string;
}

export interface SwaypCallRow {
  shipment_id: string;
  agent: string | null;
  kind: string | null;
  note: string | null;
  occurred_at: string;
  next_followup_at: string | null;
}

export interface SwaypInput {
  /** Las salidas Swayp de los días de las zonas y TODAS las salidas de sus pedidos (hermanas). */
  shipments: readonly SwaypShipmentRow[];
  orders: readonly SwaypOrderRow[];
  /** Las emisiones de esos pedidos y las directas cuya fecha original es un día de las zonas. */
  emissions: readonly SwaypEmissionRow[];
  /** Las gestiones de esas guías Swayp. */
  calls: readonly SwaypCallRow[];
  /** Id de usuaria → nombre (`resolveAgentNames`): quien creó la guía y quien la armó. */
  names: Readonly<Record<string, string>>;
  /** Las tiendas a la vista, con su nombre. */
  storeNames: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

const WEEKDAY_LONG = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const WEEKDAY_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
// Los de es-PE (`month: "short"`), sin el punto: «set» y no «sep».
const MONTH_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"];
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Margen para decir que la salida ya existía antes de la guía (inserción y gestión van segundos después). */
const PRE_EXISTING_MARGIN_MS = 2 * MINUTE_MS;
/** La gestión que acompaña a la emisión se escribe segundos después de reservarla. */
const CALL_AFTER_EMISSION_MARGIN_MS = MINUTE_MS;

function dayParts(day: string): { weekday: number; month: number; date: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return null;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return { weekday: at.getUTCDay(), month: at.getUTCMonth(), date: at.getUTCDate() };
}

/**
 * «miércoles 4 nov»: el día de la semana largo, el día y el mes corto de es-PE
 * sobre la clave del día (como `swaypDispatchDayOptions`, sin coma ni punto).
 * Con tablas fijas: servidor y navegador escriben lo mismo.
 */
export function swaypDayLabel(day: string): string {
  const p = dayParts(day);
  return p ? `${WEEKDAY_LONG[p.weekday]} ${p.date} ${MONTH_SHORT[p.month]}` : day;
}

/** «mié 4 nov». */
export function swaypShortDayLabel(day: string): string {
  const p = dayParts(day);
  return p ? `${WEEKDAY_SHORT[p.weekday]} ${p.date} ${MONTH_SHORT[p.month]}` : day;
}

function prevDay(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/**
 * El día de despacho de una guía: la FECHA UTC de `next_followup_at`, que la
 * app guarda a medianoche UTC del día elegido ('2026-11-04 00:00:00+00' es del
 * 04-11). Nunca se convierte a hora de Lima: caería un día antes. Es lo mismo
 * que filtra el Excel de programación de Swayp (app/api/export/fenix-programacion).
 */
export function swaypDispatchDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null;
}

/** El instante de un minuto de Lima (UTC−5 todo el año, sin horario de verano). */
function limaInstant(day: string, minute: number): number {
  return Date.parse(`${day}T00:00:00-05:00`) + minute * MINUTE_MS;
}

function limaStamp(iso: string | null | undefined): { day: string; minute: number } | null {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? limaClock(new Date(t)) : null;
}

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** «martes 3 nov 00:11» en hora de Lima. */
function fullStamp(iso: string | null | undefined): string | null {
  const at = limaStamp(iso);
  return at ? `${swaypDayLabel(at.day)} ${hhmm(at.minute)}` : null;
}

/** «00:38» si es del día dado; si no, «lun 2 nov 00:38». */
function timeOn(iso: string | null | undefined, day: string): string | null {
  const at = limaStamp(iso);
  if (!at) return null;
  return at.day === day ? hhmm(at.minute) : `${swaypShortDayLabel(at.day)} ${hhmm(at.minute)}`;
}

/** Los días de las dos zonas: «Hoy» solo si hoy Swayp despacha; «Próximo», el primer día de despacho después de hoy. */
export function swaypZoneDays(today: string): { hoy: string | null; proximo: string } {
  return { hoy: isSwaypDispatchDay(today) ? today : null, proximo: firstSwaypDispatchDay(today) };
}

/** El título de la zona (R2, D5). */
export function swaypZoneTitle(kind: SwaypZoneKind, day: string, today: string): string {
  const label = swaypDayLabel(day);
  if (kind === "hoy") return SWAYP_HOY_TITLE(label);
  return day === nextDay(today) ? SWAYP_MANANA_TITLE(label) : SWAYP_PROXIMO_TITLE(label);
}

/** ¿Toca releer sola? Entre las 16:00 y las 21:30 de Lima (R10). */
export function swaypAutoRefreshActive(now: Date): boolean {
  const { minute } = limaClock(now);
  return minute >= SWAYP_AUTO_REFRESH_FROM_MINUTE && minute <= SWAYP_AUTO_REFRESH_UNTIL_MINUTE;
}

// ---------------------------------------------------------------------------
// Pequeñas piezas
// ---------------------------------------------------------------------------

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function missingWord(n: number): string {
  return n === 1 ? "falta 1" : `faltan ${n}`;
}

/** Un lugar escrito todo en minúsculas («san bartolo») se escribe como nombre; lo demás, tal cual. */
function placeName(value: string | null | undefined): string | null {
  const clean = (value ?? "").trim();
  if (!clean) return null;
  if (clean !== clean.toLocaleLowerCase("es")) return clean;
  return clean.replace(/(^|[\s/-])\p{L}/gu, (letter) => letter.toLocaleUpperCase("es"));
}

function shipmentCode(s: Pick<SwaypShipmentRow, "output_code" | "guide_code">): string {
  return s.output_code?.trim() || s.guide_code?.trim() || "Salida sin código";
}

/** «S01» de «KP143987-S01». */
function outputSuffix(code: string): string {
  return /-(S\d+)$/i.exec(code)?.[1]?.toUpperCase() ?? code;
}

export function swaypLabelsHref(shipmentIds: readonly string[]): string {
  return `/api/pedidos/rotulos?ids=${[...new Set(shipmentIds.filter(Boolean))].join(",")}`;
}

function cmpText(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function isClosedGuide(s: Pick<SwaypShipmentRow, "delivery_status" | "status_category">): boolean {
  return s.delivery_status === "anulado" || s.status_category === "closed";
}

/**
 * Por qué una guía Swayp ya no sale, o null si sigue viva (R3, R8); la primera
 * que aplica gana:
 * 1. el pedido se canceló en la tienda (`orders.cancelled_at`): es la causa,
 *    aunque Kapta anulara después la guía y Swayp la cancelara;
 * 2. Swayp la canceló (estado 10, «Cancelada»);
 * 3. Swayp la devolvió o la indemnizó (9, 11, 12): la sincronización la cierra,
 *    pero la caja salió con Swayp; sigue viva, como lo que ya avanzó;
 * 4. la guía está anulada en Kapta (`anulado` / `closed`);
 * 5. el pedido está anulado (`general_status`) con la guía todavía viva.
 */
export function swaypExitReason(
  s: Pick<SwaypShipmentRow, "swayp_state" | "delivery_status" | "status_category">,
  order: Pick<SwaypOrderRow, "general_status" | "cancelled_at"> | null | undefined,
): Exclude<SwaypExitReason, "fecha_cambiada"> | null {
  if (order?.cancelled_at) return "pedido_anulado";
  if (s.swayp_state != null && SWAYP_CANCELLED_STATES.has(s.swayp_state)) return "swayp_cancelo";
  if (s.swayp_state != null && SWAYP_CLOSED_AFTER_PICKUP_STATES.has(s.swayp_state)) return null;
  if (isClosedGuide(s)) return "guia_anulada";
  if (order?.general_status === "anulado") return "pedido_anulado";
  return null;
}

/**
 * Swayp ya tomó la guía en su sistema: la custodia ya no es de la empresa, o
 * Swayp pasó de «Preparada» (estado 3 o más), o ya se entregó o transfirió.
 * Desde ahí el escáner no acepta la caja (`markShipmentReady` exige custodia
 * `empresa`, D2), así que una falta así no se pide armar.
 */
export function swaypTaken(s: Pick<SwaypShipmentRow, "custody_state" | "swayp_state" | "status_category">): boolean {
  return s.custody_state !== "empresa"
    || (s.swayp_state != null && s.swayp_state > SWAYP_NOT_TAKEN_MAX_STATE)
    || s.status_category === "delivered"
    || s.status_category === "transferred";
}

const EXIT_TEXT: Record<Exclude<SwaypExitReason, "fecha_cambiada">, string> = {
  swayp_cancelo: SWAYP_SALIO_CANCELADA,
  guia_anulada: SWAYP_SALIO_ANULADA,
  pedido_anulado: SWAYP_SALIO_PEDIDO_ANULADO,
};

/** La fecha original de una guía directa: `direct:<pedido>:<ISO del día>`. Las demás emisiones no la dicen. */
export function swaypDirectSourceDay(sourceKey: string | null | undefined): string | null {
  const m = /^direct:[^:]+:(.+)$/.exec(sourceKey ?? "");
  return m ? swaypDispatchDay(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Quién y cuándo creó la guía
// ---------------------------------------------------------------------------

export interface SwaypGuideOrigin {
  /** La hora real: la reserva de la emisión o, sin emisión, la primera gestión de la guía. */
  at: string | null;
  agent: string | null;
  automatic: boolean;
}

/**
 * Quién creó la guía y cuándo. NUNCA `shipments.created_at`: una salida «por
 * definir» puede existir desde antes (KP201878-S01: creada 12:06Z, armada
 * 12:19Z, guía escrita 21:02Z).
 * - La hora: `swayp_guide_emissions.created_at` (la reserva va antes del POST a
 *   Swayp, lib/swayp-emission.ts); sin emisión (guía escrita a mano), la
 *   primera gestión de la guía.
 * - Quién: la gestión que acompaña a la creación («Guía Swayp directa creada:
 *   …», o la del reenvío): la primera que no es anterior a la emisión; sin
 *   emisión, la primera `reroute`, o la primera. El automático no tiene persona.
 */
export function swaypGuideOrigin(
  s: Pick<SwaypShipmentRow, "id" | "order_id" | "guide_code" | "swayp_guide">,
  emissions: readonly SwaypEmissionRow[],
  calls: readonly SwaypCallRow[],
): SwaypGuideOrigin {
  const guides = new Set([s.guide_code, s.swayp_guide].filter((g): g is string => Boolean(g)));
  let emission: SwaypEmissionRow | null = null;
  for (const e of emissions) {
    const mine = e.child_id === s.id || (e.order_id === s.order_id && e.guide_code != null && guides.has(e.guide_code));
    if (!mine) continue;
    if (!emission || Date.parse(e.created_at) < Date.parse(emission.created_at)) emission = e;
  }
  const own = calls
    .filter((c) => c.shipment_id === s.id && Number.isFinite(Date.parse(c.occurred_at)))
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const since = emission ? Date.parse(emission.created_at) - CALL_AFTER_EMISSION_MARGIN_MS : null;
  const creator = since != null
    ? own.find((c) => Date.parse(c.occurred_at) >= since) ?? null
    : own.find((c) => c.kind === "reroute") ?? own[0] ?? null;
  return {
    at: emission?.created_at ?? creator?.occurred_at ?? null,
    agent: creator?.agent ?? null,
    automatic: Boolean(emission?.automatic),
  };
}

/** Creada después de las 17:00 de la víspera de su día (R7). */
export function swaypAddedLate(guideAt: string | null | undefined, day: string): boolean {
  const at = Date.parse(guideAt ?? "");
  return Number.isFinite(at) && at > limaInstant(prevDay(day), SWAYP_ROUTE_CLOSE_MINUTE);
}

/** «20:43» si se creó la víspera; si no, «mié 4 nov 00:30». */
function lateTime(guideAt: string, day: string): string {
  return timeOn(guideAt, prevDay(day)) ?? "";
}

// ---------------------------------------------------------------------------
// Dónde está la caja física (R11)
// ---------------------------------------------------------------------------

type WhereShipment = Pick<
  SwaypShipmentRow,
  | "id" | "courier" | "output_code" | "guide_code" | "output_number" | "preparation_state" | "custody_state" | "returned_at" | "created_at"
  | "ready_at" | "delivery_status" | "status_category"
>;

/** Las preparaciones que dicen que esta misma salida ya estaba en marcha antes de la guía. */
const STARTED_PREPARATION: ReadonlySet<string> = new Set(["rotulo_generado", "en_armado"]);

/** La salida existía antes de la guía: una «por definir» que la guía rellenó. */
export function swaypPreExisting(s: Pick<SwaypShipmentRow, "created_at">, guideAt: string | null | undefined): boolean {
  const born = Date.parse(s.created_at ?? "");
  const guide = Date.parse(guideAt ?? "");
  return Number.isFinite(born) && Number.isFinite(guide) && born < guide - PRE_EXISTING_MARGIN_MS;
}

function highest<T extends Pick<SwaypShipmentRow, "output_number">>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of rows) if (!best || (row.output_number ?? 0) > (best.output_number ?? 0)) best = row;
  return best;
}

/** Se armó alguna vez: escaneada (`listo_despacho`) o con hora de armado. */
function everArmed(s: Pick<SwaypShipmentRow, "preparation_state" | "ready_at">): boolean {
  return s.preparation_state === "listo_despacho" || Boolean(s.ready_at);
}

/**
 * La caja volvió a la oficina: la recibieron (`devuelto`) o tiene `returned_at`.
 * `retorno` NO: la caja sigue con el courier camino de vuelta, y el `devuelto`
 * lo pone quien la recibe (lib/swayp.ts `swaypCustodyFor`, MOM §9.4).
 */
function backHome(s: Pick<SwaypShipmentRow, "custody_state" | "returned_at">): boolean {
  return s.custody_state === "devuelto" || Boolean(s.returned_at);
}

function siblingWhere(kind: SwaypWhereKind, s: WhereShipment, text: (sibling: string, courier: string) => string): SwaypWhereabouts {
  const sibling = shipmentCode(s);
  const courier = courierDisplayName(s.courier);
  return { kind, text: text(sibling, courier), sibling: { shipmentId: s.id, code: sibling, courier } };
}

/**
 * Dónde está la caja de una FALTA; la primera regla que aplica gana, mirando
 * las salidas hermanas del mismo pedido (de cualquier courier):
 * a) esta misma salida existía antes de la guía (una «por definir» rellenada,
 *    o ya con rótulo o en armado): es esa caja, y el rótulo no cambia;
 * b) una hermana armada que sigue en la empresa (la S01 de Grupo GF, D4): la
 *    caja lleva ahora el rótulo de Swayp y Despacho retira la hermana;
 * c) una hermana que se armó y volvió a la oficina (custodia `devuelto` o
 *    `returned_at`): si la caja está entera, se usa con el rótulo nuevo;
 * c') una hermana que se armó, salió con su courier (custodia `courier` o
 *    `retorno`) y no se entregó: el caso más común, la S02 de Swayp que nace
 *    del re-ruteo de una S01 de Grupo GF que no se entregó. La caja existe:
 *    Despacho la trae de vuelta (revisión del 03-11-2026, 14 de 31 faltas de
 *    45 días caían en d; pendiente de que el owner confirme el texto);
 * d) si no, se arma desde stock.
 * Una hermana que nunca se armó no dice dónde está ninguna caja. Con varias
 * hermanas que cumplen, la de consecutivo más alto.
 */
export function swaypBoxWhereabouts(input: {
  self: WhereShipment;
  /** Si la salida existía antes de la guía (`swaypPreExisting`). */
  preExisting: boolean;
  siblings: readonly WhereShipment[];
}): SwaypWhereabouts {
  const code = shipmentCode(input.self);
  if (input.preExisting || STARTED_PREPARATION.has(input.self.preparation_state ?? "")) {
    return { kind: "por_definir", text: SWAYP_WHERE_POR_DEFINIR(code), sibling: null };
  }
  const others = input.siblings.filter((s) => s.id !== input.self.id);
  const armed = highest(others.filter((s) => s.preparation_state === "listo_despacho" && s.custody_state === "empresa"));
  if (armed) {
    return siblingWhere("hermana_armada", armed, (sibling, courier) => SWAYP_WHERE_HERMANA_ARMADA(sibling, courier, code, outputSuffix(sibling)));
  }
  const back = highest(others.filter((s) => everArmed(s) && backHome(s)));
  if (back) return siblingWhere("hermana_volvio", back, (sibling, courier) => SWAYP_WHERE_HERMANA_VOLVIO(sibling, courier, code));
  const out = highest(others.filter((s) =>
    everArmed(s)
    && (s.custody_state === "courier" || s.custody_state === "retorno")
    && !backHome(s)
    && s.delivery_status !== "entregado"
    && s.status_category !== "delivered"));
  if (out) return siblingWhere("hermana_fuera", out, (sibling, courier) => SWAYP_WHERE_HERMANA_FUERA(sibling, courier, code));
  return { kind: "desde_stock", text: SWAYP_WHERE_STOCK(code), sibling: null };
}

// ---------------------------------------------------------------------------
// Tono, cabecera y celda
// ---------------------------------------------------------------------------

/**
 * El tono de la zona «Próximo» según la hora de Lima respecto de la víspera
 * (R6); siempre con su frase. La primera regla que aplica gana:
 * 1. nada programado: neutro, «Swayp no lleva nada…»;
 * 2. sin faltas: ok, «Lote completo.»;
 * 3. todas las faltas ya las tomó Swayp (`tomadas`): ámbar, avisa a
 *    Seguimiento; «déjalo listo» sería falso, el escáner ya no las acepta;
 * 4. la víspera aún no llega (el sábado para el lunes): neutro, quién lo arma;
 * 5. la víspera antes de las 17:00: neutro, cuándo cierra Swayp y el corte;
 * 6. la víspera de 17:00 a 21:20: ámbar, cuánto falta para el corte;
 * 7. pasadas las 21:20 de la víspera: crítico, el turno noche cerró con faltas.
 */
export function swaypZoneTone(zone: { day: string; programadas: number; faltan: number; tomadas?: number }, now: Date): SwaypTone {
  if (zone.programadas <= 0) return { kind: "neutral", text: SWAYP_EMPTY(swaypDayLabel(zone.day)) };
  if (zone.faltan <= 0) return { kind: "ok", text: SWAYP_TONE_COMPLETO };
  const tomadas = zone.tomadas ?? 0;
  if (tomadas >= zone.faltan) return { kind: "warn", text: SWAYP_TONE_TOMADAS(tomadas) };
  const vispera = prevDay(zone.day);
  const clock = limaClock(now);
  if (clock.day < vispera) return { kind: "neutral", text: SWAYP_TONE_ANTES_VISPERA(swaypDayLabel(vispera)) };
  if (clock.day === vispera && clock.minute < SWAYP_ROUTE_CLOSE_MINUTE) return { kind: "neutral", text: SWAYP_TONE_VISPERA };
  if (clock.day === vispera && clock.minute < SWAYP_NIGHT_CUTOFF_MINUTE) {
    return { kind: "warn", text: SWAYP_TONE_CORTE(formatMinutes(SWAYP_NIGHT_CUTOFF_MINUTE - clock.minute)) };
  }
  return { kind: "crit", text: SWAYP_TONE_CERRO(zone.faltan) };
}

/** «Swayp miércoles 4 nov: 9 programadas · 8 armadas · falta 1» (o «· lote completo»); «Swayp hoy: 7 programadas · 7 armadas». */
export function swaypZoneHeadline(kind: SwaypZoneKind, day: string, counts: Pick<SwaypCounts, "programadas" | "armadas" | "faltan">): string {
  const label = swaypDayLabel(day);
  if (counts.programadas <= 0) return SWAYP_EMPTY(label);
  const head = `Swayp ${kind === "hoy" ? "hoy" : label}: ${count(counts.programadas, "programada", "programadas")} · ${count(counts.armadas, "armada", "armadas")}`;
  if (counts.faltan > 0) return `${head} · ${missingWord(counts.faltan)}`;
  return kind === "hoy" ? head : `${head} · lote completo`;
}

/** La celda «Swayp · Lima» de una zona. */
export function swaypCell(zone: Pick<SwaypZone, "dayLabel" | "counts" | "tone">): SwaypCell {
  const c = zone.counts;
  const big = c.programadas <= 0 ? "0" : c.faltan <= 0 ? SWAYP_CELL_COMPLETE : c.faltan === 1 ? "Falta 1" : `Faltan ${c.faltan}`;
  return {
    title: SWAYP_CELL_TITLE,
    big,
    sub: `${zone.dayLabel} · ${count(c.programadas, "programada", "programadas")} · ${count(c.armadas, "armada", "armadas")}`,
    tone: zone.tone,
  };
}

// ---------------------------------------------------------------------------
// La proyección
// ---------------------------------------------------------------------------

interface Ctx {
  today: string;
  now: Date;
  fenix: SwaypShipmentRow[];
  byId: Map<string, SwaypShipmentRow>;
  byOrder: Map<string, SwaypShipmentRow[]>;
  orderById: Map<string, SwaypOrderRow>;
  emissions: readonly SwaypEmissionRow[];
  callsByShipment: Map<string, SwaypCallRow[]>;
  names: Readonly<Record<string, string>>;
  storeNames: Readonly<Record<string, string>>;
}

function guideBase(s: SwaypShipmentRow, kind: SwaypZoneKind, day: string, ctx: Ctx): SwaypGuideRow & { origin: SwaypGuideOrigin } {
  const order = s.order_id ? ctx.orderById.get(s.order_id) : undefined;
  const code = shipmentCode(s);
  const guideCode = s.guide_code ?? s.swayp_guide ?? null;
  const orderName = order?.order_name ?? s.order_name ?? "Pedido sin número";
  const customerName = s.customer_name?.trim() || order?.customer_name?.trim() || "Cliente sin nombre";
  const district = placeName(s.district) ?? placeName(order?.district);
  const product = s.product?.trim() || order?.product_titles?.filter(Boolean).join(", ") || null;
  const storeName = ctx.storeNames[s.store_id] ?? "Tienda";
  const origin = swaypGuideOrigin(s, ctx.emissions, ctx.callsByShipment.get(s.id) ?? []);
  const creatorName = origin.agent
    ? ctx.names[origin.agent] ?? SWAYP_CREATOR_UNKNOWN
    : origin.automatic ? SWAYP_CREATOR_AUTOMATIC : SWAYP_CREATOR_UNKNOWN;
  const late = swaypAddedLate(origin.at, day);
  const chips: SwaypChip[] = late && origin.at ? [{ tone: "warn", text: SWAYP_CHIP_LATE(lateTime(origin.at, day)) }] : [];
  let swaypLine: string | null = null;
  if (kind === "hoy") {
    const label = s.swayp_state != null ? SWAYP_STATES[s.swayp_state] ?? `estado ${s.swayp_state}` : SWAYP_STATE_UNKNOWN;
    swaypLine = SWAYP_HOY_STATE_LINE(label, timeOn(s.custody_transferred_at ?? s.dispatched_at, ctx.today));
  }
  return {
    shipmentId: s.id,
    orderId: s.order_id,
    storeId: s.store_id,
    storeName,
    code,
    guideCode,
    orderName,
    customerName,
    district,
    product,
    title: SWAYP_GUIDE_LINE(code, guideCode),
    customerLine: [customerName, district].filter(Boolean).join(" · "),
    orderLine: [orderName, storeName, product].filter(Boolean).join(" · "),
    guideCreatedAt: origin.at,
    createdBy: origin.agent ? ctx.names[origin.agent] ?? null : origin.automatic ? SWAYP_CREATOR_AUTOMATIC : null,
    createdLine: SWAYP_CREATED_LINE(creatorName, fullStamp(origin.at)),
    late,
    chips,
    swaypLine,
    labelHref: swaypLabelsHref([s.id]),
    origin,
  };
}

/** «KP1-S01 · armada lunes 2 nov 17:19 · <quién armó> · Cliente Ejemplo · Surco». */
function armadaLine(row: Pick<SwaypGuideRow, "code" | "customerName" | "district">, readyAt: string | null, readyBy: string | null): string {
  const when = fullStamp(readyAt);
  return [row.code, when ? `armada ${when}` : "armada", readyBy, row.customerName, row.district].filter(Boolean).join(" · ");
}

/** Qué hacer con una falta: la de hoy que sigue aquí, crítico; la que Swayp ya tomó (hoy o antes de su día), avisar. */
function faltaActionLine(kind: SwaypZoneKind, taken: boolean): SwaypTone | null {
  if (taken) return { kind: "warn", text: SWAYP_HOY_FALTA_TOMADA };
  return kind === "hoy" ? { kind: "crit", text: SWAYP_HOY_FALTA_AQUI } : null;
}

function stripOrigin<T extends { origin: unknown }>(row: T): Omit<T, "origin"> {
  const { origin: _origin, ...rest } = row;
  return rest;
}

function salioRow(
  s: SwaypShipmentRow,
  ctx: Ctx,
  reason: SwaypExitReason,
  text: string,
  newDay: string | null,
  /** La guía que salió, si la salida ya no la lleva (una «por definir» restaurada). */
  guideCode?: string | null,
): SwaypSalioRow {
  const order = s.order_id ? ctx.orderById.get(s.order_id) : undefined;
  const wasArmed = s.preparation_state === "listo_despacho";
  // «Sácala del sitio de Swayp» solo si la caja sigue en la empresa: si ya salió
  // con Swayp o viene de regreso, no hay nada que sacar (revisión 03-11-2026).
  const stillHere = (s.custody_state ?? "empresa") === "empresa";
  return {
    shipmentId: s.id,
    orderId: s.order_id,
    storeName: ctx.storeNames[s.store_id] ?? "Tienda",
    code: shipmentCode(s),
    guideCode: guideCode ?? s.guide_code ?? s.swayp_guide ?? null,
    orderName: order?.order_name ?? s.order_name ?? "Pedido sin número",
    customerName: s.customer_name?.trim() || order?.customer_name?.trim() || "Cliente sin nombre",
    district: placeName(s.district) ?? placeName(order?.district),
    reason,
    text,
    newDay,
    wasArmed,
    armedText: wasArmed && stillHere ? SWAYP_SALIO_ARMADA : null,
  };
}

/** Cuándo se movió la fecha: la última gestión de la guía que la dejó en su día nuevo. */
function dateChangedAt(s: SwaypShipmentRow, newDay: string, ctx: Ctx): string | null {
  let latest: SwaypCallRow | null = null;
  for (const call of ctx.callsByShipment.get(s.id) ?? []) {
    if (swaypDispatchDay(call.next_followup_at) !== newDay) continue;
    if (!latest || Date.parse(call.occurred_at) > Date.parse(latest.occurred_at)) latest = call;
  }
  return latest ? fullStamp(latest.occurred_at) : null;
}

function provinceCity(s: SwaypShipmentRow, order: SwaypOrderRow | undefined): string {
  return placeName(s.city) ?? placeName(s.province) ?? placeName(order?.province) ?? placeName(order?.region) ?? SWAYP_CITY_UNKNOWN;
}

function buildZone(kind: SwaypZoneKind, day: string, ctx: Ctx): SwaypZone {
  const faltan: SwaypFaltaRow[] = [];
  const armadas: SwaypArmadaRow[] = [];
  const salieron: SwaypSalioRow[] = [];
  const revisar: SwaypRevisarRow[] = [];
  const provinciaIds: string[] = [];
  const byCity = new Map<string, number>();
  const listed = new Set<string>();

  for (const s of ctx.fenix) {
    if (swaypDispatchDay(s.next_followup_at) !== day) continue;
    listed.add(s.id);
    const order = s.order_id ? ctx.orderById.get(s.order_id) : undefined;
    const operation = order?.macro_operation ?? null;
    const exit = swaypExitReason(s, order);

    // Provincia la arma la bodega regional de Swayp (D1): solo el pie, y solo lo vivo.
    if (operation === "provincia_cod") {
      if (!exit) {
        provinciaIds.push(s.id);
        const city = provinceCity(s, order);
        byCity.set(city, (byCity.get(city) ?? 0) + 1);
      }
      continue;
    }
    // Ni Lima ni provincia: se lista para revisar y no cuenta (R1).
    if (operation !== "lima") {
      if (!exit) {
        const label = operation && operation in OPERATION_LABELS ? OPERATION_LABELS[operation as keyof typeof OPERATION_LABELS] : OPERATION_LABELS.desconocida;
        revisar.push({
          shipmentId: s.id,
          orderId: s.order_id,
          storeName: ctx.storeNames[s.store_id] ?? "Tienda",
          code: shipmentCode(s),
          guideCode: s.guide_code ?? s.swayp_guide ?? null,
          orderName: order?.order_name ?? s.order_name ?? "Pedido sin número",
          customerName: s.customer_name?.trim() || order?.customer_name?.trim() || "Cliente sin nombre",
          district: placeName(s.district) ?? placeName(order?.district),
          operation,
          text: SWAYP_REVISAR_LINE(label),
        });
      }
      continue;
    }

    if (exit) {
      salieron.push(salioRow(s, ctx, exit, EXIT_TEXT[exit], null));
      continue;
    }

    const base = guideBase(s, kind, day, ctx);
    // Armada = la PROPIA salida escaneada (R4). Una caja armada con otra salida no cuenta (D4).
    if (s.preparation_state === "listo_despacho") {
      const armedBeforeGuide = Date.parse(s.ready_at ?? "") < Date.parse(base.origin.at ?? "");
      const readyBy = s.ready_by ? ctx.names[s.ready_by] ?? null : null;
      const chips = armedBeforeGuide ? [{ tone: "neutral" as const, text: SWAYP_CHIP_ARMADA_POR_DEFINIR }, ...base.chips] : base.chips;
      armadas.push({
        ...stripOrigin(base),
        chips,
        readyAt: s.ready_at,
        readyBy,
        armedBeforeGuide,
        line: armadaLine(base, s.ready_at, readyBy),
      });
      continue;
    }

    const preExisting = swaypPreExisting(s, base.origin.at);
    // Swayp ya la tomó: no se pide armarla ni se dice dónde está la caja (R11);
    // la fila dice qué hacer (avisar a Seguimiento). Sigue siendo falta: no se
    // armó aquí (revisión del 03-11-2026, KP143987-S02 y KP200486-S02).
    const taken = swaypTaken(s);
    const where = swaypBoxWhereabouts({
      self: s,
      preExisting,
      siblings: s.order_id ? ctx.byOrder.get(s.order_id) ?? [] : [],
    });
    const newSalida = !preExisting && where.kind !== "por_definir";
    faltan.push({
      ...stripOrigin(base),
      chips: [
        { tone: "warn", text: SWAYP_CHIP_SIN_ARMAR },
        newSalida ? { tone: "info", text: SWAYP_CHIP_SALIDA_NUEVA } : { tone: "neutral", text: SWAYP_CHIP_ERA_POR_DEFINIR },
        ...base.chips,
      ],
      newSalida,
      taken,
      where: taken ? null : where,
      actionLine: faltaActionLine(kind, taken),
    });
  }

  // Las directas cuya fecha original (source_key) es este día y que no están en
  // la lista (R8). Las demás emisiones no guardan su día.
  // - «Guía anulada en Kapta»: `cancelFenixDirectGuide` deja `next_followup_at`
  //   en null (y una «por definir» rellenada vuelve a `por_definir` sin la
  //   guía), así que la lectura por fecha ya no la trae y desaparecía en
  //   silencio (KP139661-S01, 08-10-2026).
  // - «Fecha cambiada»: la guía sigue viva y sale ahora otro día.
  for (const e of ctx.emissions) {
    if (swaypDirectSourceDay(e.source_key) !== day || e.state !== "created" || !e.guide_code) continue;
    const s = (e.child_id ? ctx.byId.get(e.child_id) : undefined) ??
      ctx.fenix.find((f) => f.order_id === e.order_id && (f.guide_code === e.guide_code || f.swayp_guide === e.guide_code));
    if (!s || listed.has(s.id)) continue;
    const order = s.order_id ? ctx.orderById.get(s.order_id) : undefined;
    if (order?.macro_operation !== "lima") continue;
    // La salida ya no lleva esta guía: se restauró a «por definir» o lleva otra.
    const gone = s.courier !== "fenix" || (s.guide_code !== e.guide_code && s.swayp_guide !== e.guide_code);
    const exit = gone ? null : swaypExitReason(s, order);
    const liveDay = gone ? null : swaypDispatchDay(s.next_followup_at);
    if (gone || (!liveDay && exit)) {
      const reason = order.cancelled_at ? "pedido_anulado" : exit ?? "guia_anulada";
      listed.add(s.id);
      salieron.push(salioRow(s, ctx, reason, EXIT_TEXT[reason], null, e.guide_code));
      continue;
    }
    // Sin fecha y viva (una recuperación descartada suelta la fecha sin tocar la
    // guía) no se sabe adónde fue; si salió de otro día, es asunto de ese día.
    if (!liveDay || liveDay === day || exit) continue;
    listed.add(s.id);
    salieron.push(salioRow(s, ctx, "fecha_cambiada", SWAYP_SALIO_FECHA(swaypDayLabel(liveDay), dateChangedAt(s, liveDay, ctx)), liveDay));
  }

  faltan.sort((a, b) => cmpText(a.code, b.code));
  armadas.sort((a, b) => cmpText(a.readyAt, b.readyAt) || cmpText(a.code, b.code));
  salieron.sort((a, b) => cmpText(a.code, b.code));
  revisar.sort((a, b) => cmpText(a.code, b.code));

  const porCiudad = [...byCity.entries()]
    .map(([city, n]) => ({ city, count: n }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city, "es"));
  const dayLabel = swaypDayLabel(day);
  const provinciaTotal = provinciaIds.length;

  return finishZone({
    kind,
    day,
    dayLabel,
    shortLabel: swaypShortDayLabel(day),
    title: swaypZoneTitle(kind, day, ctx.today),
    vispera: prevDay(day),
    faltan,
    armadas,
    salieron,
    revisar,
    note: kind === "hoy" ? SWAYP_HOY_NOTE : null,
    empty: SWAYP_EMPTY(dayLabel),
    provincia: {
      total: provinciaTotal,
      porCiudad,
      text: provinciaTotal ? SWAYP_PROVINCIA(provinciaTotal, dayLabel, porCiudad.map((c) => `${c.city} ${c.count}`).join(", ")) : null,
      shipmentIds: provinciaIds,
    },
  }, ctx.now);
}

/** Lo que el tono necesita de una zona: sus cifras y cuántas faltas ya tomó Swayp. */
export function swaypToneCounts(
  zone: Pick<SwaypZone, "faltan">,
  counts: Pick<SwaypCounts, "programadas" | "faltan">,
): { programadas: number; faltan: number; tomadas: number } {
  return { programadas: counts.programadas, faltan: counts.faltan, tomadas: zone.faltan.filter((row) => row.taken).length };
}

/**
 * Las faltas de «Hoy» que siguen en la empresa y Swayp aún no tomó: lo urgente
 * del día, que sube a la celda y al enlace de la cabecera (`SWAYP_HOY_URGENT`).
 */
export function swaypHoyUrgent(zone: Pick<SwaypZone, "kind" | "faltan"> | null | undefined): number {
  if (!zone || zone.kind !== "hoy") return 0;
  return zone.faltan.filter((row) => row.actionLine?.kind === "crit").length;
}

/** Cifras, cabecera, tono y celda a partir de las filas: lo usan la proyección y la copia local tras un escaneo. */
function finishZone(zone: Omit<SwaypZone, "headline" | "counts" | "tone" | "cell">, now: Date): SwaypZone {
  const counts: SwaypCounts = {
    programadas: zone.faltan.length + zone.armadas.length,
    armadas: zone.armadas.length,
    faltan: zone.faltan.length,
    agregadasTarde: zone.faltan.filter((r) => r.late).length + zone.armadas.filter((r) => r.late).length,
  };
  const tone = zone.kind === "proximo" ? swaypZoneTone({ ...swaypToneCounts(zone, counts), day: zone.day }, now) : null;
  const headline = swaypZoneHeadline(zone.kind, zone.day, counts);
  return { ...zone, headline, counts, tone, cell: swaypCell({ dayLabel: zone.dayLabel, counts, tone }) };
}

/**
 * La lista desde las filas crudas. `now` decide hoy, las zonas, el tono y la
 * hora de lectura. Las cadenas salen hechas: la pantalla no calcula fechas.
 */
export function buildWarehouseSwayp(input: SwaypInput, now: Date): WarehouseSwaypData {
  const clock = limaClock(now);
  const today = clock.day;
  const byId = new Map<string, SwaypShipmentRow>();
  for (const s of input.shipments) byId.set(s.id, s);
  const all = [...byId.values()];
  const byOrder = new Map<string, SwaypShipmentRow[]>();
  for (const s of all) {
    if (!s.order_id) continue;
    byOrder.set(s.order_id, [...(byOrder.get(s.order_id) ?? []), s]);
  }
  const callsByShipment = new Map<string, SwaypCallRow[]>();
  for (const call of input.calls) callsByShipment.set(call.shipment_id, [...(callsByShipment.get(call.shipment_id) ?? []), call]);
  const ctx: Ctx = {
    today,
    now,
    fenix: all.filter((s) => s.courier === "fenix"),
    byId,
    byOrder,
    orderById: new Map(input.orders.map((o) => [o.order_id, o])),
    emissions: input.emissions,
    callsByShipment,
    names: input.names,
    storeNames: input.storeNames,
  };
  const days = swaypZoneDays(today);
  return {
    today,
    nowIso: now.toISOString(),
    leidoAt: hhmm(clock.minute),
    hoy: days.hoy ? buildZone("hoy", days.hoy, ctx) : null,
    proximo: buildZone("proximo", days.proximo, ctx),
    showStore: Object.keys(input.storeNames).length > 1,
  };
}

/** La respuesta sin filas (sin guías, o con `error`): las zonas siguen teniendo su día y su título. */
export function emptyWarehouseSwayp(input: { nowIso: string; error?: string }): WarehouseSwaypData {
  const now = new Date(Number.isFinite(Date.parse(input.nowIso)) ? input.nowIso : Date.now());
  const data = buildWarehouseSwayp({ shipments: [], orders: [], emissions: [], calls: [], names: {}, storeNames: {} }, now);
  return input.error ? { ...data, error: input.error } : data;
}

// ---------------------------------------------------------------------------
// Después de un escaneo (en el cliente, sin releer)
// ---------------------------------------------------------------------------

/**
 * La copia local tras un escaneo: la FALTA pasa a armada con la hora del
 * escaneo (y quién, si se sabe), y las cifras, la cabecera, el tono y la celda
 * se recalculan con `nowIso`. Si la salida no es una falta de un lote cargado,
 * devuelve el mismo objeto.
 */
export function applySwaypScan(data: WarehouseSwaypData, shipmentId: string, nowIso: string, actorName?: string | null): WarehouseSwaypData {
  if (data.error) return data;
  const now = new Date(Number.isFinite(Date.parse(nowIso)) ? nowIso : data.nowIso);
  const move = (zone: SwaypZone | null): SwaypZone | null => {
    if (!zone) return zone;
    const falta = zone.faltan.find((row) => row.shipmentId === shipmentId);
    if (!falta) return zone;
    const { newSalida: _n, taken: _k, where: _w, actionLine: _t, chips, ...base } = falta;
    const readyBy = actorName?.trim() || null;
    const armada: SwaypArmadaRow = {
      ...base,
      // Solo queda la de «Agregada …»: «Sin armar» y el origen de la salida ya no aplican.
      chips: chips.filter((chip) => chip.text !== SWAYP_CHIP_SIN_ARMAR && chip.text !== SWAYP_CHIP_SALIDA_NUEVA && chip.text !== SWAYP_CHIP_ERA_POR_DEFINIR),
      readyAt: now.toISOString(),
      readyBy,
      armedBeforeGuide: false,
      line: armadaLine(base, now.toISOString(), readyBy),
    };
    const { headline: _h, counts: _c, tone: _o, cell: _e, ...rest } = zone;
    return finishZone({
      ...rest,
      faltan: zone.faltan.filter((row) => row.shipmentId !== shipmentId),
      armadas: [...zone.armadas, armada],
    }, now);
  };
  const hoy = move(data.hoy);
  const proximo = move(data.proximo)!;
  return hoy === data.hoy && proximo === data.proximo ? data : { ...data, hoy, proximo };
}

// ---------------------------------------------------------------------------
// El escáner y «Armados hoy»
// ---------------------------------------------------------------------------

export interface SwaypScanHint {
  /** Qué regla habló: la estación relee antes de decir «fuera» (`swaypHintAfterScan`). */
  kind: "lote" | "completo" | "rotulo_viejo" | "salio" | "fuera";
  tone: "info" | "ok" | "warn" | "crit";
  text: string;
}

type ScannedShipment = Pick<DispatchShipment, "id" | "order_id" | "courier" | "output_code" | "guide_code">;

function loadedZones(data: WarehouseSwaypData): SwaypZone[] {
  return [data.hoy, data.proximo].filter((zone): zone is SwaypZone => Boolean(zone));
}

/** «falta KP143987-S02 (San Bartolo)» o «faltan 4: KP1-S01 (Ate), …, y 1 más». */
function missingList(rows: readonly Pick<SwaypFaltaRow, "code" | "district">[]): string {
  const named = (row: Pick<SwaypFaltaRow, "code" | "district">) => (row.district ? `${row.code} (${row.district})` : row.code);
  if (rows.length === 1) return `falta ${named(rows[0]!)}`;
  const shown = rows.slice(0, SWAYP_SCAN_LIST_MAX).map(named).join(", ");
  const more = rows.length - SWAYP_SCAN_LIST_MAX;
  return `faltan ${rows.length}: ${shown}${more > 0 ? ` y ${more} más` : ""}`;
}

/**
 * El segundo aviso del escáner, después de `markShipmentReady` (que devuelve la
 * salida en `shipment`). Solo mira el lote ya cargado: no pide nada al
 * servidor. La primera regla que aplica gana:
 * 1. la salida es de un lote (Hoy o Próximo): cuántas van y cuáles faltan, o
 *    «Lote completo: júntalas en el sitio de Swayp»;
 * 2. es una hermana de una FALTA (el rótulo viejo de la S01): imprime el de Swayp;
 * 3. salió de la lista: cancelada, anulada o con otra fecha;
 * 4. es de provincia o de «Revisar»: nada que decir;
 * 5. es Swayp y no es de ningún lote cargado: guárdala aparte (la estación
 *    relee antes de decirlo, `swaypHintAfterScan`).
 * Vale antes o después de `applySwaypScan`: la salida escaneada cuenta como armada.
 */
export function swaypScanHint(data: WarehouseSwaypData | null | undefined, shipment: ScannedShipment | null | undefined): SwaypScanHint | null {
  if (!data || data.error || !shipment) return null;
  const zones = loadedZones(data);

  for (const zone of zones) {
    const inLot = zone.faltan.some((row) => row.shipmentId === shipment.id) || zone.armadas.some((row) => row.shipmentId === shipment.id);
    if (!inLot) continue;
    const total = zone.faltan.length + zone.armadas.length;
    const missing = zone.faltan.filter((row) => row.shipmentId !== shipment.id);
    if (!missing.length) return { kind: "completo", tone: "ok", text: SWAYP_SCAN_COMPLETO(zone.dayLabel, total) };
    return { kind: "lote", tone: "info", text: SWAYP_SCAN_FALTAN(zone.dayLabel, total - missing.length, total, missingList(missing)) };
  }

  if (shipment.order_id) {
    for (const zone of zones) {
      const falta = zone.faltan.find((row) => row.orderId === shipment.order_id && row.shipmentId !== shipment.id);
      if (falta) {
        const own = shipment.output_code?.trim() || shipment.guide_code?.trim() || "la salida escaneada";
        return { kind: "rotulo_viejo", tone: "warn", text: SWAYP_SCAN_ROTULO_VIEJO(own, courierDisplayName(shipment.courier), falta.code) };
      }
    }
  }

  for (const zone of zones) {
    const salio = zone.salieron.find((row) => row.shipmentId === shipment.id);
    if (!salio) continue;
    if (salio.reason === "swayp_cancelo") return { kind: "salio", tone: "crit", text: SWAYP_SCAN_CANCELADA };
    if (salio.reason === "fecha_cambiada" && salio.newDay) return { kind: "salio", tone: "warn", text: SWAYP_SCAN_FECHA(swaypDayLabel(salio.newDay)) };
    return { kind: "salio", tone: "crit", text: SWAYP_SCAN_ANULADA };
  }

  if (zones.some((zone) => zone.provincia.shipmentIds.includes(shipment.id) || zone.revisar.some((row) => row.shipmentId === shipment.id))) {
    return null;
  }
  if (shipment.courier === "fenix") {
    return { kind: "fuera", tone: "warn", text: SWAYP_SCAN_FUERA(data.proximo.dayLabel, Boolean(data.hoy)) };
  }
  return null;
}

/** Lo cargado es del día de hoy en Lima: si no, sus zonas ya no son «Hoy» ni «Próximo». */
export function swaypLotIsCurrent(data: Pick<WarehouseSwaypData, "today">, now: Date): boolean {
  return limaClock(now).day === data.today;
}

/**
 * El segundo aviso del escáner en la estación. Casi siempre es `swaypScanHint`
 * con el lote cargado, sin pedir nada (R10). Dos casos releen una vez antes de
 * hablar, por GET fuera de la fila de acciones (`reread`), porque con lo cargado
 * la orden podría ser falsa (revisión del 03-11-2026):
 * - una caja Swayp que no está en ningún lote cargado: puede ser una guía
 *   agregada después de la última lectura (el 02-11 se crearon 11 entre las
 *   20:18 y las 20:29), y «guárdala aparte» haría apartar una caja que sí sale;
 * - un lote de otro día (la estación pasó la noche abierta): sus zonas ya no
 *   son «Hoy» ni «Próximo».
 * Si la relectura falla, no hay aviso: mejor ninguno que uno equivocado.
 */
export async function swaypHintAfterScan(
  data: WarehouseSwaypData | null | undefined,
  shipment: ScannedShipment | null | undefined,
  opts: { now: Date; reread: () => Promise<WarehouseSwaypData | null> },
): Promise<SwaypScanHint | null> {
  if (!data || data.error || !shipment) return null;
  const current = swaypLotIsCurrent(data, opts.now);
  const hint = current ? swaypScanHint(data, shipment) : null;
  if (shipment.courier !== "fenix" || (current && hint?.kind !== "fuera")) return hint;
  const fresh = await opts.reread();
  if (!fresh || fresh.error || !swaypLotIsCurrent(fresh, opts.now)) return null;
  return swaypScanHint(fresh, shipment);
}

/** La chapa de «Armados hoy» de una salida de un lote cargado («Swayp · mié 4 nov»), o null. */
export function swaypArmedChip(data: WarehouseSwaypData | null | undefined, shipmentId: string): string | null {
  if (!data || data.error) return null;
  for (const zone of loadedZones(data)) {
    if (zone.armadas.some((row) => row.shipmentId === shipmentId) || zone.faltan.some((row) => row.shipmentId === shipmentId)) {
      return SWAYP_ARMED_CHIP(zone.shortLabel);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// La asesora (puerta «Guía Swayp directa»)
// ---------------------------------------------------------------------------

export interface SwaypLotNotice {
  /** Bajo el selector de fecha, antes de crear: el aviso fuerte (D3), o null. */
  before: SwaypTone | null;
  /** Al confirmar la creación: a qué lote entró y, si es tarde, qué verá el almacén. */
  after: string;
  /** Después de las 17:00 de la víspera (la verán como agregada tarde). */
  late: boolean;
  /** Después de las 21:20 de la víspera (ya no hay turno de almacén). */
  afterCutoff: boolean;
}

/**
 * Lo que se le dice a la asesora de una guía Swayp de Lima o Callao para el día
 * `day`, con la hora `now`. Solo con destino de Lima con certeza (`lima`):
 * provincia no cambia y devuelve null. Nada bloquea (D3).
 * - Antes de crear: el aviso fuerte cuando el día elegido es el próximo día de
 *   despacho y ya pasaron las 21:20 de su víspera.
 * - Al crear: «Entró al lote…»; después de las 17:00 de la víspera, que el
 *   almacén la verá como agregada tarde; después de las 21:20, el aviso fuerte.
 */
export function swaypLotNotice(input: { day: string; now: Date; lima: boolean }): SwaypLotNotice | null {
  if (!input.lima || !/^\d{4}-\d{2}-\d{2}$/.test(input.day)) return null;
  const at = input.now.getTime();
  const vispera = prevDay(input.day);
  const late = at > limaInstant(vispera, SWAYP_ROUTE_CLOSE_MINUTE);
  const afterCutoff = at >= limaInstant(vispera, SWAYP_NIGHT_CUTOFF_MINUTE);
  const nextDispatch = firstSwaypDispatchDay(limaClock(input.now).day);
  const created = SWAYP_ASESORA_CREATED(swaypDayLabel(input.day));
  return {
    before: afterCutoff && input.day === nextDispatch ? { kind: "crit", text: SWAYP_ASESORA_NOCHE } : null,
    after: afterCutoff ? `${created} ${SWAYP_ASESORA_NOCHE}` : late ? `${created} ${SWAYP_ASESORA_TARDE}` : created,
    late,
    afterCutoff,
  };
}

/**
 * El día que la puerta propone por defecto: el próximo día de despacho; si ya
 * pasaron las 21:20 de su víspera y el destino es Lima, el siguiente (D3).
 * Provincia no cambia.
 */
export function swaypSuggestedDispatchDay(input: { now: Date; lima: boolean }): string {
  const first = firstSwaypDispatchDay(limaClock(input.now).day);
  if (!input.lima) return first;
  return input.now.getTime() >= limaInstant(prevDay(first), SWAYP_NIGHT_CUTOFF_MINUTE) ? firstSwaypDispatchDay(first) : first;
}
