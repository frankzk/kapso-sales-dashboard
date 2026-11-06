// Cómo se lee la cola de armado.
//
// La cola era una lista sola, ordenada por fecha de creación, y eso escondía
// dos cosas distintas:
//
// 1. No todas las cajas salen de la cola por lo mismo. En Aliclik el `PREPARED`
//    autenticado equivale al escaneo físico (MOM §6.2) y mueve la salida sin que
//    nadie toque Kapta: de 2 850 salidas Aliclik que llegaron a `listo_despacho`,
//    UNA tenía escaneo local. Provincia COD no es trabajo que el almacén cierre
//    con el lector, aunque la caja sí se empaque aquí — por eso se lista, pero
//    diciendo quién la cierra.
// 2. Una salida con la guía anulada, o que el courier ya reporta en ruta, no es
//    trabajo de armado: nadie va a empacar eso. Mezclada en la lista solo
//    engorda el pendiente y hace que la cola se lea como atraso.
//
// El orden de los grupos es la prioridad de almacén del MOM §6.2: Lima, después
// agencia, después Aliclik.

import type { OperationKind } from "@/lib/order-macro-stage";
import { courierKey } from "@/lib/dispatch";
import { courierDisplayName } from "@/lib/dispatched-with";
import { formatOlvaTracking } from "@/lib/olva/tracking";

/** Qué hecho saca la caja de la cola. */
export type WarehouseCloser = "escaneo" | "courier";

/** Couriers que reportan la preparación por API y cierran ellos la caja. */
const API_PREPARATION_COURIERS = new Set(["aliclik"]);

/**
 * Quién cierra el armado de esta salida.
 *
 * Solo Aliclik tiene la equivalencia documentada (MOM §6.2): `PREPARED` sustituye
 * al escaneo. Para todo lo demás —Lima, agencia, Swayp— la caja sigue en la cola
 * hasta que alguien la escanee aquí.
 */
export function warehouseCloser(courier: string | null | undefined): WarehouseCloser {
  return API_PREPARATION_COURIERS.has(courierKey(courier)) ? "courier" : "escaneo";
}

/** Estados de guía que ya no admiten armado. */
const NOT_ARMABLE: Record<string, string> = {
  anulado: "Guía anulada",
  transferido: "Guía transferida",
  en_ruta: "El courier la reporta en ruta",
  entregado: "El courier la reporta entregada",
};

/** Lo que `warehouseBlocker` necesita mirar de una salida. */
export interface WarehouseBlockerInput {
  courier?: string | null;
  delivery_status?: string | null;
  /** Número de tracking que Olva emite en el mostrador (0174). */
  olva_tracking?: string | null;
  /** Los dos dígitos del año de emisión que acompañan al tracking. */
  olva_emision?: string | null;
  /** El último estado crudo que el rastreo leyó de Olva; nulo si nunca lo reconoció. */
  olva_status?: string | null;
}

/** «2804738-26», o el número solo si la salida no guardó el año. */
function olvaTrackingLabel(tracking: string, emision: string | null | undefined): string {
  const year = (emision ?? "").trim();
  return year ? formatOlvaTracking({ tracking, emision: year }) : tracking;
}

/**
 * Por qué esta salida ya no es trabajo de armado, o `null` si sí lo es.
 *
 * No se oculta: se separa. Una salida anulada que desaparece sin decir nada deja
 * al pedido contado en el Master y sin explicación en la pantalla que debería
 * darla.
 *
 * Olva con tracking registrado también se aparta. Olva emite el tracking en el
 * mostrador DESPUÉS de que la caja salió con su rótulo (MOM, «El tracking de
 * Olva y su rastreo»), así que una salida con tracking ya no está en el
 * almacén. Esas cajas casi nunca se escanean aquí —de ~199 salidas de Olva en 60
 * días, una llegó a `listo_despacho`—, y sin esta regla eran 7 de las 10
 * detenidas de agencia del 06-11-2026.
 */
export function warehouseBlocker(shipment: WarehouseBlockerInput): string | null {
  const byStatus = blockedByStatus(shipment);
  if (byStatus) return byStatus;

  if (departedWithOlva(shipment)) {
    const tracking = (shipment.olva_tracking ?? "").trim();
    const label = `Ya salió con Olva (tracking ${olvaTrackingLabel(tracking, shipment.olva_emision)})`;
    if ((shipment.olva_status ?? "").trim()) return label;
    return `${label}. El rastreo de Olva todavía no reconoce ese número: revísalo en la ficha del pedido, en «Salidas y guías».`;
  }
  return null;
}

