import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserRoleSummary } from "@/lib/access";
import { Card, EmptyState, cn } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { NewImportButton } from "@/components/compras/header-form";
import { fmtInt, fmtUsd } from "@/components/compras/format";
import { ComprasSubnav } from "@/components/compras/subnav";
import { comprasPerms, loadImportList, loadSuppliers, resolveComprasOrg, type ImportListRow } from "@/lib/compras-server";
import {
  IMPORT_STATUS_LABEL,
  IMPORT_TABS,
  formatDmy,
  importAlerts,
  importChecklist,
  inImportTab,
  isActiveStatus,
  isUuid,
  limaToday,
  trackingPublicUrl,
  type ImportTab,
} from "@/lib/compras";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ v?: string; org?: string; proveedor?: string }>;

export default function ComprasPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <ComprasContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ComprasContent({ searchParams }: { searchParams: SearchParams }) {
  const [{ isVendedoraOnly }, sp] = await Promise.all([getUserRoleSummary(), searchParams]);
  if (isVendedoraOnly) redirect("/dashboard/leads");

  // La organización donde tiene «Compras» o «Montos de compras» (MOM §16, §45).
  const { orgId, allowed } = await resolveComprasOrg(sp.org);
  if (!orgId) {
    return (
      <EmptyState title="Compras">
        Las importaciones las gestiona quien tiene el permiso «Compras» en su organización.
      </EmptyState>
    );
  }

  const perms = await comprasPerms(orgId);
  const [allRows, suppliers] = await Promise.all([loadImportList(orgId, perms.canMoney), loadSuppliers(orgId)]);
  const tab: ImportTab = IMPORT_TABS.some((t) => t.id === sp.v) ? (sp.v as ImportTab) : "activas";
  // `?proveedor=<id>` (se llega desde Proveedores): solo un proveedor de esta organización.
  const supplierFilter = isUuid(sp.proveedor) ? (suppliers.find((s) => s.id === sp.proveedor) ?? null) : null;
  const rows = supplierFilter ? allRows.filter((r) => r.imp.supplier_id === supplierFilter.id) : allRows;
  const today = limaToday();
  const enriched = rows.map((row) => ({
    row,
    alerts: importAlerts(
      { status: row.imp.status, eta: row.imp.eta, reportedAt: row.imp.reported_to_warehouse_at, lastMovementAt: row.lastMovementAt },
      today,
    ),
    checklist: importChecklist(row.docKinds, row.imp.tracking_number),
  }));
  const visible = enriched.filter((e) => inImportTab(e.row.imp.status, tab));
  const active = enriched.filter((e) => isActiveStatus(e.row.imp.status));
  const counts = Object.fromEntries(IMPORT_TABS.map((t) => [t.id, enriched.filter((e) => inImportTab(e.row.imp.status, t.id)).length]));
  const late = active.filter((e) => e.alerts.late).length;
  const notify = active.filter((e) => e.alerts.notifyWarehouse).length;
  const stale = active.filter((e) => e.alerts.stale).length;
  const inTransitUsd = perms.canMoney
    ? active.filter((e) => e.row.imp.status !== "cotizacion").reduce((a, e) => a + (e.row.money?.totalUsd ?? 0), 0)
    : null;
  const orgQuery = `${allowed.length > 1 ? `&org=${orgId}` : ""}${supplierFilter ? `&proveedor=${supplierFilter.id}` : ""}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Compras</h1>
          <p className="text-xs text-slate-500">
            Importaciones a la bodega de Kapta en Lima: productos, documentos, costos, pagos y recepción.
          </p>
        </div>
        {perms.canManage && <NewImportButton orgId={orgId} suppliers={suppliers} />}
      </div>

      <ComprasSubnav current="importaciones" perms={perms} orgId={orgId} multiOrg={allowed.length > 1} />

      {supplierFilter && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <span className="rounded-full bg-brand-50 px-2.5 py-1 font-medium text-brand-700">Proveedor: {supplierFilter.name}</span>
          <Link
            href={`/dashboard/compras?v=${tab}${allowed.length > 1 ? `&org=${orgId}` : ""}`}
            className="text-xs text-slate-500 hover:text-slate-900 hover:underline"
          >
            Quitar filtro
          </Link>
        </p>
      )}

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">{active.length} activas</span>
        {inTransitUsd !== null && (
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">{fmtUsd(inTransitUsd)} en camino</span>
        )}
        {notify > 0 && <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-800">{notify} sin avisar a la bodega</span>}
        {late > 0 && <span className="rounded-full bg-red-100 px-2.5 py-1 font-semibold text-red-700">{late} atrasadas</span>}
        {stale > 0 && <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-800">{stale} sin novedades</span>}
      </div>

      <nav className="flex flex-wrap gap-1.5" aria-label="Pestañas de importaciones">
        {IMPORT_TABS.map((t) => (
          <Link
            key={t.id}
            href={`/dashboard/compras?v=${t.id}${orgQuery}`}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition",
              t.id === tab ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50",
            )}
          >
            {t.label} <span className="text-xs text-slate-400">{counts[t.id]}</span>
          </Link>
        ))}
      </nav>

      {!visible.length ? (
        <EmptyState title="Sin importaciones aquí">
          {perms.canManage ? "Crea una con «Nueva importación»." : "Cuando se registre una, aparecerá aquí."}
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {visible.map(({ row, alerts, checklist }) => (
            <ImportCard key={row.imp.id} row={row} alerts={alerts} checklist={checklist} canMoney={perms.canMoney} />
          ))}
        </div>
      )}
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", ok ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}

function ImportCard({
  row,
  alerts,
  checklist,
  canMoney,
}: {
  row: ImportListRow;
  alerts: ReturnType<typeof importAlerts>;
  checklist: { invoice: boolean; tracking: boolean };
  canMoney: boolean;
}) {
  const { imp } = row;
  const link = trackingPublicUrl({ carrier: imp.carrier, trackingNumber: imp.tracking_number, trackingUrl: imp.tracking_url });
  const active = isActiveStatus(imp.status);
  const pending = row.money ? Math.max(0, row.money.totalUsd - row.money.paidUsd) : 0;
  return (
    <Card className="p-4">
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/dashboard/compras/${imp.id}`} className="font-semibold text-brand-700 hover:underline">
              {imp.code}
            </Link>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">{IMPORT_STATUS_LABEL[imp.status]}</span>
          </div>
          <p className="truncate text-sm text-slate-700">
            {row.supplierName ?? "Sin proveedor"}
            {imp.platform_order ? <span className="text-slate-400"> · orden {imp.platform_order}</span> : null}
          </p>
          <p className="truncate text-xs text-slate-500">
            {row.items.slice(0, 3).map((it) => `${fmtInt(it.qty)} × ${it.name}`).join(" · ") || "Sin productos"}
            {row.items.length > 3 ? ` · +${row.items.length - 3}` : ""}
          </p>
          <div className="flex flex-wrap gap-1">
            <Check ok={checklist.invoice} label="Factura comercial" />
            <Check ok={checklist.tracking} label="Tracking" />
          </div>
        </div>
        <div className="text-sm">
          <p className="text-xs text-slate-500">Unidades</p>
          <p className="font-medium text-slate-900">
            {fmtInt(row.units)} <span className="text-xs font-normal text-slate-500">en {row.items.length} productos</span>
          </p>
          {alerts.stale && <p className="text-xs font-medium text-amber-700">Sin novedades hace {alerts.daysSinceMovement} días</p>}
        </div>
        <div className="text-sm">
          <p className="text-xs text-slate-500">{imp.arrived_on ? "Llegó" : "Llegada estimada"}</p>
          <p className={cn("font-medium", alerts.late ? "text-red-700" : "text-slate-900")}>
            {formatDmy(imp.arrived_on ?? imp.eta)}
            {alerts.late ? " · atrasada" : ""}
          </p>
          {imp.tracking_number && (
            <p className="truncate text-xs text-slate-500">
              {imp.carrier ?? "Guía"}{" "}
              {link ? (
                <a href={link} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">
                  {imp.tracking_number}
                </a>
              ) : (
                imp.tracking_number
              )}
            </p>
          )}
          {active && imp.status !== "cotizacion" && (
            <p className={cn("text-xs font-medium", imp.reported_to_warehouse_at ? "text-emerald-700" : alerts.notifyWarehouse ? "text-amber-700" : "text-slate-400")}>
              Bodega: {imp.reported_to_warehouse_at ? "Reportada" : alerts.notifyWarehouse ? "Avisar" : "—"}
            </p>
          )}
        </div>
        {canMoney && row.money && (
          <div className="text-sm">
            <p className="text-xs text-slate-500">Costo total</p>
            <p className="font-medium text-slate-900">{fmtUsd(row.money.totalUsd)}</p>
            <p className="text-xs text-slate-500">
              Pagado {fmtUsd(row.money.paidUsd)}
              {pending > 0.005 ? <span className="text-amber-700"> · falta {fmtUsd(pending)}</span> : null}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
