// El punto que la clienta marcó en el mapa del formulario de la web (owner,
// 15-11-2026). Desde el 14-11-2026 el formulario contra entrega deja en la nota
// del pedido «Punto de entrega: https://www.google.com/maps?q=lat,lng» y la
// misma coordenada en la dirección de envío, que Kapta ya toma como la
// ubicación del pedido (y la guía automática de Aliclik, como su GPS, cuando la
// dirección está completa: con la dirección incompleta sigue decidiendo una
// asesora). Esto solo sirve para nombrarla bien en la ficha: no es una
// dirección geocodificada, es el punto que eligió la clienta.
//
// Puro: lo usa la ficha en el navegador.

import { parseGeoLink, type LatLng } from "@/lib/geo-link";

const PUNTO_RE = /punto de entrega:\s*(https?:\/\/\S+)/i;

/** La coordenada del «Punto de entrega» de la nota, o null. */
export function webFormPin(note: string | null | undefined): LatLng | null {
  const m = PUNTO_RE.exec(note ?? "");
  if (!m) return null;
  const parsed = parseGeoLink(m[1]);
  return parsed.ok ? parsed.point : null;
}

/** ~10 m: la dirección guarda la misma coordenada, a veces con menos decimales. */
const SAME_POINT = 0.0001;

/** ¿La ubicación del pedido es ese punto? Solo entonces se rotula como tal. */
export function isWebFormPin(
  note: string | null | undefined,
  latitude: number | string | null | undefined,
  longitude: number | string | null | undefined,
): boolean {
  const pin = webFormPin(note);
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!pin || latitude == null || longitude == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return Math.abs(pin.lat - lat) <= SAME_POINT && Math.abs(pin.lng - lng) <= SAME_POINT;
}

export const WEB_FORM_PIN_LABEL = "punto que marcó la clienta en la web";
