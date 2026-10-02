import { redirect } from "next/navigation";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { getAnomalyReport } from "@/lib/leads-access";
import { StoresOverview } from "@/components/stores-overview";

export const dynamic = "force-dynamic";

export default async function StoresPage() {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
  const stores = await getAccessibleStores();
  // Diagnóstico, no operación: vive acá y no en la cabecera de Leads porque las
  // asesoras leen esa línea todo el día buscando trabajo accionable. Esta página
  // ya redirige a las vendedoras, así que queda fuera de su vista por
  // construcción y no hace falta un permiso aparte.
  const anomalias = await getAnomalyReport(
    stores.map((s) => s.id),
    stores[0]?.timezone ?? "America/Lima",
  );
  return <StoresOverview stores={stores} anomalies={anomalias} />;
}
