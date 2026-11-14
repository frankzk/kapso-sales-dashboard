// Reportes de Compras (MOM §45.8) en el mundo de operación (DESIGN.md): el
// marco de cifras arriba, las barras por mes en la tinta de una serie (el azul
// de la marca: es una medida, no una acción) y las tablas con hairlines, que
// en una tarjeta angosta pasan a lista (`@container`). La página de servidor
// pide «Montos de compras» antes de leer nada; aquí solo se dibuja.

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { Banner, SectionHead } from "@/components/ops-ui";
import { SECTION_CARD } from "@/components/ops-styles";
import { fmtInt, fmtPct, fmtPen, fmtUsd, fmtUsdUnit } from "@/components/compras/format";
import { FigureCell, FigureFrame } from "@/components/compras/chrome";
import { IconArrowDown, IconArrowUp, IconChevronRight } from "@/components/icons";
import { MISSING_FX, formatDmy } from "@/lib/compras";
import {
  importsMissingFxForUsd,
  moneyInTransit,
  monthlySpend,
  supplierRanking,
  supplierStats,
  unitCostHistory,
  type MonthRow,
  type ReportImport,
  type UnitCostProduct,
} from "@/lib/compras-reportes";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

function Card({ title, help, className, children }: { title: string; help?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn(SECTION_CARD, "@container space-y-4", className)}>
      <SectionHead title={title} help={help} />
      {children}
    </section>
  );
}

/** Una barra por mes: etiqueta, barra proporcional desde cero y la cifra. El mes en curso va en peso 600. */
function MonthBars({ rows, value, current }: { rows: MonthRow[]; value: (m: MonthRow) => number; current: string }) {
  const max = Math.max(0, ...rows.map(value));
  return (
    <ul className="space-y-1.5">
      {rows.map((m) => {
        const v = value(m);
        const now = m.month === current;
        return (
          <li key={m.month} className="grid grid-cols-[4.25rem_minmax(0,1fr)_7.5rem] items-center gap-3 text-[13px] leading-5">
            <span className={cn("tabular-nums", now ? "font-semibold text-ink-900" : "text-ink-600")}>{monthLabel(m.month)}</span>
            <span aria-hidden className="h-2 rounded-[2px] bg-wash">
              {v > 0 && <span className="block h-full rounded-[2px] bg-brand-500" style={{ width: `${Math.max(1.5, (v / (max || 1)) * 100)}%` }} />}
            </span>
            <span className={cn("text-right tabular-nums", v > 0 ? "text-ink-900" : "text-ink-300", now && "font-semibold")}>{fmtUsd(v)}</span>
          </li>
        );
      })}
    </ul>
  );
}

const TH = "border-b border-line py-2 pl-3 text-xs font-semibold text-ink-600 first:pl-0";
const NUM = "text-right";
const TD = "py-2.5 pl-3 align-top text-sm leading-5 tabular-nums text-ink-700 first:pl-0";
const SUB = "text-[13px] leading-5 text-ink-500";
// Las listas van justo bajo `SectionHead`: su hairline ya es la de arriba.
const ROWS = "-mx-4 -mt-4 divide-y divide-line sm:-mx-5";
/** Las mismas filas después de otra cosa (un aviso): con su hairline arriba. */
const ROWS_AFTER = "-mx-4 divide-y divide-line border-t border-line sm:-mx-5";
const ROW = "px-4 py-3 sm:px-5";

