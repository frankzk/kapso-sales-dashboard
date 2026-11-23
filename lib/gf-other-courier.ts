// Una sola salida viva por pedido entre GF Courier y otro courier (owner, 23-11-2026, #KP207468: «¿no se anula en
// automático si se genera una guía de Tander o Fénix? Sigue fallando y ya lo habíamos pedido»).
//
// QUÉ PASÓ. El 19-11 se creó la guía de Aliclik y Kapta anuló sola la guía GF (eso ya funcionaba: `cancelGfGuideFor`).
// El 20-11 una persona creó desde la Mesa de ruta una SEGUNDA guía GF (-S2) con la de Aliclik en ruta: crear una guía
// GF solo miraba si había otra guía GF viva. Las dos salieron a reparto el mismo día.
//
// LA REGLA. Con una salida activa de otro courier (pendiente, en ruta o por preparar, sin devolver) no se crea la guía
// de GF Courier: primero se anula o se cierra esa salida. «Propio» (Grupo GF) y las salidas por definir no cuentan.
// Pura: la usan `createGfGuideFor` (servidor) y la tarjeta de GF de la Mesa de ruta.

const LABEL: Record<string, string> = {
  aliclik: "Aliclik", swayp: "Swayp (antes Fénix)", fenix: "Swayp (antes Fénix)", shalom: "Shalom", olva: "Olva",
  tanders: "Tanders", axel: "Axel Courier", "axel courier": "Axel Courier", urpi: "Urpi",
};
const norm = (value: string | null | undefined) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const LIVE = ["pendiente", "en_ruta", "por_preparar"];

/** Nombre del courier de otra empresa, o null si es GF, Grupo GF, por definir o desconocido. */
export function otherCourierLabel(courier: string | null | undefined): string | null {
  return LABEL[norm(courier)] ?? null;
}

export interface OtherCourierOutput {
  courier: string | null;
  guide_code?: string | null;
  delivery_status: string;
  custody_state?: string | null;
  returned_at?: string | null;
}

/** Salidas activas de otro courier: las que impiden crear la guía de GF. */
export function liveOtherCourierOutputs<T extends OtherCourierOutput>(outputs: readonly T[]): T[] {
  return outputs.filter((o) => otherCourierLabel(o.courier) !== null && LIVE.includes(o.delivery_status)
    && o.custody_state !== "devuelto" && !o.returned_at);
}

/** Por qué no se crea la guía de GF, nombrando la salida activa; null si nada lo impide. */
export function otherCourierBlocksGf(outputs: readonly OtherCourierOutput[]): string | null {
  const live = liveOtherCourierOutputs(outputs)[0];
  if (!live) return null;
  return gfBlockedByOtherCourierText(otherCourierLabel(live.courier)!, live.guide_code ?? null);
}

export function gfBlockedByOtherCourierText(label: string, guideCode: string | null): string {
  return `${label} ya tiene una salida activa en este pedido${guideCode ? ` (guía ${guideCode})` : ""}: no se crea la guía de GF Courier. Anúlala o ciérrala primero.`;
}
