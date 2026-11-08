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
