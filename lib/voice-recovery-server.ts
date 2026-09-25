// Agente de voz — la parte que toca la base (MOM §11.8). Las reglas están en
// `lib/voice-recovery.ts`; aquí solo se leen y escriben filas.

import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { FenixStockRow } from "@/lib/fenix";
import { confirmationReminderDueAt } from "@/lib/order-confirmation";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import {
  VOICE_SOURCE,
  buildFicha,
  isStale,
  staleCallResolution,
  translateGestion,
  voiceDates,
  type Ficha,
  type GestionAction,
  type OpenCall,
} from "@/lib/voice-recovery";
import { compareVoiceCandidates, voiceRecoveryEligible } from "@/lib/voice-recovery-queue";
import { requestCallback, zadarmaLocalPeru } from "@/lib/zadarma";

const OPEN_STATUSES = ["queued", "dialing", "in_progress"] as const;

function secretEquals(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Las tools del agente se autentican con VOICE_TOOLS_SECRET. Se acepta como
 * `Authorization: Bearer …` o como cabecera `x-voice-secret`, según lo que
 * permita la consola de xAI.
 */
export function voiceToolAuthorized(req: NextRequest): boolean {
  const secret = env.voiceToolsSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7).trim(), secret)) return true;
  return secretEquals(req.headers.get("x-voice-secret")?.trim(), secret);
}

/** Lo mismo que los crons: nuestra propia infraestructura llamándose. */
export function internalAuthorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7).trim(), secret)) return true;
  return secretEquals(req.headers.get("x-internal-secret")?.trim(), secret);
}

/** Lee el cuerpo de una tool, venga como JSON o como query string. */
export async function readToolBody(req: NextRequest): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    out[k] = v;
  });
  try {
    const text = await req.text();
    if (text.trim()) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed ?? {})) {
        if (v !== null && v !== undefined) out[k] = String(v);
      }
    }
  } catch {
    // Cuerpo vacío o no JSON: quedan los parámetros de la URL.
  }
  return out;
}

type AttemptAction = Extract<GestionAction, { kind: "attempt" }>;

/**
 * Escribe un intento del agente sobre el pedido, por la misma función que una
 * asesora (§6.1), con el id de la llamada como operation_id: un reintento
 * devuelve lo ya escrito y no gasta otro día. Devuelve el error, o null.
 */
export async function writeVoiceAttempt(
  admin: SupabaseClient,
  call: { id: string; store_id: string; order_id: string },
  action: AttemptAction,
  now: Date,
): Promise<string | null> {
  const reminder =
    action.result === "sin_respuesta" || action.result === "se_deja_mensaje"
      ? confirmationReminderDueAt(now.toISOString())
      : null;
  const { error } = await admin.rpc("register_confirmation_attempt_v2", {
    p_store_id: call.store_id,
    p_order_id: call.order_id,
    p_actor: null,
    p_operation_id: call.id,
    p_result: action.result,
    p_channel: "llamada",
    p_note: action.note,
    p_next_contact_on: action.nextContactOn,
    p_occurred_at: now.toISOString(),
    p_reminder_due_at: reminder,
    p_source: VOICE_SOURCE,
    p_payload_extra: action.extra,
  });
  return error?.message ?? null;
}

/**
 * Cierra las llamadas abiertas cuya ventana pasó. Sin esto, una llamada que
 * nunca conectó dejaría ocupado el número del agente para siempre (hay un
 * índice único de una abierta por número). Una real que nunca llegó al agente
 * es una clienta que no contestó, y se registra como tal
 * (`staleCallResolution`).
 */
