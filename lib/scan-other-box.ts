// «Ese paquete no pertenece a esta ruta» no decía cuál era la ruta (07-10-2026).
//
// EL CASO. Con KP136825-S01 en la mano —ya en la caja de Alexis desde las
// 10:12, la única que le faltaba verificar—, se abrió por error la
// verificación de Roy (también de 16 paquetes) y el escaneo respondió «no
// pertenece a esta ruta». Parecía que no dejaba asignarlo.
//
// LA REGLA. El error nombra las dos cajas: la que se está verificando y, si
// el paquete está en otra, cuál es y de qué día. Corto: se lee con la pistola
// en la mano. PURA.

import { boxDayShort } from "@/lib/gf-scan-return";
import { isFailedOutput, type OutputForDecision } from "@/lib/labels/resolve-output";
import { nombreDeCourier } from "@/lib/shipment-output";

export interface BoxRef {
  /** Quién se lleva la caja (motorizado o courier). */
  who: string;
  routeDate: string;
}

export function notInThisBoxMessage(here: BoxRef, elsewhere: BoxRef | null): string {
  if (!elsewhere) return `No está en la caja de ${here.who} ni en otra. Agrégalo primero a una caja.`;
  const there = elsewhere.who === here.who ? `otra caja de ${elsewhere.who}` : `la caja de ${elsewhere.who}`;
  return `Está en ${there} (${boxDayShort(elsewhere.routeDate)}), no en la de ${here.who}. Verifícalo en esa caja.`;
}

/** Quién se lleva la caja: quien recoge, el motorizado o el courier. */
export function boxWho(manifest: { received_by?: string | null; driver_name?: string | null }, courierLabel: string): string {
  return manifest.received_by ?? manifest.driver_name ?? courierLabel;
}

// ---------------------------------------------------------------------------
// El rótulo viejo de la caja que volvió (09-10-2026)
// ---------------------------------------------------------------------------
//
// EL CASO. #AUR177756: Tanders no entregó su S01, la caja volvió y salió con
// Grupo GF como S02. Nadie imprimió el rótulo de la S02 —se reimprimió el de
// Tanders—, y en «Verificar caja» el QR de la caja respondía «No está en la
// caja de Alexis ni en otra»: era el de la S01. Ahora el rótulo de la salida
// nueva se pega ENCIMA (MOM §9.3). Si se lee el viejo, el error nombra la
// salida que sí va. No hay alias: el QR viejo no coteja, no marca listo y no
// cuenta como la otra salida (§29.4, un solo QR vivo por paquete).

/** Una salida dicha por su código y su courier. */
export interface LabelRef {
  outputCode: string | null;
  courier: string;
}

/**
 * Leíste el rótulo de una salida que su courier no entregó. `live` es la salida
 * con la que sale la caja (en esta caja, o la del pedido por armar); sin ella,
 * se dice cómo nace.
 */
export function oldLabelMessage(scanned: LabelRef, live: { outputCode: string | null } | null, where: "caja" | "pedido"): string {
  const old = `Es el rótulo viejo de ${scanned.outputCode ?? "una salida"} (${nombreDeCourier(scanned.courier)} no entregó).`;
  if (!live) return `${old} Para reprogramarlo, imprime desde el pedido el rótulo de su salida nueva y pégalo encima.`;
  const sale = where === "caja" ? "En esta caja va" : "El pedido sale";
  return `${old} ${sale} como ${live.outputCode ?? "otra salida"}: escanea su rótulo; si la caja no lo tiene, imprímelo y pégalo encima.`;
}

/**
 * Se asignó leyendo el rótulo de otra salida del pedido: la caja va como la
 * que se rellenó o se creó al tomarlo, y su rótulo es el que tiene que llevar.
 */
export function previousLabelNote(scanned: LabelRef, assignedCode: string | null): string {
  return `Leíste el rótulo de ${scanned.outputCode ?? "otra salida"} (${nombreDeCourier(scanned.courier)}): la caja va como ${assignedCode ?? "su salida nueva"}. Imprime su rótulo y pégalo encima.`;
}

const LIVE_STATUSES = new Set(["pendiente", "en_ruta", "por_preparar"]);

/**
 * ¿El escaneo leyó el rótulo viejo de una caja que volvió? Si la salida
 * escaneada la dio por no entregada su courier, el mensaje que nombra la salida
 * con la que sale: la que está en ESTA caja (`caja`, «Verificar caja») o la del
 * pedido en el almacén (`pedido`, «Dejar paquete listo»). Si el pedido no tiene
 * otra salida viva, cómo se crea. null cuando no aplica: el error de siempre.
 */
export function oldLabelHint(
  scannedId: string,
  outputs: readonly OutputForDecision[],
  where: "caja" | "pedido",
  inThisBox: ReadonlySet<string> = new Set(),
): string | null {
  const scanned = outputs.find((output) => output.id === scannedId);
  if (!scanned || !isFailedOutput(scanned)) return null;
  const ref = { outputCode: scanned.output_code ?? null, courier: scanned.courier ?? "" };
  const live = outputs.filter((output) =>
    output.id !== scannedId &&
    LIVE_STATUSES.has(output.delivery_status ?? "") &&
    output.custody_state !== "devuelto" &&
    !isFailedOutput(output));
  if (!live.length) return oldLabelMessage(ref, null, where);
  const here = live
    .filter((output) => (where === "caja" ? inThisBox.has(output.id) : output.custody_state === "empresa"))
    .sort((a, b) => (b.output_number ?? 0) - (a.output_number ?? 0));
  return here[0] ? oldLabelMessage(ref, { outputCode: here[0].output_code ?? null }, where) : null;
}
