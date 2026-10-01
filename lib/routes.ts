// Rutas de reparto: reglas de la parada y del cierre del día. Puro + testeado.
//
// La diferencia con lib/settlements.ts es de dirección: allí se RECONSTRUYE lo
// que pasó leyendo una hoja; aquí se DECLARA en el momento, parada por parada.
// El resultado es el mismo tipo de cuadre — por eso cerrar una ruta produce una
// liquidación normal y corriente, con sus mismas reglas.
//
// Dos ideas gobiernan este módulo:
//
//   1. LO QUE REPORTA EL MOTORIZADO ES UNA DECLARACIÓN. Se guarda en la parada,
//      no en el pedido. Que marque "entregado" no cierra nada en el Master: el
//      Master lo mueven los reportes del courier y el equipo, y el cuadre
//      compara ambos. Un motorizado no cierra pedidos por su cuenta.
//
//   2. UNA PARADA REPORTADA SE CORRIGE, NO SE REESCRIBE. Cada reporte deja su
//      rastro (`delivery_stop_events`). Es dinero: hace falta saber quién dijo
//      qué y cuándo.

import { resolveTariff, type CostContext, type CostTariff } from "@/lib/costs";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type StopStatus = "pendiente" | "entregado" | "no_entregado";
export type PaymentMethod = "efectivo" | "yape" | "pos" | "sin_cobro";

export const PAYMENT_METHODS: { code: PaymentMethod; label: string }[] = [
  { code: "efectivo", label: "Efectivo" },
  { code: "yape", label: "Yape" },
  { code: "pos", label: "POS / tarjeta" },
  { code: "sin_cobro", label: "Sin cobro" },
];

/** Motivos de no entrega. Cerrados a propósito: un catálogo fijo se puede
 *  contar y comparar entre motorizados; un texto libre, no. El detalle va en
 *  la nota. */
export const NON_DELIVERY_REASONS: { code: string; label: string }[] = [
  { code: "no_contesta", label: "No contesta" },
  { code: "rechazado", label: "Rechazó el pedido" },
  { code: "direccion_errada", label: "Dirección errada" },
  { code: "no_estaba", label: "No estaba / volver luego" },
  { code: "reprogramado", label: "Reprogramado por el cliente" },
  { code: "sin_dinero", label: "No tenía el dinero" },
  { code: "otro", label: "Otro (ver nota)" },
];

export function isPaymentMethod(v: string | null | undefined): v is PaymentMethod {
  return PAYMENT_METHODS.some((m) => m.code === v);
}

export function isNonDeliveryReason(v: string | null | undefined): boolean {
  return NON_DELIVERY_REASONS.some((r) => r.code === v);
}

/** Lo que el motorizado manda al reportar una parada. */
export interface StopReport {
  status: StopStatus;
  paymentMethod: PaymentMethod | null;
  collectedAmount: number | null;
  outcomeReason: string | null;
  note: string | null;
  hasPhoto: boolean;
  hasVoucher: boolean;
}

/** El campo del formulario que cada error pide arreglar (30-09-2026). */
export type StopReportField = "estado" | "metodo" | "monto" | "yape" | "foto" | "motivo" | "nota";

export interface ReportValidation {
  ok: boolean;
  errors: string[];
  /**
   * Para cada error, en el mismo orden, el campo que lo arregla: el teléfono
   * lleva al motorizado al primero que falta en vez de solo pintarlo de rojo.
   */
  fields: StopReportField[];
}

/**
 * Valida un reporte ANTES de tocar la base. Se exporta puro para que la misma
 * regla valga en el móvil (aviso inmediato) y en el servidor (la que manda).
 *
 * Las reglas nacen de lo que rompe una liquidación:
 *  - una entrega sin método de cobro deja un agujero silencioso en el cuadre;
 *  - una entrega en efectivo o POS sin monto es plata sin declarar;
 *  - una no-entrega con dinero cobrado es una contradicción que hay que mirar;
 *  - un cobro por Yape sin captura no se puede validar después.
 */
