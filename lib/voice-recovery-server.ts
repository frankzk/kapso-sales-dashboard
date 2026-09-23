// Agente de voz — la parte que toca la base (MOM §11.8). Las reglas están en
// `lib/voice-recovery.ts`; aquí solo se leen y escriben filas.

import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import {
  buildFicha,
  isStale,
  type Ficha,
  type OpenCall,
} from "@/lib/voice-recovery";

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

/**
 * Cierra las llamadas abiertas cuya ventana pasó. Sin esto, una llamada que
 * nunca conectó dejaría ocupado el número del agente para siempre (hay un
 * índice único de una abierta por número). No toca el pedido.
 */
export async function sweepStaleCalls(admin: SupabaseClient, now: Date): Promise<void> {
  const { data } = await admin
    .from("voice_calls")
    .select("id, agent_number, phone, status, dialed_at, started_at")
    .in("status", OPEN_STATUSES as unknown as string[]);
  const stale = ((data ?? []) as OpenCall[]).filter((c) => isStale(c, now));
  for (const c of stale) {
    await admin
      .from("voice_calls")
      .update({
        status: "failed",
        outcome: c.status === "in_progress" ? "sin_resultado" : null,
        ended_at: now.toISOString(),
        error: c.status === "in_progress" ? "sin registrar_gestion dentro de la ventana" : "no conectó",
      })
      .eq("id", c.id)
      .in("status", OPEN_STATUSES as unknown as string[]);
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
