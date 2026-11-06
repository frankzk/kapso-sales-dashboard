import "server-only";

// «Llamar con Anura», fase 2: la central SIP de la org y la clave SIP de cada
// anexo en la base (0311). SERVIDOR.
//
// La contraseña SIP se guarda cifrada con lib/crypto.ts (AES-256-GCM, la
// misma ENCRYPTION_KEY de los tokens de las tiendas) en `anura_sip_credentials`,
// que solo lee el service role. Se descifra aquí y SOLO para entregársela a
// la dueña del anexo en el momento de llamar (lo decide lib/anura/server.ts).
// Nunca se escribe en un log ni se devuelve en una lectura de Ajustes: ahí
// solo sale «clave guardada: sí/no», la fecha y si Anura la rechazó.
//
// Reciben el cliente service-role ya autorizado.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "@/lib/crypto";
import {
  ANURA_DEFAULT_ICE_SERVERS,
  ANURA_DEFAULT_SIP_PORT,
  ANURA_DEFAULT_WS_URL,
  ANURA_KAPTA_PHONE_TEXT,
  ANURA_SIP_NOT_FOUND_LEGACY_MARKS,
  ANURA_SIP_NOT_FOUND_REASON,
  ANURA_SIP_NOT_FOUND_RETEST,
  isNotFoundAwaitingTest,
  isNotFoundRejection,
  type AnuraKaptaPhoneStatus,
} from "@/lib/anura/sip";
import type { AnuraPhoneCredentials, AnuraPhoneCredentialsResult } from "@/lib/anura/sip-phone";

export const ANURA_SIP_SETTINGS_TABLE = "anura_sip_settings";
export const ANURA_SIP_CREDENTIALS_TABLE = "anura_sip_credentials";

export interface AnuraSipSettings {
  domain: string | null;
  wsUrl: string;
  port: number;
  updatedAt: string | null;
}

export const DEFAULT_SIP_SETTINGS: AnuraSipSettings = { domain: null, wsUrl: ANURA_DEFAULT_WS_URL, port: ANURA_DEFAULT_SIP_PORT, updatedAt: null };

/** Sin `0311` la tabla no existe: todo sigue como en la fase 1. */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(error.message ?? "");
}

/**
 * La central SIP de la org (o los valores por defecto). `missing`: falta la
 * 0311. `failed`: la lectura falló, así que `settings` NO es lo guardado.
 */
export async function readSipSettings(admin: SupabaseClient, orgId: string): Promise<{ settings: AnuraSipSettings; missing: boolean; failed: boolean }> {
  const { data, error } = await admin
    .from(ANURA_SIP_SETTINGS_TABLE)
    .select("sip_domain,ws_url,sip_port,updated_at")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return { settings: { ...DEFAULT_SIP_SETTINGS }, missing: isMissingTable(error), failed: true };
  const row = data as { sip_domain: string | null; ws_url: string | null; sip_port: number | null; updated_at: string | null } | null;
  if (!row) return { settings: { ...DEFAULT_SIP_SETTINGS }, missing: false, failed: false };
  return {
    settings: {
      domain: row.sip_domain || null,
      wsUrl: row.ws_url || ANURA_DEFAULT_WS_URL,
      port: row.sip_port ?? ANURA_DEFAULT_SIP_PORT,
      updatedAt: row.updated_at,
    },
    missing: false,
    failed: false,
  };
}

export async function writeSipSettings(
  admin: SupabaseClient,
  orgId: string,
  values: { domain: string; wsUrl: string; port: number },
  byUserId: string,
): Promise<string | null> {
  const { error } = await admin
    .from(ANURA_SIP_SETTINGS_TABLE)
    .upsert({ org_id: orgId, sip_domain: values.domain, ws_url: values.wsUrl, sip_port: values.port, updated_by: byUserId }, { onConflict: "org_id" });
  return error ? error.message : null;
}

/** La fila de la clave, SIN el cifrado (para Ajustes y el estado de la ficha). */
export interface SipCredentialMeta {
  extensionId: string;
  extension: string;
  sipUser: string;
  savedAt: string;
  rejectedAt: string | null;
  rejectedReason: string | null;
}

const META_COLUMNS = "extension_id,extension,sip_user,saved_at,rejected_at,rejected_reason";

type MetaRow = {
  extension_id: string;
  extension: string;
  sip_user: string;
  saved_at: string;
  rejected_at: string | null;
  rejected_reason: string | null;
};

const toMeta = (r: MetaRow): SipCredentialMeta => ({
  extensionId: r.extension_id,
  extension: r.extension,
  sipUser: r.sip_user,
  savedAt: r.saved_at,
  rejectedAt: r.rejected_at,
  rejectedReason: r.rejected_reason,
});

