// Swayp automático desde Por confirmar — piloto A/B (MOM §11.13, 13-10-2026).
//
// QUÉ ES. El botón «Enviar por Swayp» de la mesa de confirmación (§11.11),
// pulsado por una pasada diaria en vez de por una persona, sobre un grupo
// angosto de pedidos y con la mitad de ellos como grupo de control.
//
// POR QUÉ ASÍ, CON LOS NÚMEROS DEL 13-10-2026. El botón llevaba 22 envíos y 2
// entregas de 15 resueltos (13 %). Los 6 más viejos —de 4 a 7 llamadas sin
// respuesta, de 5 a 14 días esperando— fallaron todos; las 2 entregas fueron
// pedidos del día, con una sola llamada. En todas las guías Swayp desde el
// 15-09 el primer motivo de fallo es «destinatario no contesta» (41 %): quien
// no le contesta a la asesora tampoco le contesta al motorizado. Por eso el
// automático mira pedidos FRESCOS (48 h) con a lo sumo 2 llamadas sin
// respuesta, y no los que llevan días sin contestar.
//
// LO QUE DECIDIÓ EL OWNER: sin aviso previo por WhatsApp, hasta 48 h y piloto
// A/B de 10 por día. El resto de umbrales son los de la propuesta y viven en
// `swayp_pc_auto_settings`, no en el código.
//
// Este archivo es PURO: decide sobre datos ya cargados. El servidor
// (`swayp-por-confirmar-auto-server.ts`) carga los datos, corrobora la
// ubicación con Aliclik, lee el inventario en vivo de Swayp y emite por el
// mismo camino que el botón (`emitirGuiaSwaypDirecta`).

import { normalizePhone } from "@/lib/phone";
import { explicitRejection, productsOverlap } from "@/lib/swayp-auto-policy";
import type { OrderLineItem } from "@/lib/types";
import type { PcAutoArm } from "@/lib/swayp-pc-auto-labels";

export { PC_AUTO_ARM_LABEL, PC_AUTO_REASONS, type PcAutoArm } from "@/lib/swayp-pc-auto-labels";

export interface PorConfirmarAutoSettings {
  org_id: string;
  enabled: boolean;
  /** Emisiones por día de Lima, en toda la organización. */
  daily_cap: number;
  /** Emisiones por día y por bodega Swayp. */
  per_warehouse_cap: number;
  /** Antigüedad máxima del pedido, en horas. */
  max_age_hours: number;
  /** Llamadas mínimas antes de salir: la asesora tiene su oportunidad primero. */
  min_attempts: number;
  /** Llamadas sin respuesta como máximo. */
  max_unanswered: number;
  /** Importe máximo del pedido, en soles. */
  max_amount: number;
  /** Cuántos casos resueltos mira el freno. */
  brake_window: number;
  /** Por debajo de esta tasa de entrega, el freno lo apaga. */
  brake_min_rate: number;
  paused_reason?: string | null;
}

export const DEFAULT_PC_AUTO_SETTINGS: Omit<PorConfirmarAutoSettings, "org_id"> = {
  enabled: false,
  daily_cap: 10,
  per_warehouse_cap: 3,
  max_age_hours: 48,
  min_attempts: 1,
  max_unanswered: 2,
  max_amount: 300,
  brake_window: 20,
  brake_min_rate: 0.35,
  paused_reason: null,
};

/**
 * El brazo de un pedido, fijo y repetible: el mismo pedido cae siempre en el
 * mismo lado, en cada pasada y en cada servidor. FNV-1a sobre el id; la mitad
 * va a cada brazo.
 */
