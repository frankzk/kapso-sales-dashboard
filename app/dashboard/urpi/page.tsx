import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import { createServerSupabase } from "@/lib/db";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { UrpiProgrammingBoard } from "@/components/urpi-programming-board";
import { urpiGoogleConfigured } from "@/lib/urpi-google-sheets";
import { urpiAutoEnabled } from "@/lib/urpi-auto-sync";
import { urpiStorePrefix } from "@/lib/urpi-programming";
import type { UrpiSource, UrpiSnapshot } from "@/lib/urpi-programming-db";
import { UrpiResultsBoard } from "@/components/urpi-results-board";
import { UrpiViewNav } from "@/components/urpi-view-nav";
import { buildUrpiShipments, type UrpiOrderFacts, type UrpiStoredRow } from "@/lib/urpi-report-view";
import { macroStageLabel, macroSubstageLabel } from "@/lib/order-macro-stage";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Params = { source?: string; version?: string; vista?: string };
/** Resultados de Urpi: los últimos 60 días de intentos (MOM §30.11). */
const RESULTS_DAYS = 60;

export default function UrpiPage({ searchParams }: { searchParams: Promise<Params> }) {
  return <Suspense fallback={<DashboardRouteSkeleton />}><UrpiContent searchParams={searchParams} /></Suspense>;
}

async function UrpiContent({ searchParams }: { searchParams: Promise<Params> }) {
  const [stores, params, sb] = await Promise.all([getAccessibleStores(), searchParams, createServerSupabase()]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  // Kenku y Aurela comparten organización y un solo libro de Urpi.
  if (params.vista === "resultados") return <UrpiResultsContent orgId={stores[0]!.org_id} />;
  const permissions = new Map(await Promise.all([...new Set(stores.map((store) => store.org_id))].map(async (orgId) => {
    const [manage, edit] = await Promise.all([hasOrgPermission(orgId, "sheets.manage"), hasOrgPermission(orgId, "sheets.edit")]);
    return [orgId, { manage, edit }] as const;
  })));
  const [{ data, error }, { data: prefixRows }] = await Promise.all([
    sb.from("urpi_programming_sources").select("*").in("store_id", stores.map((store) => store.id)).order("month", { ascending: false }).order("name").limit(500),
    // El prefijo sale de la tienda (0115); sin él, el formulario no la registra.
    sb.from("stores").select("id,order_prefix").in("id", stores.map((store) => store.id)),
  ]);
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
    nav={<UrpiViewNav active="programaciones" />}
    key={`${source?.id ?? "empty"}:${snapshot?.id ?? "empty"}`}
    stores={stores.map((store) => ({ id: store.id, name: store.name, prefix: urpiStorePrefix(prefixRows?.find((row) => row.id === store.id)?.order_prefix), canManage: permissions.get(store.org_id)?.manage ?? false, canEdit: permissions.get(store.org_id)?.edit ?? false }))}
    sources={sources} source={source} snapshot={snapshot} versions={versions} googleConfigured={urpiGoogleConfigured()}
    autoSyncEnabled={urpiAutoEnabled() && process.env.VERCEL_ENV === "production"}
  />;
}

async function UrpiResultsContent({ orgId }: { orgId: string }) {
  const sb = await createServerSupabase();
  const cutoff = new Date(Date.now() - RESULTS_DAYS * 86400000).toISOString().slice(0, 10);
  const [canImport, canApply, rowsRes, lastRes] = await Promise.all([
    hasOrgPermission(orgId, "sheets.edit"),
    hasOrgPermission(orgId, "master.edit"),
    sb.from("urpi_report_rows").select("urpi_row,previous_row,report_date,result_code,data,order_id,store_id,link_status,link_method,candidate_order_ids")
      .eq("org_id", orgId).gte("report_date", cutoff).order("urpi_row", { ascending: false }).limit(5000),
    sb.from("urpi_report_imports").select("created_at,filename,row_count,new_count,changed_count").eq("org_id", orgId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (rowsRes.error) return <EmptyState title="Resultados de Urpi todavía no está disponible">No se pudo leer el reporte. Si es la primera vez, falta aplicar la migración 0229.</EmptyState>;
  const rows = (rowsRes.data ?? []) as UrpiStoredRow[];
  const ids = [...new Set(rows.flatMap((row) => [row.order_id, ...row.candidate_order_ids]).filter((id): id is string => Boolean(id)))];
  const facts = new Map<string, UrpiOrderFacts>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("order_master")
      .select("order_id,store_id,order_name,customer_name,general_status,macro_stage,macro_substage,order_total,orders(cancelled_at)").in("order_id", ids.slice(i, i + 200));
    if (error) return <EmptyState title="No se pudo leer el estado de los pedidos">Vuelve a cargar la página.</EmptyState>;
    for (const row of (data ?? []) as unknown as (UrpiOrderFacts & { macro_substage: string | null; orders: { cancelled_at: string | null } | null })[]) {
      const stage = [macroStageLabel(row.macro_stage), row.macro_substage ? macroSubstageLabel(row.macro_substage) : ""].filter(Boolean).join(" · ");
      facts.set(row.order_id, {
        order_id: row.order_id, store_id: row.store_id, order_name: row.order_name, customer_name: row.customer_name, general_status: row.general_status,
        macro_stage: row.macro_stage, order_total: row.order_total, cancelled_at: row.orders?.cancelled_at ?? null, stage_label: stage,
      });
    }
  }
  return <UrpiResultsBoard
    nav={<UrpiViewNav active="resultados" />}
    orgId={orgId} canImport={canImport} canApply={canApply} days={RESULTS_DAYS}
    lastImport={lastRes.data ?? null} shipments={buildUrpiShipments(rows, facts)}
  />;
}
