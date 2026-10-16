"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@/lib/types";
import { ROLES, invitableRoles } from "@/lib/team";
import { ACCESS_LABEL, FUNCTIONAL_ROLES, GRANTED_ONE_BY_ONE } from "@/lib/permissions";
import {
  addMember,
  removeMember,
  setMemberFunctionRole,
  setMemberRole,
  setPaymentValidationPermission,
  setStoreAccess,
  saveRider,
  setRiderActive,
  linkRiderUser,
  unlinkRiderUser,
  type TeamActionState,
} from "@/app/dashboard/team/actions";
import { Card, cn, STICKY_HEAD, TABLE_WRAP_FROM } from "@/components/ui";
import { SchedulesTab } from "@/components/team-schedules";
import { OpsButton } from "@/components/ops-ui";
import { IconChevronRight, IconInfo } from "@/components/icons";
import {
  MemberAccessPanel,
  RolesGuidePanel,
  displayName,
  type AccessMember,
  type GuideSection,
} from "@/components/team-permissions";
import type { AdvisorSchedule } from "@/lib/productivity-week";
import {
  DISPATCH_COURIERS,
  GROUP_GF_RIDER_COURIER,
  isGroupGfRiderCourier,
} from "@/lib/couriers/catalog";

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
  /** El nombre con que entró, si lo dio. */
  name: string | null;
  role: Role;
  stores: string[]; // store ids the member has explicit access to
  /** Permiso de concesión individual → si esta persona lo tiene hoy. */
  grants: Record<string, boolean>;
  /** Roles acumulables (0250, MOM §16). */
  functions: string[];
  /** Lo que puede hacer hoy y de dónde le viene (`explainPermissions`). */
  access: AccessMember["access"];
}

/** Qué panel lateral está abierto: la guía de roles o lo que puede hacer una persona. */
type AccessPanel = { kind: "guide"; section: GuideSection } | { kind: "member"; userId: string } | null;

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

type TeamTab = "usuarios" | "motorizados" | "horarios";

