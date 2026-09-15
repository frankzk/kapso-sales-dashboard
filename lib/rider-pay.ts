export interface RiderPayRow {
  stop_id: string; order_id: string; store_id: string | null; seq: number;
  order_name: string | null; district: string | null; status: string;
  outcome_reason: string | null; payment_method: string | null; collected_amount: number | null;
  rate_id: string | null; effective_from: string | null; configured_rate: number | null;
  base: number | null; extra: number;
}
export interface RiderPayAdjustment {
  id: string; stop_id: string; amount: number; reason: string;
  approved_by: string; approved_label: string; approved_at: string; reverses_id: string | null;
}
export interface RiderPaySnapshot {
  route_id: string; rider_id: string; rider_name: string; day: string; route_status: string;
  rows: RiderPayRow[]; adjustments: RiderPayAdjustment[];
  cash: number; direct: number; base: number; extra: number; earned: number;
  net_cash: number | null; missing: number; pending: number; evidence_missing: number; conflicts: number;
}
export interface RiderPayRate {
  id: string; district_key: string | null; amount: number; effective_from: string; reason: string;
}
export interface RiderPayDetail {
  snapshot: RiderPaySnapshot;
  approved: { at: string; by: string } | null;
  rates: RiderPayRate[];
  districts: { district_key: string; name: string }[];
  canConfigure: boolean;
  canApprove: boolean;
}
export function riderPayBlockers(s: RiderPaySnapshot): string[] {
  return [
    s.route_status !== "cerrada" ? "Termina la ruta operativa antes de aprobar el cálculo." : "",
    !s.rows.length ? "La ruta no tiene puntos." : "",
    s.missing ? `${s.missing} punto(s) sin tarifa personal vigente.` : "",
    s.pending ? `${s.pending} punto(s) sin reportar.` : "",
    s.evidence_missing ? `${s.evidence_missing} punto(s) sin evidencia completa.` : "",
    s.conflicts ? `${s.conflicts} reporte(s) con medio e importe incompatibles.` : "",
  ].filter(Boolean);
}
