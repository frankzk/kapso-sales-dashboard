import Link from "next/link";
import { getAccessibleStores } from "@/lib/access";
import { getMasterPermissions, orgsWithPermission } from "@/lib/permissions-access";
import { getReturnsReceptionData } from "@/lib/dispatch-access";
import { listReturnManifestRiders, listReturnManifests } from "@/lib/return-manifest-access";
import { RETURN_MANIFEST_PERMISSION } from "@/lib/return-manifest";
import { EmptyState } from "@/components/ui";
import { ReturnsReception } from "@/components/returns-reception";
import { ReturnManifestList, ReturnsTabs } from "@/components/return-manifests";

export const dynamic = "force-dynamic";

type SP = { vista?: string; motorizado?: string };

/**
 * Devoluciones (MOM §9.4): dos pestañas. «Recepción» es el cuadre de siempre
 * (Tanders, Shalom y la caja suelta de Grupo GF); «Manifiestos» es el registro
 * de lo que trae de golpe un motorizado de Grupo GF (0307, owner 04-11-2026).
 */
export default async function ReturnsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, stores, permissions] = await Promise.all([searchParams, getAccessibleStores(), getMasterPermissions()]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  if (!permissions.can(RETURN_MANIFEST_PERMISSION)) {
    return (
      <EmptyState title="No tienes acceso al almacén">
        <Link href="/dashboard/pedidos" className="text-brand-600 underline">Volver al Master de Pedidos</Link>
      </EmptyState>
    );
  }
  if (sp.vista === "manifiestos") {
    const orgs = await orgsWithPermission(RETURN_MANIFEST_PERMISSION);
    // Sin la 0307 las tablas no existen: la pestaña lo dice en vez de caerse.
    const [manifests, riders] = await Promise.all([
      listReturnManifests().then((rows) => ({ rows, error: null as string | null }), (cause: unknown) => ({ rows: [], error: cause instanceof Error ? cause.message : String(cause) })),
      Promise.all(orgs.map((org) => listReturnManifestRiders(org.org_id).catch(() => []))).then((lists) => lists.flat()),
    ]);
    return (
      <ReturnManifestList
        tabs={<ReturnsTabs active="manifiestos" />}
        manifests={manifests.rows}
        loadError={manifests.error}
        riders={riders}
        preselectRiderId={typeof sp.motorizado === "string" ? sp.motorizado : null}
      />
    );
  }
  const data = await getReturnsReceptionData();
  return <ReturnsReception initialData={data} nav={<ReturnsTabs active="recepcion" />} />;
}
