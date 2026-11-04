// El pin tiene que estar corroborado por el pedido antes de emitir una guía.
//
// QUÉ PASÓ. #KP133769 (11-09-2026): la clienta eligió Puno en el desplegable
// del checkout, escribió «Puno» como ciudad y «JR. Velasco Astete 191», y su
// checkout geocodificó el punto en Puno (-15.8443, -70.0252). La guía se creó
// con un pin en Santiago, Cusco (-13.5446, -71.9851), a 331 km. El paquete se
// fue a Cusco y volvió.
//
// A la cotización de Aliclik solo se le mandan `warehouseId`, `lat` y `lng`:
// EL PIN DECIDE A DÓNDE VA EL PAQUETE. La dirección escrita viaja en la guía
// para que el motorizado la lea, pero no corrige el destino. Así que un pin
// equivocado no es un detalle de formulario: es el destino.
//
// POR QUÉ NO SALTÓ EL AVISO QUE YA EXISTÍA. Se comparaba solo el DISTRITO que
// Aliclik deduce del pin contra el nuestro, y ese aviso salta en 1.958 de 4.173
// guías (47%). Casi siempre por nada: Cusco/Cuzco, Coronel Portillo/Pucallpa,
// el nombre oficial contra el comercial (§10 del MOM). Un aviso que sale en la
// mitad de los pedidos no lo lee nadie, y este salió ahí dentro.
//
// LO QUE SÍ DISCRIMINA. El pedido trae DOS declaraciones del destino que son
// independientes del pin:
//
//   1. El departamento que la clienta ELIGIÓ en el desplegable del checkout,
//      que llega como código ISO 3166-2:PE en `customAttributes` («PE-PUN»).
//      Es vocabulario cerrado: no se escribe, se elige. Lo traen 14.770 de
//      23.034 pedidos y NADIE lo estaba usando.
//   2. La ciudad que escribió en la dirección (en la convención peruana de
//      Shopify, `city` es el distrito).
//
// Medido sobre las guías creadas por API: el departamento del pin coincide con
// el del desplegable en el 99,9% de las entregadas (1.388 de 1.390). Solo 10
// guías de 2.878 discrepan — y se parten limpiamente en dos:
//
//   · El pin estaba mal (5): el pin no coincide NI con el desplegable NI con la
//     ciudad escrita. #KP133769, #KP134170, #KP130297, #KP127265, #KP123779.
//     Ninguna se entregó.
//   · El desplegable estaba mal (4): la clienta eligió mal el departamento pero
//     escribió bien la ciudad, y el pin coincide con la ciudad. #KP126473 se
//     entregó sin problema.
//
// DE AHÍ LA REGLA: el pin necesita que UNA de las dos declaraciones lo respalde.
// Si las dos lo contradicen, el pin está solo contra el pedido y no se emite.
// Sobre lo medido eso son 5 bloqueos, los 5 reales, y 0 falsos positivos.
//
// NO se corrige solo. Mover el pin es decidir a dónde va el paquete, y eso lo
// hace una persona mirando la dirección (misma regla que §10 del MOM).

import { UBIGEO_BY_CITY } from "@/lib/ubigeo";

/**
 * ISO 3166-2:PE → departamento. Es lo que manda el desplegable del checkout.
 *
 * `PE-LIM` (departamento de Lima) y `PE-LMA` (Lima Metropolitana) se resuelven
 * los dos a «lima» A PROPÓSITO: son dos códigos para lo que Aliclik devuelve
 * como un solo departamento, y distinguirlos aquí solo produciría bloqueos
 * falsos. El matiz Lima provincia / Lima metropolitana vive en la cobertura
 * (§19.0.1 del MOM), no en esta comprobación.
 */
export const DEPARTAMENTO_POR_ISO: Readonly<Record<string, string>> = Object.freeze({
  "PE-AMA": "Amazonas",
  "PE-ANC": "Áncash",
  "PE-APU": "Apurímac",
  "PE-ARE": "Arequipa",
  "PE-AYA": "Ayacucho",
  "PE-CAJ": "Cajamarca",
  "PE-CAL": "Callao",
  "PE-CUS": "Cusco",
  "PE-HUV": "Huancavelica",
  "PE-HUC": "Huánuco",
  "PE-ICA": "Ica",
  "PE-JUN": "Junín",
  "PE-LAL": "La Libertad",
  "PE-LAM": "Lambayeque",
  "PE-LIM": "Lima",
  "PE-LMA": "Lima",
  "PE-LOR": "Loreto",
  "PE-MDD": "Madre de Dios",
  "PE-MOQ": "Moquegua",
  "PE-PAS": "Pasco",
  "PE-PIU": "Piura",
  "PE-PUN": "Puno",
  "PE-SAM": "San Martín",
  "PE-TAC": "Tacna",
  "PE-TUM": "Tumbes",
  "PE-UCA": "Ucayali",
});

/**
 * El departamento detrás de un código ISO, o null si no es uno.
 *
 * Solo se acepta el código. El mismo campo del checkout llega a veces con texto
 * libre («Trujillo», «San Roman», y en un pedido el nombre de la clienta), y
 * eso NO es una declaración del departamento: es otra cosa escrita en el hueco
 * equivocado. Tratarla como declaración es lo que convertiría esta comprobación
 * en el ruido del que viene huyendo.
 */
