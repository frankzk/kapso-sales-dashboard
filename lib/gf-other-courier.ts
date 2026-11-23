// Una sola salida viva por pedido entre GF Courier y otro courier (owner, 23-11-2026, #KP207468: «¿no se anula en
// automático si se genera una guía de Tander o Fénix? Sigue fallando y ya lo habíamos pedido»).
//
// QUÉ PASÓ. El 19-11 se creó la guía de Aliclik y Kapta anuló sola la guía GF (eso ya funcionaba: `cancelGfGuideFor`).
// El 20-11 una persona creó desde la Mesa de ruta una SEGUNDA guía GF (-S2) con la de Aliclik en ruta: crear una guía
// GF solo miraba si había otra guía GF viva. Las dos salieron a reparto el mismo día.
//
// LA REGLA. Con una salida ACTIVA de otro courier no se crea la guía de GF Courier: primero se anula o se cierra.
// «Activa» es la definición única de `salidaActiva` (lib/shipment-output.ts; owner, 23-11-2026): en preparación, en
// ruta o reprogramada; no si su courier ya reportó que no la entregó (no contesta, rechazo, anulado…) ni si sigue en
// ruta sin reporte pasado el día de su ruta. «Propio» (Grupo GF) y las salidas por definir no cuentan.
// Pura: la usan `createGfGuideFor` (servidor) y la tarjeta de GF de la Mesa de ruta.
import { salidaActiva, type SalidaExistente } from "@/lib/shipment-output";

const LABEL: Record<string, string> = {
  aliclik: "Aliclik", swayp: "Swayp (antes Fénix)", fenix: "Swayp (antes Fénix)", shalom: "Shalom", olva: "Olva",
  tanders: "Tanders", axel: "Axel Courier", "axel courier": "Axel Courier", urpi: "Urpi",
};
const norm = (value: string | null | undefined) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** Nombre del courier de otra empresa, o null si es GF, Grupo GF, por definir o desconocido. */
export function otherCourierLabel(courier: string | null | undefined): string | null {
  return LABEL[norm(courier)] ?? null;
}

export type OtherCourierOutput = Omit<SalidaExistente, "courier"> & { courier: string | null };

/** Salidas activas de otro courier: las que impiden crear la guía de GF. */
export function liveOtherCourierOutputs<T extends OtherCourierOutput>(outputs: readonly T[], today?: string): T[] {
  return outputs.filter((o) => otherCourierLabel(o.courier) !== null && salidaActiva({ ...o, courier: o.courier ?? "" }, today));
}

/** Por qué no se crea la guía de GF, nombrando la salida activa; null si nada lo impide. */
export function otherCourierBlocksGf(outputs: readonly OtherCourierOutput[], today?: string): string | null {
  const live = liveOtherCourierOutputs(outputs, today)[0];
  if (!live) return null;
  return gfBlockedByOtherCourierText(otherCourierLabel(live.courier)!, live.guide_code ?? null);
}

export function gfBlockedByOtherCourierText(label: string, guideCode: string | null): string {
  return `${label} ya tiene una salida activa en este pedido${guideCode ? ` (guía ${guideCode})` : ""}: no se crea la guía de GF Courier. Anúlala o ciérrala primero.`;
}
