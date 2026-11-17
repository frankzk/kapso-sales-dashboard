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
// - «Programados» es un paso del flujo (16-11-2026: «un programado es un
//   programado»), con sus días dentro (Hoy, Mañana, Después) y las alertas de
//   lo que sale hoy o mañana sin guía. Ya no hay un bloque aparte.
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
  LIMA_STEP_PARTS,
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
  { key: "por_sacar", why: "Sin día: agéndalos." },
  { key: "programados", why: "Que salgan: genera su guía." },
  { key: "con_courier", why: "Solo seguimiento." },
  { key: "por_cerrar", why: "Validar el cobro o anular." },
];

/**
 * Lo que vive dentro de cada paso: sus filtros (el pie de la tarjeta) y cómo se
 * dice en su celda. En «No entregados» y «Sacar a reparto» son sus partes
 * (`LIMA_STEP_PARTS`): se reparten el paso y suman su cifra (owner,
 * 16-11-2026: «en el desglose dentro la suma de las partes no da 216»). La nota
 * nombra solo las partes con pedidos, en el mismo orden que los chips.
 */
const partsNote = (c: LimaBoardCounts, parts: readonly [number, string][]): string | null => {
  const named = parts.filter(([n]) => n > 0).map(([n, text]) => `${fmt(n)} ${text}`);
  return named.length ? named.join(" · ") : null;
};

