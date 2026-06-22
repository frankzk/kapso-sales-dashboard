// Pure authorization guards for team management, unit-tested and reused by the
// server actions so the tricky rules (last-owner protection, who may manage
// owners) have one source of truth.

import type { Role } from "@/lib/types";

export const ROLES: Role[] = ["owner", "admin", "viewer"];

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
  return { ok: true };
}
