"use client";

// «Sale mañana» (owner, 07-11-2026; MOM §29.16): lo que sale a reparto con
// Grupo GF un día y lo que le falta, en una sola tarjeta. La usan Despacho del
// día (todas las tiendas de Grupo GF) y Repro Lima (nuestras tiendas); cada una
// decide qué hace tocar una cifra y qué botón lleva.
import type { ReactNode } from "react";
import { Badge, StatusCard, choiceChipClass } from "@/components/ops-ui";
import { PLAN_STEPS, PLAN_STEP_LABEL, isDeliveryDay, planMissingText, type PlanStep, type PlanSummary } from "@/lib/dispatch-plan";
import { programDayLabel } from "@/lib/dispatch-day";

export interface PlanDayOption {
  day: string;
  /** «Hoy», «Mañana» o «Próximo reparto». */
  label: string;
}

/**
 * Hoy y el próximo día de reparto, con su nombre («Mañana» si es el siguiente).
 * El domingo no hay reparto: solo el lunes.
 */
export function planDayOptions(today: string, next: string): PlanDayOption[] {
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const nextOption = { day: next, label: `${next === tomorrow ? "Mañana" : "Próximo reparto"} · ${programDayLabel(next)}` };
  return isDeliveryDay(today) ? [{ day: today, label: `Hoy · ${programDayLabel(today)}` }, nextOption] : [nextOption];
}

/** «1 cotejado» / «2 cotejados»: la palabra en singular con 1. */
function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("es-PE")} ${n === 1 ? one : many}`;
}

export function DispatchPlanPanel({
  planDay,
  options,
  onPlanDay,
  summary,
  activeStep,
  onStep,
  actions,
  scopeNote,
}: {
  planDay: string;
  options: readonly PlanDayOption[];
  onPlanDay: (day: string) => void;
  summary: PlanSummary;
  /** La cifra elegida (filtra la lista); null sin elegir. */
  activeStep: PlanStep | null;
  onStep: (step: PlanStep) => void;
  /** El botón de cada pantalla, a la derecha del título. */
  actions?: ReactNode;
  /** «Todas las tiendas de Grupo GF» o «Nuestras tiendas». */
  scopeNote?: string;
}) {
  const pending = summary.steps.sin_rotulo + summary.steps.sin_armar + summary.steps.sin_caja;
  return (
    <section aria-labelledby="plan-title" className="space-y-3 rounded-lg bg-white p-4 shadow-control ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id="plan-title" className="text-sm font-semibold text-ink-900">Sale a reparto</h3>
        <div role="group" aria-label="Día del reparto" className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <button key={o.day} type="button" aria-pressed={o.day === planDay} onClick={() => onPlanDay(o.day)} className={choiceChipClass(o.day === planDay)}>
              {o.label}
            </button>
          ))}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{actions}</div>}
      </div>

      <p className="text-sm text-ink-700" aria-live="polite">
        <b className="font-semibold tabular-nums text-ink-900">{summary.total.toLocaleString("es-PE")}</b>{" "}
        {summary.total === 1 ? "pedido sale" : "pedidos salen"} el {programDayLabel(planDay)}
        {" · "}
        <span className={pending ? "text-warn-fg" : "text-ok-fg"}>{planMissingText(summary)}</span>
        {summary.overdue > 0 && <span className="text-ink-500"> {count(summary.overdue, "debía salir antes", "debían salir antes")}.</span>}
        {summary.awaitingOffice > 0 && <span className="text-ink-500"> {count(summary.awaitingOffice, "sigue con el motorizado en una caja anterior: recíbelo en oficina", "siguen con el motorizado en una caja anterior: recíbelos en oficina")}.</span>}
        {scopeNote && <span className="text-ink-500"> {scopeNote}</span>}
      </p>

      <div role="group" aria-label="Qué falta" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PLAN_STEPS.map((step) => (
          <StatusCard
            key={step}
            label={PLAN_STEP_LABEL[step].label}
            value={summary.steps[step]}
            hint={PLAN_STEP_LABEL[step].hint}
            active={activeStep === step}
            onClick={() => onStep(step)}
          />
        ))}
      </div>

      {(summary.riders.length > 0 || summary.steps.en_caja > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-600">
          <span className="font-medium text-ink-700">En caja:</span>
          {summary.riders.map((r) => (
            <Badge key={r.name} tone={r.unarmed ? "warn" : "neutral"} title={r.unarmed ? `${r.unarmed} todavía sin armar` : undefined}>
              {`${r.name} ${r.count}${r.unarmed ? ` · ${r.unarmed} sin armar` : ""}`}
            </Badge>
          ))}
          {summary.steps.en_caja > 0 && (
            <span className="text-ink-500">
              · {count(summary.officeChecked, "cotejado", "cotejados")} en oficina · {count(summary.pickedUp, "recibido", "recibidos")} por el motorizado
            </span>
          )}
        </div>
      )}
    </section>
  );
}