const INSIDE: Partial<Record<LimaStep, { keys: readonly LimaBoardKey[]; note: (c: LimaBoardCounts) => string | null }>> = {
  no_entregados: {
    keys: LIMA_STEP_PARTS.no_entregados ?? [],
    note: (c) => partsNote(c, [
      [c.sub.por_acordar, "por acordar"],
      [c.sub.reintentos_aliclik, "reintentos Aliclik"],
      [c.courier.retornando, "retornando"],
      [c.sub.sin_reporte, "sin reporte"],
    ]),
  },
  por_sacar: {
    keys: LIMA_STEP_PARTS.por_sacar ?? [],
    note: (c) => partsNote(c, [
      [c.sub.guia_sin_recoger, "sin recoger"],
      [c.sub.nunca_salieron, "nunca salieron"],
      [c.sub.mas_de_30, "de más de 30 días"],
      [c.sub.salieron_sin_dia, "ya salieron, sin día"],
    ]),
  },
  // Sus días son sus partes; lo de hoy y mañana sin guía va en la celda como alerta (`programadosNote`).
  programados: {
    keys: LIMA_STEP_PARTS.programados ?? [],
    note: (c) => partsNote(c, [
      [c.agenda.hoy ?? 0, "hoy"],
      [c.agenda.manana ?? 0, "mañana"],
      [c.agenda.despues ?? 0, "después"],
    ]),
  },
  con_courier: {
    keys: ["guia_creada", "en_ruta"],
    // La fecha de la ruta (owner, 15-11-2026): cuántos salieron hoy y cuántos son de la ruta anterior.
    note: (c) => {
      const antes = c.courier.en_ruta - c.enRutaHoy;
      const ruta = [c.enRutaHoy ? `${fmt(c.enRutaHoy)} hoy` : null, antes ? `${fmt(antes)} anterior` : null].filter(Boolean).join(" · ");
      const parts = [ruta ? `En ruta: ${ruta}` : null, c.courier.guia_creada ? `${fmt(c.courier.guia_creada)} con guía` : null].filter(Boolean);
      return parts.length ? parts.join(" · ") : null;
    },
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

/**
 * El matiz de cada paso (owner, 16-11-2026: «mejorar la paleta para hacer
 * contrastes entre las secciones»). Los pasos son una clasificación, no
 * estados: llevan los matices de `CategoryTone` (DESIGN.md), sin rojo ni verde.
 * El mismo matiz va en el número, el tramo de la barra de reparto, la celda
 * elegida y la cabecera de la lista: la fila de pasos es la leyenda.
 * Clases literales para que Tailwind las vea.
 */
export const STEP_TONE: Record<LimaStep, {
  /** Tramo de la barra de reparto; apagado, cuando hay otro paso elegido. */
  seg: string; segDim: string;
  /** Número del paso: en reposo y elegido (texto blanco sobre el 700: 4.5:1 o más). */
  num: string; numOn: string;
  /** Celda elegida: fondo, texto y barra de 2 px. */
  on: string; text: string; bar: string;
  /** Punto y banda de la cabecera de la lista. */
  dot: string; band: string;
}> = {
  novedad: { seg: "bg-orange-500", segDim: "bg-orange-200", num: "bg-orange-50 text-orange-800 ring-orange-200", numOn: "bg-orange-700 text-white ring-orange-700", on: "bg-orange-50", text: "text-orange-800", bar: "bg-orange-700", dot: "bg-orange-500", band: "bg-orange-50/70" },
  llamar_despues: { seg: "bg-sky-500", segDim: "bg-sky-200", num: "bg-sky-50 text-sky-800 ring-sky-200", numOn: "bg-sky-700 text-white ring-sky-700", on: "bg-sky-50", text: "text-sky-800", bar: "bg-sky-700", dot: "bg-sky-500", band: "bg-sky-50/70" },
  no_entregados: { seg: "bg-indigo-500", segDim: "bg-indigo-200", num: "bg-indigo-50 text-indigo-800 ring-indigo-200", numOn: "bg-indigo-700 text-white ring-indigo-700", on: "bg-indigo-50", text: "text-indigo-800", bar: "bg-indigo-700", dot: "bg-indigo-500", band: "bg-indigo-50/70" },
  programados: { seg: "bg-violet-500", segDim: "bg-violet-200", num: "bg-violet-50 text-violet-800 ring-violet-200", numOn: "bg-violet-700 text-white ring-violet-700", on: "bg-violet-50", text: "text-violet-800", bar: "bg-violet-700", dot: "bg-violet-500", band: "bg-violet-50/70" },
  por_sacar: { seg: "bg-teal-500", segDim: "bg-teal-200", num: "bg-teal-50 text-teal-800 ring-teal-200", numOn: "bg-teal-700 text-white ring-teal-700", on: "bg-teal-50", text: "text-teal-800", bar: "bg-teal-700", dot: "bg-teal-500", band: "bg-teal-50/70" },
  con_courier: { seg: "bg-slate-400", segDim: "bg-slate-200", num: "bg-slate-50 text-slate-700 ring-slate-200", numOn: "bg-slate-700 text-white ring-slate-700", on: "bg-slate-100", text: "text-slate-800", bar: "bg-slate-600", dot: "bg-slate-400", band: "bg-slate-100/70" },
  por_cerrar: { seg: "bg-slate-300", segDim: "bg-slate-100", num: "bg-slate-50 text-slate-700 ring-slate-200", numOn: "bg-slate-700 text-white ring-slate-700", on: "bg-slate-100", text: "text-slate-800", bar: "bg-slate-600", dot: "bg-slate-300", band: "bg-slate-100/70" },
};
const COURIER = new Map(LIMA_COURIER_CARDS.map((card) => [card.key, card]));

function fmt(n: number): string {
  return n.toLocaleString("es-PE");
}

/** El contexto de un paso con sus trabados al final, en `warn-fg`: «1 agendado · 2 sin fecha · 3 trabados». */
function withStuck(note: ReactNode, n: number): ReactNode {
  if (!n) return note;
  return (
    <>
      {note}
      {note ? " · " : null}
      <span className="font-semibold text-warn-fg">{fmt(n)} {n === 1 ? "trabado" : "trabados"}</span>
    </>
  );
}

/** La celda de «Programados»: sus días y, en `warn-fg`, lo que sale hoy o mañana sin guía. */
function programadosNote(days: string | null, sinGuia: number): ReactNode {
  if (!sinGuia) return days;
  return (
    <>
      {days}
      {days ? " · " : null}
      <span className="font-semibold text-warn-fg">{fmt(sinGuia)} sin guía</span>
    </>
  );
}

/** Lo que dice un filtro de adentro y cuántos tiene. */
function insideChip(key: LimaBoardKey, counts: LimaBoardCounts, today: string): { label: string; count: number; hint: string } {
  const day = agendaCards(today).find((card) => card.key === key);
  if (day) return { label: day.label, count: counts.agenda[day.key] ?? 0, hint: day.hint };
  const courier = COURIER.get(key as never);
  if (courier) return { label: courier.label, count: counts.courier[courier.key], hint: courier.hint };
  const sub = (LIMA_SUB_FILTERS as Record<string, { label: string; hint: string } | undefined>)[key];
  return { label: sub?.label ?? key, count: (counts.sub as Record<string, number>)[key] ?? 0, hint: sub?.hint ?? "" };
}

/** El paso al que pertenece lo elegido: el propio paso o un filtro de adentro (la lista toma su matiz). */
export function activeStep(active: LimaBoardKey): LimaStep | null {
  if (STEP.has(active as LimaStep)) return active as LimaStep;
  for (const [step, inside] of Object.entries(INSIDE)) if (inside?.keys.includes(active)) return step as LimaStep;
  // Las alertas y los reprogramados viven dentro de «Programados».
  if (active === "hoy_sin_guia" || active === "manana_sin_guia" || active === "reprogramados") return "programados";
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
function Cell({ label, value, note, lead, badge, active, onClick, hint, dim, stack, folded, className, tone }: {
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
  /** El matiz del paso (`STEP_TONE`): la celda elegida lo toma en vez del azul de la marca. */
  tone?: (typeof STEP_TONE)[LimaStep];
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
        active ? tone?.on ?? "bg-brand-50" : folded ? "bg-wash hover:bg-line/60" : "bg-white hover:bg-wash",
        className,
      )}
    >
      {/* La chapa («Empieza aquí») va junto al nombre en el teléfono y junto a la cifra desde `sm`: así no corta el nombre ni desalinea las cifras de la fila. */}
      <span className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {lead}
        <span className={cn("min-w-0 font-medium", folded ? "text-xs" : "text-[13px]", active ? tone?.text ?? "text-brand-700" : folded ? "text-ink-500" : "text-ink-600")}>{label}</span>
        {badge ? <span className="sm:hidden">{badge}</span> : null}
      </span>
      <span
        className={cn(
          "font-semibold tabular-nums tracking-[-0.015em]",
          folded ? "text-lg leading-6" : "text-[22px] leading-7",
          stack ? "row-start-2" : "col-start-2 row-span-2 row-start-1 sm:col-start-1 sm:row-span-1 sm:row-start-2",
          active ? tone?.text ?? "text-brand-700" : dim ? "text-ink-300" : folded ? "text-ink-600" : "text-ink-900",
        )}
      >
        {fmt(value)}
        {badge ? <span className="ml-2 hidden align-[3px] sm:inline-flex">{badge}</span> : null}
      </span>
      {note ? (
        <span className={cn("col-start-1 text-xs leading-4 text-ink-500", stack ? "row-start-3" : "row-start-2 sm:row-start-3")}>{note}</span>
      ) : null}
      {/* La marca de elegido: una barra de 2 px, como la pestaña activa (DESIGN.md «Shapes»). */}
      <span aria-hidden className={cn("absolute inset-x-0 bottom-0 h-0.5", active ? tone?.bar ?? "bg-brand-600" : "bg-transparent")} />
    </button>
  );
}

/** El número del paso: un círculo de 20 px; relleno en azul cuando es el paso elegido. */
function StepNumber({ n, active, tone }: { n: number; active: boolean; tone: (typeof STEP_TONE)[LimaStep] }) {
  return (
    <span
      aria-hidden
      className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums ring-1 ring-inset", active ? tone.numOn : tone.num)}
    >
      {n}
    </span>
  );
}

/** La franja: una sola tarjeta con las celdas separadas por líneas finas (no tarjetas sueltas). */
function Strip({ label, cols, children, footer, header }: { label: string; cols: string; children: ReactNode; footer?: ReactNode; header?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line-strong/70">
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
          const on = active === null || active === key;
          return (
            <span
              key={key}
              title={`${STEP.get(key)!.label}: ${fmt(value)}`}
              style={{ flexGrow: value, flexBasis: 0 }}
              className={cn("min-w-1 transition-colors", on ? STEP_TONE[key].seg : STEP_TONE[key].segDim)}
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

export function ReproLimaBlocks({ counts, today, active, onPick, guideAlert = true, stuck, callsDue = 0 }: {
  counts: LimaBoardCounts;
  today: string;
  /** El filtro elegido; «todos» sin ninguno. */
  active: LimaBoardKey;
  onPick: (key: LimaBoardKey) => void;
  /** «Hoy sin guía» es alerta desde las 10:30 de Lima (`hoySinGuiaAlert`); antes se cuenta sin alarmar. */
  guideAlert?: boolean;
  /**
   * Los trabados (§9.6) viven dentro de su paso (owner, 15-11-2026): cuántos
   * tiene cada paso, si el filtro «Trabados» está puesto y cómo se elige.
   */
  stuck?: { byStep: Readonly<Record<LimaStep, number>>; active: boolean; onPick: (step: LimaStep) => void };
  /** «Llamar después» cuya hora ya llegó (`callDue`): la celda lo dice en rojo. */
  callsDue?: number;
}) {
  const agenda = agendaCards(today);
  const flowTotal = LIMA_FLOW.reduce((sum, step) => sum + counts.step[step.key], 0);
  // «Empieza aquí»: el primer paso del trabajo con algo que hacer (los plegados solo se miran).
  const start = LIMA_FLOW.find((step) => !LIMA_FOLDED_STEPS.has(step.key) && counts.step[step.key] > 0)?.key ?? null;
  const step = activeStep(active);
  const inside = step ? INSIDE[step] : undefined;
  const stepCard = step ? STEP.get(step) : undefined;
  const dayKeys = new Set(agenda.map((card) => card.key));
  // Lo de hoy (desde las 10:30) y mañana sin guía ni rótulo: la alerta de «Programados».
  // Lo de mañana que creará la automática está en el filtro pero no alarma.
  const mananaSinAuto = counts.sub.manana_sin_guia - counts.autoGuideManana;
  const sinGuiaAlarm = (guideAlert ? counts.sub.hoy_sin_guia : 0) + mananaSinAuto;
  const stuckIn = (key: LimaStep) => stuck?.byStep[key] ?? 0;
  const stepStuck = step ? stuckIn(step) : 0;
  const stuckOn = Boolean(stuck?.active && step);

  return (
    <div className="space-y-7">
      <section aria-labelledby="repro-flujo" className="space-y-3">
        <BlockHead
          id="repro-flujo"
          title="Flujo del día"
          total={flowTotal}
          unit="pedidos"
          help="Cada pedido está en un solo paso: los siete suman el total. Del 1 al 5, el trabajo del equipo, de izquierda a derecha: lo que no tiene día está en No entregados y Sacar a reparto; con su día pasa a Programados. «Con el courier» y «Por cerrar» van plegados al final porque solo se miran."
        />
        <Strip
          label="Flujo del día"
          header={<SumBar counts={counts} total={flowTotal} active={step} />}
          cols="grid-cols-2 sm:grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,0.66fr)_minmax(0,0.66fr)]"
          footer={stepCard && (inside || stepStuck > 0 || stuckOn) ? (
            <>
              <span className="text-[13px] text-ink-600">
                Dentro de <b className="font-semibold text-ink-900">{stepCard.label}</b>:
              </span>
              <ChoiceChip
                label={`Todos (${stepCard.label.toLowerCase()})`}
                count={counts.step[stepCard.key]}
                active={active === stepCard.key && !stuckOn}
                title={stepCard.hint}
                onClick={() => { if (active !== stepCard.key || stuckOn) onPick(stepCard.key); }}
              />
              {(inside?.keys ?? []).filter((key) => stepCard.key !== "programados" || dayKeys.has(key)).map((key) => {
                const chip = insideChip(key, counts, today);
                return (
                  <ChoiceChip
                    key={key}
                    label={chip.label}
                    count={chip.count}
                    active={active === key && !stuckOn}
                    title={chip.hint}
                    onClick={() => onPick(active === key && !stuckOn ? stepCard.key : key)}
                  />
                );
              })}
              {stepCard.key === "programados" && (
                <>
                  {(["hoy_sin_guia", "manana_sin_guia"] as const).filter((key) => (key !== "hoy_sin_guia" || dayKeys.has("hoy")) && (counts.sub[key] > 0 || active === key)).map((key) =>
                    (key === "hoy_sin_guia" && !guideAlert) || (key === "manana_sin_guia" && mananaSinAuto === 0) ? (
                      // Antes de las 10:30, lo de hoy sin guía todavía puede recibirla: se filtra, pero no alarma.
                      <ChoiceChip
                        key={key}
                        label={LIMA_SUB_FILTERS[key].label}
                        count={counts.sub[key]}
                        active={active === key && !stuckOn}
                        title={key === "hoy_sin_guia" ? `${LIMA_SUB_FILTERS[key].hint} Es alerta desde las 10:30.` : `${LIMA_SUB_FILTERS[key].hint} Todos los crea la automática.`}
                        onClick={() => onPick(active === key && !stuckOn ? "programados" : key)}
                      />
                    ) : (
                      <AttentionPill
                        key={key}
                        icon={IconAlert}
                        label={LIMA_SUB_FILTERS[key].label}
                        count={counts.sub[key]}
                        active={active === key && !stuckOn}
                        hint={LIMA_SUB_FILTERS[key].hint}
                        onClick={() => onPick(active === key && !stuckOn ? "programados" : key)}
                      />
                    ),
                  )}
                  {/* Dentro de «Mañana sin guía»: los que creará la pasada automática no alarman (owner, 15 y 17-11-2026). */}
                  {counts.autoGuideManana > 0 && (
                    <span className="text-[13px] text-ink-500">
                      {counts.autoGuideManana === counts.sub.manana_sin_guia
                        ? `${counts.autoGuideManana === 1 ? "la crea" : "todas las crea"} la automática`
                        : `de ellas, ${fmt(counts.autoGuideManana)} ${counts.autoGuideManana === 1 ? "la crea" : "las crea"} la automática`}
                    </span>
                  )}
                  {(counts.sub.reprogramados > 0 || active === "reprogramados") && (
                    <ChoiceChip
                      label={LIMA_SUB_FILTERS.reprogramados.label}
                      count={counts.sub.reprogramados}
                      active={active === "reprogramados" && !stuckOn}
                      title={LIMA_SUB_FILTERS.reprogramados.hint}
                      onClick={() => onPick(active === "reprogramados" && !stuckOn ? "programados" : "reprogramados")}
                    />
                  )}
                </>
              )}
              {stuck && (stepStuck > 0 || stuckOn) && (
                <AttentionPill
                  icon={IconAlert}
                  label="Trabados"
                  count={stepStuck}
                  active={stuckOn}
                  hint="Pedidos de este paso quietos más de lo que deberían, lo que más lleva primero (§9.6). La fila dice el motivo y el siguiente paso."
                  onClick={() => stuck.onPick(stepCard.key)}
                />
              )}
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
                tone={STEP_TONE[flow.key]}
                // El trabajo ocupa la fila entera en el teléfono; los dos plegados van de a dos. Una línea más
                // marcada separa el trabajo de lo que solo se mira.
                className={folded ? (flow.key === "con_courier" ? "sm:shadow-[inset_1px_0_0_var(--color-line-strong)]" : undefined) : "col-span-2 sm:col-span-1"}
                // El plegado lleva un punto de su matiz (la leyenda de la barra); el trabajo, su número.
                lead={folded ? <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STEP_TONE[flow.key].dot)} /> : <StepNumber n={i + 1} active={isActive} tone={STEP_TONE[flow.key]} />}
                badge={start === flow.key && !isActive ? <Badge tone="brand" className="shrink-0">Empieza aquí</Badge> : null}
                note={withStuck(
                  flow.key === "llamar_despues" && callsDue > 0
                    ? <span className="font-semibold text-warn-fg">{fmt(callsDue)} {callsDue === 1 ? "ya toca" : "ya tocan"}</span>
                    : flow.key === "programados"
                      ? programadosNote(INSIDE.programados?.note(counts) ?? null, sinGuiaAlarm) ?? flow.why
                      : INSIDE[flow.key]?.note(counts) ?? flow.why,
                  stuckIn(flow.key),
                )}
              />
            );
          })}
        </Strip>
      </section>

    </div>
  );
}
