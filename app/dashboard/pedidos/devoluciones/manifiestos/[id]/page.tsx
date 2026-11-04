import Link from "next/link";
import { notFound } from "next/navigation";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getReturnManifestDetail } from "@/lib/return-manifest-access";
import { RETURN_MANIFEST_PERMISSION, RETURN_MANIFESTS_TAB_PATH } from "@/lib/return-manifest";
import { EmptyState } from "@/components/ui";
import { ReturnManifestDetailView } from "@/components/return-manifest-detail";

export const dynamic = "force-dynamic";

/**
 * Un manifiesto de devolución (0307, MOM §9.4 y §29.13): cabecera, escáner,
 * contador, los tres paneles y el acta. Permiso de Almacén en SU organización
 * (lo comprueba el cargador); sin él, o de otra organización, no existe.
 */
export default async function ReturnManifestPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, permissions] = await Promise.all([params, getMasterPermissions()]);
  if (!permissions.can(RETURN_MANIFEST_PERMISSION)) {
    return (
      <EmptyState title="No tienes acceso al almacén">
        <Link href="/dashboard/pedidos" className="text-brand-600 underline">Volver al Master de Pedidos</Link>
      </EmptyState>
    );
  }
  const detail = await getReturnManifestDetail(id).catch((cause: unknown) => {
    console.error("[return-manifest] detail", id, cause instanceof Error ? cause.message : cause);
    return null;
  });
  if (!detail) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
    return (
      <EmptyState title="No encontramos ese manifiesto de devolución">
        <Link href={RETURN_MANIFESTS_TAB_PATH} className="text-brand-600 underline">Volver a Manifiestos</Link>
      </EmptyState>
    );
  }
  return <ReturnManifestDetailView detail={detail} />;
}
