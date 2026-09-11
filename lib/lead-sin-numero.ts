// El cliente que escribe con NOMBRE DE USUARIO de WhatsApp y no deja su número.
//
// QUÉ PASÓ. Desde agosto de 2026 Meta permite escribir a un negocio con nombre
// de usuario en vez de con el teléfono, y en ese caso NO entrega el número: el
// contacto llega identificado por un `business-scoped user id` (`PE.1492386…`).
// Medido en Kapta: 0% de los leads en junio y julio, 3,27% en agosto, 4,77% en
// la primera mitad de septiembre. Va a más, no a menos.
//
// LO QUE ROMPE, que no es una cosa sino tres:
//
//   1. El courier no tiene a quién llamar (43 pedidos y S/6.140 desde agosto
//      salieron sin número de contacto).
//   2. «Venta telefónica» busca al cliente por `(store_id, phone)`. Un lead sin
//      número NO SE ENCUENTRA, así que crea uno nuevo y la venta se le acredita
//      a ese clon — que no tiene `ad_id`. El anuncio que trajo al cliente figura
//      como si no hubiera vendido.
//   3. La próxima vez que ese cliente escriba, vuelve a pasar.
//
// EL CASO QUE LO DESTAPÓ (11-09-2026). Claudia entra por el anuncio «🌙 Noches
// Más Tranquilas» a las 11:22:31 y Kapta le crea su lead con `ad_id` y sin
// teléfono. A las 11:27 ella TECLEA su número en el chat. A las 11:28 la asesora
// abre «Venta telefónica» con ese número, no aparece nadie, y se crea un segundo
// lead. El pedido #KP133722 se ata al segundo. Siete minutos después la misma
// asesora vuelve al primero y lo marca «contactado, dejó WhatsApp»: ella sabía
// que eran la misma persona, el sistema no.
//
// Medido sobre 30 días, los leads de anuncio SIN número «convierten» al 2,99%
// contra el 7,22% de los que traen número (esperados ~27, observados 11,
// p ≈ 0,002). Parte de esa brecha es esta duplicación y parte es que sin número
// cuesta más cerrar; las dos empujan igual y no se pueden separar con los datos
// que hay.

/**
 * ¿Se guarda en el lead el celular que se tecleó al generar el pedido? PURA.
 *
 * SOLO RELLENA EL HUECO. Un lead que ya trae número lo trajo de WhatsApp y ese
 * es la identidad del cliente; el del formulario puede ser el de quien recibe el
 * paquete. Medido sobre 4.465 pedidos coinciden en 4.461 (99,9%), así que
 * rellenar es seguro — pero pisar no aporta nada y puede confundir a dos
 * personas distintas en una sola ficha.
 */
export function debeGuardarTelefono(
  leadPhone: string | null | undefined,
  typedPhone: string | null | undefined,
): boolean {
  return !leadPhone && Boolean(typedPhone && typedPhone.trim());
}

export interface CandidatoSinNumero {
  id: string;
  name: string | null;
  username: string | null;
  adHeadline: string | null;
  lastInteractionAt: string | null;
}

/** Cuántos se ofrecen. Medido sobre 7 días de Kenku en ventanas de 2 horas: 3
 *  candidatos de media y 16 en el peor caso. Seis entran en pantalla sin tapar
 *  el formulario y cubren la media con holgura. */
export const MAX_CANDIDATOS = 6;

/** Cuánto hacia atrás se mira. El cliente escribe, la asesora le pide el número
 *  y vende en la misma sesión —en el caso de Claudia pasaron seis minutos—, así
 *  que dos horas cubren el caso real sin arrastrar conversaciones de ayer. */
export const VENTANA_CANDIDATOS_MS = 2 * 60 * 60_000;

function normaliza(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * ¿El nombre tecleado apunta a este candidato? PURA.
 *
 * Por palabras y no por igualdad: la asesora escribe «Claudia» y la ficha dice
 * «Claudia Nycole Arismendi». Exigir la cadena completa dejaría fuera justo el
 * caso para el que se hizo esto.
 *
 * Las palabras de una sola letra no cuentan: una inicial suelta coincide con
 * media cola y convertiría el aviso en ruido.
 */
export function nombreApunta(
  nombreTecleado: string | null | undefined,
  candidato: CandidatoSinNumero,
): boolean {
  const contra = normaliza(`${candidato.name ?? ""} ${candidato.username ?? ""}`);
  // El filtro de longitud es la ÚNICA regla, y por eso no hay guardas antes.
  // Tuvo dos —«el buscado mide menos de 2» y «el candidato no tiene texto»— y
  // las dos eran código muerto: una palabra de una letra ya no pasa el filtro,
  // y una cadena vacía no contiene nada. Se quitaron al ver que romperlas no
  // hacía fallar ninguna prueba (M105), que es como se reconoce una línea que
  // aparenta ser una regla sin serlo.
  return normaliza(nombreTecleado ?? "")
    .split(/\s+/)
    .filter((palabra) => palabra.length >= 2)
    .some((palabra) => contra.includes(palabra));
}

/**
 * Los candidatos a ofrecer, ordenados. PURA.
 *
 * Primero los que el nombre señala —si la asesora escribió uno— y después los
 * más recientes. El orden importa más que el filtro: no se descarta a nadie por
 * no coincidir el nombre, porque el nombre es OPCIONAL en el formulario y mucha
 * ficha llega con el apodo de WhatsApp («andreita😘») en vez del nombre real.
 */
export function ordenarCandidatos(
  candidatos: readonly CandidatoSinNumero[],
  nombreTecleado: string | null | undefined,
): CandidatoSinNumero[] {
  return [...candidatos]
    .sort((a, b) => {
      const apuntaA = nombreApunta(nombreTecleado, a) ? 1 : 0;
      const apuntaB = nombreApunta(nombreTecleado, b) ? 1 : 0;
      if (apuntaA !== apuntaB) return apuntaB - apuntaA;
      const tA = Date.parse(a.lastInteractionAt ?? "");
      const tB = Date.parse(b.lastInteractionAt ?? "");
      return (Number.isFinite(tB) ? tB : 0) - (Number.isFinite(tA) ? tA : 0);
    })
    .slice(0, MAX_CANDIDATOS);
}

/** Cómo se nombra a un candidato en la lista. PURA. El username va SIEMPRE que
 *  exista: es lo único que la asesora acaba de ver en el chat, y muchas fichas
 *  traen de nombre un apodo con emoji que no dice nada. */
export function etiquetaCandidato(candidato: CandidatoSinNumero): string {
  const nombre = (candidato.name ?? "").trim();
  const usuario = (candidato.username ?? "").trim();
  if (nombre && usuario) return `${nombre} · @${usuario}`;
  if (nombre) return nombre;
  if (usuario) return `@${usuario}`;
  return "Sin nombre";
}
