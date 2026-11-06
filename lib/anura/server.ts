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
import {
  ANURA_KAPTA_PHONE_TEXT,
  defaultSipUser,
  normalizeAnuraWsUrl,
  normalizeSipDomain,
  normalizeSipPassword,
  normalizeSipPort,
  normalizeSipUser,
  type AnuraKaptaPhoneStatus,
} from "@/lib/anura/sip";
import {
  ANURA_SIP_NOT_FOUND_STATUS,
  rejectionReason,
  type AnuraPhoneCredentialsResult,
  type AnuraRegistrationFailureKind,
} from "@/lib/anura/sip-phone";
import {
  clearNotFoundRejections,
  deleteSipCredential,
  isMissingTable as isMissingSipTable,
  kaptaPhoneStatus,
  markNotFoundAwaitingTest,
  markSipCredentialRejected,
  readSipCredentialMetas,
  readSipSettings,
  sipPhoneCredentials,
  writeSipCredential,
  writeSipSettings,
} from "@/lib/anura/sip-store";
import { anuraWebhookUrl } from "@/lib/anura/token";
import { talkTimeWords } from "@/lib/browser-call";

export type { AnuraCallLive, AnuraStartResult } from "@/lib/anura/calls";
export type { AnuraPhoneCredentialsResult } from "@/lib/anura/sip-phone";
export type { AnuraKaptaPhoneStatus } from "@/lib/anura/sip";

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

/** La fila del anexo activo de una persona en una org (id y número), o null. */
export async function anuraExtensionRowOf(admin: SupabaseClient, orgId: string, userId: string): Promise<{ id: string; extension: string } | null> {
  const { data } = await admin
    .from("anura_extensions")
    .select("id,extension")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("active", true)
    .maybeSingle();
  const row = data as { id?: string; extension?: string } | null;
  return row?.id && row.extension ? { id: row.id, extension: row.extension } : null;
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
  // `getMasterPermissions` junta los permisos de TODAS las orgs: hace falta
  // `master.edit` en la org del pedido.
  if (!(await hasOrgPermission(target.orgId, "master.edit"))) return { ok: false, error: ANURA_DENIED_CALL };
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

export type AnuraRecordingAccess = { ok: true; signedUrl: string } | { ok: false; status: 401 | 404 };

/**
 * La grabación guardada de una llamada, para la ruta del mismo origen
 * (`/api/anura/recordings/<id>`). La oye quien ve la tienda del pedido (RLS
 * de `anura_calls`, como el historial), también quien hizo la llamada: si ya
 * no ve esa tienda (salió de la org), no la oye. Devuelve una URL
 * firmada corta que solo usa el servidor para copiar los bytes: el navegador
 * nunca la ve (la CSP no le deja cargar audio de Supabase).
 */
export async function anuraRecordingAccessFor(callId: string): Promise<AnuraRecordingAccess> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401 };
  if (!isUuid(callId)) return { ok: false, status: 404 };
  const admin = createAdminSupabase();
  const { data } = await admin.from("anura_calls").select("id,user_id,recording_status,recording_path").eq("id", callId).maybeSingle();
  const row = data as { id: string; user_id: string | null; recording_status: string; recording_path: string | null } | null;
  if (!row) return { ok: false, status: 404 };
  // Siempre por RLS, también para quien la hizo: una grabación lleva datos de la clienta.
  const sb = await createServerSupabase();
  const { data: visible } = await sb.from("anura_calls").select("id").eq("id", callId).maybeSingle();
  if (!visible) return { ok: false, status: 404 };
  if (row.recording_status !== "guardada" || !row.recording_path) return { ok: false, status: 404 };
  const signedUrl = await signedRecordingUrl(admin, row.recording_path);
  return signedUrl ? { ok: true, signedUrl } : { ok: false, status: 404 };
}

/** Una llamada en la ficha del pedido (tarjeta del historial). */
export interface AnuraOrderCall extends AnuraCallLive {
  userId: string | null;
  /** Quién llamó (parte local del correo, como el resto del historial). */
  who: string | null;
  answered: boolean;
  /** «2 min 13 s», o null si no se habló. */
  talkLabel: string | null;
  /**
   * La grabación por una ruta del MISMO origen (`/api/anura/recordings/<id>`),
   * solo si está guardada. La CSP no deja al `<audio>` cargar de Supabase.
   */
  recordingUrl: string | null;
}

