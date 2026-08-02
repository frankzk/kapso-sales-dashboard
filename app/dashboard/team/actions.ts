"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import type { Role } from "@/lib/types";
import {
  canAddMember,
  canRemoveMember,
  canSetRole,
  isRole,
  type MemberLite,
} from "@/lib/team";

export interface TeamActionState {
  error?: string;
  notice?: string;
}

/** Verify the caller is owner/admin of `orgId`; returns their role or null. */
async function requireOrgAdmin(orgId: string): Promise<{ userId: string; role: Role } | null> {
  if (!orgId) return null;
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await sb
    .from("memberships")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data || (data.role !== "owner" && data.role !== "admin")) return null;
  return { userId: user.id, role: data.role as Role };
}

async function orgMembers(admin: SupabaseClient, orgId: string): Promise<MemberLite[]> {
  const { data } = await admin.from("memberships").select("user_id, role").eq("org_id", orgId);
  return (data as MemberLite[]) ?? [];
}

async function findUserIdByEmail(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) break;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------

export async function addMember(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const orgId = String(formData.get("org_id") ?? "");
  const actor = await requireOrgAdmin(orgId);
  if (!actor) return { error: "Sin permiso en esta organización." };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "viewer");
  if (!email) return { error: "Email requerido." };
  const guard = canAddMember(role, actor.role);
  if (!guard.ok) return { error: guard.reason };

  const admin = createAdminSupabase();
  let userId = await findUserIdByEmail(admin, email);
  let invited = false;
  let notice: string | undefined;

  if (!userId) {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email);
    if (!error && data?.user) {
      userId = data.user.id;
      invited = true;
    } else {
      // SMTP may be unconfigured — create the account so they can magic-link in.
      const created = await admin.auth.admin.createUser({ email, email_confirm: false });
      if (created.error || !created.data?.user) {
        return { error: `No se pudo invitar/crear al usuario: ${error?.message ?? errMsg(created.error)}` };
      }
      userId = created.data.user.id;
      notice = `Usuario ${email} creado (sin email de invitación); podrá entrar con magic link.`;
    }
  }

  const { error: upErr } = await admin
    .from("memberships")
    .upsert({ user_id: userId, org_id: orgId, role }, { onConflict: "user_id,org_id" });
  if (upErr) return { error: upErr.message };

  revalidatePath("/dashboard/team");
  return { notice: notice ?? (invited ? `Invitación enviada a ${email}.` : `${email} agregado como ${role}.`) };
}

