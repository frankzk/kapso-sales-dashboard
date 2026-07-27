// Configuración de Shalom por tienda y gestión del token de sesión.
//
// Vive aparte de las server actions porque lo usan DOS rutas: el Master (crear
// la guía) y Ajustes (el botón "Probar conexión"). Duplicarlo garantizaría que
// una de las dos se quedara atrás.
//
// SERVER-ONLY: descifra secretos y usa el cliente admin de Supabase.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { ShalomClient, sessionIsFresh } from "./client";

export interface StoreShalom {
  /** Para reutilizar el token entre tiendas de la misma empresa. */
  org_id: string;
  shalom_pro_email: string | null;
  shalom_pro_password_enc: string | null;
  shalom_origin_terminal_id: number | null;
  shalom_origin_terminal_name: string | null;
  shalom_default_product_id: number | null;
  shalom_session_token_enc: string | null;
  shalom_session_expires_at: string | null;
}

export const SHALOM_STORE_COLUMNS =
  "org_id,shalom_pro_email,shalom_pro_password_enc,shalom_origin_terminal_id," +
  "shalom_origin_terminal_name,shalom_default_product_id,shalom_session_token_enc,shalom_session_expires_at";

export async function loadStoreShalom(
  admin: SupabaseClient,
  storeId: string,
): Promise<StoreShalom | null> {
  const { data } = await admin
    .from("stores")
    .select(SHALOM_STORE_COLUMNS)
    .eq("id", storeId)
    .maybeSingle();
  return (data as StoreShalom | null) ?? null;
}

/**
 * ¿Se puede crear una guía para esta tienda? Hacen falta las DOS mitades: la API
 * key global del wrapper (entorno) y la cuenta de Shalom Pro de la tienda.
 */
export function isConfigured(store: StoreShalom | null): boolean {
  return Boolean(
    env.shalomConfigured() &&
      store?.shalom_pro_email &&
      store?.shalom_pro_password_enc &&
      store?.shalom_origin_terminal_id,
  );
}

/**
 * Por qué NO se puede, distinguiendo de quién es el problema: falta la variable
 * de entorno lo arregla quien despliega; falta la cuenta lo arregla quien
 * administra la tienda. Decir "no está configurado" a secas manda a la persona
 * equivocada a buscar en el sitio equivocado.
 */
export function configurationBlocker(store: StoreShalom | null): string | null {
  if (!env.shalomConfigured()) {
    return "Shalom no está habilitado en este servidor: falta la variable SHALOM_API_KEY. Es global, no de la tienda.";
  }
  if (!store?.shalom_pro_email || !store?.shalom_pro_password_enc) {
    return "Esta tienda no tiene cuenta de Shalom Pro. Cárgala en Ajustes → Tienda → Shalom.";
  }
  if (!store?.shalom_origin_terminal_id) {
    return "Falta la agencia de origen de esta tienda (Ajustes → Tienda → Shalom).";
  }
  return null;
}

/** Cliente que solo necesita la API key (agencias, ubicaciones, health). */
export function publicClient(): ShalomClient {
  return new ShalomClient({ apiKey: env.shalomApiKey(), baseUrl: env.shalomApiBase() });
}

/**
 * Cliente listo para llamar, con el token cacheado si sigue vivo. NO crea la
 * sesión: eso es explícito (`mintSession`) porque tarda ~90 s y nadie quiere
 * pagarlo dentro de la llamada que crea la guía.
 */
export function clientFor(store: StoreShalom): { client: ShalomClient; sessionReady: boolean } {
  const sessionToken =
    sessionIsFresh(store.shalom_session_expires_at) && store.shalom_session_token_enc
      ? decrypt(store.shalom_session_token_enc)
      : null;
  return {
    client: new ShalomClient({
      apiKey: env.shalomApiKey(),
      baseUrl: env.shalomApiBase(),
      sessionToken,
    }),
    sessionReady: Boolean(sessionToken),
  };
}

export type MintResult =
  | { expiresAt: string; source: "cache" | "shared" | "login" }
  | { error: string };

/**
 * Consigue un token de sesión vigente para la tienda, por el camino más barato
 * que haya disponible:
 *
 *   1. `cache`  — la tienda ya tiene uno vivo. Gratis.
 *   2. `shared` — otra tienda de la MISMA organización usa la misma cuenta de
 *      Shalom y ya pagó el login. El token es de la cuenta, no de la tienda, así
 *      que se copia. Gratis.
 *   3. `login`  — no hay más remedio: ~90 s, hasta 2 min.
 *
 * El paso 2 está acotado a la misma `org_id` aunque el email ya sea prueba
 * suficiente de que es la misma cuenta: no hay razón para que un token cruce una
 * frontera de organización, y la restricción no cuesta nada.
 *
 * Tras un login, el token se guarda en TODAS las tiendas de la organización que
 * usan ese email — la siguiente entra por el paso 1 o el 2.
 */
export async function mintSession(
  admin: SupabaseClient,
  storeId: string,
  store: StoreShalom,
): Promise<MintResult> {
  if (sessionIsFresh(store.shalom_session_expires_at) && store.shalom_session_token_enc) {
    return { expiresAt: store.shalom_session_expires_at as string, source: "cache" };
  }

  const email = store.shalom_pro_email as string;

  const shared = await admin
    .from("stores")
    .select("shalom_session_token_enc,shalom_session_expires_at")
    .eq("org_id", store.org_id)
    .eq("shalom_pro_email", email)
    .neq("id", storeId)
    .not("shalom_session_token_enc", "is", null)
    .order("shalom_session_expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const reusable = shared.data as {
    shalom_session_token_enc: string | null;
    shalom_session_expires_at: string | null;
  } | null;

  if (reusable?.shalom_session_token_enc && sessionIsFresh(reusable.shalom_session_expires_at)) {
    await admin
      .from("stores")
      .update({
        shalom_session_token_enc: reusable.shalom_session_token_enc,
        shalom_session_expires_at: reusable.shalom_session_expires_at,
      })
      .eq("id", storeId);
    return { expiresAt: reusable.shalom_session_expires_at as string, source: "shared" };
  }

  let password: string;
  try {
    password = decrypt(store.shalom_pro_password_enc as string);
  } catch {
    return { error: "No se pudo descifrar la contraseña de Shalom. Vuelve a cargarla en Ajustes." };
  }

  const session = await publicClient().createSession(email, password);

  await admin
    .from("stores")
    .update({
      shalom_session_token_enc: encrypt(session.session_token),
      shalom_session_expires_at: session.expires_at,
    })
    .eq("org_id", store.org_id)
    .eq("shalom_pro_email", email);

  return { expiresAt: session.expires_at, source: "login" };
}

/** Tira el token cacheado. Para cuando Shalom lo rechaza antes de que expire. */
export async function clearSession(admin: SupabaseClient, storeId: string): Promise<void> {
  await admin
    .from("stores")
    .update({ shalom_session_token_enc: null, shalom_session_expires_at: null })
    .eq("id", storeId);
}
