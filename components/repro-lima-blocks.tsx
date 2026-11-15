"use client";

// Los tres bloques de Repro Lima (owner, 15-11-2026; MOM §9.5).
//
// «FLUJO DEL DÍA» Y NO «POR GESTIONAR HOY» (owner, 15-11-2026, segunda vuelta):
// «la suma de Reintentos Aliclik 111 más los dos de su derecha no suman 184 …
// aquí falta ordenar un flujo de trabajo». Los chips sueltos debajo de la fila
// se leían como partes de la primera tarjeta. Ahora:
// - las cinco tareas son PASOS numerados, en el orden en que el equipo las
//   trabaja: primero lo que está en la calle, después lo que tiene hora, lo que
//   falló, lo nuevo y al final lo administrativo. El número es información (el
//   orden del trabajo), no adorno;
// - lo que vive DENTRO de un paso (Reintentos Aliclik, Más de 30 días, Esperan
//   anulación) se dice dentro de su celda («111 son reintentos Aliclik») y su
//   filtro aparece en el pie de ESA tarjeta solo cuando el paso está elegido,
//   con su nombre delante: ya no hay chips que parezcan sumarse a otra cifra.
// Cada cifra sigue siendo un filtro de la única lista de abajo (The Cifras
// Navegan Rule). Solo dibuja: las cuentas salen de lib/repro-lima-blocks.ts.
import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { Badge, ChoiceChip } from "@/components/ops-ui";
import {
  LIMA_COURIER_CARDS,
  LIMA_SUB_FILTERS,
  LIMA_TASK_CARDS,
  agendaCards,
  type LimaBoardCounts,
  type LimaBoardKey,
  type LimaSubFilter,
  type LimaTask,
} from "@/lib/repro-lima-blocks";
import type { LimaStuckReason } from "@/lib/lima-stuck";

/**
 * El orden del trabajo (owner, 15-11-2026): de lo más urgente a lo
 * administrativo. La clasificación de cada pedido en una sola tarea sigue en
 * `limaTaskOf`; esto es solo el orden en que se presentan.
 */
export const LIMA_FLOW: readonly { key: LimaTask; why: string }[] = [
  { key: "novedad", why: "El courier lo tiene en la calle: llama ya." },
  { key: "llamar_despues", why: "A la hora que pidió la clienta." },
  { key: "no_entregados", why: "Acuerda el día y el courier." },
  { key: "primer_despacho", why: "Confirma los datos y agenda." },
  { key: "por_cerrar", why: "Cierra en Kapta lo que ya terminó." },
];

/** Lo que vive dentro de cada paso, y cómo se dice en su celda. */
const INSIDE: Partial<Record<LimaTask, { sub: LimaSubFilter; phrase: (n: number) => string }>> = {
  no_entregados: { sub: "reintentos_aliclik", phrase: (n) => `${fmt(n)} ${n === 1 ? "es reintento" : "son reintentos"} Aliclik` },
  primer_despacho: { sub: "mas_de_30", phrase: (n) => `${fmt(n)} con más de 30 días` },
  por_cerrar: { sub: "esperan_anulacion", phrase: (n) => `${fmt(n)} ${n === 1 ? "espera" : "esperan"} anulación` },
};

/** Un motivo de trabado con su cuenta (§9.6): el tablero los muestra como excepción arriba. */
export interface LimaStuckChip {
  reason: LimaStuckReason;
  count: number;
}

const TASK = new Map(LIMA_TASK_CARDS.map((card) => [card.key, card]));

function fmt(n: number): string {
  return n.toLocaleString("es-PE");
}

