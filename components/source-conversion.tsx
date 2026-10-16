import { cn } from "@/components/ui";
import { Figure, FIGURE_FRAME, pctText } from "@/components/figures";
import { CLOSING_GROUP_SHADE } from "@/components/palette";
import { CLOSING_GROUPS, GROUP_LABEL, type ClosingGroupKey } from "@/lib/closing-channel";
import { CONVERSION_DAYS, SOURCE_LABEL, sourceNoRateCause, type SourceConversionSummary } from "@/lib/consolidado-origen";

const nf = new Intl.NumberFormat("es-PE");
const TH = "px-3 py-2 text-xs font-semibold text-ink-600";
/** Los grupos de cierre en corto, para que quepan en una celda; el largo va en la etiqueta accesible. */
const SHORT: Record<ClosingGroupKey, string> = { humano: "Asesora", automatizacion: "Bot", web: "Web", otros: "Otros" };

/**
 * Conversión de cada fuente de leads (MOM §17.4): de los leads que llegaron en
 * el periodo y ya cumplieron 7 días, cuántos compraron en esos 7 días por
 * cualquier canal. Las que ya eran clientas van aparte: comprar otra vez no es
 * convertir. Sin leads con 7 días la tasa dice «Sin datos», nunca 0 %.
 */
export function SourceConversion({ summary }: { summary: SourceConversionSummary }) {
  const { sources, total, noRate, advisors } = summary;
  const rows = sources.filter((s) => s.born > 0);
  const cause = sourceNoRateCause(summary);
  return (
    <div className="flex flex-col gap-5">
      <dl className={cn(FIGURE_FRAME, "grid-cols-1 shadow-none sm:grid-cols-3")}>
        <Figure
          label="Conversión de los leads"
          value={total.rate != null ? pctText(total.rate) : "Sin datos"}
          sub={
            total.prospects
              ? `${nf.format(total.converted)} de ${nf.format(total.prospects)} compraron en ${CONVERSION_DAYS} días`
              : cause === "ya_clientas"
                ? `los leads con ${CONVERSION_DAYS} días ya eran clientas`
                : cause === "maduran"
                  ? `ningún lead cumplió ${CONVERSION_DAYS} días todavía`
                  : cause === "sin_tasa"
                    ? "solo llegaron leads sin tasa"
                    : "ningún lead nuevo en el periodo"
          }
        />
        <Figure
          label="Por madurar"
          value={nf.format(total.maturing)}
          sub={`leads con menos de ${CONVERSION_DAYS} días: todavía no entran`}
        />
        <Figure
          label="Cierre de las asesoras"
          value={advisors.rate != null ? pctText(advisors.rate) : "Sin datos"}
          sub={
            advisors.worked
              ? `${nf.format(advisors.sales)} ventas de ${nf.format(advisors.worked)} leads trabajados${advisors.cancelledSales ? ` · ${nf.format(advisors.cancelledSales)} anuladas` : ""}`
              : "ninguna gestión de asesora en el periodo"
          }
        />
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <caption className="sr-only">Conversión por fuente de los leads del periodo</caption>
          <thead>
            <tr className="border-b border-line text-left">
              <th scope="col" className={cn(TH, "pl-0")}>Fuente</th>
              <th scope="col" className={cn(TH, "text-right")}>Leads</th>
              <th scope="col" className={cn(TH, "text-right")}>Ya eran clientas</th>
              <th scope="col" className={cn(TH, "text-right")}>Nuevas con 7 días</th>
              <th scope="col" className={cn(TH, "text-right")}>Compraron</th>
              <th scope="col" className={cn(TH, "text-right")}>Conversión</th>
              <th scope="col" className={cn(TH, "pr-0")}>Quién cerró la compra</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const closed = CLOSING_GROUPS.filter((g) => s.closedBy[g] > 0);
              return (
                <tr key={s.key} className="border-b border-line align-top last:border-0">
                  <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                    <span className="block font-medium text-ink-900">{SOURCE_LABEL[s.key].title}</span>
                    <span className="mt-0.5 block text-xs text-ink-500">{SOURCE_LABEL[s.key].sub}</span>
                  </th>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">
                    {nf.format(s.born)}
                    {s.maturing > 0 && <span className="block whitespace-nowrap text-xs text-ink-500">{nf.format(s.maturing)} por madurar</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{nf.format(s.alreadyCustomers)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{nf.format(s.prospects)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{nf.format(s.converted)}</td>
                  <td className={cn("px-3 py-2.5 text-right tabular-nums", s.rate != null ? "font-semibold text-ink-900" : "text-ink-500")}>
                    {s.rate != null ? pctText(s.rate) : "Sin datos"}
                  </td>
                  <td className="py-2.5 pl-3">
                    {s.converted && closed.length ? (
                      <span className="flex min-w-40 flex-col gap-1.5 pt-1">
                        <span
                          role="img"
                          aria-label={closed.map((g) => `${GROUP_LABEL[g]} ${pctText(s.closedBy[g] / s.converted, 0)}`).join(", ")}
                          className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
                        >
                          {closed.map((g) => (
                            <span
                              key={g}
                              className="h-full first:rounded-l-full last:rounded-r-full"
                              style={{ flex: `${s.closedBy[g]} 0 0`, background: CLOSING_GROUP_SHADE[g] }}
                            />
                          ))}
                        </span>
                        <span aria-hidden className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-ink-600">
                          {closed.map((g) => (
                            <span key={g} className="inline-flex items-center gap-1 whitespace-nowrap">
                              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: CLOSING_GROUP_SHADE[g] }} />
                              {SHORT[g]} <span className="tabular-nums text-ink-900">{pctText(s.closedBy[g] / s.converted, 0)}</span>
                            </span>
                          ))}
                        </span>
                      </span>
                    ) : (
                      <span className="text-ink-500">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {noRate.born > 0 && (
        <p className="max-w-[72ch] text-[13px] leading-5 text-ink-600">
          {nf.format(noRate.born)} {noRate.born === 1 ? "lead más llegó" : "leads más llegaron"} por venta telefónica o con una
          fuente que el tablero no reconoce: no tienen tasa, porque no hay un canal que medir.
        </p>
      )}
    </div>
  );
}