export function brazoDe(orderId: string): PcAutoArm {
  let h = 0x811c9dc5;
  for (let i = 0; i < orderId.length; i++) {
    h ^= orderId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2 === 0 ? "swayp" : "control";
}

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const MESES = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre";

/**
 * ¿La dirección dice DÓNDE? Calle con número, o manzana y lote (Mz B Lt 3,
 * «lote E19»). Lo pidió el owner el 12-10-2026: «Av. Las Torres» sin número no
 * sirve.
 *
 * No cuentan como número los de una fecha que da nombre a la calle («Av. 31 de
 * octubre y Esperanza»), ni la etapa de una urbanización («1ra etapa»), ni un
 * código pegado a una palabra («Las Dunas D2», «F16»): esos son dudosos y los
 * mira una persona.
 */
export function direccionConNumero(address: string | null | undefined): boolean {
  let t = ` ${sinTildes(address ?? "")} `;
  if (!t.trim()) return false;
  t = t.replace(new RegExp(`\\b\\d{1,2}\\s+de\\s+(?:${MESES})\\b`, "g"), " ");
  t = t.replace(/\b\d+\s*(?:ra|da|ta|era|ro|do|to|va|vo|ma|mo)?\s*etapa\b/g, " ");
  if (/\b(?:mz|mza|mzn|mzm|manzana)\b\.?\s*[a-z0-9]+.*\b(?:lt|lte|lot|lote)\b\.?\s*[a-z]?\d+/.test(t)) return true;
  if (/\blote\b\.?\s*[a-z]?\d+/.test(t)) return true;
  return /(?:^|[\s#°º.,-])(?:n(?:ro|ro\.|°|º)?\s*)?\d{1,5}[a-z]?(?=[\s,.-]|$)/.test(t);
}

/** ¿Pide recoger en una agencia? Swayp reparte a domicilio. */
export function esRecojoEnAgencia(...partes: (string | null | undefined)[]): boolean {
  const t = sinTildes(partes.filter(Boolean).join(" "));
  return /\b(?:shalom+|olva|agencia|recojo|recoger|oficina\s+de|terminal|marvisur|cruz\s+del\s+sur)\b/.test(t);
}

/** Lo que el servidor carga de cada candidato. */
export interface PcAutoCandidate {
  order: {
    id: string;
    store_id: string;
    name: string | null;
    created_at: string;
    cancelled_at: string | null;
    total_amount: number | null;
    total_refunded: number | null;
    currency: string | null;
    financial_status: string | null;
    customer_phone: string | null;
    shopify_note: string | null;
    line_items: OrderLineItem[] | null;
  };
  master: {
    macro_stage: string | null;
    macro_substage: string | null;
    coverage: string | null;
    swayp_availability: string | null;
    address: string | null;
    reference: string | null;
    district: string | null;
    province: string | null;
    region: string | null;
    latitude: number | null;
    longitude: number | null;
    confirmation_next_contact_on: string | null;
  };
  /** Gestiones de confirmación del pedido (`confirmation_contact`). */
  contacts: { result: string | null; note: string | null; occurred_at: string }[];
  /** Salidas vivas que no son una «por definir» rellenable. */
  liveOutputs: number;
  /** Pagos registrados del pedido: el piloto es contra entrega completa. */
  payments: number;
  /** Otros pedidos del mismo teléfono. */
  phoneHistory: {
    id: string;
    created_at: string;
    cancelled_at: string | null;
    delivered: boolean;
    /** Rechazó en la puerta, dijo que no compró o se descartó su recuperación. */
    rejected: boolean;
    /** Sigue vivo: ni entregado, ni cancelado, ni cerrado sin entrega. */
    open: boolean;
    line_items: OrderLineItem[] | null;
  }[];
}

/** Subetapas de Por confirmar donde el automático puede actuar. */
const SUBETAPAS = new Set(["sin_llamar", "por_confirmar"]);
const SIN_RESPUESTA = new Set(["sin_respuesta", "se_deja_mensaje"]);

export type PcAutoVerdict =
  | { eligible: false; reason: string }
  | { eligible: true; reason: "eligible"; arm: PcAutoArm; phone: string; recompra: boolean };

/**
 * ¿Este pedido puede salir solo por Swayp? Todo lo que se puede decidir sin
 * salir de la base. Lo que pide red —ubicación, inventario en vivo, vínculo— lo
 * decide el servidor después, solo para los que pasan esto.
 */
export function evaluarPorConfirmarAuto(
  c: PcAutoCandidate,
  s: PorConfirmarAutoSettings,
  now: Date,
): PcAutoVerdict {
  const no = (reason: string) => ({ eligible: false as const, reason });
  const o = c.order;
  const m = c.master;

  if (m.macro_stage !== "por_confirmar" || !SUBETAPAS.has(m.macro_substage ?? "")) return no("stage");
  if (m.coverage !== "provincia_cod") return no("not_provincia_cod");
  if (m.swayp_availability !== "ok") return no("not_swayp_ok");

  const horas = (now.getTime() - Date.parse(o.created_at)) / 3_600_000;
  if (!Number.isFinite(horas) || horas < 0 || horas > s.max_age_hours) return no("old_order");
  if (
    o.cancelled_at ||
    (o.total_refunded ?? 0) > 0 ||
    !(Number(o.total_amount) > 0) ||
    o.currency !== "PEN" ||
    o.financial_status !== "pending" ||
    !o.name
  ) {
    return no("invalid_order");
  }

  // La asesora va primero; y quien ya no contesta, tampoco le va a contestar a Swayp.
  if (c.contacts.length < s.min_attempts) return no("no_attempt");
  if (c.contacts.filter((x) => SIN_RESPUESTA.has(x.result ?? "")).length > s.max_unanswered) {
    return no("too_many_unanswered");
  }
  if (
    c.contacts.some((x) => x.result === "volver_a_contactar" || x.result === "pendiente_de_abono") ||
    (m.confirmation_next_contact_on && m.confirmation_next_contact_on.slice(0, 10) > now.toISOString().slice(0, 10))
  ) {
    return no("scheduled");
  }

  if (esRecojoEnAgencia(m.address, m.reference)) return no("agency");
  if (!direccionConNumero(m.address) || !(m.district ?? "").trim() || !((m.province ?? m.region ?? "").trim())) {
    return no("address");
  }

  const phone = normalizePhone(o.customer_phone);
  if (!phone || !/^519\d{8}$/.test(phone)) return no("phone");
  if (Number(o.total_amount) > s.max_amount) return no("amount");
  if (c.payments > 0) return no("payment");
  if (c.liveOutputs > 0) return no("live_output");

  const items = o.line_items ?? [];
  if (!items.length || items.some((x) => !x.sku || !x.title || !Number.isInteger(x.quantity) || x.quantity <= 0)) {
    return no("same_product");
  }

  const texto = [o.shopify_note, ...c.contacts.map((x) => x.note)].filter(Boolean).join("\n");
  if (c.phoneHistory.some((h) => h.rejected) || (texto && explicitRejection(texto))) return no("rejection");

  // Otro pedido vivo del mismo producto, o el mismo producto entregado hace
  // poco («ya recibió el producto», motivo 17 de Swayp).
  const hace30 = now.getTime() - 30 * 86_400_000;
  if (
    c.phoneHistory.some(
      (h) =>
        !h.cancelled_at &&
        (h.open || (h.delivered && Date.parse(h.created_at) >= hace30)) &&
        productsOverlap(items, h.line_items ?? []),
    )
  ) {
    return no("duplicate");
  }

  return {
    eligible: true,
    reason: "eligible",
    arm: brazoDe(o.id),
    phone,
    recompra: c.phoneHistory.some((h) => h.delivered),
  };
}

/**
 * El orden de la pasada: primero quien ya compró y recibió (el 84 % de esas
 * entregas llegó en el histórico), después el pedido más antiguo dentro de la
 * ventana, que es el que más se acerca al límite.
 */
export function ordenDePasada<T extends { recompra: boolean; createdAt: string }>(a: T, b: T): number {
  return Number(b.recompra) - Number(a.recompra) || a.createdAt.localeCompare(b.createdAt);
}

/**
 * El freno. Mira los últimos `brake_window` casos resueltos del brazo Swayp; si
 * se entregó menos de `brake_min_rate`, el automático se apaga solo. Con menos
 * casos que la ventana no frena: diez resultados no dicen nada todavía.
 */
export function frenoActivado(
  resueltos: readonly { entregado: boolean; resolvedAt: string }[],
  s: Pick<PorConfirmarAutoSettings, "brake_window" | "brake_min_rate">,
): { frena: boolean; tasa: number | null; casos: number } {
  const ultimos = [...resueltos].sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt)).slice(0, s.brake_window);
  if (ultimos.length < s.brake_window) return { frena: false, tasa: null, casos: ultimos.length };
  const tasa = ultimos.filter((x) => x.entregado).length / ultimos.length;
  return { frena: tasa < s.brake_min_rate, tasa, casos: ultimos.length };
}

/** Códigos de novedad de Swayp que son falla de la propia bodega: inventario (18) y no despachó (20). */
export const NOVEDADES_DE_BODEGA = new Set([18, 20]);

/** Lee el código de novedad del estado informado («Swayp · Bodega no despacho mercancía (20)»). */
export function codigoDeNovedad(reported: string | null | undefined): number | null {
  const m = /\((\d+)\)\s*$/.exec(reported ?? "");
  return m ? Number(m[1]) : null;
}
