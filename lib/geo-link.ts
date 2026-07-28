// Coordenadas a partir de lo que el equipo pega: un enlace de Google Maps o el
// par de números suelto.
//
// Por qué existe: Tanders no acepta una dirección de texto, exige un punto. Su
// formulario lo resuelve con el autocompletado de Google Places, que es una API
// facturada. Pegar el enlace del pin no cuesta nada y es lo que el equipo ya
// hace para compartir una ubicación por WhatsApp, así que la guía se puede crear
// sin depender de una key de Google.
//
// Puro y testeado: un signo cambiado acá manda el paquete a otro distrito.

export interface LatLng {
  lat: number;
  lng: number;
}

export type GeoLinkResult =
  | { ok: true; point: LatLng }
  | { ok: false; error: string };

/** Rango real de coordenadas. Un 0/0 se rechaza: es el Golfo de Guinea. */
function valid(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";

/**
 * Extrae el punto. El orden de los patrones importa:
 *
 *  1. `!3d…!4d…` — las coordenadas del LUGAR marcado.
 *  2. `?q=` / `query=` / `ll=` — el punto que alguien compartió explícitamente.
 *  3. `@lat,lng` — el centro de la CÁMARA, que no es el pin: si el usuario movió
 *     el mapa después de buscar, apunta a otro lado. Último recurso.
 */
export function parseGeoLink(raw: string | null | undefined): GeoLinkResult {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, error: "Pega un enlace de Google Maps o las coordenadas." };

  // Los enlaces cortos son un redirect: sin resolverlos no hay coordenadas.
  if (/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(text)) {
    return {
      ok: false,
      error:
        "Ese es un enlace corto y no contiene las coordenadas. Ábrelo en el navegador y copia el enlace largo (el que tiene @ y números).",
    };
  }

  const patterns = [
    new RegExp(`!3d${NUM}!4d${NUM}`),
    new RegExp(`[?&](?:q|query|ll|center|destination)=${NUM}%2C\\s*${NUM}`, "i"),
    new RegExp(`[?&](?:q|query|ll|center|destination)=${NUM},\\s*${NUM}`, "i"),
    new RegExp(`@${NUM},${NUM}`),
    // Par suelto: "-12.054714, -76.956875". Anclado a los extremos para no
    // capturar dos números cualesquiera de una frase.
    new RegExp(`^${NUM}\\s*[,;]\\s*${NUM}$`),
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (valid(lat, lng)) return { ok: true, point: { lat, lng } };
  }

  return {
    ok: false,
    error:
      "No se encontraron coordenadas ahí. Pega el enlace completo de Google Maps o el par «-12.054714, -76.956875».",
  };
}

/** Enlace al punto, para que el operador verifique antes de crear la guía. */
export function mapsUrlFor(point: LatLng): string {
  return `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}`;
}
