// Adaptador para couriers de AGENCIA: Shalom y Olva. El paquete no se entrega
// en el domicilio, viaja a una sucursal y el cliente lo recoge — con lo que
// aparece un ciclo de vida propio (§10) que el reparto normal no tiene:
//
//   enviado a agencia → registrado → en tránsito → disponible para recojo
//     → cliente notificado → pendiente de recojo → próximo a vencer
//     → retorno iniciado → devuelto al origen        (o bien: recogido)
//
// Entre el 5 % y el 6 % de estos pedidos termina devuelto, así que el
// seguimiento de "disponible para recojo" y "próximo a vencer" es justamente lo
// que evita la devolución.
//
// Los alias de cabecera son deliberadamente amplios: cada agencia (y cada export
// de cada agencia) titula las columnas a su manera. Añadir un alias nuevo cuando
// aparezca un formato distinto es una línea, y este módulo es puro y testeado.

import { normalizePhone } from "@/lib/phone";
import { emptyReportRow, type CanonicalReportRow, type CourierAdapter } from "./types";
import { buildLookup, parseCount, parseDate, parseNumber, pick, stripAccents } from "./sheet";

const GUIDE_KEYS = [
  "guia", "nro guia", "n guia", "numero de guia", "nro. guia", "codigo",
  "codigo de seguimiento", "tracking", "nro orden", "orden de servicio", "ost",
] as const;
const ORDER_KEYS = ["pedido", "nro pedido", "numero de pedido", "orden", "order", "referencia"] as const;
const NAME_KEYS = ["destinatario", "cliente", "nombre", "nombre completo", "consignado"] as const;
const PHONE_KEYS = ["telefono", "celular", "whatsapp", "telefono destinatario", "contacto"] as const;
const PRODUCT_KEYS = ["producto", "contenido", "descripcion", "detalle"] as const;
const DISTRICT_KEYS = ["distrito", "distrito destino"] as const;
const PROVINCE_KEYS = ["provincia", "provincia destino"] as const;
const REGION_KEYS = ["departamento", "region", "departamento destino"] as const;
const BRANCH_KEYS = ["agencia", "sucursal", "agencia destino", "oficina", "terminal", "local"] as const;
const STATUS_KEYS = ["estado", "estado envio", "situacion", "estado actual", "ultimo estado"] as const;
const REASON_KEYS = ["motivo", "observacion", "observaciones", "motivo devolucion", "detalle estado"] as const;
const SENT_KEYS = ["fecha envio", "fecha de envio", "fecha registro", "fecha emision"] as const;
const ARRIVED_KEYS = ["fecha llegada", "fecha de llegada", "llegada agencia", "fecha arribo"] as const;
const EXPIRES_KEYS = ["fecha limite", "fecha vencimiento", "vence", "fecha maxima de recojo"] as const;
const PICKED_KEYS = ["fecha recojo", "fecha de recojo", "fecha entrega", "recogido el"] as const;
const RETURN_KEYS = ["fecha devolucion", "fecha de devolucion", "fecha retorno"] as const;
const ATTEMPT_KEYS = ["intentos", "nro intentos", "n intentos", "visitas"] as const;
const COST_KEYS = ["costo", "flete", "importe", "monto", "costo envio", "precio"] as const;
const STORE_KEYS = ["tienda", "canal", "marca", "remitente"] as const;

/**
 * Traduce el texto de estado de la agencia a un sub-estado del catálogo
 * (lib/order-status.ts). Se compara por inclusión porque los reportes mezclan
 * frases completas ("DISPONIBLE PARA RECOJO EN AGENCIA HUANCAYO").
 */
const PICKUP_PATTERNS: [RegExp, string][] = [
  [/devuelt|retorn(o|ado) al origen|reingres/i, "retorno_iniciado"],
  [/retorno inici|en proceso de retorno|por devolver/i, "retorno_iniciado"],
  [/vencid|por vencer|proximo a vencer|prox\. a vencer/i, "proximo_a_vencer"],
  [/pendiente de recojo|no recogid|sin recoger/i, "pendiente_de_recojo"],
  [/notificad|avisad/i, "cliente_notificado"],
  [/disponible|listo para recojo|en agencia destino|para recojo/i, "disponible_para_recojo"],
  [/registrad|recepcionad|recibido en agencia|admitid/i, "registrado_en_agencia"],
  [/transito|en ruta|en viaje|despachad/i, "en_transito"],
  [/enviad|remitid|entregado a agencia/i, "enviado_a_agencia"],
];

const DELIVERED_RE = /recogid|entregad|retirad|conforme/i;
const CANCELLED_RE = /anulad|cancelad|rechazad/i;
const RETURNED_RE = /devuelt|retornado al origen|devolucion (realizada|confirmada)/i;

export interface AgencyStatus {
  delivery_status: string;
  pickup_state: string | null;
  returned: boolean;
}

/**
 * Clasifica el estado reportado. El orden importa: "entregado/recogido" gana
 * sobre todo lo demás (§3.3), y una devolución solo se marca cuando el reporte
 * dice explícitamente que el paquete volvió — el Master todavía exigirá después
 * que conste el despacho y la guía antes de contarla como devolución.
 */