/** El teléfono de Kapta del anexo de quien mira (fase 2). */
export interface AnuraKaptaPhoneView {
  /**
   * `listo`: la llamada se hace con el teléfono dentro de Kapta.
   * `sin_telefono`: fase 1 sin cambios (suena su teléfono de Anura).
   * `clave_rechazada` / `dominio_no_reconocido` / `sin_dominio`: no se puede
   * llamar; `message` dice por qué.
   */
  status: AnuraKaptaPhoneStatus;
  message: string | null;
  rejectedAt: string | null;
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
  /** ¿El anexo de quien mira tiene teléfono en Kapta? (fase 2). */
  kaptaPhone: AnuraKaptaPhoneView;
}

const NO_KAPTA_PHONE: AnuraKaptaPhoneView = { status: "sin_telefono", message: null, rejectedAt: null };

/** La ruta del mismo origen que sirve una grabación guardada. */
export function anuraRecordingHref(callId: string): string {
  return `/api/anura/recordings/${callId}`;
}

/** El estado del teléfono de Kapta de un anexo. Sin la 0311: fase 1. */
async function kaptaPhoneOf(admin: SupabaseClient, orgId: string, ext: { id: string; extension: string } | null): Promise<AnuraKaptaPhoneView> {
  if (!ext) return NO_KAPTA_PHONE;
  const [{ settings, missing }, metas] = await Promise.all([readSipSettings(admin, orgId), readSipCredentialMetas(admin, orgId)]);
  if (missing || metas.missing) return NO_KAPTA_PHONE;
  const meta = metas.byExtensionId.get(ext.id) ?? null;
  const status = kaptaPhoneStatus(ext, meta, settings);
  const rejected = status === "clave_rechazada" || status === "dominio_no_reconocido";
  return {
    status,
    message: rejected || status === "sin_dominio" ? ANURA_KAPTA_PHONE_TEXT[status] : null,
    rejectedAt: rejected ? meta?.rejectedAt ?? null : null,
  };
}

function recordingLinkExpired(r: AnuraCallRow, nowMs: number): boolean {
  if (r.recording_status !== "pendiente" || !r.recording_expires_at) return false;
  const at = Date.parse(r.recording_expires_at);
  return Number.isFinite(at) && at <= nowMs;
}

