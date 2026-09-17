// Liquidaciones 2 — plantillas de dominios, hojas y columnas. Es lo que se
// siembra en una organización la primera vez que entra alguien con
// `sheets.manage`; después la base manda y esto solo sirve para crear hojas
// nuevas de un dominio o para las pruebas.
//
// Los seis dominios salen del Excel «MASTER KEY 2.0» (docs/plan/liquidaciones-2.md):
//   pedidos          lo que Shopify manda, vía Kapta. Solo lectura.
//   catalogos        valores que la operación decide (zona por distrito).
//   reparto_propio   una fila por punto de ruta de un motorizado.
//   courier_externo  una fila por guía de un courier.
//   consolidado      una fila por pedido con lo que aportan los demás.
//   indicadores      solo lectura, calculado sobre el consolidado.
//
// En la iteración 1 se instancian Pedidos y Consolidado por tienda y el
// Catálogo de zonas. Reparto propio y Courier externo llevan su plantilla de
// columnas y de estados desde ya —es el contrato— pero sin hojas.

import {
  CONSOLIDADO_STATUSES,
  COURIER_EXTERNO_STATUSES,
  REPARTO_PROPIO_STATUSES,
  type StatusTemplate,
} from "./statuses";
import { ZONAS } from "./resolver";
import type { ColumnDataType, ColumnKind, ColumnSource, SheetRowKey } from "./types";

export interface ColumnTemplate {
  key: string;
  label: string;
  kind: ColumnKind;
  data_type?: ColumnDataType;
  source?: ColumnSource;
  options?: readonly string[];
  width?: number;
  pinned?: boolean;
  required?: boolean;
  visible?: boolean;
}

export interface DomainTemplate {
  key: string;
  name: string;
  row_key: SheetRowKey;
  description: string;
  statuses: readonly StatusTemplate[];
  columns: readonly ColumnTemplate[];
  /** Si las hojas del dominio se crean una por tienda. */
  perStore: boolean;
}

const campo = (key: string, label: string, field: string, extra: Partial<ColumnTemplate> = {}): ColumnTemplate => ({
  key,
  label,
  kind: "campo",
  data_type: "text",
  source: { field },
  ...extra,
});
const derivada = (key: string, label: string, rule: string, extra: Partial<ColumnTemplate> = {}): ColumnTemplate => ({
  key,
  label,
  kind: "derivada",
  data_type: "text",
  source: { rule },
  ...extra,
});
const manual = (key: string, label: string, extra: Partial<ColumnTemplate> = {}): ColumnTemplate => ({
  key,
  label,
  kind: "manual",
  data_type: "text",
  source: {},
  ...extra,
});

/** Tiendas que puede declarar una fila de reparto. «Kast» son puntos ajenos a
 *  Shopify que los motorizados llevan en la misma ruta. */
export const REPARTO_STORES = ["Aurela", "Kenku", "Kast", "Otra"] as const;

/** Métodos de pago, lista cerrada. Sale del vocabulario de jul-sep 2026. */
export const REPARTO_PAYMENT_METHODS = [
  "Efectivo",
  "Yape Grupo GF",
  "Yape/Plin Frankz",
  "Yape/Plin Gabriela",
  "Izipay",
  "Link de pago",
  "Transferencia",
  "Pagado antes",
  "Sin cobro",
] as const;

/** Lo que escriben → método. Normalizado con normalizeAlias. Lo que no está
 *  aquí ni en la lista se guarda literal en `metodo_pago_reportado`. */
export const REPARTO_PAYMENT_ALIASES: Record<string, (typeof REPARTO_PAYMENT_METHODS)[number]> = {
  "EFECTIVO": "Efectivo",
  "CASH": "Efectivo",
  "YAPE GF": "Yape Grupo GF",
  "YAPEGF": "Yape Grupo GF",
  "YAPE G F": "Yape Grupo GF",
  "YAPEW GF": "Yape Grupo GF",
  "YAPE GRUPO GF": "Yape Grupo GF",
  "YAPE GRUPO GF SAC": "Yape Grupo GF",
  "BCP GRUPO GF SAC": "Transferencia",
  "PLIN FRANKZ KASTNER": "Yape/Plin Frankz",
  "YAPE FRANKZ KASTNER": "Yape/Plin Frankz",
  "PLIN FK": "Yape/Plin Frankz",
  "YAPE FK": "Yape/Plin Frankz",
  "INTERBANK FRANKZ KASTNER": "Transferencia",
  "YAPE GABRIELA REANO": "Yape/Plin Gabriela",
  "PLIN GABRIELA REANO": "Yape/Plin Gabriela",
  "YAPE GABY": "Yape/Plin Gabriela",
  "PLIN GABY": "Yape/Plin Gabriela",
  "YPE GF": "Yape Grupo GF",
  "YAE GF": "Yape Grupo GF",
  "YAPE.GF": "Yape Grupo GF",
  "YAPE GFF": "Yape Grupo GF",
  "BCP GF": "Transferencia",
  "BCP": "Transferencia",
  "IBK FK": "Transferencia",
  "BBVA FK": "Transferencia",
  "SCOTIA FK": "Transferencia",
  "IZIPAY": "Izipay",
  "IZIPZAY": "Izipay",
  "POS": "Izipay",
  "LINK": "Link de pago",
  "LINK PAGO": "Link de pago",
  "LINK DE PAGO": "Link de pago",
  // «Vende Más» es una app de cobro por link, según la operación (16-09-2026).
  "VENDE MAS": "Link de pago",
  "VENDEMAS": "Link de pago",
  "PAGADO": "Pagado antes",
  "YA PAGO": "Pagado antes",
  // «OK» en el cuaderno: cruce del 16-09-2026, 91 de 106 pedidos vinculados
  // estaban `paid` en Shopify por checkout (tarjeta, transferencia, cuotas).
  "OK": "Pagado antes",
  "PAGADO SHOPIFY": "Pagado antes",
  "SIN COBRO": "Sin cobro",
  "SOLO ENTREGAR": "Sin cobro",
};