/** Las claves guardadas de la org, por id de anexo. `missing`: falta la 0311. */
export async function readSipCredentialMetas(admin: SupabaseClient, orgId: string): Promise<{ byExtensionId: Map<string, SipCredentialMeta>; missing: boolean }> {
  const { data, error } = await admin.from(ANURA_SIP_CREDENTIALS_TABLE).select(META_COLUMNS).eq("org_id", orgId);
  if (error) return { byExtensionId: new Map(), missing: isMissingTable(error) };
  return { byExtensionId: new Map(((data ?? []) as MetaRow[]).map((r) => [r.extension_id, toMeta(r)])), missing: false };
}

/**
 * El estado del teléfono de Kapta de un anexo. Una clave guardada para otro
 * número de anexo no vale (la base la borra al cambiar el número; esto es la
 * segunda red).
 */
export function kaptaPhoneStatus(
  ext: { id: string; extension: string } | null,
  meta: SipCredentialMeta | null | undefined,
  settings: Pick<AnuraSipSettings, "domain">,
): AnuraKaptaPhoneStatus {
  if (!ext || !meta || meta.extensionId !== ext.id || meta.extension !== ext.extension) return "sin_telefono";
  if (meta.rejectedAt) return isNotFoundRejection(meta.rejectedReason) ? "dominio_no_reconocido" : "clave_rechazada";
  if (!settings.domain) return "sin_dominio";
  return "listo";
}

/** Guarda (o cambia) la clave de un anexo, cifrada. Limpia «clave rechazada». */
export async function writeSipCredential(
  admin: SupabaseClient,
  input: { orgId: string; extensionId: string; extension: string; sipUser: string; password: string; byUserId: string },
  now: Date = new Date(),
): Promise<{ savedAt: string } | { error: string }> {
  let cipher: string;
  try {
    cipher = encrypt(input.password);
  } catch {
    return { error: "No se pudo cifrar la clave: falta ENCRYPTION_KEY en el servidor." };
  }
  const savedAt = now.toISOString();
  const { error } = await admin.from(ANURA_SIP_CREDENTIALS_TABLE).upsert(
    {
      extension_id: input.extensionId,
      org_id: input.orgId,
      extension: input.extension,
      sip_user: input.sipUser,
      password_cipher: cipher,
      saved_by: input.byUserId,
      saved_at: savedAt,
      rejected_at: null,
      rejected_reason: null,
    },
    { onConflict: "extension_id" },
  );
  if (error) return { error: isMissingTable(error) ? "Falta aplicar la migración 0311 (teléfono de Kapta)." : `No se pudo guardar la clave: ${error.message}` };
  return { savedAt };
}

export async function deleteSipCredential(admin: SupabaseClient, orgId: string, extensionId: string): Promise<{ removed: boolean } | { error: string }> {
  const { data, error } = await admin
    .from(ANURA_SIP_CREDENTIALS_TABLE)
    .delete()
    .eq("org_id", orgId)
    .eq("extension_id", extensionId)
    .select("extension_id");
  if (error) return { error: `No se pudo quitar la clave: ${error.message}` };
  return { removed: (data ?? []).length > 0 };
}

/**
 * Marca «clave rechazada» la clave de ESA versión (la que se entregó). Si
 * mientras tanto alguien guardó otra, no la toca. Devuelve si marcó.
 */
export async function markSipCredentialRejected(
  admin: SupabaseClient,
  input: { orgId: string; extensionId: string; credentialVersion: string; reason: string },
  now: Date = new Date(),
): Promise<boolean> {
  const { data, error } = await admin
    .from(ANURA_SIP_CREDENTIALS_TABLE)
    .update({ rejected_at: now.toISOString(), rejected_reason: input.reason.slice(0, 200) })
    .eq("org_id", input.orgId)
    .eq("extension_id", input.extensionId)
    .eq("saved_at", input.credentialVersion)
    .is("rejected_at", null)
    .select("extension_id");
  return !error && (data ?? []).length > 0;
}

/**
 * «Guardar central» guardó OTRO dominio: las marcas «dominio no reconocido»
 * (404 con el dominio anterior) pasan a esperar que Anura acepte el nuevo
 * (`ANURA_SIP_NOT_FOUND_RETEST` al final del motivo). NO se liberan todavía:
 * si el dominio nuevo también está mal, cada anexo gastaría un 404 más desde
 * la misma oficina. Las libera `clearNotFoundRejections` cuando un «Probar y
 * guardar» con el dominio nuevo sale bien. Devuelve cuántas dejó esperando (0
 * si falla: no es motivo para no guardar el dominio).
 */
