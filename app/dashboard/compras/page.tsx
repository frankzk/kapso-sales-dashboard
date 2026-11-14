import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getUserRoleSummary } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { NewImportButton } from "@/components/compras/header-form";
import { ComprasSubnav } from "@/components/compras/subnav";
import { ImportListView } from "@/components/compras/import-list";
import { ComprasGate, ComprasHeader, IMPORT_ALERT_FILTERS, type ImportAlertFilter } from "@/components/compras/chrome";
import {
  COMPRAS_VIEW_PERMISSIONS,
  comprasPerms,
  loadImportList,
  loadSuppliers,
  resolveComprasOrg,
} from "@/lib/compras-server";
import { IMPORT_TABS, isImportKind, isUuid, limaToday, type ImportTab } from "@/lib/compras";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ v?: string; org?: string; proveedor?: string; alerta?: string; tipo?: string }>;

export default function ComprasPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <ComprasContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ComprasContent({ searchParams }: { searchParams: SearchParams }) {
  const [{ isVendedoraOnly }, sp, master] = await Promise.all([getUserRoleSummary(), searchParams, getMasterPermissions()]);
  // La vendedora con «Recepción de compras» (rol Almacén, MOM §45.11) sí entra.
  if (isVendedoraOnly && !COMPRAS_VIEW_PERMISSIONS.some((p) => master.can(p))) redirect("/dashboard/leads");

  // La organización donde tiene «Compras», «Montos de compras» o «Recepción de
  // compras» (MOM §16, §45, §45.11).
  const { orgId, allowed } = await resolveComprasOrg(sp.org, "view");
  if (!orgId) {
    return (
      <ComprasGate title="Compras">
        Las importaciones las gestiona quien tiene el permiso «Compras» en su organización.
      </ComprasGate>
    );
  }

  const perms = await comprasPerms(orgId);
  const [allRows, suppliers] = await Promise.all([loadImportList(orgId, perms.canMoney), loadSuppliers(orgId)]);
  const tab: ImportTab = IMPORT_TABS.some((t) => t.id === sp.v) ? (sp.v as ImportTab) : "activas";
  // `?proveedor=<id>` (se llega desde Proveedores): solo un proveedor de esta organización.
  const supplierFilter = isUuid(sp.proveedor) ? (suppliers.find((s) => s.id === sp.proveedor) ?? null) : null;
  // `?alerta=`: las píldoras de excepción (solo filtran la vista).
  const alerta = IMPORT_ALERT_FILTERS.some((f) => f.id === sp.alerta) ? (sp.alerta as ImportAlertFilter) : null;
  // `?tipo=`: importaciones o compras locales (MOM §45.12).
  const tipo = isImportKind(sp.tipo) ? sp.tipo : null;

  return (
    <div className="space-y-6">
      <ComprasHeader
        title="Compras"
        actions={perms.canManage ? <NewImportButton orgId={orgId} suppliers={suppliers} /> : undefined}
      >
        Importaciones y compras locales a laboratorios y maquilas, a la bodega de Kapta en Lima: productos, documentos, costos, pagos y entregas.
      </ComprasHeader>

      <ComprasSubnav current="importaciones" perms={perms} orgId={orgId} multiOrg={allowed.length > 1} />

      <ImportListView
        rows={allRows}
        suppliers={suppliers}
        supplierFilter={supplierFilter}
        tab={tab}
        alerta={alerta}
        tipo={tipo}
        canMoney={perms.canMoney}
        orgParam={allowed.length > 1 ? orgId : null}
        today={limaToday()}
        emptyAction={perms.canManage ? <NewImportButton orgId={orgId} suppliers={suppliers} /> : undefined}
      />
    </div>
  );
}
