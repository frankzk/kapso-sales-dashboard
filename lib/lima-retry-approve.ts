import "server-only";

// El paso que crea la guía del reintento Aliclik de Lima (MOM §9.5), compartido
// por «Aprobar» de la bandeja (entrega 2) y por la pasada automática (entrega 3,
// 04-11-2026).
//
// POR QUÉ UN SOLO CAMINO. Lo que el owner encendió en Automatizaciones es
// «pulsar Aprobar sin persona», no otra regla: el mismo transporte, las mismas
// compuertas de `createAliclikGuideFor`, el mismo hecho en el historial y el
// mismo «pasa a Repro Lima» cuando Aliclik no ofrece el transporte. Si cada
// camino tuviera su copia, la primera corrección de uno dejaría al otro creando
// guías con la regla vieja.
//
// QUÉ CAMBIA SEGÚN QUIÉN PIDE.
//   * Una persona (`{ userId }`): lee con su sesión (sin scope, como siempre),
//     firma los hechos y el motivo de la salida adicional dice «aprobado en
//     Repro Lima».
//   * El sistema (`{ system, variant }`): sin sesión, lee con el service role
//     acotado a la organización del pedido (`aliclikReadScopeFor`), firma con
//     actor null y `source: "system"`, y la guía lleva el origen
//     `reintento_lima`, el único automático al que se le acepta el motivo de la
//     salida adicional (la caja que falló sigue viva hasta que vuelve).
//
// `dry` cotiza, elige el transporte y pasa por las compuertas de Kapta de la
// creación (`aliclikCreateGates`, las mismas que corre `createAliclikGuideFor`)
// pero no crea ni escribe nada: es la simulación del panel. Así «Habría creado
// la guía» solo sale de un pedido que Activo sí crearía (04-11-2026).
//
// Quién puede y qué cadena toca lo decide quien llama: la acción con permisos y
// RLS; la pasada con el interruptor de la variante, el tope y el candado del log.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aliclikContextFor,
  aliclikCreateGates,
  aliclikReadScopeFor,
  aliclikRecipientBlock,
  createAliclikGuideFor,
  previewAliclikGuideFor,
  type AliclikGuideOrigin,
  type AliclikReadScope,
} from "@/lib/aliclik-guide";
import { isAlidriver, isAutoecom } from "@/lib/aliclik-lima";
import { CHAIN_EVENT_KINDS, type LimaRetryChain } from "@/lib/lima-retry-chain";
import { autoRetryMotive, type RetryVariant } from "@/lib/lima-retry-auto";
import { limaTodayKey } from "@/lib/shipments";
import type { ReproRow } from "@/lib/repro-lima-access";
import type { OrderMasterRow } from "@/lib/types";

export const RETRY_TRANSPORT_LABEL = { autoecom: "AUTOECOM", alidriver: "ALIDRIVER" } as const;
export type RetryTransport = (typeof RETRY_TRANSPORT_LABEL)[keyof typeof RETRY_TRANSPORT_LABEL];

/** La cadena tal como la ve la bandeja (`retryChainOf`). */
export type RetryChainView = NonNullable<ReproRow["retryChain"]>;
/** La cadena cruda de los hechos (`facts.retryChain`), en estado «siguiente». */
export type RetryChainNext = Extract<LimaRetryChain, { state: "siguiente" }>;

/** Quién pide el reintento: una persona con sesión, o la pasada automática. */
export type RetryActor = { userId: string } | { system: true; variant: RetryVariant };

export interface RetryApproveInput {
  admin: SupabaseClient;
  row: OrderMasterRow;
  chain: RetryChainView;
  /** La cadena cruda (`facts.retryChain`): el motivo automático sale de ella. */
  raw: RetryChainNext;
  actor: RetryActor;
  /** El día de Lima de la pasada (YYYY-MM-DD). Por defecto, hoy. */
  today?: string;
  /** Cotiza y elige el transporte; no crea ni escribe. */
  dry?: boolean;
  /** El scope ya resuelto de la tienda (la pasada lo guarda por tienda). Solo sistema. */
  scope?: AliclikReadScope;
}

/**
 * Lo que pasó. `outcome` usa el vocabulario de `lima_retry_auto_log`; la
 * acción manual traduce cada uno a sus mensajes de siempre.
 */
