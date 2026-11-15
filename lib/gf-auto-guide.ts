// Guía GF automática (MOM §29.17, «Guía GF automática», decisión del owner del
// 15-11-2026).
//
// POR QUÉ. GF Courier por API ya crea la guía desde la Mesa de ruta, pero cada
// pedido de Lima seguía esperando a que alguien pulsara el botón. El owner
// decidió que el día del despacho, en la mañana, Kapta la cree sola. Lo que una
// persona quiera mandar por Aliclik se crea antes de la primera pasada, y
// entonces GF ya no toma ese pedido.
//
// QUÉ HACE. A las 9:00, 10:00 y 11:00 de Lima crea la guía de GF Courier de los
// pedidos de Lima en Preparación · Por generar rótulo con el envío programado
// para HOY o sin fecha, de las tiendas con GF Courier por API habilitado. Por el
// mismo camino que la tarjeta de la Mesa de ruta (`createGfGuideFor`,
// lib/gf-courier-guide.ts), con sus compuertas y su intención idempotente.
//
// QUÉ NO HACE. No toca Agencia ni Provincia, ni un pedido programado para otro
// día (tampoco uno cuyo día ya pasó: ese es de una persona), ni uno que ya
// tiene guía de cualquier courier, ni un acompañante que viaja en la caja de
// otro pedido (§32). Si la guía no sale —falta el SKU, el apellido o el
// distrito, o GF responde SKU_NOT_FOUND, DISTRICT_NOT_COVERED u OUT_OF_STOCK—,
// deja el hecho en el historial del pedido y avisa por Telegram de ESE pedido.
// Un intento por pedido y día: lo que falló lo toma una persona.
//
// TRES POSICIONES, por organización, en el panel de Automatizaciones (§40):
// Apagado no hace nada; Simulación dice qué guía habría creado y no crea nada
// afuera; Activo la crea. Nace Apagado.
//
// Pura: lo que lee la base y llama a GF vive en lib/gf-auto-guide-server.ts.

import { classifyOperation } from "@/lib/order-macro-stage";
import { dispatchDateLabel } from "@/lib/dispatch-date";
import { RETRY_MODE_LABEL, isRetryMode, type RetryMode } from "@/lib/lima-retry-auto";
import { compareGfCatalog, type GfCatalogProduct } from "@/lib/gf-courier-catalog";
import { escapeHtml } from "@/lib/telegram";
import type { OrderMasterRow } from "@/lib/types";

/** El hecho que deja un intento fallido. Es también lo que impide repetirlo ese día. */
export const GF_AUTO_FAILED = "gf_auto_guide_failed";
export const GF_AUTO_POLICY = "gf-auto-v1";

/**
 * Las pasadas, en hora de Lima: 9:00, 10:00 y 11:00 del día del despacho
 * (`0 14,15,16 * * *` en vercel.json, Lima es UTC−5 todo el año). Varias y no
 * una: un pedido que llega o se programa para hoy a media mañana también entra.
 */
export const GF_AUTO_PASS_HOURS_LIMA = [9, 10, 11] as const;
export const GF_AUTO_FIRST_HOUR_LIMA = GF_AUTO_PASS_HOURS_LIMA[0];
export const GF_AUTO_LAST_HOUR_LIMA = GF_AUTO_PASS_HOURS_LIMA[2];

/** ¿Es hora de una pasada que crea? De 9:00 a 11:59 de Lima. Fuera de eso, solo la simulación a mano (`?dry=1`). */
export function gfAutoPassOpen(limaHour: number): boolean {
  return limaHour >= GF_AUTO_FIRST_HOUR_LIMA && limaHour <= GF_AUTO_LAST_HOUR_LIMA;
}

/** Apagado / Simulación / Activo: las mismas tres posiciones que el resto del panel. */
export type GfAutoMode = RetryMode;
export const GF_AUTO_MODE_LABEL = RETRY_MODE_LABEL;

/** La posición guardada; sin fila, sin la 0345 o con un valor raro, Apagado. */
export function gfAutoModeFrom(value: unknown): GfAutoMode {
  return isRetryMode(value) ? value : "apagado";
}

