// «Cotejar Olva» (MOM §12), dentro de «Pago de diferencia» (MOM §44, owner
// 10-11-2026: «mudarla entera»). Las dos vistas —el cotejo del portal y los
// correos de Olva— como secciones de servidor: leen la base y entregan el
// tablero, sin título ni pestañas (los pone la página).
//
// Vincular pide «Gestionar pedidos» (`master.edit`) en la organización, como
// siempre (app/dashboard/olva/actions.ts): quien cobra la diferencia y gestiona
// pedidos también vincula.

import type { ReactNode } from "react";
import type { getAccessibleStores } from "@/lib/access";
import { createAdminSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { OlvaCotejoBoard, type CotejoOrg, type CotejoRun } from "@/components/olva-cotejo-board";
import { OlvaEmailLog } from "@/components/olva-email-log";
import { getOlvaEmailLog } from "@/lib/olva/email-log-access";
import { formatOlvaTracking, parseOlvaTracking } from "@/lib/olva/tracking";
import type { CotejoResumen } from "@/lib/olva/portal-sync";

type Stores = Awaited<ReturnType<typeof getAccessibleStores>>;

/** Lo que dice la página bajo el título en «Cotejar Olva». */
export const OLVA_COTEJO_DESCRIPTION: ReactNode = (
  <>
    Trae del portal de Olva los envíos que registró la empresa y les pone el tracking a las salidas de Kapta que no lo
    tienen. Sin tracking, Kapta no sabe cuándo el paquete llega a la agencia y el pedido no entra a la bandeja.{" "}
    <strong className="font-semibold text-ink-700">Solo vincula lo que no admite duda</strong>: el «Doc. externo» igual
    al número del pedido, el DNI de la clienta, o la misma dirección con todos sus nombres. Lo demás queda abajo para
    que lo decida una persona.
  </>
);

/** Lo que dice la página bajo el título en «Correos de Olva». */
export const OLVA_CORREOS_DESCRIPTION =
  "Cada rótulo que Olva manda por correo al registrar un envío —Make lo saca del buzón de Outlook— y si encontró su pedido. Con el mismo teléfono o DNI y al menos un nombre en común le pone el tracking a la salida; lo que no encuentra espera aquí a una persona.";

/** «Correos de Olva»: cada rótulo que llegó por correo y si encontró su pedido. */
export async function OlvaEmailsSection({ stores }: { stores: Stores }) {
  const orgIds = [...new Set(stores.map((s) => s.org_id))];
  const admin = createAdminSupabase();
  const [log, perms] = await Promise.all([
    getOlvaEmailLog(admin, { orgIds, storeIds: stores.map((s) => s.id) }),
    Promise.all(orgIds.map(async (id) => [id, await hasOrgPermission(id, "master.edit")] as const)),
  ]);
  return <OlvaEmailLog log={log} editableOrgIds={perms.filter(([, can]) => can).map(([id]) => id)} />;
}

export async function OlvaCotejoSection({ stores }: { stores: Stores }) {
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