export function classifyAgencyStatus(raw: string | null): AgencyStatus {
  // Se compara sin acentos: los reportes escriben indistintamente "tránsito" y
  // "transito", "próximo" y "proximo".
  const text = stripAccents((raw ?? "").trim());
  if (!text) return { delivery_status: "pendiente", pickup_state: null, returned: false };

  if (DELIVERED_RE.test(text) && !RETURNED_RE.test(text)) {
    return { delivery_status: "entregado", pickup_state: "recogido", returned: false };
  }
  if (CANCELLED_RE.test(text)) {
    return { delivery_status: "anulado", pickup_state: null, returned: false };
  }

  const pickup = PICKUP_PATTERNS.find(([re]) => re.test(text))?.[1] ?? null;
  const returned = RETURNED_RE.test(text);
  // Mientras el paquete está en la agencia la guía sigue viva: "en ruta" cuando
  // viaja, "pendiente" cuando espera al cliente o al retorno.
  const delivery_status = pickup === "en_transito" ? "en_ruta" : "pendiente";
  return { delivery_status, pickup_state: pickup, returned };
}

function toCanonical(raw: Record<string, string>): CanonicalReportRow {
  const map = buildLookup(raw);
  const reported = pick(map, STATUS_KEYS);
  const status = classifyAgencyStatus(reported);
  const returnedAt = parseDate(pick(map, RETURN_KEYS));
  const pickedAt = parseDate(pick(map, PICKED_KEYS));

  return {
    ...emptyReportRow(raw),
    guide_code: pick(map, GUIDE_KEYS),
    order_name: normalizeOrderRef(pick(map, ORDER_KEYS)),
    // El nº de pedido viene en su propia columna, así que es un dato afirmado
    // por el courier y no una conjetura sacada de un texto libre.
    order_name_confirmed: Boolean(pick(map, ORDER_KEYS)),
    customer_name: pick(map, NAME_KEYS),
    customer_phone: normalizePhone(pick(map, PHONE_KEYS)),
    product: pick(map, PRODUCT_KEYS),
    district: pick(map, DISTRICT_KEYS),
    province: pick(map, PROVINCE_KEYS),
    region: pick(map, REGION_KEYS),
    delivery_status: status.delivery_status,
    reported_status: reported,
    pickup_state: status.pickup_state,
    attempts: parseCount(pick(map, ATTEMPT_KEYS)),
    non_delivery_reason: pick(map, REASON_KEYS),
    dispatched_at: parseDate(pick(map, SENT_KEYS)),
    closed_at: status.delivery_status === "entregado" ? pickedAt : null,
    // Una devolución de agencia siempre lleva fecha; si el estado la anuncia
    // pero el reporte no la trae, no se inventa (el Master la dejará como
    // "en proceso de retorno" en vez de cerrarla como devuelta).
    returned_at: status.returned ? returnedAt : null,
    agency_branch: pick(map, BRANCH_KEYS),
    agency_arrived_at: parseDate(pick(map, ARRIVED_KEYS)),
    agency_expires_at: parseDate(pick(map, EXPIRES_KEYS)),
    cost: parseNumber(pick(map, COST_KEYS)),
    store_hint: pick(map, STORE_KEYS),
  };
}

const ORDER_TOKEN_RE = /#?\s*((?:KP|AUR)[A-Za-z0-9-]+)/i;

/** Normaliza el nº de pedido a "#KP114985", como hace lib/aliclik-import. */
function normalizeOrderRef(value: string | null): string | null {
  if (!value) return null;
  const m = ORDER_TOKEN_RE.exec(value);
  if (m?.[1]) return `#${m[1].toUpperCase()}`;
  const digits = /^\s*#?\s*(\d{4,})\s*$/.exec(value);
  return digits?.[1] ? `#${digits[1]}` : null;
}

/** Construye el adaptador de una agencia concreta. */
export function makeAgencyAdapter(id: string, label: string, hint: RegExp): CourierAdapter {
  return {
    id,
    label,
    agency: true,
    parse: (rows) => rows.map(toCanonical).filter((r) => r.guide_code || r.order_name),
    score: (rows) => {
      const sample = rows.slice(0, 20);
      // Se reconoce por dos señales: que el nombre de la agencia aparezca en
      // alguna celda, y que el reporte hable de agencia/recojo.
      const named = sample.filter((r) =>
        Object.values(r).some((v) => hint.test(String(v ?? ""))),
      ).length;
      const agencyShaped = sample.filter((r) => {
        const map = buildLookup(r);
        return Boolean(pick(map, BRANCH_KEYS) || pick(map, EXPIRES_KEYS));
      }).length;
      return named * 2 + agencyShaped;
    },
  };
}

export const shalomAdapter = makeAgencyAdapter("shalom", "Shalom", /shalom/i);
export const olvaAdapter = makeAgencyAdapter("olva", "Olva", /olva/i);
