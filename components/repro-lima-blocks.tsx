"use client";

// El flujo del día y la Agenda de Repro Lima (owner, 15-11-2026; MOM §9.5).
//
// TERCERA VUELTA (owner, 15-11-2026): «estos 5 no suman 1,438 pedidos»,
// «Por cerrar no lo necesito como tal», «lo del martes al viernes, ponlo
// dentro de Después», «en Hoy y Mañana… cuáles tienen guía y cuáles no; los
// que no tienen guía son una alerta» y «más preocupados en sacar todos los
// pedidos a reparto». Ahora:
// - los seis PASOS son una partición (`limaStepOf`): cada pedido está en uno y
//   solo uno, así que suman el total de arriba, y una barra de reparto lo
//   muestra («en la barra superior las etapas deben sumar el total»). Los
//   cuatro del trabajo van numerados y a lo ancho; «Con el courier» y «Por
//   cerrar», que el equipo solo mira, van plegados al final, más delgados y en
//   gris («las que no necesitamos, como Por cerrar, plegadas para que no
//   interrumpan»). «Sacar a reparto» reemplaza a «Confirmar primer despacho» y
//   lleva todo lo que falta que salga, con día o sin él;
// - lo que vive DENTRO de un paso (Reintentos Aliclik, Sin fecha, En ruta…) se
//   dice dentro de su celda y su filtro aparece en el pie de ESA tarjeta solo
//   cuando el paso está elegido, con su nombre delante;
// - la Agenda es Hoy, Mañana, Después y Sin fecha. Hoy y Mañana dicen cuántos
//   tienen guía o rótulo y cuántos no; los que no, son una alerta con filtro.
// Cada cifra sigue siendo un filtro de la única lista de abajo (The Cifras
// Navegan Rule). Solo dibuja: las cuentas salen de lib/repro-lima-blocks.ts.
import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { AttentionPill, Badge, ChoiceChip } from "@/components/ops-ui";
import { IconAlert } from "@/components/icons";
import {
  LIMA_COURIER_CARDS,
  LIMA_FOLDED_STEPS,
  LIMA_STEP_CARDS,
  LIMA_SUB_FILTERS,
  agendaCards,
  type LimaBoardCounts,
  type LimaBoardKey,
  type LimaStep,
} from "@/lib/repro-lima-blocks";
import type { LimaStuckReason } from "@/lib/lima-stuck";

/**
 * El orden del trabajo (owner, 15-11-2026): de lo más urgente a lo que solo se
 * mira. Los seis pasos son una partición (`limaStepOf`): suman el total. Los
 * dos últimos van plegados (`LIMA_FOLDED_STEPS`).
 */
export const LIMA_FLOW: readonly { key: LimaStep; why: string }[] = [
  { key: "novedad", why: "El courier lo tiene en la calle: llama ya." },
  { key: "llamar_despues", why: "A la hora que pidió la clienta." },
  { key: "no_entregados", why: "Acuerda el día y el courier." },
  { key: "por_sacar", why: "Que salga todo: agenda y genera su guía." },
  { key: "con_courier", why: "Solo seguimiento." },
  { key: "por_cerrar", why: "Validar el cobro o anular." },
];

/** Lo que vive dentro de cada paso: sus filtros (el pie de la tarjeta) y cómo se dice en su celda. */
const INSIDE: Partial<Record<LimaStep, { keys: readonly LimaBoardKey[]; note: (c: LimaBoardCounts) => string | null }>> = {
  no_entregados: {
    keys: ["reintentos_aliclik"],
    note: (c) => (c.sub.reintentos_aliclik ? `${fmt(c.sub.reintentos_aliclik)} ${c.sub.reintentos_aliclik === 1 ? "es reintento" : "son reintentos"} Aliclik` : null),
  },
  por_sacar: {
    keys: ["sin_fecha", "mas_de_30"],
    note: (c) => {
      const sinFecha = c.agenda.sin_fecha ?? 0;
      const agendados = c.step.por_sacar - sinFecha;
      return `${fmt(agendados)} ${agendados === 1 ? "agendado" : "agendados"} · ${fmt(sinFecha)} sin fecha`;
    },
  },
  con_courier: {
    keys: ["guia_creada", "en_ruta", "retornando"],
    note: (c) => `${fmt(c.courier.en_ruta)} en ruta · ${fmt(c.courier.guia_creada)} con guía`,
  },
  por_cerrar: {
    keys: ["esperan_anulacion"],
    note: (c) => (c.sub.esperan_anulacion ? `${fmt(c.sub.esperan_anulacion)} ${c.sub.esperan_anulacion === 1 ? "espera" : "esperan"} anulación` : null),
  },
};

