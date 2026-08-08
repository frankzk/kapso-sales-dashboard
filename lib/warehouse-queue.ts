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

/**
 * Por qué esta salida ya no es trabajo de armado, o `null` si sí lo es.
 *
 * No se oculta: se separa. Una salida anulada que desaparece sin decir nada deja
 * al pedido contado en el Master y sin explicación en la pantalla que debería
 * darla.
 */
export function warehouseBlocker(deliveryStatus: string | null | undefined): string | null {
  if (!deliveryStatus) return null;
  return NOT_ARMABLE[deliveryStatus] ?? null;
}

/** A partir de aquí una caja pendiente dejó de ser trabajo del día. */
export const WAREHOUSE_STALE_DAYS = 3;

export interface WarehouseQueueInput {
  courier: string | null;
  delivery_status?: string | null;
  created_at?: string | null;
  operation?: string | null;
}

export interface WarehouseQueueEntry<T extends WarehouseQueueInput> {
  shipment: T;
  closer: WarehouseCloser;
  /** Días completos que la salida lleva esperando. */
  ageDays: number;
  stalled: boolean;
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
    const reason = warehouseBlocker(shipment.delivery_status);
    if (reason) {
      blocked.push({ shipment, reason });
      continue;
    }
    const ageDays = daysBetween(shipment.created_at, now);
    const entry: WarehouseQueueEntry<T> = {
      shipment,
      closer: warehouseCloser(shipment.courier),
      ageDays,
      stalled: ageDays >= WAREHOUSE_STALE_DAYS,
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
