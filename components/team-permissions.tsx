"use client";

// Equipo › guía de roles y permisos (13-10-2026, MOM §16). Reemplaza el
// párrafo que enumeraba cada rol y cada permiso de corrido, y las ayudas que
// solo salían al pasar el ratón (en el celular no se veían). Dos lecturas en el
// mismo panel lateral:
//
//   - «¿Qué hace cada rol?»: un índice (los siete roles, la vendedora sin roles,
//     los permisos que se dan uno por uno y los accesos) y, al lado, el elegido
//     con sus permisos agrupados por área, cada uno con lo que deja hacer.
//   - «Lo que puede hacer» una persona: sus permisos por área y, junto a cada
//     uno, de dónde le viene (su acceso, cada rol, una concesión uno por uno), y
//     aparte lo que se le quitó a mano.
//
// Los nombres y las explicaciones salen del glosario de lib/permissions.ts.

import { useEffect, useId, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { Badge, FIELD, SidePanel } from "@/components/ops-ui";
import { IconChevronRight } from "@/components/icons";
import {
  ACCESS_HELP,
  ACCESS_LABEL,
  FUNCTIONAL_ROLES,
  GRANTED_ONE_BY_ONE,
  PERMISSION_HELP,
  PERMISSION_LABEL,
  groupByArea,
  permissionsFor,
  type FunctionalRole,
  type Permission,
  type PermissionSource,
} from "@/lib/permissions";

/** Lo que el panel necesita de cada persona del equipo. */
export interface AccessMember {
  user_id: string;
  email: string;
  name: string | null;
  role: string;
  functions: string[];
  access: {
    granted: { permission: Permission; sources: PermissionSource[] }[];
    revoked: Permission[];
  };
}

/** Qué parte de la guía está abierta. */
export type GuideSection = FunctionalRole | "vendedora" | "uno-por-uno" | "accesos";

export function displayName(member: Pick<AccessMember, "name" | "email">): string {
  return member.name?.trim() || member.email;
}

function sourceLabel(source: PermissionSource): string {
  if (source.kind === "grant") return "Dado uno por uno";
  if (source.kind === "function") return FUNCTIONAL_ROLES.find((entry) => entry.role === source.role)?.label ?? source.role;
  return `Viene con ${ACCESS_LABEL[source.role] ?? source.role}`;
}

/** El panel lateral se cierra también con Escape, como las hojas del producto. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** Una fila del glosario: el nombre, lo que deja hacer y, a la derecha, lo que se diga de ella. */
function PermissionRow({ permission, aside, muted = false }: { permission: Permission; aside?: ReactNode; muted?: boolean }) {
  return (
    <li className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className={cn("text-sm font-medium", muted ? "text-ink-500 line-through decoration-ink-300" : "text-ink-900")}>
          {PERMISSION_LABEL[permission]}
        </p>
        <p className="mt-0.5 max-w-[60ch] text-[13px] leading-5 text-ink-500">{PERMISSION_HELP[permission]}</p>
      </div>
      {aside && <div className="flex shrink-0 flex-wrap gap-1 sm:max-w-[45%] sm:justify-end">{aside}</div>}
    </li>
  );
}

/** Los permisos de una lista, por área: el título del área y sus filas sobre hairlines. */
function AreaList<T extends { permission: Permission }>({
  items,
  aside,
  muted,
}: {
  items: readonly T[];
  aside?: (item: T) => ReactNode;
  muted?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-6">
      {groupByArea(items).map((area) => (
        <section key={area.key} aria-labelledby={`${id}-${area.key}`}>
          <h4 id={`${id}-${area.key}`} className="flex items-baseline gap-2 text-[13px] font-semibold text-ink-700">
            {area.label}
            <span className="font-normal tabular-nums text-ink-500">{area.items.length}</span>
          </h4>
          <ul className="mt-1 divide-y divide-line border-t border-line">
            {area.items.map((item) => (
              <PermissionRow key={item.permission} permission={item.permission} aside={aside?.(item)} muted={muted} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Quiénes tienen algo, en una línea; sin nadie, lo dice. */
function Holders({ members, empty = "Nadie lo tiene todavía." }: { members: AccessMember[]; empty?: string }) {
  if (!members.length) return <p className="text-[13px] text-ink-500">{empty}</p>;
  return (
    <p className="text-[13px] leading-5 text-ink-500">
      <span className="font-medium text-ink-700">Lo tienen ({members.length}):</span>{" "}
      {members.map((member) => displayName(member)).join(", ")}
    </p>
  );
}

const ROLE_SECTIONS = FUNCTIONAL_ROLES.map((entry) => ({ key: entry.role as GuideSection, label: entry.label, count: entry.permissions.length }));
const VENDEDORA_BUNDLE = [...permissionsFor(["vendedora"])];
const EXTRA_SECTIONS: { key: GuideSection; label: string; short?: string; count?: number }[] = [
  { key: "vendedora", label: "Vendedora sin roles", count: VENDEDORA_BUNDLE.length },
  { key: "uno-por-uno", label: "Los que se dan uno por uno", short: "Uno por uno", count: GRANTED_ONE_BY_ONE.length },
  { key: "accesos", label: "Accesos" },
];

function GuideIndex({ section, onSelect }: { section: GuideSection; onSelect: (section: GuideSection) => void }) {
  const selectId = useId();
  const item = (entry: { key: GuideSection; label: string; short?: string; count?: number }) => (
    <li key={entry.key}>
      <button
        type="button"
        aria-current={entry.key === section ? "true" : undefined}
        onClick={() => onSelect(entry.key)}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors pointer-coarse:h-11",
          entry.key === section ? "bg-brand-50 font-semibold text-brand-700" : "text-ink-600 hover:bg-wash hover:text-ink-900",
        )}
      >
        <span className="truncate">{entry.short ?? entry.label}</span>
        {entry.count != null && (
          <span className={cn("tabular-nums text-xs", entry.key === section ? "text-brand-700" : "text-ink-500")}>{entry.count}</span>
        )}
      </button>
    </li>
  );
  return (
    <nav aria-label="Partes de la guía">
      {/* En el teléfono, un selector como el «Ir a» de Ajustes: diez chips
          ocupaban cuatro filas antes de lo que se quería leer. */}
      <div className="md:hidden">
        <label htmlFor={selectId} className="text-[13px] font-medium text-ink-700">
          Ver
        </label>
        <select
          id={selectId}
          value={section}
          onChange={(event) => onSelect(event.target.value as GuideSection)}
          className={cn(FIELD, "mt-1.5 pointer-coarse:h-11")}
        >
          <optgroup label="Roles">
            {ROLE_SECTIONS.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Además">
            {EXTRA_SECTIONS.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className="hidden md:block">
        <p className="px-2.5 text-xs font-semibold text-ink-500">Roles</p>
        <ul className="mt-1 flex flex-col gap-0.5">{ROLE_SECTIONS.map(item)}</ul>
        <p className="mt-5 px-2.5 text-xs font-semibold text-ink-500">Además</p>
        <ul className="mt-1 flex flex-col gap-0.5">{EXTRA_SECTIONS.map(item)}</ul>
      </div>
    </nav>
  );
}

function SectionTitle({ title, badge, children }: { title: string; badge?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-1.5 border-b border-line pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-ink-900">{title}</h3>
        {badge}
      </div>
      {children}
    </header>
  );
}

function GuideDetail({ section, members }: { section: GuideSection; members: AccessMember[] }) {
  const role = FUNCTIONAL_ROLES.find((entry) => entry.role === section);
  if (role) {
    const items = role.permissions.map((permission) => ({ permission }));
    return (
      <div className="flex flex-col gap-5">
        <SectionTitle title={role.label} badge={<Badge>{role.permissions.length} permisos</Badge>}>
          <p className="max-w-[62ch] text-sm text-ink-600">{role.description}</p>
          <Holders members={members.filter((member) => member.functions.includes(role.role))} />
        </SectionTitle>
        <AreaList items={items} />
      </div>
    );
  }
  if (section === "vendedora") {
    return (
      <div className="flex flex-col gap-5">
        <SectionTitle title="Vendedora sin roles" badge={<Badge>{VENDEDORA_BUNDLE.length} permisos</Badge>}>
          <p className="max-w-[62ch] text-sm text-ink-600">
            Lo que tiene quien entra como vendedora y todavía no tiene roles. En cuanto le das un rol, deja de
            tener esto y tiene solo lo de sus roles.
          </p>
          <Holders
            members={members.filter((member) => member.role === "vendedora" && !member.functions.length)}
            empty="Todas las vendedoras tienen roles."
          />
        </SectionTitle>
        <AreaList items={VENDEDORA_BUNDLE.map((permission) => ({ permission }))} />
      </div>
    );
  }
  if (section === "uno-por-uno") {
    return (
      <div className="flex flex-col gap-5">
        <SectionTitle title="Los que se dan uno por uno">
          <p className="max-w-[62ch] text-sm text-ink-600">
            No vienen con ningún rol: se dan a una persona en la columna «Permisos por persona». Los de dinero y
            datos solo los da el dueño.
          </p>
        </SectionTitle>
        <ul className="divide-y divide-line">
          {GRANTED_ONE_BY_ONE.map((entry) => {
            const holders = members.filter((member) =>
              member.access.granted.some((item) => item.permission === entry.permission && item.sources.some((source) => source.kind === "grant")),
            );
            return (
              <li key={entry.permission} className="flex flex-col gap-2 py-3">
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">{entry.label}</p>
                    <p className="mt-0.5 max-w-[60ch] text-[13px] leading-5 text-ink-500">{PERMISSION_HELP[entry.permission]}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1 sm:justify-end">
                    {entry.ownerOnly && <Badge>Solo el dueño</Badge>}
                    {"withAdminRole" in entry && entry.withAdminRole && <Badge>Viene con dueño y admin</Badge>}
                  </div>
                </div>
                <Holders members={holders} empty="Nadie lo tiene dado." />
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <SectionTitle title="Accesos">
        <p className="max-w-[62ch] text-sm text-ink-600">
          Cada persona tiene un acceso (la columna «Acceso»). Los roles se suman encima del acceso de vendedora.
        </p>
      </SectionTitle>
      <ul className="divide-y divide-line">
        {["owner", "admin", "vendedora", "viewer", "motorizado"].map((role) => (
          <li key={role} className="py-3">
            <p className="text-sm font-medium text-ink-900">{ACCESS_LABEL[role]}</p>
            <p className="mt-0.5 max-w-[60ch] text-[13px] leading-5 text-ink-500">{ACCESS_HELP[role]}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** «¿Qué hace cada rol?»: el índice a la izquierda (chips arriba en el teléfono) y lo elegido al lado. */
export function RolesGuidePanel({
  section,
  onSelect,
  members,
  onClose,
}: {
  section: GuideSection;
  onSelect: (section: GuideSection) => void;
  members: AccessMember[];
  onClose: () => void;
}) {
  useEscape(onClose);
  return (
    <SidePanel
      label="Qué hace cada rol"
      title="¿Qué hace cada rol?"
      meta="Los roles se suman. Los asigna el dueño."
      width="max-w-[880px]"
      onClose={onClose}
    >
      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8">
        <GuideIndex section={section} onSelect={onSelect} />
        <GuideDetail section={section} members={members} />
      </div>
    </SidePanel>
  );
}

/** Lo que puede hacer una persona hoy, por área y con el origen de cada permiso. */
export function MemberAccessPanel({
  member,
  onOpenGuide,
  onClose,
}: {
  member: AccessMember;
  onOpenGuide: (section: GuideSection) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  const { granted, revoked } = member.access;
  const roles = FUNCTIONAL_ROLES.filter((entry) => member.functions.includes(entry.role));
  // Lo que trae el acceso se dice una vez arriba: repetido en cada fila («Viene
  // con Dueño» cuarenta y dos veces) tapaba lo que sí distingue a la persona.
  const byAccess = granted.filter((item) => item.sources.some((source) => source.kind === "access")).length;
  return (
    <SidePanel
      label={`Lo que puede hacer ${displayName(member)}`}
      title={displayName(member)}
      badge={<Badge>{ACCESS_LABEL[member.role] ?? member.role}</Badge>}
      meta={member.name ? member.email : undefined}
      width="max-w-[600px]"
      onClose={onClose}
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3 border-b border-line pb-4">
          <p className="text-sm text-ink-700">
            {granted.length ? (
              <>
                Puede hacer <strong className="font-semibold tabular-nums text-ink-900">{granted.length}</strong>{" "}
                {granted.length === 1 ? "cosa" : "cosas"}.
              </>
            ) : (
              "Solo puede mirar: no cambia nada."
            )}{" "}
            {byAccess > 0 &&
              (member.role === "vendedora"
                ? "No tiene roles: tiene el paquete de vendedora."
                : `${byAccess === granted.length ? "Todo" : byAccess} viene con su acceso de ${ACCESS_LABEL[member.role] ?? member.role}.`)}
          </p>
          {roles.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] text-ink-500">Roles:</span>
              {roles.map((entry) => (
                <button
                  key={entry.role}
                  type="button"
                  onClick={() => onOpenGuide(entry.role)}
                  className="inline-flex h-7 items-center gap-1 rounded-full bg-white px-2.5 text-[13px] font-medium text-ink-700 ring-1 ring-inset ring-line-strong transition-shadow hover:ring-ink-300 pointer-coarse:h-11"
                >
                  {entry.label}
                  <IconChevronRight width={14} height={14} aria-hidden className="text-ink-500" />
                </button>
              ))}
            </div>
          )}
        </div>
        {granted.length > 0 && (
          <AreaList
            items={granted}
            aside={(item) =>
              item.sources
                .filter((source) => source.kind !== "access")
                .map((source, i) => <Badge key={i}>{sourceLabel(source)}</Badge>)
            }
          />
        )}
        {revoked.length > 0 && (
          <section aria-label="Quitados a esta persona" className="flex flex-col gap-2">
            <h4 className="text-[13px] font-semibold text-ink-700">Quitados a esta persona</h4>
            <p className="text-[13px] text-ink-500">Su acceso o un rol los traen, pero se le quitaron uno por uno.</p>
            <ul className="divide-y divide-line border-t border-line">
              {revoked.map((permission) => (
                <PermissionRow key={permission} permission={permission} muted aside={<Badge tone="warn">Quitado</Badge>} />
              ))}
            </ul>
          </section>
        )}
        <button
          type="button"
          onClick={() => onOpenGuide(roles[0]?.role ?? (member.role === "vendedora" ? "vendedora" : "accesos"))}
          className="inline-flex w-fit items-center gap-1 text-[13px] font-medium text-brand-700 underline-offset-2 hover:underline pointer-coarse:min-h-11"
        >
          ¿Qué hace cada rol?
          <IconChevronRight width={14} height={14} aria-hidden />
        </button>
      </div>
    </SidePanel>
  );
}