export function ReportsView({
  imports,
  suppliers,
  storeName,
  today,
  orgQuery,
}: {
  imports: ReportImport[];
  suppliers: { id: string; name: string }[];
  storeName: Map<string, string>;
  today: string;
  /** `&org=` cuando la persona ve más de una organización. */
  orgQuery: string;
}) {
  const transit = moneyInTransit(imports);
  const months = monthlySpend(imports, today, 12);
  const thisMonth = months[months.length - 1]!;
  const bought12 = months.reduce((a, m) => a + m.boughtUsd, 0);
  const bought12Pen = months.reduce((a, m) => a + m.boughtPen, 0);
  const last6 = [...months].slice(-6).reverse();
  const products = unitCostHistory(imports);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  // En una sola moneda para todos: soles si todas las compras se pueden llevar a
  // soles (un laboratorio local todo en soles entra sin tipo de cambio).
  const ranking = supplierRanking(suppliers.map((s) => supplierStats(s.id, imports, { money: true })));
  const fmtBase = ranking.base === "PEN" ? fmtPen : fmtUsd;
  const fmtOther = ranking.base === "PEN" ? fmtUsd : fmtPen;
  // Montos en soles sin tipo de cambio: no entran en los USD y se dice cuántas son.
  const missingFx = importsMissingFxForUsd(imports);

  return (
    <div className="space-y-4 sm:space-y-6">
      {missingFx > 0 && (
        <Banner tone="warn" role="status" title={MISSING_FX}>
          <p>
            {missingFx} importaci{missingFx === 1 ? "ón tiene" : "ones tienen"} montos en soles y no tiene{missingFx === 1 ? "" : "n"} tipo de cambio: no entra
            {missingFx === 1 ? "" : "n"} en las cifras en USD. Escríbelo en el detalle de cada una.
          </p>
        </Banner>
      )}
      <FigureFrame className="lg:grid-cols-4">
        <FigureCell
          label="Dinero en camino (USD)"
          value={fmtUsd(transit.totalUsd)}
          sub={`${fmtInt(transit.units)} u. en ${transit.imports} importación${transit.imports === 1 ? "" : "es"}${penNote(transit.totalPen, transit.withoutFx)}${transit.usdWithoutFx ? ` · ${transit.usdWithoutFx} sin tipo de cambio fuera de los USD` : ""}`}
          tone={transit.usdWithoutFx ? "warn" : undefined}
        />
        <FigureCell
          label="Pagado de lo que viene"
          value={fmtUsd(transit.paidUsd)}
          sub={transit.pendingUsd > 0 ? `Falta pagar ${fmtUsd(transit.pendingUsd)}${transit.pendingPen > 0 ? ` (${fmtPen(transit.pendingPen)})` : ""}` : "Nada pendiente"}
          tone={transit.pendingUsd > 0 ? "warn" : undefined}
        />
        <FigureCell label="Comprado en 12 meses" value={fmtUsd(bought12)} sub={bought12Pen > 0 ? fmtPen(bought12Pen) : undefined} />
        <FigureCell label={`Este mes (${monthLabel(thisMonth.month)})`} value={fmtUsd(thisMonth.boughtUsd)} sub={`Pagado ${fmtUsd(thisMonth.paidUsd)}`} />
      </FigureFrame>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card title="Comprado por mes" help="Costo aterrizado de las compradas, por el mes del pedido. En USD (los costos en soles ÷ el tipo de cambio de cada importación).">
          <MonthBars rows={months} value={(m) => m.boughtUsd} current={thisMonth.month} />
        </Card>
        <Card title="Pagado por mes" help="Pagos por el mes en que se pagaron, sin los de importaciones canceladas. En USD (los pagos en soles ÷ el tipo de cambio de su importación).">
          <MonthBars rows={months} value={(m) => m.paidUsd} current={thisMonth.month} />
        </Card>
      </div>

      <Card title="Últimos 6 meses">
        <table className="hidden w-full @xl:table">
          <thead>
            <tr>
              <th className={cn(TH, "text-left")}>Mes</th>
              <th className={cn(TH, NUM)}>Importaciones</th>
              <th className={cn(TH, NUM)}>Unidades</th>
              <th className={cn(TH, NUM)}>Comprado</th>
              <th className={cn(TH, NUM)}>Pagado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {last6.map((m) => (
              <tr key={m.month}>
                <td className={cn(TD, "text-left text-ink-900")}>{monthLabel(m.month)}</td>
                <td className={cn(TD, NUM)}>{fmtInt(m.imports)}</td>
                <td className={cn(TD, NUM)}>{fmtInt(m.units)}</td>
                <td className={cn(TD, NUM)}>
                  <span className="text-ink-900">{fmtUsd(m.boughtUsd)}</span>
                  {m.boughtPen > 0 && <p className={SUB}>{fmtPen(m.boughtPen)}</p>}
                </td>
                <td className={cn(TD, NUM)}>
                  <span className="text-ink-900">{fmtUsd(m.paidUsd)}</span>
                  {m.paidPen > 0 && <p className={SUB}>{fmtPen(m.paidPen)}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className={cn(ROWS, "-mb-4 sm:-mb-5 @xl:hidden")}>
          {last6.map((m) => (
            <li key={m.month} className={cn(ROW, "flex items-start justify-between gap-3")}>
              <span>
                <span className="block text-sm leading-5 text-ink-900">{monthLabel(m.month)}</span>
                <span className={cn(SUB, "block tabular-nums")}>
                  {fmtInt(m.imports)} importaci{m.imports === 1 ? "ón" : "ones"} · {fmtInt(m.units)} u.
                </span>
              </span>
              <span className="text-right text-[13px] leading-5 tabular-nums">
                <span className="block text-sm text-ink-900">{fmtUsd(m.boughtUsd)}</span>
                <span className="block text-ink-500">pagado {fmtUsd(m.paidUsd)}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Costo por unidad de cada producto"
        help="Costo aterrizado por unidad buena en cada importación comprada (por SKU y tienda; sin SKU, por nombre). En rojo si sube más de 2 %, en verde si baja más de 2 %."
      >
        {!products.length ? (
          <p className="text-sm text-ink-500">Todavía no hay importaciones compradas con unidades buenas.</p>
        ) : (
          <ul className={cn(ROWS, "-mb-4 sm:-mb-5")}>
            {products.map((p) => (
              <UnitCostItem key={p.key} p={p} storeName={p.storeId ? (storeName.get(p.storeId) ?? null) : null} />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Proveedores por monto comprado"
        help={
          ranking.base === "PEN"
            ? "En soles: los montos en soles tal cual y los de USD × el tipo de cambio de cada importación. El equivalente en USD, solo si todas sus compras tienen con qué convertir."
            : "En USD: alguna compra en USD no tiene tipo de cambio y no se puede llevar a soles. El equivalente en soles, solo si todas sus compras tienen con qué convertir."
        }
      >
        {ranking.missingFx > 0 && (
          <Banner tone="warn" role="status" title={MISSING_FX}>
            <p>
              {ranking.missingFx} compra{ranking.missingFx === 1 ? "" : "s"} no entra{ranking.missingFx === 1 ? "" : "n"} en el ranking en{" "}
              {ranking.base === "PEN" ? "soles" : "USD"}: le{ranking.missingFx === 1 ? "" : "s"} falta el tipo de cambio.
              {ranking.outside.length > 0 &&
                ` Sin ninguna compra que se pueda comparar: ${ranking.outside.map((o) => supplierName.get(o.supplierId) ?? "—").join(", ")}.`}
            </p>
          </Banner>
        )}
        {!ranking.rows.length ? (
          <p className="text-sm text-ink-500">{ranking.outside.length ? "Ninguna compra se puede comparar todavía." : "Todavía no hay compras."}</p>
        ) : (
          <>
            <table className="hidden w-full @xl:table">
              <thead>
                <tr>
                  <th className={cn(TH, "w-8 text-left")}>#</th>
                  <th className={cn(TH, "text-left")}>Proveedor</th>
                  <th className={cn(TH, NUM)}>Comprado ({ranking.base === "PEN" ? "S/" : "USD"})</th>
                  <th className={cn(TH, NUM)}>Del total</th>
                  <th className={cn(TH, NUM)}>Compras</th>
                  <th className={cn(TH, NUM)}>Unidades</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {ranking.rows.map((r, i) => (
                  <tr key={r.supplierId}>
                    <td className={cn(TD, "text-left text-ink-500")}>{i + 1}</td>
                    <td className={cn(TD, "text-left")}>
                      <Link href={`/dashboard/compras?v=todas&proveedor=${r.supplierId}${orgQuery}`} className="font-medium text-brand-700 hover:underline">
                        {supplierName.get(r.supplierId) ?? "—"}
                      </Link>
                    </td>
                    <td className={cn(TD, NUM)}>
                      <span className="font-medium text-ink-900">{fmtBase(r.amount)}</span>
                      {r.other != null && <p className={SUB}>{fmtOther(r.other)}</p>}
                      {r.missingFx > 0 && <p className="text-[13px] font-medium leading-5 text-warn-fg">+{r.missingFx} sin tipo de cambio</p>}
                    </td>
                    <td className={cn(TD, NUM)}>
                      <ShareBar share={r.share} />
                    </td>
                    <td className={cn(TD, NUM)}>{fmtInt(r.bought)}</td>
                    <td className={cn(TD, NUM)}>{fmtInt(r.units)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className={cn(ranking.missingFx > 0 ? ROWS_AFTER : ROWS, "-mb-4 sm:-mb-5 @xl:hidden")}>
              {ranking.rows.map((r, i) => (
                <li key={r.supplierId} className={cn(ROW, "flex items-start justify-between gap-3")}>
                  <span className="min-w-0">
                    <Link href={`/dashboard/compras?v=todas&proveedor=${r.supplierId}${orgQuery}`} className="text-sm font-medium leading-5 text-brand-700 hover:underline">
                      <span className="tabular-nums text-ink-500">{i + 1}.</span> {supplierName.get(r.supplierId) ?? "—"}
                    </Link>
                    <span className={cn(SUB, "block tabular-nums")}>
                      {fmtInt(r.bought)} compra{r.bought === 1 ? "" : "s"} · {fmtInt(r.units)} u.
                    </span>
                  </span>
                  <span className="text-right text-[13px] leading-5 tabular-nums">
                    <span className="block text-sm font-medium text-ink-900">{fmtBase(r.amount)}</span>
                    {r.other != null && <span className="block text-ink-500">{fmtOther(r.other)}</span>}
                    {r.missingFx > 0 && <span className="block font-medium text-warn-fg">+{r.missingFx} sin tipo de cambio</span>}
                    <span className="block text-ink-500">{fmtPct(r.share)} del total</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

function ShareBar({ share }: { share: number }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden className="hidden h-1.5 w-16 rounded-[2px] bg-wash @3xl:block">
        <span className="block h-full rounded-[2px] bg-brand-500" style={{ width: `${Math.max(2, Math.min(100, share * 100))}%` }} />
      </span>
      <span className="text-ink-900">{fmtPct(share)}</span>
    </span>
  );
}

/** «+5.0 %» con su flecha, «−3.0 %», «0.0 %». La palabra va para el lector: la flecha es decorativa. */
function ChangeLabel({ change }: { change: number }) {
  if (change > 0) {
    return (
      <span className="inline-flex items-center gap-0.5">
        <IconArrowUp aria-hidden className="size-3.5" strokeWidth={2.4} />
        <span className="sr-only">Sube </span>+{fmtPct(change)}
      </span>
    );
  }
  if (change < 0) {
    return (
      <span className="inline-flex items-center gap-0.5">
        <IconArrowDown aria-hidden className="size-3.5" strokeWidth={2.4} />
        <span className="sr-only">Baja </span>−{fmtPct(-change)}
      </span>
    );
  }
  return <>{fmtPct(0)}</>;
}

/** El costo por unidad en USD o, si a esa importación le falta el tipo de cambio, el aviso. */
const unitUsd = (n: number | null) => (n == null ? MISSING_FX : fmtUsdUnit(n));

function penNote(pen: number, withoutFx: number): string {
  if (!(pen > 0)) return "";
  return ` · ${fmtPen(pen)}${withoutFx ? ` (${withoutFx} sin tipo de cambio)` : ""}`;
}

function UnitCostItem({ p, storeName }: { p: UnitCostProduct; storeName: string | null }) {
  const tone = p.trend === "up" ? "font-semibold text-crit-fg" : p.trend === "down" ? "font-semibold text-ok-fg" : "text-ink-600";
  return (
    <li className={ROW}>
      <div className="grid gap-x-6 gap-y-2 @2xl:grid-cols-[minmax(0,1fr)_9rem_9rem_6.5rem]">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-5 text-ink-900">{p.name}</p>
          <p className={SUB}>
            {p.sku ? (
              <>
                SKU <span className="font-mono text-xs text-ink-700">{p.sku}</span> · {storeName ?? "General"}
              </>
            ) : (
              "Sin SKU"
            )}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-x-4 @2xl:contents">
          <Price label="Último" value={unitUsd(p.last.unitCostUsd)} pen={p.last.unitCostPen} code={p.last.code} strong />
          {p.previous ? (
            <Price label="Anterior" value={unitUsd(p.previous.unitCostUsd)} pen={p.previous.unitCostPen} code={p.previous.code} />
          ) : (
            <Price label="Anterior" value="—" />
          )}
          <div className="@2xl:text-right">
            <p className="text-xs font-medium text-ink-500 @2xl:sr-only">Cambio</p>
            <p className={cn("text-sm leading-5 tabular-nums", p.change == null ? "text-ink-300" : tone)}>{p.change == null ? "—" : <ChangeLabel change={p.change} />}</p>
          </div>
        </div>
      </div>
      <details className="group mt-1.5">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-[13px] font-medium text-brand-700 hover:underline pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <IconChevronRight aria-hidden className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
          {p.points.length} importación{p.points.length === 1 ? "" : "es"}
        </summary>
        <ul className="mt-1.5 space-y-0.5 border-l border-line-strong pl-3 text-[13px] leading-5 tabular-nums text-ink-600">
          {[...p.points].reverse().map((pt) => (
            <li key={pt.importId}>
              <Link href={`/dashboard/compras/${pt.importId}`} className="font-mono text-xs text-brand-700 hover:underline">
                {pt.code}
              </Link>{" "}
              · {formatDmy(pt.date)} · {fmtInt(pt.good)} buenas · <span className={pt.unitCostUsd == null ? "font-medium text-warn-fg" : "text-ink-900"}>{unitUsd(pt.unitCostUsd)}</span>
              {pt.unitCostPen != null ? ` · ${fmtPen(pt.unitCostPen)}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

function Price({ label, value, pen, code, strong }: { label: string; value: string; pen?: number | null; code?: string; strong?: boolean }) {
  return (
    <div className="min-w-0 @2xl:text-right">
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <p className={cn("text-sm leading-5 tabular-nums", value === MISSING_FX ? "font-medium text-warn-fg" : strong ? "font-semibold text-ink-900" : "text-ink-700")}>{value}</p>
      {pen != null && <p className={cn(SUB, "tabular-nums")}>{fmtPen(pen)}</p>}
      {code && <p className="font-mono text-xs leading-4 text-ink-500">{code}</p>}
    </div>
  );
}