/** Un motivo de trabado con su cuenta (§9.6): el tablero los muestra como excepción arriba. */
export interface LimaStuckChip {
  reason: LimaStuckReason;
  count: number;
}

const STEP = new Map(LIMA_STEP_CARDS.map((card) => [card.key, card]));
const COURIER = new Map(LIMA_COURIER_CARDS.map((card) => [card.key, card]));

function fmt(n: number): string {
  return n.toLocaleString("es-PE");
}

/** Lo que dice un filtro de adentro y cuántos tiene. */
function insideChip(key: LimaBoardKey, counts: LimaBoardCounts): { label: string; count: number; hint: string } {
  if (key === "sin_fecha") return { label: "Sin fecha", count: counts.agenda.sin_fecha ?? 0, hint: "Por sacar a reparto y todavía sin día." };
  const courier = COURIER.get(key as never);
  if (courier) return { label: courier.label, count: counts.courier[courier.key], hint: courier.hint };
  const sub = (LIMA_SUB_FILTERS as Record<string, { label: string; hint: string } | undefined>)[key];
  return { label: sub?.label ?? key, count: (counts.sub as Record<string, number>)[key] ?? 0, hint: sub?.hint ?? "" };
}

/** El paso al que pertenece lo elegido: el propio paso o un filtro de adentro. */
function activeStep(active: LimaBoardKey): LimaStep | null {
  if (STEP.has(active as LimaStep)) return active as LimaStep;
  for (const [step, inside] of Object.entries(INSIDE)) if (inside?.keys.includes(active)) return step as LimaStep;
  return null;
}

/** Título del bloque con su total y, debajo, la ayuda: se leen juntos, como en Stripe. */
function BlockHead({ id, title, total, unit, help }: { id: string; title: string; total: number; unit: string; help: string }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 id={id} className="text-base font-semibold tracking-[-0.01em] text-ink-900">{title}</h2>
        <span className="text-[13px] tabular-nums text-ink-500">{fmt(total)} {unit}</span>
      </div>
      <p className="mt-0.5 text-[13px] leading-5 text-ink-500">{help}</p>
    </div>
  );
}

/**
 * Una celda de franja: etiqueta, cifra y una línea de contexto. Elegida, se
 * subraya en azul como una pestaña y la cifra toma el azul (The Cifras Navegan
 * Rule: el filtro activo se ve sin leer). En el teléfono, la de un paso pone la
 * cifra a la derecha y el contexto debajo de la etiqueta; con `stack`, siempre
 * en columna (la Agenda y el courier van de dos en dos).
 */
function Cell({ label, value, note, lead, badge, active, onClick, hint, dim, stack, folded, className }: {
  label: string;
  value: number;
  note?: ReactNode;
  lead?: ReactNode;
  /** Junto a la etiqueta (p. ej. «Empieza aquí»). */
  badge?: ReactNode;
  active: boolean;
  onClick: () => void;
  hint?: string;
  /** Cero: la celda se aclara, pero sigue filtrando. */
  dim?: boolean;
  stack?: boolean;
  /**
   * Plegada: un paso que el equipo solo mira. Más delgada, sobre `wash`, con la
   * etiqueta y la cifra un escalón más chicas y en gris: cuenta para el total
   * sin competir con el trabajo.
   */
  folded?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={hint}
      className={cn(
        "group relative grid min-w-0 content-start items-center gap-x-3 gap-y-1 text-left transition-colors focus-visible:z-10 pointer-coarse:min-h-14",
        folded ? "px-3 py-3" : "px-4 py-3.5",
        stack ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-1",
        active ? "bg-brand-50" : folded ? "bg-wash hover:bg-line/60" : "bg-white hover:bg-wash",
        className,
      )}
    >
      {/* La chapa («Empieza aquí») va junto al nombre en el teléfono y junto a la cifra desde `sm`: así no corta el nombre ni desalinea las cifras de la fila. */}
      <span className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {lead}
        <span className={cn("min-w-0 font-medium", folded ? "text-xs" : "text-[13px]", active ? "text-brand-700" : folded ? "text-ink-500" : "text-ink-600")}>{label}</span>
        {badge ? <span className="sm:hidden">{badge}</span> : null}
      </span>
      <span
        className={cn(
          "font-semibold tabular-nums tracking-[-0.015em]",
          folded ? "text-lg leading-6" : "text-[22px] leading-7",
          stack ? "row-start-2" : "col-start-2 row-span-2 row-start-1 sm:col-start-1 sm:row-span-1 sm:row-start-2",
          active ? "text-brand-700" : dim ? "text-ink-300" : folded ? "text-ink-600" : "text-ink-900",
        )}
      >
        {fmt(value)}
        {badge ? <span className="ml-2 hidden align-[3px] sm:inline-flex">{badge}</span> : null}
      </span>
      {note ? (
        <span className={cn("col-start-1 text-xs leading-4 text-ink-500", stack ? "row-start-3" : "row-start-2 sm:row-start-3")}>{note}</span>
      ) : null}
      {/* La marca de elegido: una barra de 2 px, como la pestaña activa (DESIGN.md «Shapes»). */}
      <span aria-hidden className={cn("absolute inset-x-0 bottom-0 h-0.5", active ? "bg-brand-600" : "bg-transparent")} />
    </button>
  );
}

