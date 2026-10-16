import { formatCurrency, type LossReason, type LostRevenue } from "@/lib/metrics";

/** La parte de un motivo con un decimal como mucho: «45.5 %», no «45.45 %». */
export function sharePct(pct: number): string {
  return `${pct.toLocaleString("es-PE", { maximumFractionDigits: 1 })}\u00a0%`;
}

/**
 * Por qué no compraron: una fila por motivo con su parte y su barra. Las
 * barras van en una sola tinta —es la misma medida para todos los motivos—;
 * el color por motivo no decía nada que la etiqueta no diga.
 */
export function LossReasonBars({ items, total }: { items: LossReason[]; total: number }) {
  if (!items.length) {
    return <p className="text-sm text-ink-500">Sin leads sin convertir en el periodo.</p>;
  }
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div>
      <ul className="flex flex-col gap-3">
        {items.map((it) => (
          <li key={it.bucket}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-ink-900">{it.label}</span>
              <span className="shrink-0 tabular-nums text-ink-600">
                <span className="font-semibold text-ink-900">{sharePct(it.pct)}</span>
                {"\u00a0· "}
                {it.count.toLocaleString("es-PE")}
              </span>
            </div>
            <div className="mt-1.5 h-2 rounded-full bg-line">
              <div className="h-full rounded-full bg-ink-500" style={{ width: `${Math.max(2, Math.round((it.count / max) * 100))}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-4 flex items-baseline justify-between border-t border-line pt-3 text-sm text-ink-600">
        Oportunidades perdidas
        <span className="font-semibold tabular-nums text-ink-900">{total.toLocaleString("es-PE")}</span>
      </p>
    </div>
  );
}

/** Lo que se dejó de vender, estimado por motivo: personas × ticket promedio. */
export function LostRevenueCards({
  items,
  total,
  currency,
}: {
  items: LostRevenue[];
  total: number;
  currency: string;
}) {
  if (!items.length) {
    return <p className="text-sm text-ink-500">Sin pérdidas estimadas en el periodo.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs font-semibold text-ink-600">
          <th scope="col" className="py-2 pr-3 font-semibold">Motivo</th>
          <th scope="col" className="px-3 py-2 text-right font-semibold">Personas</th>
          <th scope="col" className="py-2 pl-3 text-right font-semibold">Potencial perdido</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.bucket} className="border-b border-line">
            <td className="py-2.5 pr-3 text-ink-900">{it.label}</td>
            <td className="px-3 py-2.5 text-right tabular-nums text-ink-600">{it.lostCount.toLocaleString("es-PE")}</td>
            <td className="py-2.5 pl-3 text-right font-semibold tabular-nums text-ink-900">{formatCurrency(it.estRevenue, currency)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="font-semibold text-ink-900">
          <td className="py-2.5 pr-3">Total</td>
          <td className="px-3 py-2.5 text-right tabular-nums">{items.reduce((s, it) => s + it.lostCount, 0).toLocaleString("es-PE")}</td>
          <td className="py-2.5 pl-3 text-right tabular-nums">{formatCurrency(total, currency)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
