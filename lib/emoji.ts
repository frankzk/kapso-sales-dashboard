// El catálogo de emojis del compositor de Leads, y la lógica que lo maneja.
//
// POR QUÉ A MANO Y NO UNA LIBRERÍA. Los paquetes de emojis (emoji-mart y
// compañía) traen el set completo de Unicode con sus nombres en varios idiomas:
// son cientos de kB que acabarían en el bundle del dashboard para una caja de
// texto. Acá hace falta lo que una asesora usa de verdad al confirmar un pedido
// contra entrega, y eso cabe en una lista escrita a mano — con las palabras de
// búsqueda en ESPAÑOL, que ninguna librería trae bien.
//
// La lógica va aparte de la interfaz porque es lo que puede romperse en
// silencio: insertar en la posición equivocada del texto o perder el cursor no
// lanza ningún error, solo produce mensajes mal escritos.

export interface EmojiEntry {
  /** El carácter. */
  e: string;
  /** Palabras de búsqueda, separadas por espacio, en español y sin tildes. */
  k: string;
}

export interface EmojiGroup {
  id: string;
  label: string;
  /** El emoji que hace de pestaña. */
  icon: string;
  items: EmojiEntry[];
}

/**
 * Grupos. El primero es el que más se usa en esta operación —confirmar, cobrar,
 * despachar— y por eso va delante: el orden alfabético o el de Unicode dejarían
 * el 📦 a tres pestañas de distancia del caso más frecuente.
 */
export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    id: "venta",
    label: "Venta y envío",
    icon: "📦",
    items: [
      { e: "✅", k: "listo ok confirmado check visto bueno" },
      { e: "☑️", k: "check casilla marcado" },
      { e: "❌", k: "no error cancelado equis" },
      { e: "📦", k: "paquete pedido caja envio encomienda" },
      { e: "🚚", k: "camion envio despacho reparto delivery" },
      { e: "🛵", k: "moto motorizado reparto delivery" },
      { e: "📍", k: "ubicacion direccion pin mapa lugar" },
      { e: "🗺️", k: "mapa ubicacion ruta" },
      { e: "🏠", k: "casa domicilio direccion" },
      { e: "🏢", k: "agencia oficina edificio" },
      { e: "💰", k: "dinero plata pago monto soles" },
      { e: "💵", k: "billete efectivo cash pago" },
      { e: "💳", k: "tarjeta pos pago" },
      { e: "🧾", k: "boleta recibo comprobante factura voucher" },
      { e: "📲", k: "yape celular transferencia pago movil" },
      { e: "📱", k: "celular telefono movil" },
      { e: "📞", k: "llamada telefono llamar" },
      { e: "☎️", k: "telefono llamada" },
      { e: "⏰", k: "hora reloj alarma horario" },
      { e: "🕐", k: "hora reloj tiempo" },
      { e: "📅", k: "fecha calendario dia" },
      { e: "⏳", k: "espera tiempo pendiente" },
      { e: "🔁", k: "reprogramar repetir de nuevo" },
      { e: "⚠️", k: "atencion cuidado alerta importante" },
      { e: "ℹ️", k: "informacion dato aviso" },
      { e: "🔎", k: "buscar revisar consultar lupa" },
      { e: "📷", k: "foto camara imagen" },
      { e: "🖼️", k: "foto imagen captura" },
      { e: "🎁", k: "regalo obsequio promocion" },
      { e: "🏷️", k: "precio etiqueta descuento oferta" },
      { e: "🛒", k: "carrito compra pedido" },
      { e: "⭐", k: "estrella calificacion resena" },
    ],
  },
  {
    id: "caras",
    label: "Caras",
    icon: "😊",
    items: [
      { e: "😊", k: "sonrisa feliz amable contento" },
      { e: "🙂", k: "sonrisa leve bien" },
      { e: "😀", k: "sonrisa feliz alegre" },
      { e: "😃", k: "feliz alegre contento" },
      { e: "😄", k: "feliz risa alegre" },
      { e: "😁", k: "sonrisa dientes feliz" },
      { e: "😅", k: "risa nervios sudor" },
      { e: "😂", k: "risa llorar gracioso jaja" },
      { e: "🤣", k: "risa carcajada jaja" },
      { e: "🥰", k: "amor corazones carino" },
      { e: "😍", k: "amor encanta ojos corazon" },
      { e: "😉", k: "guino complice" },
      { e: "😌", k: "aliviado tranquilo calma" },
      { e: "🤗", k: "abrazo carino bienvenida" },
      { e: "🤔", k: "duda pensar pregunta" },
      { e: "😐", k: "neutral serio" },
      { e: "😕", k: "confundido duda" },
      { e: "😞", k: "triste decepcion pena" },
      { e: "😔", k: "triste pena lamento" },
      { e: "😢", k: "llanto triste pena" },
      { e: "😭", k: "llanto fuerte triste" },
      { e: "😳", k: "sorpresa verguenza" },
      { e: "😮", k: "sorpresa asombro" },
      { e: "🥳", k: "fiesta celebracion felicidades" },
      { e: "😎", k: "genial lentes cool" },
      { e: "🤝", k: "acuerdo trato saludo mano" },
      { e: "😴", k: "dormir sueno cansado" },
      { e: "🤒", k: "enfermo fiebre malestar" },
      { e: "😇", k: "angel bueno inocente" },
    ],
  },
  {
    id: "gestos",
    label: "Gestos",
    icon: "👍",
    items: [
      { e: "👍", k: "ok bien pulgar aprobado dale" },
      { e: "👎", k: "mal no pulgar abajo" },
      { e: "🙏", k: "gracias por favor rezo agradecido" },
      { e: "👏", k: "aplauso felicitaciones bravo" },
      { e: "🙌", k: "celebracion manos arriba genial" },
      { e: "🤲", k: "manos ofrecer pedir" },
      { e: "👋", k: "hola saludo adios chau" },
      { e: "✌️", k: "paz victoria dos" },
      { e: "🤞", k: "suerte dedos cruzados" },
      { e: "💪", k: "fuerza animo vamos" },
      { e: "👌", k: "ok perfecto bien" },
      { e: "👉", k: "senala derecha mira aqui" },
      { e: "👈", k: "senala izquierda" },
      { e: "👇", k: "senala abajo aqui" },
      { e: "☝️", k: "senala arriba atencion" },
      { e: "✋", k: "alto mano espera" },
      { e: "🤙", k: "llamame shaka" },
      { e: "✍️", k: "escribir anotar firma" },
    ],
  },
  {
    id: "simbolos",
    label: "Símbolos",
    icon: "❤️",
    items: [
      { e: "❤️", k: "corazon amor rojo" },
      { e: "🧡", k: "corazon naranja" },
      { e: "💛", k: "corazon amarillo" },
      { e: "💚", k: "corazon verde" },
      { e: "💙", k: "corazon azul" },
      { e: "💜", k: "corazon morado" },
      { e: "🖤", k: "corazon negro" },
      { e: "💕", k: "corazones amor" },
      { e: "✨", k: "brillo nuevo estrellas genial" },
      { e: "🎉", k: "fiesta celebracion felicidades" },
      { e: "🎊", k: "fiesta confeti celebracion" },
      { e: "🔥", k: "fuego genial exito top" },
      { e: "💯", k: "cien perfecto total" },
      { e: "❗", k: "importante atencion exclamacion" },
      { e: "❓", k: "pregunta duda" },
      { e: "➡️", k: "flecha derecha siguiente" },
      { e: "⬅️", k: "flecha izquierda anterior" },
      { e: "🔗", k: "enlace link" },
      { e: "📌", k: "importante fijar chincheta" },
      { e: "🆗", k: "ok listo" },
      { e: "🆕", k: "nuevo novedad" },
      { e: "🚀", k: "rapido lanzamiento despegue" },
    ],
  },
];

