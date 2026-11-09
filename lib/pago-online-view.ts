import "server-only";

// Lo que el panel de Automatizaciones muestra de «Pago solo online (lista
// automática)» (MOM §41.11): la posición, lo que se cobra, la última corrida,
// por tienda el último envío bueno, el último error y el freno de cambio
// brusco, y las excepciones de Kapta. NUNCA un celular de la lista: cuentas,
// fechas y estados; de una excepción, solo los tres últimos dígitos y el
// pedido desde el que se hizo.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgentNames } from "@/lib/agent-names";
import { formatLimaDateTime } from "@/lib/automations-catalog";
import { loadPagoOnlineSettings, pagoOnlineStores } from "@/lib/pago-online-server";
import {
  PAGO_ONLINE_SEND_STATUS_LABEL,
  limaDateOf,
  parseCodCoreTotals,
  pagoOnlineMaskedPhone,
  type PagoOnlineMode,
  type PagoOnlineRequirement,
  type PagoOnlineSendStatus,
} from "@/lib/pago-online";

export interface PagoOnlineRunView {
  id: string;
  at: string;
  mode: "simulacion" | "activo";
  trigger: "cron" | "manual";
  status: "calculando" | "listo" | "error";
  requirement: PagoOnlineRequirement;
  phones: number;
  emails: number;
  twoOrMore: number;
  /** Los que entran por la regla B (anula casi todo lo que pide). */
  anuladores: number;
  excepted: number;
  porConfirmarListed: number;
  porConfirmarBraked: number;
  baseline: number | null;
  guard: "primera" | "ok" | "bloqueado" | "aceptado" | null;
  guardReason: string | null;
  acceptedBy: string | null;
  error: string | null;
  /** Es de hoy (Lima), está en Activo y el freno la paró: se puede aceptar. */
  canAccept: boolean;
}

export interface PagoOnlineStoreView {
  id: string;
  name: string;
  /** El último envío bueno (diario o manual): fecha, cuántos y lo que dijo el GET. */
  lastOk: { at: string; phones: number; emails: number; verifyPhones: number | null; verifyUpdatedAt: string | null; verifyError: string | null } | null;
  /** El último intento que terminó mal, si es más nuevo que el último bueno. */
  lastError: { at: string; status: string; httpStatus: number | null; error: string | null } | null;
  /** El último freno de cambio brusco de la tienda, si es más nuevo que el último bueno. */
  guard: { at: string; reason: string | null } | null;
  /** El estado del último intento (cualquiera). */
  lastStatus: string | null;
  /** La última prueba: cuándo y en qué terminó (sin el celular). */
  lastTest: { at: string; status: string; verifyPhones: number | null } | null;
}

export interface PagoOnlineExceptionView {
  id: string;
  phoneMasked: string;
  orderName: string | null;
  reason: string;
  addedAt: string;
  addedBy: string;
}

export interface PagoOnlineView {
  available: boolean;
  mode: PagoOnlineMode;
  requirement: PagoOnlineRequirement;
  /** La lista que lee el freno de Kapta hoy: cuántos y desde cuándo. */
  current: { runId: string; at: string; phones: number; emails: number } | null;
  lastRun: PagoOnlineRunView | null;
  /** La última simulación, si la última corrida no lo es. */
  lastSimulation: PagoOnlineRunView | null;
  stores: PagoOnlineStoreView[];
  exceptions: PagoOnlineExceptionView[];
  error: string | null;
}

type RunRow = {
  id: string;
  run_date: string;
  mode: "simulacion" | "activo";
  trigger: "cron" | "manual";
  status: "calculando" | "listo" | "error";
  requirement: PagoOnlineRequirement;
  phones: number;
  emails: number;
  two_or_more: number;
  anuladores: number;
  excepted: number;
  por_confirmar_listed: number;
  por_confirmar_braked: number;
  baseline_phones: number | null;
  guard: PagoOnlineRunView["guard"];
  guard_reason: string | null;
  accepted_by: string | null;
  error: string | null;
  started_at: string;
};

