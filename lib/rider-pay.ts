import { resolveLimaDistrict } from "@/lib/order-coverage";
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
  created_at?: string;
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

/** Clave de distrito de Lima como la resuelve la base (`resolve_lima_district`, con Chosica → Lurigancho). */
export function riderPayDistrictKey(raw: string | null | undefined): string | null {
  const key = resolveLimaDistrict(raw, { searchInText: true });
  return key === "lurigancho chosica" ? "lurigancho" : key;
}

export interface StopRateCheck {
  /** De dónde sale la tarifa que rige hoy para esa parada. */
  source: "distrito" | "general" | null;
  /** La que rige hoy con las tarifas registradas. */
  current: number | null;
  /** Aviso para quien revisa, o null si todo cuadra. */
  warning: string | null;
}

/**
 * ¿La tarifa de la parada es la que corresponde a su distrito? Avisa cuando
 * el distrito del pedido no se reconoce (se aplica la general sin decirlo) y
 * cuando el monto calculado —o el aprobado y congelado— ya no es el que rige
 * con las tarifas registradas (p. ej. se creó una tarifa del distrito después).
 */
export function checkStopRate(
  row: Pick<RiderPayRow, "district" | "configured_rate">,
  rates: readonly RiderPayRate[],
  day: string,
): StopRateCheck {
  const versions: RiderRateVersion[] = rates.map((r) => ({ district_key: r.district_key, amount: Number(r.amount), effective_from: r.effective_from, created_at: r.created_at ?? r.effective_from }));
  const key = riderPayDistrictKey(row.district);
  const resolved = key ? resolveRiderRate(versions, key, day) : resolveRiderRate(versions.filter((v) => !v.district_key), "", day);
  const current = resolved?.amount ?? null;
  const source = resolved?.source ?? null;
  const money = (n: number) => `S/ ${n.toFixed(2)}`;
  if (!key) {
    return { source, current, warning: `Distrito «${row.district ?? "sin distrito"}» no reconocido: se aplica la tarifa general.` };
  }
  if (current != null && row.configured_rate != null && Math.abs(current - Number(row.configured_rate)) > 0.004) {
    return { source, current, warning: `Con las tarifas de hoy sería ${money(current)} (${source === "distrito" ? "tarifa del distrito" : "general"}).` };
  }
  return { source, current, warning: null };
}