/** Todos los emojis, aplanados. Para buscar y para resolver los recientes. */
export const ALL_EMOJIS: EmojiEntry[] = EMOJI_GROUPS.flatMap((g) => g.items);

/** Los que se ofrecen antes de que la asesora haya usado ninguno. */
export const DEFAULT_RECENTS = ["😊", "🙏", "👍", "✅", "📦", "🚚", "💰", "📍"];

const RECENTS_MAX = 16;
/** Clave de localStorage. Con prefijo para no chocar con nada más del dominio. */
export const RECENTS_KEY = "kapta:emoji-recientes";

/** Quita tildes y baja a minúsculas, para que "envío" encuentre "envio". */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Busca por palabra clave. Una consulta vacía no devuelve nada — quien no ha
 * escrito nada tiene que ver los grupos, no la lista entera de golpe.
 */
export function searchEmojis(query: string): EmojiEntry[] {
  const q = fold(query.trim());
  if (!q) return [];
  const out: EmojiEntry[] = [];
  const seen = new Set<string>();
  // Dos pasadas: primero los que EMPIEZAN por lo tecleado. Con "gr", "gracias"
  // tiene que salir antes que un emoji cuya decimoquinta palabra la contenga.
  for (const pass of [0, 1]) {
    for (const item of ALL_EMOJIS) {
      if (seen.has(item.e)) continue;
      const words = fold(item.k).split(" ");
      const hit = pass === 0 ? words.some((w) => w.startsWith(q)) : fold(item.k).includes(q);
      if (hit) {
        out.push(item);
        seen.add(item.e);
      }
    }
  }
  return out;
}

/**
 * Añade un emoji a los recientes: al principio, sin repetir y con tope.
 *
 * Sin la deduplicación, usar el mismo emoji tres veces llenaría la fila con tres
 * copias y echaría a los demás — que es justo lo contrario de para lo que sirve.
 */
export function pushRecent(current: string[], emoji: string): string[] {
  return [emoji, ...current.filter((e) => e !== emoji)].slice(0, RECENTS_MAX);
}

/** Lo que devuelve una inserción: el texto nuevo y dónde queda el cursor. */
export interface Insertion {
  text: string;
  caret: number;
}

/**
 * Inserta en la posición del cursor, reemplazando lo que estuviera seleccionado.
 *
 * El cursor queda DETRÁS del emoji, no al final del texto. Suena a detalle y no
 * lo es: al escribir "hola , ¿cómo estás?" y meter un emoji tras "hola", si el
 * cursor saltara al final, el siguiente emoji se pegaría en otro sitio y la
 * asesora escribiría a ciegas. `emoji.length` cuenta unidades UTF-16, que es la
 * misma unidad que usa `setSelectionRange`, así que los pares subrogados —casi
 * todos los emojis— caen donde deben.
 */
export function insertAtCursor(
  text: string,
  start: number,
  end: number,
  emoji: string,
): Insertion {
  // Un índice fuera de rango o invertido no debe perder texto: se acota.
  const len = text.length;
  const a = Math.max(0, Math.min(start, len));
  const b = Math.max(a, Math.min(end, len));
  return { text: text.slice(0, a) + emoji + text.slice(b), caret: a + emoji.length };
}