export type RetryApproveResult =
  | {
      /** No se llegó a cotizar: el contexto de Aliclik, el scope o la cotización fallaron. */
      outcome: "fallo";
      stage: "contexto" | "cotizacion";
      transport: RetryTransport;
      error: string;
    }
  | { outcome: "sin_transporte"; transport: RetryTransport }
  | { outcome: "no_seleccionable"; transport: RetryTransport; reason: string | null }
  | { outcome: "simulada"; transport: RetryTransport; detail: string }
  | {
      /**
       * Solo en `dry`: las compuertas de Kapta de la creación no la dejan
       * pasar. Con `kaptaBlock` es una regla («Activo no la crearía: … y lo
       * pasaría a Repro Lima»); sin él, no se pudo leer algo («No se pudo
       * comprobar: … (Activo lo reintentaría)»). `error` ya lo dice.
       */
      outcome: "fallo";
      stage: "compuertas";
      transport: RetryTransport;
      error: string;
      kaptaBlock: boolean;
    }
  | {
      /** `createAliclikGuideFor` respondió con error: candado, timeout o rechazo. */
      outcome: "en_curso" | "incierto" | "fallo";
      stage: "creacion";
      transport: RetryTransport;
      error: string;
      locked: boolean;
      /**
       * El rechazo es una regla de Kapta sobre el pedido tal como está
       * (`AliclikCreateResult.kaptaBlock`), no un error de Aliclik ni de red.
       */
      kaptaBlock: boolean;
      /**
       * Con `incierto`: la guía que Aliclik SÍ creó aunque Kapta no pudo
       * guardarla. Existe allá: hay que vincularla, no crearla otra vez.
       */
      guide?: string | null;
    }
  | { outcome: "creada"; transport: RetryTransport; guide: string | null };

function isSystem(actor: RetryActor): actor is { system: true; variant: RetryVariant } {
  return "system" in actor;
}

async function recordChainEvent(
  admin: SupabaseClient,
  row: OrderMasterRow,
  actor: RetryActor,
  kind: string,
  reason: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const system = isSystem(actor);
  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind,
    occurred_at: new Date().toISOString(),
    // El automático no tiene persona: actor null y `system`, como la guía del
    // día programado (lib/aliclik-scheduled-server.ts).
    actor: system ? null : actor.userId,
    source: system ? "system" : "manual",
    reason,
    payload: system ? { ...payload, auto: true, variant: actor.variant } : payload,
  });
}

/**
 * Cotiza, elige el transporte de la cadena y crea la guía del reintento (o, con
 * `dry`, dice cuál crearía). Sin transporte para la dirección, el pedido pasa a
 * Repro Lima (decisión del owner, 03-11-2026) salvo en `dry`.
 */
