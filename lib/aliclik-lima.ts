// Aliclik en Lima: solo con AUTOECOM (MOM §9, «Aliclik en Lima», 26-10-2026,
// decisión del owner).
//
// Hasta el 26-10-2026 Aliclik era solo de Provincia COD; en Lima salían Grupo
// GF, Tanders y Swayp. Desde ese día Tanders deja de crear guías y Aliclik
// entra a Lima, pero solo con su transporte AUTOECOM. La cotización de Aliclik
// (`GET /integration/order/shipping/cost`) devuelve los transportes que llegan
// a ese punto; en Lima:
//
//   · si uno es AUTOECOM, solo ese se puede elegir;
//   · si ninguno lo es, se deja elegir el que Aliclik ofrezca (decisión del
//     owner: mejor salir con otro que no salir) y la cotización lo avisa.
//
// El nombre exacto no se conocía al escribir esto (Kapta nunca había cotizado
// una dirección de Lima: sus 7.476 guías eran ALIDRIVER), así que se compara
// sin espacios, guiones ni mayúsculas: «AUTOECOM», «Auto Ecom», «AUTO-ECOM».

/** ¿El transporte de la cotización es AUTOECOM? */
export function isAutoecom(transportName: string | null | undefined): boolean {
  return (transportName ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").includes("AUTOECOM");
}

export const AUTOECOM_ONLY_REASON = "En Lima se envía solo con AUTOECOM.";

export const AUTOECOM_MISSING_WARNING =
  "Aliclik no ofreció AUTOECOM para esta dirección de Lima: puedes elegir el transporte que ofreció.";

/**
 * Los transportes de una cotización de Lima, con la regla de AUTOECOM. Un
 * transporte que ya no se podía elegir (un express fuera de hora) sigue sin
 * poderse elegir.
 */
export function limaTransportPolicy<T extends { transportName?: string | null; selectable: boolean; reason?: string }>(
  couriers: readonly T[],
): { couriers: T[]; warning: string | null } {
  if (!couriers.some((c) => isAutoecom(c.transportName))) {
    return { couriers: [...couriers], warning: couriers.length ? AUTOECOM_MISSING_WARNING : null };
  }
  return {
    couriers: couriers.map((c) =>
      isAutoecom(c.transportName) ? c : { ...c, selectable: false, reason: AUTOECOM_ONLY_REASON },
    ),
    warning: null,
  };
}
