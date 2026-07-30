// Traduce un envío del dashboard al payload de POST /v2/guias.
//
// Todo acá es PURO y testeable: el llamador (la server action) hace la llamada
// de red. Así el mapeo —que es donde están los errores caros, porque un campo
// mal puesto manda un paquete a otra dirección— se prueba sin tocar la API.
//
// Datos del remitente
// -------------------
// Swayp pide los datos de la bodega de origen en CADA guía, y no los tenemos en
// la base: son de Kenku, no de Swayp. Van en la env var SWAYP_SENDERS como un
// JSON de ciudad de cobertura → remitente, para poder activar producción sin
// tocar código:
//
//   SWAYP_SENDERS='{"arequipa":{"nombre":"Kenku","nit":"20600000000",
//     "direccion":"Av. Ejercito 123","telefono":"959000000","email":"ventas@kenku.pe"},
//     "cusco":{...}}'
//
// Una ciudad sin remitente configurado NO puede crear guías por API — el
// llamador cae al alta manual. Es deliberado: es preferible eso a inventar una
// dirección de recogida.

import { z } from "zod";
import { resolveUbigeo, warehouseUbigeo } from "@/lib/ubigeo";
import type { SwaypCreateGuideInput } from "@/lib/swayp";

/** Dimensiones por defecto. La base no guarda peso ni medidas por producto, y
 *  Swayp los exige; verificado que acepta estos valores. Ajustables por env sin
 *  redeploy si la tarifa lo amerita. */
export const DEFAULT_PACKAGE = { peso: "1", largo: "15", alto: "15", ancho: "15" } as const;

/** DNI del destinatario. `nitDestinatario` es obligatorio para Swayp pero no lo
 *  capturamos: verificado que acepta este placeholder. Si algún día Swayp exige
 *  un DNI real, esto es lo único que hay que cambiar (más capturarlo en la UI). */
export const PLACEHOLDER_NIT = "00000000";

const senderSchema = z.object({
  nombre: z.string().min(1),
  nit: z.string().min(1),
  direccion: z.string().min(5),
  telefono: z.string().min(1),
  /** Teléfono con el que el mensajero coordina la recogida; por defecto el mismo. */
  telefonoRecogida: z.string().min(1).optional(),
  email: z.string().min(3),
});

export type SwaypSender = z.infer<typeof senderSchema>;

const sendersSchema = z.record(z.string(), senderSchema);

/**
 * Parsea SWAYP_SENDERS. Devuelve {} ante JSON inválido en vez de lanzar: un
 * error de configuración no debe tumbar la página de envíos, sólo desactivar
 * la creación por API (que cae al alta manual).
 */
export function parseSenders(raw: string | undefined): Record<string, SwaypSender> {
  if (!raw?.trim()) return {};
  try {
    const parsed = sendersSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export interface BuildGuideInput {
  /** Ciudad de cobertura normalizada del envío (shipments.city). */
  city: string;
  /** Distrito del destino (shipments.district). */
  district: string | null | undefined;
  customerName: string | null | undefined;
  customerPhone: string | null | undefined;
  address1: string | null | undefined;
  /** Referencia / complemento (shipments.delivery_reference). */
  reference?: string | null;
  /** Líneas del pedido, para el campo `contenido`. */
  lineItems: Array<{ title: string; quantity: number }>;
  /** Monto a cobrar contra entrega. 0 si el envío no lleva recaudo. */
  codAmount: number;
  /** Fecha de despacho, ISO 8601. Opcional. */
  dispatchDateIso?: string | null;
  observaciones?: string | null;
  senders: Record<string, SwaypSender>;
}

export type BuildGuideResult =
  | { ok: true; input: SwaypCreateGuideInput }
  | { ok: false; error: string };

/** «2 x Cápsulas, 1 x Pulsera» — la nomenclatura que pide Swayp. */
export function buildContenido(lineItems: Array<{ title: string; quantity: number }>): string {
  return lineItems
    .filter((li) => li.title?.trim())
    .map((li) => `${Math.max(1, li.quantity || 1)} x ${li.title.trim()}`)
    .join(", ");
}

/**
 * Arma el payload de creación, o explica por qué no se puede.
 *
 * Cada validación de acá existe porque la API la rechaza (y una guía rechazada
 * a mitad del flujo es peor que no intentarla): las direcciones deben tener 5+
 * caracteres, el ubigeo del destino debe ser EXACTO —un fallback al cercado
 * mandaría el paquete al distrito equivocado sin avisar— y el origen tiene que
 * ser la bodega de la misma ciudad, porque Swayp sólo cubre pares intra-ciudad.
 */
export function buildSwaypGuideInput(b: BuildGuideInput): BuildGuideResult {
  const sender = b.senders[b.city];
  if (!sender) {
    return { ok: false, error: `No hay bodega Swayp configurada para ${b.city}.` };
  }

  const origen = warehouseUbigeo(b.city);
  if (!origen) return { ok: false, error: `${b.city} no es una ciudad con cobertura Swayp.` };

  const destino = resolveUbigeo(b.city, b.district);
  if (!destino) return { ok: false, error: `${b.city} no es una ciudad con cobertura Swayp.` };
  if (!destino.exact) {
    return {
      ok: false,
      error: `No se pudo identificar el distrito «${b.district ?? ""}» en ${b.city}; un ubigeo aproximado desviaría el paquete.`,
    };
  }

  const direccion = (b.address1 ?? "").trim();
  if (direccion.length < 5) {
    return { ok: false, error: "La dirección de entrega es muy corta (mínimo 5 caracteres)." };
  }

  const nombre = (b.customerName ?? "").trim();
  if (!nombre) return { ok: false, error: "El envío no tiene nombre del destinatario." };

  const telefono = (b.customerPhone ?? "").trim();
  if (!telefono) return { ok: false, error: "El envío no tiene teléfono del destinatario." };

  const contenido = buildContenido(b.lineItems);
  if (!contenido) return { ok: false, error: "El pedido no tiene productos para declarar." };

  const cod = Number.isFinite(b.codAmount) ? Math.max(0, b.codAmount) : 0;
  const valor = String(cod || 1); // valorDeclarado no puede ser 0

  return {
    ok: true,
    input: {
      nombreRemitente: sender.nombre,
      nitRemitente: sender.nit,
      direccionRemitente: sender.direccion,
      telefonoRemitente: sender.telefono,
      telefonoRecogida: sender.telefonoRecogida ?? sender.telefono,
      emailRemitente: sender.email,
      ciudadRemitente: origen,

      nombreDestinatario: nombre,
      nitDestinatario: PLACEHOLDER_NIT,
      direccionDestinatario: direccion,
      // Swayp PEGA adicionalDireccion al final de direccionDestinatario sin
      // separador — verificado sobre una guía real, que quedó como
      // "Calle Misti 100PRUEBA DE INTEGRACION". El separador va acá para que el
      // mensajero lea una dirección entendible.
      ...(b.reference?.trim() ? { adicionalDireccion: ` - ${b.reference.trim()}` } : {}),
      telefonoDestinatario: telefono,
      // No guardamos email del cliente; el del remitente asegura que las
      // notificaciones de Swayp lleguen a alguien que las lea.
      emailDestinatario: sender.email,
      ciudadDestinatario: destino.code,

      contenido,
      ...(b.observaciones?.trim() ? { observaciones: b.observaciones.trim() } : {}),
      ...(b.dispatchDateIso ? { fechaEntrega: b.dispatchDateIso } : {}),

      ...DEFAULT_PACKAGE,
      valorDeclarado: valor,
      valorRecaudo: String(cod),
    },
  };
}