/** El paso al que pertenece lo elegido: el propio paso o un filtro de adentro. */
function activeStep(active: LimaBoardKey): LimaTask | null {
  if (TASK.has(active as LimaTask)) return active as LimaTask;
  const parent = (LIMA_SUB_FILTERS as Record<string, { parent: string } | undefined>)[active]?.parent;
  return parent && TASK.has(parent as LimaTask) ? (parent as LimaTask) : null;
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
function Cell({ label, value, note, lead, badge, active, onClick, hint, dim, stack }: {
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
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={hint}
      className={cn(
        "group relative grid min-w-0 content-start items-center gap-x-3 gap-y-1 px-4 py-3.5 text-left transition-colors focus-visible:z-10 pointer-coarse:min-h-14",
        stack ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-1",
        active ? "bg-brand-50" : "bg-white hover:bg-wash",
      )}
    >
      <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
        {lead}
        <span className={cn("truncate text-[13px] font-medium", active ? "text-brand-700" : "text-ink-600")}>{label}</span>
        {badge}
      </span>
      <span
        className={cn(
          "text-[22px] font-semibold leading-7 tabular-nums tracking-[-0.015em]",
          stack ? "row-start-2" : "col-start-2 row-span-2 row-start-1 sm:col-start-1 sm:row-span-1 sm:row-start-2",
          active ? "text-brand-700" : dim ? "text-ink-300" : "text-ink-900",
        )}
      >
        {fmt(value)}
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
function Strip({ label, cols, children, footer }: { label: string; cols: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
      <div role="group" aria-label={label} className={cn("grid gap-px bg-line", cols)}>
        {children}
      </div>
      {footer ? <div className="flex flex-wrap items-center gap-2 border-t border-line bg-wash/60 px-4 py-2.5">{footer}</div> : null}
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
  const agenda = agendaCards(today, counts.agenda);
  const flowTotal = LIMA_FLOW.reduce((sum, step) => sum + counts.task[step.key], 0);
  const agendaTotal = agenda.reduce((sum, card) => sum + (counts.agenda[card.key] ?? 0), 0);
  const courierTotal = LIMA_COURIER_CARDS.reduce((sum, card) => sum + counts.courier[card.key], 0);
  // «Empieza aquí»: el primer paso con algo que hacer, para que nadie tenga que decidir por dónde.
  const start = LIMA_FLOW.find((step) => counts.task[step.key] > 0)?.key ?? null;
  const step = activeStep(active);
  const inside = step ? INSIDE[step] : undefined;
  const stepCard = step ? TASK.get(step) : undefined;

  return (
    <div className="space-y-7">
      <section aria-labelledby="repro-flujo" className="space-y-3">
        <BlockHead
          id="repro-flujo"
          title="Flujo del día"
          total={flowTotal}
          unit="por gestionar"
          help="De izquierda a derecha: de lo que está en la calle a lo que solo falta cerrar. Cada pedido está en un solo paso."
        />
        <Strip
          label="Flujo del día"
          cols="grid-cols-1 sm:grid-cols-5"
          footer={stepCard && inside ? (
            <>
              <span className="text-[13px] text-ink-600">
                Dentro de <b className="font-semibold text-ink-900">{stepCard.label}</b>:
              </span>
              <ChoiceChip
                label={`Todos (${stepCard.label.toLowerCase()})`}
                count={counts.task[stepCard.key]}
                active={active === stepCard.key}
                title={stepCard.hint}
                onClick={() => { if (active !== stepCard.key) onPick(stepCard.key); }}
              />
              <ChoiceChip
                label={LIMA_SUB_FILTERS[inside.sub].label}
                count={counts.sub[inside.sub]}
                active={active === inside.sub}
                title={LIMA_SUB_FILTERS[inside.sub].hint}
                onClick={() => onPick(active === inside.sub ? stepCard.key : inside.sub)}
              />
            </>
          ) : null}
        >
          {LIMA_FLOW.map((flow, i) => {
            const card = TASK.get(flow.key)!;
            const value = counts.task[flow.key];
            const isActive = step === flow.key;
            const sub = INSIDE[flow.key];
            const subCount = sub ? counts.sub[sub.sub] : 0;
            return (
              <Cell
                key={flow.key}
                label={card.label}
                value={value}
                dim={value === 0}
                active={isActive}
                onClick={() => onPick(flow.key)}
                hint={card.hint}
                lead={<StepNumber n={i + 1} active={isActive} />}
                badge={start === flow.key && !isActive ? <Badge tone="brand" className="shrink-0">Empieza aquí</Badge> : null}
                note={sub && subCount > 0 ? sub.phrase(subCount) : flow.why}
              />
            );
          })}
        </Strip>
      </section>

      <div className="grid gap-7 2xl:grid-cols-[minmax(0,8fr)_minmax(0,3fr)] 2xl:gap-5">
        <section aria-labelledby="repro-agenda" className="min-w-0 space-y-3">
          <BlockHead
            id="repro-agenda"
            title="Agenda"
            total={agendaTotal}
            unit="pedidos"
            help="El día en que sale: lo acordado con la clienta, «Programar envío», el programa o el recojo del courier."
          />
          <Strip
            label="Agenda"
            cols="grid-cols-2 sm:grid-cols-4 xl:grid-cols-8"
            footer={counts.sub.reprogramados > 0 || active === "reprogramados" ? (
              <>
                <span className="text-[13px] text-ink-600">Filtrar la agenda:</span>
                <ChoiceChip
                  label={LIMA_SUB_FILTERS.reprogramados.label}
                  count={counts.sub.reprogramados}
                  active={active === "reprogramados"}
                  title={LIMA_SUB_FILTERS.reprogramados.hint}
                  onClick={() => onPick(active === "reprogramados" ? "todos" : "reprogramados")}
                />
              </>
            ) : null}
          >
            {agenda.map((card) => {
              const value = counts.agenda[card.key] ?? 0;
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
                />
              );
            })}
          </Strip>
        </section>

        <section aria-labelledby="repro-courier" className="min-w-0 space-y-3">
          <BlockHead
            id="repro-courier"
            title="En manos del courier"
            total={courierTotal}
            unit="en seguimiento"
            help="Solo se mira: con la guía viva de un courier."
          />
          <Strip label="En manos del courier" cols="grid-cols-3">
            {LIMA_COURIER_CARDS.map((card) => {
              const value = counts.courier[card.key];
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
                />
              );
            })}
          </Strip>
        </section>
      </div>
    </div>
  );
}
