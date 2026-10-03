"use server";

// «Cotejar Olva» (MOM §12): el botón y «Pegar respuesta». El cotejo en sí
// vive en lib/olva/portal-sync.ts, el mismo que corre el cron.

import { revalidatePath } from "next/cache";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { createAdminSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { parsePortalTrackings } from "@/lib/olva/portal";
import { planOlvaLink } from "@/lib/olva/link";
import { formatOlvaTracking, parseOlvaTracking } from "@/lib/olva/tracking";
import { limaTodayKey } from "@/lib/shipments";
import { createManualRouteOutput, setOlvaTracking } from "@/app/dashboard/pedidos/actions";
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

/**
 * «Vincular a pedido»: el envío de Olva no encontró salida y alguien sabe de
 * qué pedido es. El tracking va a su salida de Olva libre o, si el pedido no
 * tiene ninguna, se le crea una con el mismo camino que el Master.
 */
export async function linkTrackingToOrder(tracking: string, orderNameRaw: string): Promise<CotejoActionState> {
  const parsed = parseOlvaTracking(tracking);
  if (!parsed.ok) return { ok: false, message: parsed.error };
  const digits = orderNameRaw.trim().toUpperCase().replace(/[#\s]/g, "");
  if (!/^[A-Z]{1,6}\d{3,}$/.test(digits)) return { ok: false, message: "Escribe el número del pedido, por ejemplo KP136585." };
  const orderName = `#${digits}`;

  const stores = await getAccessibleStores();
  const admin = createAdminSupabase();
  const { data: orders } = await admin
    .from("order_master")
    .select("order_id,store_id")
    .eq("order_name", orderName)
    .in("store_id", stores.map((s) => s.id))
    .limit(2);
  const found = (orders ?? []) as { order_id: string; store_id: string }[];
  const order = found[0];
  if (!order) return { ok: false, message: `No encontré el pedido ${orderName} en tus tiendas.` };
  if (found.length > 1) return { ok: false, message: `Hay más de un pedido ${orderName}: hazlo desde el Master.` };

  const { data: outputs, error } = await admin
    .from("shipments")
    .select("id,courier,delivery_status,olva_tracking,olva_emision")
    .eq("order_id", order.order_id);
  if (error) return { ok: false, message: error.message };
  const plan = planOlvaLink(
    ((outputs ?? []) as {
      id: string;
      courier: string;
      delivery_status: string;
      olva_tracking: string | null;
      olva_emision: string | null;
    }[]).map((o) => ({
      id: o.id,
      courier: o.courier,
      deliveryStatus: o.delivery_status,
      olvaTracking: o.olva_tracking,
      olvaEmision: o.olva_emision,
    })),
    parsed.value,
  );

  const label = formatOlvaTracking(parsed.value);
  // Los permisos, el tracking repetido y el evento en la ficha los ponen las
  // mismas acciones del Master: aquí solo se decide cuál toca.
  let res: { error?: string; notice?: string };
  if (plan.kind === "error") return { ok: false, message: plan.error };
  if (plan.kind === "done") return { ok: true, message: `${orderName} ya tenía el tracking ${label}.` };
  if (plan.kind === "set") {
    res = await setOlvaTracking(plan.shipmentId, { tracking: label });
  } else {
    res = await createManualRouteOutput(order.order_id, {
      courier: "olva",
      dispatchDate: limaTodayKey(),
      olvaTracking: label,
      note: `Salida de Olva registrada desde «Cotejar Olva»: el envío ya estaba en Olva con el tracking ${label}.`,
    });
  }
  if (res.error) return { ok: false, message: res.error };
  revalidatePath(PATH);
  return {
    ok: true,
    message:
      plan.kind === "create"
        ? `Se creó la salida de Olva de ${orderName} con el tracking ${label}.`
        : `Tracking ${label} puesto en ${orderName}.`,
  };
}