export function departamentoDeCodigoIso(value: string | null | undefined): string | null {
  const code = (value ?? "").trim().toUpperCase();
  return DEPARTAMENTO_POR_ISO[code] ?? null;
}

/**
 * Normaliza para comparar lugares: sin tildes, sin puntuación, minúscula.
 *
 * La `z` se iguala a la `s` porque Cusco y Cuzco son el mismo sitio y las dos
 * grafías conviven en los datos (362 guías traen «Cuzco» del checkout y
 * «Cusco» de Aliclik). Es la misma unificación que ya hace §19.0.1 del MOM.
 */
function lugar(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/z/g, "s")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * LIMA Y CALLAO SON UN SOLO DESTINO PARA ESTA PREGUNTA (04-11-2026).
 *
 * #KP142342: la clienta eligió Callao (`PE-CAL`), escribió «Callao» y su pin cae
 * en Ventanilla, que ES Callao. Aliclik archiva los distritos del Callao bajo el
 * departamento «Lima», así que el pin decía «Ventanilla, Lima» contra «Callao»
 * y la guía se bloqueaba. Y la ciudad escrita no lo salvaba: «Callao» es la
 * provincia, el distrito del pin es Ventanilla. Medido en 30 días: 72 pedidos
 * con `PE-CAL`, 70 escribieron «Callao» como ciudad. Todos se habrían bloqueado
 * al salir por Aliclik.
 *
 * Por eso: si el pin cae en uno de los siete distritos del Callao y su
 * departamento es Lima o Callao, cualquiera de los dos en el desplegable lo
 * respalda. Se exige el departamento además del distrito porque «Bellavista»
 * también existe en San Martín, Cajamarca y Piura.
 */
const DISTRITOS_DEL_CALLAO = new Set(Object.keys(UBIGEO_BY_CITY.callao ?? {}));
const LIMA_O_CALLAO = new Set(["lima", "callao"]);

function pinEnElCallao(departamentoDelPin: string | null | undefined, distritoDelPin: string | null | undefined): boolean {
  return LIMA_O_CALLAO.has(lugar(departamentoDelPin)) && DISTRITOS_DEL_CALLAO.has(lugar(distritoDelPin));
}

/** Lo que el pedido dice del destino, frente a lo que Aliclik dedujo del pin. */
export interface PinContraElPedido {
  /** Departamento que Aliclik dedujo del pin. */
  departamentoDelPin: string | null | undefined;
  /** Distrito que Aliclik dedujo del pin. */
  distritoDelPin: string | null | undefined;
  /** Código ISO del desplegable del checkout, tal cual llegó. */
  isoDelCheckout: string | null | undefined;
  /** Ciudad escrita en la dirección: el distrito, en la convención peruana. */
  ciudadEscrita: string | null | undefined;
  /**
   * El distrito que una PERSONA fijó en «Ubicación y cobertura», o null si
   * nadie corrigió la ubicación. Es una tercera declaración: alguien miró la
   * dirección. Sin esto, el aviso mandaba a «revisar la ubicación» y corregirla
   * no cambiaba nada (#KP142342).
   */
  distritoCorregido?: string | null;
}

/**
 * Por qué NO se puede emitir con este pin, o null si el pedido lo respalda.
 *
 * Devuelve texto redactado para enseñar, no un booleano: quien lo lee tiene que
 * poder decidir sin abrir el código.
 */
export function pinSinCorroborar(x: PinContraElPedido): string | null {
  const elegido = departamentoDeCodigoIso(x.isoDelCheckout);
  // Sin desplegable no hay segunda declaración: no se inventa un bloqueo con
  // una sola fuente. Son 8.264 pedidos de 23.034, y para ellos esto no cambia
  // nada — siguen con el aviso de distrito de siempre.
  if (!elegido) return null;

  const pin = lugar(x.departamentoDelPin);
  if (!pin) return null;
  if (pin === lugar(elegido)) return null;
  // Lima y Callao: el mismo destino para Aliclik (ver `pinEnElCallao`).
  if (LIMA_O_CALLAO.has(lugar(elegido)) && pinEnElCallao(x.departamentoDelPin, x.distritoDelPin)) return null;
  // Una persona corrigió la ubicación y fijó el distrito donde cae el pin.
  const corregido = lugar(x.distritoCorregido);
  if (corregido && corregido === lugar(x.distritoDelPin)) return null;

  // Segunda oportunidad: la ciudad escrita. Si el pin cae en el distrito que
  // ella misma escribió, el pin está corroborado y quien se equivocó fue el
  // desplegable — el caso de #KP126473 (eligió Lima, escribió Pucallpa, el
  // paquete llegó a Pucallpa).
  const ciudad = lugar(x.ciudadEscrita);
  if (ciudad && ciudad === lugar(x.distritoDelPin)) return null;

  const donde = [x.distritoDelPin, x.departamentoDelPin].filter(Boolean).join(", ");
  return (
    `El pin apunta a ${donde || "otro sitio"}, y el pedido dice ${elegido}` +
    (x.ciudadEscrita ? ` (${x.ciudadEscrita})` : "") +
    ". El paquete va a donde apunta el pin, no a la dirección escrita, así que " +
    "esta guía saldría hacia otro departamento. Revisa la ubicación en «Ubicación " +
    "y cobertura» antes de emitirla."
  );
}