export async function markNotFoundAwaitingTest(admin: SupabaseClient, orgId: string): Promise<number> {
  let waiting = 0;
  try {
    const { data, error } = await admin
      .from(ANURA_SIP_CREDENTIALS_TABLE)
      .select("extension_id,rejected_reason")
      .eq("org_id", orgId)
      .not("rejected_at", "is", null);
    if (error) return 0;
    for (const row of (data ?? []) as { extension_id: string; rejected_reason: string | null }[]) {
      const reason = row.rejected_reason;
      if (!reason || !isNotFoundRejection(reason) || isNotFoundAwaitingTest(reason)) continue;
      const next = `${reason.slice(0, 200 - ANURA_SIP_NOT_FOUND_RETEST.length)}${ANURA_SIP_NOT_FOUND_RETEST}`;
      const res = await admin
        .from(ANURA_SIP_CREDENTIALS_TABLE)
        .update({ rejected_reason: next })
        .eq("org_id", orgId)
        .eq("extension_id", row.extension_id)
        .eq("rejected_reason", reason)
        .select("extension_id");
      if (!res.error) waiting += (res.data ?? []).length;
    }
  } catch {
    // no es motivo para no guardar el dominio
  }
  return waiting;
}

/**
 * Anura ACEPTÓ un «Probar y guardar» con el dominio de la central: se liberan
 * las marcas «dominio no reconocido» hechas con un dominio anterior, que
 * vuelven a probar UNA vez, cada una en su próxima llamada:
 *   · `onlyAwaitingTest` (el dominio ya estaba guardado): solo las que
 *     esperaban la prueba (`markNotFoundAwaitingTest`); las hechas con ESTE
 *     dominio siguen marcadas (ahí lo que está mal es el usuario);
 *   · sin él (la prueba misma cambió el dominio): todas, porque todas se
 *     hicieron con un dominio anterior.
 * Un «clave rechazada» (401/403/407) NO se toca: ahí lo que está mal es la
 * clave. Devuelve cuántas liberó (0 si falla: la clave ya se guardó).
 */
export async function clearNotFoundRejections(admin: SupabaseClient, orgId: string, opts: { onlyAwaitingTest?: boolean } = {}): Promise<number> {
  let freed = 0;
  const patterns = opts.onlyAwaitingTest
    ? [`%${ANURA_SIP_NOT_FOUND_RETEST}`]
    : [`${ANURA_SIP_NOT_FOUND_REASON}%`, ...ANURA_SIP_NOT_FOUND_LEGACY_MARKS.map((m) => `%${m}%`)];
  for (const pattern of patterns) {
    try {
      const { data, error } = await admin
        .from(ANURA_SIP_CREDENTIALS_TABLE)
        .update({ rejected_at: null, rejected_reason: null })
        .eq("org_id", orgId)
        .not("rejected_at", "is", null)
        .like("rejected_reason", pattern)
        .select("extension_id");
      if (!error) freed += (data ?? []).length;
    } catch {
      // la clave ya se guardó; la marca sigue y se puede liberar en otra prueba
    }
  }
  return freed;
}

/**
 * Las credenciales del teléfono de un anexo, descifradas, o por qué no. Quien
 * llama ya comprobó que el anexo es de quien las pide.
 */
export async function sipPhoneCredentials(
  admin: SupabaseClient,
  orgId: string,
  ext: { id: string; extension: string },
): Promise<AnuraPhoneCredentialsResult> {
  const [{ settings, missing: settingsMissing }, credRes] = await Promise.all([
    readSipSettings(admin, orgId),
    admin
      .from(ANURA_SIP_CREDENTIALS_TABLE)
      .select(`${META_COLUMNS},password_cipher`)
      .eq("org_id", orgId)
      .eq("extension_id", ext.id)
      .maybeSingle(),
  ]);
  if (settingsMissing || isMissingTable(credRes.error)) return { ok: false, code: "sin_telefono", error: ANURA_KAPTA_PHONE_TEXT.sin_telefono };
  if (credRes.error) return { ok: false, code: "base", error: "No se pudo leer el teléfono de Kapta. Inténtalo otra vez." };
  const row = credRes.data as (MetaRow & { password_cipher: string }) | null;
  const meta = row ? toMeta(row) : null;
  const status = kaptaPhoneStatus(ext, meta, settings);
  if (status !== "listo" || !row || !settings.domain) {
    const code = status === "listo" ? "sin_telefono" : status;
    return { ok: false, code, error: ANURA_KAPTA_PHONE_TEXT[code] };
  }
  let password: string;
  try {
    password = decrypt(row.password_cipher);
  } catch {
    return { ok: false, code: "base", error: "No se pudo abrir la clave del teléfono de Kapta. Pide a quien administra que la vuelva a guardar." };
  }
  const phone: AnuraPhoneCredentials = {
    extension: ext.extension,
    sipUser: row.sip_user,
    password,
    domain: settings.domain,
    wsUrl: settings.wsUrl,
    port: settings.port,
    iceServers: ANURA_DEFAULT_ICE_SERVERS.map((s) => ({ ...s })),
    credentialVersion: row.saved_at,
  };
  return { ok: true, phone };
}
