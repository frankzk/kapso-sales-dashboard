"use server";

// La página «Lista negra» (MOM §41 y §41.11, owner 09-11-2026). Cada acción
// vuelve a comprobarlo todo en el servidor:
//   * BUSCAR un celular: miembro de la organización (no motorizado), con tope
//     de búsquedas por persona (`lista_negra_searches`, 0329). Contesta solo por
//     ESE celular (`searchListaNegra`): nunca la lista.
//   * CAMBIAR algo —agregar o sacar a mano, exceptuar de la automática o
//     quitar una excepción—: `prepay_list.manage` EN ESA organización (dueño y
//     admin por su rol) y solo en producción, como las demás escrituras.
// El alta y la baja quedan con quién, cuándo y por qué en la propia fila; una
// baja no se borra ni se reabre (0309). Los casos esperados devuelven
// `{ error }`; ninguna lanza.

import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import { isUuid, PAGO_ONLINE_EXCEPTION_EVENT } from "@/lib/automations-catalog";
import { addPrepayEntry, removePrepayEntry } from "@/lib/prepay-list-server";
import { addPagoOnlineException, removePagoOnlineException } from "@/lib/pago-online-server";
import { pagoOnlineReasonProblem } from "@/lib/pago-online";
import { inCurrentAutoList, searchListaNegra } from "@/lib/lista-negra-server";
import type { ListaNegraSearchView } from "@/lib/lista-negra";
import { LN_EXCEPT_DONE } from "@/lib/lista-negra-copy";
import {
  PREPAY_LIST_LEGACY_PATH,
  PREPAY_LIST_PATH,
  isPrepayEntryRequirement,
  prepayPhoneInput,
  prepayPhoneLabel,
  prepayReasonProblem,
} from "@/lib/prepay-list";

export interface PrepayListActionResult {
  error?: string;
  notice?: string;
}

type Gate = { error: string } | { admin: ReturnType<typeof createAdminSupabase>; actor: string | null };

async function gate(orgId: string): Promise<Gate> {
  if (!isUuid(orgId)) return { error: "Organización inválida." };
  if (!(await hasOrgPermission(orgId, "prepay_list.manage"))) {
    return { error: "Tu acceso no permite cambiar la Lista negra." };
  }
  if (process.env.VERCEL_ENV !== "production") return { error: "Disponible solo en producción." };
  const user = await getCurrentUser();
  return { admin: createAdminSupabase(), actor: user?.id ?? null };
}

function revalidate() {
  revalidatePath(PREPAY_LIST_PATH);
  revalidatePath(PREPAY_LIST_LEGACY_PATH);
}

/** Agregar a mano, con lo que pide: «Adelanto de S/ 20» o «Pago total» (el de siempre). */
export async function addToPrepayList(orgId: string, phone: string, reason: string, requirement: string = "pago_completo"): Promise<PrepayListActionResult> {
  const parsed = prepayPhoneInput(phone);
  if (!parsed.ok) return { error: parsed.error };
  const problem = prepayReasonProblem(reason);
  if (problem) return { error: problem };
  if (!isPrepayEntryRequirement(requirement)) return { error: "Elige qué se le pide." };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const res = await addPrepayEntry(g.admin, { orgId, phone: parsed.phone, reason, actor: g.actor, requirement });
  if (!res.ok) return { error: res.error };
  revalidate();
  return { notice: `${prepayPhoneLabel(parsed.phone)} agregada a la Lista negra. Kapta la frena desde ya; las tiendas, desde el envío de mañana 05:00.` };
}

export async function removeFromPrepayList(orgId: string, entryId: string, reason: string): Promise<PrepayListActionResult> {
  if (!isUuid(entryId)) return { error: "Ese cliente no existe en la lista." };
  const problem = prepayReasonProblem(reason);
  if (problem) return { error: problem };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const res = await removePrepayEntry(g.admin, { orgId, entryId, reason, actor: g.actor });
  if (!res.ok) return { error: res.error };
  revalidate();
  return { notice: `${prepayPhoneLabel(res.entry.phone)} sacada de la Lista negra a mano. Si está en la automática, sigue ahí.` };
}

export interface ListaNegraSearchActionResult {
  error?: string;
  view?: ListaNegraSearchView;
}

/** Buscar UN celular: miembro de la organización, con tope por persona. */
export async function searchListaNegraAction(orgId: string, phone: string): Promise<ListaNegraSearchActionResult> {
  if (!isUuid(orgId)) return { error: "Organización inválida." };
  const parsed = prepayPhoneInput(phone);
  if (!parsed.ok) return { error: parsed.error };
  const user = await getCurrentUser();
  if (!user) return { error: "Vuelve a iniciar sesión." };
  const sb = await createServerSupabase();
  const { data: membership } = await sb.from("memberships").select("role").eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  const role = (membership as { role?: string } | null)?.role;
  if (!role || role === "motorizado") return { error: "La Lista negra la ve el equipo de la organización." };
  const canManage = await hasOrgPermission(orgId, "prepay_list.manage").catch(() => false);
  const res = await searchListaNegra(createAdminSupabase(), sb, { orgId, phone: parsed.phone, userId: user.id, canManage });
  return res.ok ? { view: res.view } : { error: res.error };
}

/** «Exceptuar de la Lista negra» desde la búsqueda: solo de la automática, con motivo. */
export async function exceptFromListaNegra(orgId: string, phone: string, reason: string): Promise<PrepayListActionResult> {
  const parsed = prepayPhoneInput(phone);
  if (!parsed.ok) return { error: parsed.error };
  const problem = pagoOnlineReasonProblem(reason);
  if (problem) return { error: problem };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  try {
    if (!(await inCurrentAutoList(g.admin, orgId, parsed.phone))) return { error: "Ese celular no está en la lista automática vigente: no hay nada que exceptuar." };
  } catch {
    return { error: "No se pudo leer la lista automática. Intenta de nuevo." };
  }
  const res = await addPagoOnlineException(g.admin, { orgId, phone: parsed.phone, reason, actor: g.actor });
  if (!res.ok) return { error: res.error };
  await g.admin
    .from("automation_switch_events")
    .insert({ org_id: orgId, store_id: null, automation: PAGO_ONLINE_EXCEPTION_EVENT, previous: null, next: "exceptuado", actor: g.actor });
  revalidate();
  return { notice: LN_EXCEPT_DONE };
}

/** «Quitar excepción», con motivo: si sigue cumpliendo la regla, vuelve a frenar con la lista vigente. */
export async function removeListaNegraException(orgId: string, id: string, reason: string): Promise<PrepayListActionResult> {
  if (!isUuid(id)) return { error: "Esa excepción no existe." };
  const problem = pagoOnlineReasonProblem(reason);
  if (problem) return { error: problem };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const res = await removePagoOnlineException(g.admin, { orgId, id, reason, actor: g.actor });
  if (!res.ok) return { error: res.error };
  await g.admin
    .from("automation_switch_events")
    .insert({ org_id: orgId, store_id: null, automation: PAGO_ONLINE_EXCEPTION_EVENT, previous: "exceptuado", next: "quitada", actor: g.actor });
  revalidate();
  return { notice: "Excepción quitada: si sigue cumpliendo la regla, vuelve a frenar con la lista vigente y entra en el envío de mañana 05:00." };
}
