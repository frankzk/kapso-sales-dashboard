import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { ComprasSubnav } from "@/components/compras/subnav";
import { ComprasGate, ComprasHeader } from "@/components/compras/chrome";
import { ReportsView } from "@/components/compras/reports-view";
import { comprasPerms, loadReportImports, loadSuppliers, resolveComprasOrg } from "@/lib/compras-server";
import { limaToday } from "@/lib/compras";

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

async function ReportesContent({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const [{ isVendedoraOnly }, sp] = await Promise.all([getUserRoleSummary(), searchParams]);
  if (isVendedoraOnly) redirect("/dashboard/leads");

  // Solo las organizaciones donde tiene «Montos de compras».
  const { orgId, allowed } = await resolveComprasOrg(sp.org, "money");
  if (!orgId) {
    return <ComprasGate title="Reportes de Compras">Los reportes de compras piden el permiso «Montos de compras».</ComprasGate>;
  }
  const perms = await comprasPerms(orgId);
  if (!perms.canMoney) {
    return <ComprasGate title="Reportes de Compras">Los reportes de compras piden el permiso «Montos de compras».</ComprasGate>;
  }

  const [imports, suppliers, stores] = await Promise.all([
    loadReportImports(orgId, perms.canMoney),
    loadSuppliers(orgId),
    getAccessibleStores(),
  ]);
  const storeName = new Map(stores.filter((s) => s.org_id === orgId).map((s) => [s.id, s.name]));

  return (
    <div className="space-y-6">
      <ComprasHeader title="Compras">
        Reportes en USD (con soles donde la importación tiene tipo de cambio). Las cotizaciones y las canceladas no cuentan como compras; los
        meses son de Lima.
      </ComprasHeader>
      <ComprasSubnav current="reportes" perms={perms} orgId={orgId} multiOrg={allowed.length > 1} />
      <ReportsView
        imports={imports}
        suppliers={suppliers}
        storeName={storeName}
        today={limaToday()}
        orgQuery={allowed.length > 1 ? `&org=${orgId}` : ""}
      />
    </div>
  );
}
