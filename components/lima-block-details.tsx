"use client";

import { ChoiceChip } from "@/components/ops-ui";
import type { LimaDetailGroup } from "@/lib/lima-block-details";
import { useState } from "react";
import { cn } from "@/components/ui";
import type { LimaSituation } from "@/lib/lima-situations";

function DetailGroups({ groups, active, onPick }: { groups: readonly LimaDetailGroup[]; active: string | null; onPick: (key: string | null) => void }) {
  return <div className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
    {groups.map((group) => <div key={group.title} role="group" aria-label={group.title} className="min-w-0 space-y-2">
      <h4 className="text-[13px] font-semibold text-ink-700">{group.title}</h4>
      <div className="flex flex-wrap gap-1.5 [&>button]:h-auto [&>button]:min-h-11 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:py-2 [&>button]:text-left [&>button>span]:shrink-0">
        {group.items.map((item) => <ChoiceChip key={item.key} label={item.label} count={item.count} active={active === item.key} onClick={() => onPick(active === item.key ? null : item.key)} />)}
      </div>
      {group.help ? <p className="max-w-prose text-xs leading-5 text-ink-500">{group.help}</p> : null}
    </div>)}
  </div>;
}

function SituationList({ situations, active, onPick }: { situations: readonly LimaSituation[]; active: string | null; onPick: (key: string | null) => void }) {
  const [limit, setLimit] = useState(8);
  const shown = situations.slice(0, limit);
  const selected = situations.find((s) => s.key === active);
  const visible = selected && !shown.includes(selected) ? [selected, ...shown] : shown;
  return <div className="mt-4">
    <h4 className="text-[13px] font-semibold text-ink-900">Situaciones completas · {situations.length.toLocaleString("es-PE")}</h4>
    <p className="mt-1 text-xs leading-5 text-ink-500">Cada pedido pertenece a una sola situación. Sus cantidades suman todos los pedidos del bloque.</p>
    {active?.startsWith("situation:") && !selected ? <p role="status" className="mt-2 text-[13px] text-warn-fg">La situación elegida ya no tiene pedidos con estos filtros. Usa «Todos los del bloque» para volver.</p> : null}
    <div className="mt-3 divide-y divide-line border-y border-line" role="group" aria-label="Situaciones completas">
      {visible.map((s) => <button type="button" key={s.key} aria-pressed={active === s.key} onClick={() => onPick(active === s.key ? null : s.key)} className={cn("grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand-600", active === s.key ? "bg-brand-50" : "hover:bg-white")}>
        <span className="min-w-0"><span className="block text-[13px] font-medium leading-5 text-ink-900">{s.title}</span><span className="mt-1 block break-words text-xs leading-5 text-ink-500">{s.detail}</span></span>
        <span className="text-lg font-semibold tabular-nums text-brand-700">{s.count.toLocaleString("es-PE")}</span>
      </button>)}
    </div>
    {limit < situations.length ? <button type="button" onClick={() => setLimit((n) => n + 20)} className="mt-2 min-h-11 text-[13px] font-medium text-brand-700 hover:underline">Ver más situaciones ({situations.length - limit})</button> : null}
  </div>;
}

export function LimaBlockDetails({ label, total, groups, active, onPick, situations }: {
  label: string; total: number; groups: readonly LimaDetailGroup[]; active: string | null; onPick: (key: string | null) => void;
  situations?: readonly LimaSituation[];
}) {
  return (
    <section aria-label={`Detalle de ${label}`} className="border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">Dentro de {label} <span className="font-normal tabular-nums text-ink-500">· {total.toLocaleString("es-PE")} pedidos</span></h3>
        <ChoiceChip label="Todos los del bloque" count={total} active={!active} onClick={() => onPick(null)} />
      </div>
      <p className="mt-1 text-[13px] leading-5 text-ink-500">Toca una cifra para ver sus pedidos abajo. Cada cifra cuenta pedidos, aunque tengan varias guías. Los cruces no se suman entre sí.</p>
      <DetailGroups groups={groups.filter((group) => group.prominent)} active={active} onPick={onPick} />
      {situations ? <SituationList key={label} situations={situations} active={active} onPick={onPick} /> : null}
      <details className="mt-4" open={!situations || Boolean(active && !active.startsWith("situation:"))}>
      <summary className="cursor-pointer py-2 text-[13px] font-semibold text-ink-700">Explorar características por separado</summary>
      <DetailGroups groups={groups.filter((group) => !group.prominent)} active={active} onPick={onPick} />
      </details>
    </section>
  );
}