export type GfAutoRow = Pick<
  OrderMasterRow,
  | "dispatch_scheduled_on"
  | "macro_stage"
  | "macro_substage"
  | "shipping_mode"
  | "coverage"
  | "region"
  | "province"
  | "district"
>;

/**
 * Por qué un pedido no entra a la pasada de hoy:
 *   * `otro_dia`   — programado para otro día, futuro o ya pasado;
 *   * `otra_etapa` — no está en Preparación · Por generar rótulo (ya tiene guía,
 *                    o es acompañante: «Viaja en la caja de otro pedido»);
 *   * `no_lima`    — Agencia o Provincia (`classifyOperation`).
 */
export type GfAutoSkip = "otro_dia" | "otra_etapa" | "no_lima";

/** Por qué este pedido no entra a la pasada de hoy, o null si entra. Sin fecha programada, entra. */
export function gfAutoSkip(row: GfAutoRow, todayLima: string): GfAutoSkip | null {
  if (row.dispatch_scheduled_on && row.dispatch_scheduled_on !== todayLima) return "otro_dia";
  if (row.macro_stage !== "preparacion" || row.macro_substage !== "por_generar_rotulo") return "otra_etapa";
  if (classifyOperation(row) !== "lima") return "no_lima";
  return null;
}

type EventLike = { kind: string; payload?: unknown };

/** ¿El automático ya lo intentó hoy y falló? Entonces es de una persona hasta mañana. */
export function gfAutoTriedOn(events: readonly EventLike[], date: string): boolean {
  return events.some(
    (event) => event.kind === GF_AUTO_FAILED && (event.payload as { date?: unknown } | null | undefined)?.date === date,
  );
}

/**
 * Lo que queda en el registro del panel por pedido, día de Lima y modo
 * (`gf_auto_guide_log.outcome`, 0345):
 *   * `simulada`  — en Simulación: habría creado la guía.
 *   * `creada`    — guía creada (lleva el número `GF…`).
 *   * `fallo`     — no se pudo crear: avisó por Telegram y dejó el hecho. En
 *                   Simulación: Activo no la crearía, y por qué.
 *   * `en_curso`  — otra creación del mismo pedido está en marcha, o GF no
 *                   respondió a tiempo: la intención queda pendiente y la
 *                   resuelve `gf-reconcile` o la pasada siguiente, con la misma
 *                   clave de idempotencia. No es un fallo y no avisa.
 */
export const GF_AUTO_OUTCOMES = ["simulada", "creada", "fallo", "en_curso"] as const;
export type GfAutoOutcome = (typeof GF_AUTO_OUTCOMES)[number];

export function isGfAutoOutcome(value: unknown): value is GfAutoOutcome {
  return typeof value === "string" && (GF_AUTO_OUTCOMES as readonly string[]).includes(value);
}

export const GF_AUTO_OUTCOME_LABEL: Record<GfAutoOutcome, string> = {
  simulada: "Habría creado la guía",
  creada: "Guía creada",
  fallo: "No se pudo crear",
  en_curso: "Creándose: se mira en la pasada siguiente",
};

/** En Simulación, `fallo` es lo que Activo haría: no la crearía. */
export function gfAutoOutcomeLabel(outcome: GfAutoOutcome, mode: "simulacion" | "activo"): string {
  return mode === "simulacion" && outcome === "fallo" ? "No la crearía" : GF_AUTO_OUTCOME_LABEL[outcome];
}

/**
 * Por qué Activo no crearía nada en esta organización, o null. Un automático
 * que depende de otra función no se enciende con ella apagada (§40): sin la
 * llave del servidor o sin ninguna tienda con GF Courier por API, Activo no
 * se deja elegir, y si ya estaba, el panel dice «Está en Activo, pero no corre».
 */
export function gfAutoActivoBlocker(input: { writeEnabled: boolean; readyStores: number }): string | null {
  if (!input.writeEnabled) return "GF Courier por API está apagado en el servidor (GF_COURIER_WRITE_ENABLED): no se crea ninguna guía.";
  if (input.readyStores <= 0) {
    return "Ninguna tienda tiene GF Courier por API habilitado con su token (Ajustes de la tienda → GF Courier).";
  }
  return null;
}