export async function approveLimaRetry(input: RetryApproveInput): Promise<RetryApproveResult> {
  const { admin, row, chain, actor } = input;
  const system = isSystem(actor);
  const transport = RETRY_TRANSPORT_LABEL[chain.next];
  const today = input.today ?? limaTodayKey();

  // La persona lee con su sesión (sin scope, como siempre); el sistema no
  // tiene sesión y lee acotado a la organización del pedido.
  let scope: AliclikReadScope | undefined;
  if (system) {
    scope = input.scope;
    if (!scope) {
      const resolved = await aliclikReadScopeFor(admin, row.store_id);
      if (!resolved.scope) {
        return { outcome: "fallo", stage: "contexto", transport, error: resolved.error ?? "No se pudo leer la organización de la tienda." };
      }
      scope = resolved.scope;
    }
  }

  const { ctx, error: ctxError } = await aliclikContextFor(row, system ? null : actor.userId, { blockAgencia: true });
  if (!ctx) return { outcome: "fallo", stage: "contexto", transport, error: ctxError ?? "No se pudo preparar la conexión con Aliclik." };
  const preview = scope
    ? await previewAliclikGuideFor(ctx, { modality: "cod" }, scope)
    : await previewAliclikGuideFor(ctx, { modality: "cod" });
  if (!preview.ok) return { outcome: "fallo", stage: "cotizacion", transport, error: preview.error ?? "No se pudo cotizar el envío." };

  const wanted = (name: string | null | undefined) => (chain.next === "autoecom" ? isAutoecom(name) : isAlidriver(name));
  const courier = preview.couriers?.find((c) => wanted(c.transportName)) ?? null;
  if (!courier) {
    // Decisión del owner (03-11-2026): sin ese transporte para la dirección,
    // el pedido pasa a Repro Lima. La simulación solo lo dice.
    if (!input.dry) {
      await recordChainEvent(admin, row, actor, CHAIN_EVENT_KINDS.dismissed,
        `Aliclik no ofrece ${transport} para esta dirección: pasa a Repro Lima.`,
        { attempt: chain.attempt, of: chain.of, transport, why: "sin_transporte" });
    }
    return { outcome: "sin_transporte", transport };
  }
  if (!courier.selectable) return { outcome: "no_seleccionable", transport, reason: courier.reason ?? null };

  // El motivo de la salida adicional de Lima: la persona aprobó en la bandeja;
  // el sistema lo hace porque el owner encendió la variante, y lo dice.
  const motive = system
    ? autoRetryMotive(input.raw, chain.failedText)
    : `Reintento Aliclik ${chain.attempt} de ${chain.of} aprobado en Repro Lima. ${chain.failedText}.`;
  const createInput = {
    transportId: courier.transportId,
    expectedCollectTotal: preview.collectTotal ?? null,
    motivoSalidaAdicional: motive,
    note: null,
  };
  const origin: AliclikGuideOrigin | undefined = system
    ? { kind: "reintento_lima", scheduledOn: today, reason: motive }
    : undefined;

  if (input.dry) {
    // Lo que la creación real rechazaría siempre: las compuertas de Kapta con
    // el mismo motivo, el mismo origen y el mismo scope que usará Activo, y el
    // teléfono y la dirección que Aliclik exige. Se para antes del candado y
    // del POST. Sin esto la simulación decía «Habría creado la guía» y Activo
    // fallaba y avisaba cada día hasta que la cadena vencía.
    // Solo una REGLA dice qué haría Activo (no crearla y pasarlo a Repro
    // Lima); un «no se pudo leer» Activo lo reintenta, y la simulación lo dice.
    const gates = await aliclikCreateGates(ctx, createInput, scope, origin);
    if (!gates.ok && !gates.kaptaBlock) {
      return { outcome: "fallo", stage: "compuertas", transport, kaptaBlock: false, error: `No se pudo comprobar: ${gates.error.replace(/\.$/, "")} (Activo lo reintentaría).` };
    }
    const reason = gates.ok ? aliclikRecipientBlock(row) : gates.error;
    if (reason) {
      return { outcome: "fallo", stage: "compuertas", transport, kaptaBlock: true, error: `Activo no la crearía: ${reason.replace(/\.$/, "")}, y lo pasaría a Repro Lima.` };
    }
    return {
      outcome: "simulada",
      transport,
      detail: `${courier.transportName ?? transport} S/ ${courier.deliveryCost} · cobrar S/ ${(preview.collectTotal ?? 0).toFixed(2)}`,
    };
  }
  const result = system
    ? await createAliclikGuideFor(ctx, createInput, scope, origin)
    : await createAliclikGuideFor(ctx, createInput);
  if (result.error) {
    // El candado lo tiene otra creación (una persona ahora, o un timeout que el
    // barrido resuelve); el timeout pudo haberla creado; con número, Aliclik
    // SÍ la creó y lo que falló fue guardarla en Kapta: es `incierto` con su
    // código (cuenta para el tope y no se crea otra vez); lo demás es un
    // rechazo. La persona ve el mismo mensaje de siempre (`result.error`).
    const created = result.orderNumber?.trim() || null;
    const outcome = result.locked ? "en_curso" : result.timedOut || created ? "incierto" : "fallo";
    return {
      outcome, stage: "creacion", transport, error: result.error, locked: !!result.locked,
      kaptaBlock: outcome === "fallo" && !!result.kaptaBlock,
      ...(created ? { guide: created } : {}),
    };
  }
  await recordChainEvent(admin, row, actor, CHAIN_EVENT_KINDS.approved,
    `Reintento Aliclik ${chain.attempt} de ${chain.of} ${system ? "automático" : "aprobado"}: guía con ${transport}${result.orderNumber ? ` (${result.orderNumber})` : ""}.`,
    { attempt: chain.attempt, of: chain.of, transport, guide: result.orderNumber ?? null, failed: chain.failedText });
  return { outcome: "creada", transport, guide: result.orderNumber ?? null };
}
