import { Suspense } from "react";
import { getAccessibleStores } from "@/lib/access";
import { createAdminSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { OlvaCotejoBoard, type CotejoOrg, type CotejoRun } from "@/components/olva-cotejo-board";
import { formatOlvaTracking, parseOlvaTracking } from "@/lib/olva/tracking";
import type { CotejoResumen } from "@/lib/olva/portal-sync";

export const dynamic = "force-dynamic";
// El botón entra al portal de Olva y coteja en la misma petición.
export const maxDuration = 120;

export default function OlvaCotejoPage() {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <OlvaCotejoContent />
    </Suspense>
  );
}

async function OlvaCotejoContent() {
  const stores = await getAccessibleStores();
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  const orgIds = [...new Set(stores.map((s) => s.org_id))];
  const admin = createAdminSupabase();

  const [{ data: storeRows }, { data: runRows }, perms] = await Promise.all([
    admin
      .from("stores")
      .select("id,org_id,name,olva_portal_username,olva_portal_password_enc,olva_portal_ruc")
      .in("org_id", orgIds)
      .order("name"),
    admin
      .from("olva_portal_runs")
      .select("id,org_id,source,desde,hasta,ok,error,fetched,linked,resumen,created_at")
      .in("org_id", orgIds)
      .order("created_at", { ascending: false })
      .limit(60),
    Promise.all(orgIds.map(async (id) => [id, await hasOrgPermission(id, "master.edit")] as const)),
  ]);
  const canEdit = new Map(perms);
  const allStores = (storeRows ?? []) as {
    id: string;
    org_id: string;
    name: string;
    olva_portal_username: string | null;
    olva_portal_password_enc: string | null;
    olva_portal_ruc: string | null;
  }[];
  const runs = (runRows ?? []) as (CotejoRun & { org_id: string; resumen: CotejoResumen })[];

  // Lo que quedó por revisar puede haberse vinculado después, a mano o en otro
  // cotejo: se mira el estado de HOY, no el de la bitácora.
  const pendingTrackings = new Set<string>();
  for (const r of runs) {
    for (const row of r.resumen?.rows ?? []) {
      if (row.outcome === "revisar" || row.outcome === "sin_pareja") pendingTrackings.add(row.tracking);
    }
  }
  const liveLinked: Record<string, string | null> = {};
  const numbers = [...pendingTrackings]
    .map((t) => parseOlvaTracking(t))
    .flatMap((p) => (p.ok ? [p.value] : []));
  for (let i = 0; i < numbers.length; i += 200) {
    const { data } = await admin
      .from("shipments")
      .select("olva_tracking,olva_emision,order_name")
      .in("olva_tracking", numbers.slice(i, i + 200).map((n) => n.tracking));
    for (const s of (data ?? []) as { olva_tracking: string; olva_emision: string; order_name: string | null }[]) {
      liveLinked[formatOlvaTracking({ tracking: s.olva_tracking, emision: s.olva_emision })] = s.order_name;
    }
  }

  const orgs: CotejoOrg[] = orgIds.map((orgId) => {
    const own = allStores.filter((s) => s.org_id === orgId);
    const visible = stores.filter((s) => s.org_id === orgId);
    const history = runs.filter((r) => r.org_id === orgId);
    return {
      orgId,
      label: visible.map((s) => s.name).join(" · "),
      configured: own.some((s) => s.olva_portal_username && s.olva_portal_password_enc && s.olva_portal_ruc),
      canEdit: canEdit.get(orgId) ?? false,
      stores: visible.map((s) => ({ id: s.id, name: s.name })),
      latest: history.find((r) => r.ok) ?? null,
      history: history.slice(0, 8).map((r) => ({ ...r, resumen: undefined })),
    };
  });

  // Lo que dice el rótulo que llegó por correo de los envíos pendientes: el
  // pedido con ese teléfono, si lo hay, para proponerlo en «Vincular a pedido».
  const labelHints: Record<string, { suggested: string | null; note: string | null }> = {};
  for (let i = 0; i < numbers.length; i += 200) {
    const { data } = await admin
      .from("olva_email_labels")
      .select("olva_tracking,olva_emision,suggested_order_name,match_note")
      .in("olva_tracking", numbers.slice(i, i + 200).map((n) => n.tracking));
    for (const l of (data ?? []) as {
      olva_tracking: string;
      olva_emision: string;
      suggested_order_name: string | null;
      match_note: string | null;
    }[]) {
      labelHints[formatOlvaTracking({ tracking: l.olva_tracking, emision: l.olva_emision })] = {
        suggested: l.suggested_order_name,
        note: l.match_note,
      };
    }
  }

  return <OlvaCotejoBoard orgs={orgs} liveLinked={liveLinked} labelHints={labelHints} />;
}
