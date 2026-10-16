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
import { buildUrpiShipments, URPI_OBSERVATION_RESOLVED, type UrpiOrderFacts, type UrpiStoredRow } from "@/lib/urpi-report-view";
import { planUrpiSalida, type UrpiSalidaCandidate } from "@/lib/urpi-salida";
import { olderDeliveredOrderIds, type UrpiAttemptRef } from "@/lib/urpi-results-window";
import { macroStageLabel, macroSubstageLabel } from "@/lib/order-macro-stage";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Params = { source?: string; version?: string; vista?: string };
/** Resultados de Urpi: los últimos 60 días de intentos (MOM §30.11), más los
 *  entregados de antes cuya salida «por definir» sigue por rellenar. */
const RESULTS_DAYS = 60;
const ROW_COLUMNS = "urpi_row,previous_row,report_date,result_code,data,order_id,store_id,link_status,link_method,candidate_order_ids";
type Supabase = Awaited<ReturnType<typeof createServerSupabase>>;

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
    sb.from("urpi_report_rows").select(ROW_COLUMNS)
      .eq("org_id", orgId).gte("report_date", cutoff).order("urpi_row", { ascending: false }).limit(5000),
    sb.from("urpi_report_imports").select("created_at,filename,row_count,new_count,changed_count").eq("org_id", orgId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (rowsRes.error) return <EmptyState title="Resultados de Urpi todavía no está disponible">No se pudo leer el reporte. Si es la primera vez, falta aplicar la migración 0229.</EmptyState>;
  const windowRows = (rowsRes.data ?? []) as UrpiStoredRow[];
  const rows = [...windowRows, ...await olderSalidaPendingRows(sb, orgId, cutoff, windowRows)];
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
  // Observaciones ya cerradas con motivo: el último cierre de cada pedido.
  const observed = [...facts.values()].filter((fact) => fact.cancelled_at || fact.general_status === "devuelto").map((fact) => fact.order_id);
  for (let i = 0; i < observed.length; i += 200) {
    const { data } = await sb.from("order_events").select("order_id,reason,occurred_at,payload")
      .eq("kind", URPI_OBSERVATION_RESOLVED).in("order_id", observed.slice(i, i + 200));
    for (const event of (data ?? []) as { order_id: string; reason: string | null; occurred_at: string; payload: { urpi_row?: number } | null }[]) {
      const fact = facts.get(event.order_id)!;
      const urpiRow = Number(event.payload?.urpi_row ?? 0);
      if (!fact.observation_resolved || fact.observation_resolved.urpiRow < urpiRow) fact.observation_resolved = { urpiRow, note: event.reason ?? "", at: event.occurred_at };
    }
  }
  // Entregados cuya caja sigue «por definir»: se rellenan como salida de Urpi.
  const delivered = [...facts.values()].filter((fact) => fact.general_status === "entregado").map((fact) => fact.order_id);
  const pending = await salidaPendingIds(sb, delivered);
  for (const id of delivered) facts.get(id)!.salida_pending = pending.has(id);
  return <UrpiResultsBoard
    nav={<UrpiViewNav active="resultados" />}
    orgId={orgId} canImport={canImport} canApply={canApply} days={RESULTS_DAYS}
    lastImport={lastRes.data ?? null} shipments={buildUrpiShipments(rows, facts)}
  />;
}

/** De estos pedidos entregados, los que tienen la salida «por definir» que se
 *  puede rellenar como salida de Urpi (lib/urpi-salida.ts). */
async function salidaPendingIds(sb: Supabase, delivered: readonly string[]): Promise<Set<string>> {
  const salidas = new Map<string, UrpiSalidaCandidate[]>();
  for (let i = 0; i < delivered.length; i += 200) {
    const { data } = await sb.from("shipments")
      .select("id,order_id,courier,created_via,delivery_status,custody_state,custody_transferred_at,returned_at,output_number").in("order_id", delivered.slice(i, i + 200));
    for (const row of (data ?? []) as (UrpiSalidaCandidate & { order_id: string })[]) salidas.set(row.order_id, [...(salidas.get(row.order_id) ?? []), row]);
  }
  return new Set(delivered.filter((id) => planUrpiSalida(salidas.get(id) ?? []).kind === "rellenar"));
}

/**
 * Los intentos de los pedidos que Urpi entregó ANTES de la ventana y cuya caja
 * sigue «por definir» (lib/urpi-results-window.ts). Sin esto el aviso «Pasar a
 * salida de Urpi entregada» no los veía y nadie podía rellenarlos. Para no
 * cargar historia, de los viejos se leen solo tres columnas, y enteros solo los
 * que tienen la salida pendiente. Si una lectura falla, la pantalla sigue con la
 * ventana, como antes.
 */
async function olderSalidaPendingRows(sb: Supabase, orgId: string, cutoff: string, windowRows: readonly UrpiStoredRow[]): Promise<UrpiStoredRow[]> {
  const attempts: UrpiAttemptRef[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("urpi_report_rows").select("order_id,urpi_row,result_code")
      .eq("org_id", orgId).lt("report_date", cutoff).not("order_id", "is", null).order("urpi_row").range(from, from + 999);
    if (error) return [];
    attempts.push(...((data ?? []) as UrpiAttemptRef[]));
    if ((data ?? []).length < 1000) break;
  }
  const inWindow = new Set(windowRows.map((row) => row.order_id).filter((id): id is string => Boolean(id)));
  const candidates = olderDeliveredOrderIds(attempts, inWindow);
  const entregados: string[] = [];
  for (let i = 0; i < candidates.length; i += 200) {
    const { data, error } = await sb.from("order_master").select("order_id").eq("general_status", "entregado").in("order_id", candidates.slice(i, i + 200));
    if (error) return [];
    entregados.push(...((data ?? []) as { order_id: string }[]).map((row) => row.order_id));
  }
  const pending = [...await salidaPendingIds(sb, entregados)];
  const rows: UrpiStoredRow[] = [];
  for (let i = 0; i < pending.length; i += 200) {
    const { data, error } = await sb.from("urpi_report_rows").select(ROW_COLUMNS).eq("org_id", orgId).in("order_id", pending.slice(i, i + 200));
    if (error) return [];
    rows.push(...((data ?? []) as UrpiStoredRow[]));
  }
  return rows;
}