export async function sweepStaleCalls(admin: SupabaseClient, now: Date): Promise<void> {
  const { data } = await admin
    .from("voice_calls")
    .select("id, store_id, order_id, mode, agent_number, phone, status, dialed_at, started_at")
    .in("status", OPEN_STATUSES as unknown as string[]);
  type Row = OpenCall & { store_id: string; order_id: string; mode: "real" | "test" };
  const stale = ((data ?? []) as Row[]).filter((c) => isStale(c, now));
  for (const c of stale) {
    const r = staleCallResolution(c);
    // Se cierra ANTES de escribir y solo si seguía abierta: dos barridos a la
    // vez no registran dos veces (y la v2 es idempotente por operation_id).
    const { data: closed } = await admin
      .from("voice_calls")
      .update({ status: r.status, outcome: r.outcome, ended_at: now.toISOString(), error: r.error })
      .eq("id", c.id)
      .in("status", OPEN_STATUSES as unknown as string[])
      .select("id");
    if (!r.registerNoAnswer || !closed?.length) continue;

    const action = translateGestion(
      { disposition: "no_contesta", resumen: "No contestó: la llamada no llegó al agente." },
      { today: voiceDates(now).hoy, canDiscard: false, voiceCallId: c.id },
    );
    if (action.kind !== "attempt") continue;
    const writeError = await writeVoiceAttempt(admin, c, action, now);
    if (writeError) {
      await admin.from("voice_calls").update({ status: "failed", error: writeError }).eq("id", c.id);
    } else {
      await recomputeOrderMasterSafe(admin, [c.order_id]);
    }
  }
}

export async function openCalls(admin: SupabaseClient): Promise<OpenCall[]> {
  const { data, error } = await admin
    .from("voice_calls")
    .select("id, agent_number, phone, status, dialed_at, started_at")
    .in("status", OPEN_STATUSES as unknown as string[]);
  if (error) throw new Error(error.message);
  return (data ?? []) as OpenCall[];
}

export interface VoiceCallRow {
  id: string;
  store_id: string;
  order_id: string;
  mode: "real" | "test";
  status: string;
}

export async function loadCall(admin: SupabaseClient, id: string): Promise<VoiceCallRow | null> {
  const { data } = await admin
    .from("voice_calls")
    .select("id, store_id, order_id, mode, status")
    .eq("id", id)
    .maybeSingle();
  return (data as VoiceCallRow | null) ?? null;
}

/** La ficha del pedido real de la fila, con las fechas de hoy en Lima. */
export async function loadFicha(
  admin: SupabaseClient,
  call: VoiceCallRow,
  now: Date,
): Promise<Ficha | null> {
  const [{ data: order }, { data: master }, { data: store }] = await Promise.all([
    admin.from("orders").select("name, line_items, total_amount").eq("id", call.order_id).maybeSingle(),
    admin
      .from("order_master")
      .select("customer_name, district, province, address, reference, order_total")
      .eq("order_id", call.order_id)
      .maybeSingle(),
    admin.from("stores").select("name").eq("id", call.store_id).maybeSingle(),
  ]);
  if (!order) return null;
  const o = order as { name: string | null; line_items: unknown; total_amount: number | null };
  const m = (master ?? {}) as {
    customer_name?: string | null;
    district?: string | null;
    province?: string | null;
    address?: string | null;
    reference?: string | null;
    order_total?: number | string | null;
  };
  return buildFicha(
    {
      storeName: (store as { name?: string } | null)?.name ?? null,
      customerName: m.customer_name ?? null,
      orderName: o.name,
      lineItems: Array.isArray(o.line_items)
        ? (o.line_items as { title?: string | null; quantity?: number | null }[])
        : [],
      total: m.order_total ?? o.total_amount,
      district: m.district ?? null,
      province: m.province ?? null,
      address: m.address ?? null,
      reference: m.reference ?? null,
      mode: call.mode,
    },
    now,
  );
}

export interface StoreVoiceConfig {
  id: string;
  voice_recovery_enabled: boolean;
  voice_recovery_can_discard: boolean;
  voice_recovery_agent_number: string | null;
  voice_recovery_zadarma_sip: string | null;
}

export async function loadStoreVoiceConfig(
  admin: SupabaseClient,
  storeId: string,
): Promise<StoreVoiceConfig | null> {
  const { data } = await admin
    .from("stores")
    .select(
      "id, voice_recovery_enabled, voice_recovery_can_discard, voice_recovery_agent_number, voice_recovery_zadarma_sip",
    )
    .eq("id", storeId)
    .maybeSingle();
  return (data as StoreVoiceConfig | null) ?? null;
}

// ── Lanzar una llamada ──────────────────────────────────────────────────────

export interface PlaceCallInput {
  storeId: string;
  orderId: string;
  /** Teléfono al que se llama: la clienta en `real`, quien prueba en `test`. */
  phone: string;
  mode: "real" | "test";
  triggeredBy: string | null;
  agentNumber: string;
  sip: string;
}

