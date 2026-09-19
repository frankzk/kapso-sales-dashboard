import { Suspense } from "react";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { SheetsBoard } from "@/components/sheets-board";
import { computeRows } from "@/lib/sheets/engine";
import { limaMonthKey } from "@/lib/sheets/resolver";
import {
  countOpenObservations,
  ensureSheetsInitialized,
  getSheetWorkspace,
  loadAliases,
  loadContributions,
  loadObservations,
  loadOrderFacts,
  loadOrderFactsByIds,
  loadStoredRows,
  loadStoredRowsByMonth,
  loadStoredRowsFor,
} from "@/lib/sheets/access";
import { CATALOGO_ZONAS_KEY, isCuadernoSheet } from "@/lib/sheets/templates";
import { syncRiderMonthStops } from "@/lib/sheets/stop-sync";
import { createAdminSupabase } from "@/lib/db";
import type { Contribution, StoredRow } from "@/lib/sheets/types";

export const dynamic = "force-dynamic";

type SP = { hoja?: string; mes?: string; q?: string; org?: string; panel?: string };

export default function Liquidaciones2Page({ searchParams }: { searchParams: Promise<SP> }) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <Liquidaciones2Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Liquidaciones2Content({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, stores, perms, user] = await Promise.all([
    searchParams,
    getAccessibleStores(),
    getMasterPermissions(),
    getCurrentUser(),
  ]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;

  const orgIds = [...new Set(stores.map((s) => s.org_id))];
  const orgId = sp.org && orgIds.includes(sp.org) ? sp.org : orgIds[0];
  if (!orgId) return <EmptyState title="No tienes tiendas asignadas" />;
  const canManage = perms.can("sheets.manage");
  const canEdit = perms.can("sheets.edit");

  // La primera visita de alguien que puede configurar deja la organización
  // sembrada; también crea las hojas de una tienda conectada después.
  if (canManage) {
    try {
      await ensureSheetsInitialized(orgId, stores, user?.id ?? null);
    } catch (e) {
      // Casi siempre es que la 0168 no está aplicada (DEPLOY.md): decirlo
      // vale más que una pantalla rota.
      return (
        <EmptyState title="Liquidaciones 2 no pudo inicializarse">
          {e instanceof Error ? e.message : String(e)}. Comprueba que la migración 0168 esté aplicada.
        </EmptyState>
      );
    }
  }

  const workspace = await getSheetWorkspace(orgId);
  if (!workspace.domains.length) {
    return (
      <EmptyState title="Liquidaciones 2 todavía no está inicializado">
        Pide a un administrador que entre a esta pantalla: la primera visita crea los dominios y las hojas.
      </EmptyState>
    );
  }

  const consolidado = workspace.sheets.find((s) => workspace.domains.find((d) => d.id === s.domain_id)?.key === "consolidado");
  const sheet =
    workspace.sheets.find((s) => s.key === sp.hoja) ?? consolidado ?? workspace.sheets[0] ?? null;
  const domain = sheet ? workspace.domains.find((d) => d.id === sheet.domain_id) ?? null : null;

  const month = sp.q ? null : sp.mes?.trim() === "todos" ? null : (sp.mes?.trim() || limaMonthKey(new Date().toISOString()));
  const search = sp.q?.trim() || null;

  let rows: ReturnType<typeof computeRows> = [];
  let truncated = false;
  const LIMIT = 3000;
  if (sheet && domain) {
    const catalogSheet = workspace.sheets.find((s) => s.key === CATALOGO_ZONAS_KEY);
    const lookups: { key: string; rows: StoredRow[] }[] = [];
    if (catalogSheet && catalogSheet.id !== sheet.id) {
      lookups.push({ key: catalogSheet.key, rows: await loadStoredRows(catalogSheet.id, 10000) });
    }
    if (domain.row_key === "pedido" && sheet.store_id) {
      const facts = await loadOrderFacts({ storeId: sheet.store_id, month, search, limit: LIMIT });
      truncated = facts.length >= LIMIT;
      const [stored, byOrderId] = await Promise.all([
        loadStoredRowsFor(sheet.id, facts.map((f) => f.order_name ?? f.order_id)),
        domain.key === "consolidado" ? loadContributions(orgId, facts.map((f) => f.order_id)) : Promise.resolve(new Map<string, Contribution[]>()),
      ]);
      // El motor indexa los aportes por nº de pedido, que es lo que ve la gente.
      const contributions = new Map<string, Contribution[]>();
      for (const f of facts) {
        const list = byOrderId.get(f.order_id);
        if (list && f.order_name) contributions.set(f.order_name, list);
      }
      rows = computeRows({ rowKey: "pedido", columns: sheet.columns, facts, stored, lookups, contributions });
    } else {
      // Las hojas de reparto se miran por mes (columna `fecha`); los catálogos, enteros.
      // La parada es la verdad (MOM §29.12): antes de pintar el mes, las paradas
      // del motorizado que aún no tienen fila se traen a la hoja.
      const riderId = typeof sheet.config.rider_id === "string" ? sheet.config.rider_id : null;
      if (isCuadernoSheet(sheet, domain) && riderId && month && !search && canEdit) {
        try {
          await syncRiderMonthStops(createAdminSupabase(), { orgId, riderId, month, actor: user?.id ?? null });
        } catch (e) {
          console.error("[liquidaciones-2] sincronización de paradas", e instanceof Error ? e.message : e);
        }
      }
      const stored =
        isCuadernoSheet(sheet, domain) && month && !search
          ? await loadStoredRowsByMonth(sheet.id, month, 10000)
          : await loadStoredRows(sheet.id, 10000);
      truncated = stored.length >= 10000;
      const filtered = search
        ? stored.filter((r) => JSON.stringify(r.values).toLowerCase().includes(search.toLowerCase()))
        : stored;
      // En cuaderno, el pedido vinculado se lee para «Estado en Kapta» y
      // «Monto Kapta» (MOM §30.8): lo que decide qué falta por aplicar.
      const linkedFacts = isCuadernoSheet(sheet, domain)
        ? await loadOrderFactsByIds(filtered.map((r) => r.order_id).filter((id): id is string => Boolean(id)))
        : undefined;
      rows = computeRows({ rowKey: domain.row_key, columns: sheet.columns, stored: filtered, lookups, linkedFacts });
    }
  }

  const [aliases, observations, sheetOpenObservations] = sheet
    ? await Promise.all([loadAliases(sheet.id), loadObservations(orgId, sheet.id, "abierta"), countOpenObservations(sheet.id)])
    : [[], [], 0];

  return (
    <SheetsBoard
      orgId={orgId}
      orgIds={orgIds}
      stores={stores.filter((s) => s.org_id === orgId).map((s) => ({ id: s.id, name: s.name }))}
      domains={workspace.domains}
      sheets={workspace.sheets}
      sheet={sheet}
      domain={domain}
      rows={rows}
      truncated={truncated}
      aliases={aliases}
      observations={observations}
      reasons={workspace.reasons}
      openObservations={workspace.openObservations}
      sheetOpenObservations={sheetOpenObservations}
      filters={{ month: month ?? (sp.mes?.trim() === "todos" ? "todos" : ""), search: search ?? "" }}
      lastImport={(sheet?.config as { last_import?: Record<string, unknown> } | undefined)?.last_import ?? null}
      canEdit={canEdit}
      canManage={canManage}
      canApplyMaster={perms.can("master.edit")}
      panel={sp.panel ?? null}
    />
  );
}
