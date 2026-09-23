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

/** Una versión de `rider_pay_rates` (0162): general (sin distrito) o de un distrito. */
export interface RiderRateVersion {
  district_key: string | null;
  amount: number;
  effective_from: string;
  created_at: string;
}

/**
 * La tarifa personal vigente de un motorizado en un distrito y día, con la
 * misma precedencia que `rider_pay_preview` (0162): la del distrito gana a la
 * general; entre iguales, la de vigencia más reciente y, a igualdad, la última
 * registrada. Null si no hay ninguna vigente.
 */
export function resolveRiderRate(
  rates: readonly RiderRateVersion[],
  districtKey: string,
  day: string,
): { amount: number; source: "distrito" | "general"; effectiveFrom: string } | null {
  let best: RiderRateVersion | null = null;
  const rank = (r: RiderRateVersion) => `${r.district_key ? 1 : 0}|${r.effective_from}|${r.created_at}`;
  for (const r of rates) {
    if (r.effective_from > day) continue;
    if (r.district_key && r.district_key !== districtKey) continue;
    if (!best || rank(r) > rank(best)) best = r;
  }
  return best ? { amount: Number(best.amount), source: best.district_key ? "distrito" : "general", effectiveFrom: best.effective_from } : null;
}
