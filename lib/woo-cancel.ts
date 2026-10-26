// «Anular pedido» desde Kapta para los pedidos de WooCommerce (MOM §38.15,
// pedido del owner del 26-10-2026): las reglas, puras, que comparten la ficha
// (para decirlas antes del clic) y el servidor (que manda). Sin red ni base, y
// sin nada de Node: la ficha la importa.
//
// POR QUÉ EXISTE. Hasta hoy un pedido de WooCommerce se anulaba solo en
// wp-admin, y la entrada (webhook o pasada) lo marcaba anulado y dejaba
// «Anulado en WooCommerce» en la Actividad (§38.3). Darle wp-admin a cada
// persona del equipo para eso es darle el sitio entero. Kapta pasa el pedido a
// «Cancelado» en WooCommerce con las claves de la tienda; nunca lo manda a la
// papelera ni lo borra.
//
// QUÉ FRENA. El MOM no tenía reglas para anular desde Kapta (wp-admin deja
// anular cualquier cosa, y una anulación con la caja en la calle lleva el
// pedido a Por cerrar, §7). Se elige el lado conservador, decisión documentada
// en §38.15: no se anula un pedido que ya salió, que tiene una salida o guía
// viva, que está entregado o devuelto, que tiene dinero en la mano (cobrado en
// la web, o un comprobante validado o en revisión: anularlo exige un
// reembolso, que solo confirma el owner, §16) ni uno que comparte caja con
// otro pedido (§32). Lo que frena se dice con lo que hay que hacer antes.

import { activeOutputs } from "@/lib/closure-blocks";
import { nombreDeCourier } from "@/lib/shipment-output";

/** El motivo de la anulación: una lista corta y, siempre, el texto de quien anula. */
export const WOO_CANCEL_REASONS = [
  { code: "cliente_desiste", label: "La clienta ya no lo quiere" },
  { code: "duplicado", label: "Pedido duplicado" },
  // MOM §2 punto 3: una corrección comercial se hace anulando y creando otro.
  { code: "rehacer", label: "Se rehace con otros datos" },
  { code: "sin_stock", label: "Sin stock" },
  { code: "otro", label: "Otro motivo" },
] as const;

export type WooCancelReasonCode = (typeof WOO_CANCEL_REASONS)[number]["code"];

/** Lo mínimo y lo máximo del texto del motivo. */
export const WOO_CANCEL_REASON_MIN = 5;
export const WOO_CANCEL_REASON_MAX = 500;

/**
 * Quién anula desde Kapta: «Registrar estado a mano» (`master.set_status`,
 * owner y admin, MOM §16). No había una acción de anular pedidos de Shopify
 * desde Kapta que copiar (Shopify se anula en Shopify); anular la venta en la
 * tienda es el cambio de estado más fuerte, y ese permiso es el de los cambios
 * de estado a mano.
 */
export const WOO_CANCEL_PERMISSION = "master.set_status";

export const WOO_CANCEL_DENIED =
  "Anular un pedido en WooCommerce desde Kapta es de quien registra estados a mano (owner y admin). Pídeselo a un admin.";

export function wooCancelReasonLabel(code: string): string | null {
  return WOO_CANCEL_REASONS.find((r) => r.code === code)?.label ?? null;
}

/** El motivo, validado: el código de la lista y el texto (5 a 500 caracteres). */
export function validateWooCancelReason(
  code: unknown,
  text: unknown,
): { ok: true; code: WooCancelReasonCode; label: string; text: string } | { ok: false; error: string } {
  const label = typeof code === "string" ? wooCancelReasonLabel(code) : null;
  if (!label) return { ok: false, error: "Elige el motivo de la anulación." };
  const clean = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (clean.length < WOO_CANCEL_REASON_MIN) {
    return { ok: false, error: "Escribe en una línea por qué se anula: queda en la Actividad del pedido." };
  }
  if (clean.length > WOO_CANCEL_REASON_MAX) {
    return { ok: false, error: `El motivo es demasiado largo (máx. ${WOO_CANCEL_REASON_MAX} caracteres).` };
  }
  return { ok: true, code: code as WooCancelReasonCode, label, text: clean };
}

/** La nota del hecho en la Actividad: de dónde vino y el motivo. Quién, lo dice el actor. */
export function wooCancelEventNote(label: string, text: string): string {
  return `Desde Kapta · Motivo: ${label} — ${text}`;
}

// ---------------------------------------------------------------------------
// Qué impide anular
// ---------------------------------------------------------------------------

export interface WooCancelShipment {
  courier: string | null;
  guide_code?: string | null;
  delivery_status: string;
  custody_state?: string | null;
}