/**
 * Columnas del CUADERNO de ruta: una fila por punto, con fecha, tienda,
 * cliente, pedido, estado, lo cobrado y cómo. Las usan las hojas de Reparto
 * propio y también las de Courier externo que llevan cuaderno (Alexis, Urpi):
 * mismo formato de bloques por fecha, mismo lector (lib/sheets/reparto-import).
 */
export const CUADERNO_COLUMNS: readonly ColumnTemplate[] = [
  manual("fecha", "Fecha", { data_type: "date", required: true, pinned: true, width: 110 }),
  manual("punto", "Punto", { width: 80 }),
  manual("tienda", "Tienda", { data_type: "select", options: REPARTO_STORES, width: 90 }),
  manual("cliente", "Nombre del cliente", { width: 200 }),
  manual("pedido", "# Pedido", { required: true, width: 120 }),
  derivada("vinculado", "En Kapta", "vinculado", { data_type: "boolean", width: 80 }),
  manual("estado", "Estado", { data_type: "status", width: 150 }),
  manual("estado_reportado", "Estado escrito", { width: 150, visible: false }),
  manual("reprogramar_para", "Reprogramar para", { data_type: "date", width: 120 }),
  manual("efectivo", "Efectivo", { data_type: "number", width: 90 }),
  manual("a_cobrar", "A cobrar", { data_type: "number", width: 90 }),
  manual("metodo_pago", "Método de pago", { data_type: "select", options: REPARTO_PAYMENT_METHODS, width: 140 }),
  manual("metodo_pago_reportado", "Método escrito", { width: 150, visible: false }),
  manual("observacion_1", "Observación 1", { width: 180 }),
  manual("observacion_2", "Observación 2", { width: 180 }),
  manual("revision", "Revisión", { width: 200 }),
];

/**
 * Couriers externos que reportan con cuaderno de puntos, no con reporte por
 * guía (decisión del 16-09-2026: Alexis y Urpi son couriers, no motorizados
 * propios, aunque el Excel les diera hoja de puntos). Liquidan como courier.
 */
export const COURIER_CUADERNO_SHEETS = [
  { name: "Alexis", courier: "alexis" },
  { name: "Urpi", courier: "urpi" },
] as const;

/** ¿La hoja se lee y se pinta como cuaderno de puntos? Reparto propio siempre;
 *  Courier externo solo si su config lo declara. */
export function isCuadernoSheet(
  sheet: { config?: Record<string, unknown> | null } | null | undefined,
  domain: { row_key: SheetRowKey } | null | undefined,
): boolean {
  if (!domain) return false;
  if (domain.row_key === "punto") return true;
  return (sheet?.config as { layout?: unknown } | null | undefined)?.layout === "cuaderno";
}

/** Columnas comunes a toda hoja con clave «pedido»: el pedido y su ficha. */
const PEDIDO_BASE: readonly ColumnTemplate[] = [
  campo("pedido", "# Pedido", "order_name", { pinned: true, width: 120 }),
  campo("cliente", "Cliente", "customer_name", { width: 200 }),
  campo("distrito", "Distrito", "district", { width: 140 }),
  campo("region", "Región", "region", { width: 120 }),
  derivada("fecha", "Fecha", "fecha_lima", { data_type: "date", width: 110 }),
  derivada("mes", "Mes", "mes", { width: 80 }),
  campo("monto", "Monto", "order_total", { data_type: "number", width: 90 }),
];

