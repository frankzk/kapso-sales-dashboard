import { cn } from "@/components/ui";
import { Change, Figure, FIGURE_FRAME, pctText } from "@/components/figures";
import { CLOSING_GROUP_SHADE } from "@/components/palette";
import { formatCurrency } from "@/lib/metrics";
import {
  CHANNEL_GROUP,
  CHANNEL_LABEL,
  CLOSING_CHANNELS,
  CLOSING_GROUPS,
  GROUP_LABEL,
  type ClosingChannelSummary,
} from "@/lib/closing-channel";
import type { SalesTotals } from "@/lib/consolidado-origen";

const nf = new Intl.NumberFormat("es-PE");

function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

/**
 * Quién cerró cada venta de la tienda (MOM §17.3): arriba los cuatro grupos, de
 * más a menos mano humana; abajo cada canal con su «ayudado por asesora».
 *
 * Ayudar no es cerrar: un pedido del bot que una asesora trabajó antes sigue
 * siendo del bot, y la ayuda se cuenta aparte en su fila. Así los canales suman
 * el total de la tienda y el porcentaje de la asesora no se infla ni se hunde.
 *
 * `prev`: las mismas ventas del periodo anterior, solo si se puede comparar
 * (cada tienda lo contaba entero, MOM §17.4). Sin él no hay columna de cambio.
 */
export function ClosingChannels({
  summary,
  currency,
  prev,
}: {
  summary: ClosingChannelSummary;
  currency: string;
  prev?: SalesTotals | null;
}) {
  const { byChannel, byGroup, total } = summary;
  const share = (revenue: number) => (total.revenue ? revenue / total.revenue : 0);
  const shownGroups = CLOSING_GROUPS.filter((g) => byGroup[g].revenue > 0);
  // Un canal que vendía antes y ahora no también es una fila: su caída es el dato.
  const rows = CLOSING_CHANNELS.filter(
    (c) => byChannel[c].orders > 0 || byChannel[c].cancelled > 0 || (prev?.byChannel[c].orders ?? 0) > 0,
  );
  return (
    <div className="flex flex-col gap-5">
      <dl className={cn(FIGURE_FRAME, "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4")}>
        {CLOSING_GROUPS.map((g) => {
          const f = byGroup[g];
          return (
            <Figure
              key={g}
              label={
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: CLOSING_GROUP_SHADE[g] }} />
                  {GROUP_LABEL[g]}
                </span>
              }
              value={formatCurrency(f.revenue, currency)}
              delta={prev ? <Change pct={pctDelta(f.revenue, prev.byGroup[g].revenue)} /> : undefined}
              sub={
                <>
                  {pctText(share(f.revenue))} de los ingresos{" · "}
                  {nf.format(f.orders)} {f.orders === 1 ? "pedido" : "pedidos"}
                </>
              }
            />
          );
        })}
      </dl>

      <div>
        <div
          role="img"
          aria-label={shownGroups.map((g) => `${GROUP_LABEL[g]} ${pctText(share(byGroup[g].revenue))}`).join(", ") || "Sin ingresos"}
          className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-line"
        >
          {shownGroups.map((g) => (
            <span
              key={g}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ flex: `${byGroup[g].revenue} 0 0`, background: CLOSING_GROUP_SHADE[g] }}
            />
          ))}
        </div>
        <p className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 text-sm text-ink-600">
          <span>
            Todas las ventas de la tienda{" · "}
            {nf.format(total.orders)} pedidos
            {total.cancelled ? ` · ${nf.format(total.cancelled)} cancelados aparte` : ""}
          </span>
          <span className="text-base font-semibold tabular-nums text-ink-900">
            {formatCurrency(total.revenue, currency)}
            {prev && <span className="ml-2 text-xs font-normal text-ink-500">antes {formatCurrency(prev.revenue, currency)}</span>}
          </span>
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className={cn("w-full text-sm", prev ? "min-w-[720px]" : "min-w-[620px]")}>
          <caption className="sr-only">Ventas por canal de cierre</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs font-medium text-ink-500">
              <th scope="col" className="py-2 pr-3 font-medium">Canal</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">Pedidos</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">Ingresos</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">% ingresos</th>
              {prev && <th scope="col" className="py-2 px-3 text-right font-medium">Ingresos contra el anterior</th>}
              <th scope="col" className="py-2 px-3 text-right font-medium">Ayudados por asesora</th>
              <th scope="col" className="py-2 pl-3 text-right font-medium">Cancelados aparte</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const f = byChannel[c];
              return (
                <tr key={c} className="border-b border-line last:border-0 align-top">
                  <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                    <span className="inline-flex items-center gap-1.5 font-medium text-ink-900">
                      <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: CLOSING_GROUP_SHADE[CHANNEL_GROUP[c]] }} />
                      {CHANNEL_LABEL[c].title}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-500">{CHANNEL_LABEL[c].sub}</span>
                  </th>
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-700">{nf.format(f.orders)}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-700">{formatCurrency(f.revenue, currency)}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-700">{pctText(share(f.revenue))}</td>
                  {prev && (
                    <td className="py-2.5 px-3 text-right">
                      <Change pct={pctDelta(f.revenue, prev.byChannel[c].revenue)} />
                    </td>
                  )}
                  <td className="py-2.5 px-3 text-right tabular-nums text-ink-700">
                    {c === "asesora" ? (
                      <span className="text-ink-500">—</span>
                    ) : f.assisted ? (
                      <>
                        {nf.format(f.assisted)}
                        <span className="text-ink-500"> ({pctText(f.orders ? f.assisted / f.orders : 0, 0)})</span>
                      </>
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="py-2.5 pl-3 text-right tabular-nums text-ink-700">{nf.format(f.cancelled)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
