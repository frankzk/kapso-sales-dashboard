import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import { createServerSupabase } from "@/lib/db";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { UrpiProgrammingBoard } from "@/components/urpi-programming-board";
import { urpiGoogleConfigured } from "@/lib/urpi-google-sheets";
import type { UrpiSource, UrpiSnapshot } from "@/lib/urpi-programming-db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Params = { source?: string; version?: string };

export default function UrpiPage({ searchParams }: { searchParams: Promise<Params> }) {
  return <Suspense fallback={<DashboardRouteSkeleton />}><UrpiContent searchParams={searchParams} /></Suspense>;
}

async function UrpiContent({ searchParams }: { searchParams: Promise<Params> }) {
  const [stores, params, sb] = await Promise.all([getAccessibleStores(), searchParams, createServerSupabase()]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  const permissions = new Map(await Promise.all([...new Set(stores.map((store) => store.org_id))].map(async (orgId) => {
    const [manage, edit] = await Promise.all([hasOrgPermission(orgId, "sheets.manage"), hasOrgPermission(orgId, "sheets.edit")]);
    return [orgId, { manage, edit }] as const;
  })));
  const { data, error } = await sb.from("urpi_programming_sources").select("*").in("store_id", stores.map((store) => store.id)).order("month", { ascending: false }).order("name").limit(500);
  if (error) return <EmptyState title="Programaciones Urpi todavía no está disponible">No se pudo cargar el registro de archivos. Contacta al administrador si el problema continúa.</EmptyState>;
  const sources = (data ?? []) as UrpiSource[];
  const source = sources.find((item) => item.id === params.source) ?? sources[0] ?? null;
  let snapshot: UrpiSnapshot | null = null;
  let versions: Pick<UrpiSnapshot, "id" | "created_at" | "origin" | "row_count">[] = [];
  if (source) {
    const { data: history, error: historyError } = await sb.from("urpi_programming_snapshots").select("id,created_at,origin,row_count")
      .eq("source_id", source.id).order("created_at", { ascending: false }).limit(100);
    if (historyError) return <EmptyState title="No se pudo leer el historial de Urpi">Vuelve a cargar la página.</EmptyState>;
    versions = history ?? [];
    const versionId = params.version && versions.some((item) => item.id === params.version) ? params.version : source.current_snapshot_id;
    if (versionId) {
      const { data: stored, error: snapshotError } = await sb.from("urpi_programming_snapshots").select("*").eq("source_id", source.id).eq("id", versionId).maybeSingle();
      if (snapshotError) return <EmptyState title="No se pudo leer la programación">La última versión se conserva. Vuelve a cargar la página.</EmptyState>;
      snapshot = stored as UrpiSnapshot | null;
    }
  }
  return <UrpiProgrammingBoard
    key={`${source?.id ?? "empty"}:${snapshot?.id ?? "empty"}`}
    stores={stores.map((store) => ({ id: store.id, name: store.name, canManage: permissions.get(store.org_id)?.manage ?? false, canEdit: permissions.get(store.org_id)?.edit ?? false }))}
    sources={sources} source={source} snapshot={snapshot} versions={versions} googleConfigured={urpiGoogleConfigured()}
  />;
}
