"use client";

// «Todos» de Repro Lima (MOM §9.5, 14-10-2026): los pedidos de Lima sin estado
// final, por macroetapa y subetapa del Master, con sus nombres
// (lib/order-macro-stage.ts). No es una lista de casos ni crea estados: las
// cifras y los enlaces vienen hechos en `limaOpenBreakdown`
// (lib/repro-lima-todos.ts).
//
// Dos bloques: «Todavía por entregar» (lo que cuenta la tarjeta) y «Ya
// entregado, anulado o devuelto: falta cerrar», abierto y con su total, para no
// perder de vista las cajas que siguen afuera. Desde 1024 px, uno al lado del
// otro.
//
// Cada subetapa abre su cola del Master (etapa, subetapa, cobertura «Lima» y
// tienda): son enlaces a colas, no a pedidos, así que no pasan por la ficha
// (E31). «Por reprogramar Lima» no sale de la pantalla: abre las cuatro listas.
// Las chapas de antigüedad son texto, no filtros: el Master no filtra por días
// en la etapa. Líneas finas, sin tarjeta dentro de tarjeta (E33); funciona a
// 360 px.

import Link from "next/link";
import { cn } from "@/components/ui";
import { Badge, ChoiceChip } from "@/components/ops-ui";
import { IconChevronRight } from "@/components/icons";
import { MacroStageDot } from "@/components/order-master-shared";
import type { ReproList } from "@/lib/repro-lima";
import type { TodosBreakdown, TodosStage, TodosSubstage } from "@/lib/repro-lima-todos";

type ListCount = { list: ReproList; label: string; count: number };

const fmt = (n: number) => n.toLocaleString("es-PE");
const pedidos = (n: number) => `${fmt(n)} ${n === 1 ? "pedido" : "pedidos"}`;

/** «, 12 con más de 7 días y 3 con más de 30», para el nombre accesible. */
function agesText(s: TodosSubstage): string {
  return `${s.over7 ? `, ${fmt(s.over7)} con más de 7 días` : ""}${s.over30 ? ` y ${fmt(s.over30)} con más de 30` : ""}`;
}

/** Lo que se ve en la fila: nombre, chapas de antigüedad, cifra y flecha. */
function RowBody({ s }: { s: TodosSubstage }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm text-ink-900">{s.label}</span>
        {(s.over7 > 0 || s.over30 > 0) && (
          <span className="mt-1 flex flex-wrap gap-1">
            {s.over7 > 0 && <Badge tone="warn">{`${fmt(s.over7)} con más de 7 días`}</Badge>}
            {s.over30 > 0 && <Badge tone="crit">{`${fmt(s.over30)} con más de 30`}</Badge>}
          </span>
        )}
      </span>
      <span className="flex h-5 shrink-0 items-center gap-1 text-sm font-semibold tabular-nums text-ink-900">
        {fmt(s.total)}
        <IconChevronRight className="size-4 text-ink-500" />
      </span>
    </>
  );
}

const ROW = "flex min-h-11 items-start justify-between gap-3 px-4 py-2.5 hover:bg-wash";

function SubstageRow({ s, lists, onOpenList }: { s: TodosSubstage; lists: readonly ListCount[]; onOpenList: (list: ReproList) => void }) {
  if (s.inPage) {
    // Las cuatro listas van DEBAJO del botón, como hermanas: nunca un botón dentro de otro.
    return (
      <li>
        <button
          type="button"
          onClick={() => onOpenList("por_decidir")}
          aria-label={`${s.label}: ${pedidos(s.total)}${agesText(s)}. Ver sus cuatro listas.`}
          className={cn(ROW, "w-full text-left")}
        >
          <RowBody s={s} />
        </button>
        <div className="flex flex-wrap gap-1 px-4 pb-2.5">
          {lists.map((l) => (
            <ChoiceChip key={l.list} label={l.label} count={l.count} active={false} onClick={() => onOpenList(l.list)} />
          ))}
        </div>
      </li>
    );
  }
  if (!s.href) return null;
  return (
    <li>
      {/* Sin precarga: son hasta unas veinte colas del Master, que se arma en el servidor. */}
      <Link
        href={s.href}
        prefetch={false}
        aria-label={`${s.label}: ${pedidos(s.total)}${agesText(s)}. Abrir en el Master de Pedidos.`}
        className={ROW}
      >
        <RowBody s={s} />
      </Link>
    </li>
  );
}

