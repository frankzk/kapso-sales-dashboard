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
// Confirmado el 26-10-2026: Aliclik lo llama «AutoEcom Logistic».

/** ¿El transporte de la cotización es AUTOECOM? */
export function isAutoecom(transportName: string | null | undefined): boolean {
  return (transportName ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").includes("AUTOECOM");
}

export const AUTOECOM_ONLY_REASON = "En Lima se envía solo con AUTOECOM.";

export const AUTOECOM_MISSING_WARNING =
  "Aliclik no ofreció AUTOECOM para esta dirección de Lima: puedes elegir el transporte que ofreció.";

/** ¿El transporte de la cotización es ALIDRIVER? */
export function isAlidriver(transportName: string | null | undefined): boolean {
  return (transportName ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").includes("ALIDRIVER");
}

export const AUTOECOM_OR_ALIDRIVER_REASON = "En Lima, después de AUTOECOM, se envía con AUTOECOM o ALIDRIVER.";

export const ALIDRIVER_AFTER_AUTOECOM_NOTE =
  "Este pedido ya salió con AUTOECOM: esta vez también se puede enviar con ALIDRIVER.";

/** Una guía anterior del pedido, con lo que dice su transporte y si salió. */
export interface PriorAliclikGuide {
  courier: string | null;
  aliclik_transport_name: string | null;
  dispatched_at: string | null;
}

/**
 * ¿El pedido ya salió con AUTOECOM? Una guía Aliclik suya con ese transporte
 * y despachada (Aliclik la recogió), cualquiera que sea su estado de hoy
 * —anulada, devuelta o no entregada—. Una guía AUTOECOM anulada antes de
 * salir no cuenta: el pedido nunca salió con ella. Pura.
 */
export function alreadyLeftWithAutoecom(guides: readonly PriorAliclikGuide[]): boolean {
  return guides.some(
    (g) => (g.courier ?? "").toLowerCase() === "aliclik" && isAutoecom(g.aliclik_transport_name) && Boolean(g.dispatched_at),
  );
}

/**
 * Los transportes de una cotización de Lima, con la regla de AUTOECOM. Un
 * transporte que ya no se podía elegir (un express fuera de hora) sigue sin
 * poderse elegir.
 *
 * DESPUÉS DE AUTOECOM, ALIDRIVER (02-11-2026, decisión del owner). Si el
 * pedido ya salió con AUTOECOM y vuelve a enviarse por Aliclik (#KP143987,
 * AUR5X246218871979 anulada), recién entonces se puede elegir ALIDRIVER;
 * AUTOECOM sigue disponible y los demás, no.
 */
export function limaTransportPolicy<T extends { transportName?: string | null; selectable: boolean; reason?: string }>(
  couriers: readonly T[],
  options: { afterAutoecom?: boolean } = {},
): { couriers: T[]; warning: string | null } {
  if (!couriers.some((c) => isAutoecom(c.transportName))) {
    return { couriers: [...couriers], warning: couriers.length ? AUTOECOM_MISSING_WARNING : null };
  }
  const allowed = (c: T) => isAutoecom(c.transportName) || (options.afterAutoecom === true && isAlidriver(c.transportName));
  const reason = options.afterAutoecom ? AUTOECOM_OR_ALIDRIVER_REASON : AUTOECOM_ONLY_REASON;
  return {
    couriers: couriers.map((c) => (allowed(c) ? c : { ...c, selectable: false, reason })),
    warning: options.afterAutoecom && couriers.some((c) => isAlidriver(c.transportName)) ? ALIDRIVER_AFTER_AUTOECOM_NOTE : null,
  };
}
