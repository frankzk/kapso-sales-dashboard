"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@/lib/types";
import { ROLES } from "@/lib/team";
import {
  addMember,
  removeMember,
  setMemberRole,
  setStoreAccess,
  saveRider,
  setRiderActive,
  linkRiderUser,
  unlinkRiderUser,
  type TeamActionState,
} from "@/app/dashboard/team/actions";
import { Card, cn, STICKY_HEAD, TABLE_WRAP, TABLE_WRAP_FROM } from "@/components/ui";

const initial: TeamActionState = {};

/**
 * Returns true for a short moment right after a save completes successfully,
 * so callers can flash a "Guardado ✓" confirmation. Detects the pending→done
 * transition (rather than a notice change) so repeated identical saves still flash.
 */
function useSavedFlash(pending: boolean, notice: string | undefined): boolean {
  const [show, setShow] = useState(false);
  const wasPending = useRef(false);
  useEffect(() => {
    const justSaved = wasPending.current && !pending && Boolean(notice);
    wasPending.current = pending;
    if (justSaved) {
      setShow(true);
      const t = setTimeout(() => setShow(false), 2500);
      return () => clearTimeout(t);
    }
  }, [pending, notice]);
  return show;
}

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

export interface RiderRow {
  id: string;
  store_id: string | null;
  courier: string | null;
  full_name: string;
  doc_number: string | null;
  phone: string | null;
  active: boolean;
  note: string | null;
  user_id: string | null;
  user_email: string | null;
}

type TeamTab = "usuarios" | "motorizados";

