// Vincular a su pedido una guía de Shalom que YA EXISTE: la creó una persona a
// mano en pro.shalom.pe (MOM §12, contingencia).
//
// Lo usan dos puertas, y por eso vive aquí y no en la server action:
//
//   1. El drawer, «Ya la creé en Shalom Pro» — una persona con sesión y
//      permiso (`registerManualShalomGuide`).
//   2. «Cotejar Shalom» — el cron, sin sesión ni usuario, cuando el listado de
//      la cuenta no deja duda de qué pedido es la guía
//      (lib/shalom/account-cotejo.ts).
//
// Las reglas son UNA: el mismo número no cuelga de dos pedidos, el pedido no
// puede quedar con dos salidas vivas, la salida «por definir» se rellena en vez
// de abrir otra fila, y queda un `guide_created` en la línea de tiempo. Si cada
// puerta las escribiera por su cuenta, la del cron acabaría siendo la puerta de
// atrás que la contingencia ya fue una vez (ver `blockingActiveGuide`).
//
// SERVER-ONLY: usa el cliente admin de Supabase y cifra la clave.

import type { SupabaseClient } from "@supabase/supabase-js";
import { encrypt } from "@/lib/crypto";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { writeCourierGuide } from "@/lib/route-output-fill";
import { isFillableRouteOutput } from "@/lib/shipment-output";
import { blockingActiveGuide } from "@/lib/shalom/draft";
import type { NormalizedManualShalomGuide } from "@/lib/shalom/manual";
import { SHALOM_ORIGIN } from "@/lib/shalom/origin";

/** Guías que ya cubren el pedido: crear otra encima duplica el despacho. */
export const ACTIVE_GUIDE_STATUSES = new Set(["pendiente", "en_ruta", "por_preparar"]);

/** Guías vivas del pedido, para no despachar dos veces lo mismo. */
export async function activeGuides(
  admin: SupabaseClient,
  orderId: string,
): Promise<{ courier: string; guide_code: string; delivery_status: string }[]> {
  const { data } = await admin
    .from("shipments")
    .select(
      "courier,guide_code,delivery_status,created_via,custody_state,custody_transferred_at",
    )
    .eq("order_id", orderId);
  const rows =
    (data as {
      courier: string;
      guide_code: string;
      delivery_status: string;
      created_via: string | null;
      custody_state: string | null;
      custody_transferred_at: string | null;
    }[]) ?? [];
  // La salida «por definir» no cuenta como guía activa: es ESTA caja esperando
  // courier, y la guía nueva se escribe encima de ella. Ver lib/route-output-fill.
  return rows.filter((g) => ACTIVE_GUIDE_STATUSES.has(g.delivery_status) && !isFillableRouteOutput(g));
}

/** Lo que hace falta del pedido para escribir su salida. */
export interface ExistingGuideOrder {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
}

/** Quién vinculó la guía: va a la nota y al payload de la línea de tiempo. */
export const COTEJAR_SHALOM = "cotejar_shalom";

export interface RegisterExistingGuideOptions {
  /** Usuario que la registra; `null` cuando lo hace el cron (Cotejar Shalom). */
  actor: string | null;
  /**
   * Solo vincular si la guía no está en NINGUNA salida. El drawer no lo pide:
   * reenviar su formulario completa identificadores de la misma guía. El cron
   * sí: no tiene nada que completar, y una guía ya vinculada no es suya.
   */
  onlyIfNew?: boolean;
  /** Presente cuando la vincula Cotejar Shalom: por qué no admite duda. */
  cotejo?: { motivo: string; payload?: Record<string, unknown> };
}

export type RegisterExistingGuideResult =
  | {
      ok: true;
      alreadyLinked: boolean;
      shipmentId: string;
      /** `KP123-S01` si se rellenó la salida «por definir» del pedido. */
      filledOutput: string | null;
      /** Lo que hay que decir de la clave de recojo (vacío si se guardó). */
      keyWarning: string;
    }
  | { ok: false; error: string };

/**
 * Registra la guía existente en el pedido. No llama a Shalom: la guía ya está
 * emitida. El rastreo público la sigue después por su número.
 *
 * La clave de recojo se guarda solo si viene: el cron no la tiene y no la
 * inventa. Se registra después desde la salida Shalom, en Salidas y guías.
 */