export function validateStopReport(report: StopReport): ReportValidation {
  const errors: string[] = [];
  const fields: StopReportField[] = [];
  const fail = (field: StopReportField, message: string) => {
    fields.push(field);
    errors.push(message);
  };

  if (report.status === "pendiente") {
    fail("estado", "Elige si lo entregaste o no.");
    return { ok: false, errors, fields };
  }

  if (report.status === "entregado") {
    if (!isPaymentMethod(report.paymentMethod)) {
      fail("metodo", "Indica cómo cobraste.");
    }
    const needsAmount =
      report.paymentMethod === "efectivo" ||
      report.paymentMethod === "yape" ||
      report.paymentMethod === "pos";
    if (needsAmount && (report.collectedAmount === null || !Number.isFinite(report.collectedAmount) || report.collectedAmount <= 0)) {
      fail("monto", "Escribe cuánto cobraste.");
    }
    if (report.paymentMethod === "sin_cobro" && report.collectedAmount !== 0) {
      fail("monto", "Sin cobro debe registrar S/ 0.00.");
    }
    if (report.paymentMethod === "yape" && !report.hasVoucher) {
      fail("yape", "Adjunta la captura del Yape.");
    }
    if (!report.hasPhoto) {
      fail("foto", "Adjunta la foto de la entrega.");
    }
  }

  if (report.status === "no_entregado") {
    if (!isNonDeliveryReason(report.outcomeReason)) {
      fail("motivo", "Indica por qué no se entregó.");
    }
    if (report.outcomeReason === "otro" && !report.note?.trim()) {
      fail("nota", "Escribe en la nota qué pasó.");
    }
    // Un rechazo se le cobra a la tienda como una entrega (MOM §29.7), y sin
    // foto no hay cómo sostenerlo. Se pide AQUÍ, al reportar, porque es el único
    // momento en que el motorizado está en la puerta: antes solo lo pedía la
    // liquidación, días después, y de 204 rechazos ninguno tenía foto.
    if (report.outcomeReason === "rechazado" && !report.hasPhoto) {
      fail("foto", "Adjunta la foto del rechazo.");
    }
    if ((report.collectedAmount ?? 0) > 0) {
      fail("monto", "Marcaste que no se entregó pero declaraste dinero cobrado.");
    }
  }

  return { ok: errors.length === 0, errors, fields };
}

/**
 * ¿El reporte de una no entrega lleva foto? El rechazo siempre, porque se
 * cobra; cualquier otra no entrega solo cuando reporta otra persona por el
 * motorizado. Es lo que decide si el teléfono muestra el campo de la foto.
 */
export function nonDeliveryNeedsPhoto(reason: string | null | undefined, delegated: boolean): boolean {
  return delegated || reason === "rechazado";
}

/** Lo mínimo de una parada para saber si le falta la foto al liquidar. */
export interface EvidenceStop {
  seq?: number;
  status: string;
  outcome_reason: string | null;
  photo_path: string | null;
  order?: { name: string | null } | null;
  /**
   * El ítem ACTIVO de la caja de Grupo GF de la que salió la parada (0185).
   * Un «No entregado» que todavía lo tiene sigue dentro de la caja: nadie lo
   * recibió en oficina.
   */
  manifest_item_id?: string | null;
}

/**
 * Desde qué ruta el rechazo exige foto (MOM §29.7). Hasta el 27/09 el teléfono
 * no la pedía al rechazar —solo a la entrega— y ya no hay puerta que
 * fotografiar: esos rechazos no frenan ni el cierre ni el pago del motorizado
 * (decisión de Frankz, 28-09-2026). La misma fecha vive en `rider_pay_preview`
 * (0197), para que cerrar y aprobar el pago digan lo mismo.
 */
export const REJECTION_PHOTO_FROM = "2026-09-28";

/** ¿Un rechazo de una ruta de ese día necesita foto? */
export function rejectionNeedsPhoto(routeDate: string): boolean {
  // Fechas ISO: el orden de texto es el del calendario, también con hora.
  return routeDate >= REJECTION_PHOTO_FROM;
}

/**
 * Entregas y rechazos sin foto: lo que no deja liquidar (MOM §29.7). La
 * entrega la exige siempre; el rechazo, solo en rutas desde el 28/09.
 */
export function stopsMissingEvidence<T extends EvidenceStop>(stops: readonly T[], routeDate: string): T[] {
  const rechazoConFoto = rejectionNeedsPhoto(routeDate);
  return stops.filter((stop) => !stop.photo_path && (stop.status === "entregado" || (rechazoConFoto && stop.outcome_reason === "rechazado")));
}

/**
 * El error de liquidación NOMBRA las paradas. «Falta evidencia» a secas
 * obligaba a revisar las 19 filas de la ruta para encontrar el único rechazo
 * sin foto (Yhoni, 23/09).
 */
export function missingEvidenceMessage(stops: readonly EvidenceStop[]): string | null {
  if (!stops.length) return null;
  const nombres = stops.map((stop) => {
    const pedido = stop.order?.name ?? `parada ${stop.seq ?? "sin número"}`;
    return `${pedido} (${stop.status === "entregado" ? "entregado" : "rechazó el pedido"})`;
  });
  const cuantas = stops.length === 1 ? "1 parada" : `${stops.length} paradas`;
  return `Falta la foto en ${cuantas}: ${nombres.join(", ")}. Adjúntala con «Corregir» en la ruta del motorizado o desde «Reportar entregas», y vuelve a terminar la ruta.`;
}