function blockedByStatus(shipment: WarehouseBlockerInput): string | null {
  const status = shipment.delivery_status;
  return status ? NOT_ARMABLE[status] ?? null : null;
}

/**
 * Si `warehouseBlocker` la aparta porque ya salió con Olva (y no por el estado
 * de su guía). No es un error sino una caja que ya no está: la pantalla lo
 * pinta como motivo de bloqueo (ámbar), no en rojo.
 */
export function departedWithOlva(shipment: WarehouseBlockerInput): boolean {
  if (blockedByStatus(shipment)) return false;
  return courierKey(shipment.courier) === "olva" && !!(shipment.olva_tracking ?? "").trim();
}

/** A partir de aquí una caja pendiente dejó de ser trabajo del día. */
export const WAREHOUSE_STALE_DAYS = 3;

/** Desde aquí una detenida ya no espera a que alguien la arme: hay que decidir. */
export const WAREHOUSE_DECIDE_DAYS = 30;

/** Otra salida del mismo pedido, en lo justo para explicar una detenida. */
export interface WarehouseSiblingOutput {
  id: string;
  courier: string | null;
  delivery_status: string | null;
  custody_state: string | null;
  created_at: string | null;
  output_code?: string | null;
}

export interface WarehouseQueueInput extends WarehouseBlockerInput {
  courier: string | null;
  delivery_status?: string | null;
  created_at?: string | null;
  operation?: string | null;
  /** Lo último que reportó el courier por API («PENDING_DELIVERY · TO_PREPARE · …»). */
  reported_status?: string | null;
  /**
   * Las salidas ANTERIORES del mismo pedido (creadas antes que esta, sin ella).
   * Solo las carga la estación de almacén; sin ellas el diagnóstico cae a las
   * demás razones.
   */
  previousOutputs?: WarehouseSiblingOutput[];
}

/**
 * Las salidas del pedido creadas ANTES que esta, sin ella misma: las que pueden
 * explicar por qué esta existe (la anterior se anuló o volvió).
 */
export function previousOutputsOf(
  shipment: { id: string; created_at: string | null },
  siblings: readonly WarehouseSiblingOutput[],
): WarehouseSiblingOutput[] {
  const own = shipment.created_at ? Date.parse(shipment.created_at) : Number.NaN;
  return siblings.filter((other) => {
    if (other.id === shipment.id || !other.created_at) return false;
    const at = Date.parse(other.created_at);
    // Sin fecha propia no hay «antes» que medir: se queda todo lo demás.
    return Number.isNaN(own) || at < own;
  });
}

export interface WarehouseQueueEntry<T extends WarehouseQueueInput> {
  shipment: T;
  closer: WarehouseCloser;
  /** Días completos que la salida lleva esperando. */
  ageDays: number;
  stalled: boolean;
  /** Por qué está detenida y qué hacer; `null` si no lo está. */
  diagnosis: string | null;
}

export interface WarehouseQueueGroup<T extends WarehouseQueueInput> {
  operation: OperationKind;
  entries: WarehouseQueueEntry<T>[];
  /** Cuántas de este grupo dependen del reporte del courier, no del escaneo. */
  waitingOnCourier: number;
  stalled: number;
}

export interface WarehouseQueue<T extends WarehouseQueueInput> {
  groups: WarehouseQueueGroup<T>[];
  /** Salidas que ya no se pueden armar, con el motivo. */
  blocked: { shipment: T; reason: string }[];
  /** Total armable: lo que de verdad falta pasar por el lector o por el courier. */
  total: number;
  stalled: number;
}

/** Prioridad de almacén del MOM §6.2: Lima, agencia, Aliclik. */
const GROUP_ORDER: OperationKind[] = ["lima", "agencia", "provincia_cod", "desconocida"];

function operationOf(value: string | null | undefined): OperationKind {
  return (GROUP_ORDER as string[]).includes(value ?? "")
    ? (value as OperationKind)
    : "desconocida";
}

function daysBetween(fromIso: string | null | undefined, now: number): number {
  if (!fromIso) return 0;
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.floor((now - from) / 86_400_000));
}

/**
 * Arma la cola: agrupa por operación en el orden de prioridad, marca quién
 * cierra cada caja y aparta lo que ya no se puede armar.
 */
