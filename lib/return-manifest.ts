// Manifiesto de devolución (fase 1, Grupo GF; 0307, MOM §9.4, §13 y §29.13).
//
// EL CASO. Alexis trae de golpe las devoluciones de varios días. El dueño
// pidió «un manifiesto con todo lo que llegó para llevar un registro con lo que
// reporta Alexis» (04-11-2026). Kapta sabe qué debería volver —cada paquete
// que el motorizado reportó «No entregado» y sigue en su caja— y lo coteja
// contra lo que de verdad llega, escaneado caja por caja.
//
// LAS REGLAS (decisiones del owner, 04-11-2026):
//   - Cada caja se recibe con la recepción de siempre (`gf_return_to_office`):
//     el manifiesto no cambia estados de pedido por su cuenta.
//   - Plazo para «falta» por motorizado: Alexis 3 días; Johnny (Yhoni), Roy y
//     Yordani 1; Duglas 1 mientras no se defina; Urpi 14 (fase 2). La edad se
//     mide desde el día de ruta de la caja, nunca desde `reported_at`.
//   - Un reprogramado que sigue en la caja «sigue con el motorizado» hasta 14
//     días; con más de 14 días, «falta».
//   - Una caja que llega con su parada todavía pendiente no se entregó: se
//     reporta «No entregado · Llegó a oficina sin reporte» y se recibe.
//   - Un pedido anulado en la tienda que vuelve va a inventario.
//
// PURO: sin base, sin reloj. Lo usan las acciones, los cargadores y el acta.

import { gfReturnDecision } from "@/lib/gf-returns-scan";
import { boxDayShort } from "@/lib/gf-scan-return";
import { NON_DELIVERY_REASONS } from "@/lib/routes";
import { ARRIVED_WITHOUT_REPORT_NOTE } from "@/lib/lima-retry-chain";

/** La pantalla de Devoluciones; los manifiestos son su pestaña «Manifiestos». */
export const RETURN_MANIFESTS_PATH = "/dashboard/pedidos/devoluciones";
/** La pestaña «Manifiestos» de Devoluciones. */
export const RETURN_MANIFESTS_TAB_PATH = `${RETURN_MANIFESTS_PATH}?vista=manifiestos`;
export function returnManifestPath(id: string): string {
  return `${RETURN_MANIFESTS_PATH}/manifiestos/${id}`;
}
/** El acta para descargar: PDF o Excel (`app/api/pedidos/devoluciones/manifiestos/[id]/acta`). */
export function returnManifestActaUrl(id: string, format: "pdf" | "xlsx"): string {
  return `/api/pedidos/devoluciones/manifiestos/${id}/acta?formato=${format}`;
}
/** La foto opcional del manifiesto (la hoja o el acta firmada). */
export function returnManifestPhotoUrl(id: string, path?: string): string {
  const base = `/api/pedidos/devoluciones/manifiestos/${id}/foto`;
  return path ? `${base}?path=${encodeURIComponent(path)}` : base;
}

/** El permiso de Almacén: abrir, escanear, cerrar, anular y descargar (owner, 04-11-2026). */
export const RETURN_MANIFEST_PERMISSION = "warehouse.prepare" as const;

/** Por primer nombre normalizado. Lo que no está aquí usa el plazo por defecto. */
export const RIDER_RETURN_CADENCE_DAYS: Readonly<Record<string, number>> = {
  alexis: 3,
  johnny: 1,
  jhonny: 1,
  yhoni: 1,
  jhony: 1,
  roy: 1,
  yordani: 1,
  // Sin plazo definido todavía: 1 día (owner, 04-11-2026).
  duglas: 1,
  douglas: 1,
};
export const DEFAULT_RETURN_CADENCE_DAYS = 1;
/** Fase 2: Urpi recoge cada una o dos semanas. */
export const URPI_RETURN_CADENCE_DAYS = 14;
/** Un reprogramado sigue con el motorizado hasta 14 días; después, falta. */
export const REPROGRAMADO_KEEP_DAYS = 14;
/** Aviso en la lista: un manifiesto abierto hace más de esto se olvidó. */
export const STALE_OPEN_MANIFEST_DAYS = 1;

