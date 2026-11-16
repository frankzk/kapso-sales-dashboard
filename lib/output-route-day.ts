// La fecha de la ruta de cada salida, para «Salidas y guías» de la ficha (owner,
// 16-11-2026: «en esta data falta la fecha de la ruta»). Puro.
//
// De lo más cierto a lo menos:
//  1. Grupo GF: el día de la ruta del motorizado (su parada o su caja).
//  2. Aliclik: la fecha operativa que reporta (`aliclik_service_date`).
//  3. Cualquier courier: el día en que salió (`dispatched_at`, día de Lima).
//  4. Sin salida todavía: el día en que se creó la guía, dicho como tal.
import { limaDay, programDayLabel } from "@/lib/dispatch-day";

export interface OutputRouteDayInput {
  aliclik_service_date?: string | null;
  dispatched_at?: string | null;
  created_at?: string | null;
}

export interface OutputRouteDay {
  day: string;
  /** «Ruta del lun 16/11», «Salió el vie 13/11» o «Creada el jue 12/11 · sin ruta todavía». */
  text: string;
}

export function outputRouteDay(guide: OutputRouteDayInput, gf?: { box: { routeDate: string } | null; stop: { routeDate: string | null } | null } | null): OutputRouteDay | null {
  const route = gf?.stop?.routeDate ?? gf?.box?.routeDate ?? null;
  if (route) return { day: route.slice(0, 10), text: `Ruta del ${programDayLabel(route.slice(0, 10))}` };
  const service = guide.aliclik_service_date?.slice(0, 10);
  if (service) return { day: service, text: `Ruta del ${programDayLabel(service)}` };
  const out = limaDay(guide.dispatched_at);
  if (out) return { day: out, text: `Salió el ${programDayLabel(out)}` };
  const created = limaDay(guide.created_at);
  if (created) return { day: created, text: `Creada el ${programDayLabel(created)} · sin ruta todavía` };
  return null;
}
