// Formas de la API de Shalom (api.shalom-api-peru.com).
//
// A diferencia de Tanders, esta API SÍ está documentada, así que los tipos son
// transcripción del contrato y no ingeniería inversa. Lo que sigue siendo
// defensivo es la lectura: es un wrapper sobre pro.shalom.pe, y el propio
// proveedor avisa de campos que Shalom dejó de mandar (los bloques `origen`,
// `destino`, `remitente`, `destinatario` y `comprobante` del rastreo llegan en
// cero desde julio de 2026). Nada se construye sobre esos campos.
//
// OJO — esto NO reemplaza a lib/couriers/agency.ts. Ese adaptador parsea los
// reportes Excel de Shalom que ENTRAN al sistema; esto crea guías que SALEN.
// Ambos escriben en `shipments` con courier='shalom' y se encuentran ahí.

/** Dos niveles de auth: la API key siempre, las credenciales del cliente además. */
export const SHALOM_API_BASE = "https://api.shalom-api-peru.com";

/**
 * Tipo de contenido declarado. Shalom lo exige en toda orden y la API acepta 4
 * alias cortos además de los textos literales que imprime en la guía. Se manda
 * el alias: es lo que el proveedor documenta como estable.
 */
export const DECLARACIONES_JURADAS = [
  { value: "docs", label: "Documentos" },
  { value: "ropa", label: "Ropa" },
  { value: "art", label: "Artículos de uso personal" },
  { value: "electro", label: "Electrodomésticos" },
] as const;

export type DeclaracionJurada = (typeof DECLARACIONES_JURADAS)[number]["value"];

/** Quién paga el flete: el remitente al despachar, o el destinatario al recoger. */
export type ShalomPayer = "sender" | "receiver";

export type ShalomDocumentType = "DNI" | "RUC" | "CE";

/** Destinatario de `POST /v1/orders`. El remitente NO va: sale de la cuenta. */
export interface ShalomReceiver {
  /** person_id de Shalom Pro, si ya se conoce (evita la búsqueda). */
  id?: number;
  document_type: ShalomDocumentType;
  document: string;
  /** Nombre de la persona, o razón social completa si es RUC. */
  name?: string;
  /** Obligatorio para DNI/CE cuando la persona aún no existe. No aplica a RUC. */
  last_name?: string;
  sur_name?: string;
  /** Numérico y sin código de país: 999888777. */
  phone?: number;
  email?: string;
  address?: string;
}

/** Medidas de "Otra Medida". Peso en kg, el resto en metros. */
export interface ShalomDimensions {
  weight_kg: number;
  height_m: number;
  length_m: number;
  width_m: number;
}

/** Cuerpo de `POST /v1/orders`. */
export interface ShalomOrderPayload {
  origin_terminal_id: number;
  destiny_terminal_id: number;
  product_id: number;
  quantity: number;
  payer: ShalomPayer;
  declaracion_jurada: DeclaracionJurada;
  receiver: ShalomReceiver;
  /** 4 dígitos, ni repetidos ni consecutivos. La elegimos nosotros. */
  pickup_code: string;
  dimensions?: ShalomDimensions;
  aereo?: boolean;
}

/**
 * Respuesta de `POST /v1/orders`. Los cuatro identificadores no son
 * intercambiables — ver la tabla "Identificadores" de la documentación:
 *   guia   → rastrear (`numero`)          codigo → rastrear
 *   ose_id → etiqueta, comprobante, GRT   id     → borrar (sale de GET /v1/orders)
 */
export interface ShalomOrderResult {
  guia: string;
  serie?: string | null;
  codigo?: string | null;
  ose_id?: number | null;
}

/** Agencia de `GET /v1/agencies` y `/v1/agencies/search`. */
export interface ShalomAgency {
  id: number;
  nombre: string;
  departamento?: string | null;
  provincia?: string | null;
  distrito?: string | null;
  direccion?: string | null;
  aereo?: boolean | null;
  latitud?: number | null;
  longitud?: number | null;
  [k: string]: unknown;
}

/** Producto de `GET /v1/products` — el catálogo de cajas de la cuenta. */
export interface ShalomProduct {
  id: number;
  title: string;
  content?: string | null;
  sub_content?: string | null;
  img?: string | null;
  measurements?: {
    weight?: number | null;
    width?: number | null;
    height?: number | null;
    length?: number | null;
  } | null;
}

/** Persona resuelta por `GET /v1/persons/search`. */
export interface ShalomPerson {
  id: number;
  document_type: string;
  document: string;
  name: string | null;
  last_name: string | null;
  sur_name: string | null;
  full_name: string | null;
  phone: number | null;
  email: string | null;
  address: string | null;
}

/** Cotización de `POST /v1/tariff/calculate`. */
export interface ShalomTariff {
  currency: string;
  breakdown: Record<string, number>;
  product?: { id: number; title: string; price: number } | null;
}

/** Token efímero de `POST /v1/shalom/sessions`: `ssk_<64-hex>`, TTL 2 horas. */
export interface ShalomSession {
  session_token: string;
  /** ISO-8601 tal como lo manda la API. */
  expires_at: string;
}

/**
 * Orden de la cuenta, de `GET /v1/orders`. Se declara solo lo que se usa para
 * la recuperación tras un timeout; el resto viaja en el índice de firma.
 */
export interface ShalomAccountOrder {
  id: number;
  guia?: string | null;
  serie?: string | null;
  codigo?: string | null;
  pickup_code?: string | null;
  created_at?: string | null;
  receiver?: { document?: string | null; full_name?: string | null } | null;
  [k: string]: unknown;
}

/**
 * Error de la API con el status HTTP y el `code` del envelope, para poder
 * distinguir un `shalom_auth_failed` (credenciales del cliente) de un
 * `unauthorized` (nuestra API key) sin leer el mensaje.
 */
export class ShalomApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ShalomApiError";
  }

  /** ¿El fallo es de las credenciales de Shalom Pro y no de la API key? */
  get isShalomAuth(): boolean {
    return this.code === "shalom_auth_failed";
  }
}

/**
 * La llamada se cortó sin saber si la orden se creó. Es su propia clase porque
 * el tratamiento es distinto a cualquier otro error: NO se reintenta, se va a
 * buscar la guía a `GET /v1/orders`.
 */
export class ShalomTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShalomTimeoutError";
  }
}
