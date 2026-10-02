"use server";

// «Cotejar Olva» (MOM §12): el botón y «Pegar respuesta». El cotejo en sí
// vive en lib/olva/portal-sync.ts, el mismo que corre el cron.

import { revalidatePath } from "next/cache";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { createAdminSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { parsePortalTrackings } from "@/lib/olva/portal";
import {
  loadOlvaPortalAccounts,
  olvaPortalAccountForStore,
  runOlvaCotejo,
  type CotejoRunResult,
} from "@/lib/olva/portal-sync";

const PATH = "/dashboard/olva";

export interface CotejoActionState {
  ok: boolean;
  message: string;
}

function describe(r: CotejoRunResult): CotejoActionState {
  if (!r.ok) return { ok: false, message: r.error ?? "El cotejo no terminó." };
  return {
    ok: true,
    message: `Olva trajo ${r.fetched} envíos: ${r.linked} vinculados, ${r.review} por revisar, ${r.unmatched} sin pareja.`,
  };
}

/** Pegar el tracking cambia el Master y dispara avisos: el permiso es el de editarlo. */
async function requireOrg(orgId: string): Promise<{ userId: string } | CotejoActionState> {
  const [user, stores] = await Promise.all([getCurrentUser(), getAccessibleStores()]);
  if (!user) return { ok: false, message: "Inicia sesión para continuar." };
  if (!stores.some((s) => s.org_id === orgId)) return { ok: false, message: "No tienes acceso a esta organización." };
  if (!(await hasOrgPermission(orgId, "master.edit"))) {
    return { ok: false, message: "Tu rol no permite registrar trackings en el Master." };
  }
  return { userId: user.id };
}

export async function runCotejoNow(orgId: string): Promise<CotejoActionState> {
  const auth = await requireOrg(orgId);
  if ("ok" in auth) return auth;
  const admin = createAdminSupabase();
  const accounts = await loadOlvaPortalAccounts(admin, { orgIds: [orgId] });
  if (!accounts.length) {
    return { ok: false, message: "Falta la cuenta del portal de Olva: ponla en Ajustes de la tienda (usuario, contraseña y RUC)." };
  }
  const results: CotejoActionState[] = [];
  for (const account of accounts) {
    results.push(describe(await runOlvaCotejo(admin, { account, source: "manual", actor: auth.userId })));
  }
  revalidatePath(PATH);
  return { ok: results.every((r) => r.ok), message: results.map((r) => r.message).join(" ") };
}

/**
 * El plan B cuando Cloudflare no deja entrar al cotejo automático: alguien
 * copia en su navegador la respuesta de `getTrackingsClient` y la pega aquí.
 */
export async function pasteCotejo(storeId: string, text: string): Promise<CotejoActionState> {
  const stores = await getAccessibleStores();
  const store = stores.find((s) => s.id === storeId);
  if (!store) return { ok: false, message: "No tienes acceso a esta tienda." };
  const auth = await requireOrg(store.org_id);
  if ("ok" in auth) return auth;

  let json: unknown;
  try {
    json = JSON.parse(text.trim());
  } catch {
    return { ok: false, message: "Eso no es JSON. Copia la pestaña «Respuesta» de getTrackingsClient completa." };
  }
  const parsed = parsePortalTrackings(json);
  if (!parsed.ok) return { ok: false, message: parsed.error };
  if (!parsed.rows.length) return { ok: false, message: "La respuesta no trae ningún envío legible." };

  const admin = createAdminSupabase();
  const account = await olvaPortalAccountForStore(admin, storeId);
  if (!account) return { ok: false, message: "No se encontró la tienda." };
  const result = await runOlvaCotejo(admin, {
    account,
    source: "pegado",
    actor: auth.userId,
    rows: parsed.rows,
    skipped: parsed.skipped,
  });
  revalidatePath(PATH);
  return describe(result);
}