export async function setMemberRole(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const orgId = String(formData.get("org_id") ?? "");
  const actor = await requireOrgAdmin(orgId);
  if (!actor) return { error: "Sin permiso." };

  const userId = String(formData.get("user_id") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!isRole(role)) return { error: "Rol inválido." };

  const admin = createAdminSupabase();
  const members = await orgMembers(admin, orgId);
  const guard = canSetRole(members, userId, role, actor.role);
  if (!guard.ok) return { error: guard.reason };

  const { error } = await admin
    .from("memberships")
    .update({ role })
    .eq("org_id", orgId)
    .eq("user_id", userId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard/team");
  return { notice: "Rol actualizado." };
}

export async function removeMember(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const orgId = String(formData.get("org_id") ?? "");
  const actor = await requireOrgAdmin(orgId);
  if (!actor) return { error: "Sin permiso." };

  const userId = String(formData.get("user_id") ?? "");
  const admin = createAdminSupabase();
  const members = await orgMembers(admin, orgId);
  const guard = canRemoveMember(members, userId, actor.role);
  if (!guard.ok) return { error: guard.reason };

  // Revoke per-store access for this org's stores, then drop the membership.
  const { data: stores } = await admin.from("stores").select("id").eq("org_id", orgId);
  const ids = (stores ?? []).map((s: { id: string }) => s.id);
  if (ids.length) {
    await admin.from("user_store_access").delete().eq("user_id", userId).in("store_id", ids);
  }
  const { error } = await admin
    .from("memberships")
    .delete()
    .eq("org_id", orgId)
    .eq("user_id", userId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard/team");
  return { notice: "Miembro removido." };
}

export async function setStoreAccess(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const orgId = String(formData.get("org_id") ?? "");
  const actor = await requireOrgAdmin(orgId);
  if (!actor) return { error: "Sin permiso." };

  const userId = String(formData.get("user_id") ?? "");
  const storeId = String(formData.get("store_id") ?? "");
  const grant = String(formData.get("grant") ?? "") === "1";

  const admin = createAdminSupabase();
  // The store must belong to this org and the user must be a member.
  const { data: store } = await admin
    .from("stores")
    .select("id, org_id")
    .eq("id", storeId)
    .maybeSingle();
  if (!store || store.org_id !== orgId) return { error: "La tienda no pertenece a la organización." };
  const { data: mem } = await admin
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!mem) return { error: "El usuario no es miembro." };

  if (grant) {
    const { error } = await admin
      .from("user_store_access")
      .upsert({ user_id: userId, store_id: storeId }, { onConflict: "user_id,store_id" });
    if (error) return { error: error.message };
  } else {
    const { error } = await admin
      .from("user_store_access")
      .delete()
      .eq("user_id", userId)
      .eq("store_id", storeId);
    if (error) return { error: error.message };
  }
  revalidatePath("/dashboard/team");
  return { notice: "Acceso actualizado." };
}

// ---------------------------------------------------------------------------
// Motorizados (riders). Vive en Equipo, solo owner/admin. La ficha es distinta
// del usuario: un motorizado puede existir sin login; se le vincula un usuario
// solo si va a entrar a /reparto (segundo cotejo desde su celular).
// ---------------------------------------------------------------------------

export interface RiderInput {
  orgId: string;
  id?: string | null;
  storeId?: string | null;
  courier?: string | null; // vacío = motorizado propio
  fullName: string;
  docNumber?: string | null;
  phone?: string | null;
  note?: string | null;
}

function cleanText(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

/** Crea o actualiza la ficha de un motorizado (nunca la borra). */
export async function saveRider(input: RiderInput): Promise<TeamActionState> {
  const auth = await requireOrgAdmin(input.orgId);
  if (!auth) return { error: "Sin acceso a esta organización." };

  const fullName = (input.fullName ?? "").trim();
  if (fullName.length < 2) return { error: "Indica el nombre del motorizado." };

  const admin = createAdminSupabase();
  const fields = {
    store_id: input.storeId || null,
    courier: cleanText(input.courier),
    full_name: fullName,
    doc_number: cleanText(input.docNumber),
    phone: cleanText(input.phone),
    note: cleanText(input.note),
  };

  try {
    if (input.id) {
      const { error } = await admin
        .from("riders")
        .update(fields)
        .eq("id", input.id)
        .eq("org_id", input.orgId);
      if (error) throw error;
    } else {
      const { error } = await admin
        .from("riders")
        .insert({ org_id: input.orgId, ...fields, created_by: auth.userId });
      if (error) throw error;
    }
  } catch (e) {
    const msg = errMsg(e);
    if (/riders_doc_idx/.test(msg)) {
      return { error: "Ya existe un motorizado con ese DNI en esta organización." };
    }
    return { error: msg };
  }
  revalidatePath("/dashboard/team");
  return { notice: input.id ? "Motorizado actualizado." : "Motorizado registrado." };
}

/** Activa o desactiva sin borrar: las rutas pasadas conservan su motorizado. */
export async function setRiderActive(
  orgId: string,
  riderId: string,
  active: boolean,
): Promise<TeamActionState> {
  const auth = await requireOrgAdmin(orgId);
  if (!auth) return { error: "Sin acceso a esta organización." };
  const admin = createAdminSupabase();
  const { error } = await admin.from("riders").update({ active }).eq("id", riderId).eq("org_id", orgId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard/team");
  return { notice: active ? "Motorizado activado." : "Motorizado desactivado." };
}

/** Vincula un usuario ya miembro de la org, para darle acceso a /reparto. */
export async function linkRiderUser(
  orgId: string,
  riderId: string,
  email: string,
): Promise<TeamActionState> {
  const auth = await requireOrgAdmin(orgId);
  if (!auth) return { error: "Sin acceso a esta organización." };
  const clean = (email ?? "").trim().toLowerCase();
  if (!clean) return { error: "Indica el correo del usuario." };

  const admin = createAdminSupabase();
  const userId = await findUserIdByEmail(admin, clean);
  if (!userId) {
    return { error: "No hay ningún usuario con ese correo. Invítalo primero en Usuarios y accesos." };
  }
  const { data: mem } = await admin
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!mem) return { error: "Ese usuario no es miembro de la organización. Invítalo primero." };

  const { error } = await admin.from("riders").update({ user_id: userId }).eq("id", riderId).eq("org_id", orgId);
  if (error) {
    if (/riders_user_idx/.test(error.message)) {
      return { error: "Ese usuario ya está vinculado a otro motorizado." };
    }
    return { error: error.message };
  }
  revalidatePath("/dashboard/team");
  return { notice: "Usuario vinculado. Ya puede entrar a /reparto." };
}

export async function unlinkRiderUser(orgId: string, riderId: string): Promise<TeamActionState> {
  const auth = await requireOrgAdmin(orgId);
  if (!auth) return { error: "Sin acceso a esta organización." };
  const admin = createAdminSupabase();
  const { error } = await admin.from("riders").update({ user_id: null }).eq("id", riderId).eq("org_id", orgId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard/team");
  return { notice: "Usuario desvinculado." };
}