export function TeamManager({
  org,
  orgs,
  myRole,
  currentUserId,
  stores,
  members,
  riders,
}: {
  org: { id: string; name: string };
  orgs: { id: string; name: string }[];
  myRole: Role;
  currentUserId: string;
  stores: Store[];
  members: TeamMember[];
  riders: RiderRow[];
}) {
  const ownerCnt = members.filter((m) => m.role === "owner").length;
  const [tab, setTab] = useState<TeamTab>("usuarios");

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

      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ["usuarios", "Usuarios y accesos"],
            ["motorizados", "Motorizados"],
          ] as [TeamTab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              key === tab ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "usuarios" && (
        <>
          <AddMemberForm orgId={org.id} myRole={myRole} />
          <Card>
            <div className={TABLE_WRAP}>
              <table className="w-full text-sm">
                <thead>
                  <tr className={cn(STICKY_HEAD, "text-xs text-slate-500")}>
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
        </>
      )}

      {tab === "motorizados" && (
        <RidersTab orgId={org.id} riders={riders} stores={stores} members={members} />
      )}
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
  const saved = useSavedFlash(pending, state.notice);
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
      {pending ? (
        <span className="text-xs text-slate-400">Guardando…</span>
      ) : saved ? (
        <span className="text-xs font-medium text-emerald-600">Guardado ✓</span>
      ) : null}
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
  const [state, action, pending] = useActionState(setStoreAccess, initial);
  const saved = useSavedFlash(pending, state.notice);
  return (
    <form action={action} className="inline-flex items-center gap-1">
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
      {saved && <span className="text-xs font-medium text-emerald-600" title="Guardado">✓</span>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Motorizados. La ficha es del negocio (existe sin login); vincular un usuario
// es opcional y solo sirve para darle acceso a /reparto. Activar/desactivar no
// borra: las rutas pasadas conservan a su motorizado.
// ---------------------------------------------------------------------------

function RidersTab({
  orgId,
  riders,
  stores,
  members,
}: {
  orgId: string;
  riders: RiderRow[];
  stores: Store[];
  members: TeamMember[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  function run(action: () => Promise<TeamActionState>) {
    startTransition(async () => {
      const res = await action();
      setError(res.error ?? null);
      setNotice(res.notice ?? null);
      if (!res.error) router.refresh();
    });
  }

  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const linkedUserIds = new Set(riders.map((r) => r.user_id).filter(Boolean) as string[]);

  return (
    <div className="space-y-4">
      <Card className="space-y-2">
        <p className="text-xs text-slate-500">
          El motorizado es una ficha del negocio: puede existir sin usuario. Vincúlale un usuario
          solo si va a entrar a <code>/reparto</code> a cotejar y reportar sus paradas. Deja la
          transportadora en blanco para los motorizados propios.
        </p>
      </Card>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
      )}

      <RiderForm orgId={orgId} stores={stores} pending={pending} onSubmit={(input) => run(() => saveRider(input))} />

      <Card className="p-0">
        <div className={TABLE_WRAP_FROM[1160]}>
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className={cn(STICKY_HEAD, "text-left text-xs text-slate-500")}>
                <th className="px-4 py-2 font-medium">Motorizado</th>
                <th className="px-2 py-2 font-medium">Transportadora</th>
                <th className="px-2 py-2 font-medium">Tienda</th>
                <th className="px-2 py-2 font-medium">Usuario (/reparto)</th>
                <th className="px-2 py-2 font-medium">Estado</th>
                <th className="px-4 py-2 text-right font-medium">Acción</th>
              </tr>
            </thead>
            <tbody>
              {riders.map((r) => {
                const isEditing = editing === r.id;
                return (
                  <RiderRowView
                    key={r.id}
                    orgId={orgId}
                    rider={r}
                    stores={stores}
                    members={members}
                    linkedUserIds={linkedUserIds}
                    storeName={storeName}
                    pending={pending}
                    isEditing={isEditing}
                    onToggleEdit={() => setEditing(isEditing ? null : r.id)}
                    run={run}
                  />
                );
              })}
              {riders.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-slate-400">
                    Todavía no hay motorizados registrados.
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

function StoreSelectRider({
  stores,
  value,
  onChange,
}: {
  stores: Store[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
    >
      <option value="">Todas las tiendas</option>
      {stores.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

function RiderForm({
  orgId,
  stores,
  pending,
  onSubmit,
}: {
  orgId: string;
  stores: Store[];
  pending: boolean;
  onSubmit: (input: Parameters<typeof saveRider>[0]) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [courier, setCourier] = useState("");
  const [docNumber, setDocNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [storeId, setStoreId] = useState("");

  return (
    <Card className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Registrar motorizado
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Nombre completo"
          className="w-48 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <input
          value={courier}
          onChange={(e) => setCourier(e.target.value)}
          placeholder="Transportadora (vacío = propio)"
          className="w-52 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <input
          value={docNumber}
          onChange={(e) => setDocNumber(e.target.value)}
          placeholder="DNI"
          className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Celular"
          className="w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <StoreSelectRider stores={stores} value={storeId} onChange={setStoreId} />
        <button
          disabled={pending || fullName.trim().length < 2}
          onClick={() => {
            onSubmit({
              orgId,
              storeId: storeId || null,
              courier,
              fullName,
              docNumber,
              phone,
            });
            setFullName("");
            setCourier("");
            setDocNumber("");
            setPhone("");
            setStoreId("");
          }}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Registrar
        </button>
      </div>
    </Card>
  );
}

function RiderRowView({
  orgId,
  rider,
  stores,
  members,
  linkedUserIds,
  storeName,
  pending,
  isEditing,
  onToggleEdit,
  run,
}: {
  orgId: string;
  rider: RiderRow;
  stores: Store[];
  members: TeamMember[];
  linkedUserIds: Set<string>;
  storeName: Map<string, string>;
  pending: boolean;
  isEditing: boolean;
  onToggleEdit: () => void;
  run: (action: () => Promise<TeamActionState>) => void;
}) {
  const [fullName, setFullName] = useState(rider.full_name);
  const [courier, setCourier] = useState(rider.courier ?? "");
  const [docNumber, setDocNumber] = useState(rider.doc_number ?? "");
  const [phone, setPhone] = useState(rider.phone ?? "");
  const [storeId, setStoreId] = useState(rider.store_id ?? "");
  const [linkEmail, setLinkEmail] = useState("");

  // Miembros aún no vinculados a ningún motorizado (o el actual).
  const linkable = members.filter(
    (m) => !linkedUserIds.has(m.user_id) || m.user_id === rider.user_id,
  );

  return (
    <>
      <tr className="border-b border-slate-100 last:border-0">
        <td className="px-4 py-2.5 text-slate-800">{rider.full_name}</td>
        <td className="px-2 py-2.5 text-slate-600">
          {rider.courier ? rider.courier : <span className="text-slate-400">Propio</span>}
        </td>
        <td className="px-2 py-2.5 text-slate-600">
          {rider.store_id ? (storeName.get(rider.store_id) ?? "—") : "Todas"}
        </td>
        <td className="px-2 py-2.5 text-slate-600">
          {rider.user_email ?? <span className="text-slate-400">—</span>}
        </td>
        <td className="px-2 py-2.5">
          {rider.active ? (
            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">activo</span>
          ) : (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">inactivo</span>
          )}
        </td>
        <td className="px-4 py-2.5 text-right">
          <div className="inline-flex gap-2">
            <button onClick={onToggleEdit} className="text-xs text-brand-700 hover:underline">
              {isEditing ? "Cerrar" : "Editar"}
            </button>
            <button
              disabled={pending}
              onClick={() => run(() => setRiderActive(orgId, rider.id, !rider.active))}
              className="text-xs text-slate-500 hover:underline disabled:opacity-50"
            >
              {rider.active ? "Desactivar" : "Activar"}
            </button>
          </div>
        </td>
      </tr>
      {isEditing && (
        <tr className="bg-slate-50/60">
          <td colSpan={6} className="px-4 py-3">
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-2">
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Nombre completo"
                  className="w-48 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                />
                <input
                  value={courier}
                  onChange={(e) => setCourier(e.target.value)}
                  placeholder="Transportadora (vacío = propio)"
                  className="w-52 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                />
                <input
                  value={docNumber}
                  onChange={(e) => setDocNumber(e.target.value)}
                  placeholder="DNI"
                  className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                />
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Celular"
                  className="w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                />
                <StoreSelectRider stores={stores} value={storeId} onChange={setStoreId} />
                <button
                  disabled={pending || fullName.trim().length < 2}
                  onClick={() =>
                    run(() =>
                      saveRider({
                        orgId,
                        id: rider.id,
                        storeId: storeId || null,
                        courier,
                        fullName,
                        docNumber,
                        phone,
                      }),
                    )
                  }
                  className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  Guardar
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
                <span className="text-xs font-medium text-slate-500">Usuario para /reparto:</span>
                {rider.user_email ? (
                  <>
                    <span className="text-xs text-slate-700">{rider.user_email}</span>
                    <button
                      disabled={pending}
                      onClick={() => run(() => unlinkRiderUser(orgId, rider.id))}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      Desvincular
                    </button>
                  </>
                ) : (
                  <>
                    <select
                      value={linkEmail}
                      onChange={(e) => setLinkEmail(e.target.value)}
                      className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                    >
                      <option value="">Elegir un miembro…</option>
                      {linkable.map((m) => (
                        <option key={m.user_id} value={m.email}>
                          {m.email}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={pending || !linkEmail}
                      onClick={() => run(() => linkRiderUser(orgId, rider.id, linkEmail))}
                      className="text-xs text-brand-700 hover:underline disabled:opacity-50"
                    >
                      Vincular
                    </button>
                    <span className="text-[11px] text-slate-400">
                      El usuario debe ser miembro (invítalo en Usuarios y accesos).
                    </span>
                  </>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
