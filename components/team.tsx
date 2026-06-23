"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { Role } from "@/lib/types";
import { ROLES } from "@/lib/team";
import {
  addMember,
  removeMember,
  setMemberRole,
  setStoreAccess,
  type TeamActionState,
} from "@/app/dashboard/team/actions";
import { Card } from "@/components/ui";

const initial: TeamActionState = {};

export interface TeamMember {
  user_id: string;
  email: string;
  role: Role;
  stores: string[]; // store ids the member has explicit access to
}

interface Store {
  id: string;
  name: string;
}

export function TeamManager({
  org,
  orgs,
  myRole,
  currentUserId,
  stores,
  members,
}: {
  org: { id: string; name: string };
  orgs: { id: string; name: string }[];
  myRole: Role;
  currentUserId: string;
  stores: Store[];
  members: TeamMember[];
}) {
  const ownerCnt = members.filter((m) => m.role === "owner").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Equipo y accesos</h1>
          <p className="text-sm text-slate-500">
            Organización <strong>{org.name}</strong> · tu rol: {myRole}
          </p>
        </div>
        {orgs.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {orgs.map((o) => (
              <Link
                key={o.id}
                href={`/dashboard/team?org=${o.id}`}
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  o.id === org.id
                    ? "border-brand-500 bg-brand-50 text-brand-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {o.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      <AddMemberForm orgId={org.id} myRole={myRole} />

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-500">
                <th className="py-2 text-left font-medium">Miembro</th>
                <th className="py-2 text-left font-medium">Rol</th>
                <th className="py-2 text-left font-medium">Acceso a tiendas</th>
                <th className="py-2 text-right font-medium">Acción</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id} className="border-b border-slate-100 align-top last:border-0">
                  <td className="py-3 text-slate-800">
                    {m.email}
                    {m.user_id === currentUserId && (
                      <span className="ml-1 text-xs text-slate-400">(tú)</span>
                    )}
                  </td>
                  <td className="py-3">
                    <RoleForm orgId={org.id} member={m} myRole={myRole} ownerCnt={ownerCnt} />
                  </td>
                  <td className="py-3">
                    <StoreAccessCell orgId={org.id} member={m} stores={stores} />
                  </td>
                  <td className="py-3 text-right">
                    <RemoveForm orgId={org.id} member={m} myRole={myRole} ownerCnt={ownerCnt} />
                  </td>
                </tr>
              ))}
              {!members.length && (
                <tr>
                  <td colSpan={4} className="py-4 text-sm text-slate-400">
                    Sin miembros todavía.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function roleOptions(showOwner: boolean): Role[] {
  return ROLES.filter((r) => r !== "owner" || showOwner);
}

function AddMemberForm({ orgId, myRole }: { orgId: string; myRole: Role }) {
  const [state, action, pending] = useActionState(addMember, initial);
  return (
    <Card>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="org_id" value={orgId} />
        <div className="grow">
          <label className="block text-sm font-medium text-slate-700" htmlFor="email">
            Invitar por email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="persona@correo.com"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor="role">
            Rol
          </label>
          <select
            id="role"
            name="role"
            defaultValue="viewer"
            className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          >
            {roleOptions(myRole === "owner").map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Invitando…" : "Invitar"}
        </button>
      </form>
      {state.error && <p className="mt-2 text-sm text-red-600">{state.error}</p>}
      {state.notice && <p className="mt-2 text-sm text-emerald-600">{state.notice}</p>}
    </Card>
  );
}

function RoleForm({
  orgId,
  member,
  myRole,
  ownerCnt,
}: {
  orgId: string;
  member: TeamMember;
  myRole: Role;
  ownerCnt: number;
}) {
  const [state, action, pending] = useActionState(setMemberRole, initial);
  const isOwnerTarget = member.role === "owner";
  const lastOwner = isOwnerTarget && ownerCnt <= 1;
  const canEdit = myRole === "owner" || !isOwnerTarget;
  const disabled = pending || lastOwner || !canEdit;
  // Always include the current role as an option so the value is valid.
  const showOwnerOption = myRole === "owner" || isOwnerTarget;
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="user_id" value={member.user_id} />
      <select
        name="role"
        defaultValue={member.role}
        disabled={disabled}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500 disabled:bg-slate-50 disabled:text-slate-400"
        title={lastOwner ? "No puedes cambiar al único owner" : undefined}
      >
        {roleOptions(showOwnerOption).map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {state.error && <span className="text-xs text-red-600">{state.error}</span>}
    </form>
  );
}

function RemoveForm({
  orgId,
  member,
  myRole,
  ownerCnt,
}: {
  orgId: string;
  member: TeamMember;
  myRole: Role;
  ownerCnt: number;
}) {
  const [state, action, pending] = useActionState(removeMember, initial);
  const lastOwner = member.role === "owner" && ownerCnt <= 1;
  const canRemove = myRole === "owner" || member.role !== "owner";
  const disabled = pending || lastOwner || !canRemove;
  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="user_id" value={member.user_id} />
      <button
        type="submit"
        disabled={disabled}
        className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:text-slate-300 disabled:hover:bg-transparent"
        title={lastOwner ? "No puedes remover al único owner" : undefined}
      >
        Quitar
      </button>
      {state.error && <span className="text-xs text-red-600">{state.error}</span>}
    </form>
  );
}

function StoreAccessCell({
  orgId,
  member,
  stores,
}: {
  orgId: string;
  member: TeamMember;
  stores: Store[];
}) {
  if (!stores.length) return <span className="text-xs text-slate-400">Sin tiendas</span>;
  // Owners/admins already see every store in the org via their role; viewers and
  // vendedoras need explicit per-store grants.
  if (member.role !== "viewer" && member.role !== "vendedora") {
    return <span className="text-xs text-slate-400">Todas (por rol)</span>;
  }
  const granted = new Set(member.stores);
  return (
    <div className="flex flex-wrap gap-2">
      {stores.map((s) => (
        <AccessToggle
          key={s.id}
          orgId={orgId}
          userId={member.user_id}
          store={s}
          has={granted.has(s.id)}
        />
      ))}
    </div>
  );
}

function AccessToggle({
  orgId,
  userId,
  store,
  has,
}: {
  orgId: string;
  userId: string;
  store: Store;
  has: boolean;
}) {
  const [, action, pending] = useActionState(setStoreAccess, initial);
  return (
    <form action={action}>
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="store_id" value={store.id} />
      <input type="hidden" name="grant" value={has ? "0" : "1"} />
      <label
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${
          has ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-500"
        } ${pending ? "opacity-50" : ""}`}
      >
        <input
          type="checkbox"
          defaultChecked={has}
          disabled={pending}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="h-3.5 w-3.5"
        />
        {store.name}
      </label>
    </form>
  );
}