export interface WooCancelFacts {
  /** `orders.platform`. Solo `woocommerce` se anula desde Kapta. */
  platform: string | null;
  /** `orders_master.general_status` (o el de la ficha). */
  generalStatus: string | null;
  /** `orders.financial_status`. */
  financialStatus: string | null;
  /** Las salidas propias del pedido (`shipments`). */
  shipments: readonly WooCancelShipment[];
  /**
   * Los comprobantes del pedido (`order_payments.validation_status`). La ficha
   * no los tiene a mano: pasa null y el servidor los lee.
   */
  payments: readonly { validation_status: string | null }[] | null;
  /**
   * Pedido acompañante (§32): el pedido de la caja en la que viaja, si viaja en
   * la de otro, y los que viajan en las suyas.
   */
  companion?: { travelsIn: string | null; carries: readonly string[] } | null;
}

export type WooCancelBlockCode =
  | "no_woocommerce"
  | "entregado"
  | "devuelto"
  | "salida_entregada"
  | "caja_afuera"
  | "salida_activa"
  | "cobrado_tienda"
  | "pago_validado"
  | "comprobante_en_revision"
  | "acompanante";

export interface WooCancelBlock {
  code: WooCancelBlockCode;
  message: string;
}

/** Los estados de cobro de WooCommerce (ya mapeados, §38.4) que dicen que entró dinero. */
const MONEY_IN_STATUSES = new Set(["paid", "partially_paid", "partially_refunded", "refunded"]);

function shipmentLabel(s: WooCancelShipment): string {
  const code = (s.guide_code ?? "").trim();
  const courier = nombreDeCourier(s.courier);
  return code ? `la guía ${code} (${courier})` : `la salida de ${courier}`;
}

/**
 * Lo que impide anular este pedido desde Kapta, cada cosa con qué hacer antes.
 * Vacío: se puede. El servidor lo vuelve a calcular con lo leído de la base;
 * la ficha lo usa para decirlo antes del clic.
 */
export function wooCancelBlocks(f: WooCancelFacts): WooCancelBlock[] {
  if (f.platform !== "woocommerce") {
    return [
      {
        code: "no_woocommerce",
        message:
          "Solo los pedidos de WooCommerce se anulan desde Kapta. Este pedido es de Shopify: se anula en Shopify, como siempre.",
      },
    ];
  }
  const out: WooCancelBlock[] = [];
  const general = (f.generalStatus ?? "").trim().toLowerCase();
  if (general === "entregado") {
    out.push({
      code: "entregado",
      message: "El pedido está entregado: no se anula. Si la clienta lo devuelve, regístralo como devolución.",
    });
  } else if (general === "devuelto") {
    out.push({
      code: "devuelto",
      message: "El pedido ya está devuelto: su cierre sigue en la Mesa de cierre, no se anula desde aquí.",
    });
  }

  for (const s of f.shipments) {
    if (s.delivery_status === "entregado") {
      out.push({
        code: "salida_entregada",
        message: `${capitalize(shipmentLabel(s))} figura entregada: un pedido entregado no se anula.`,
      });
    } else if (s.custody_state === "courier" || s.custody_state === "retorno") {
      // La caja fuera del almacén (con el courier o volviendo), también con la
      // guía ya anulada: anular la venta no la trae de vuelta, y el pedido
      // quedaría esperando su retorno (§7).
      out.push({
        code: "caja_afuera",
        message: `La caja de ${shipmentLabel(s)} ya salió del almacén: recibe su retorno antes de anular el pedido.`,
      });
    } else if (activeOutputs([{ ...s, id: "" }]).length) {
      // Las mismas salidas vivas que impiden finalizar (`activeOutputs`).
      out.push({
        code: "salida_activa",
        message: `${capitalize(shipmentLabel(s))} sigue viva: anúlala primero con su propio botón (avisa al courier) y después anula el pedido.`,
      });
    }
  }

  if (MONEY_IN_STATUSES.has((f.financialStatus ?? "").trim().toLowerCase())) {
    out.push({
      code: "cobrado_tienda",
      message:
        "WooCommerce lo tiene cobrado: anularlo exige un reembolso, que solo confirma el owner (MOM §16). Anúlalo con el owner en WooCommerce.",
    });
  }
  const payments = f.payments ?? [];
  if (payments.some((p) => p.validation_status === "validado")) {
    out.push({
      code: "pago_validado",
      message:
        "Tiene un pago validado: anularlo exige devolver ese dinero, y el reembolso solo lo confirma el owner (MOM §16). Anúlalo con el owner.",
    });
  } else if (payments.some((p) => p.validation_status && p.validation_status !== "rechazado")) {
    out.push({
      code: "comprobante_en_revision",
      message: "Tiene un comprobante sin resolver: valídalo o recházalo en Cobro antes de anular.",
    });
  }

  const companion = f.companion;
  if (companion?.travelsIn) {
    out.push({
      code: "acompanante",
      message: `Viaja en la caja de ${companion.travelsIn}: desvincúlalo de esa caja antes de anularlo.`,
    });
  }
  if (companion && companion.carries.length) {
    out.push({
      code: "acompanante",
      message: `En su caja viaja ${companion.carries.join(", ")}: desvincúlalo antes de anular este pedido.`,
    });
  }
  return out;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
