import "server-only";

// «Llamar con Anura», fase 1: lo que hacen las acciones de la ficha y de
// Ajustes. Cada función AUTORIZA primero (permiso + lectura por RLS de lo que
// toca) y después lee o escribe con el service role, como el resto del Master.
//
//   · Llamar desde la ficha: `master.edit` (el mismo de §8.5), Anura
//     configurado (ANURA_CLICK2DIAL_TOKEN y, si está puesto, ANURA_ORG_ID igual
//     a la org del pedido) y un anexo activo de quien llama en
//     la org de la tienda del pedido. El teléfono lo lee el servidor del
//     pedido; el navegador nunca lo manda.
//   · Ajustes › Telefonía Anura: `stores.manage` en la org de la tienda (lo
//     que pide Ajustes entero).

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { env } from "@/lib/env";
import { getMasterPermissions, hasOrgPermission } from "@/lib/permissions-access";
import { resolveAgentNames } from "@/lib/agent-names";
import {
  ANURA_EVENT_RETENTION_DAYS,
  ANURA_EVENT_TEMPLATE,
  anuraPeruCalled,
  isUuid,
  maskPhone,
  normalizeAnuraExtension,
} from "@/lib/anura/events";
import {
  ANURA_CALL_COLUMNS,
  anuraCallLive,
  activeAnuraCallOf,
  placeAnuraCall,
  releaseStaleAnuraCalls,
  type AnuraCallLive,
  type AnuraCallRow,
  type AnuraStartResult,
} from "@/lib/anura/calls";
import { retryAnuraRecording, signedRecordingUrl } from "@/lib/anura/recording";
import { anuraWebhookUrl } from "@/lib/anura/token";
import { talkTimeWords } from "@/lib/browser-call";

export type { AnuraCallLive, AnuraStartResult } from "@/lib/anura/calls";

export type AnuraMutationResult = { ok: true; notice: string } | { ok: false; error: string };

export const ANURA_NOT_CONFIGURED = "Anura no está configurado: falta el token de Click2Dial.";
export const ANURA_NO_EXTENSION = "No tienes un anexo de Anura asignado. Pídelo a quien administra (Ajustes › Telefonía Anura).";
export const ANURA_BAD_PHONE = "El teléfono del cliente no es un celular peruano válido.";
export const ANURA_DENIED_CALL = "Tu rol no permite llamar con Anura.";
export const ANURA_DENIED_ADMIN = "Solo quien administra la tienda configura Anura.";

/**
 * Anura está encendido para esta org: hay token y, si `ANURA_ORG_ID` está
 * puesto, es la org dueña de la central. El token es uno solo para toda la
 * plataforma: con `ANURA_ORG_ID`, otra org no puede llamar con él. Nunca dice
 * el valor.
 */
export function anuraConfigured(orgId: string): boolean {
  if (!env.anuraClick2DialToken()) return false;
  const owner = env.anuraOrgId();
  return !owner || owner === orgId.toLowerCase();
}

/** El token para llamar desde esta org, o "" si esta org no puede. */
function anuraTokenFor(orgId: string): string {
  return anuraConfigured(orgId) ? env.anuraClick2DialToken() : "";
}

/** El anexo activo de una persona en una org, o null. */
export async function anuraExtensionOf(admin: SupabaseClient, orgId: string, userId: string): Promise<string | null> {
  const { data } = await admin
    .from("anura_extensions")
    .select("extension")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("active", true)
    .maybeSingle();
  return (data as { extension?: string } | null)?.extension ?? null;
}

/** La org de una tienda que la persona ve (por RLS), o null. */
async function orgOfStore(sb: SupabaseClient, storeId: string): Promise<string | null> {
  if (!isUuid(storeId)) return null;
  const { data } = await sb.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  return (data as { org_id?: string | null } | null)?.org_id ?? null;
}

interface OrderTarget {
  userId: string;
  orderId: string;
  storeId: string;
  orgId: string;
  phone: string | null;
}

/** El pedido por RLS (si no se ve, no existe) y la org de su tienda. */
async function orderTarget(orderId: string): Promise<OrderTarget | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Tu sesión venció. Vuelve a entrar." };
  if (!isUuid(orderId)) return { error: "Sin acceso a este pedido." };
  const sb = await createServerSupabase();
  const { data, error } = await sb.from("order_master").select("order_id,store_id,customer_phone").eq("order_id", orderId).maybeSingle();
  if (error) return { error: `No se pudo leer el pedido: ${error.message}` };
  const row = data as { order_id: string; store_id: string; customer_phone: string | null } | null;
  if (!row) return { error: "Sin acceso a este pedido." };
  const orgId = await orgOfStore(sb, row.store_id);
  if (!orgId) return { error: "Sin acceso a la tienda de este pedido." };
  return { userId: user.id, orderId: row.order_id, storeId: row.store_id, orgId, phone: row.customer_phone };
}