/** El número del paso: un círculo de 20 px; relleno en azul cuando es el paso elegido. */
function StepNumber({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums",
        active ? "bg-brand-600 text-white" : "bg-white text-ink-600 ring-1 ring-inset ring-line-strong",
      )}
    >
      {n}
    </span>
  );
}

/** La franja: una sola tarjeta con las celdas separadas por líneas finas (no tarjetas sueltas). */
function Strip({ label, cols, children, footer, header }: { label: string; cols: string; children: ReactNode; footer?: ReactNode; header?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
      {header ? <div className="border-b border-line px-4 py-3">{header}</div> : null}
      <div role="group" aria-label={label} className={cn("grid gap-px bg-line", cols)}>
        {children}
      </div>
      {footer ? <div className="flex flex-wrap items-center gap-2 border-t border-line bg-wash/60 px-4 py-2.5">{footer}</div> : null}
    </div>
  );
}

/**
 * La barra de reparto del flujo: un tramo por paso, de ancho proporcional a su
 * cifra y en el mismo orden que las celdas, y al final el total. Hace visible
 * que los pasos suman el total (owner, 15-11-2026). Los pasos del trabajo van
 * en azul; los plegados, en gris. Con un paso elegido, su tramo se marca y los
 * demás se aclaran. Es decorativa para el lector de pantalla: las cifras están
 * en las celdas.
 */
function SumBar({ counts, total, active }: { counts: LimaBoardCounts; total: number; active: LimaStep | null }) {
  return (
    <div className="flex items-center gap-3">
      <div aria-hidden className="flex h-2 min-w-0 flex-1 gap-0.5 overflow-hidden rounded-full bg-line">
        {total > 0 ? LIMA_FLOW.map(({ key }) => {
          const value = counts.step[key];
          if (!value) return null;
          const folded = LIMA_FOLDED_STEPS.has(key);
          const on = active === null || active === key;
          return (
            <span
              key={key}
              title={`${STEP.get(key)!.label}: ${fmt(value)}`}
              style={{ flexGrow: value, flexBasis: 0 }}
              className={cn(
                "min-w-1 transition-colors",
                folded
                  ? (active === key ? "bg-ink-600" : on ? "bg-ink-300" : "bg-line-strong")
                  : (active === key ? "bg-brand-700" : on ? "bg-brand-500" : "bg-brand-200"),
              )}
            />
          );
        }) : null}
      </div>
      <span className="shrink-0 text-[13px] tabular-nums text-ink-600">
        = <b className="font-semibold text-ink-900">{fmt(total)}</b> pedidos
      </span>
    </div>
  );
}

