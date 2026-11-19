import { compareDispatchCodes, dispatchedWithLabel } from "@/lib/dispatched-with";
import { courierLabel, limaHasDeparture, limaIsNew, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { agendaDayText, courierStatusText, LIMA_COURIER_CARDS, type LimaRowClass, type LimaStep } from "@/lib/repro-lima-blocks";
import { limaDay } from "@/lib/dispatch-day";

export interface LimaSituation { key: string; title: string; detail: string; count: number }

/** Dos motorizados propios son un courier. GF por API sí es otro proveedor. */
export function limaHistoricalProviders(row: Pick<LimaPendingOrder, "dispatchedWith">): string[] {
  return [...new Set((row.dispatchedWith ?? []).map((code) => code === "propio" || code === "gf" || code.startsWith("gf:") ? "gf" : code === "swayp" ? "fenix" : code))].sort();
}

export function limaNeedsReview(row: Pick<LimaPendingOrder, "dispatchedWith">): boolean {
  return limaHistoricalProviders(row).length > 1;
}

const CUSTODY: Record<string, string> = { empresa: "En la empresa", courier: "Con el courier", retorno: "En retorno", devuelto: "Devuelto a la empresa" };
const CALL_RESULT: Record<string, string> = { confirma: "Confirmó", confirmado: "Confirmó", llamar_despues: "Pidió otra llamada", no_contesta: "No contesta", no_quiere: "Ya no lo quiere", cancela: "Pidió cancelar", programar: "Pidió programar", sin_resultado: "Sin resultado" };

function signature(row: LimaPendingOrder, cls: LimaRowClass): unknown[] {
  return [
    limaHasDeparture(row) ? "left" : limaIsNew(row) ? "never" : "unknown", row.attempts,
    [...new Set(row.dispatchedWith ?? [])].sort(compareDispatchCodes), courierLabel(row.courier, row.courierDetail),
    cls.guide, cls.agendaDay, cls.agreed, cls.needsToday ?? false, cls.routeDay,
    row.ops?.custody ?? null, row.ops?.reportedStatus ?? null,
    row.management?.hasCall ?? null, row.management?.lastCallResult ?? null, cls.nextCallAt ?? null,
    cls.awaitingCancel, cls.retry, row.ops?.guides?.annulled ?? 0, row.ops?.guides?.returned ?? 0,
    row.ops?.guides?.total ?? 0, limaDay(row.lastDepartureAt ?? row.dispatchedAt), limaDay(row.management?.lastCallAt ?? null),
    row.gfAssigned?.rider ?? null, row.gfAssigned?.day ?? null, cls.courier,
  ];
}

export function limaSituationKey(row: LimaPendingOrder, cls: LimaRowClass): string {
  return `situation:${JSON.stringify(signature(row, cls))}`;
}

export function isLimaSituationKey(key: string | null): boolean {
  if (!key?.startsWith("situation:") || key.length > 6000) return false;
  // Los enlaces anteriores siguen siendo válidos y avisan si su situación cambió.
  try { const parts = JSON.parse(key.slice(10)); return Array.isArray(parts) && (parts.length === 23 || parts.length === 24); }
  catch { return false; }
}

export function limaSituation(row: LimaPendingOrder, cls: LimaRowClass, today: string): Omit<LimaSituation, "count"> {
  const left = limaHasDeparture(row);
  const known = left ? "Ya salió" : limaIsNew(row) ? "Nunca salió" : "Salida sin evidencia suficiente";
  const attempts = `${row.attempts} ${row.attempts === 1 ? "intento registrado" : "intentos registrados"}`;
  const guide = cls.guide ? "Con guía o rótulo vigente" : "Sin guía o rótulo vigente";
  const program = cls.needsToday ? "Provincia a Lima: gestionar hoy, sin fecha de despacho" : cls.agendaDay ? `${left || cls.agreed ? "Reprogramado" : "Programado"}: ${agendaDayText(cls.agendaDay, today)}` : "Sin día programado";
  const historical = [...new Set(row.dispatchedWith ?? [])].sort(compareDispatchCodes).map(dispatchedWithLabel);
  const history = historical.length ? `Salió con: ${historical.join(", ")}` : left ? "Courier histórico sin registrar" : "Sin courier de salida comprobado";
  const call = row.management ? row.management.hasCall ? `Con llamada registrada${row.management.lastCallResult ? ` (${CALL_RESULT[row.management.lastCallResult] ?? row.management.lastCallResult})` : ""}` : "Sin llamadas registradas" : "Historial de llamadas no disponible";
  const extra = [
    history, `Courier actual: ${courierLabel(row.courier, row.courierDetail)}`, `Custodia: ${CUSTODY[row.ops?.custody ?? ""] ?? "sin confirmar"}`, call,
    cls.courier ? `Recojo: ${LIMA_COURIER_CARDS.find((card) => card.key === cls.courier)!.label}` : null,
    row.ops?.reportedStatus ? `Reporte: ${courierStatusText(row.ops.reportedStatus) ?? row.ops.reportedStatus}` : null,
    cls.routeDay ? `Ruta: ${cls.routeDay}` : null,
    cls.nextCallAt ? `Próxima llamada: ${new Date(cls.nextCallAt).toLocaleString("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "short" })}` : null,
    row.management?.lastCallAt ? `Última llamada: ${limaDay(row.management.lastCallAt)}` : null,
    row.lastDepartureAt || row.dispatchedAt ? `Última evidencia de reparto: ${limaDay(row.lastDepartureAt ?? row.dispatchedAt)}` : null,
    row.gfAssigned ? `Asignado para la siguiente ruta: ${row.gfAssigned.rider}${row.gfAssigned.day ? ` (${row.gfAssigned.day})` : ""}` : null,
    row.ops?.guides?.total ? `${row.ops.guides.total} documento(s) en el historial` : null,
    cls.awaitingCancel ? "Espera anulación de la venta" : null,
    cls.retry ? "Reintento Aliclik por aprobar" : null,
    row.ops?.guides?.annulled ? `${row.ops.guides.annulled} documento(s) anulado(s)` : null,
    row.ops?.guides?.returned ? `${row.ops.guides.returned} documento(s) devuelto(s)` : null,
    limaNeedsReview(row) ? "Revisar posible cierre: salió con varios couriers" : null,
  ].filter(Boolean);
  return { key: limaSituationKey(row, cls), title: [known, attempts, guide, program].join(" · "), detail: extra.join(" · ") };
}

/** Una combinación por pedido: las filas son una partición completa del bloque. */
export function limaSituations(rows: readonly LimaPendingOrder[], classes: ReadonlyMap<string, LimaRowClass>, step: LimaStep, today: string): LimaSituation[] {
  const grouped = new Map<string, LimaSituation>();
  for (const row of rows) {
    const cls = classes.get(row.orderId);
    if (!cls || cls.step !== step) continue;
    const s = limaSituation(row, cls, today);
    const existing = grouped.get(s.key);
    if (existing) existing.count++;
    else grouped.set(s.key, { ...s, count: 1 });
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, "es") || a.detail.localeCompare(b.detail, "es"));
}
