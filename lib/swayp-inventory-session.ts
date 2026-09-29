// La sesión del panel de Swayp que el sync DIARIO reutiliza mientras está
// vigente, y la llave de la extensión de Chrome que la envía.
//
// POR QUÉ. Swayp no da (todavía) una credencial de API con acceso al
// inventario —la de las guías responde 403 «No tienes autorización 7301»— y el
// login del panel exige reCAPTCHA, que existe justamente para que un programa
// no inicie sesión solo. Lo legítimo es reutilizar la sesión que una PERSONA
// abrió: al pegar su token en Stock Swayp, o al abrir el panel con la extensión
// instalada. Kapta la guarda cifrada hasta que vence y sincroniza, como mucho,
// una vez cada `HORAS_ENTRE_SYNCS`. Sólo lee inventario y bodegas.
//
// Si algún día existe `SWAYP_INVENTORY_TOKEN` (credencial de API), manda sobre
// la sesión: no vence y no depende de nadie.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "@/lib/crypto";
import type { SwaypInventoryCreds } from "@/lib/swayp-inventory-api";
import {
  credencialInventarioDesdeEnv,
  sincronizarInventarioSwayp,
  type SyncResult,
} from "@/lib/swayp-inventory-sync";

/** Una vez al día basta (decisión del 29-09-2026); 20 h deja holgura al horario. */
export const HORAS_ENTRE_SYNCS = 20;

/** Margen para no usar un token que vence mientras corre el sync. */
const MARGEN_MS = 3 * 60_000;

/** Si el token no dice cuándo vence, se asume lo peor razonable: una hora. */
const VIDA_POR_DEFECTO_MS = 60 * 60_000;

/**
 * Cuándo vence un JWT, leído de su `exp`. No verifica la firma —no hace falta:
 * sólo decide hasta cuándo INTENTAR usarlo; Swayp es quien lo valida—. null si
 * no es un JWT o no trae `exp`.
 */