/** Una carga de Grupo GF ligada a la ruta que todavía no pasó a custodia. */
export interface OpenLoad {
  id: string;
  load_number: number;
  state: string;
  /** Paquetes activos. Una carga vacía no se recibe: se cancela con motivo. */
  items: number;
}

/**
 * Lo que impide terminar una ruta. `forceable` solo existe fuera de Grupo GF:
 * ahí el coordinador puede cerrar con paradas sin reportar a conciencia.
 */
export type RouteCloseBlocker =
  | { kind: "carga_sin_recibir"; loads: OpenLoad[] }
  | { kind: "sin_paradas" }
  | { kind: "sin_reportar"; stops: EvidenceStop[]; forceable: boolean }
  | { kind: "sin_foto"; stops: EvidenceStop[] }
  /**
   * «No entregado» que siguen dentro de la caja (29-09-2026). Se puede cerrar
   * igual —el motorizado propio los devuelve al día siguiente (MOM §9.4)—,
   * pero a conciencia: así quedaron 78 atrapados en cajas del 16 al 28/09.
   */
  | { kind: "sin_recibir"; stops: EvidenceStop[]; forceable: true };

/** Lo que el coordinador puede saltar a conciencia con «Cerrar igual». */
export function isForceableBlocker(blocker: RouteCloseBlocker): boolean {
  return (blocker.kind === "sin_reportar" && blocker.forceable) || blocker.kind === "sin_recibir";
}

/**
 * Los «No entregado» de la ruta que siguen en su caja de Grupo GF. Mismo
 * criterio que el escaneo de Despacho del día: un ítem activo es un paquete que
 * la caja todavía dice tener.
 */
export function stopsNotReceived<T extends EvidenceStop>(stops: readonly T[]): T[] {
  return stops.filter((stop) => stop.status === "no_entregado" && !!stop.manifest_item_id);
}

/**
 * Todo lo que impide terminar la ruta, en el orden en que lo comprueba el
 * cierre. PURA. La usan el servidor —el primero que no se pueda forzar es el
 * error— y el panel de la ruta, que los enseña TODOS antes de pulsar y con su
 * arreglo. Antes el coordinador los descubría de a uno: pulsaba, leía un error,
 * lo arreglaba, pulsaba otra vez y aparecía el siguiente.
 */
export function routeCloseBlockers(input: {
  isGf: boolean;
  openLoads: readonly OpenLoad[];
  stops: readonly EvidenceStop[];
  /** Día de la ruta: decide si sus rechazos exigen foto (`rejectionNeedsPhoto`). */
  routeDate: string;
}): RouteCloseBlocker[] {
  const out: RouteCloseBlocker[] = [];
  // En Grupo GF las paradas nacen al recibir la carga: con una carga abierta,
  // «sin paradas» sería el síntoma y no la causa.
  if (input.isGf && input.openLoads.length) {
    out.push({ kind: "carga_sin_recibir", loads: [...input.openLoads].sort((a, b) => a.load_number - b.load_number) });
  } else if (!input.stops.length) {
    out.push({ kind: "sin_paradas" });
  }
  const pendientes = input.stops.filter((stop) => stop.status === "pendiente");
  if (pendientes.length) out.push({ kind: "sin_reportar", stops: pendientes, forceable: !input.isGf });
  if (input.isGf) {
    const sinFoto = stopsMissingEvidence(input.stops, input.routeDate);
    if (sinFoto.length) out.push({ kind: "sin_foto", stops: sinFoto });
    const sinRecibir = stopsNotReceived(input.stops);
    if (sinRecibir.length) out.push({ kind: "sin_recibir", stops: sinRecibir, forceable: true });
  }
  return out;
}

