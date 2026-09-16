// Liquidaciones 2 — tipos compartidos entre la base (0168), el motor de
// columnas y la pantalla. Léelo junto con docs/plan/liquidaciones-2.md y el
// MOM §30.

/** Qué identifica una fila dentro de las hojas de un dominio. */
export type SheetRowKey = "pedido" | "guia" | "punto" | "valor" | "periodo";

/** Efecto de un estado del dominio sobre el pedido (MOM §30.3). */
export type StatusEffect = "informa" | "entrega" | "devolucion" | "anulacion";

export type ColumnKind = "campo" | "manual" | "lookup" | "derivada";
export type ColumnDataType = "text" | "number" | "date" | "select" | "boolean" | "status";

/** Marca que una hoja aporta al Consolidado por pedido: E entregado, T en
 *  tránsito (hubo intento o está en curso), D devuelto, 0 nada. Es el mismo
 *  alfabeto que usaba la hoja «Revisar» del Excel, a propósito: la gente ya lo
 *  lee de corrido. */
export type ContributionMark = "E" | "T" | "D" | "0";

export interface DomainRow {
  id: string;
  org_id: string;
  key: string;
  name: string;
  row_key: SheetRowKey;
  description: string | null;
  position: number;
}

export interface DomainStatusRow {
  id: string;
  domain_id: string;
  code: string;
  label: string;
  operational_status: string;
  effect: StatusEffect;
  position: number;
  active: boolean;
}

export interface SheetRow {
  id: string;
  org_id: string;
  domain_id: string;
  store_id: string | null;
  key: string;
  name: string;
  position: number;
  active: boolean;
  config: Record<string, unknown>;
}

/** Fuente de una columna, según su tipo. */
export type ColumnSource =
  | { field: string } // campo
  | { sheet: string; match: string; by: string; return: string } // lookup
  | { rule: string } // derivada
  | Record<string, never>; // manual

export interface SheetColumnRow {
  id: string;
  sheet_id: string;
  key: string;
  label: string;
  kind: ColumnKind;
  data_type: ColumnDataType;
  source: ColumnSource;
  options: string[];
  position: number;
  width: number | null;
  visible: boolean;
  pinned: boolean;
  required: boolean;
  from_template: boolean;
}

export type CellValue = string | number | boolean | null;

export interface StoredRow {
  id: string;
  sheet_id: string;
  order_id: string | null;
  row_key: string;
  values: Record<string, CellValue>;
  source: "manual" | "importacion" | "sincronizacion";
  updated_at?: string;
}

export interface StatusAliasRow {
  id: string;
  sheet_id: string;
  alias: string;
  status_code: string | null;
  seen_count: number;
}

export interface ObservationRow {
  id: string;
  org_id: string;
  sheet_id: string;
  row_id: string | null;
  order_id: string | null;
  field: string;
  external_value: string | null;
  kapta_value: string | null;
  difference: number | null;
  reason_code: string | null;
  note: string | null;
  status: "abierta" | "resuelta";
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface ObservationReason {
  code: string;
  label: string;
  description: string | null;
  position: number;
}

/** Lo que el motor necesita saber de un pedido para llenar columnas `campo` y
 *  reglas `derivada`. Es un subconjunto de OrderMasterRow + orders. */
export interface OrderFacts {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
  coverage: string | null;
  shipping_mode: string | null;
  order_created_at: string | null;
  order_total: number | null;
  general_status: string;
  operational_status: string;
  current_courier: string | null;
  delivered_courier: string | null;
  attempt_count: number;
  delivered_at: string | null;
  returned_at: string | null;
  guide_code: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

/** Aporte de una hoja de Reparto propio o Courier externo a un pedido. */
export interface Contribution {
  /** Clave de la hoja que aporta (p. ej. `reparto_roy`). */
  sheet_key: string;
  mark: ContributionMark;
}

/** Una fila ya calculada, lista para pintar. */
export interface ComputedRow {
  row_key: string;
  order_id: string | null;
  stored_id: string | null;
  cells: Record<string, CellValue>;
}
