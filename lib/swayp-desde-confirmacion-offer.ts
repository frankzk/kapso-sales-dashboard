// ¿Se ofrece «Swayp lo puede llevar hoy» (MOM §11.11) a este pedido?
//
// La regla es la del botón «Enviar por Swayp» de la mesa de confirmación: un
// pedido de provincia COD en Por confirmar que Swayp puede llevar hoy («Swayp ok
// · con stock», §11.10), salvo «Swayp no entregó» —ese ya salió por Swayp y se
// llama para salir por otra vía—. Vive aquí, pura y sin nada del servidor,
// porque la leen la ficha del pedido y el paso de después de «Generar pedido»
// en Leads (MOM §25.2): dos copias de la condición acabarían ofreciendo Swayp en
// pedidos distintos. El servidor la vuelve a exigir al emitir
// (lib/swayp-directa.ts).
//
// Cuando no se ofrece, dice por qué en una línea: la asesora de Leads no tiene
// la mesa de confirmación delante y una opción que desaparece sin explicación
// se lee como un error.

import { ORDER_COVERAGE_LABEL, type OrderCoverage } from "@/lib/order-coverage";
import { SWAYP_AVAILABILITY_OPTIONS } from "@/lib/order-master-filters";
import type { SwaypRouteCheck } from "@/lib/order-route-plan";

export type SwaypAvailabilityValue = "ok" | "sin_stock" | "sin_cobertura";

export interface SwaypDesdeConfirmacionRow {
  macro_stage?: string | null;
  macro_substage?: string | null;
  coverage?: string | null;
  swayp_availability?: SwaypAvailabilityValue | null;
}

export type SwaypDesdeConfirmacionOffer = { offered: true } | { offered: false; reason: string };

/** Los motivos, para que la pantalla y las pruebas digan lo mismo. */
export const SWAYP_OFFER_REASON = {
  notPorConfirmar: "Swayp sin confirmar solo se ofrece mientras el pedido está en Por confirmar.",
  swaypNoEntrego: "Ya salió por Swayp y no se entregó: se llama para salir por otra vía.",
  notProvinciaCod: (coverage: string) => `Solo para provincia COD; este pedido es ${coverage}.`,
  notOk: (label: string) => `Swayp no lo puede llevar hoy: ${label.toLowerCase()}.`,
  notEvaluated: "Swayp todavía no evaluó el stock para este pedido.",
} as const;

export function swaypDesdeConfirmacionOffer(row: SwaypDesdeConfirmacionRow): SwaypDesdeConfirmacionOffer {
  if (row.macro_stage !== "por_confirmar") return { offered: false, reason: SWAYP_OFFER_REASON.notPorConfirmar };
  if (row.macro_substage === "swayp_no_entrego") return { offered: false, reason: SWAYP_OFFER_REASON.swaypNoEntrego };
  if (row.coverage !== "provincia_cod") {
    const label = row.coverage ? ORDER_COVERAGE_LABEL[row.coverage as OrderCoverage] ?? row.coverage : "sin cobertura asignada";
    return { offered: false, reason: SWAYP_OFFER_REASON.notProvinciaCod(label) };
  }
  if (row.swayp_availability !== "ok") {
    if (!row.swayp_availability) return { offered: false, reason: SWAYP_OFFER_REASON.notEvaluated };
    const label =
      SWAYP_AVAILABILITY_OPTIONS.find((option) => option.value === row.swayp_availability)?.label ??
      row.swayp_availability;
    return { offered: false, reason: SWAYP_OFFER_REASON.notOk(label) };
  }
  return { offered: true };
}

// ---------------------------------------------------------------------------
// Pedido nuevo: primero Swayp (MOM §11.14, owner 27-11-2026)
// ---------------------------------------------------------------------------
//
// «queremos poner de primera opcion a los pedidos nuevos de cuando tenemos el
// stock commpleto en Swayp, la opcion que es si no se entrega, regresa a "Por
// confimar"» y «que se bloquee Aliclik como primera opcion para estos pedidos.
// La idea es darle pedidos nuevos y limpios a Swayp». Con sus respuestas: nuevo
// es la primera salida y 48 h o menos; Aliclik deja de ser la sugerencia pero
// se puede elegir igual; lo envía la asesora con el botón «Enviar por Swayp».

/** Hasta cuántas horas desde que se creó el pedido cuenta como nuevo. */
export const SWAYP_PRIMERO_MAX_HOURS = 48;

export const SWAYP_PRIMERO_TITLE = "Pedido nuevo: primero Swayp";
export const SWAYP_PRIMERO_NOTE =
  "Swayp tiene stock de todo el pedido. Sale sin confirmar; si Swayp no lo entrega, vuelve a Por confirmar para llamarlo y sacarlo por Aliclik.";
// Los textos de las tarjetas de la Mesa de ruta viven en lib/order-route-plan.ts
// (`SWAYP_PRIMERO_ROUTE_REASON`, `SWAYP_PRIMERO_ALICLIK_REASON`).

/**
 * ¿Es un pedido nuevo que sale primero por Swayp? Provincia COD en Por confirmar
 * (no «Swayp no entregó»), sin ninguna salida todavía, creado hace 48 h o menos
 * y con stock completo en Swayp: cobertura, todos sus productos vinculados y
 * con stock (`swaypRouteCheck`, la misma lectura de la tarjeta de Swayp).
 *
 * El stock es el leído en la ficha, no `swayp_availability` del Master: esa
 * aprueba con que UN producto tenga stock y se calcula cada hora, así que un
 * pedido recién creado todavía no la tiene.
 */
export function swaypPrimero(input: {
  row: Pick<SwaypDesdeConfirmacionRow, "macro_stage" | "macro_substage" | "coverage"> & {
    order_created_at?: string | null;
  };
  outputs: number;
  swayp: SwaypRouteCheck | null | undefined;
  now: Date;
}): boolean {
  const { row, swayp } = input;
  if (row.macro_stage !== "por_confirmar" || row.macro_substage === "swayp_no_entrego") return false;
  if (row.coverage !== "provincia_cod") return false;
  if (input.outputs > 0) return false;
  const created = Date.parse(row.order_created_at ?? "");
  if (!Number.isFinite(created)) return false;
  if (input.now.getTime() - created > SWAYP_PRIMERO_MAX_HOURS * 60 * 60 * 1000) return false;
  return (
    !!swayp?.known &&
    swayp.covered === true &&
    swayp.stockOk === true &&
    !(swayp.unlinked ?? []).some(Boolean)
  );
}