/**
 * La nota de la parada que llegó sin reporte (regla 4). Vive en la cadena de
 * reintentos, que la reconoce para dejar esa parada fuera (lib/lima-retry-chain.ts).
 */
export { ARRIVED_WITHOUT_REPORT_NOTE };
/** El motivo del catálogo con que se reporta (lleva la nota de arriba). */
export const ARRIVED_WITHOUT_REPORT_REASON = "otro";

function firstNameKey(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0] ?? "";
}

/** Plazo en días del motorizado. Por su nombre, como `isChainRider` (lib/lima-retry-chain.ts). */
export function riderReturnCadenceDays(riderName: string | null | undefined): number {
  return RIDER_RETURN_CADENCE_DAYS[firstNameKey(riderName)] ?? DEFAULT_RETURN_CADENCE_DAYS;
}

/** El plazo de un manifiesto: Urpi por courier; Grupo GF por motorizado. */
export function returnCadenceFor(courier: string, riderName: string | null | undefined): number {
  if (courier === "urpi") return URPI_RETURN_CADENCE_DAYS;
  return riderReturnCadenceDays(riderName);
}

/** Días entre el día de ruta de la caja y el día de llegada (YYYY-MM-DD). */
export function returnAgeDays(routeDate: string, arrivedOn: string): number {
  const a = Date.parse(`${routeDate.slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${arrivedOn.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export type ExpectedBucket = "falta" | "con_el_motorizado" | "reprogramado";

/**
 * Lo esperado que no llegó: «Reprogramado, sigue con él» hasta 14 días, «Con
 * el motorizado» dentro de su plazo, y «Falta» después. Es la misma regla que
 * aplica `return_manifest_close` (0307) al anotar las que faltaron.
 */
export function expectedBucket(input: {
  routeDate: string;
  outcomeReason: string | null | undefined;
  arrivedOn: string;
  cadenceDays: number;
}): ExpectedBucket {
  const age = returnAgeDays(input.routeDate, input.arrivedOn);
  if (input.outcomeReason === "reprogramado") return age > REPROGRAMADO_KEEP_DAYS ? "falta" : "reprogramado";
  return age > input.cadenceDays ? "falta" : "con_el_motorizado";
}

// ---------------------------------------------------------------------------
// Líneas

export type ReturnLineOutcome = "received" | "held" | "info" | "missing";
export type ReturnLineFlag = "otra_caja" | "sin_reporte" | "reportada_entregada" | "ya_recibida" | "no_identificada" | "reprogramado";
/** Lo que hizo la recepción (0307, releído en la base). */
export type ReceiptOutcome = "por_asignar" | "a_inventario_anulado" | "a_stock_reemplazada" | "ya_devuelta";
export type ReturnManifestState = "open" | "closed" | "cancelled";

export const RETURN_LINE_FLAG_LABEL: Readonly<Record<ReturnLineFlag, string>> = {
  otra_caja: "De otra caja",
  sin_reporte: "Llegó sin reporte",
  reportada_entregada: "Reportada entregada · incidencia",
  ya_recibida: "Ya recibida",
  no_identificada: "No identificada",
  reprogramado: "Reprogramado",
};

export const RECEIPT_OUTCOME_LABEL: Readonly<Record<ReceiptOutcome, string>> = {
  por_asignar: "Recibido · vuelve a por asignar",
  a_inventario_anulado: "Recibido · a inventario (anulado)",
  a_stock_reemplazada: "Recibido · a stock (reemplazada)",
  ya_devuelta: "Recibido · ya constaba devuelta",
};

export const RETURN_MANIFEST_STATE_LABEL: Readonly<Record<ReturnManifestState, string>> = {
  open: "En recepción",
  closed: "Cerrado",
  cancelled: "Anulado",
};

/** Una línea como la leen los paneles y el acta. Sin datos del cliente. */
export interface ReturnManifestLine {
  id: string;
  shipmentId: string | null;
  storeId: string | null;
  orderId: string | null;
  orderName: string | null;
  outputCode: string | null;
  scannedCode: string;
  sourceRiderName: string | null;
  sourceRouteDate: string | null;
  reportedStatus: string | null;
  reportedReason: string | null;
  expected: boolean;
  outcome: ReturnLineOutcome;
  flags: ReturnLineFlag[];
  receiptOutcome: ReceiptOutcome | null;
  message: string | null;
  note: string | null;
  scanCount: number;
  scannedAt: string;
  removedAt: string | null;
  removalReason: string | null;
}

/** Lo que Kapta esperaba de vuelta y todavía está en la caja del motorizado. */
export interface ExpectedReturn {
  shipmentId: string;
  storeId: string | null;
  itemId: string;
  manifestId: string;
  routeDate: string;
  stopId: string | null;
  outcomeReason: string | null;
  orderId: string | null;
  orderName: string | null;
  outputCode: string | null;
  /**
   * Un sello del courier (`returned_at`) no prueba que la caja llegó: lo
   * esperado sigue esperado hasta que se escanea. Se lee solo para mostrarlo.
   */
  returnedAt?: string | null;
}

export interface ExpectedRow extends ExpectedReturn {
  ageDays: number;
  bucket: ExpectedBucket;
}

export interface ReturnManifestBuckets {
  /** Esperado y llegó: recibido. */
  llego: ReturnManifestLine[];
  /** Esperado y no llegó, por plazo. */
  noLlego: { falta: ExpectedRow[]; conElMotorizado: ExpectedRow[]; reprogramado: ExpectedRow[] };
  /** Llegó sin esperarse: de otra caja, sin reporte, reportada entregada, ya recibida, no identificada. */
  sinEsperarse: ReturnManifestLine[];
  /** Descartadas (escaneo equivocado), con su motivo. */
  descartadas: ReturnManifestLine[];
  /**
   * Lo esperado DENTRO de plazo que no llegó, contado. Abierto, son las listas
   * de `noLlego`; cerrado, lo que el cierre congeló (`pending_at_close`), así
   * que «esperados» no cambia al cerrar.
   */
  pending: { conElMotorizado: number; reprogramado: number };
}

/** Lo que el cierre congeló, sumado para las tiendas de quien mira. PURA. */
export function pendingAtCloseFor(
  frozen: Readonly<Record<string, { con_el_motorizado?: number | null; reprogramado?: number | null } | null | undefined>> | null | undefined,
  storeIds: ReadonlySet<string>,
): { visible: { conElMotorizado: number; reprogramado: number }; hidden: number } {
  const visible = { conElMotorizado: 0, reprogramado: 0 };
  let hidden = 0;
  for (const [storeId, counts] of Object.entries(frozen ?? {})) {
    const con = Math.max(0, Number(counts?.con_el_motorizado ?? 0) || 0);
    const repro = Math.max(0, Number(counts?.reprogramado ?? 0) || 0);
    if (storeIds.has(storeId)) { visible.conElMotorizado += con; visible.reprogramado += repro; }
    else hidden += con + repro;
  }
  return { visible, hidden };
}

function byOldest<T extends { routeDate?: string | null; sourceRouteDate?: string | null; scannedAt?: string }>(a: T, b: T): number {
  const da = a.routeDate ?? a.sourceRouteDate ?? "";
  const db = b.routeDate ?? b.sourceRouteDate ?? "";
  if (da !== db) return da < db ? -1 : 1;
  return (a.scannedAt ?? "") < (b.scannedAt ?? "") ? -1 : 1;
}

/**
 * Los tres paneles. Abierto, lo esperado sale en vivo (`expected`); cerrado,
 * lo que faltó es lo que el cierre anotó (`missing`), lo que seguía en plazo es
 * lo que contó (`pendingAtClose`) y `expected` se ignora: un manifiesto
 * cerrado no cambia. Lo de otra caja nunca cuenta como esperado.
 */
export function bucketReturnManifest(input: {
  state: ReturnManifestState;
  expected: readonly ExpectedReturn[];
  lines: readonly ReturnManifestLine[];
  arrivedOn: string;
  cadenceDays: number;
  /** Cerrado: lo que el cierre contó dentro de plazo (`pendingAtCloseFor`). */
  pendingAtClose?: { conElMotorizado: number; reprogramado: number } | null;
}): ReturnManifestBuckets {
  const active = input.lines.filter((line) => !line.removedAt);
  const descartadas = input.lines.filter((line) => Boolean(line.removedAt));
  const llego = active.filter((line) => line.outcome === "received" && line.expected).sort(byOldest);
  const sinEsperarse = active.filter((line) => line.outcome !== "missing" && !(line.outcome === "received" && line.expected)).sort(byOldest);
  const noLlego: ReturnManifestBuckets["noLlego"] = { falta: [], conElMotorizado: [], reprogramado: [] };
  if (input.state === "open") {
    const seen = new Set(active.map((line) => line.shipmentId).filter(Boolean));
    for (const row of input.expected) {
      if (seen.has(row.shipmentId)) continue;
      const bucket = expectedBucket({ routeDate: row.routeDate, outcomeReason: row.outcomeReason, arrivedOn: input.arrivedOn, cadenceDays: input.cadenceDays });
      const full: ExpectedRow = { ...row, ageDays: returnAgeDays(row.routeDate, input.arrivedOn), bucket };
      if (bucket === "falta") noLlego.falta.push(full);
      else if (bucket === "reprogramado") noLlego.reprogramado.push(full);
      else noLlego.conElMotorizado.push(full);
    }
  } else {
    for (const line of active.filter((l) => l.outcome === "missing" && l.shipmentId)) {
      noLlego.falta.push({
        shipmentId: line.shipmentId!,
        storeId: line.storeId,
        itemId: "",
        manifestId: "",
        routeDate: line.sourceRouteDate ?? "",
        stopId: null,
        outcomeReason: line.reportedReason,
        orderId: line.orderId,
        orderName: line.orderName,
        outputCode: line.outputCode,
        ageDays: line.sourceRouteDate ? returnAgeDays(line.sourceRouteDate, input.arrivedOn) : 0,
        bucket: "falta",
      });
    }
  }
  for (const list of Object.values(noLlego)) list.sort(byOldest);
  const pending = input.state === "open"
    ? { conElMotorizado: noLlego.conElMotorizado.length, reprogramado: noLlego.reprogramado.length }
    : { conElMotorizado: input.pendingAtClose?.conElMotorizado ?? 0, reprogramado: input.pendingAtClose?.reprogramado ?? 0 };
  return { llego, noLlego, sinEsperarse, descartadas, pending };
}

export interface ReturnManifestTotals {
  /** Cajas que llegaron físicamente (todo lo escaneado y no descartado). */
  arrived: number;
  received: number;
  /** De lo recibido: lo que vuelve a «por asignar» y lo que va a inventario o stock. */
  requeued: number;
  toInventory: number;
  toStock: number;
  /** Observaciones abiertas (no se recibieron). */
  withObservation: number;
  info: number;
  /** Esperadas y fuera de plazo que no llegaron. */
  missing: number;
  /** Esperadas dentro de plazo que no llegaron: siguen con el motorizado (reprogramado incluido). */
  withRider: number;
  expectedTotal: number;
  expectedReceived: number;
  declared: number | null;
  /** Declaró menos llegaron; null sin cifra declarada. */
  declaredGap: number | null;
}

/** Los totales del contador, del cierre y del acta. */
export function returnManifestTotals(buckets: ReturnManifestBuckets, declared: number | null): ReturnManifestTotals {
  const arrivedLines = [...buckets.llego, ...buckets.sinEsperarse];
  const received = arrivedLines.filter((l) => l.outcome === "received");
  const arrived = arrivedLines.length;
  // Cerrado, lo que seguía en plazo ya no se lista: se usa lo que el cierre contó.
  const expectedPending = buckets.noLlego.falta.length + buckets.pending.conElMotorizado + buckets.pending.reprogramado;
  return {
    arrived,
    received: received.length,
    requeued: received.filter((l) => l.receiptOutcome === "por_asignar").length,
    toInventory: received.filter((l) => l.receiptOutcome === "a_inventario_anulado").length,
    toStock: received.filter((l) => l.receiptOutcome === "a_stock_reemplazada" || l.receiptOutcome === "ya_devuelta").length,
    withObservation: arrivedLines.filter((l) => l.outcome === "held").length,
    info: arrivedLines.filter((l) => l.outcome === "info").length,
    missing: buckets.noLlego.falta.length,
    withRider: buckets.pending.conElMotorizado + buckets.pending.reprogramado,
    expectedTotal: buckets.llego.length + expectedPending,
    expectedReceived: buckets.llego.length,
    declared,
    declaredGap: declared == null ? null : declared - arrived,
  };
}

/** «Recibidos 12 de 30 esperados · declaró 14». */
export function returnManifestCounter(totals: ReturnManifestTotals): string {
  const base = `Recibidos ${totals.expectedReceived} de ${totals.expectedTotal} esperados`;
  const extra = totals.arrived - totals.expectedReceived;
  return [base, extra > 0 ? `${extra} sin esperarse` : null, totals.declared != null ? `declaró ${totals.declared}` : null]
    .filter(Boolean)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// El escaneo

/** Lo que el escaneo sabe de la salida, leído con el mismo buscador de Almacén. */
export interface ManifestScanFacts {
  /** Código de la salida (output_code o guía). */
  label: string;
  /** El motorizado del manifiesto. */
  headerRiderId: string;
  /** `courierKey` de la salida; una «por definir» llega como `propio` (como en Devoluciones). */
  courier: string;
  /** La caja de Grupo GF donde está, si está en una. */
  box: {
    itemId: string;
    manifestId: string;
    riderId: string | null;
    riderName: string;
    routeDate: string;
    /** La última parada de la salida en ESA caja (sin las que pasaron a otra ruta, 0292). */
    stop: { id: string; status: string; outcomeReason: string | null; routeId: string; routeStatus: string | null } | null;
  } | null;
  custodyState: string | null;
  receivedInOffice: boolean;
  replaced: boolean;
  /** Anulado en la tienda o venta Woo terminada: una ya recibida fue a inventario. */
  saleEnded?: boolean;
}

export type ManifestScanPlan =
  | { kind: "recibir"; otraCaja: boolean; message?: undefined }
  /** Regla 4: se reporta «No entregado · Llegó a oficina sin reporte» y se recibe. */
  | { kind: "reportar_y_recibir"; otraCaja: boolean; stopId: string; routeId: string; message?: undefined }
  | { kind: "anotar"; outcome: "held" | "info"; flags: ReturnLineFlag[]; message: string };

/**
 * Qué hace el manifiesto con la caja escaneada. Clasifica con la MISMA regla
 * que Almacén → Devoluciones (`gfReturnDecision`) y añade lo propio del
 * manifiesto: de otra caja, sin reporte (regla 4), reportada entregada,
 * ya recibida y no identificada. PURA.
 */
export function classifyManifestScan(facts: ManifestScanFacts): ManifestScanPlan {
  const { label, box } = facts;
  if (facts.courier !== "propio") {
    return {
      kind: "anotar",
      outcome: "held",
      flags: ["no_identificada"],
      message: `${label} no es de Grupo GF: su devolución no va en este manifiesto. Anota qué es o descártala.`,
    };
  }
  const otraCaja = Boolean(box && box.riderId !== facts.headerRiderId);
  const decision = gfReturnDecision(label, {
    box: box ? { riderName: box.riderName, routeDate: box.routeDate, stopStatus: box.stop?.status ?? null } : null,
    custodyState: facts.custodyState,
    receivedInOffice: facts.receivedInOffice,
    replaced: facts.replaced,
    saleEnded: facts.saleEnded,
  });
  if (decision.kind === "recibir") return { kind: "recibir", otraCaja };
  if (box) {
    const where = `la caja de ${box.riderName} del ${boxDayShort(box.routeDate)}`;
    const status = box.stop?.status ?? null;
    if (status === "entregado") {
      return {
        kind: "anotar",
        outcome: "held",
        flags: otraCaja ? ["reportada_entregada", "otra_caja"] : ["reportada_entregada"],
        message: `${label}: ${box.riderName} lo reportó entregado (${where}) y la caja volvió. Es una incidencia: no se recibe; avisa a coordinación para corregir ese reporte.`,
      };
    }
    if (status === "pendiente" && box.stop) {
      if (box.stop.routeStatus !== "en_curso") {
        return {
          kind: "anotar",
          outcome: "held",
          flags: otraCaja ? ["sin_reporte", "otra_caja"] : ["sin_reporte"],
          message: `${label} llegó sin reporte y la ruta del ${boxDayShort(box.routeDate)} ya no está en curso: corrige su parada en Rutas y vuelve a escanearla.`,
        };
      }
      return { kind: "reportar_y_recibir", otraCaja, stopId: box.stop.id, routeId: box.stop.routeId };
    }
    return {
      kind: "anotar",
      outcome: "held",
      flags: otraCaja ? ["sin_reporte", "otra_caja"] : ["sin_reporte"],
      message: `${label} sigue en ${where} sin una parada que reportar: revísalo en Rutas y vuelve a escanearlo.`,
    };
  }
  if (decision.kind === "aviso") return { kind: "anotar", outcome: "info", flags: ["ya_recibida"], message: decision.message };
  return { kind: "anotar", outcome: "held", flags: ["no_identificada"], message: `${decision.message} Anota qué es o descártala.` };
}

/** Lo que dice la línea recibida, según lo que hizo la base. */
export function receivedLineMessage(input: {
  label: string;
  receiptOutcome: ReceiptOutcome;
  otraCaja: boolean;
  sinReporte: boolean;
  boxRiderName: string;
  boxRouteDate: string;
}): string {
  const from = `${input.boxRiderName} del ${boxDayShort(input.boxRouteDate)}`;
  const lead = input.sinReporte
    ? `${input.label} llegó sin reporte: se reportó «No entregado · ${ARRIVED_WITHOUT_REPORT_NOTE}» y se recibió`
    : `${input.label} recibido`;
  const other = input.otraCaja ? ` De otra caja (${from}).` : "";
  switch (input.receiptOutcome) {
    case "a_inventario_anulado":
      return `${lead}: el pedido está anulado en la tienda, va a inventario (Almacén decide stock o merma); no vuelve a «por asignar».${other}`;
    case "a_stock_reemplazada":
      return `${lead}: era la caja reemplazada; desármala y regístrala como reingreso a stock.${other}`;
    case "ya_devuelta":
      return `${lead}: ya constaba devuelta; salió de la caja sin volver a «por asignar».${other}`;
    default:
      return `${lead}: vuelve a «por asignar» en Grupo GF para reprogramarlo.${other}`;
  }
}

// ---------------------------------------------------------------------------
// Después del cierre: lo que se deriva en vivo, sin tocar el manifiesto.

/** Un evento de recepción posterior de la salida (`returned_to_office` / `return_received`). */
export interface ShipmentReceiptEvent {
  shipmentId: string;
  kind: string;
  actor: string | null;
  source: string | null;
  occurredAt: string;
  returnManifestId?: string | null;
}

/**
 * ¿Una persona recibió la salida después? Solo cuenta una recepción humana:
 * ni el sello del courier ni una toma del sistema sin actor (`urpi_take_gf_output`,
 * backfills) prueban que la caja llegó. Devuelve la primera, o null.
 */
export function laterPhysicalReceipt(shipmentId: string, after: string, events: readonly ShipmentReceiptEvent[]): ShipmentReceiptEvent | null {
  const hits = events
    .filter((e) => e.shipmentId === shipmentId && e.actor && (e.kind === "returned_to_office" || e.kind === "return_received")
      && (e.source === "dispatch" || e.source === "manual") && e.occurredAt > after)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
  return hits[0] ?? null;
}

/** «apareció el 06/11», para una línea que faltó y luego llegó. */
export function appearedLabel(event: ShipmentReceiptEvent | null): string | null {
  if (!event) return null;
  return `apareció el ${limaDdMm(event.occurredAt)}`;
}

function limaDdMm(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso.slice(0, 10);
  const [, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(at).split("-");
  return `${day}/${month}`;
}

/** Lo que muestra el historial de la salida en el drawer del pedido. */
export function drawerLineLabel(line: { outcome: ReturnLineOutcome; flags: readonly ReturnLineFlag[]; manifestLabel: string }): string {
  const where = line.manifestLabel;
  if (line.outcome === "received") return `Recibida en ${where}`;
  if (line.outcome === "missing") return `Faltó en ${where}`;
  if (line.flags.includes("reportada_entregada")) return `Incidencia en ${where}: llegó reportada entregada`;
  if (line.flags.includes("no_identificada")) return `No identificada en ${where}`;
  if (line.flags.includes("sin_reporte")) return `Llegó sin reporte en ${where}`;
  return `Escaneada en ${where}`;
}

/**
 * El cuaderno que llega después y dice «entregado» de una parada que ya se
 * reportó «No entregado · Llegó a oficina sin reporte»: no se carga encima
 * (la parada ya no está pendiente) y queda como incidencia a la vista. PURA.
 */
export function notebookOfficeConflictMessage(input: { manifestLabel: string; arrivedOn: string | null }): string {
  const day = input.arrivedOn ? ` el ${boxDayShort(input.arrivedOn)}` : "";
  return `Incidencia: el cuaderno dice Entregado, pero la caja llegó a la oficina${day} sin reporte (${input.manifestLabel}) y se recibió «No entregado». No se carga: revísalo con coordinación.`;
}

// ---------------------------------------------------------------------------
// El acta (PDF y Excel). Sin nombres, teléfonos ni direcciones de clientes.

export interface ReturnManifestActaHeader {
  label: string;
  courierLabel: string;
  riderFirstName: string | null;
  arrivedOn: string;
  handedOverBy: string | null;
  receivedBy: string | null;
  openedAt: string;
  closedAt: string | null;
  state: ReturnManifestState;
  declaredCount: number | null;
  note: string | null;
}

export interface ReturnManifestActaRow {
  n: number;
  orderName: string;
  outputCode: string;
  boxDay: string;
  reported: string;
  result: string;
}

export interface ReturnManifestActa {
  title: string;
  header: ReturnManifestActaHeader;
  rows: ReturnManifestActaRow[];
  totals: ReturnManifestTotals;
  signatures: ["Entregó", "Recibió"];
}

/** «No contesta», «Reprogramado por el cliente», «Entregado». */
export function reportedLabel(status: string | null | undefined, reason: string | null | undefined): string {
  if (status === "entregado") return "Entregado";
  if (status === "pendiente" || !status) return "Sin reporte";
  const label = NON_DELIVERY_REASONS.find((r) => r.code === reason)?.label;
  return label ? `No entregado · ${label}` : "No entregado";
}

/** El resultado de la línea sin sus marcas (la pantalla las muestra aparte). */
export function lineResultHead(line: Pick<ReturnManifestLine, "outcome" | "flags" | "receiptOutcome">): string {
  if (line.outcome === "missing") return line.flags.includes("reprogramado") ? "Falta (reprogramado más de 14 días)" : "Falta";
  return line.outcome === "received"
    ? RECEIPT_OUTCOME_LABEL[line.receiptOutcome ?? "por_asignar"]
    : line.outcome === "held" ? "Observación · no recibida" : "Informativa";
}

/** El resultado de la línea, en palabras del acta: la cabeza y sus marcas. */
export function lineResultLabel(line: Pick<ReturnManifestLine, "outcome" | "flags" | "receiptOutcome">): string {
  if (line.outcome === "missing") return lineResultHead(line);
  const flags = line.flags.filter((f) => f !== "reprogramado").map((f) => RETURN_LINE_FLAG_LABEL[f]);
  return [lineResultHead(line), ...flags].join(" · ");
}

/** El acta: una fila por línea (recibidas, observaciones y faltantes), sin datos de clientes. */
export function buildReturnManifestActa(input: {
  header: ReturnManifestActaHeader;
  buckets: ReturnManifestBuckets;
}): ReturnManifestActa {
  const { header, buckets } = input;
  const rows: ReturnManifestActaRow[] = [];
  const push = (orderName: string | null, outputCode: string | null, day: string | null, reported: string, result: string) =>
    rows.push({ n: rows.length + 1, orderName: orderName ?? "—", outputCode: outputCode ?? "—", boxDay: day ? boxDayShort(day) : "—", reported, result });
  for (const line of [...buckets.llego, ...buckets.sinEsperarse]) {
    push(line.orderName, line.outputCode ?? line.scannedCode, line.sourceRouteDate, reportedLabel(line.reportedStatus, line.reportedReason), lineResultLabel(line));
  }
  for (const row of buckets.noLlego.falta) {
    push(row.orderName, row.outputCode, row.routeDate, reportedLabel("no_entregado", row.outcomeReason),
      row.outcomeReason === "reprogramado" ? "Falta (reprogramado más de 14 días)" : "Falta");
  }
  return {
    title: `Acta de devolución · ${header.label}`,
    header,
    rows,
    totals: returnManifestTotals(buckets, header.declaredCount),
    signatures: ["Entregó", "Recibió"],
  };
}