export async function registerExistingShalomGuide(
  admin: SupabaseClient,
  row: ExistingGuideOrder,
  guide: NormalizedManualShalomGuide,
  options: RegisterExistingGuideOptions,
): Promise<RegisterExistingGuideResult> {
  const { actor, cotejo } = options;

  // El número impreso identifica una salida real. Nunca puede aparecer en dos
  // pedidos distintos, incluso si dos personas registran la contingencia al
  // mismo tiempo (la base además conserva unique(courier, guide_code)).
  const duplicate = await admin
    .from("shipments")
    .select("id,order_id,store_id,guide_code")
    .eq("courier", "shalom")
    .eq("guide_code", guide.guideCode)
    .maybeSingle();
  if (duplicate.error) return { ok: false, error: `No se pudo validar la guía: ${duplicate.error.message}` };
  if (duplicate.data?.order_id && duplicate.data.order_id !== row.order_id) {
    return {
      ok: false,
      error: `La guía ${guide.guideCode} ya está vinculada a otro pedido. Revisa el número antes de continuar.`,
    };
  }
  if (duplicate.data && options.onlyIfNew) {
    return { ok: false, error: `La guía ${guide.guideCode} ya está registrada en Kapta.` };
  }

  // La contingencia registra una salida física igual que la vía API, así que
  // hereda su misma regla: un pedido no puede quedar con dos salidas vivas. Sin
  // esto, la pestaña «Ya la creé en Shalom Pro» era la puerta de atrás — no la
  // frena `blockers` en el modal ni se comprobaba acá— y dejaba al pedido con
  // dos paquetes que nadie sabe cuál viaja.
  //
  // Se excluye ESTA guía: reenviar el formulario para completar identificadores
  // que faltaban es idempotente por diseño y no debe chocar consigo mismo.
  const otherActive = blockingActiveGuide(await activeGuides(admin, row.order_id), guide.guideCode);
  if (otherActive) {
    return {
      ok: false,
      error:
        `El pedido ya tiene una salida activa: ${otherActive.guide_code} (${otherActive.courier}, ${otherActive.delivery_status}). ` +
        "Anúlala antes de vincular esta guía; si ya salió con el courier, registra primero su retorno.",
    };
  }

  const now = new Date().toISOString();
  let shipmentId = duplicate.data?.id ?? null;
  const alreadyLinked = Boolean(shipmentId);
  let filledOutput: string | null = null;

  if (!shipmentId) {
    const written = await writeCourierGuide(admin, row.order_id, {
      courier: "shalom",
      guide_code: guide.guideCode,
      store_id: row.store_id,
      order_id: row.order_id,
      matched: true,
      match_method: "manual",
      order_name: row.order_name,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      product: null,
      district: row.district,
      province: row.province,
      city: row.district,
      region: row.region,
      delivery_address: null,
      agency_branch: guide.agencyBranch,
      delivery_status: "pendiente",
      status_category: "pending",
      pickup_state: "pendiente_de_envio",
      shalom_codigo: guide.codigo,
      shalom_serie: guide.serie,
      shalom_ose_id: guide.oseId,
      shalom_order_id: guide.shalomOrderId,
      shalom_raw: {
        source: SHALOM_ORIGIN.manual,
        guia: guide.guideCode,
        codigo: guide.codigo,
        serie: guide.serie,
        ose_id: guide.oseId,
        order_id: guide.shalomOrderId,
        recorded_at: now,
        recorded_by: actor,
        ...(cotejo ? { registered_by: COTEJAR_SHALOM } : {}),
      },
      // `preparation_state`, `custody_state` y `assigned_at` NO viajan aquí, y
      // es deliberado: esta fila también se usa como UPDATE cuando rellena una
      // salida que ya existía. Mandarlos haría retroceder a `rotulo_generado`
      // una caja que el almacén ya escaneó como `listo_despacho` — borrar el
      // trabajo hecho para registrar una guía. Al insertar de cero, la base
      // pone `no_iniciado` y `empresa` por defecto, que es exactamente lo que
      // hace la vía API con una guía recién creada.
      //
      // Vale también para la que vincula Cotejar Shalom: la guía la emitió una
      // persona en pro.shalom.pe, y eso es lo que dice `created_via`. Quién la
      // trajo a Kapta lo dicen `registered_by` y la línea de tiempo.
      created_via: SHALOM_ORIGIN.manual,
    });

    if ("error" in written) {
      // La guía EXISTE en Shalom —la creó una persona en su panel—, así que el
      // mensaje tiene que dejarla anotada en vez de sugerir reintentar.
      if (/duplicate key|23505/i.test(written.error)) {
        return {
          ok: false,
          error: `La guía ${guide.guideCode} fue registrada por otra persona mientras completabas el formulario. Actualiza el pedido para verla.`,
        };
      }
      return { ok: false, error: `No se pudo registrar la guía manual: ${written.error}` };
    }
    shipmentId = written.shipmentId;
    filledOutput = written.filled ? written.outputCode : null;
  } else {
    // Un segundo envío del mismo formulario es idempotente. Permite completar
    // identificadores faltantes, pero nunca cambia de pedido ni crea otro QR.
    const patch: Record<string, unknown> = { updated_at: now };
    if (guide.codigo) patch.shalom_codigo = guide.codigo;
    if (guide.serie) patch.shalom_serie = guide.serie;
    if (guide.oseId) patch.shalom_ose_id = guide.oseId;
    if (guide.shalomOrderId) patch.shalom_order_id = guide.shalomOrderId;
    if (guide.agencyBranch) patch.agency_branch = guide.agencyBranch;
    const updated = await admin.from("shipments").update(patch).eq("id", shipmentId);
    if (updated.error) {
      return { ok: false, error: `La guía ya existe, pero no se pudo actualizar: ${updated.error.message}` };
    }
  }

  let keyWarning = "";
  if (guide.pickupCode) {
    const { data: previousKey } = await admin
      .from("shalom_pickup_keys")
      .select("order_id")
      .eq("order_id", row.order_id)
      .maybeSingle();
    const keyWrite = await admin.from("shalom_pickup_keys").upsert(
      {
        order_id: row.order_id,
        store_id: row.store_id,
        key_enc: encrypt(guide.pickupCode),
        created_by: actor,
        ...(previousKey ? { replaced_at: now, replaced_by: actor } : {}),
      },
      { onConflict: "order_id" },
    );
    if (keyWrite.error) {
      keyWarning = ` La guía quedó vinculada, pero la clave no pudo guardarse (${keyWrite.error.message}); regístrala desde la salida Shalom en Salidas y guías.`;
    }
  } else {
    keyWarning = " No se ingresó la clave de recojo; regístrala después desde la salida Shalom en Salidas y guías.";
  }

  const { data: validatedPayments } = await admin
    .from("order_payments")
    .select("amount")
    .eq("order_id", row.order_id)
    .eq("validation_status", "validado");
  const advance = (validatedPayments ?? []).reduce(
    (sum, payment) => sum + (Number(payment.amount) || 0),
    0,
  );
  const what = alreadyLinked
    ? "actualizada"
    : cotejo
      ? `creada fuera de Kapta y registrada por Cotejar Shalom (${cotejo.motivo})`
      : "creada fuera de Kapta y vinculada manualmente";
  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind: alreadyLinked ? "guide_link_updated" : "guide_created",
    occurred_at: now,
    actor,
    source: "shalom",
    courier: "shalom",
    guide_code: guide.guideCode,
    shipment_id: shipmentId,
    note:
      `Guía Shalom ${what}.` +
      `${guide.agencyBranch ? ` Destino: ${guide.agencyBranch}.` : ""}` +
      ` Adelanto validado: S/ ${advance.toFixed(2)}.` +
      // El cron no tiene la clave: la nota lo dice donde se lee, no solo en el
      // payload, porque es lo siguiente que alguien tiene que hacer.
      (cotejo && !guide.pickupCode ? " Falta la clave de recojo: regístrala desde la salida Shalom en Salidas y guías." : ""),
    // Nunca se guarda la clave en la línea de tiempo: solo la confirmación de
    // que fue recibida y cifrada.
    payload: {
      source: SHALOM_ORIGIN.manual,
      shipment_id: shipmentId,
      codigo: guide.codigo,
      serie: guide.serie,
      ose_id: guide.oseId,
      shalom_order_id: guide.shalomOrderId,
      agency_branch: guide.agencyBranch,
      has_pickup_key: Boolean(guide.pickupCode),
      validated_advance: advance,
      ...(cotejo ? { registered_by: COTEJAR_SHALOM, ...(cotejo.payload ?? {}) } : {}),
    },
  });

  await recomputeOrderMasterSafe(admin, [row.order_id]);

  return { ok: true, alreadyLinked, shipmentId: shipmentId as string, filledOutput, keyWarning };
}