// ---------------------------------------------------------------------------
// La ficha del pedido
// ---------------------------------------------------------------------------

/** «Llamar con Anura» desde la ficha. */
export async function startAnuraCallForOrder(orderId: string, deps: { fetchImpl?: typeof fetch } = {}): Promise<AnuraStartResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) return { ok: false, error: ANURA_DENIED_CALL };
  const target = await orderTarget(orderId);
  if ("error" in target) return { ok: false, error: target.error };
  const token = anuraTokenFor(target.orgId);
  if (!token) return { ok: false, error: ANURA_NOT_CONFIGURED };
  const admin = createAdminSupabase();
  const extension = await anuraExtensionOf(admin, target.orgId, target.userId);
  if (!extension) return { ok: false, error: ANURA_NO_EXTENSION };
  const phone = anuraPeruCalled(target.phone);
  if (!phone) return { ok: false, error: ANURA_BAD_PHONE };
  return placeAnuraCall(
    admin,
    {
      orgId: target.orgId,
      storeId: target.storeId,
      orderId: target.orderId,
      userId: target.userId,
      mode: "pedido",
      extension,
      phone,
      token,
    },
    deps,
  );
}

export type AnuraCallStatusResult = { ok: true; call: AnuraCallLive } | { ok: false; error: string };

/**
 * El estado de una llamada, para el sondeo de la ficha. La ve quien la pidió
 * o quien ve la tienda (RLS de `anura_calls`). Suelta la `solicitada` que
 * pasó 60 s sin aviso.
 */
export async function anuraCallStatusFor(callId: string): Promise<AnuraCallStatusResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Tu sesión venció. Vuelve a entrar." };
  if (!isUuid(callId)) return { ok: false, error: "Llamada no encontrada." };
  const admin = createAdminSupabase();
  const read = async () => {
    const { data } = await admin.from("anura_calls").select(ANURA_CALL_COLUMNS).eq("id", callId).maybeSingle();
    return (data as unknown as AnuraCallRow | null) ?? null;
  };
  let row = await read();
  if (!row) return { ok: false, error: "Llamada no encontrada." };
  if (row.user_id !== user.id) {
    const sb = await createServerSupabase();
    const { data: visible } = await sb.from("anura_calls").select("id").eq("id", callId).maybeSingle();
    if (!visible) return { ok: false, error: "Llamada no encontrada." };
  }
  if (row.status === "solicitada" || row.status === "sonando" || row.status === "en_curso") {
    if ((await releaseStaleAnuraCalls(admin, { callId }, new Date())) > 0) row = (await read()) ?? row;
  }
  return { ok: true, call: anuraCallLive(row) };
}

/** Una llamada en la ficha del pedido (tarjeta del historial). */
export interface AnuraOrderCall extends AnuraCallLive {
  userId: string | null;
  /** Quién llamó (parte local del correo, como el resto del historial). */
  who: string | null;
  answered: boolean;
  /** «2 min 13 s», o null si no se habló. */
  talkLabel: string | null;
  /** URL firmada de 5 minutos, solo si la grabación está guardada. */
  recordingUrl: string | null;
}

export interface AnuraOrderPanel {
  /** Mostrar «Llamar con Anura»: token + `master.edit` + anexo + celular peruano. */
  enabled: boolean;
  /** Por qué no sale el botón (para depurar; la ficha no tiene que decirlo). */
  disabledReason: string | null;
  extension: string | null;
  /** La llamada viva de quien mira (de este u otro pedido), para retomar el sondeo. */
  activeCall: AnuraCallLive | null;
  calls: AnuraOrderCall[];
}

function recordingLinkExpired(r: AnuraCallRow, nowMs: number): boolean {
  if (r.recording_status !== "pendiente" || !r.recording_expires_at) return false;
  const at = Date.parse(r.recording_expires_at);
  return Number.isFinite(at) && at <= nowMs;
}

const EMPTY_PANEL: AnuraOrderPanel = { enabled: false, disabledReason: null, extension: null, activeCall: null, calls: [] };

/**
 * Lo que la ficha necesita de Anura: si sale el botón y las llamadas del
 * pedido con su grabación. Las llamadas se leen por RLS (quien ve el pedido
 * las ve). Una grabación «pendiente» se reintenta después de responder.
 */
