// Permisos efectivos del usuario de la petición. Une los roles de
// `memberships` (lib/access.ts) con las concesiones puntuales de
// `user_permissions`, y devuelve el conjunto que lib/permissions.ts sabe evaluar.
//
// SERVER-ONLY. Memoizado por petición con React `cache()`, como el resto de
// lib/access.ts, para que el layout y la página no repitan la consulta.

import { cache } from "react";
import { createServerSupabase } from "@/lib/db";
import { getUserRoleSummary } from "@/lib/access";
import {
  hasPermission,
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
  // `user_permissions` llega con la fase 3. Antes de esa migración la consulta
  // falla y los permisos salen solo del rol — que es exactamente el
  // comportamiento correcto durante la ventana de despliegue.
  const { data, error } = await sb.from("user_permissions").select("permission,granted");
  if (error) return [];
  return ((data ?? []) as { permission: string; granted: boolean | null }[]).map((r) => ({
    permission: r.permission,
    granted: r.granted ?? true,
  }));
}

async function loadUncached(): Promise<MasterPermissions> {
  const [{ roles }, grants] = await Promise.all([getUserRoleSummary(), loadGrants()]);
  const permissions = permissionsFor(roles, grants);
  return {
    roles,
    permissions,
    readOnly: isReadOnly(roles, grants),
    can: (permission: Permission) => hasPermission(roles, permission, grants),
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
  const [{ data: membership }, { data: grantRows }] = await Promise.all([
    sb.from("memberships").select("role").eq("org_id", orgId).maybeSingle(),
    sb.from("user_permissions").select("permission,granted").eq("org_id", orgId),
  ]);
  if (!membership) return new Set<Permission>();
  return permissionsFor(
    [String(membership.role)],
    ((grantRows ?? []) as { permission: string; granted: boolean | null }[]).map((row) => ({
      permission: row.permission,
      granted: row.granted ?? true,
    })),
  );
});

export async function hasOrgPermission(
  orgId: string,
  permission: Permission,
): Promise<boolean> {
  return (await loadOrgPermissions(orgId)).has(permission);
}
