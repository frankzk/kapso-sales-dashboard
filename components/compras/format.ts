// Formatos de la sección Compras (MOM §45). Puros: los usan el servidor y el
// navegador.

import { LIMA_TZ } from "@/lib/compras";

const N2 = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const N4 = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const INT = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 });
const DATE_TIME = new Intl.DateTimeFormat("es-PE", {
  timeZone: LIMA_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export const fmtUsd = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `US$ ${N2.format(n)}`);
/** Costo por unidad del proveedor: hasta 4 decimales. */
export const fmtUsdUnit = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `US$ ${N4.format(n)}`);
export const fmtPen = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `S/ ${N2.format(n)}`);
export const fmtInt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : INT.format(n));
export const fmtPct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(1)} %`);
export const fmtDateTime = (iso: string | null | undefined) => (iso ? DATE_TIME.format(new Date(iso)) : "—");

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
