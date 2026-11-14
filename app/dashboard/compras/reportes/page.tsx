import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { BarList, Card, EmptyState, cn } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { ComprasSubnav } from "@/components/compras/subnav";
import { fmtInt, fmtPct, fmtPen, fmtUsd, fmtUsdUnit } from "@/components/compras/format";
import { comprasPerms, loadReportImports, loadSuppliers, resolveComprasOrg } from "@/lib/compras-server";
import { formatDmy, limaToday } from "@/lib/compras";
import {
  moneyInTransit,
  monthlySpend,
  supplierRanking,
  supplierStats,
  unitCostHistory,
  type MonthRow,
  type UnitCostProduct,
} from "@/lib/compras-reportes";

export const dynamic = "force-dynamic";

// Reportes de Compras (MOM §45.8). Solo con «Montos de compras» en la
// organización: todo aquí es dinero. Sin el permiso, ni se leen los datos.

export default function ReportesPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <ReportesContent searchParams={searchParams} />
    </Suspense>
  );
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

function Box({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </Card>
  );
}

const TH = "px-2 py-2 text-left text-xs font-medium text-slate-500";
const TD = "px-2 py-2 align-top text-sm text-slate-700";

async function ReportesContent({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const [{ isVendedoraOnly }, sp] = await Promise.all([getUserRoleSummary(), searchParams]);
  if (isVendedoraOnly) redirect("/dashboard/leads");

  // Solo las organizaciones donde tiene «Montos de compras».
  const { orgId, allowed } = await resolveComprasOrg(sp.org, "money");
  if (!orgId) {
    return <EmptyState title="Reportes de Compras">Los reportes de compras piden el permiso «Montos de compras».</EmptyState>;
  }
  const perms = await comprasPerms(orgId);
  if (!perms.canMoney) {
    return <EmptyState title="Reportes de Compras">Los reportes de compras piden el permiso «Montos de compras».</EmptyState>;
  }

  const [imports, suppliers, stores] = await Promise.all([
    loadReportImports(orgId, perms.canMoney),
    loadSuppliers(orgId),
    getAccessibleStores(),
  ]);
  const today = limaToday();
  const transit = moneyInTransit(imports);
  const months = monthlySpend(imports, today, 12);
  const thisMonth = months[months.length - 1]!;
  const bought12 = months.reduce((a, m) => a + m.boughtUsd, 0);
  const bought12Pen = months.reduce((a, m) => a + m.boughtPen, 0);
  const last6 = [...months].slice(-6).reverse();
  const products = unitCostHistory(imports);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const ranking = supplierRanking(suppliers.map((s) => supplierStats(s.id, imports, { money: true })));
  const storeName = new Map(stores.filter((s) => s.org_id === orgId).map((s) => [s.id, s.name]));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Compras</h1>
        <p className="text-xs text-slate-500">
          Reportes en USD (con soles donde la importación tiene tipo de cambio). Las cotizaciones y las canceladas no cuentan
          como compras; los meses son de Lima.
        </p>
      </div>
      <ComprasSubnav current="reportes" perms={perms} orgId={orgId} multiOrg={allowed.length > 1} />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Dinero en camino"
          value={fmtUsd(transit.totalUsd)}
          sub={`${fmtInt(transit.units)} u. en ${transit.imports} importación${transit.imports === 1 ? "" : "es"}${penNote(transit.totalPen, transit.withoutFx)}`}
        />
        <Metric
          label="Pagado de lo que viene"
          value={fmtUsd(transit.paidUsd)}
          sub={transit.pendingUsd > 0 ? `Falta pagar ${fmtUsd(transit.pendingUsd)}${transit.pendingPen > 0 ? ` (${fmtPen(transit.pendingPen)})` : ""}` : "Nada pendiente"}
        />
        <Metric label="Comprado en 12 meses" value={fmtUsd(bought12)} sub={bought12Pen > 0 ? fmtPen(bought12Pen) : undefined} />
        <Metric label={`Este mes (${monthLabel(thisMonth.month)})`} value={fmtUsd(thisMonth.boughtUsd)} sub={`Pagado ${fmtUsd(thisMonth.paidUsd)}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Box title="Comprado por mes" subtitle="Costo aterrizado de las compradas, por el mes del pedido.">
          <BarList items={months.map((m) => ({ label: monthLabel(m.month), value: m.boughtUsd, valueLabel: fmtUsd(m.boughtUsd) }))} />
        </Box>
        <Box title="Pagado por mes" subtitle="Pagos por el mes en que se pagaron, sin los de importaciones canceladas.">
          <BarList items={months.map((m) => ({ label: monthLabel(m.month), value: m.paidUsd, valueLabel: fmtUsd(m.paidUsd) }))} />
        </Box>
      </div>

      <Box title="Últimos 6 meses">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px]">
            <thead className="border-b border-slate-200">
              <tr>
                <th className={TH}>Mes</th>
                <th className={cn(TH, "text-right")}>Importaciones</th>
                <th className={cn(TH, "text-right")}>Unidades</th>
                <th className={cn(TH, "text-right")}>Comprado</th>
                <th className={cn(TH, "text-right")}>Pagado</th>
              </tr>
            </thead>
            <tbody>
              {last6.map((m) => (
                <MonthTableRow key={m.month} m={m} />
              ))}
            </tbody>
          </table>
        </div>
      </Box>

      <Box
        title="Costo por unidad de cada producto"
        subtitle="Costo aterrizado por unidad buena en cada importación comprada (por SKU y tienda; sin SKU, por nombre). Rojo si sube más de 2 %, verde si baja más de 2 %."
      >
        {!products.length ? (
          <p className="text-sm text-slate-400">Todavía no hay importaciones compradas con unidades buenas.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="border-b border-slate-200">
                <tr>
                  <th className={TH}>Producto</th>
                  <th className={cn(TH, "text-right")}>Último</th>
                  <th className={cn(TH, "text-right")}>Anterior</th>
                  <th className={cn(TH, "text-right")}>Cambio</th>
                  <th className={TH}>Historial</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <UnitCostRow key={p.key} p={p} storeName={p.storeId ? (storeName.get(p.storeId) ?? null) : null} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Box>

      <Box title="Proveedores por monto comprado">
        {!ranking.length ? (
          <p className="text-sm text-slate-400">Todavía no hay compras.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead className="border-b border-slate-200">
                <tr>
                  <th className={TH}>#</th>
                  <th className={TH}>Proveedor</th>
                  <th className={cn(TH, "text-right")}>Comprado</th>
                  <th className={cn(TH, "text-right")}>Del total</th>
                  <th className={cn(TH, "text-right")}>Compras</th>
                  <th className={cn(TH, "text-right")}>Unidades</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((r, i) => (
                  <tr key={r.supplierId} className="border-b border-slate-100 last:border-0">
                    <td className={TD}>{i + 1}</td>
                    <td className={TD}>
                      <Link
                        href={`/dashboard/compras?v=todas&proveedor=${r.supplierId}${allowed.length > 1 ? `&org=${orgId}` : ""}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {supplierName.get(r.supplierId) ?? "—"}
                      </Link>
                    </td>
                    <td className={cn(TD, "text-right")}>
                      <p className="font-medium text-slate-900">{fmtUsd(r.boughtUsd)}</p>
                      {r.boughtPen > 0 && <p className="text-xs text-slate-500">{fmtPen(r.boughtPen)}</p>}
                    </td>
                    <td className={cn(TD, "text-right")}>{fmtPct(r.share)}</td>
                    <td className={cn(TD, "text-right")}>{fmtInt(r.bought)}</td>
                    <td className={cn(TD, "text-right")}>{fmtInt(r.units)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Box>
    </div>
  );
}

/** «▲ +5.0 %», «▼ −3.0 %», «0.0 %». */
function changeLabel(change: number): string {
  if (change > 0) return `▲ +${fmtPct(change)}`;
  if (change < 0) return `▼ −${fmtPct(-change)}`;
  return fmtPct(0);
}

function penNote(pen: number, withoutFx: number): string {
  if (!(pen > 0)) return "";
  return ` · ${fmtPen(pen)}${withoutFx ? ` (${withoutFx} sin tipo de cambio)` : ""}`;
}

function MonthTableRow({ m }: { m: MonthRow }) {
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className={TD}>{monthLabel(m.month)}</td>
      <td className={cn(TD, "text-right")}>{fmtInt(m.imports)}</td>
      <td className={cn(TD, "text-right")}>{fmtInt(m.units)}</td>
      <td className={cn(TD, "text-right")}>
        {fmtUsd(m.boughtUsd)}
        {m.boughtPen > 0 && <p className="text-xs text-slate-500">{fmtPen(m.boughtPen)}</p>}
      </td>
      <td className={cn(TD, "text-right")}>
        {fmtUsd(m.paidUsd)}
        {m.paidPen > 0 && <p className="text-xs text-slate-500">{fmtPen(m.paidPen)}</p>}
      </td>
    </tr>
  );
}

function UnitCostRow({ p, storeName }: { p: UnitCostProduct; storeName: string | null }) {
  const tone = p.trend === "up" ? "font-semibold text-red-700" : p.trend === "down" ? "font-semibold text-emerald-700" : "text-slate-600";
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className={cn(TD, "max-w-[240px]")}>
        <p className="font-medium text-slate-900">{p.name}</p>
        <p className="text-xs text-slate-500">
          {p.sku ? `SKU ${p.sku}` : "Sin SKU"}
          {p.sku ? ` · ${storeName ?? "General"}` : ""}
        </p>
      </td>
      <td className={cn(TD, "text-right")}>
        <p className="font-medium text-slate-900">{fmtUsdUnit(p.last.unitCostUsd)}</p>
        {p.last.unitCostPen != null && <p className="text-xs text-slate-500">{fmtPen(p.last.unitCostPen)}</p>}
        <p className="text-xs text-slate-400">{p.last.code}</p>
      </td>
      <td className={cn(TD, "text-right")}>
        {p.previous ? (
          <>
            <p>{fmtUsdUnit(p.previous.unitCostUsd)}</p>
            {p.previous.unitCostPen != null && <p className="text-xs text-slate-500">{fmtPen(p.previous.unitCostPen)}</p>}
            <p className="text-xs text-slate-400">{p.previous.code}</p>
          </>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className={cn(TD, "text-right", tone)}>
        {p.change == null ? <span className="text-slate-400">—</span> : changeLabel(p.change)}
      </td>
      <td className={TD}>
        <details>
          <summary className="cursor-pointer text-xs text-brand-700">
            {p.points.length} importación{p.points.length === 1 ? "" : "es"}
          </summary>
          <ul className="mt-1 space-y-0.5 text-xs">
            {[...p.points].reverse().map((pt) => (
              <li key={pt.importId}>
                <Link href={`/dashboard/compras/${pt.importId}`} className="text-brand-700 hover:underline">
                  {pt.code}
                </Link>{" "}
                · {formatDmy(pt.date)} · {fmtInt(pt.good)} buenas · {fmtUsdUnit(pt.unitCostUsd)}
                {pt.unitCostPen != null ? ` · ${fmtPen(pt.unitCostPen)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      </td>
    </tr>
  );
}
