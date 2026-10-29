import { MASTER_PATH } from "@/lib/order-drawer-href";

/** Inclusive start and exclusive end, as calendar days in Lima. */
export interface AgencyPaymentWindow { from: string; to: string }

export function agencyPaymentWindow(from: string | null, to: string | null): AgencyPaymentWindow | null {
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString().slice(0, 10) !== from ||
      new Date(end).toISOString().slice(0, 10) !== to || end <= start || end - start > 32 * 86_400_000) return null;
  return { from, to };
}

export function agencyUnpaidHref(period: { startIso: string; endIso: string }): string {
  const qs = new URLSearchParams({ agency_unpaid: "1", apf: period.startIso.slice(0, 10), apt: period.endIso.slice(0, 10) });
  return `${MASTER_PATH}?${qs}`;
}

export function agencyPaymentWindowLabel(window: AgencyPaymentWindow): string {
  const format = (day: string) => day.split("-").reverse().join("/");
  const lastDay = new Date(Date.parse(`${window.to}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return `${format(window.from)} al ${format(lastDay)}`;
}
