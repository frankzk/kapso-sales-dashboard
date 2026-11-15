// Formatos de la sección Compras (MOM §45). Puros: los usan el servidor y el
// navegador.

import { LIMA_TZ, type Currency } from "@/lib/compras";

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
/** Costo por unidad de una compra local (0343): hasta 4 decimales, en soles. */
export const fmtPenUnit = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `S/ ${N4.format(n)}`);
/** Un costo por unidad en su moneda: «US$ 2.0333» o «S/ 7.50». */
export const fmtUnit = (n: number | null | undefined, currency: Currency) => (currency === "PEN" ? fmtPenUnit(n) : fmtUsdUnit(n));
/** Un monto en su moneda (0342): «US$ 1,055.00» o «S/ 427.25». */
export const fmtMoney = (n: number | null | undefined, currency: Currency) => (currency === "PEN" ? fmtPen(n) : fmtUsd(n));
/** «US$ 800.00 + S/ 427.25»: dinero sin convertir, cada moneda por separado (sin la que está en 0). */
export const fmtSplit = (m: { usd: number; pen: number }) => {
  const parts = [m.usd !== 0 || m.pen === 0 ? fmtUsd(m.usd) : null, m.pen !== 0 ? fmtPen(m.pen) : null].filter(Boolean);
  return parts.join(" + ");
};
export const fmtInt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : INT.format(n));
export const fmtPct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(1)} %`);
/**
 * Fecha y hora de Lima. Los espacios raros que pone cada ICU alrededor de
 * «a. m.» (fino o duro, según Node o el navegador) pasan a un espacio normal:
 * si no, el texto del servidor y el del navegador no coinciden al hidratar.
 */
export const fmtDateTime = (iso: string | null | undefined) => (iso ? DATE_TIME.format(new Date(iso)).replace(/[\u00a0\u202f]/g, " ") : "—");

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