export async function loadAnuraOrderPanel(
  orderId: string,
  deps: { defer?: (work: () => Promise<unknown>) => void } = {},
): Promise<AnuraOrderPanel> {
  const target = await orderTarget(orderId);
  if ("error" in target) return { ...EMPTY_PANEL, disabledReason: target.error };
  const admin = createAdminSupabase();
  const sb = await createServerSupabase();
  const [perms, extension, callsRes] = await Promise.all([
    getMasterPermissions(),
    anuraExtensionOf(admin, target.orgId, target.userId),
    sb.from("anura_calls").select(ANURA_CALL_COLUMNS).eq("order_id", target.orderId).order("requested_at", { ascending: false }).limit(30),
  ]);
  const rows = ((callsRes.data ?? []) as unknown as AnuraCallRow[]).filter((r) => r.mode === "pedido");

  let disabledReason: string | null = null;
  if (!anuraConfigured(target.orgId)) disabledReason = ANURA_NOT_CONFIGURED;
  else if (!perms.can("master.edit")) disabledReason = ANURA_DENIED_CALL;
  else if (!extension) disabledReason = ANURA_NO_EXTENSION;
  else if (!anuraPeruCalled(target.phone)) disabledReason = ANURA_BAD_PHONE;

  const [names, urls, active] = await Promise.all([
    resolveAgentNames(rows.map((r) => r.user_id ?? "").filter(Boolean), admin),
    Promise.all(rows.map((r) => (r.recording_status === "guardada" ? signedRecordingUrl(admin, r.recording_path) : Promise.resolve(null)))),
    extension ? activeAnuraCallOf(admin, target.userId) : Promise.resolve(null),
  ]);

  const nowMs = Date.now();
  const pending = rows.filter((r) => r.recording_status === "pendiente");
  if (pending.length) {
    const work = async () => {
      for (const r of pending.slice(0, 3)) await retryAnuraRecording(admin, r);
    };
    if (deps.defer) deps.defer(work);
    else await work().catch(() => {});
  }

  return {
    enabled: disabledReason === null,
    disabledReason,
    extension,
    activeCall: active ? anuraCallLive(active) : null,
    calls: rows.map((r, i) => {
      // Una «pendiente» cuyo enlace de Anura ya venció se ve «vencida» ya (el
      // reintento de arriba la deja así en la base).
      const live = { ...anuraCallLive(r), ...(recordingLinkExpired(r, nowMs) ? { recordingStatus: "vencida" as const } : {}) };
      const answered = r.status === "contestada";
      return {
        ...live,
        userId: r.user_id,
        who: r.user_id ? names[r.user_id] ?? null : null,
        answered,
        talkLabel: answered && (r.bill_seconds ?? 0) > 0 ? talkTimeWords(r.bill_seconds ?? 0) : null,
        recordingUrl: urls[i] ?? null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Ajustes › Telefonía Anura
// ---------------------------------------------------------------------------

interface AdminTarget {
  userId: string;
  storeId: string;
  orgId: string;
}

async function adminTarget(storeId: string): Promise<AdminTarget | { error: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Tu sesión venció. Vuelve a entrar." };
  const sb = await createServerSupabase();
  const orgId = await orgOfStore(sb, storeId);
  if (!orgId) return { error: "Tienda no encontrada." };
  if (!(await hasOrgPermission(orgId, "stores.manage"))) return { error: ANURA_DENIED_ADMIN };
  return { userId: user.id, storeId, orgId };
}

export interface AnuraExtensionView {
  id: string;
  userId: string;
  name: string;
  extension: string;
  active: boolean;
}

export interface AnuraPersonView {
  userId: string;
  name: string;
  role: string;
}

export interface AnuraEventView {
  id: string;
  receivedAt: string;
  event: string | null;
  direction: string | null;
  anuraStatus: string | null;
  outcome: "aplicado" | "repetido" | "ignorado" | "error";
  detail: string | null;
  /** Enmascarados (`98••••321`). */
  calling: string;
  called: string;
  extension: string | null;
  billSeconds: number | null;
  callId: string | null;
}

export interface AnuraSettingsData {
  /** Hay ANURA_CLICK2DIAL_TOKEN. Nunca el valor. */
  configured: boolean;
  webhook: {
    /** La URL entera, para copiar. */
    url: string;
    /** Lo que pide el formulario de Anura por separado. */
    protocol: "HTTPS";
    host: string;
    port: 443;
    /** Ruta con el token, sin la barra inicial (como la pide Anura). */
    path: string;
  } | null;
  template: string;
  extensions: AnuraExtensionView[];
  people: AnuraPersonView[];
  recentEvents: AnuraEventView[];
  /** Las tablas de la 0310 todavía no existen. */
  migrationMissing: boolean;
}

export type AnuraSettingsResult = { ok: true; data: AnuraSettingsData } | { ok: false; error: string };

/** Sin `0310` la tabla no existe: la sección lo dice en vez de caerse. */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(error.message ?? "");
}

/** Todo lo de la sección «Telefonía Anura» de Ajustes. */
export async function loadAnuraSettings(storeId: string, siteUrl: string): Promise<AnuraSettingsResult> {
  const target = await adminTarget(storeId);
  if ("error" in target) return { ok: false, error: target.error };
  const admin = createAdminSupabase();
  const since = new Date(Date.now() - ANURA_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  const [extRes, memberRes, eventRes] = await Promise.all([
    admin.from("anura_extensions").select("id,user_id,extension,active").eq("org_id", target.orgId).order("extension"),
    admin.from("memberships").select("user_id,role").eq("org_id", target.orgId),
    admin
      .from("anura_webhook_events")
      .select("id,received_at,event,direction,anura_status,outcome,detail,payload,call_id")
      .eq("org_id", target.orgId)
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(50),
  ]);
  const migrationMissing = isMissingTable(extRes.error) || isMissingTable(eventRes.error);
  const exts = (extRes.data ?? []) as { id: string; user_id: string; extension: string; active: boolean }[];
  const members = ((memberRes.data ?? []) as { user_id: string; role: string }[]).filter((m) => m.role !== "motorizado");
  const names = await resolveAgentNames([...members.map((m) => m.user_id), ...exts.map((e) => e.user_id)], admin);

  let webhook: AnuraSettingsData["webhook"] = null;
  try {
    const url = anuraWebhookUrl(siteUrl, target.orgId);
    const parsed = new URL(url);
    webhook = { url, protocol: "HTTPS", host: parsed.host, port: 443, path: `${parsed.pathname.replace(/^\//, "")}${parsed.search}` };
  } catch {
    webhook = null;
  }

  type EventRow = {
    id: string;
    received_at: string;
    event: string | null;
    direction: string | null;
    anura_status: string | null;
    outcome: AnuraEventView["outcome"];
    detail: string | null;
    payload: Record<string, unknown> | null;
    call_id: string | null;
  };
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);

  return {
    ok: true,
    data: {
      configured: anuraConfigured(target.orgId),
      webhook,
      template: ANURA_EVENT_TEMPLATE,
      extensions: exts.map((e) => ({ id: e.id, userId: e.user_id, name: names[e.user_id] ?? e.user_id.slice(0, 8), extension: e.extension, active: e.active })),
      people: members
        .map((m) => ({ userId: m.user_id, name: names[m.user_id] ?? m.user_id.slice(0, 8), role: m.role }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      recentEvents: ((eventRes.data ?? []) as EventRow[]).map((e) => {
        const p = e.payload ?? {};
        // La bitácora ya guarda los teléfonos enmascarados; se vuelve a
        // enmascarar por si una fila vieja trajera uno entero.
        return {
          id: e.id,
          receivedAt: e.received_at,
          event: e.event,
          direction: e.direction,
          anuraStatus: e.anura_status,
          outcome: e.outcome,
          detail: e.detail,
          calling: str(p.calling)?.includes("•") ? String(p.calling) : maskPhone(str(p.calling)),
          called: str(p.called)?.includes("•") ? String(p.called) : maskPhone(str(p.called)),
          extension: str(p.accountExtension),
          billSeconds: typeof p.billSeconds === "number" ? p.billSeconds : null,
          callId: e.call_id,
        };
      }),
      migrationMissing,
    },
  };
}

/** Asigna (o cambia) el anexo de una persona. Uno por persona y uno por anexo. */
export async function saveAnuraExtensionFor(storeId: string, userId: string, rawExtension: string): Promise<AnuraMutationResult> {
  const target = await adminTarget(storeId);
  if ("error" in target) return { ok: false, error: target.error };
  const extension = normalizeAnuraExtension(rawExtension);
  if (!extension) return { ok: false, error: "El anexo son de 2 a 6 dígitos (por ejemplo, 101)." };
  if (!isUuid(userId)) return { ok: false, error: "Elige a una persona del equipo." };
  const admin = createAdminSupabase();
  const { data: member } = await admin.from("memberships").select("role").eq("org_id", target.orgId).eq("user_id", userId).maybeSingle();
  if (!member) return { ok: false, error: "Esa persona no es del equipo de esta organización." };
  const { data: taken } = await admin
    .from("anura_extensions")
    .select("user_id")
    .eq("org_id", target.orgId)
    .eq("extension", extension)
    .maybeSingle();
  const takenBy = (taken as { user_id?: string } | null)?.user_id;
  if (takenBy && takenBy !== userId) {
    const names = await resolveAgentNames([takenBy], admin);
    return { ok: false, error: `El anexo ${extension} ya está asignado a ${names[takenBy] ?? "otra persona"}. Quítaselo primero.` };
  }
  const { error } = await admin
    .from("anura_extensions")
    .upsert({ org_id: target.orgId, user_id: userId, extension, active: true, created_by: target.userId }, { onConflict: "org_id,user_id" });
  if (error) {
    if (error.code === "23505") return { ok: false, error: `El anexo ${extension} ya está asignado a otra persona.` };
    return { ok: false, error: `No se pudo guardar el anexo: ${error.message}` };
  }
  return { ok: true, notice: `Anexo ${extension} asignado.` };
}

/** Enciende o apaga un anexo sin borrarlo. */
export async function setAnuraExtensionActiveFor(storeId: string, extensionId: string, active: boolean): Promise<AnuraMutationResult> {
  const target = await adminTarget(storeId);
  if ("error" in target) return { ok: false, error: target.error };
  if (!isUuid(extensionId)) return { ok: false, error: "Anexo no encontrado." };
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("anura_extensions")
    .update({ active })
    .eq("id", extensionId)
    .eq("org_id", target.orgId)
    .select("extension");
  if (error) return { ok: false, error: `No se pudo cambiar el anexo: ${error.message}` };
  if (!(data ?? []).length) return { ok: false, error: "Anexo no encontrado." };
  return { ok: true, notice: active ? "Anexo activado." : "Anexo desactivado." };
}

/** Quita el anexo de una persona (para dárselo a otra). */
export async function removeAnuraExtensionFor(storeId: string, extensionId: string): Promise<AnuraMutationResult> {
  const target = await adminTarget(storeId);
  if ("error" in target) return { ok: false, error: target.error };
  if (!isUuid(extensionId)) return { ok: false, error: "Anexo no encontrado." };
  const admin = createAdminSupabase();
  const { data, error } = await admin.from("anura_extensions").delete().eq("id", extensionId).eq("org_id", target.orgId).select("extension");
  if (error) return { ok: false, error: `No se pudo quitar el anexo: ${error.message}` };
  if (!(data ?? []).length) return { ok: false, error: "Anexo no encontrado." };
  return { ok: true, notice: "Anexo quitado." };
}

/**
 * «Llamada de prueba» desde Ajustes: al número que escribe quien administra,
 * con su propio anexo o con el que elija de la org. No es intento de ningún
 * pedido (`modo = prueba`, sin pedido).
 */
export async function startAnuraTestCallFor(
  storeId: string,
  rawPhone: string,
  rawExtension?: string | null,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<AnuraStartResult> {
  const target = await adminTarget(storeId);
  if ("error" in target) return { ok: false, error: target.error };
  const token = anuraTokenFor(target.orgId);
  if (!token) return { ok: false, error: ANURA_NOT_CONFIGURED };
  const phone = anuraPeruCalled(rawPhone);
  if (!phone) return { ok: false, error: "Escribe un celular peruano de 9 dígitos." };
  const admin = createAdminSupabase();
  let extension: string | null;
  if (rawExtension) {
    const wanted = normalizeAnuraExtension(rawExtension);
    if (!wanted) return { ok: false, error: "Anexo no válido." };
    const { data } = await admin
      .from("anura_extensions")
      .select("extension")
      .eq("org_id", target.orgId)
      .eq("extension", wanted)
      .eq("active", true)
      .maybeSingle();
    extension = (data as { extension?: string } | null)?.extension ?? null;
    if (!extension) return { ok: false, error: `El anexo ${wanted} no está asignado ni activo en esta organización.` };
  } else {
    extension = await anuraExtensionOf(admin, target.orgId, target.userId);
    if (!extension) return { ok: false, error: "No tienes un anexo asignado: asígnate uno o elige el anexo con el que probar." };
  }
  return placeAnuraCall(
    admin,
    // Sin tienda: la prueba no es de ningún pedido, y así nadie más lee por
    // RLS el número que escribió quien administra.
    { orgId: target.orgId, storeId: null, orderId: null, userId: target.userId, mode: "prueba", extension, phone, token },
    deps,
  );
}

