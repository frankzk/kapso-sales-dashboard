// Guía GF automática (MOM §29.17, «Guía GF automática», decisión del owner del
// 15-11-2026).
//
// POR QUÉ. GF Courier por API ya crea la guía desde la Mesa de ruta, pero cada
// pedido de Lima seguía esperando a que alguien pulsara el botón. El owner
// decidió que Kapta la cree sola: primero la mañana del despacho (15-11-2026) y,
// desde el 16-11-2026, «ni bien entra el pedido». Lo que una persona quiera
// mandar por Aliclik se programa con Aliclik en Repro Lima, o se crea su guía:
// la de Aliclik anula sola la guía GF que siga sin asignar.
//
// QUÉ HACE. Cada 10 minutos, todo el día, crea la guía de GF Courier de los
// pedidos de Lima en Preparación · Por generar rótulo, sin fecha (GF la
// programa) o programados para hoy o un día que viene (la guía va con ese día,
// `scheduled_date`), de las tiendas con GF Courier por API habilitado. Por el
// mismo camino que la tarjeta de la Mesa de ruta (`createGfGuideFor`,
// lib/gf-courier-guide.ts), con sus compuertas y su intención idempotente.
//
// QUÉ NO HACE. No toca Agencia ni Provincia, ni un pedido cuyo día programado
// ya pasó (ese es de una persona), ni uno programado con otro courier, ni uno que ya
// tiene guía de cualquier courier, ni un acompañante que viaja en la caja de
// otro pedido (§32), ni uno con un acuerdo de Repro Lima con la clienta: el
// acuerdo decide el día y el courier (§9.5, owner 15-11-2026). Si la guía no sale —falta el SKU, el apellido o el
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
import { programDayLabel } from "@/lib/dispatch-day";
import { reproAttentionEpisodeKey, reproCourierName } from "@/lib/repro-lima";
import type { OrderMasterRow } from "@/lib/types";

/** El hecho que deja un intento fallido. Es también lo que impide repetirlo ese día. */
export const GF_AUTO_FAILED = "gf_auto_guide_failed";
export const GF_AUTO_POLICY = "gf-auto-v1";

/**
 * Las pasadas: cada 10 minutos, todo el día (owner, 16-11-2026: «el de GF
 * Courier debe ser ni bien entra el pedido»; antes, 9:00, 10:00 y 11:00 de
 * Lima). Así lo que entra a «Por generar rótulo» tiene su guía en minutos.
 */
export const GF_AUTO_CRON = "2,12,22,32,42,52 * * * *";

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
  | "dispatch_courier"
  | "macro_stage"
  | "macro_substage"
  | "shipping_mode"
  | "coverage"
  | "region"
  | "province"
  | "district"
>;

/**
 * Por qué un pedido no entra a la pasada:
 *   * `dia_pasado` — su día programado ya pasó sin guía (la chapa roja «no
 *                    salió» es para una persona). Un día que viene sí entra:
 *                    la guía va con ese día (16-11-2026);
 *   * `otra_etapa` — no está en Preparación · Por generar rótulo (ya tiene guía,
 *                    o es acompañante: «Viaja en la caja de otro pedido»);
 *   * `no_lima`    — Agencia o Provincia (`classifyOperation`);
 *   * `otro_courier` — «Programar envío» eligió otro courier (Aliclik, Swayp,
 *                    Grupo GF; 0348, owner 16-11-2026): sale con ese.
 */
export type GfAutoSkip = "dia_pasado" | "otra_etapa" | "no_lima" | "otro_courier";

/** Por qué este pedido no entra a la pasada, o null si entra. Sin fecha, hoy o un día que viene, entra. */
export function gfAutoSkip(row: GfAutoRow, todayLima: string): GfAutoSkip | null {
  if (row.dispatch_scheduled_on && row.dispatch_scheduled_on < todayLima) return "dia_pasado";
  if (row.macro_stage !== "preparacion" || row.macro_substage !== "por_generar_rotulo") return "otra_etapa";
  if (classifyOperation(row) !== "lima") return "no_lima";
  if (row.dispatch_courier && row.dispatch_courier !== "gf_courier") return "otro_courier";
  return null;
}

