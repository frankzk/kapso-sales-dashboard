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