export function ReproLimaBlocks({ counts, today, active, onPick }: {
  counts: LimaBoardCounts;
  today: string;
  /** El filtro elegido; «todos» sin ninguno. */
  active: LimaBoardKey;
  onPick: (key: LimaBoardKey) => void;
}) {
  const agenda = agendaCards(today);
  const flowTotal = LIMA_FLOW.reduce((sum, step) => sum + counts.step[step.key], 0);
  const agendaTotal = agenda.reduce((sum, card) => sum + (counts.agenda[card.key] ?? 0), 0);
  // «Empieza aquí»: el primer paso del trabajo con algo que hacer (los plegados solo se miran).
  const start = LIMA_FLOW.find((step) => !LIMA_FOLDED_STEPS.has(step.key) && counts.step[step.key] > 0)?.key ?? null;
  const step = activeStep(active);
  const inside = step ? INSIDE[step] : undefined;
  const stepCard = step ? STEP.get(step) : undefined;
  const sinGuia = { hoy: counts.sub.hoy_sin_guia, manana: counts.sub.manana_sin_guia } as Record<string, number>;

  return (
    <div className="space-y-7">
      <section aria-labelledby="repro-flujo" className="space-y-3">
        <BlockHead
          id="repro-flujo"
          title="Flujo del día"
          total={flowTotal}
          unit="pedidos"
          help="Cada pedido está en un solo paso: los seis suman el total. Del 1 al 4, el trabajo del equipo, de izquierda a derecha; «Con el courier» y «Por cerrar» van plegados al final porque solo se miran."
        />
        <Strip
          label="Flujo del día"
          header={<SumBar counts={counts} total={flowTotal} active={step} />}
          cols="grid-cols-2 sm:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,0.66fr)_minmax(0,0.66fr)]"
          footer={stepCard && inside ? (
            <>
              <span className="text-[13px] text-ink-600">
                Dentro de <b className="font-semibold text-ink-900">{stepCard.label}</b>:
              </span>
              <ChoiceChip
                label={`Todos (${stepCard.label.toLowerCase()})`}
                count={counts.step[stepCard.key]}
                active={active === stepCard.key}
                title={stepCard.hint}
                onClick={() => { if (active !== stepCard.key) onPick(stepCard.key); }}
              />
              {inside.keys.map((key) => {
                const chip = insideChip(key, counts);
                return (
                  <ChoiceChip
                    key={key}
                    label={chip.label}
                    count={chip.count}
                    active={active === key}
                    title={chip.hint}
                    onClick={() => onPick(active === key ? stepCard.key : key)}
                  />
                );
              })}
            </>
          ) : null}
        >
          {LIMA_FLOW.map((flow, i) => {
            const card = STEP.get(flow.key)!;
            const value = counts.step[flow.key];
            const isActive = step === flow.key;
            const folded = LIMA_FOLDED_STEPS.has(flow.key);
            return (
              <Cell
                key={flow.key}
                label={card.label}
                value={value}
                dim={value === 0}
                active={isActive}
                onClick={() => onPick(flow.key)}
                hint={card.hint}
                folded={folded}
                stack={folded}
                // El trabajo ocupa la fila entera en el teléfono; los dos plegados van de a dos. Una línea más
                // marcada separa el trabajo de lo que solo se mira.
                className={folded ? (flow.key === "con_courier" ? "sm:shadow-[inset_1px_0_0_var(--color-line-strong)]" : undefined) : "col-span-2 sm:col-span-1"}
                lead={folded ? undefined : <StepNumber n={i + 1} active={isActive} />}
                badge={start === flow.key && !isActive ? <Badge tone="brand" className="shrink-0">Empieza aquí</Badge> : null}
                note={INSIDE[flow.key]?.note(counts) ?? flow.why}
              />
            );
          })}
        </Strip>
      </section>

      <section aria-labelledby="repro-agenda" className="space-y-3">
        <BlockHead
          id="repro-agenda"
          title="Agenda"
          total={agendaTotal}
          unit="pedidos"
          help="El día en que sale: lo acordado con la clienta, «Programar envío», el programa o el recojo del courier; «Sin fecha», lo que falta sacar y no tiene día. No suma el total: un no entregado sin acuerdo o lo que el courier ya lleva no tiene día. Hoy y Mañana dicen cuáles tienen guía; los que no, son una alerta."
        />
        <Strip
          label="Agenda"
          cols="grid-cols-2 sm:grid-cols-4"
          footer={counts.sub.hoy_sin_guia + counts.sub.manana_sin_guia + counts.sub.reprogramados > 0 || ["hoy_sin_guia", "manana_sin_guia", "reprogramados"].includes(active) ? (
            <>
              {(["hoy_sin_guia", "manana_sin_guia"] as const).filter((key) => counts.sub[key] > 0 || active === key).map((key) => (
                <AttentionPill
                  key={key}
                  icon={IconAlert}
                  label={LIMA_SUB_FILTERS[key].label}
                  count={counts.sub[key]}
                  active={active === key}
                  hint={LIMA_SUB_FILTERS[key].hint}
                  onClick={() => onPick(active === key ? "todos" : key)}
                />
              ))}
              {(counts.sub.reprogramados > 0 || active === "reprogramados") && (
                <ChoiceChip
                  label={LIMA_SUB_FILTERS.reprogramados.label}
                  count={counts.sub.reprogramados}
                  active={active === "reprogramados"}
                  title={LIMA_SUB_FILTERS.reprogramados.hint}
                  onClick={() => onPick(active === "reprogramados" ? "todos" : "reprogramados")}
                />
              )}
            </>
          ) : null}
        >
          {agenda.map((card) => {
            const value = counts.agenda[card.key] ?? 0;
            const missing = sinGuia[card.key];
            return (
              <Cell
                key={card.key}
                label={card.label}
                value={value}
                dim={value === 0}
                active={active === card.key}
                hint={card.hint}
                onClick={() => onPick(card.key)}
                stack
                note={missing === undefined || value === 0 ? undefined : (
                  <>
                    {fmt(value - missing)} con guía ·{" "}
                    <span className={missing > 0 ? "font-semibold text-warn-fg" : undefined}>{fmt(missing)} sin guía</span>
                  </>
                )}
              />
            );
          })}
        </Strip>
      </section>
    </div>
  );
}
