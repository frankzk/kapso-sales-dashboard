// Permisos efectivos del usuario de la petición. Une los roles de
// `memberships` (lib/access.ts), los roles acumulables de `membership_roles`
// (0244, MOM §16) y las concesiones puntuales de `user_permissions`, y devuelve
// el conjunto que lib/permissions.ts sabe evaluar.
//
// SERVER-ONLY. Memoizado por petición con React `cache()`, como el resto de
// lib/access.ts, para que el layout y la página no repitan la consulta.

import { cache } from "react";
import { createServerSupabase } from "@/lib/db";
import { getCurrentUser, getUserRoleSummary } from "@/lib/access";
import {
  isReadOnly,
  permissionsFor,
  type Permission,
  type PermissionGrant,
} from "@/lib/permissions";

export interface MasterPermissions {
  roles: string[];
  permissions: Set<Permission>;
  readOnly: boolean;
  can: (permission: Permission) => boolean;
}

async function loadGrants(): Promise<PermissionGrant[]> {
  const sb = await createServerSupabase();
  const user = await getCurrentUser();
  if (!user) return [];
  // `user_permissions` llega con la fase 3. Antes de esa migración la consulta
  // falla y los permisos salen solo del rol — que es exactamente el
  // comportamiento correcto durante la ventana de despliegue.
  // RLS lets org admins read teammates' grants too; never union those into
  // the current actor's permissions.
  const { data, error } = await sb.from("user_permissions").select("permission,granted").eq("user_id", user.id);
  if (error) return [];
  return ((data ?? []) as { permission: string; granted: boolean | null }[]).map((r) => ({
    permission: r.permission,
    granted: r.granted ?? true,
  }));
}

/**
 * Los roles acumulables de la persona, de todas sus organizaciones. Antes de la
 * 0244 la tabla no existe y la consulta falla: sin roles, que es exactamente lo
 * que había.
 */
async function loadFunctionalRoles(): Promise<{ org_id: string; role: string }[]> {
  const sb = await createServerSupabase();
  const user = await getCurrentUser();
  if (!user) return [];
  // Como con los permisos: RLS deja a un admin leer las filas de su equipo, y
  // esas nunca se suman a las de quien pide.
  const { data, error } = await sb.from("membership_roles").select("org_id,role").eq("user_id", user.id);
  if (error) return [];
  return (data ?? []) as { org_id: string; role: string }[];
}

const getFunctionalRoles = cache(loadFunctionalRoles);

async function loadUncached(): Promise<MasterPermissions> {
  const [{ roles }, grants, functionRows] = await Promise.all([getUserRoleSummary(), loadGrants(), getFunctionalRoles()]);
  const functions = [...new Set(functionRows.map((row) => row.role))];
  const permissions = permissionsFor(roles, grants, functions);
  return {
    roles,
    permissions,
    readOnly: isReadOnly(roles, grants, functions),
    can: (permission: Permission) => permissions.has(permission),
  };
}

export const getMasterPermissions = cache(loadUncached);

/**
 * Comprueba un permiso dentro de una organizacion concreta. Los permisos
 * financieros configurados desde Equipo son por organizacion: una concesion
 * en una empresa nunca debe habilitar acciones sobre pedidos de otra.
 */
const loadOrgPermissions = cache(async (orgId: string): Promise<Set<Permission>> => {
  const sb = await createServerSupabase();
  const user = await getCurrentUser();
  if (!user) return new Set<Permission>();
  const [{ data: membership }, { data: grantRows }, functionRows] = await Promise.all([
    sb
      .from("memberships")
      .select("role")
      .eq("org_id", orgId)
      .eq("user_id", user.id)
      .maybeSingle(),
    sb.from("user_permissions").select("permission,granted").eq("org_id", orgId).eq("user_id", user.id),
    getFunctionalRoles(),
  ]);
  if (!membership) return new Set<Permission>();
  return permissionsFor(
    [String(membership.role)],
    ((grantRows ?? []) as { permission: string; granted: boolean | null }[]).map((row) => ({
      permission: row.permission,
      granted: row.granted ?? true,
    })),
    functionRows.filter((row) => row.org_id === orgId).map((row) => row.role),
  );
});

/**
 * Las organizaciones donde la persona tiene `permission`, con su acceso en
 * cada una. Reemplaza al «¿es owner o admin de alguna?» que había escrito a
 * mano en Tiendas, Costos, Equipo y Stock (MOM §16, 12-10-2026).
 */
export async function orgsWithPermission(permission: Permission): Promise<{ org_id: string; role: string }[]> {
  const sb = await createServerSupabase();
  const user = await getCurrentUser();
  if (!user) return [];
  const { data } = await sb.from("memberships").select("org_id,role").eq("user_id", user.id);
  const memberships = (data ?? []) as { org_id: string; role: string }[];
  const allowed = await Promise.all(memberships.map((m) => hasOrgPermission(m.org_id, permission)));
  return memberships.filter((_, i) => allowed[i]);
}

export async function hasOrgPermission(
  orgId: string,
  permission: Permission,
): Promise<boolean> {
  return (await loadOrgPermissions(orgId)).has(permission);
}
