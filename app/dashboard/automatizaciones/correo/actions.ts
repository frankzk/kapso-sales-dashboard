"use server";

// Automatizaciones › Correo · Resend (MOM §46, 0355): guardar o quitar la clave
// de Resend y subir un tramo de contactos. Con `automations.manage`, como el
// resto de Automatizaciones (§40); subir contactos pide además `data.export`
// (sacar nombres y correos de clientas de Kapta es una descarga de la base).
// Solo en producción: una vista previa no escribe en la cuenta de Resend.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { hasOrgPermission } from "@/lib/permissions-access";
import { limaDayOf } from "@/lib/agent-tools";
import { listResendSegments } from "@/lib/resend-client";
import { ensureResendSetup, importResendBucket } from "@/lib/resend-marketing-server";
import {
  RESEND_MIGRATION_MISSING,
  isResendBucket,
  isResendMigrationMissing,
  looksLikeResendKey,
  resendBucket,
  resendErrorMessage,
  resendKeyHint,
} from "@/lib/resend-marketing";

export interface ResendFormState {
  error?: string;
  notice?: string;
}

const PATH = "/dashboard/automatizaciones/correo";

async function requireManager(orgId: string): Promise<{ userId: string } | { error: string }> {
  if (!orgId) return { error: "Falta la organización." };
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  if (!(await hasOrgPermission(orgId, "automations.manage"))) {
    return { error: "Conectar Resend es del dueño, o de quien él autorice en Equipo («Automatizaciones»)." };
  }
  if (process.env.VERCEL_ENV !== "production") return { error: "Disponible solo en producción." };
  return { userId: user.id };
}

/** «Guardar clave»: la prueba en Resend, la cifra y deja listos el tema y los segmentos de cada tienda. */
export async function saveResendKey(_prev: ResendFormState, formData: FormData): Promise<ResendFormState> {
  const orgId = String(formData.get("org_id") ?? "");
  const ctx = await requireManager(orgId);
  if ("error" in ctx) return { error: ctx.error };
  const key = String(formData.get("api_key") ?? "").trim();
  if (!looksLikeResendKey(key)) return { error: "Esa no parece una clave de Resend: empieza con «re_»." };

  // Una clave de solo envío no puede leer segmentos: así se nota antes de guardarla.
  const probe = await listResendSegments(key);
  if (!probe.ok) return { error: resendErrorMessage(probe.error) };

  const admin = createAdminSupabase();
  const { error } = await admin.from("resend_settings").upsert(
    {
      org_id: orgId,
      api_key_enc: encrypt(key),
      key_hint: resendKeyHint(key),
      updated_by: ctx.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id" },
  );
  if (error) return { error: isResendMigrationMissing(error) ? RESEND_MIGRATION_MISSING : `No se guardó: ${error.message}` };

  // Las tiendas que la persona ve (RLS).
  const sb = await createServerSupabase();
  const { data: stores } = await sb.from("stores").select("id, name").eq("org_id", orgId).order("name");
  const setup = await ensureResendSetup(admin, orgId, key, (stores ?? []) as { id: string; name: string }[]);
  revalidatePath(PATH);
  if (!setup.ok) return { notice: `Clave guardada. No pudimos crear los segmentos todavía: ${setup.error}` };
  return {
    notice: setup.value.created
      ? `Clave guardada. Kapta creó en Resend ${setup.value.created} temas y segmentos (uno por marca y tramo).`
      : "Clave guardada. Los temas y segmentos de Resend ya estaban listos.",
  };
}

/** «Quitar clave»: Kapta la olvida. En Resend no se borra nada. */
export async function removeResendKey(_prev: ResendFormState, formData: FormData): Promise<ResendFormState> {
  const orgId = String(formData.get("org_id") ?? "");
  const ctx = await requireManager(orgId);
  if ("error" in ctx) return { error: ctx.error };
  const admin = createAdminSupabase();
  const { error } = await admin
    .from("resend_settings")
    .update({ api_key_enc: null, key_hint: null, updated_by: ctx.userId, updated_at: new Date().toISOString() })
    .eq("org_id", orgId);
  if (error) return { error: `No se quitó: ${error.message}` };
  revalidatePath(PATH);
  return { notice: "Clave quitada. Los contactos que ya subiste siguen en Resend." };
}

/** «Subir a Resend»: un tramo de una tienda. */
export async function uploadResendBucket(_prev: ResendFormState, formData: FormData): Promise<ResendFormState> {
  const orgId = String(formData.get("org_id") ?? "");
  const storeId = String(formData.get("store_id") ?? "");
  const bucket = formData.get("bucket");
  const ctx = await requireManager(orgId);
  if ("error" in ctx) return { error: ctx.error };
  if (!(await hasOrgPermission(orgId, "data.export"))) {
    return { error: "Subir contactos pide el permiso «Descargar la base de pedidos»." };
  }
  if (!isResendBucket(bucket)) return { error: "Elige un tramo." };
  const sb = await createServerSupabase();
  // RLS: la tienda tiene que ser de la organización y verse.
  const { data: store } = await sb.from("stores").select("id, name").eq("id", storeId).eq("org_id", orgId).maybeSingle();
  if (!store) return { error: "No encontramos esa tienda." };
  const res = await importResendBucket({
    orgId,
    store: store as { id: string; name: string },
    bucket,
    userId: ctx.userId,
    day: limaDayOf(new Date()),
  });
  revalidatePath(PATH);
  if (!res.ok) return { error: res.error };
  const fmt = (n: number) => n.toLocaleString("es-PE");
  const skipped = res.value.excluded ? ` (${fmt(res.value.excluded)} correos mal escritos o repetidos quedaron fuera)` : "";
  return {
    notice: `Enviados ${fmt(res.value.rows)} contactos de ${store.name} · ${resendBucket(bucket).label.toLocaleLowerCase("es-PE")}${skipped}. Resend los procesa en unos minutos.`,
  };
}