const EMPTY_PANEL: AnuraOrderPanel = { enabled: false, disabledReason: null, extension: null, activeCall: null, calls: [], kaptaPhone: NO_KAPTA_PHONE };

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
  const [perms, extRow, callsRes] = await Promise.all([
    getMasterPermissions(),
    anuraExtensionRowOf(admin, target.orgId, target.userId),
    sb.from("anura_calls").select(ANURA_CALL_COLUMNS).eq("order_id", target.orderId).order("requested_at", { ascending: false }).limit(30),
  ]);
  const extension = extRow?.extension ?? null;
  const rows = ((callsRes.data ?? []) as unknown as AnuraCallRow[]).filter((r) => r.mode === "pedido");

  let disabledReason: string | null = null;
  if (!anuraConfigured(target.orgId)) disabledReason = ANURA_NOT_CONFIGURED;
  else if (!perms.can("master.edit")) disabledReason = ANURA_DENIED_CALL;
  else if (!extension) disabledReason = ANURA_NO_EXTENSION;
  else if (!anuraPeruCalled(target.phone)) disabledReason = ANURA_BAD_PHONE;

  const [names, active, kaptaPhone] = await Promise.all([
    resolveAgentNames(rows.map((r) => r.user_id ?? "").filter(Boolean), admin),
    extension ? activeAnuraCallOf(admin, target.userId) : Promise.resolve(null),
    disabledReason === null ? kaptaPhoneOf(admin, target.orgId, extRow) : Promise.resolve(NO_KAPTA_PHONE),
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
    kaptaPhone,
    calls: rows.map((r) => {
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
        recordingUrl: r.recording_status === "guardada" && r.recording_path ? anuraRecordingHref(r.id) : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// El teléfono dentro de Kapta (fase 2, solo salidas)
// ---------------------------------------------------------------------------

export const ANURA_PHONE_NOT_OWNER =
  "La clave del teléfono de Kapta solo se entrega a la dueña del anexo: prueba con tu propio anexo.";

/** Las credenciales SIP del anexo propio de `userId` en `orgId`, o por qué no. */
async function ownPhoneCredentials(admin: SupabaseClient, orgId: string, userId: string): Promise<AnuraPhoneCredentialsResult> {
  if (!anuraConfigured(orgId)) return { ok: false, code: "no_configurado", error: ANURA_NOT_CONFIGURED };
  const ext = await anuraExtensionRowOf(admin, orgId, userId);
  if (!ext) return { ok: false, code: "sin_anexo", error: ANURA_NO_EXTENSION };
  return sipPhoneCredentials(admin, orgId, ext);
}

/**
 * Las credenciales del teléfono de Kapta para llamar desde la ficha. SOLO a
 * la dueña del anexo, en el momento de llamar: `master.edit`, el pedido
 * visible por RLS, Anura encendido para la org del pedido (token y
 * ANURA_ORG_ID), un anexo ACTIVO propio en esa org y su clave guardada y no
 * rechazada. La contraseña no se escribe en ningún log; el navegador la
 * guarda solo en memoria mientras dura la llamada.
 */
export async function anuraPhoneForOrder(orderId: string): Promise<AnuraPhoneCredentialsResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) return { ok: false, code: "permiso", error: ANURA_DENIED_CALL };
  const target = await orderTarget(orderId);
  if ("error" in target) return { ok: false, code: target.error.startsWith("Tu sesión") ? "sesion" : "pedido", error: target.error };
  // La clave solo con `master.edit` en la org DEL PEDIDO (no en otra org de la persona).
  if (!(await hasOrgPermission(target.orgId, "master.edit"))) return { ok: false, code: "permiso", error: ANURA_DENIED_CALL };
  if (!anuraPeruCalled(target.phone)) return { ok: false, code: "pedido", error: ANURA_BAD_PHONE };
  return ownPhoneCredentials(createAdminSupabase(), target.orgId, target.userId);
}

/**
 * Las credenciales del teléfono de Kapta para la llamada de prueba de
 * Ajustes: quien administra (`stores.manage`) y SOLO con su propio anexo. Con
 * el anexo de otra persona no se entrega la clave.
 */
export async function anuraTestPhoneFor(storeId: string, rawExtension?: string | null): Promise<AnuraPhoneCredentialsResult> {
  const target = await adminTarget(storeId);
  if ("error" in target) return { ok: false, code: target.error === ANURA_DENIED_ADMIN ? "permiso" : "sesion", error: target.error };
  const admin = createAdminSupabase();
  if (rawExtension) {
    const wanted = normalizeAnuraExtension(rawExtension);
    const own = await anuraExtensionRowOf(admin, target.orgId, target.userId);
    if (!wanted || !own || own.extension !== wanted) return { ok: false, code: "permiso", error: ANURA_PHONE_NOT_OWNER };
  }
  return ownPhoneCredentials(admin, target.orgId, target.userId);
}

export type AnuraPhoneRejectScope = { orderId: string } | { storeId: string };

/**
 * El teléfono de la asesora no pudo registrarse porque Anura lo rechazó. Dos
 * casos, los dos se detienen sin reintentar (varios intentos fallidos hacen
 * que Anura bloquee la IP de la oficina):
 *   · `clave` (SIP 401/403/407): se marca «clave rechazada» y Kapta no la
 *     vuelve a entregar hasta que se guarde otra.
 *   · `dominio` (SIP 404/604, «Not Found»): Anura no reconoce ese usuario en
 *     ese dominio. Se marca «dominio no reconocido»: Kapta no vuelve a probar
 *     esa clave con ese dominio; corregir el dominio de la central o volver a
 *     «Probar y guardar» lo destraba. Si el navegador manda el dominio con el
 *     que probó y la central ya tiene otro, no se marca (ya lo corrigieron).
 * Un 404 que llegue como `clave` (pestañas de antes de este cambio) se trata
 * como `dominio`. Solo marca el anexo PROPIO, y solo la versión de la clave
 * que se entregó (si alguien guardó otra entretanto, no la toca). Un fallo
 * que no es un rechazo no marca nada.
 */
export async function reportAnuraPhoneRejectedFor(
  scope: AnuraPhoneRejectScope,
  input: { credentialVersion: string; kind: AnuraRegistrationFailureKind; status?: number | null; domain?: string | null },
): Promise<{ ok: true; marked: boolean } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Tu sesión venció. Vuelve a entrar." };
  if (input.kind !== "clave" && input.kind !== "dominio") return { ok: true, marked: false };
  const version = typeof input.credentialVersion === "string" ? input.credentialVersion.trim() : "";
  if (!version || version.length > 64 || Number.isNaN(Date.parse(version))) return { ok: false, error: "Versión de la clave no válida." };
  const status = Number.isInteger(input.status) && (input.status as number) >= 100 && (input.status as number) < 700 ? (input.status as number) : null;
  const kind: "clave" | "dominio" = input.kind === "dominio" || (status !== null && ANURA_SIP_NOT_FOUND_STATUS.has(status)) ? "dominio" : "clave";
  const triedDomain = typeof input.domain === "string" && input.domain.trim() ? normalizeSipDomain(input.domain) : null;

  let orgId: string | null = null;
  if ("orderId" in scope) {
    const target = await orderTarget(scope.orderId);
    if ("error" in target) return { ok: false, error: target.error };
    orgId = target.orgId;
  } else {
    orgId = await orgOfStore(await createServerSupabase(), scope.storeId);
    if (!orgId) return { ok: false, error: "Tienda no encontrada." };
  }
  const admin = createAdminSupabase();
  const ext = await anuraExtensionRowOf(admin, orgId, user.id);
  if (!ext) return { ok: false, error: ANURA_NO_EXTENSION };
  if (kind === "dominio" && triedDomain) {
    // Si la central ya tiene otro dominio, el 404 era del anterior: no se marca.
    const { settings } = await readSipSettings(admin, orgId);
    if (settings.domain && settings.domain !== triedDomain) return { ok: true, marked: false };
  }
  const marked = await markSipCredentialRejected(admin, {
    orgId,
    extensionId: ext.id,
    credentialVersion: version,
    reason: rejectionReason(kind, status),
  });
  return { ok: true, marked };
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
  /** El teléfono de Kapta de este anexo (fase 2). Nunca la clave. */
  phone: AnuraExtensionPhoneView;
}

export interface AnuraExtensionPhoneView {
  status: AnuraKaptaPhoneStatus;
  /** El usuario SIP guardado, o el sugerido (`<anexo>-websocket`) si no hay clave. */
  sipUser: string;
  /** «Clave guardada: sí/no». */
  hasPassword: boolean;
  savedAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
}

/** La central SIP de la org (fase 2). No es secreto. */
export interface AnuraSipSettingsView {
  domain: string | null;
  wsUrl: string;
  port: number;
  updatedAt: string | null;
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
  /** La central SIP del teléfono de Kapta (fase 2). */
  sip: AnuraSipSettingsView;
  /** Las tablas de la 0311 todavía no existen: no se pueden guardar claves. */
  sipMigrationMissing: boolean;
}

export type AnuraSettingsResult = { ok: true; data: AnuraSettingsData } | { ok: false; error: string };

/** Sin `0310` la tabla no existe: la sección lo dice en vez de caerse. */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  return isMissingSipTable(error);
}

