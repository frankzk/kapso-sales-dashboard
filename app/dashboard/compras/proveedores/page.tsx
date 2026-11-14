import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getUserRoleSummary } from "@/lib/access";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { ComprasSubnav } from "@/components/compras/subnav";
import { SuppliersView, type SupplierViewRow } from "@/components/compras/suppliers";
import { comprasPerms, loadReportImports, loadSuppliers, resolveComprasOrg } from "@/lib/compras-server";
import { supplierStats } from "@/lib/compras-reportes";

export const dynamic = "force-dynamic";

// Proveedores (MOM §45.7). Ver: «Compras» o «Montos de compras» en la
// organización. Crear, editar y borrar: «Compras» (las acciones lo vuelven a
// pedir). «Comprado (USD)»: solo con «Montos de compras»; sin él, el servidor
// ni lee los montos (`loadReportImports(orgId, perms.canMoney)`).

export default function ProveedoresPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <ProveedoresContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ProveedoresContent({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const [{ isVendedoraOnly }, sp] = await Promise.all([getUserRoleSummary(), searchParams]);
  if (isVendedoraOnly) redirect("/dashboard/leads");

  const { orgId, allowed } = await resolveComprasOrg(sp.org);
  if (!orgId) {
    return (
      <EmptyState title="Proveedores">
        Los proveedores de las importaciones los ve quien tiene «Compras» o «Montos de compras» en su organización.
      </EmptyState>
    );
  }
  const perms = await comprasPerms(orgId);
  if (!perms.canManage && !perms.canMoney) {
    return <EmptyState title="Proveedores">Hace falta el permiso «Compras» o «Montos de compras».</EmptyState>;
  }
  const [suppliers, imports] = await Promise.all([loadSuppliers(orgId), loadReportImports(orgId, perms.canMoney)]);
  const rows: SupplierViewRow[] = suppliers.map((supplier) => ({
    supplier,
    stats: supplierStats(supplier.id, imports, { money: perms.canMoney }),
  }));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Compras</h1>
        <p className="text-xs text-slate-500">
          A quién le compras, cuánto tarda, si llega a tiempo y qué tan completo llega. Las cotizaciones y las canceladas no
          cuentan como compras.
        </p>
      </div>
      <ComprasSubnav current="proveedores" perms={perms} orgId={orgId} multiOrg={allowed.length > 1} />
      <SuppliersView
        orgId={orgId}
        orgQuery={allowed.length > 1 ? `&org=${orgId}` : ""}
        rows={rows}
        canManage={perms.canManage}
        canMoney={perms.canMoney}
      />
    </div>
  );
}
