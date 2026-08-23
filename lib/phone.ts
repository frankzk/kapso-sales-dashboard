// Teléfonos: normalización y la regla de qué es un móvil peruano válido.
//
// `normalizePhone` existe para que los leads (indexados por teléfono) y los
// pedidos enlacen de forma fiable: quita lo que no sea dígito y añade el código
// de país a los móviles de 9 cifras, igual que el `phone_number` de Kapso
// (p. ej. "51980694766").
//
// El resto del fichero es LA MISMA REGLA para el formulario y para el servidor.
// Vive junta a propósito: el drawer bloquea el botón con ella y la server action
// vuelve a comprobarla, y dos definiciones de «móvil válido» en dos ficheros
// acabarían discrepando — con el usuario confiando en la que le pinta la
// pantalla. Es el mismo motivo por el que la mesa de ruta delega en
// `isFillableRouteOutput` en vez de reescribir sus condiciones.

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D+/g, "");
  if (!d) return null;
  d = d.replace(/^00+/, ""); // drop international 00 prefix
  // Peru mobile without country code: 9XXXXXXXX (9 digits) → 51 9XXXXXXXX
  if (d.length === 9 && d.startsWith("9")) d = "51" + d;
  return d;
}

/** Código de país del Perú, sin el `+`. */
export const PERU_CC = "51";
/** Un móvil peruano son nueve dígitos y empieza por 9. */
export const PERU_MOBILE_DIGITS = 9;

/**
 * Los 9 dígitos NACIONALES de lo que haya escrito una persona.
 *
 * Acepta las cuatro formas que aparecen de verdad —`988805509`, `988-805-509`,
 * `+51 988 805 509`, `51988805509`— porque el campo viene prerrellenado con el
 * teléfono de WhatsApp (que trae el `51`) y encima se teclea y se pega a mano.
 * Devuelve solo la parte nacional, que es lo que se enseña y se valida.
 */
export function peruMobileDigits(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D+/g, "").replace(/^00+/, "");
  // El `51` solo se quita si SOBRAN dígitos. Sin la comparación de longitud, un
  // móvil que empiece por 51 —`519880550` es uno válido— perdería sus dos
  // primeras cifras y el error hablaría de un número que nadie tecleó.
  if (d.length > PERU_MOBILE_DIGITS && d.startsWith(PERU_CC)) return d.slice(PERU_CC.length);
  return d;
}

/**
 * ¿Por qué NO se puede usar este número? `null` = está bien.
 *
 * Devuelve el motivo en vez de un booleano para que el formulario pueda decir
 * qué falta —«faltan 2 dígitos» es accionable, «teléfono inválido» no— y para
 * que el servidor use exactamente el mismo texto.
 *
 * POR QUÉ LA REGLA ES DURA (9 dígitos empezando por 9) y no admite fijos ni
 * extranjeros: el mismo formulario ofrece enviar la confirmación por WhatsApp, y
 * a un fijo no le llega. Exigir móvil no es una restricción caprichosa, es lo
 * que el pedido necesita para poder confirmarse y para que el courier llame.
 * Una salida de emergencia sería una rama que nadie prueba y que estará mal el
 * día que por fin se use.
 */
export function peruMobileProblem(raw: string | null | undefined): string | null {
  const d = peruMobileDigits(raw);
  if (!d) return "Escribe el celular del cliente.";
  if (!d.startsWith("9")) return "Un celular peruano empieza por 9.";
  if (d.length < PERU_MOBILE_DIGITS) {
    const faltan = PERU_MOBILE_DIGITS - d.length;
    return `Faltan ${faltan} dígito${faltan === 1 ? "" : "s"}: son 9 en total.`;
  }
  if (d.length > PERU_MOBILE_DIGITS) {
    const sobran = d.length - PERU_MOBILE_DIGITS;
    return `Sobra${sobran === 1 ? "" : "n"} ${sobran} dígito${sobran === 1 ? "" : "s"}: son 9 en total.`;
  }
  return null;
}

/**
 * `988805509` → `988-805-509`, para que un dígito de más o de menos se VEA.
 *
 * En una tira de nueve cifras seguidas nadie detecta que falta una; partida en
 * tres grupos de tres, salta a la vista. Formatea lo que haya, aunque esté
 * incompleto, porque se aplica mientras se teclea.
 */
export function formatPeruMobile(raw: string | null | undefined): string {
  // Los tres cortes ya acotan a nueve: lo que sobre no se pinta, y así el campo
  // no deja teclear un décimo dígito.
  const d = peruMobileDigits(raw);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)].filter(Boolean).join("-");
}
