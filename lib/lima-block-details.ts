// Desgloses de lectura: todos cuentan pedidos, nunca guías ni eventos.
import { compareDispatchCodes, dispatchedWithLabel } from "@/lib/dispatched-with";
import { courierLabel, limaIsNew, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import type { LimaRowClass, LimaStep } from "@/lib/repro-lima-blocks";

export type LimaDetailGroup = { title: string; help?: string; items: { key: string; label: string; count: number }[] };

/** Cero intentos no prueba que no salió: puede estar en ruta sin reporte. */
export function limaDepartureState(row: LimaPendingOrder): "never" | "left" | "unknown" {
  if (row.hasPriorDispatch || row.dispatchedAt || row.lastDepartureAt || row.attempts > 0 || row.dispatchedWith?.length) return "left";
  if (limaIsNew(row)) return "never";
  return "unknown";
}

export function limaDetailFacts(row: LimaPendingOrder, cls: LimaRowClass) {
  const departure = limaDepartureState(row);
  const scheduled = Boolean(cls.agendaDay);
  const waiting = cls.courier === null || cls.courier === "guia_creada";
  return { departure, scheduled, reprogrammed: scheduled && (cls.agreed || (departure === "left" && waiting)) };
}

/** El mismo predicado se usa para la cifra y para la lista que abre. */
export function limaDetailMatches(row: LimaPendingOrder, cls: LimaRowClass, key: string): boolean {
  const { departure, scheduled, reprogrammed } = limaDetailFacts(row, cls);
  switch (key) {
    case "never": return departure === "never";
    case "left": return departure === "left";
    case "unknown": return departure === "unknown";
    case "guide": return cls.guide;
    case "no-guide": return !cls.guide;
    case "old-guide": return (row.ops?.guides?.total ?? 0) > 0;
    case "annulled-guide": return (row.ops?.guides?.annulled ?? 0) > 0;
    case "returned-guide": return (row.ops?.guides?.returned ?? 0) > 0;
    case "scheduled": return scheduled;
    case "no-day": return !scheduled;
    case "reprogrammed": return reprogrammed;
    case "agreement": return cls.agreed;
    case "guide-scheduled": return cls.guide && scheduled;
    case "guide-reprogrammed": return cls.guide && reprogrammed;
    case "no-guide-reprogrammed": return !cls.guide && reprogrammed;
    case "guide-cancel": return cls.guide && cls.awaitingCancel;
    case "any-guide-cancel": return (row.ops?.guides?.total ?? 0) > 0 && cls.awaitingCancel;
    case "cancel": return cls.awaitingCancel;
    case "delivered": return Boolean(row.ops?.courierDelivered);
    case "guide-cancel-requested": return (row.ops?.guides?.cancelRequested ?? 0) > 0;
    case "left-no-courier": return departure === "left" && !row.dispatchedWith?.length;
    default:
      if (/^attempts:\d+$/.test(key)) return row.attempts === Number(key.slice(9));
      if (key.startsWith("with:")) return row.dispatchedWith?.includes(key.slice(5)) ?? false;
      if (key.startsWith("current:")) return courierLabel(row.courier, row.courierDetail) === key.slice(8);
      return false;
  }
}

export function limaBlockDetails(rows: readonly LimaPendingOrder[], classes: ReadonlyMap<string, LimaRowClass>, step: LimaStep, selected?: string | null): LimaDetailGroup[] {
  const inside = rows.flatMap((row) => {
    const cls = classes.get(row.orderId);
    return cls?.step === step ? [{ row, cls }] : [];
  });
  const group = (title: string, items: readonly (readonly [string, string])[], help?: string): LimaDetailGroup => ({
    title, help,
    items: items.map(([key, label]) => ({ key, label, count: inside.filter(({ row, cls }) => limaDetailMatches(row, cls, key)).length })),
  });
  // Un filtro guardado sigue visible con cero al cambiar Tienda, Distrito o la búsqueda.
  const historical = [...new Set([...inside.flatMap(({ row }) => row.dispatchedWith ?? []), ...(selected?.startsWith("with:") && selected.length > 5 ? [selected.slice(5)] : [])])].sort(compareDispatchCodes);
  const current = [...new Set([...inside.map(({ row }) => courierLabel(row.courier, row.courierDetail)), ...(selected?.startsWith("current:") && selected.length > 8 ? [selected.slice(8)] : [])])].sort((a, b) => a.localeCompare(b, "es"));
  const attempts = [...new Set([0, 1, 2, ...inside.map(({ row }) => row.attempts), ...(/^attempts:\d+$/.test(selected ?? "") ? [Number(selected!.slice(9))] : [])])].sort((a, b) => a - b);
  return [
    group("Salidas a reparto", [["never", "Nunca salieron"], ["left", "Salieron al menos una vez"], ["unknown", "Sin evidencia suficiente"]], "Estas tres cifras suman el bloque. Tener guía o motorizado asignado no prueba una salida."),
    group("Intentos de entrega registrados", attempts.map((n) => [`attempts:${n}`, `${n} ${n === 1 ? "intento" : "intentos"}`]), "Suman el bloque. Son visitas reportadas; una salida sin resultado todavía puede tener 0 intentos."),
    group("Guías y rótulos", [["guide", "Con guía o rótulo vigente"], ["no-guide", "Sin guía o rótulo vigente"], ["old-guide", "Con documentos en el historial"], ["annulled-guide", "Con guía o rótulo anulado"], ["returned-guide", "Con guía o rótulo devuelto"]], "Con y sin documento vigente suman el bloque. El historial incluye documentos anteriores y puede cruzarse."),
    group("Programación actual", [["scheduled", "Con día programado"], ["no-day", "Sin día programado"], ["reprogrammed", "Reprogramados con día"], ["agreement", "Con acuerdo vigente con la clienta"]], "Con y sin día suman el bloque. Reprogramados: ya salieron o tienen acuerdo vigente y cuentan con un nuevo día."),
    group("Cruces para gestionar", [["guide-scheduled", "Con guía vigente y programados"], ["guide-reprogrammed", "Con guía vigente y reprogramados"], ["no-guide-reprogrammed", "Reprogramados sin guía vigente"], ["cancel", "Esperan anulación de la venta"], ["guide-cancel", "Con guía vigente y esperan anulación"], ["any-guide-cancel", "Con guía en el historial y esperan anulación"], ["guide-cancel-requested", "Guía GF con anulación solicitada"], ["delivered", "Courier reportó entregado, falta cierre"]], "Son cruces: un pedido puede aparecer en varias cifras. La anulación requiere un cierre explícito del caso; no se predice."),
    group("Salió con (historial)", [...historical.map((code) => [`with:${code}`, dispatchedWithLabel(code)] as const), ["left-no-courier", "Salió, courier sin registrar"]], "Solo salidas comprobadas. Si salió con varios couriers, cuenta una vez en cada uno. Un asignado o sugerido aún no cuenta como salida."),
    group("Courier actual", current.map((label) => [`current:${label}`, label]), "Cada pedido cuenta una vez. Puede ser diferente de quien hizo los repartos anteriores."),
  ];
}

/** Resumen por pedido, independiente del courier asignado para la próxima ruta. */
export function limaHistoryText(row: LimaPendingOrder): string {
  const state = limaDepartureState(row);
  const departure = state === "never" ? "Nunca salió a reparto" : state === "left" ? "Salió al menos una vez" : "Salida sin evidencia suficiente";
  const history = [...new Set(row.dispatchedWith ?? [])].sort(compareDispatchCodes).map(dispatchedWithLabel);
  return `${departure} · ${row.attempts} ${row.attempts === 1 ? "intento registrado" : "intentos registrados"}${history.length ? ` · Salió con: ${history.join(", ")}` : state === "left" ? " · Courier de salida sin registrar" : ""}`;
}