/** Todo lo de la sección «Telefonía Anura» de Ajustes. */
export async function loadAnuraSettings(storeId: string, siteUrl: string): Promise<AnuraSettingsResult> {
  const target = await adminTarget(storeId);
  if ("error" in target) return { ok: false, error: target.error };
  const admin = createAdminSupabase();
  const since = new Date(Date.now() - ANURA_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  const [extRes, memberRes, eventRes, sipRes, metaRes] = await Promise.all([
    admin.from("anura_extensions").select("id,user_id,extension,active").eq("org_id", target.orgId).order("extension"),
    admin.from("memberships").select("user_id,role").eq("org_id", target.orgId),
    admin
      .from("anura_webhook_events")
      .select("id,received_at,event,direction,anura_status,outcome,detail,payload,call_id")
      .eq("org_id", target.orgId)
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(50),
    readSipSettings(admin, target.orgId),
    readSipCredentialMetas(admin, target.orgId),
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
      extensions: exts.map((e) => {
        const meta = metaRes.byExtensionId.get(e.id) ?? null;
        const valid = meta && meta.extension === e.extension ? meta : null;
        return {
          id: e.id,
          userId: e.user_id,
          name: names[e.user_id] ?? e.user_id.slice(0, 8),
          extension: e.extension,
          active: e.active,
          phone: {
            status: kaptaPhoneStatus({ id: e.id, extension: e.extension }, valid, sipRes.settings),
            sipUser: valid?.sipUser ?? defaultSipUser(e.extension),
            hasPassword: !!valid,
            savedAt: valid?.savedAt ?? null,
            rejectedAt: valid?.rejectedAt ?? null,
            rejectedReason: valid?.rejectedReason ?? null,
          },
        };
      }),
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
      sip: { ...sipRes.settings },
      sipMigrationMissing: sipRes.missing || metaRes.missing,
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
  const { data: before } = await admin
    .from("anura_extensions")
    .select("id,extension")
    .eq("org_id", target.orgId)
    .eq("user_id", userId)
    .maybeSingle();
  const previous = before as { id?: string; extension?: string } | null;
  const { error } = await admin
    .from("anura_extensions")
    .upsert({ org_id: target.orgId, user_id: userId, extension, active: true, created_by: target.userId }, { onConflict: "org_id,user_id" });
  if (error) {
    if (error.code === "23505") return { ok: false, error: `El anexo ${extension} ya está asignado a otra persona.` };
    return { ok: false, error: `No se pudo guardar el anexo: ${error.message}` };
  }
  // La clave de la «101-websocket» no sirve para la 102: cambiar el número
  // borra la clave (la base también lo hace, 0311).
  if (previous?.id && previous.extension && previous.extension !== extension) {
    await deleteSipCredential(admin, target.orgId, previous.id).catch(() => null);
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

/** El anexo de la org por id (para las claves SIP). */
async function orgExtensionById(admin: SupabaseClient, orgId: string, extensionId: string): Promise<{ id: string; extension: string } | null> {
  if (!isUuid(extensionId)) return null;
  const { data } = await admin.from("anura_extensions").select("id,extension").eq("id", extensionId).eq("org_id", orgId).maybeSingle();
  const row = data as { id?: string; extension?: string } | null;
  return row?.id && row.extension ? { id: row.id, extension: row.extension } : null;
}

export interface AnuraSipSettingsInput {
  domain: string;
  /** Vacío = wss://sipwss.anura.pe. */
  wsUrl?: string | null;
  /** Vacío = 55090. */
  port?: number | string | null;
}

type SipSettingsParsed = { domain: string; wsUrl: string; port: number } | { error: string };

function parseSipSettings(input: AnuraSipSettingsInput | null | undefined): SipSettingsParsed {
  const domain = normalizeSipDomain(input?.domain);
  if (!domain) return { error: "Escribe el dominio de la central tal como sale en «Obtener credenciales» (por ejemplo, miempresa.anura.pe)." };
  const wsUrl = normalizeAnuraWsUrl(input?.wsUrl ?? null);
  if (!wsUrl) return { error: "La URL WebSocket tiene que ser wss:// a un servidor de anura.pe (por defecto, wss://sipwss.anura.pe)." };
  const port = normalizeSipPort(input?.port ?? null);
  if (!port) return { error: "El puerto SIP es un número de 1 a 65535 (en Perú, 55090)." };
  return { domain, wsUrl, port };
}

/**
 * Guarda la central SIP de la org (dominio, URL WebSocket, puerto). Con OTRO
 * dominio no libera los anexos «dominio no reconocido»: los deja esperando
 * que Anura acepte el nuevo en un «Probar y guardar» (si el nuevo también
 * estuviera mal, cada anexo gastaría un 404 más desde la misma oficina).
 */
export async function saveAnuraSipSettingsFor(storeId: string, input: AnuraSipSettingsInput): Promise<AnuraMutationResult> {
  const target = await adminTarget(storeId);
  if ("error" in target) return { ok: false, error: target.error };
  const parsed = parseSipSettings(input);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const admin = createAdminSupabase();
  const before = await readSipSettings(admin, target.orgId);
  const error = await writeSipSettings(admin, target.orgId, parsed, target.userId);
  if (error) return { ok: false, error: isMissingTable({ message: error }) ? "Falta aplicar la migración 0311 (teléfono de Kapta)." : `No se pudo guardar la central: ${error}` };
  // Si no se pudo leer lo anterior, no se sabe si el dominio cambió: no se toca ninguna marca.
  const waiting = !before.failed && before.settings.domain !== parsed.domain ? await markNotFoundAwaitingTest(admin, target.orgId) : 0;
  return { ok: true, notice: `Central de Anura guardada.${waiting ? ` ${ANURA_DOMAIN_RETEST_NOTICE(waiting)}` : ""}` };
}

/** Lo que se dice al guardar otro dominio si había anexos con «dominio no reconocido». */
export const ANURA_DOMAIN_RETEST_NOTICE = (n: number) =>
  (n === 1
    ? "El anexo que Anura no reconocía con el dominio anterior sigue en pausa"
    : `Los ${n} anexos que Anura no reconocía con el dominio anterior siguen en pausa`) +
  ": prueba el dominio nuevo con «Probar y guardar» en un anexo. Cuando Anura lo acepte, se vuelven a probar en su próxima llamada, sin volver a escribir sus claves.";

/** Lo que se dice cuando un «Probar y guardar» liberó otros anexos con «dominio no reconocido». */
export const ANURA_DOMAIN_FREED_NOTICE = (n: number) =>
  n === 1
    ? "Anura aceptó el dominio: el otro anexo que no reconocía con el dominio anterior se probará con este en su próxima llamada."
    : `Anura aceptó el dominio: los otros ${n} anexos que no reconocía con el dominio anterior se probarán con este en su próxima llamada.`;

export interface AnuraSipCredentialsInput extends AnuraSipSettingsInput {
  /** Vacío = `<anexo>-websocket`. */
  sipUser?: string | null;
  password: string;
}

/**
 * «Probar y guardar»: el navegador de quien administra ya hizo UN registro
 * con estos datos y Anura lo aceptó; aquí se guardan la central (si cambió) y
 * la clave CIFRADA del anexo. Limpia «clave rechazada». El servidor no puede
 * comprobar la prueba (la hizo el navegador): confía en quien administra,
 * que de todos modos puede escribir la clave.
 */
export async function saveAnuraSipCredentialsFor(storeId: string, extensionId: string, input: AnuraSipCredentialsInput): Promise<AnuraMutationResult> {
  const target = await adminTarget(storeId);
  if ("error" in target) return { ok: false, error: target.error };
  const admin = createAdminSupabase();
  const ext = await orgExtensionById(admin, target.orgId, extensionId);
  if (!ext) return { ok: false, error: "Anexo no encontrado." };
  const parsed = parseSipSettings(input);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const sipUser = normalizeSipUser(input?.sipUser ?? null, ext.extension);
  if (!sipUser) return { ok: false, error: "El usuario SIP solo lleva letras, números, punto, guion o guion bajo (por ejemplo, 101-websocket)." };
  const password = normalizeSipPassword(input?.password);
  if (!password) return { ok: false, error: "Escribe la contraseña SIP de la terminal web (hasta 128 caracteres, sin saltos de línea)." };

  const { settings, missing, failed } = await readSipSettings(admin, target.orgId);
  if (missing) return { ok: false, error: "Falta aplicar la migración 0311 (teléfono de Kapta)." };
  const domainChanged = !failed && settings.domain !== parsed.domain;
  if (failed || settings.domain !== parsed.domain || settings.wsUrl !== parsed.wsUrl || settings.port !== parsed.port) {
    const error = await writeSipSettings(admin, target.orgId, parsed, target.userId);
    if (error) return { ok: false, error: `No se pudo guardar la central: ${error}` };
  }
  const saved = await writeSipCredential(admin, {
    orgId: target.orgId,
    extensionId: ext.id,
    extension: ext.extension,
    sipUser,
    password,
    byUserId: target.userId,
  });
  if ("error" in saved) return { ok: false, error: saved.error };
  // Anura aceptó ESTE dominio: los demás anexos que no reconocía con uno
  // anterior vuelven a probar una vez. Si la prueba misma cambió el dominio,
  // todas las marcas 404 son de uno anterior; si ya estaba guardado, solo las
  // que esperaban la prueba (las hechas con este dominio siguen: ahí falla el
  // usuario). Sin lectura fiable de lo anterior, solo las que esperaban.
  const freed = await clearNotFoundRejections(admin, target.orgId, { onlyAwaitingTest: !domainChanged });
  return {
    ok: true,
    notice: `Teléfono de Kapta listo para el anexo ${ext.extension}.${freed ? ` ${ANURA_DOMAIN_FREED_NOTICE(freed)}` : ""}`,
  };
}

/** «Quitar clave»: el anexo vuelve a la fase 1 (suena su teléfono de Anura). */
export async function removeAnuraSipCredentialsFor(storeId: string, extensionId: string): Promise<AnuraMutationResult> {
  const target = await adminTarget(storeId);
  if ("error" in target) return { ok: false, error: target.error };
  const admin = createAdminSupabase();
  const ext = await orgExtensionById(admin, target.orgId, extensionId);
  if (!ext) return { ok: false, error: "Anexo no encontrado." };
  const res = await deleteSipCredential(admin, target.orgId, ext.id);
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, notice: res.removed ? `Clave del anexo ${ext.extension} quitada.` : `El anexo ${ext.extension} no tenía clave guardada.` };
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

