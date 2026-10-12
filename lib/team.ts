// Pure authorization guards for team management, unit-tested and reused by the
// server actions so the tricky rules (last-owner protection, who may manage
// owners) have one source of truth.
//
// SOLO EL DUEÑO REPARTE PODER (12-10-2026, MOM §16). Hasta esta fecha un admin
// podía cambiar roles, invitar admins y darse a sí mismo «Corregir pagos» o
// «Validar pagos» desde Equipo, con doce admins en la organización. Pasó: una
// admin se concedió «Corregir pagos» y «Administrar Grupo GF», y dos admins
// dieron «Validar pagos» a otras personas. Desde entonces un admin solo puede
// invitar o quitar vendedoras y solo lectura, y conceder lo operativo
// («Reportar entregas de rutas»). Roles, admins y permisos de dinero o datos:
// solo el dueño.

import type { Role } from "@/lib/types";

export const ROLES: Role[] = ["owner", "admin", "viewer", "vendedora"];

export interface MemberLite {
  user_id: string;
  role: Role;
}

export function isRole(v: string): v is Role {
  return (ROLES as string[]).includes(v);
}

export function ownerCount(members: MemberLite[]): number {
  return members.filter((m) => m.role === "owner").length;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/** May `actorRole` remove `targetUserId` from this member set? */
export function canRemoveMember(
  members: MemberLite[],
  targetUserId: string,
  actorRole: Role,
): GuardResult {
  const target = members.find((m) => m.user_id === targetUserId);
  if (!target) return { ok: false, reason: "No es miembro de la organización." };
  if (target.role === "owner" && actorRole !== "owner") {
    return { ok: false, reason: "Solo un owner puede remover a otro owner." };
  }
  if (target.role === "admin" && actorRole !== "owner") {
    return { ok: false, reason: "Solo el dueño puede quitar a un admin." };
  }
  if (target.role === "owner" && ownerCount(members) <= 1) {
    return { ok: false, reason: "No puedes remover al único owner." };
  }
  return { ok: true };
}

/** May `actorRole` change `targetUserId` to `newRole`? */
export function canSetRole(
  members: MemberLite[],
  targetUserId: string,
  newRole: string,
  actorRole: Role,
): GuardResult {
  if (!isRole(newRole)) return { ok: false, reason: "Rol inválido." };
  const target = members.find((m) => m.user_id === targetUserId);
  if (!target) return { ok: false, reason: "No es miembro de la organización." };
  if (target.role === newRole) return { ok: true };
  if (actorRole !== "owner") return { ok: false, reason: "Solo el dueño cambia roles." };
  // Only owners may grant or revoke the owner role.
  if ((target.role === "owner" || newRole === "owner") && actorRole !== "owner") {
    return { ok: false, reason: "Solo un owner puede gestionar el rol owner." };
  }
  // Never demote the last remaining owner.
  if (target.role === "owner" && newRole !== "owner" && ownerCount(members) <= 1) {
    return { ok: false, reason: "No puedes quitar el rol al único owner." };
  }
  return { ok: true };
}

/** May `actorRole` add a member with `newRole`? */
export function canAddMember(newRole: string, actorRole: Role): GuardResult {
  if (!isRole(newRole)) return { ok: false, reason: "Rol inválido." };
  if (newRole === "owner" && actorRole !== "owner") {
    return { ok: false, reason: "Solo un owner puede asignar el rol owner." };
  }
  if (newRole === "admin" && actorRole !== "owner") {
    return { ok: false, reason: "Solo el dueño puede invitar a alguien como admin." };
  }
  return { ok: true };
}

/** Los roles que `actorRole` puede elegir al invitar: un admin, solo los que no reparten poder. */
export function invitableRoles(actorRole: Role): Role[] {
  return ROLES.filter((role) => canAddMember(role, actorRole).ok);
}

/**
 * Protege la lista explicita de personas que validan pagos.
 *
 * - Un admin no puede modificar los permisos de un owner.
 * - Nunca se puede desactivar al ultimo validador de la organizacion.
 */
export function canSetPaymentValidator(
  members: MemberLite[],
  targetUserId: string,
  grant: boolean,
  actorRole: Role,
  activeValidatorIds: readonly string[],
  /**
   * Cómo se llama el permiso, para el mensaje. `null` desactiva la regla del
   * último: hay permisos cuya ausencia total no deja nada parado, y ahí exigir
   * que quede alguien sería un candado sin motivo.
   */
  label: string | null = "validar pagos",
  /**
   * Si el permiso es de dinero o de datos (`GRANTED_ONE_BY_ONE[].ownerOnly`), su
   * nombre: solo el dueño lo da o lo quita, también a sí mismo. Null = no.
   */
  ownerOnlyLabel: string | null = null,
): GuardResult {
  const target = members.find((member) => member.user_id === targetUserId);
  if (!target) return { ok: false, reason: "No es miembro de la organizacion." };
  if (ownerOnlyLabel && actorRole !== "owner") {
    return { ok: false, reason: `Solo el dueño puede dar o quitar «${ownerOnlyLabel}».` };
  }
  if (target.role === "owner" && actorRole !== "owner") {
    return { ok: false, reason: "Solo un owner puede modificar los permisos de otro owner." };
  }
  const active = new Set(activeValidatorIds);
  if (label && !grant && active.has(targetUserId) && active.size <= 1) {
    return {
      ok: false,
      reason: `Debe quedar al menos una persona autorizada para ${label.toLocaleLowerCase("es")}.`,
    };
  }
  return { ok: true };
}
