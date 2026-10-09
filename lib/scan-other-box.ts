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