export type PlaceCallResult =
  | { ok: true; callId: string; from: string; to: string }
  | { ok: false; status: number; error: string; callId?: string };

/**
 * Escribe la fila ANTES de marcar y luego pide el callback (MOM §11.8: la
 * llamada se ata a la fila, no al teléfono que contesta). La usan la prueba,
 * el botón del drawer y el barrido: una sola forma de llamar.
 */
export async function placeVoiceCall(
  admin: SupabaseClient,
  input: PlaceCallInput,
  now: Date = new Date(),
): Promise<PlaceCallResult> {
  const phone = zadarmaLocalPeru(input.phone);
  if (!phone) return { ok: false, status: 400, error: "El teléfono no es un número peruano válido." };
  if (!input.agentNumber.trim() || !input.sip.trim()) {
    return {
      ok: false,
      status: 400,
      error: "Falta el número del agente o la extensión de Zadarma con caller ID peruano en los ajustes de la tienda.",
    };
  }

  // Las credenciales se leen ANTES de escribir la fila: si faltan, se dice
  // así, en vez de dejar una fila «marcando» que ocupa el número del agente.
  let creds: { key: string; secret: string };
  try {
    creds = { key: env.zadarmaKey(), secret: env.zadarmaSecret() };
  } catch {
    return {
      ok: false,
      status: 500,
      error: "Faltan las credenciales de Zadarma en el servidor (ZADARMA_KEY y ZADARMA_SECRET en Vercel).",
    };
  }

  await sweepStaleCalls(admin, now);

  const { data: inserted, error: insertError } = await admin
    .from("voice_calls")
    .insert({
      store_id: input.storeId,
      order_id: input.orderId,
      mode: input.mode,
      agent_number: input.agentNumber.trim(),
      phone,
      // `dialing` ANTES de pedir la llamada: el agente puede llamar a la tool
      // en cuanto la clienta dice «¿Aló?», y la fila tiene que estar.
      status: "dialing",
      dialed_at: now.toISOString(),
      triggered_by: input.triggeredBy,
    })
    .select("id")
    .single();
  if (insertError) {
    const busy = insertError.code === "23505";
    return {
      ok: false,
      status: busy ? 409 : 500,
      error: busy
        ? "El agente ya está en otra llamada. Espera a que termine (o a que caduque: 3 minutos marcando, 10 en curso)."
        : insertError.message,
    };
  }
  const callId = (inserted as { id: string }).id;

  const result = await requestCallback(creds, {
    agentNumber: input.agentNumber,
    customerPhone: phone,
    sip: input.sip,
  });
  if (!result.ok) {
    await admin
      .from("voice_calls")
      .update({
        status: "failed",
        error: result.error,
        telephony_response: result.response ?? null,
        ended_at: new Date().toISOString(),
      })
      .eq("id", callId);
    return { ok: false, status: 502, error: result.error, callId };
  }
  await admin.from("voice_calls").update({ telephony_response: result.response }).eq("id", callId);
  return { ok: true, callId, from: result.from, to: result.to };
}

// ── La cola del barrido ─────────────────────────────────────────────────────

export interface VoiceStoreSettings {
  id: string;
  name: string | null;
  org_id: string | null;
  return_recovery_max_days: number | null;
  voice_recovery_enabled: boolean;
  voice_recovery_auto: boolean;
  voice_recovery_can_discard: boolean;
  voice_recovery_daily_cap: number;
  voice_recovery_max_attempts: number;
  voice_recovery_max_age_days: number;
  voice_recovery_hour_start: number;
  voice_recovery_hour_end: number;
  voice_recovery_agent_number: string | null;
  voice_recovery_zadarma_sip: string | null;
}

export const VOICE_STORE_COLUMNS =
  "id, name, org_id, return_recovery_max_days, voice_recovery_enabled, voice_recovery_auto, voice_recovery_can_discard, voice_recovery_daily_cap, voice_recovery_max_attempts, voice_recovery_max_age_days, voice_recovery_hour_start, voice_recovery_hour_end, voice_recovery_agent_number, voice_recovery_zadarma_sip";

export interface VoiceCandidate {
  orderId: string;
  orderName: string | null;
  phone: string;
  closedAt: string;
  dueByPact: boolean;
}