/** Lo de un caso de Repro Lima que hace falta para saber si manda sobre la pasada. */
export interface GfAutoReproCase {
  order_id: string;
  episode_key: string;
  agreed_on: string | null;
  agreed_courier?: string | null;
  closed_at?: string | null;
}

/**
 * El acuerdo de Repro Lima que manda sobre la pasada, o null (owner,
 * 15-11-2026; MOM §9.5, §29.17): un caso abierto con día acordado
 * (`agreed_on`) en su episodio vigente. Los pedidos de la pasada están en
 * Preparación · Por generar rótulo: su episodio es el de atención
 * (`reproAttentionEpisodeKey`, el mismo que usa `loadReproFacts`). Un caso de
 * otro episodio ya no vale (Repro Lima lo cierra al leer). El acuerdo decide
 * el día y el courier: la guía la crea Repro Lima, o una persona. PURA.
 */
export function gfAutoReproAgreement(orderId: string, cases: readonly GfAutoReproCase[]): GfAutoReproCase | null {
  const episode = reproAttentionEpisodeKey(orderId);
  return cases.find((c) => c.order_id === orderId && !c.closed_at && Boolean(c.agreed_on) && c.episode_key === episode) ?? null;
}

/** Lo que dice la pasada de un pedido que no toma por su acuerdo de Repro Lima. */
export function gfAutoReproDetail(c: Pick<GfAutoReproCase, "agreed_on" | "agreed_courier">): string {
  const day = c.agreed_on ? programDayLabel(c.agreed_on.slice(0, 10)) : "el día acordado";
  return `Tiene un acuerdo en Repro Lima: sale el ${day} con ${reproCourierName(c.agreed_courier)}. El acuerdo decide el día y el courier.`;
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
export function gfAutoDayLine(date: string, scheduledOn: string | null): string {
  if (!scheduledOn) return `Sin fecha programada: entró en la pasada de hoy, ${dispatchDateLabel(date)}.`;
  return scheduledOn === date ? `Programado para hoy, ${dispatchDateLabel(date)}.` : `Programado para el ${dispatchDateLabel(scheduledOn)}.`;
}

/** La alerta de Telegram de UN pedido cuya guía GF automática no se pudo crear. Pura. */
export function gfAutoFailureTelegram(input: {
  storeName: string;
  orderName: string | null;
  customerName: string | null;
  place: string | null;
  date: string;
  /** El día de «Programar envío», o null sin fecha. */
  scheduledOn: string | null;
  error: string;
  url: string;
}): string {
  const reason = input.error.length > ALERT_REASON_MAX ? `${input.error.slice(0, ALERT_REASON_MAX - 1)}…` : input.error;
  const who = [input.customerName, input.place].filter(Boolean).join(" · ");
  return [
    `⚠️ <b>${escapeHtml(input.storeName)}</b> · guía GF Courier automática no creada`,
    `<b>${escapeHtml(input.orderName ?? "Pedido sin número")}</b>${who ? ` · ${escapeHtml(who)}` : ""}`,
    escapeHtml(gfAutoDayLine(input.date, input.scheduledOn)),
    "",
    `Motivo: ${escapeHtml(reason)}`,
    "",
    "Hoy no se vuelve a intentar. Créala a mano desde la Mesa de ruta:",
    escapeHtml(input.url),
  ].join("\n");
}

/** El motivo del hecho `guide_registered` de una guía que creó la pasada: el historial dice que fue automática. */
export const GF_AUTO_GUIDE_REASON = "Guía GF automática: al entrar a Por generar rótulo.";

/** La nota del hecho `gf_auto_guide_failed` en el historial del pedido. */
export const GF_AUTO_FAILED_NOTE =
  "No se pudo crear la guía GF Courier automática de hoy. Hoy no se vuelve a intentar: hay que crearla a mano desde la Mesa de ruta.";
