// Cuánto lleva un pedido creado, en días de Lima (owner, 20-11-2026: «no veo en
// el drawer de los de provincia la fecha de la creación del pedido, para saber
// si es un pedido al menos medio reciente»). Puro: lo usa el cajón de Envíos.

import { limaDayKey } from "@/lib/order-confirmation";

const dayNumber = (key: string): number | null => {
  const [y, m, d] = key.split("-").map(Number);
  return y && m && d ? Date.UTC(y, m - 1, d) / 86_400_000 : null;
};

/** Días de Lima entre la creación y `now`: 0 hoy, 1 ayer. Sin fecha válida, null. */
export function orderAgeDays(createdAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!createdAt) return null;
  const from = dayNumber(limaDayKey(createdAt));
  const to = dayNumber(limaDayKey(now.toISOString()));
  if (from === null || to === null) return null;
  return Math.max(0, to - from);
}

/** «hoy», «ayer», «hace 6 días». */
export function orderAgeText(days: number): string {
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  return `hace ${days.toLocaleString("es-PE")} días`;
}

/** «13/11/26, 10:12 a. m.» en hora de Lima: el mismo formato que «creado el …» de la ficha del Master. */
export function orderCreatedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  return d.toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