export const DOMAIN_TEMPLATES: readonly DomainTemplate[] = [
  {
    key: "pedidos",
    name: "Pedidos",
    row_key: "pedido",
    description: "Lo que Shopify manda a Kapta. Solo lectura: es la fuente, no se corrige aquí.",
    statuses: [],
    perStore: true,
    columns: [
      ...PEDIDO_BASE,
      derivada("estado", "Estado Kapta", "estado_kapta", { data_type: "status", width: 110 }),
      campo("estado_operativo", "Estado operativo", "operational_status", { data_type: "status", width: 170 }),
      campo("courier_actual", "Courier actual", "current_courier", { width: 110 }),
      campo("courier_entrega", "Courier de entrega", "delivered_courier", { width: 120 }),
      campo("intentos", "Intentos", "attempt_count", { data_type: "number", width: 80 }),
      derivada("anulado", "Anulado", "anulado", { data_type: "boolean", width: 80 }),
      campo("motivo_anulacion", "Motivo de anulación", "cancel_reason", { width: 160 }),
      campo("guia", "Guía", "guide_code", { width: 130 }),
      campo("celular", "Celular", "customer_phone", { width: 120, visible: false }),
    ],
  },
  {
    key: "catalogos",
    name: "Catálogos",
    row_key: "valor",
    description: "Valores que la operación decide y las demás hojas consultan.",
    statuses: [],
    perStore: false,
    columns: [],
  },
  {
    key: "reparto_propio",
    name: "Reparto propio",
    row_key: "punto",
    description:
      "Una fila por punto de ruta de un motorizado: tienda, cliente, pedido, estado, lo cobrado y cómo. Aporta E/T/D al Consolidado.",
    statuses: REPARTO_PROPIO_STATUSES,
    perStore: false,
    columns: CUADERNO_COLUMNS,
  },
  {
    key: "courier_externo",
    name: "Courier externo",
    row_key: "guia",
    description:
      "Una fila por guía de un courier, con el estado que reporta y su equivalente en Kapta. Aporta E/T/D al Consolidado.",
    statuses: COURIER_EXTERNO_STATUSES,
    perStore: false,
    columns: [
      manual("guia", "Guía", { required: true, pinned: true, width: 140 }),
      manual("pedido", "# Pedido", { width: 120 }),
      manual("cliente", "Cliente", { width: 200 }),
      manual("distrito", "Distrito", { width: 140 }),
      manual("estado_reportado", "Estado reportado", { width: 200 }),
      manual("estado", "Estado", { data_type: "status", width: 150 }),
      manual("monto_reportado", "Monto reportado", { data_type: "number", width: 110 }),
      manual("comision", "Comisión", { data_type: "number", width: 90 }),
      manual("fecha", "Fecha", { data_type: "date", width: 110 }),
    ],
  },
  {
    key: "consolidado",
    name: "Consolidado",
    row_key: "pedido",
    description:
      "Una fila por pedido con la zona, lo que aportó cada hoja y el estatus resuelto. Es la hoja «Revisar» del Excel.",
    statuses: CONSOLIDADO_STATUSES,
    perStore: true,
    columns: [
      ...PEDIDO_BASE,
      derivada("zona", "Zona", "zona", { width: 130 }),
      derivada("estatus", "Estatus", "estatus_consolidado", { data_type: "status", pinned: false, width: 110 }),
      derivada("entregado_por", "Entregado por", "estatus_por", { width: 150 }),
      derivada("aportes", "Aportes", "aportes", { width: 220 }),
      derivada("intentos_lima", "# Motos Lima", "intentos_lima", { data_type: "number", width: 100 }),
      derivada("estado_kapta", "Estado Kapta", "estado_kapta", { data_type: "status", width: 110 }),
      derivada("diferencia", "Diferencia", "diferencia_estatus", { width: 120 }),
      campo("motivo_anulacion", "Motivo de anulación", "cancel_reason", { width: 160 }),
      manual("comentario", "Comentario", { width: 220 }),
    ],
  },
  {
    key: "indicadores",
    name: "Indicadores",
    row_key: "periodo",
    description: "Tasas por zona y día, efectividad por motorizado, ventas contra meta. Solo lectura.",
    statuses: [],
    perStore: false,
    columns: [],
  },
];

export function domainTemplate(key: string): DomainTemplate | null {
  return DOMAIN_TEMPLATES.find((d) => d.key === key) ?? null;
}

/** Hojas que se crean al inicializar una organización, además de las por tienda. */
export interface SheetTemplate {
  key: string;
  name: string;
  domain: string;
  columns: readonly ColumnTemplate[];
}

export const CATALOGO_ZONAS_KEY = "catalogo_zonas";

export const FIXED_SHEETS: readonly SheetTemplate[] = [
  {
    key: CATALOGO_ZONAS_KEY,
    name: "Zonas por distrito",
    domain: "catalogos",
    columns: [
      manual("distrito", "Distrito", { required: true, pinned: true, width: 200 }),
      manual("region", "Región", { width: 160 }),
      manual("zona", "Zona", { data_type: "select", options: ZONAS, required: true, width: 150 }),
    ],
  },
];

/** `Kenku Peru` → `kenku_peru`: clave estable de hoja por tienda. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function perStoreSheetKey(domainKey: string, storeName: string): string {
  return `${domainKey}_${slugify(storeName)}`;
}