export function buildWarehouseQueue<T extends WarehouseQueueInput>(
  shipments: T[],
  now: number = Date.now(),
): WarehouseQueue<T> {
  const blocked: { shipment: T; reason: string }[] = [];
  const byOperation = new Map<OperationKind, WarehouseQueueEntry<T>[]>();

  for (const shipment of shipments) {
    const reason = warehouseBlocker(shipment);
    if (reason) {
      blocked.push({ shipment, reason });
      continue;
    }
    const ageDays = daysBetween(shipment.created_at, now);
    const closer = warehouseCloser(shipment.courier);
    const stalled = ageDays >= WAREHOUSE_STALE_DAYS;
    const entry: WarehouseQueueEntry<T> = {
      shipment,
      closer,
      ageDays,
      stalled,
      diagnosis: stalled ? stallDiagnosis({ shipment, closer, ageDays }) : null,
    };
    const operation = operationOf(shipment.operation);
    const list = byOperation.get(operation) ?? [];
    list.push(entry);
    byOperation.set(operation, list);
  }

  const groups: WarehouseQueueGroup<T>[] = [];
  for (const operation of GROUP_ORDER) {
    const entries = byOperation.get(operation);
    if (!entries?.length) continue;
    // Lo más viejo primero: dentro de un grupo, lo que lleva días esperando es lo
    // que hay que mirar, no lo que acaba de entrar.
    entries.sort((a, b) => b.ageDays - a.ageDays);
    groups.push({
      operation,
      entries,
      waitingOnCourier: entries.filter((entry) => entry.closer === "courier").length,
      stalled: entries.filter((entry) => entry.stalled).length,
    });
  }

  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const stalled = groups.reduce((sum, group) => sum + group.stalled, 0);
  return { groups, blocked, total, stalled };
}

/** Una salida anterior que no llegó: anulada, o cuya caja volvió o viene de vuelta. */
function failedOutput(output: WarehouseSiblingOutput): boolean {
  return (
    output.delivery_status === "anulado" ||
    output.custody_state === "devuelto" ||
    output.custody_state === "retorno"
  );
}

