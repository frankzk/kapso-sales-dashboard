"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, createAdminSupabase } from "@/lib/db";
import type { Role } from "@/lib/types";
import { permissionsFor } from "@/lib/permissions";
import {
  canAddMember,
  canRemoveMember,
  canSetPaymentValidator,
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

async function orgPaymentValidatorIds(
  admin: SupabaseClient,
  orgId: string,
  members: MemberLite[],
): Promise<{ ids: string[]; error?: string }> {
  const { data, error } = await admin
    .from("user_permissions")
    .select("user_id, permission, granted")
    .eq("org_id", orgId)
    .in("permission", ["payments.validate", "shalom.validate_payment"]);
  if (error) return { ids: [], error: error.message };
  const grantsByUser = new Map<string, { permission: string; granted: boolean }[]>();
  for (const row of
    (data as { user_id: string; permission: string; granted: boolean }[]) ?? []) {
    const grants = grantsByUser.get(row.user_id) ?? [];
    grants.push({ permission: row.permission, granted: row.granted });
    grantsByUser.set(row.user_id, grants);
  }
  return {
    ids: members
      .filter((member) =>
        permissionsFor([member.role], grantsByUser.get(member.user_id) ?? []).has(
          "payments.validate",
        ),
      )
      .map((member) => member.user_id),
  };
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

  const validators = await orgPaymentValidatorIds(admin, orgId, members);
  if (validators.error) return { error: validators.error };
  const validatorGuard = canSetPaymentValidator(
    members,
    userId,
    false,
    actor.role,
    validators.ids,
  );
  if (!validatorGuard.ok) return { error: validatorGuard.reason };

  // Revoke per-store access for this org's stores, then drop the membership.
  const { data: stores } = await admin.from("stores").select("id").eq("org_id", orgId);
  const ids = (stores ?? []).map((s: { id: string }) => s.id);
  if (ids.length) {
    await admin.from("user_store_access").delete().eq("user_id", userId).in("store_id", ids);
  }
  // A removed member must not recover old exceptional permissions if invited
  // again later. The membership delete and this cleanup are deliberately
  // explicit because user_permissions belongs to the organization, not a store.
  const { error: permissionError } = await admin
    .from("user_permissions")
    .delete()
    .eq("org_id", orgId)
    .eq("user_id", userId);
  if (permissionError) return { error: permissionError.message };
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

/** Concede o revoca la capacidad financiera de validar pagos. */
export async function setPaymentValidationPermission(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const orgId = String(formData.get("org_id") ?? "");
  const actor = await requireOrgAdmin(orgId);
  if (!actor) return { error: "Sin permiso." };

  const userId = String(formData.get("user_id") ?? "");
  const grant = String(formData.get("grant") ?? "") === "1";
  const admin = createAdminSupabase();
  const members = await orgMembers(admin, orgId);
  const validators = await orgPaymentValidatorIds(admin, orgId, members);
  if (validators.error) return { error: validators.error };

  const guard = canSetPaymentValidator(
    members,
    userId,
    grant,
    actor.role,
    validators.ids,
  );
  if (!guard.ok) return { error: guard.reason };

  const { error } = await admin.from("user_permissions").upsert(
    {
      user_id: userId,
      org_id: orgId,
      permission: "payments.validate",
      granted: grant,
      granted_by: actor.userId,
    },
    { onConflict: "user_id,org_id,permission" },
  );
  if (error) return { error: error.message };

  revalidatePath("/dashboard/team");
  return { notice: grant ? "Puede validar pagos." : "Permiso de validacion retirado." };
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
