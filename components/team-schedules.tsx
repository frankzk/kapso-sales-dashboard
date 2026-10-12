"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, CHECKBOX, ChoiceChip, FIELD_BOX, OpsButton, SidePanel } from "@/components/ops-ui";
import { clearAdvisorSchedule, saveAdvisorSchedule } from "@/app/dashboard/team/actions";
import { DEFAULT_SCHEDULE, daysLabel, dowShort, type AdvisorSchedule } from "@/lib/productivity-week";
import type { Role } from "@/lib/types";

const nf1 = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 1 });

const ROLE_LABEL: Partial<Record<Role, string>> = {
  owner: "Dueño",
  admin: "Admin",
  vendedora: "Vendedora",
};

export interface ScheduleMember {
  user_id: string;
  email: string;
  role: Role;
}

/**
 * Equipo › Horarios: la meta de horas de la semana y el horario de cada
 * persona. Productividad compara sus horas activas con esto; quien no tiene
 * horario usa la meta por defecto (48 h, lunes a sábado, sin horario).
 */
export function SchedulesTab({
  orgId,
  members,
  schedules,
}: {
  orgId: string;
  members: ScheduleMember[];
  schedules: Record<string, AdvisorSchedule>;
}) {
  const [editing, setEditing] = useState<ScheduleMember | null>(null);
  // Primero quienes venden: son a quienes se les mide la semana.
  const sorted = [...members].sort(
    (a, b) => Number(b.role === "vendedora") - Number(a.role === "vendedora") || a.email.localeCompare(b.email),
  );

  return (
    <section aria-labelledby="horarios-title" className="rounded-lg bg-white shadow-control ring-1 ring-line">
      <div className="border-b border-line px-4 py-4 sm:px-5">
        <h2 id="horarios-title" className="text-base font-semibold text-ink-900">
          Horarios
        </h2>
        <p className="mt-1 max-w-[72ch] text-pretty text-[13px] leading-5 text-ink-500">
          La meta de horas de la semana y el horario de cada persona. Productividad compara sus horas activas con esto y,
          si tiene horario, marca la primera actividad tarde y la última antes de la salida. Quien no tiene horario usa{" "}
          {nf1.format(DEFAULT_SCHEDULE.weeklyHours)}&nbsp;h de {daysLabel(DEFAULT_SCHEDULE.days)}.
        </p>
      </div>
      <ul className="divide-y divide-line">
        {sorted.map((m) => {
          const s = schedules[m.user_id];
          return (
            <li key={m.user_id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-sm font-medium text-ink-900">{m.email}</p>
                <p className="text-xs text-ink-500">{ROLE_LABEL[m.role] ?? m.role}</p>
              </div>
              <div className="min-w-0 flex-1 basis-64 text-[13px] leading-5">
                {s ? (
                  <>
                    <p className="tabular-nums text-ink-900">
                      <span className="font-semibold">{nf1.format(s.weeklyHours)}&nbsp;h</span> por semana · {daysLabel(s.days)}
                    </p>
                    <p className="tabular-nums text-ink-600">{s.start ? `${s.start} a ${s.end}` : "Sin horario fijo"}</p>
                  </>
                ) : (
                  <p className="flex flex-wrap items-center gap-2 text-ink-500">
                    <Badge>Por defecto</Badge>
                    <span className="tabular-nums">
                      {nf1.format(DEFAULT_SCHEDULE.weeklyHours)}&nbsp;h · {daysLabel(DEFAULT_SCHEDULE.days)}
                    </span>
                  </p>
                )}
              </div>
              {/* Ancho fijo: «Editar» y «Definir horario» no mueven la columna del horario. */}
              <div className="flex sm:w-36 sm:justify-end">
                <OpsButton size="sm" onClick={() => setEditing(m)} className="pointer-coarse:h-11">
                  {s ? "Editar" : "Definir horario"}
                </OpsButton>
              </div>
            </li>
          );
        })}
        {!sorted.length && <li className="px-4 py-6 text-sm text-ink-500 sm:px-5">Sin miembros todavía.</li>}
      </ul>
      {editing && (
        <ScheduleEditor
          key={editing.user_id}
          orgId={orgId}
          member={editing}
          current={schedules[editing.user_id] ?? null}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function ScheduleEditor({
  orgId,
  member,
  current,
  onClose,
}: {
  orgId: string;
  member: ScheduleMember;
  current: AdvisorSchedule | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const base = current ?? DEFAULT_SCHEDULE;
  const [hours, setHours] = useState(String(base.weeklyHours));
  const [days, setDays] = useState<number[]>(base.days);
  const [fixed, setFixed] = useState(Boolean(base.start));
  const [start, setStart] = useState(base.start ?? "09:00");
  const [end, setEnd] = useState(base.end ?? "18:00");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggleDay = (d: number) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)));
  const weekly = Number(hours.replace(",", "."));
  const perDay = days.length && Number.isFinite(weekly) ? weekly / days.length : null;

  function save() {
    setError(null);
    startTransition(async () => {
      const r = await saveAdvisorSchedule({
        orgId,
        userId: member.user_id,
        weeklyHours: hours,
        days,
        start: fixed ? start : null,
        end: fixed ? end : null,
      });
      if (r.error) {
        setError(r.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  function clear() {
    setError(null);
    startTransition(async () => {
      const r = await clearAdvisorSchedule(orgId, member.user_id);
      if (r.error) {
        setError(r.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <SidePanel
      label={`Horario de ${member.email}`}
      title="Horario de la semana"
      badge={current ? undefined : <Badge>Por defecto</Badge>}
      meta={member.email}
      width="max-w-[480px]"
      onClose={onClose}
    >
      <div className="flex flex-col gap-6">
        <div>
          <label htmlFor="meta-semana" className="text-[13px] font-medium text-ink-700">
            Meta de la semana
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              id="meta-semana"
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className={cn(FIELD_BOX, "h-9 w-24 px-3 tabular-nums pointer-coarse:h-11")}
            />
            <span className="text-sm text-ink-600">horas</span>
          </div>
          <p className="mt-1.5 text-xs text-ink-500">
            {perDay != null && perDay > 0
              ? `Se reparte entre sus días: ${nf1.format(perDay)} h por día.`
              : "Las horas activas: entre la primera y la última acción de cada bloque."}
          </p>
        </div>

        <fieldset>
          <legend className="text-[13px] font-medium text-ink-700">Días de trabajo</legend>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <ChoiceChip key={d} label={dowShort(d)} active={days.includes(d)} onClick={() => toggleDay(d)} />
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="sr-only">Horario</legend>
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-900">
            <input type="checkbox" checked={fixed} onChange={(e) => setFixed(e.target.checked)} className={CHECKBOX} />
            Tiene horario de entrada y salida
          </label>
          {fixed ? (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="hora-entrada" className="text-[13px] font-medium text-ink-700">
                  Entrada
                </label>
                <input
                  id="hora-entrada"
                  type="time"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className={cn(FIELD_BOX, "mt-1.5 h-9 w-32 px-3 tabular-nums pointer-coarse:h-11")}
                />
              </div>
              <div>
                <label htmlFor="hora-salida" className="text-[13px] font-medium text-ink-700">
                  Salida
                </label>
                <input
                  id="hora-salida"
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className={cn(FIELD_BOX, "mt-1.5 h-9 w-32 px-3 tabular-nums pointer-coarse:h-11")}
                />
              </div>
              <p className="basis-full text-xs text-ink-500">
                La primera actividad después de las {start || "—"} y la última antes de las {end || "—"} se marcan pasados 10
                minutos.
              </p>
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-ink-500">Sin horario solo se comparan las horas con la meta.</p>
          )}
        </fieldset>

        {error && (
          <Banner tone="crit" role="alert" title="No se guardó">
            {error}
          </Banner>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
          <OpsButton variant="primary" onClick={save} disabled={pending} className="pointer-coarse:h-11">
            {pending ? "Guardando…" : "Guardar horario"}
          </OpsButton>
          <OpsButton onClick={onClose} disabled={pending} className="pointer-coarse:h-11">
            Cancelar
          </OpsButton>
          {current && (
            <button
              type="button"
              onClick={clear}
              disabled={pending}
              className="ml-auto inline-flex h-9 items-center rounded-md px-2 text-[13px] font-medium text-crit-fg transition-colors hover:bg-crit-wash disabled:opacity-50 pointer-coarse:h-11"
            >
              Quitar horario
            </button>
          )}
        </div>
      </div>
    </SidePanel>
  );
}
