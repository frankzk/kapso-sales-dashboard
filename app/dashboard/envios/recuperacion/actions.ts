"use server";

// Cola de recuperación de devoluciones: cargarla, enviar la plantilla, descartar.
//
// El envío en sí vive en lib/return-recovery.ts y lo comparten estas acciones y
// el cron automático — la elegibilidad no puede diverger entre "lo mandó una
// persona" y "lo mandó el sistema", o la regla del MOM §11 se cumpliría solo en
// uno de los dos caminos.
//
// Vive bajo Envíos, con las guías, y no en el Master: lo que se recupera es la
// GUÍA devuelta. Un pedido puede tener varias, y la que volvió es una concreta.

import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getStoreCreds } from "@/lib/ingest";
import {
  buildRecoveryQueue,
  recoveryConfig,
  RECOVERY_COLS,
  RECOVERY_DEFAULT_MAX_DAYS,
  sendRecoveryTemplate,
  type RecoveryCandidate,
  type RecoveryQueueRow,
} from "@/lib/return-recovery";

export interface RecoveryView {
  rows: RecoveryQueueRow[];
  /** Por qué la tienda no puede enviar todavía, o null si puede. */
  blocker: string | null;
  templateName: string | null;
  auto: boolean;
  maxDays: number;
}

/** Motivo legible de por qué esta tienda no puede enviar. Se muestra arriba de
 *  la cola: sin esto, el botón deshabilitado no explica nada y el diagnóstico
 *  («falta aprobar la plantilla en Aurela») se pierde. */
function describeBlocker(creds: Awaited<ReturnType<typeof getStoreCreds>>): string | null {
  if (!creds) return "No se pudo leer la configuración de la tienda.";
  if (!creds.return_recovery_enabled) {
    return "La recuperación de devoluciones está apagada para esta tienda (Ajustes).";
  }
  if (!creds.return_recovery_template_name) {
    return "Falta indicar la plantilla aprobada de recuperación (Ajustes).";
  }
  if (!creds.kapso_api_key || !creds.whatsapp_phone_number_id) {
    return "Falta la clave de Kapso o el número de WhatsApp de la tienda (Ajustes).";
  }
  if (!recoveryConfig(creds)) {
    return "La lista de parámetros de la plantilla no tiene ningún token válido (Ajustes).";
  }
  return null;
}

/** Carga la cola de una tienda. Las guías se leen con el cliente del USUARIO,
 *  así que RLS decide qué tiendas ve; la config se lee con service-role porque
 *  incluye secretos que no salen al navegador. */
export async function loadRecoveryView(storeId: string): Promise<RecoveryView> {
  const stores = await getAccessibleStores();
  if (!stores.some((s) => s.id === storeId)) {
    return { rows: [], blocker: "No tienes acceso a esta tienda.", templateName: null, auto: false, maxDays: RECOVERY_DEFAULT_MAX_DAYS };
  }

  const creds = await getStoreCreds(storeId);
  const maxDays = creds?.return_recovery_max_days ?? RECOVERY_DEFAULT_MAX_DAYS;
  const sb = await createServerSupabase();
  // La ventana de la consulta es más ancha que la de elegibilidad a propósito:
  // las vencidas por frescura se MUESTRAN con su motivo. Que una devolución no
  // se pueda recuperar es justamente lo que hay que poder ver.
  const sinceIso = new Date(Date.now() - maxDays * 2 * 86_400_000).toISOString();
  const { data, error } = await sb
    .from("shipments")
    .select(RECOVERY_COLS)
    .eq("store_id", storeId)
    .not("returned_at", "is", null)
    .gte("returned_at", sinceIso)
    .order("returned_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(`cola de recuperación: ${error.message}`);

  return {
    rows: buildRecoveryQueue((data as unknown as RecoveryCandidate[] | null) ?? [], {
      nowMs: Date.now(),
      maxDays,
    }),
    blocker: describeBlocker(creds),
    templateName: creds?.return_recovery_template_name ?? null,
    auto: creds?.return_recovery_auto ?? false,
    maxDays,
  };
}

export interface RecoveryActionResult {
  ok: boolean;
  error?: string;
}

/** Manda la plantilla a UNA guía devuelta. La elegibilidad se vuelve a
 *  comprobar dentro de `sendRecoveryTemplate`: el botón puede venir de una
 *  pantalla vieja. */
export async function sendRecoveryAction(
  storeId: string,
  shipmentId: string,
): Promise<RecoveryActionResult> {
  const [stores, perms] = await Promise.all([getAccessibleStores(), getMasterPermissions()]);
  if (!stores.some((s) => s.id === storeId)) return { ok: false, error: "Sin acceso a la tienda." };
  if (!perms.can("recovery.contact")) {
    return { ok: false, error: "No tienes permiso para escribirle a la clienta." };
  }

  const creds = await getStoreCreds(storeId);
  const blocker = describeBlocker(creds);
  if (blocker || !creds) return { ok: false, error: blocker ?? "Configuración incompleta." };
  const cfg = recoveryConfig(creds)!;

  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("shipments")
    .select(RECOVERY_COLS)
    .eq("id", shipmentId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (error || !data) return { ok: false, error: "No se encontró la guía." };

  const sb = await createServerSupabase();
  const { data: auth } = await sb.auth.getUser();

  const res = await sendRecoveryTemplate(admin, storeId, data as unknown as RecoveryCandidate, cfg, {
    sentBy: auth?.user?.id ?? null,
    maxDays: creds.return_recovery_max_days ?? RECOVERY_DEFAULT_MAX_DAYS,
  });
  revalidatePath("/dashboard/envios/recuperacion");
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "El envío fue rechazado." };
}

/** Saca una guía de la cola sin escribirle. El motivo es obligatorio: la cola
 *  es corta y una guía descartada sin explicación se vuelve a mirar cada vez. */
export async function dismissRecoveryAction(
  storeId: string,
  shipmentId: string,
  reason: string,
): Promise<RecoveryActionResult> {
  const [stores, perms] = await Promise.all([getAccessibleStores(), getMasterPermissions()]);
  if (!stores.some((s) => s.id === storeId)) return { ok: false, error: "Sin acceso a la tienda." };
  if (!perms.can("recovery.contact")) return { ok: false, error: "No tienes permiso." };
  const motivo = reason.trim();
  if (motivo.length < 3) return { ok: false, error: "Escribe un motivo breve." };

  const sb = await createServerSupabase();
  const { data: auth } = await sb.auth.getUser();
  const admin = createAdminSupabase();
  const { error } = await admin
    .from("shipments")
    .update({
      recovery_state: "descartado",
      recovery_dismissed_at: new Date().toISOString(),
      recovery_dismissed_by: auth?.user?.id ?? null,
      recovery_dismiss_reason: motivo.slice(0, 300),
    })
    .eq("id", shipmentId)
    .eq("store_id", storeId)
    // Una guía que ya recibió el mensaje no se puede "descartar": el mensaje ya
    // salió y borrar la marca solo perdería el rastro.
    .is("recovery_state", null);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/envios/recuperacion");
  return { ok: true };
}