/** «#KP1, #KP2, #KP3, #KP4, #KP5 y 3 más»: cabe en una línea de error. */
function orderList(stops: readonly EvidenceStop[], max = 5): string {
  const names = stops.map((stop) => stop.order?.name ?? `parada ${stop.seq ?? "sin número"}`);
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} y ${names.length - max} más`;
}

/** El mensaje de UN bloqueo: qué pasa, con qué pedidos, y cómo se arregla. */
export function routeCloseBlockerMessage(blocker: RouteCloseBlocker): string {
  switch (blocker.kind) {
    case "carga_sin_recibir":
      return blocker.loads
        .map((load) => load.items === 0
          ? `La carga ${load.load_number} está abierta y vacía: cancélala con motivo.`
          : `La carga ${load.load_number} tiene ${load.items === 1 ? "1 paquete" : `${load.items} paquetes`} sin recibir: que el motorizado la reciba o retira desde la caja los paquetes que no van.`)
        .join(" ");
    case "sin_paradas":
      return "La ruta no tiene paradas: no hay nada que terminar ni liquidar.";
    case "sin_reportar": {
      const una = blocker.stops.length === 1;
      const cuantas = una ? "1 parada" : `${blocker.stops.length} paradas`;
      return blocker.forceable
        ? `${una ? "Queda" : "Quedan"} ${cuantas} sin reportar. Espera a que las reporte o ciérrala igual a conciencia.`
        : `${una ? "Falta" : "Faltan"} ${cuantas} por reportar: ${orderList(blocker.stops)}. Repórtalas en «Reportar entregas»; en Grupo GF no se cierra sin reporte.`;
    }
    case "sin_foto":
      return missingEvidenceMessage(blocker.stops) ?? "Falta la foto de una entrega o un rechazo.";
    case "sin_recibir": {
      const uno = blocker.stops.length === 1;
      return `${uno ? "Falta recibir en oficina 1 paquete «No entregado»" : `Faltan recibir en oficina ${blocker.stops.length} paquetes «No entregado»`}: ${orderList(blocker.stops)}. Si ya ${uno ? "volvió, recíbelo" : "volvieron, recíbelos"} con «Recibir en oficina»; si ${uno ? "vuelve" : "vuelven"} después, ciérrala igual: ${uno ? "queda" : "quedan"} en «Devoluciones» y se ${uno ? "recibe" : "reciben"} al escanear${uno ? "lo" : "los"}.`;
    }
  }
}

/** Una parada tal como está guardada, para los totales de la ruta. */
export interface RouteStop {
  id: string;
  order_id: string;
  status: StopStatus;
  payment_method: string | null;
  collected_amount: number | null;
}

export interface RouteTotals {
  total: number;
  pendientes: number;
  entregados: number;
  noEntregados: number;
  /** Cobrado por método, para saber cuánto efectivo debe traer en la mano. */
  efectivo: number;
  yape: number;
  pos: number;
  /** Todo lo cobrado, sea como sea. */
  cobradoTotal: number;
  /** ¿Ya reportó todas sus paradas? Es la condición para cerrar sin forzar. */
  completa: boolean;
}

export function routeTotals(stops: readonly RouteStop[]): RouteTotals {
  const by = (method: string) =>
    round2(
      stops
        .filter((s) => s.status === "entregado" && s.payment_method === method)
        .reduce((sum, s) => sum + Math.max(0, s.collected_amount ?? 0), 0),
    );

  const efectivo = by("efectivo");
  const yape = by("yape");
  const pos = by("pos");
  const pendientes = stops.filter((s) => s.status === "pendiente").length;

  return {
    total: stops.length,
    pendientes,
    entregados: stops.filter((s) => s.status === "entregado").length,
    noEntregados: stops.filter((s) => s.status === "no_entregado").length,
    efectivo,
    yape,
    pos,
    cobradoTotal: round2(efectivo + yape + pos),
    completa: stops.length > 0 && pendientes === 0,
  };
}

/**
 * Lo que se le paga al motorizado por la ruta.
 *
 * Usa el mismo motor que todo lo demás (`resolveTariff`), así que una tarifa
 * plana de S/ 8.50 es sencillamente una tarifa sin ámbito: se configura una vez
 * en Costos, lleva fecha de vigencia y, si mañana sube, lo que se pagó ayer no
 * se reescribe.
 *
 * Solo se paga lo ENTREGADO por defecto. Que una visita fallida se pague o no
 * es una decisión de la empresa, no del cálculo: si hay tarifa de visita
 * configurada, se aplica; si no la hay, esas paradas valen cero y no se
 * reportan como tarifa faltante, porque no tenerla es una postura válida.
 */
export interface RoutePayout {
  entregas: number;
  visitas: number;
  amount: number;
  /** Entregas sin tarifa vigente ese día: hay que definirla antes de cerrar. */
  missingTariffs: number;
}

export function computeRoutePayout(
  stops: readonly RouteStop[],
  tariffs: readonly CostTariff[],
  ctx: CostContext,
  day: string,
): RoutePayout {
  const entregas = stops.filter((s) => s.status === "entregado");
  const visitas = stops.filter((s) => s.status === "no_entregado");

  const perDelivery = resolveTariff(tariffs, "motorizado_entrega", ctx, day);
  const perVisit = resolveTariff(tariffs, "motorizado_visita", ctx, day);

  const amount = round2(
    entregas.length * (perDelivery?.amount ?? 0) + visitas.length * (perVisit?.amount ?? 0),
  );

  return {
    entregas: entregas.length,
    visitas: visitas.length,
    amount,
    // Solo la de entrega se considera obligatoria: sin ella el pago sería cero
    // en silencio. La de visita ausente significa "las visitas no se pagan".
    missingTariffs: entregas.length > 0 && !perDelivery ? 1 : 0,
  };
}

/**
 * Convierte las paradas de una ruta cerrada en líneas de liquidación.
 *
 * Aquí está la ganancia de todo el módulo: las líneas nacen YA vinculadas a su
 * pedido (`order_id` viene de la asignación, no de adivinar un nombre), así que
 * la liquidación de un motorizado propio no tiene cola de revisión. Es la misma
 * estructura que produce el lector de Excel, para que el cuadre sea uno solo.
 */
export interface SettlementLineDraft {
  order_id: string;
  declared_status: string;
  declared_amount: number | null;
  match_status: "ok";
  raw: Record<string, string>;
}

export function stopsToSettlementLines(
  stops: readonly RouteStop[],
): SettlementLineDraft[] {
  return stops
    .filter((s) => s.status !== "pendiente")
    .map((s) => ({
      order_id: s.order_id,
      declared_status: s.status === "entregado" ? "entregado" : "no entregado",
      // Una no-entrega declara cero, no null: el motorizado SÍ reportó, y dijo
      // que no cobró nada. Es distinto de "no lo declaró".
      declared_amount: s.status === "entregado" && s.payment_method !== "sin_cobro" ? round2(Math.max(0, s.collected_amount ?? 0)) : 0,
      match_status: "ok" as const,
      raw: {
        origen: "ruta",
        estado: s.status,
        metodo: s.payment_method ?? "",
        monto: s.collected_amount === null ? "" : String(s.collected_amount),
      },
    }));
}

// ---------------------------------------------------------------------------
// Qué le pasa al PEDIDO cuando se cierra la ruta.
// ---------------------------------------------------------------------------

/**
 * Efecto de una parada sobre el estado del pedido en el Master.
 *
 * Con un courier externo el estado real lo trae su reporte; con motorizado
 * propio no viene nadie detrás, así que el cierre de la ruta es el único
 * momento en que el Master puede enterarse. Sin esto, un pedido entregado por
 * un motorizado propio se quedaría "pendiente" para siempre y el cuadre lo
 * marcaría como "cobro sin entrega" en todas y cada una de sus paradas.
 *
 * `null` = no se toca el pedido. Es la respuesta correcta para TODOS los
 * motivos de no entrega: que hoy no contestara no cambia nada del pedido, solo
 * significa que hay que volver. Cerrarlo sería perder una venta viva.
 *
 * Tampoco «Rechazó el pedido» (v1.23, 30-09-2026). Hasta la v1.22 el cierre de
 * la ruta ANULABA el pedido por un rechazo. Regla del owner: solo la anulación
 * en Shopify termina la venta; el rechazo va a «Por reprogramar Lima» como
 * cualquier «No entregado», y lo lee el Master de la parada misma.
 */
export type StopEffect = "entregado" | null;

export function stopEffect(stop: {
  status: StopStatus;
  outcome_reason?: string | null;
}): StopEffect {
  return stop.status === "entregado" ? "entregado" : null;
}

export interface MasterEffect {
  order_id: string;
  target: Exclude<StopEffect, null>;
  reason: string;
}

/**
 * Los cambios que el cierre de una ruta debe aplicar al Master. Puro: quien
 * llama los escribe. Se devuelve la razón para que quede en el historial del
 * pedido y se entienda de dónde salió el cambio meses después.
 */
export function masterEffects(
  stops: readonly {
    order_id: string;
    status: StopStatus;
    outcome_reason?: string | null;
  }[],
): MasterEffect[] {
  const out: MasterEffect[] = [];
  for (const s of stops) {
    const target = stopEffect(s);
    if (!target) continue;
    out.push({
      order_id: s.order_id,
      target,
      reason: "Entregado por el motorizado y confirmado al cerrar la ruta.",
    });
  }
  return out;
}

/** Agrupa las paradas por tienda: una ruta mixta produce una liquidación por
 *  cada tienda, porque el dinero y el cuadre son por tienda. */
export function groupByStore<T extends { store_id: string | null }>(
  stops: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const s of stops) {
    if (!s.store_id) continue;
    const list = out.get(s.store_id);
    if (list) list.push(s);
    else out.set(s.store_id, [s]);
  }
  return out;
}