function newestFirst(a: WarehouseSiblingOutput, b: WarehouseSiblingOutput): number {
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

/** « (Tanders)», o nada si la anterior no tenía courier elegido. */
function previousCourierLabel(courier: string | null): string {
  const key = courierKey(courier);
  return key && key !== "por_definir" ? ` (${courierDisplayName(courier)})` : "";
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase("es") + text.slice(1);
}

/** Qué le pasó a la salida anterior, dicho como se diría en el almacén. */
function whatHappened(output: WarehouseSiblingOutput): string {
  if (output.custody_state === "devuelto") return "volvió a la oficina";
  if (output.custody_state === "retorno") {
    return output.delivery_status === "anulado" ? "se anuló y viene de vuelta" : "viene de vuelta";
  }
  return "se anuló";
}

const DECIDE_LINE = "30 días o más sin armar: hay que decidir si sale o se cancela.";

/**
 * Por qué una caja detenida sigue en la cola y qué hacer con ella.
 *
 * «Detenida» sola no movía a nadie: el 06-11-2026 había 18 y ninguna decía por
 * qué. Gana la primera razón que aplica:
 *
 * a) la salida anterior del pedido (la inmediata) se anuló o volvió: esta es la
 *    salida nueva, y la caja de la anterior es la que hay que rotular; sin
 *    courier, primero elegirlo;
 * b) el courier está «por definir»: nadie puede armarla hasta que Despacho elija;
 * c) Aliclik no la reporta preparada (sigue en `TO_PREPARE`, o sin reporte):
 *    la cierra su reporte, nunca el escaneo;
 * d) Olva sin tracking: si ya salió, falta registrar el tracking;
 * e) 30 días o más: ya no es armarla, es decidir si sale o se cancela;
 * f) lo demás: nadie la armó.
 *
 * Los 30 días se añaden a la razón que haya, no la tapan: una caja sin courier
 * desde hace tres meses sigue necesitando courier, y además una decisión.
 */
export function stallDiagnosis<T extends WarehouseQueueInput>(
  entry: Pick<WarehouseQueueEntry<T>, "shipment" | "closer" | "ageDays">,
): string {
  const { shipment, closer, ageDays } = entry;
  const courier = courierKey(shipment.courier);
  const undecided = !courier || courier === "por_definir";
  const old = ageDays >= WAREHOUSE_DECIDE_DAYS;
  const withAge = (line: string) => (old ? `${line} ${DECIDE_LINE}` : line);

  // Solo la inmediatamente anterior explica esta: si después de una anulada hubo
  // otra salida viva, «la anterior se anuló» hablaría de la caja equivocada.
  const previous = [...(shipment.previousOutputs ?? [])].sort(newestFirst)[0];
  const failed = previous && failedOutput(previous) ? previous : undefined;
  if (failed) {
    const head = `Salida nueva: la anterior${previousCourierLabel(failed.courier)} ${whatHappened(failed)}.`;
    // Aliclik la cierra con su reporte: con ella el escaneo no cuenta.
    const close =
      closer === "courier"
        ? `; sale de la cola cuando ${courierDisplayName(shipment.courier)} la reporte preparada.`
        : " y escanéala.";
    const todo =
      failed.custody_state === "devuelto"
        ? `Rotula esa caja con esta salida${close}`
        : `Si la caja ya está en oficina, rotúlala con esta salida${close}`;
    // Sin courier no hay rótulo que poner: lo que bloquea va primero.
    return withAge(undecided ? `${head} Primero elige courier en Despacho; después ${lowerFirst(todo)}` : `${head} ${todo}`);
  }

  if (undecided) return withAge("Sin courier: elígelo en Despacho para poder armarla.");

  if (closer === "courier") {
    // La cierra el reporte del courier, no el escaneo: nunca pedir escanearla.
    const name = courierDisplayName(shipment.courier);
    if ((shipment.reported_status ?? "").toUpperCase().includes("TO_PREPARE")) {
      return withAge(`${name} no la reporta preparada (TO_PREPARE): revisa en su portal si ya se empacó.`);
    }
    return withAge(`${name} todavía no la reporta preparada: empácala si falta y, si ya está empacada, revísalo en su portal.`);
  }

  if (courier === "olva" && !(shipment.olva_tracking ?? "").trim()) {
    return withAge("Si ya salió, registra el tracking de Olva en la ficha del pedido, en «Salidas y guías»; si no, ármala.");
  }

  if (old) return DECIDE_LINE;
  return "Nadie la armó: rotúlala y escanéala, o avisa si falta stock.";
}

/** Cuánto falta empacar de una operación, para el panel de cabecera. */
export interface WarehousePanel {
  operation: OperationKind;
  total: number;
  stalled: number;
  /**
   * Quién cierra las cajas de este panel. `null` cuando no queda ninguna, y
   * `mixto` cuando conviven las dos formas —pasa si un pedido de provincia sale
   * por un courier sin equivalencia documentada—.
   */
  closer: WarehouseCloser | "mixto" | null;
}

/**
 * Las tres operaciones que el panel enseña SIEMPRE, aunque estén en cero.
 *
 * Que aparezcan vacías es justamente el punto: un almacén que solo ve lo que le
 * queda no puede saber si Lima ya cerró, porque un grupo sin cajas simplemente
 * no se dibuja. El cero hay que enseñarlo para poder exigirlo al final del turno.
 */
export const WAREHOUSE_PANEL_OPERATIONS: OperationKind[] = ["lima", "agencia", "provincia_cod"];

/**
 * El resumen por operación.
 *
 * Se calcula sobre la cola YA construida para que el panel y la lista no puedan
 * discrepar: lo apartado —guías anuladas, o que el courier ya reporta en ruta—
 * queda fuera de los dos, porque nadie va a empacar esas cajas.
 */
export function warehousePanels<T extends WarehouseQueueInput>(
  queue: WarehouseQueue<T>,
): WarehousePanel[] {
  const byOperation = new Map(queue.groups.map((group) => [group.operation, group]));
  // Las fijas primero, y `desconocida` solo si de verdad hay algo sin clasificar:
  // un panel permanente para lo que no debería existir enseña a ignorarlo.
  const operations = [...WAREHOUSE_PANEL_OPERATIONS];
  if (byOperation.has("desconocida")) operations.push("desconocida");

  return operations.map((operation) => {
    const group = byOperation.get(operation);
    if (!group?.entries.length) {
      return { operation, total: 0, stalled: 0, closer: null };
    }
    const byCourier = group.waitingOnCourier;
    return {
      operation,
      total: group.entries.length,
      stalled: group.stalled,
      closer: byCourier === 0 ? "escaneo" : byCourier === group.entries.length ? "courier" : "mixto",
    };
  });
}