type SendRow = {
  store_id: string;
  kind: "diaria" | "manual" | "prueba";
  status: PagoOnlineSendStatus;
  phones_sent: number;
  emails_sent: number;
  http_status: number | null;
  error: string | null;
  guard_reason: string | null;
  verify: unknown;
  verify_error: string | null;
  started_at: string;
};

const RUN_COLUMNS =
  "id,run_date,mode,trigger,status,requirement,phones,emails,two_or_more,anuladores,excepted,por_confirmar_listed,por_confirmar_braked,baseline_phones,guard,guard_reason,accepted_by,error,started_at";

const BAD: readonly PagoOnlineSendStatus[] = ["fallido", "credenciales", "demasiado_grande", "sin_claves", "sin_endpoint", "reintento"];

export async function loadPagoOnlineView(admin: SupabaseClient, orgId: string, stores: { id: string; name: string }[]): Promise<PagoOnlineView> {
  const empty: PagoOnlineView = {
    available: false,
    mode: "apagado",
    requirement: "adelanto",
    current: null,
    lastRun: null,
    lastSimulation: null,
    stores: [],
    exceptions: [],
    error: null,
  };
  const { settings, missing, error } = await loadPagoOnlineSettings(admin, orgId);
  if (missing) return empty;
  if (error) return { ...empty, error: "No se pudo leer «Pago solo online»: no se puede cambiar ahora." };

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [runsRes, sendsRes, excRes, currentRes] = await Promise.all([
    admin.from("pago_online_runs").select(RUN_COLUMNS).eq("org_id", orgId).order("started_at", { ascending: false }).limit(20),
    admin
      .from("pago_online_sends")
      .select("store_id,kind,status,phones_sent,emails_sent,http_status,error,guard_reason,verify,verify_error,started_at")
      .eq("org_id", orgId)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(300),
    admin
      .from("pago_online_exceptions")
      .select("id,phone,order_name,reason,added_by,added_at")
      .eq("org_id", orgId)
      .is("removed_at", null)
      .order("added_at", { ascending: false })
      .limit(200),
    settings.current_run_id
      ? admin.from("pago_online_runs").select("id,phones,emails,started_at").eq("id", settings.current_run_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const problems: string[] = [];
  if (runsRes.error) problems.push("las corridas");
  if (sendsRes.error) problems.push("los envíos");
  if (excRes.error) problems.push("las excepciones");

  const runs = (runsRes.data ?? []) as RunRow[];
  const people = await resolveAgentNames(
    [...runs.map((r) => r.accepted_by), ...((excRes.data ?? []) as { added_by: string | null }[]).map((e) => e.added_by)].filter((id): id is string => !!id),
    admin,
  );
  const today = limaDateOf(new Date());
  const runView = (r: RunRow, latestActive: boolean): PagoOnlineRunView => ({
    id: r.id,
    at: formatLimaDateTime(r.started_at),
    mode: r.mode,
    trigger: r.trigger,
    status: r.status,
    requirement: r.requirement,
    phones: r.phones,
    emails: r.emails,
    twoOrMore: r.two_or_more,
    anuladores: r.anuladores ?? 0,
    excepted: r.excepted,
    porConfirmarListed: r.por_confirmar_listed,
    porConfirmarBraked: r.por_confirmar_braked,
    baseline: r.baseline_phones,
    guard: r.guard,
    guardReason: r.guard_reason,
    acceptedBy: r.accepted_by ? (people[r.accepted_by] ?? "Alguien del equipo") : null,
    error: r.error,
    canAccept: latestActive && settings.mode === "activo" && r.mode === "activo" && r.status === "listo" && r.guard === "bloqueado" && r.run_date === today,
  });
  const latest = runs[0] ?? null;
  const latestActiveId = runs.find((r) => r.mode === "activo")?.id ?? null;
  const lastRun = latest ? runView(latest, latest.id === latestActiveId) : null;
  const sim = runs.find((r) => r.mode === "simulacion");
  const lastSimulation = sim && sim.id !== latest?.id ? runView(sim, false) : null;

  const sends = (sendsRes.data ?? []) as SendRow[];
  const storeViews: PagoOnlineStoreView[] = stores.map((s) => {
    const mine = sends.filter((r) => r.store_id === s.id);
    const real = mine.filter((r) => r.kind !== "prueba");
    const ok = real.find((r) => r.status === "enviado");
    const okAt = ok ? Date.parse(ok.started_at) : -Infinity;
    const bad = real.find((r) => BAD.includes(r.status) && Date.parse(r.started_at) > okAt);
    const frenado = real.find((r) => r.status === "freno_cambio" && Date.parse(r.started_at) > okAt);
    const test = mine.find((r) => r.kind === "prueba");
    const v = ok ? parseCodCoreTotals(ok.verify) : null;
    return {
      id: s.id,
      name: s.name,
      lastOk: ok
        ? {
            at: formatLimaDateTime(ok.started_at),
            phones: ok.phones_sent,
            emails: ok.emails_sent,
            verifyPhones: v?.celulares ?? null,
            verifyUpdatedAt: v?.actualizado ? formatLimaDateTime(v.actualizado) || v.actualizado : null,
            verifyError: ok.verify_error,
          }
        : null,
      lastError: bad ? { at: formatLimaDateTime(bad.started_at), status: PAGO_ONLINE_SEND_STATUS_LABEL[bad.status] ?? bad.status, httpStatus: bad.http_status, error: bad.error } : null,
      guard: frenado ? { at: formatLimaDateTime(frenado.started_at), reason: frenado.guard_reason } : null,
      lastStatus: real[0] ? (PAGO_ONLINE_SEND_STATUS_LABEL[real[0].status] ?? real[0].status) : null,
      lastTest: test
        ? { at: formatLimaDateTime(test.started_at), status: PAGO_ONLINE_SEND_STATUS_LABEL[test.status] ?? test.status, verifyPhones: parseCodCoreTotals(test.verify).celulares }
        : null,
    };
  });

  const cur = currentRes.data as { id: string; phones: number; emails: number; started_at: string } | null;
  return {
    available: true,
    mode: settings.mode,
    requirement: settings.requirement,
    current: cur ? { runId: cur.id, at: formatLimaDateTime(cur.started_at), phones: cur.phones, emails: cur.emails } : null,
    lastRun,
    lastSimulation,
    stores: storeViews,
    exceptions: ((excRes.data ?? []) as { id: string; phone: string; order_name: string | null; reason: string; added_by: string | null; added_at: string }[]).map((e) => ({
      id: e.id,
      phoneMasked: pagoOnlineMaskedPhone(e.phone),
      orderName: e.order_name,
      reason: e.reason,
      addedAt: formatLimaDateTime(e.added_at),
      addedBy: e.added_by ? (people[e.added_by] ?? "Alguien del equipo") : "Kapta",
    })),
    error: problems.length ? `No se pudieron leer ${problems.join(", ")} de «Pago solo online».` : null,
  };
}

/** Para el panel: las tiendas WooCommerce activas de la organización y la vista. Nunca lanza. */
export async function loadPagoOnlinePanel(admin: SupabaseClient, orgId: string): Promise<PagoOnlineView> {
  try {
    const stores = await pagoOnlineStores(admin, orgId);
    return await loadPagoOnlineView(admin, orgId, stores);
  } catch (e) {
    return {
      available: false,
      mode: "apagado",
      requirement: "adelanto",
      current: null,
      lastRun: null,
      lastSimulation: null,
      stores: [],
      exceptions: [],
      error: `No se pudo leer «Pago solo online»: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
