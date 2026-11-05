"use server";

// Agregar y quitar a mano en la «Lista de pago adelantado» (MOM §41). Cada
// acción vuelve a comprobarlo todo en el servidor:
//   1. lo que se pide sirve: una organización (uuid), un celular peruano y un
//      motivo de al menos 8 caracteres;
//   2. `prepay_list.manage` EN ESA organización (dueño y admin por su rol);
//   3. solo en producción, como las demás escrituras del panel: un preview no
//      cambia la lista de verdad.
// El alta y la baja quedan con quién, cuándo y por qué en la propia fila; una
// baja no se borra ni se reabre (0309). Los casos esperados devuelven
// `{ error }`; ninguna lanza.

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import { isUuid } from "@/lib/automations-catalog";
import { addPrepayEntry, removePrepayEntry } from "@/lib/prepay-list-server";
import { PREPAY_LIST_PATH, prepayPhoneInput, prepayPhoneLabel, prepayReasonProblem } from "@/lib/prepay-list";

export interface PrepayListActionResult {
  error?: string;
  notice?: string;
}

type Gate = { error: string } | { admin: ReturnType<typeof createAdminSupabase>; actor: string | null };

async function gate(orgId: string): Promise<Gate> {
  if (!isUuid(orgId)) return { error: "Organización inválida." };
  if (!(await hasOrgPermission(orgId, "prepay_list.manage"))) {
    return { error: "Tu acceso no permite cambiar la lista de pago adelantado." };
  }
  if (process.env.VERCEL_ENV !== "production") return { error: "Disponible solo en producción." };
  const user = await getCurrentUser();
  return { admin: createAdminSupabase(), actor: user?.id ?? null };
}

export async function addToPrepayList(orgId: string, phone: string, reason: string): Promise<PrepayListActionResult> {
  const parsed = prepayPhoneInput(phone);
  if (!parsed.ok) return { error: parsed.error };
  const problem = prepayReasonProblem(reason);
  if (problem) return { error: problem };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const res = await addPrepayEntry(g.admin, { orgId, phone: parsed.phone, reason, actor: g.actor });
  if (!res.ok) return { error: res.error };
  revalidatePath(PREPAY_LIST_PATH);
  return { notice: `${prepayPhoneLabel(parsed.phone)} agregado a la lista: paga el total por adelantado.` };
}

export async function removeFromPrepayList(orgId: string, entryId: string, reason: string): Promise<PrepayListActionResult> {
  if (!isUuid(entryId)) return { error: "Ese cliente no existe en la lista." };
  const problem = prepayReasonProblem(reason);
  if (problem) return { error: problem };
  const g = await gate(orgId);
  if ("error" in g) return { error: g.error };
  const res = await removePrepayEntry(g.admin, { orgId, entryId, reason, actor: g.actor });
  if (!res.ok) return { error: res.error };
  revalidatePath(PREPAY_LIST_PATH);
  return {
    notice: `${prepayPhoneLabel(res.entry.phone)} quitado de la lista. La regla automática solo lo vuelve a agregar si rechaza o no recoge un pedido nuevo: no por los que ya tenía hoy.`,
  };
}
