// La guía GF que quedó de más (owner, 24-11-2026, #KP206950 y #KP207043: «sí, ok»).
//
// QUÉ PASA. Una persona saca el pedido con otro courier (Aliclik, Swayp…) mientras la guía GF tiene «no contesta».
// Kapta intenta anularla en GF (`cancelInactiveGfGuides`), pero si la caja todavía está con el motorizado, GF no la
// anula y la guía GF queda abierta: días después la caja vuelve al almacén de GF y se queda ahí, retenida, con el
// pedido ya entregado o en ruta por el otro courier.
//
// LA REGLA. Cuando GF dice que la caja ya volvió a su almacén (estado INCIDENT, etapa BACK_IN_WAREHOUSE) y el pedido
// ya salió con otro courier por decisión de una persona —una guía de otro courier, creada por una persona DESPUÉS de
// la guía GF, en preparación, en ruta o entregada—, Kapta anula sola la guía GF: GF desarma la caja y el producto
// vuelve al estante. Es la única excepción a «el automático no anula guías de nadie» (owner, 15-11-2026): la decisión
// ya la tomó una persona al crear la otra guía. Si la guía GF es la más nueva, la decisión vigente es GF y no se toca.
// Pura: la usan el webhook de GF y la pasada de gf-reconcile (`closeGhostGfGuide`).
import type { GfOrder } from "@/lib/gf-courier";
import { GF_STAGE_BACK_IN_WAREHOUSE } from "@/lib/gf-courier-status";
import { otherCourierLabel } from "@/lib/gf-other-courier";

export interface GhostOtherOutput {
  courier: string | null;
  guide_code: string | null;
  delivery_status: string;
  returned_at?: string | null;
  created_at: string;
  /** Su `guide_registered` tiene una persona (actor). */
  by_person: boolean;
}

/** ¿GF dice que la caja de esta guía ya está en su almacén y en ninguna carga? */
export function gfBoxBackInWarehouse(gf: Pick<GfOrder, "status" | "stage">): boolean {
  return gf.status?.code === "INCIDENT" && gf.stage?.code === GF_STAGE_BACK_IN_WAREHOUSE;
}

/** La guía del otro courier que hace sobrar la guía GF, o null si la guía GF no se anula sola. */
export function gfGhostReplacedBy(input: {
  gf: Pick<GfOrder, "status" | "stage">;
  gfCreatedAt: string;
  others: readonly GhostOtherOutput[];
}): GhostOtherOutput | null {
  if (!gfBoxBackInWarehouse(input.gf)) return null;
  const after = Date.parse(input.gfCreatedAt);
  if (!Number.isFinite(after)) return null;
  return input.others.find((o) =>
    otherCourierLabel(o.courier) !== null && o.by_person && Boolean(o.guide_code) && !o.returned_at &&
    ["pendiente", "en_ruta", "entregado"].includes(o.delivery_status) &&
    Date.parse(o.created_at) > after,
  ) ?? null;
}

/** El motivo que queda en GF y en la Actividad. */
export function gfGhostCancelNote(other: Pick<GhostOtherOutput, "courier" | "guide_code">): string {
  return `Guía de GF Courier anulada sola por Kapta: la caja volvió al almacén de GF y el pedido ya salió con ` +
    `${otherCourierLabel(other.courier) ?? "otro courier"} (guía ${other.guide_code}), creada por una persona.`;
}
