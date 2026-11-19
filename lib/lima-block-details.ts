// Desgloses de lectura: todos cuentan pedidos, nunca guías ni eventos.
import { compareDispatchCodes, dispatchedWithLabel } from "@/lib/dispatched-with";
import { courierLabel, limaIsNew, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { LIMA_COURIER_CARDS, type LimaRowClass, type LimaStep } from "@/lib/repro-lima-blocks";
import { limaNeedsReview, limaSituationKey } from "@/lib/lima-situations";
import { limaPackageLocation } from "@/lib/lima-package";
import { limaReviewReasons, LIMA_REVIEW_LABELS } from "@/lib/lima-review";

export type LimaDetailGroup = { title: string; help?: string; prominent?: boolean; items: { key: string; label: string; count: number }[] };

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
    case "auto-gf-guide": return row.ops?.autoGfGuide === true;
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
    case "review-couriers": return limaNeedsReview(row);
    case "review": return limaReviewReasons(row, cls).length > 0;
    case "failed-no-report": return cls.step === "no_entregados" && cls.noReport;
    case "failed-retry": return cls.step === "no_entregados" && cls.retry;
    case "failed-agree": return cls.step === "no_entregados" && !cls.retry && !cls.noReport;
    case "with-call": return row.management?.hasCall === true;
    case "no-call": return row.management?.hasCall === false;
    case "unknown-call": return row.management == null;
    case "moved-lima": return Boolean(row.management?.movedToLimaAt);
    case "manage-today": return cls.needsToday === true;
    case "pickup-pending": return cls.courier === "guia_creada";
    case "pickup-done": return cls.courier === "en_ruta";
    case "custody-unknown": return !row.ops?.custody;
    case "no-report": return !row.ops?.reportedStatus;
    default:
      if (key.startsWith("review:")) return limaReviewReasons(row, cls).some((reason) => reason === key.slice(7));
      if (key.startsWith("location:")) return limaPackageLocation(row) === key.slice(9);
      if (key.startsWith("situation:")) return limaSituationKey(row, cls) === key;
      if (key.startsWith("custody:")) return row.ops?.custody === key.slice(8);
      if (key.startsWith("report:")) return row.ops?.reportedStatus === key.slice(7);
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
  const reports = [...new Set([...inside.flatMap(({ row }) => row.ops?.reportedStatus ? [row.ops.reportedStatus] : []), ...(selected?.startsWith("report:") ? [selected.slice(7)] : [])])].sort();
  return [
    ...(step === "no_entregados" ? [
      { ...group("Dónde figura el paquete", [["location:warehouse", "En almacén"], ["location:courier", "Con el courier"], ["location:returning", "Retornando"], ["location:unknown", "Ubicación sin confirmar"]], "Estas cuatro cifras suman el bloque. En almacén incluye custodia empresa y devuelto. Se muestra la ubicación registrada; las contradicciones se marcan para revisión."), prominent: true },
      { ...group("Gestión pendiente", [["failed-agree", "Por acordar nuevo intento"], ["failed-retry", "Reintentos Aliclik"], ["failed-no-report", "Sin reporte de la ruta"], ["review", "Para revisión"]], "La gestión se cruza con la ubicación: un pedido puede estar con el courier y sin reporte. Para revisión puede coincidir con otras cifras; no se suma aparte."), prominent: true },
      { ...group("Motivos de revisión", Object.entries(LIMA_REVIEW_LABELS).map(([reason, label]) => [`review:${reason}`, label]), "Se conserva su bloque hasta verificar los datos. No anula ventas ni guías automáticamente."), prominent: true },
    ] : []),
    ...(step === "con_courier" ? [group("Estado del recojo", [["pickup-pending", LIMA_COURIER_CARDS[0]!.label], ["pickup-done", LIMA_COURIER_CARDS[1]!.label]], "Estas dos cifras suman el bloque. Crear una guía no confirma el recojo. Consulta la custodia del paquete para saber quién lo tiene; si no consta, no se supone.")] : []),
    group("Salidas a reparto", [["never", "Nunca salieron"], ["left", "Salieron al menos una vez"], ["unknown", "Sin evidencia suficiente"]], "Estas tres cifras suman el bloque. Tener guía o motorizado asignado no prueba una salida."),
    group("Intentos de entrega registrados", attempts.map((n) => [`attempts:${n}`, `${n} ${n === 1 ? "intento" : "intentos"}`]), "Suman el bloque. Son visitas reportadas; una salida sin resultado todavía puede tener 0 intentos."),
    group("Guías y rótulos", [["guide", "Con guía o rótulo vigente"], ["no-guide", "Sin guía o rótulo vigente"], ["auto-gf-guide", "Con guía GF automática pendiente de recojo"], ["old-guide", "Con documentos en el historial"], ["annulled-guide", "Con guía o rótulo anulado"], ["returned-guide", "Con guía o rótulo devuelto"]], "Con y sin documento vigente suman el bloque. La guía GF automática permite seguir en Nuevos mientras no haya gestión ni salida. El historial incluye documentos anteriores y puede cruzarse."),
    group("Programación actual", [["scheduled", "Con día programado"], ["no-day", "Sin día programado"], ["reprogrammed", "Reprogramados con día"], ["agreement", "Con acuerdo vigente con la clienta"]], "Con y sin día suman el bloque. Reprogramados: ya salieron o tienen acuerdo vigente y cuentan con un nuevo día."),
    group("Cruces para gestionar", [["guide-scheduled", "Con guía vigente y programados"], ["guide-reprogrammed", "Con guía vigente y reprogramados"], ["no-guide-reprogrammed", "Reprogramados sin guía vigente"], ["cancel", "Esperan anulación de la venta"], ["guide-cancel", "Con guía vigente y esperan anulación"], ["any-guide-cancel", "Con guía en el historial y esperan anulación"], ["guide-cancel-requested", "Guía GF con anulación solicitada"], ["delivered", "Courier reportó entregado, falta cierre"]], "Son cruces: un pedido puede aparecer en varias cifras. La anulación requiere un cierre explícito del caso; no se predice."),
    group("Salió con (historial)", [...historical.map((code) => [`with:${code}`, dispatchedWithLabel(code)] as const), ["left-no-courier", "Salió, courier sin registrar"]], "Solo salidas comprobadas. Si salió con varios couriers, cuenta una vez en cada uno. Un asignado o sugerido aún no cuenta como salida."),
    group("Courier actual", current.map((label) => [`current:${label}`, label]), "Cada pedido cuenta una vez. Puede ser diferente de quien hizo los repartos anteriores."),
    group("Gestión y llamadas", [["with-call", "Con llamada de gestión de entrega"], ["no-call", "Sin llamadas de gestión de entrega"], ["unknown-call", "Historial de llamadas sin leer"], ["moved-lima", "Cobertura corregida a Lima"], ["manage-today", "Provincia a Lima: gestionar hoy"]], "Solo cuentan las llamadas desde la creación del pedido. Las anteriores se conservan en el historial comercial. Con llamada, sin llamada y sin lectura suman el bloque. Gestionar hoy no crea una fecha de despacho."),
    group("Custodia del paquete", [["custody:empresa", "En la empresa"], ["custody:courier", "Con el courier"], ["custody:retorno", "En retorno"], ["custody:devuelto", "Devuelto a la empresa"], ["custody-unknown", "Custodia sin confirmar"]]),
    group("Reporte del courier", [...reports.map((report) => [`report:${report}`, report] as const), ["no-report", "Sin reporte del courier"]]),
    group("Revisión para posible cierre", [["review-couriers", "Salieron con varios couriers"]], "Solo revisión. No anula ventas ni guías. Dos motorizados de Grupo GF cuentan como un courier."),
  ];
}

/** Resumen por pedido, independiente del courier asignado para la próxima ruta. */
export function limaHistoryText(row: LimaPendingOrder): string {
  const state = limaDepartureState(row);
  const departure = state === "never" ? "Nunca salió a reparto" : state === "left" ? "Salió al menos una vez" : "Salida sin evidencia suficiente";
  const history = [...new Set(row.dispatchedWith ?? [])].sort(compareDispatchCodes).map(dispatchedWithLabel);
  return `${departure} · ${row.attempts} ${row.attempts === 1 ? "intento registrado" : "intentos registrados"}${history.length ? ` · Salió con: ${history.join(", ")}` : state === "left" ? " · Courier de salida sin registrar" : ""}`;
}