export function TeamManager({
  org,
  orgs,
  myRole,
  currentUserId,
  stores,
  members,
  riders,
  schedules,
  initialTab = "usuarios",
  initialScheduleUserId = null,
}: {
  org: { id: string; name: string };
  orgs: { id: string; name: string }[];
  myRole: Role;
  currentUserId: string;
  stores: Store[];
  members: TeamMember[];
  riders: RiderRow[];
  /** Meta y horario por persona (Equipo › Horarios, migración 0245). */
  schedules: Record<string, AdvisorSchedule>;
  initialTab?: TeamTab;
  /** Desde Productividad, «Editar horario» abre el de esa persona. */
  initialScheduleUserId?: string | null;
}) {
  const ownerCnt = members.filter((m) => m.role === "owner").length;
  const [tab, setTab] = useState<TeamTab>(initialTab);
  const [panel, setPanel] = useState<AccessPanel>(null);
  const openGuide = (section: GuideSection) => setPanel({ kind: "guide", section });
  const openMember = (userId: string) => setPanel({ kind: "member", userId });
  const panelMember = panel?.kind === "member" ? members.find((m) => m.user_id === panel.userId) : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Equipo y accesos</h1>
          <p className="text-sm text-slate-500">
            Organización <strong>{org.name}</strong> · tu acceso: {ACCESS_LABEL[myRole] ?? myRole}
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
            ["horarios", "Horarios"],
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
            {/* Antes, dos párrafos enumeraban cada rol y cada permiso de corrido, y el
                resto solo salía al pasar el ratón. Ahora una frase y la guía. */}
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-[68ch] text-[13px] leading-5 text-ink-600">
                Cada persona tiene un <strong className="font-semibold text-ink-900">acceso</strong> y, encima,{" "}
                <strong className="font-semibold text-ink-900">roles</strong> que le suman permisos. Los de dinero y
                datos se dan uno por uno. Toca «permisos» en una fila para ver qué puede hacer esa persona y por qué.
              </p>
              <OpsButton size="sm" className="shrink-0" onClick={() => openGuide(FUNCTIONAL_ROLES[0].role)}>
                <IconInfo width={16} height={16} aria-hidden />
                ¿Qué hace cada rol?
              </OpsButton>
            </div>
            <div className={TABLE_WRAP_FROM[1110]}>
              <table className="w-full min-w-[1040px] text-sm">
                <thead>
                  <tr className={cn(STICKY_HEAD, "text-xs text-slate-500")}>
                    <th className="py-2 text-left font-medium">Miembro</th>
                    <th className="py-2 text-left font-medium">
                      <HeadWithGuide label="Roles" onOpen={() => openGuide(FUNCTIONAL_ROLES[0].role)} />
                    </th>
                    <th className="py-2 text-left font-medium">
                      <HeadWithGuide label="Permisos por persona" onOpen={() => openGuide("uno-por-uno")} />
                    </th>
                    <th className="py-2 text-left font-medium">
                      <HeadWithGuide label="Acceso" onOpen={() => openGuide("accesos")} />
                    </th>
                    <th className="py-2 text-left font-medium">Acceso a tiendas</th>
                    <th className="py-2 text-right font-medium">Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.user_id} className="border-b border-slate-100 align-top last:border-0">
                      <td className="py-3 text-slate-800">
                        {m.name ?? m.email}
                        {m.user_id === currentUserId && (
                          <span className="ml-1 text-xs text-slate-400">(tú)</span>
                        )}
                        {m.name && <span className="block text-xs text-slate-500">{m.email}</span>}
                      </td>
                      <td className="py-3">
                        <FunctionRolesCell
                          orgId={org.id}
                          member={m}
                          myRole={myRole}
                          onOpenGuide={openGuide}
                          onOpenMember={() => openMember(m.user_id)}
                        />
                      </td>
                      <td className="py-3">
                        <PaymentValidationToggle orgId={org.id} member={m} myRole={myRole} />
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
                      <td colSpan={6} className="py-4 text-sm text-slate-400">
                        Sin miembros todavía.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
          {panel?.kind === "guide" && (
            <RolesGuidePanel
              section={panel.section}
              onSelect={openGuide}
              members={members}
              onClose={() => setPanel(null)}
            />
          )}
          {panelMember && (
            <MemberAccessPanel member={panelMember} onOpenGuide={openGuide} onClose={() => setPanel(null)} />
          )}
        </>
      )}

      {tab === "horarios" && (
        <SchedulesTab
          orgId={org.id}
          members={members.map((m) => ({ user_id: m.user_id, email: m.email, role: m.role }))}
          schedules={schedules}
          initialEditUserId={initialScheduleUserId}
        />
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
            Acceso
          </label>
          <select
            id="role"
            name="role"
            defaultValue="viewer"
            className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          >
            {/* Un admin solo invita vendedoras y solo lectura (MOM §16). */}
            {invitableRoles(myRole).map((r) => (
              <option key={r} value={r}>
                {ACCESS_LABEL[r] ?? r}
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
  // Solo el dueño cambia roles (MOM §16, 12-10-2026).
  const canEdit = myRole === "owner";
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
        title={lastOwner ? "No puedes cambiar al único owner" : !canEdit ? "Solo el dueño cambia roles" : undefined}
      >
        {roleOptions(showOwnerOption).map((r) => (
          <option key={r} value={r}>
            {ACCESS_LABEL[r] ?? r}
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

/**
 * Los roles acumulables de una persona (MOM §16). El dueño los marca y desmarca;
 * los demás los ven. Debajo, plegado, todo lo que la persona puede hacer hoy.
 */
/** Encabezado de columna con un botón que abre su parte de la guía. */
function HeadWithGuide({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Qué significa «${label}»`}
        className="grid size-6 place-items-center rounded text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:size-11"
      >
        <IconInfo width={14} height={14} aria-hidden />
      </button>
    </span>
  );
}

function FunctionRolesCell({
  orgId,
  member,
  myRole,
  onOpenGuide,
  onOpenMember,
}: {
  orgId: string;
  member: TeamMember;
  myRole: Role;
  onOpenGuide: (section: GuideSection) => void;
  onOpenMember: () => void;
}) {
  const canEdit = myRole === "owner";
  const count = member.access.granted.length;
  return (
    <div className="flex flex-col gap-1">
      {canEdit ? (
        FUNCTIONAL_ROLES.map((entry) => (
          <FunctionRoleToggle key={entry.role} orgId={orgId} member={member} entry={entry} />
        ))
      ) : member.functions.length ? (
        <div className="flex max-w-56 flex-wrap gap-1">
          {FUNCTIONAL_ROLES.filter((entry) => member.functions.includes(entry.role)).map((entry) => (
            <button
              key={entry.role}
              type="button"
              onClick={() => onOpenGuide(entry.role)}
              className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-200"
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : (
        <span className="text-xs text-slate-400" title="Solo el dueño asigna roles">Sin roles</span>
      )}
      <button
        type="button"
        onClick={onOpenMember}
        aria-label={`Qué puede hacer ${displayName(member)}`}
        className="mt-1 inline-flex w-fit items-center gap-0.5 rounded text-xs font-medium text-brand-700 underline-offset-2 hover:underline pointer-coarse:min-h-11"
      >
        {count ? `${count} ${count === 1 ? "permiso" : "permisos"}` : "Solo mira"}
        <IconChevronRight width={14} height={14} aria-hidden />
      </button>
    </div>
  );
}

function FunctionRoleToggle({
  orgId,
  member,
  entry,
}: {
  orgId: string;
  member: TeamMember;
  entry: (typeof FUNCTIONAL_ROLES)[number];
}) {
  const [state, action, pending] = useActionState(setMemberFunctionRole, initial);
  const has = member.functions.includes(entry.role);
  return (
    <form action={action} className="flex flex-col">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="user_id" value={member.user_id} />
      <input type="hidden" name="role" value={entry.role} />
      <input type="hidden" name="grant" value={has ? "0" : "1"} />
      <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-xs font-medium text-slate-700" title={entry.description}>
        <input
          type="checkbox"
          defaultChecked={has}
          disabled={pending}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          aria-label={`${entry.label} — rol de ${member.email}`}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        {entry.label}
      </label>
      {state.error && <span className="max-w-56 text-[11px] text-red-600">{state.error}</span>}
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
  // A un admin u owner solo lo quita el dueño (MOM §16).
  const canRemove = myRole === "owner" || (member.role !== "owner" && member.role !== "admin");
  const disabled = pending || lastOwner || !canRemove;
  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="user_id" value={member.user_id} />
      <button
        type="submit"
        disabled={disabled}
        className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:text-slate-300 disabled:hover:bg-transparent"
        title={lastOwner ? "No puedes remover al único owner" : !canRemove ? "Solo el dueño puede quitar a un admin" : undefined}
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

function PaymentValidationToggle({
  orgId,
  member,
  myRole,
}: {
  orgId: string;
  member: TeamMember;
  myRole: Role;
}) {
  return (
    <div className="flex min-w-44 flex-col gap-1.5">
      {GRANTED_ONE_BY_ONE.map((entry) => (
        <OneByOneToggle
          key={entry.permission}
          orgId={orgId}
          member={member}
          myRole={myRole}
          entry={entry}
        />
      ))}
    </div>
  );
}

/**
 * Una casilla por permiso de concesión individual.
 *
 * Cada una es su propio formulario y su propio `useActionState`: con uno solo
 * compartido, guardar «Corregir pagos» habría pintado el «Guardado ✓» sobre
 * «Validar pagos» y quien mira no sabría cuál se guardó.
 */
function OneByOneToggle({
  orgId,
  member,
  myRole,
  entry,
}: {
  orgId: string;
  member: TeamMember;
  myRole: Role;
  entry: (typeof GRANTED_ONE_BY_ONE)[number];
}) {
  const [state, action, pending] = useActionState(setPaymentValidationPermission, initial);
  const saved = useSavedFlash(pending, state.notice);
  // Dinero y datos: solo el dueño los da o los quita, también a sí mismo (MOM §16).
  const canEdit = myRole === "owner" || (!entry.ownerOnly && member.role !== "owner");
  const has = member.grants[entry.permission] ?? false;
  return (
    <form action={action} className="flex flex-col gap-0.5">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="user_id" value={member.user_id} />
      <input type="hidden" name="permission" value={entry.permission} />
      <input type="hidden" name="grant" value={has ? "0" : "1"} />
      <label
        className={cn(
          "inline-flex w-fit items-center gap-2 text-xs font-medium",
          canEdit ? "cursor-pointer text-slate-700" : "cursor-not-allowed text-slate-400",
        )}
        title={!canEdit && entry.ownerOnly ? `${entry.description} Solo el dueño lo da o lo quita.` : entry.description}
      >
        <input
          type="checkbox"
          defaultChecked={has}
          disabled={pending || !canEdit}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          aria-label={`${entry.label} — permitir a ${member.email}`}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
        {entry.label}
      </label>
      {pending ? (
        <span className="text-[11px] text-slate-400">Guardando…</span>
      ) : saved ? (
        <span className="text-[11px] font-medium text-emerald-600">Guardado ✓</span>
      ) : null}
      {state.error && <span className="max-w-56 text-[11px] text-red-600">{state.error}</span>}
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
          empresa operadora. Los motorizados internos pertenecen formalmente a Grupo GF Courier;
          las fichas históricas conservan sus IDs y rutas.
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

function RiderCourierSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const normalized = isGroupGfRiderCourier(value) ? GROUP_GF_RIDER_COURIER : value;
  const options = [...new Set(DISPATCH_COURIERS.map((option) => option.label))];
  if (normalized && !options.includes(normalized)) options.push(normalized);
  return (
    <label className="text-xs font-medium text-slate-600">
      Empresa operadora
      <select
        value={normalized}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block h-9 w-52 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      >
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
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
  const [courier, setCourier] = useState(GROUP_GF_RIDER_COURIER);
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
        <RiderCourierSelect value={courier} onChange={setCourier} />
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
            setCourier(GROUP_GF_RIDER_COURIER);
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
  const [courier, setCourier] = useState(
    isGroupGfRiderCourier(rider.courier) ? GROUP_GF_RIDER_COURIER : rider.courier ?? GROUP_GF_RIDER_COURIER,
  );
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
          {isGroupGfRiderCourier(rider.courier) ? GROUP_GF_RIDER_COURIER : rider.courier}
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
                <RiderCourierSelect value={courier} onChange={setCourier} />
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