export function vencimientoDeToken(token: string): Date | null {
  const partes = token.trim().replace(/^bearer\s+/i, "").split(".");
  if (partes.length !== 3) return null;
  try {
    const json = Buffer.from(partes[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = Number((JSON.parse(json) as { exp?: unknown }).exp);
    return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

/** ¿Toca sincronizar? Sí si nunca se hizo o la última buena fue hace ≥ 20 h. */
export function debeSincronizar(ultimaOk: Date | null, ahora: Date = new Date()): boolean {
  if (!ultimaOk) return true;
  return ahora.getTime() - ultimaOk.getTime() >= HORAS_ENTRE_SYNCS * 3_600_000;
}

/** Cuándo fue la última sincronización que terminó bien (manual o automática). */
export async function ultimaSincronizacionOk(admin: SupabaseClient, orgId: string): Promise<Date | null> {
  const { data } = await admin
    .from("swayp_inventory_sync_runs")
    .select("created_at")
    .eq("org_id", orgId)
    .eq("ok", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const at = (data as { created_at: string } | null)?.created_at;
  return at ? new Date(at) : null;
}

// ── Sesión guardada ──────────────────────────────────────────────────────────

/**
 * Guarda (cifrada) la sesión con la que alguien acaba de leer Swayp, para que
 * el sync diario la reutilice. Reemplaza a la anterior. Devuelve cuándo vence.
 */
export async function guardarSesionSwayp(
  admin: SupabaseClient,
  input: { orgId: string; creds: SwaypInventoryCreds; source: "manual" | "extension"; userId: string | null },
): Promise<Date> {
  const vence = vencimientoDeToken(input.creds.token) ?? new Date(Date.now() + VIDA_POR_DEFECTO_MS);
  const { error } = await admin.from("swayp_inventory_sessions").upsert(
    {
      org_id: input.orgId,
      token_enc: encrypt(input.creds.token),
      email: input.creds.email,
      ruc: input.creds.user,
      id_company: input.creds.idCompany,
      expires_at: vence.toISOString(),
      source: input.source,
      saved_by: input.userId,
      saved_at: new Date().toISOString(),
    },
    { onConflict: "org_id" },
  );
  if (error) throw new Error(`No se pudo guardar la sesión de Swayp: ${error.message}`);
  return vence;
}

export interface SesionGuardada {
  creds: SwaypInventoryCreds;
  expiresAt: Date;
  source: "manual" | "extension";
  savedAt: Date;
}

/** Datos de la sesión guardada, SIN el token: lo que puede ver la pantalla. */
export async function infoSesionGuardada(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ expiresAt: string; source: "manual" | "extension"; savedAt: string } | null> {
  const { data } = await admin
    .from("swayp_inventory_sessions")
    .select("expires_at,source,saved_at")
    .eq("org_id", orgId)
    .maybeSingle();
  const r = data as { expires_at: string; source: "manual" | "extension"; saved_at: string } | null;
  return r ? { expiresAt: r.expires_at, source: r.source, savedAt: r.saved_at } : null;
}

/** La sesión guardada si todavía sirve (no vence en los próximos minutos). */
export async function sesionVigente(
  admin: SupabaseClient,
  orgId: string,
  ahora: Date = new Date(),
): Promise<SesionGuardada | null> {
  const { data } = await admin
    .from("swayp_inventory_sessions")
    .select("token_enc,email,ruc,id_company,expires_at,source,saved_at")
    .eq("org_id", orgId)
    .maybeSingle();
  const r = data as {
    token_enc: string;
    email: string;
    ruc: string;
    id_company: string;
    expires_at: string;
    source: "manual" | "extension";
    saved_at: string;
  } | null;
  if (!r) return null;
  const expiresAt = new Date(r.expires_at);
  if (expiresAt.getTime() - MARGEN_MS <= ahora.getTime()) return null;
  let token: string;
  try {
    token = decrypt(r.token_enc);
  } catch {
    return null;
  }
  return {
    creds: { token, email: r.email, user: r.ruc, idCompany: r.id_company, country: "PE" },
    expiresAt,
    source: r.source,
    savedAt: new Date(r.saved_at),
  };
}

/** Swayp rechazó la sesión antes de su `exp` (se cerró, se cambió la clave): se descarta. */
export async function olvidarSesionSwayp(admin: SupabaseClient, orgId: string): Promise<void> {
  await admin.from("swayp_inventory_sessions").delete().eq("org_id", orgId);
}

/**
 * La credencial para correr sin nadie delante: la de API si existe (no vence),
 * si no la sesión guardada mientras esté vigente. null si no hay ninguna.
 */
export async function credencialAutomatica(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ creds: SwaypInventoryCreds; origen: "api" | "sesion" } | null> {
  const api = credencialInventarioDesdeEnv();
  if (api.ok && api.orgId === orgId) return { creds: api.creds, origen: "api" };
  const sesion = await sesionVigente(admin, orgId);
  return sesion ? { creds: sesion.creds, origen: "sesion" } : null;
}

// ── Llave de la extensión ────────────────────────────────────────────────────

export function hashLlave(llave: string): string {
  return createHash("sha256").update(llave.trim()).digest("hex");
}

/** Genera la llave de la extensión (reemplaza la anterior) y la devuelve en claro, una sola vez. */
export async function crearLlaveExtension(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
): Promise<string> {
  const llave = `kse_${randomBytes(24).toString("hex")}`;
  const { error } = await admin.from("swayp_extension_keys").upsert(
    {
      org_id: orgId,
      key_hash: hashLlave(llave),
      created_by: userId,
      created_at: new Date().toISOString(),
      last_used_at: null,
    },
    { onConflict: "org_id" },
  );
  if (error) throw new Error(`No se pudo crear la llave de la extensión: ${error.message}`);
  return llave;
}

/** La organización dueña de una llave de extensión, o null. Marca su último uso. */
export async function orgDeLlave(admin: SupabaseClient, llave: string): Promise<string | null> {
  if (!/^kse_[0-9a-f]{48}$/.test(llave.trim())) return null;
  const hash = hashLlave(llave);
  const { data } = await admin.from("swayp_extension_keys").select("org_id,key_hash").eq("key_hash", hash).maybeSingle();
  const r = data as { org_id: string; key_hash: string } | null;
  if (!r) return null;
  // La búsqueda ya fue por igualdad; la comparación constante es por higiene.
  if (!timingSafeEqual(Buffer.from(r.key_hash), Buffer.from(hash))) return null;
  await admin.from("swayp_extension_keys").update({ last_used_at: new Date().toISOString() }).eq("org_id", r.org_id);
  return r.org_id;
}

/** Cuándo se creó y se usó por última vez la llave de la extensión. */
export async function infoExtension(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ createdAt: string; lastUsedAt: string | null } | null> {
  const { data } = await admin
    .from("swayp_extension_keys")
    .select("created_at,last_used_at")
    .eq("org_id", orgId)
    .maybeSingle();
  const r = data as { created_at: string; last_used_at: string | null } | null;
  return r ? { createdAt: r.created_at, lastUsedAt: r.last_used_at } : null;
}

// ── Sync diario ──────────────────────────────────────────────────────────────

export type ResultadoSiToca =
  | { estado: "al_dia"; ultimaOk: Date | null }
  | { estado: "sin_credencial" }
  | { estado: "corrio"; origen: "api" | "sesion"; resultado: SyncResult };

/**
 * El sync automático: corre sólo si la última sincronización buena fue hace
 * ≥ `HORAS_ENTRE_SYNCS` y hay una credencial utilizable. Lo llaman el cron
 * (cada hora, casi siempre para decir «al día») y la extensión al recibir una
 * sesión nueva. Si Swayp rechaza la sesión guardada, se descarta.
 */
export async function sincronizarSiToca(admin: SupabaseClient, orgId: string): Promise<ResultadoSiToca> {
  const ultimaOk = await ultimaSincronizacionOk(admin, orgId);
  if (!debeSincronizar(ultimaOk)) return { estado: "al_dia", ultimaOk };
  const c = await credencialAutomatica(admin, orgId);
  if (!c) return { estado: "sin_credencial" };
  const resultado = await sincronizarInventarioSwayp(admin, {
    creds: c.creds,
    orgId,
    userId: null,
    ciudades: "todas",
    source: "cron",
  });
  if ("error" in resultado && resultado.credencialRechazada && c.origen === "sesion") {
    await olvidarSesionSwayp(admin, orgId);
  }
  return { estado: "corrio", origen: c.origen, resultado };
}