function StageGroup({ stage, lists, onOpenList }: { stage: TodosStage; lists: readonly ListCount[]; onOpenList: (list: ReproList) => void }) {
  return (
    <div className="mt-4">
      <div className="px-4">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink-700">
          <MacroStageDot stage={stage.stage} />
          <span className="min-w-0 flex-1 break-words">{stage.label}</span>
          <span className="shrink-0 tabular-nums">{fmt(stage.total)}</span>
        </h3>
        <p className="mt-0.5 text-[13px] text-ink-500">{stage.hint}</p>
      </div>
      <ul className="mt-2 divide-y divide-line border-t border-line">
        {stage.substages.map((s) => (
          <SubstageRow key={s.substage ?? "sin_subetapa"} s={s} lists={lists} onOpenList={onOpenList} />
        ))}
      </ul>
    </div>
  );
}

function Block({ title, total, note, stages, lists, onOpenList }: {
  title: string;
  total: number;
  note?: string;
  stages: readonly TodosStage[];
  lists: readonly ListCount[];
  onOpenList: (list: ReproList) => void;
}) {
  return (
    <div className={cn("min-w-0 pt-4", !stages.length && "pb-4")}>
      <div className="px-4">
        <h2 className="flex items-baseline justify-between gap-3 text-sm font-semibold text-ink-900">
          <span className="min-w-0 break-words">{title}</span>
          <span className="shrink-0 tabular-nums">{fmt(total)}</span>
        </h2>
        {note && <p className="mt-0.5 text-[13px] text-ink-500">{note}</p>}
      </div>
      {stages.map((stage) => (
        <StageGroup key={stage.stage} stage={stage} lists={lists} onOpenList={onOpenList} />
      ))}
    </div>
  );
}

export function ReproLimaTodos({ breakdown, lists, onOpenList }: {
  breakdown: TodosBreakdown;
  lists: ReadonlyArray<{ list: ReproList; label: string; count: number }>;
  onOpenList: (list: ReproList) => void;
}) {
  const { porEntregar, porCerrar, totals } = breakdown;
  if (!porEntregar.length && !porCerrar) {
    return (
      <div className="border-t border-line px-4 py-12 text-center">
        <p className="text-sm text-ink-500">No hay pedidos de Lima sin estado final.</p>
      </div>
    );
  }
  return (
    <div className="border-t border-line">
      <div className="divide-y divide-line lg:grid lg:grid-cols-2 lg:divide-x lg:divide-y-0 lg:divide-line">
        <Block
          title="Todavía por entregar"
          total={totals.porEntregar}
          note="En Lima, lo que no se entrega vuelve a «Por reprogramar Lima»; solo la entrega lo pasa a «Por cerrar»."
          stages={porEntregar}
          lists={lists}
          onOpenList={onOpenList}
        />
        <Block
          title="Ya entregado, anulado o devuelto: falta cerrar"
          total={totals.porCerrar}
          stages={porCerrar ? [porCerrar] : []}
          lists={lists}
          onOpenList={onOpenList}
        />
      </div>
      <p className="border-t border-line px-4 py-3 text-[13px] text-ink-500">
        Cada pedido cuenta una vez, en su subetapa del Master. Los días son días de Lima desde que entró a la etapa; en «Por cerrar», desde su último cambio de estado.
      </p>
    </div>
  );
}
