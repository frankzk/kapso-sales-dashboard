// La dirección que recibe Swayp (owner, 05-11-2026; MOM §11.6.2).
//
// Swayp recibe la dirección y la referencia UNA vez, al crear la guía
// (`direccionDestinatario` y `adicionalDireccion`, lib/swayp-guide.ts), y su
// API no tiene forma de cambiarlas después: solo crear, cancelar, consultar y
// resolver novedades. KP143594-S02 (guía 50000166047, 04-11-2026) se creó a las
// 12:57:16 como excepción sobre una guía anulada «por error de dirección»; la
// referencia se agregó en Kapta a las 12:58:43 y a Swayp nunca le llegó.
//
// Dos reglas, puras y probadas en test/swayp-address.test.ts:
// 1. Corregir el destino de un pedido con una guía Swayp viva avisa, antes y
//    después de guardar, que el cambio no le llega a Swayp.
// 2. La excepción sobre una guía anulada enseña exactamente lo que va a recibir
//    Swayp, y si el motivo habla de la dirección pide confirmar que ya se
//    corrigió antes de crear la guía nueva.

/** Estados de Swayp que ya cerraron la guía (7 Entregada … 12). */
const CLOSED_SWAYP_STATES: ReadonlySet<number> = new Set([7, 8, 9, 10, 11, 12]);
const CLOSED_DELIVERY = new Set(["anulado", "entregado", "devuelto"]);
const CLOSED_CATEGORY = new Set(["closed", "delivered"]);

export interface SwaypGuideRow {
  courier: string | null;
  guide_code: string | null;
  swayp_guide?: string | null;
  delivery_status: string | null;
  status_category?: string | null;
  swayp_state?: number | null;
}

/** Las guías Swayp todavía vivas (Swayp las tiene con la dirección con que se crearon). */
export function swaypLiveGuides(rows: readonly SwaypGuideRow[]): string[] {
  const guides = rows
    .filter((row) => (row.courier ?? "").toLowerCase() === "fenix")
    .filter((row) => !CLOSED_DELIVERY.has(row.delivery_status ?? ""))
    .filter((row) => !CLOSED_CATEGORY.has(row.status_category ?? ""))
    .filter((row) => row.swayp_state == null || !CLOSED_SWAYP_STATES.has(row.swayp_state))
    .map((row) => (row.swayp_guide ?? row.guide_code ?? "").trim())
    .filter(Boolean);
  return [...new Set(guides)];
}

const guideList = (guides: readonly string[]): string =>
  guides.length === 1 ? `la guía ${guides[0]}` : `las guías ${guides.join(", ")}`;

/** Antes de guardar, en el formulario de la corrección. */
export const SWAYP_ADDRESS_LIVE_BEFORE = (guides: readonly string[]): string =>
  `Swayp ya tiene ${guideList(guides)} con la dirección anterior: corregirla aquí no se la cambia a Swayp. ` +
  "Después de guardar, avísale a Swayp la dirección, la referencia y la ubicación.";

/** Después de guardar, junto al aviso de siempre. */
export const SWAYP_ADDRESS_NOT_SENT = (guides: readonly string[]): string =>
  `Ojo: Swayp ya tiene ${guideList(guides)} con la dirección anterior y este cambio no le llega. ` +
  "Avísale a Swayp la dirección, la referencia y la ubicación; si vuelve con novedad, ponlas en el comentario al resolverla.";

/**
 * La dirección tal como la ve Swayp: la referencia va pegada al final con « - »
 * (`adicionalDireccion`, lib/swayp-guide.ts).
 */
export function swaypAddressLine(address: string | null | undefined, reference: string | null | undefined): string {
  const a = (address ?? "").trim();
  const r = (reference ?? "").trim();
  return r ? `${a} - ${r}` : a;
}

/** ¿El motivo de la excepción dice que el problema fue la dirección? */
export function swaypMotiveMentionsAddress(note: string | null | undefined): boolean {
  return /direcci[oó]n|referencia|ubicaci[oó]n|domicilio/i.test(note ?? "");
}

export const SWAYP_REROUTE_ADDRESS_TITLE = "Swayp recibirá esta dirección";
export const SWAYP_REROUTE_ADDRESS_NOTE =
  "Swayp la recibe al crear la guía y después ya no se le puede cambiar: si no está bien, corrígela primero en «Modificar destino».";
export const SWAYP_REROUTE_NO_ADDRESS = "Sin dirección: corrígela en «Modificar destino» antes de crear la guía.";
export const SWAYP_REROUTE_NO_REFERENCE = "Sin referencia: Swayp solo recibirá la dirección.";
export const SWAYP_REROUTE_ADDRESS_CONFIRM = "Ya corregí la dirección y la referencia de arriba";
export const SWAYP_REROUTE_ADDRESS_REQUIRED =
  "El motivo habla de la dirección: corrígela en «Modificar destino» antes de crear la guía nueva y marca que ya está corregida.";