/**
 * ¿Algún SKU del pedido haría fallar a GF? La simulación no llama a
 * POST /v1/orders: compara los SKU con el catálogo de la tienda en GF
 * (GET /v1/products, solo lectura). La cobertura del distrito y los montos solo
 * los responde GF al crear. Pura.
 */
export function gfCatalogProblem(skus: readonly string[], products: readonly GfCatalogProduct[]): string | null {
  const unique = [...new Set(skus.map((s) => s.trim()).filter(Boolean))];
  const verdict = compareGfCatalog(unique.map((sku) => ({ sku, name: sku })), products);
  if (verdict.missingInGf.length) {
    return `GF no tiene en su catálogo ${skuList(verdict.missingInGf.map((r) => r.sku))}: respondería SKU_NOT_FOUND.`;
  }
  if (verdict.outOfStock.length) {
    return `GF tiene Agotado ${skuList(verdict.outOfStock.map((r) => r.sku))}: respondería OUT_OF_STOCK.`;
  }
  return null;
}

function skuList(skus: readonly string[]): string {
  return skus.length === 1 ? `el SKU ${skus[0]}` : `los SKU ${skus.join(", ")}`;
}

/** Lo que dice la simulación de una guía que habría creado. Pura. */
export function gfAutoSimulationDetail(input: {
  amountToCollect: number;
  units: number;
  district: string | null;
  /** El catálogo de GF no se pudo leer: no se comprobaron los SKU. */
  catalogNote?: string | null;
}): string {
  const parts = [
    input.amountToCollect > 0 ? `Cobraría S/ ${input.amountToCollect.toFixed(2)}` : "Sin cobro en la puerta (pagado)",
    `${input.units} ${input.units === 1 ? "producto" : "productos"}`,
    ...(input.district?.trim() ? [input.district.trim()] : []),
  ];
  const line = `${parts.join(" · ")}.`;
  return input.catalogNote ? `${line} ${input.catalogNote}` : line;
}

/** Cuánto del motivo cabe en la alerta. El resto está en el historial del pedido. */
const ALERT_REASON_MAX = 600;

/** Qué día entró: programado para hoy, o sin fecha. Pura. */
export function gfAutoDayLine(date: string, scheduled: boolean): string {
  return scheduled
    ? `Programado para hoy, ${dispatchDateLabel(date)}.`
    : `Sin fecha programada: entró en la pasada de hoy, ${dispatchDateLabel(date)}.`;
}

/** La alerta de Telegram de UN pedido cuya guía GF automática no se pudo crear. Pura. */
export function gfAutoFailureTelegram(input: {
  storeName: string;
  orderName: string | null;
  customerName: string | null;
  place: string | null;
  date: string;
  scheduled: boolean;
  error: string;
  url: string;
}): string {
  const reason = input.error.length > ALERT_REASON_MAX ? `${input.error.slice(0, ALERT_REASON_MAX - 1)}…` : input.error;
  const who = [input.customerName, input.place].filter(Boolean).join(" · ");
  return [
    `⚠️ <b>${escapeHtml(input.storeName)}</b> · guía GF Courier automática no creada`,
    `<b>${escapeHtml(input.orderName ?? "Pedido sin número")}</b>${who ? ` · ${escapeHtml(who)}` : ""}`,
    escapeHtml(gfAutoDayLine(input.date, input.scheduled)),
    "",
    `Motivo: ${escapeHtml(reason)}`,
    "",
    "Hoy no se vuelve a intentar. Créala a mano desde la Mesa de ruta:",
    escapeHtml(input.url),
  ].join("\n");
}

/** El motivo del hecho `guide_registered` de una guía que creó la pasada: el historial dice que fue automática. */
export const GF_AUTO_GUIDE_REASON = "Guía GF automática: despacho de hoy (pasadas de 9:00 a 11:00).";

/** La nota del hecho `gf_auto_guide_failed` en el historial del pedido. */
export const GF_AUTO_FAILED_NOTE =
  "No se pudo crear la guía GF Courier automática de hoy. Hoy no se vuelve a intentar: hay que crearla a mano desde la Mesa de ruta.";
