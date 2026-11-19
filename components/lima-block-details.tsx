"use client";

import { ChoiceChip } from "@/components/ops-ui";
import type { LimaDetailGroup } from "@/lib/lima-block-details";

export function LimaBlockDetails({ label, total, groups, active, onPick }: {
  label: string; total: number; groups: readonly LimaDetailGroup[]; active: string | null; onPick: (key: string | null) => void;
}) {
  return (
    <section aria-label={`Detalle de ${label}`} className="border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">Dentro de {label} <span className="font-normal tabular-nums text-ink-500">· {total.toLocaleString("es-PE")} pedidos</span></h3>
        <ChoiceChip label="Todos los del bloque" count={total} active={!active} onClick={() => onPick(null)} />
      </div>
      <p className="mt-1 text-[13px] leading-5 text-ink-500">Toca una cifra para ver sus pedidos abajo. Cada cifra cuenta pedidos, aunque tengan varias guías. Los cruces no se suman entre sí.</p>
      <div className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <div key={group.title} role="group" aria-label={group.title} className="min-w-0 space-y-2">
            <h4 className="text-[13px] font-semibold text-ink-700">{group.title}</h4>
            <div className="flex flex-wrap gap-1.5 [&>button]:h-auto [&>button]:min-h-11 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:py-2 [&>button]:text-left [&>button>span]:shrink-0">
              {group.items.map((item) => <ChoiceChip key={item.key} label={item.label} count={item.count} active={active === item.key} onClick={() => onPick(active === item.key ? null : item.key)} />)}
            </div>
            {group.help ? <p className="max-w-prose text-xs leading-5 text-ink-500">{group.help}</p> : null}
          </div>
        ))}
      </div>
    </section>
  );
}