export interface VoiceQueue {
  candidates: VoiceCandidate[];
  excluded: Record<string, number>;
  /** Por pedido, para explicar en el drawer por qué no entra. */
  reasons: Record<string, string>;
}

const CHUNK = 200;
function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

// PostgREST devuelve como máximo 1000 filas por llamada AUNQUE se pida un
// .limit() mayor, y el recorte es silencioso. El 24-09-2026 la subetapa tenía
// 1338 pedidos: llegaban 1000 viejos sin orden y la cola salía vacía todo el
// día. Por eso toda lectura de aquí se drena por páginas, ordenadas por `id`.
const PAGE = 1000;

export async function drain<T>(
  table: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

async function selectIn<T>(
  admin: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  values: readonly string[],
  extra?: (q: ReturnType<SupabaseClient["from"]>["select"] extends (...a: never[]) => infer R ? R : never) => unknown,
): Promise<T[]> {
  const rows: T[] = [];
  for (const part of chunks(values)) {
    // 200 pedidos pueden traer más de 1000 eventos: también se pagina.
    const batch = await drain<T>(table, (from, to) => {
      let q = admin.from(table).select(columns).in(column, part);
      if (extra) q = extra(q as never) as typeof q;
      return q.order("id").range(from, to);
    });
    rows.push(...batch);
  }
  return rows;
}

/**
 * Carga los hechos de los pedidos en Reproprovincia de una tienda y aplica
 * `voiceRecoveryEligible`. Se parte de `order_master.macro_substage` porque
 * es donde el Master ya decidió «En gestión Reproprovincia» (Lima tiene su
 * propia subetapa y queda fuera); la elegibilidad vuelve a comprobar la
 * recuperación con la misma función, así que un Master atrasado no cuela nada.
 */
export async function loadVoiceQueue(
  admin: SupabaseClient,
  store: VoiceStoreSettings,
  now: Date,
  onlyOrderId?: string,
): Promise<VoiceQueue> {
  const today = voiceDates(now).hoy;

  const masters = await drain<{
    order_id: string;
    order_name: string | null;
    customer_phone: string | null;
    district: string | null;
    region: string | null;
    confirmation_next_contact_on: string | null;
  }>("order_master", (from, to) => {
    let q = admin
      .from("order_master")
      .select("order_id, order_name, customer_phone, district, region, confirmation_next_contact_on")
      .eq("store_id", store.id)
      .eq("macro_substage", "gestion_reproprovincia");
    if (onlyOrderId) q = q.eq("order_id", onlyOrderId);
    return q.order("id").range(from, to);
  });
  const excluded: Record<string, number> = {};
  const reasons: Record<string, string> = {};
  if (!masters.length) return { candidates: [], excluded, reasons };

  const ids = masters.map((m) => m.order_id);
  const phones = [...new Set(masters.map((m) => m.customer_phone).filter((p): p is string => Boolean(p)))];

  type Guide = {
    order_id: string;
    courier: string;
    delivery_status: string;
    reported_status: string | null;
    closed_at: string | null;
    returned_at: string | null;
    updated_at: string | null;
  };
  type Ev = { order_id: string; kind: string; occurred_at: string };
  type OrderRow = { id: string; line_items: unknown };
  type Prior = {
    order_id: string;
    order_name: string | null;
    order_created_at: string | null;
    general_status: string | null;
    operational_status: string | null;
    macro_stage: string | null;
    order_total: number | null;
    guide_code: string | null;
    current_courier: string | null;
    last_courier: string | null;
    delivered_courier: string | null;
    attempt_count: number | null;
    customer_phone: string | null;
  };
  type Call = { order_id: string; queued_at: string };

  const [guides, events, orders, priors, calls, stockRes, dnc] = await Promise.all([
    selectIn<Guide>(
      admin,
      "shipments",
      "order_id, courier, delivery_status, reported_status, closed_at, returned_at, updated_at",
      "order_id",
      ids,
    ),
    selectIn<Ev>(admin, "order_events", "order_id, kind, occurred_at", "order_id", ids, (q) =>
      (q as unknown as { in: (c: string, v: string[]) => unknown }).in("kind", [
        "recovery_discarded",
        "confirmation_contact",
        "contact_attempt",
        "call",
      ]),
    ),
    selectIn<OrderRow>(admin, "orders", "id, line_items", "id", ids),
    phones.length
      ? selectIn<Prior>(
          admin,
          "order_master",
          "order_id, order_name, order_created_at, general_status, operational_status, macro_stage, order_total, guide_code, current_courier, last_courier, delivered_courier, attempt_count, customer_phone",
          "customer_phone",
          phones,
          (q) => (q as unknown as { eq: (c: string, v: string) => unknown }).eq("store_id", store.id),
        )
      : Promise.resolve([] as Prior[]),
    selectIn<Call>(admin, "voice_calls", "order_id, queued_at", "order_id", ids, (q) =>
      (q as unknown as { eq: (c: string, v: string) => unknown }).eq("mode", "real"),
    ),
    store.org_id
      ? admin.from("fenix_stock").select("city, product, sku, quantity, unlimited").eq("org_id", store.org_id)
      : Promise.resolve({ data: [], error: null }),
    admin
      .from("voice_calls")
      .select("phone")
      .eq("store_id", store.id)
      .eq("outcome_payload->>no_llamar", "true"),
  ]);
  const stock = ((stockRes as { data: unknown[] | null }).data ?? []) as FenixStockRow[];
  const doNotCall = new Set(
    ((dnc.data ?? []) as { phone: string }[]).map((r) => zadarmaLocalPeru(r.phone)).filter(Boolean),
  );

  const byOrder = <T extends { order_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.order_id, [...(m.get(r.order_id) ?? []), r]);
    return m;
  };
  const guidesBy = byOrder(guides);
  const eventsBy = byOrder(events);
  const callsBy = byOrder(calls);
  const itemsBy = new Map(orders.map((o) => [o.id, Array.isArray(o.line_items) ? o.line_items : []]));
  const priorsByPhone = new Map<string, Prior[]>();
  for (const p of priors) {
    if (!p.customer_phone) continue;
    priorsByPhone.set(p.customer_phone, [...(priorsByPhone.get(p.customer_phone) ?? []), p]);
  }

  const candidates: VoiceCandidate[] = [];
  for (const m of masters) {
    const verdict = voiceRecoveryEligible({
      now,
      today,
      guides: guidesBy.get(m.order_id) ?? [],
      events: eventsBy.get(m.order_id) ?? [],
      recoveryWindowDays: store.return_recovery_max_days ?? 30,
      maxAgeDays: store.voice_recovery_max_age_days,
      district: m.district,
      region: m.region,
      lineItems: (itemsBy.get(m.order_id) ?? []) as { title?: string; sku?: string; quantity?: number }[],
      stock,
      phone: m.customer_phone,
      priors: (priorsByPhone.get(m.customer_phone ?? "") ?? []).filter((p) => p.order_id !== m.order_id) as never,
      nextContactOn: m.confirmation_next_contact_on,
      agentCalls: callsBy.get(m.order_id) ?? [],
      maxAgentAttempts: store.voice_recovery_max_attempts,
      doNotCall: doNotCall.has(zadarmaLocalPeru(m.customer_phone) ?? "-"),
    });
    if (verdict.eligible) {
      candidates.push({
        orderId: m.order_id,
        orderName: m.order_name,
        phone: m.customer_phone ?? "",
        closedAt: verdict.closedAt,
        dueByPact: verdict.dueByPact,
      });
    } else {
      excluded[verdict.reason] = (excluded[verdict.reason] ?? 0) + 1;
      reasons[m.order_id] = verdict.reason;
    }
  }
  candidates.sort(compareVoiceCandidates);
  return { candidates, excluded, reasons };
}

/** Llamadas reales de hoy (Lima) de una tienda: el tope diario se cuenta aquí. */
export async function realCallsToday(admin: SupabaseClient, storeId: string, now: Date): Promise<number> {
  const limaMidnightUtc = new Date(
    Date.UTC(
      new Date(now.getTime() - 5 * 3_600_000).getUTCFullYear(),
      new Date(now.getTime() - 5 * 3_600_000).getUTCMonth(),
      new Date(now.getTime() - 5 * 3_600_000).getUTCDate(),
      5,
    ),
  );
  const { count } = await admin
    .from("voice_calls")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("mode", "real")
    .gte("queued_at", limaMidnightUtc.toISOString());
  return count ?? 0;
}
