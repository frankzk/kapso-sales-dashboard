// Lecturas del manifiesto de devolución (0307) para la lista, el detalle, el
// drawer del pedido y el acta. SERVER-ONLY, sin "use server": exporta
// cargadores, no acciones.
//
// Alcance: la cabecera es de la organización; las líneas y lo esperado, de las
// tiendas de quien mira. Las líneas se leen con el cliente del usuario (RLS por
// tienda, 0307); lo esperado sale de `return_manifest_expected` y se filtra por
// sus tiendas, así que un #pedido de otra tienda nunca aparece. Lo de otras
// tiendas solo se cuenta (`hiddenOtherStores`).

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { hasOrgPermission, orgsWithPermission } from "@/lib/permissions-access";
import { resolveAgentNames } from "@/lib/agent-names";
import { limaDateKey } from "@/lib/aliclik-geo";
import { isGroupGfRiderCourier } from "@/lib/couriers/catalog";
import {
  appearedLabel,
  bucketReturnManifest,
  buildReturnManifestActa,
  drawerLineLabel,
  laterPhysicalReceipt,
  notebookOfficeConflictMessage,
  pendingAtCloseFor,
  RETURN_MANIFEST_PERMISSION,
  returnAgeDays,
  returnCadenceFor,
  returnManifestCounter,
  returnManifestTotals,
  expectedBucket,
  STALE_OPEN_MANIFEST_DAYS,
  type ExpectedReturn,
  type ReceiptOutcome,
  type ReturnLineFlag,
  type ReturnLineOutcome,
  type ReturnManifestActa,
  type ReturnManifestBuckets,
  type ReturnManifestLine,
  type ReturnManifestState,
  type ReturnManifestTotals,
  type ShipmentReceiptEvent,
} from "@/lib/return-manifest";

type Admin = SupabaseClient;

// Las rutas viven en el módulo puro: las usan también los componentes de cliente.
export { RETURN_MANIFESTS_PATH, returnManifestPath } from "@/lib/return-manifest";

export interface ReturnManifestHeader {
  id: string;
  orgId: string;
  courier: string;
  riderId: string | null;
  /** Copia histórica del nombre del motorizado al abrir. */
  riderName: string | null;
  label: string;
  arrivedOn: string;
  handedOverBy: string | null;
  declaredCount: number | null;
  note: string | null;
  photoPaths: string[];
  cadenceDays: number;
  state: ReturnManifestState;
  createdAt: string;
  createdByName: string | null;
  closedAt: string | null;
  closedByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancellationReason: string | null;
  /** Abierto hace más de un día: el aviso de la lista. */
  stale: boolean;
}

const HEADER_COLUMNS =
  "id,org_id,courier,rider_id,driver_name,label,arrived_on,handed_over_by,declared_count,note,photo_paths,cadence_days,state," +
  "created_by,created_at,closed_by,closed_at,cancelled_by,cancelled_at,cancellation_reason,pending_at_close";

type HeaderRow = {
  id: string; org_id: string; courier: string; rider_id: string | null; driver_name: string | null; label: string;
  arrived_on: string; handed_over_by: string | null; declared_count: number | null; note: string | null;
  photo_paths: string[] | null; cadence_days: number; state: ReturnManifestState; created_by: string; created_at: string;
  closed_by: string | null; closed_at: string | null; cancelled_by: string | null; cancelled_at: string | null;
  cancellation_reason: string | null;
  /** Lo que el cierre contó dentro de plazo, por tienda (0307). */
  pending_at_close?: Record<string, { con_el_motorizado?: number; reprogramado?: number }> | null;
};

const LINE_COLUMNS =
  "id,manifest_id,store_id,shipment_id,scanned_code,dispatch_item_id,source_manifest_id,source_rider_id,source_route_date,stop_id," +
  "reported_status,reported_reason,expected,outcome,flags,receipt_outcome,message,note,scan_count,scanned_at,removed_at,removal_reason";

type LineRow = {
  id: string; manifest_id: string; store_id: string | null; shipment_id: string | null; scanned_code: string;
  dispatch_item_id: string | null; source_manifest_id: string | null; source_rider_id: string | null;
  source_route_date: string | null; stop_id: string | null; reported_status: string | null; reported_reason: string | null;
  expected: boolean; outcome: ReturnLineOutcome; flags: ReturnLineFlag[] | null; receipt_outcome: ReceiptOutcome | null;
  message: string | null; note: string | null; scan_count: number; scanned_at: string; removed_at: string | null;
  removal_reason: string | null;
};

/** Quien mira o escribe: el permiso de Almacén en ESA organización y sus tiendas. */
export async function returnManifestAccess(orgId: string): Promise<{ ok: true; userId: string; storeIds: Set<string> } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "No autenticado." };
  if (!(await hasOrgPermission(orgId, RETURN_MANIFEST_PERMISSION))) return { ok: false, error: "No tienes permiso para recibir devoluciones." };
  const stores = (await getAccessibleStores()).filter((store) => store.org_id === orgId);
  if (!stores.length) return { ok: false, error: "No tienes tiendas asignadas en esta organización." };
  return { ok: true, userId: user.id, storeIds: new Set(stores.map((store) => store.id)) };
}

function isStale(row: Pick<HeaderRow, "state" | "created_at">, today: string): boolean {
  return row.state === "open" && returnAgeDays(limaDateKey(new Date(row.created_at)), today) > STALE_OPEN_MANIFEST_DAYS;
}

function toHeader(row: HeaderRow, names: Record<string, string>, today: string): ReturnManifestHeader {
  return {
    id: row.id,
    orgId: row.org_id,
    courier: row.courier,
    riderId: row.rider_id,
    riderName: row.driver_name,
    label: row.label,
    arrivedOn: row.arrived_on,
    handedOverBy: row.handed_over_by,
    declaredCount: row.declared_count,
    note: row.note,
    photoPaths: row.photo_paths ?? [],
    cadenceDays: row.cadence_days,
    state: row.state,
    createdAt: row.created_at,
    createdByName: names[row.created_by] ?? null,
    closedAt: row.closed_at,
    closedByName: row.closed_by ? names[row.closed_by] ?? null : null,
    cancelledAt: row.cancelled_at,
    cancelledByName: row.cancelled_by ? names[row.cancelled_by] ?? null : null,
    cancellationReason: row.cancellation_reason,
    stale: isStale(row, today),
  };
}

async function headerNames(admin: Admin, rows: readonly HeaderRow[]): Promise<Record<string, string>> {
  return resolveAgentNames(rows.flatMap((r) => [r.created_by, r.closed_by, r.cancelled_by].filter((x): x is string => Boolean(x))), admin);
}

/** Las líneas visibles con su #pedido y su código de salida (nunca el cliente). */
async function hydrateLines(admin: Admin, rows: readonly LineRow[]): Promise<ReturnManifestLine[]> {
  const shipmentIds = [...new Set(rows.map((r) => r.shipment_id).filter((x): x is string => Boolean(x)))];
  const riderIds = [...new Set(rows.map((r) => r.source_rider_id).filter((x): x is string => Boolean(x)))];
  const [{ data: shipments }, { data: riders }] = await Promise.all([
    shipmentIds.length
      ? admin.from("shipments").select("id,order_id,order_name,output_code,guide_code").in("id", shipmentIds)
      : Promise.resolve({ data: [] }),
    riderIds.length ? admin.from("riders").select("id,full_name").in("id", riderIds) : Promise.resolve({ data: [] }),
  ]);
  const ship = new Map(((shipments ?? []) as { id: string; order_id: string | null; order_name: string | null; output_code: string | null; guide_code: string | null }[]).map((s) => [s.id, s]));
  const rider = new Map(((riders ?? []) as { id: string; full_name: string }[]).map((r) => [r.id, r.full_name]));
  return rows.map((r) => {
    const s = r.shipment_id ? ship.get(r.shipment_id) : undefined;
    return {
      id: r.id,
      shipmentId: r.shipment_id,
      storeId: r.store_id,
      orderId: s?.order_id ?? null,
      orderName: s?.order_name ?? null,
      outputCode: s?.output_code ?? s?.guide_code ?? null,
      scannedCode: r.scanned_code,
      sourceRiderName: r.source_rider_id ? rider.get(r.source_rider_id) ?? null : null,
      sourceRouteDate: r.source_route_date,
      reportedStatus: r.reported_status,
      reportedReason: r.reported_reason,
      expected: r.expected,
      outcome: r.outcome,
      flags: r.flags ?? [],
      receiptOutcome: r.receipt_outcome,
      message: r.message,
      note: r.note,
      scanCount: r.scan_count,
      scannedAt: r.scanned_at,
      removedAt: r.removed_at,
      removalReason: r.removal_reason,
    };
  });
}

/**
 * Lo que Kapta espera de vuelta del motorizado, en vivo, solo de las tiendas de
 * quien mira. `hidden` cuenta lo de otras tiendas sin nombrarlo.
 */
export async function loadExpectedReturns(
  admin: Admin,
  orgId: string,
  riderId: string,
  storeIds: ReadonlySet<string>,
): Promise<{ expected: ExpectedReturn[]; hidden: number }> {
  const { data, error } = await admin.rpc("return_manifest_expected", { p_org_id: orgId, p_rider_id: riderId });
  if (error) throw new Error(`lo esperado del motorizado: ${error.message}`);
  const rows = (data ?? []) as { item_id: string; shipment_id: string; store_id: string | null; manifest_id: string; route_date: string; stop_id: string | null; outcome_reason: string | null }[];
  const visible = rows.filter((r) => r.store_id && storeIds.has(r.store_id));
  const ids = visible.map((r) => r.shipment_id);
  const ship = new Map<string, { order_id: string | null; order_name: string | null; output_code: string | null; guide_code: string | null; returned_at: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: chunk } = await admin.from("shipments").select("id,order_id,order_name,output_code,guide_code,returned_at").in("id", ids.slice(i, i + 200));
    for (const s of (chunk ?? []) as { id: string; order_id: string | null; order_name: string | null; output_code: string | null; guide_code: string | null; returned_at: string | null }[]) ship.set(s.id, s);
  }
  return {
    hidden: rows.length - visible.length,
    expected: visible.map((r) => {
      const s = ship.get(r.shipment_id);
      return {
        shipmentId: r.shipment_id,
        storeId: r.store_id,
        itemId: r.item_id,
        manifestId: r.manifest_id,
        routeDate: r.route_date,
        stopId: r.stop_id,
        outcomeReason: r.outcome_reason,
        orderId: s?.order_id ?? null,
        orderName: s?.order_name ?? null,
        outputCode: s?.output_code ?? s?.guide_code ?? null,
        returnedAt: s?.returned_at ?? null,
      };
    }),
  };
}

export interface ReturnManifestListItem extends ReturnManifestHeader {
  counts: { arrived: number; received: number; withObservation: number; missing: number };
}

/** La pestaña «Manifiestos»: abiertos primero, luego por día de llegada. */
export async function listReturnManifests(opts: { limit?: number } = {}): Promise<ReturnManifestListItem[]> {
  const orgs = await orgsWithPermission(RETURN_MANIFEST_PERMISSION);
  if (!orgs.length) return [];
  const sb = await createServerSupabase();
  const admin = createAdminSupabase();
  const orgIds = orgs.map((o) => o.org_id);
  // Los abiertos van aparte y sin el límite: uno olvidado (el del aviso) nunca
  // se cae de la lista por haber 60 cerrados más nuevos. Hay a lo sumo uno por
  // motorizado.
  const [open, closed] = await Promise.all([
    sb.from("return_manifests").select(HEADER_COLUMNS).in("org_id", orgIds).eq("state", "open")
      .order("arrived_on", { ascending: false }).order("created_at", { ascending: false }).limit(500),
    sb.from("return_manifests").select(HEADER_COLUMNS).in("org_id", orgIds).eq("state", "closed")
      .order("arrived_on", { ascending: false }).order("created_at", { ascending: false })
      .limit(Math.min(Math.max(opts.limit ?? 60, 1), 200)),
  ]);
  const error = open.error ?? closed.error;
  if (error) throw new Error(`manifiestos de devolución: ${error.message}`);
  const rows = [...((open.data ?? []) as unknown as HeaderRow[]), ...((closed.data ?? []) as unknown as HeaderRow[])];
  const ids = rows.map((r) => r.id);
  const { data: lineRows } = ids.length
    ? await sb.from("return_manifest_lines").select("manifest_id,outcome,removed_at").in("manifest_id", ids).is("removed_at", null)
    : { data: [] };
  const counts = new Map<string, ReturnManifestListItem["counts"]>();
  for (const l of (lineRows ?? []) as { manifest_id: string; outcome: ReturnLineOutcome }[]) {
    const c = counts.get(l.manifest_id) ?? { arrived: 0, received: 0, withObservation: 0, missing: 0 };
    if (l.outcome === "missing") c.missing++;
    else {
      c.arrived++;
      if (l.outcome === "received") c.received++;
      if (l.outcome === "held") c.withObservation++;
    }
    counts.set(l.manifest_id, c);
  }
  const names = await headerNames(admin, rows);
  const today = limaDateKey();
  return rows.map((r) => ({ ...toHeader(r, names, today), counts: counts.get(r.id) ?? { arrived: 0, received: 0, withObservation: 0, missing: 0 } }));
}

/** Lo que se deriva en vivo de una línea, sin tocar el manifiesto cerrado. */
export interface ReturnManifestLineExtra {
  /** Una que faltó y después llegó: «apareció el 06/11». */
  appeared: string | null;
  /** Una observación que alguien recibió después (por otra vía). */
  resolvedAt: string | null;
  /** El cuaderno cargado después dice «entregado» de una que llegó sin reporte. */
  notebookIncident: string | null;
}

export interface ReturnManifestDetail {
  header: ReturnManifestHeader;
  lines: ReturnManifestLine[];
  /** Vacío si el manifiesto no está abierto (lo que faltó son sus líneas `missing`). */
  expected: ExpectedReturn[];
  buckets: ReturnManifestBuckets;
  totals: ReturnManifestTotals;
  /** «Recibidos 12 de 30 esperados · declaró 14». */
  counter: string;
  /** Lo esperado de otras tiendas: solo la cifra. */
  hiddenOtherStores: number;
  extras: Record<string, ReturnManifestLineExtra>;
  canEdit: boolean;
}

async function loadHeader(id: string): Promise<HeaderRow | null> {
  const sb = await createServerSupabase();
  const { data } = await sb.from("return_manifests").select(HEADER_COLUMNS).eq("id", id).maybeSingle();
  return (data as unknown as HeaderRow | null) ?? null;
}

/** Las recepciones posteriores de unas salidas (para «apareció» y «resuelta»). */
async function receiptEvents(admin: Admin, shipmentIds: readonly string[]): Promise<ShipmentReceiptEvent[]> {
  const out: ShipmentReceiptEvent[] = [];
  const ids = [...new Set(shipmentIds)];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin
      .from("order_events")
      .select("shipment_id,kind,actor,source,occurred_at,payload")
      .in("shipment_id", ids.slice(i, i + 200))
      .in("kind", ["returned_to_office", "return_received"]);
    for (const e of (data ?? []) as { shipment_id: string; kind: string; actor: string | null; source: string | null; occurred_at: string; payload: Record<string, unknown> | null }[]) {
      out.push({
        shipmentId: e.shipment_id, kind: e.kind, actor: e.actor, source: e.source, occurredAt: e.occurred_at,
        returnManifestId: typeof e.payload?.return_manifest_id === "string" ? (e.payload.return_manifest_id as string) : null,
      });
    }
  }
  return out;
}

/**
 * Las paradas que el cuaderno dice «entregado» después de que la caja llegó sin
 * reporte: la incidencia a la vista (regla 4). El cuaderno es el del motorizado
 * de la CAJA (`source_rider_id`), que en una «De otra caja» no es el del
 * manifiesto.
 */
async function notebookIncidents(
  admin: Admin,
  lines: readonly ReturnManifestLine[],
  rowOf: Map<string, Pick<LineRow, "stop_id" | "source_rider_id">>,
  header: HeaderRow,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const candidates = lines.filter((l) => l.outcome === "received" && l.flags.includes("sin_reporte") && l.sourceRouteDate
    && rowOf.get(l.id)?.stop_id && (rowOf.get(l.id)?.source_rider_id ?? header.rider_id));
  if (!candidates.length) return out;
  const riderOf = (l: ReturnManifestLine) => rowOf.get(l.id)?.source_rider_id ?? header.rider_id!;
  const byRider = new Map<string, Set<string>>();
  for (const l of candidates) byRider.set(riderOf(l), (byRider.get(riderOf(l)) ?? new Set()).add(l.sourceRouteDate!));
  const delivered = new Set<string>();
  await Promise.all([...byRider].map(async ([riderId, days]) => {
    const { data } = await admin.from("rider_notebook_imports").select("route_date,plan").eq("rider_id", riderId).in("route_date", [...days]);
    for (const imp of (data ?? []) as { plan: unknown }[]) {
      for (const row of Array.isArray(imp.plan) ? imp.plan as { match?: { stopId?: string | null }; outcome?: { status?: string } | null }[] : []) {
        if (row?.match?.stopId && row.outcome?.status === "entregado") delivered.add(row.match.stopId);
      }
    }
  }));
  for (const l of candidates) {
    if (delivered.has(rowOf.get(l.id)!.stop_id!)) out.set(l.id, notebookOfficeConflictMessage({ manifestLabel: header.label, arrivedOn: header.arrived_on }));
  }
  return out;
}

/** El detalle: cabecera, líneas, lo esperado en vivo, los tres paneles y los totales. */
export async function getReturnManifestDetail(id: string): Promise<ReturnManifestDetail | null> {
  const row = await loadHeader(id);
  if (!row) return null;
  const access = await returnManifestAccess(row.org_id);
  if (!access.ok) return null;
  const sb = await createServerSupabase();
  const admin = createAdminSupabase();
  const { data: lineData, error } = await sb.from("return_manifest_lines").select(LINE_COLUMNS).eq("manifest_id", id).order("scanned_at");
  if (error) throw new Error(`líneas del manifiesto: ${error.message}`);
  const lineRows = ((lineData ?? []) as unknown as LineRow[]).filter((l) => !l.store_id || access.storeIds.has(l.store_id));
  const lines = await hydrateLines(admin, lineRows);
  const frozen = row.state === "open" ? null : pendingAtCloseFor(row.pending_at_close, access.storeIds);
  const { expected, hidden } = row.state === "open" && row.rider_id
    ? await loadExpectedReturns(admin, row.org_id, row.rider_id, access.storeIds)
    : { expected: [], hidden: 0 };
  const buckets = bucketReturnManifest({
    state: row.state, expected, lines, arrivedOn: row.arrived_on, cadenceDays: row.cadence_days, pendingAtClose: frozen?.visible ?? null,
  });
  const totals = returnManifestTotals(buckets, row.declared_count);

  const events = await receiptEvents(admin, lines.filter((l) => l.shipmentId && l.outcome !== "received").map((l) => l.shipmentId!));
  const rowOf = new Map(lineRows.map((l) => [l.id, { stop_id: l.stop_id, source_rider_id: l.source_rider_id }]));
  const incidents = await notebookIncidents(admin, lines, rowOf, row);
  const extras: Record<string, ReturnManifestLineExtra> = {};
  for (const line of lines) {
    const after = line.outcome === "missing" ? row.closed_at ?? line.scannedAt : line.scannedAt;
    const later = line.shipmentId && line.outcome !== "received"
      ? laterPhysicalReceipt(line.shipmentId, after, events.filter((e) => e.returnManifestId !== id))
      : null;
    extras[line.id] = {
      appeared: line.outcome === "missing" ? appearedLabel(later) : null,
      resolvedAt: line.outcome === "held" ? later?.occurredAt ?? null : null,
      notebookIncident: incidents.get(line.id) ?? null,
    };
  }
  const names = await headerNames(admin, [row]);
  return {
    header: toHeader(row, names, limaDateKey()),
    lines,
    expected,
    buckets,
    totals,
    counter: returnManifestCounter(totals),
    hiddenOtherStores: hidden,
    extras,
    canEdit: row.state === "open",
  };
}

/** El acta para el PDF y el Excel: sin nombres, teléfonos ni direcciones de clientes. */
export async function getReturnManifestActa(id: string): Promise<ReturnManifestActa | null> {
  const detail = await getReturnManifestDetail(id);
  if (!detail) return null;
  const h = detail.header;
  return buildReturnManifestActa({
    header: {
      label: h.label,
      courierLabel: h.courier === "propio" ? "Grupo GF" : h.courier,
      riderFirstName: h.riderName ? h.riderName.trim().split(/\s+/)[0] ?? null : null,
      arrivedOn: h.arrivedOn,
      handedOverBy: h.handedOverBy,
      receivedBy: h.closedByName ?? h.createdByName,
      openedAt: h.createdAt,
      closedAt: h.closedAt,
      state: h.state,
      declaredCount: h.declaredCount,
      note: h.note,
    },
    buckets: detail.buckets,
  });
}

/** Una entrada del historial de la salida en el drawer: «Recibida en Devolución · Alexis · 04/11». */
export interface ReturnManifestDrawerEntry {
  manifestId: string;
  lineId: string;
  label: string;
  text: string;
  outcome: ReturnLineOutcome;
  flags: ReturnLineFlag[];
  at: string;
  /** «apareció el 06/11», si faltó y después llegó. */
  appeared: string | null;
}

/** Para el drawer: las líneas de manifiesto de estas salidas (RLS por tienda). */
export async function returnManifestEntriesForShipments(shipmentIds: readonly string[]): Promise<Record<string, ReturnManifestDrawerEntry[]>> {
  const ids = [...new Set(shipmentIds.filter(Boolean))];
  const out: Record<string, ReturnManifestDrawerEntry[]> = {};
  if (!ids.length) return out;
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("return_manifest_lines")
    .select("id,manifest_id,shipment_id,outcome,flags,scanned_at,removed_at,return_manifests!inner(label,state,closed_at)")
    .in("shipment_id", ids.slice(0, 200))
    .is("removed_at", null)
    .order("scanned_at");
  // Sin la 0307 la tabla no existe: el drawer sigue sin esta línea.
  if (error) return out;
  type Header = { label: string; state: string; closed_at: string | null };
  const rows = (data ?? []) as unknown as { id: string; manifest_id: string; shipment_id: string; outcome: ReturnLineOutcome; flags: ReturnLineFlag[] | null; scanned_at: string; return_manifests: Header | Header[] }[];
  const missing = rows.filter((r) => r.outcome === "missing");
  const events = missing.length ? await receiptEvents(createAdminSupabase(), missing.map((r) => r.shipment_id)) : [];
  for (const r of rows) {
    const header = Array.isArray(r.return_manifests) ? r.return_manifests[0] : r.return_manifests;
    if (!header || header.state === "cancelled") continue;
    const flags = r.flags ?? [];
    const appeared = r.outcome === "missing"
      ? appearedLabel(laterPhysicalReceipt(r.shipment_id, header.closed_at ?? r.scanned_at, events.filter((e) => e.returnManifestId !== r.manifest_id)))
      : null;
    (out[r.shipment_id] ??= []).push({
      manifestId: r.manifest_id,
      lineId: r.id,
      label: header.label,
      text: drawerLineLabel({ outcome: r.outcome, flags, manifestLabel: header.label }),
      outcome: r.outcome,
      flags,
      at: r.outcome === "missing" ? header.closed_at ?? r.scanned_at : r.scanned_at,
      appeared,
    });
  }
  return out;
}

/** Un motorizado de Grupo GF para «Nuevo manifiesto de devolución». */
export interface ReturnManifestRiderOption {
  orgId: string;
  riderId: string;
  riderName: string;
  cadenceDays: number;
  /** «No entregado» que siguen en sus cajas (de las tiendas de quien mira). */
  expected: number;
  /** De esos, fuera de plazo hoy (reprogramado: más de 14 días). */
  outOfCadence: number;
  openManifestId: string | null;
}

/** Los motorizados de Grupo GF activos de la organización, con lo que deben. */
export async function listReturnManifestRiders(orgId: string): Promise<ReturnManifestRiderOption[]> {
  const access = await returnManifestAccess(orgId);
  if (!access.ok) return [];
  const admin = createAdminSupabase();
  const [{ data: riders }, { data: open }] = await Promise.all([
    admin.from("riders").select("id,full_name,courier").eq("org_id", orgId).eq("active", true).order("full_name"),
    admin.from("return_manifests").select("id,rider_id").eq("org_id", orgId).eq("courier", "propio").eq("state", "open"),
  ]);
  const openBy = new Map(((open ?? []) as { id: string; rider_id: string | null }[]).map((m) => [m.rider_id, m.id]));
  const today = limaDateKey();
  const gf = ((riders ?? []) as { id: string; full_name: string; courier: string | null }[]).filter((r) => isGroupGfRiderCourier(r.courier));
  return Promise.all(gf.map(async (r) => {
    const cadenceDays = returnCadenceFor("propio", r.full_name);
    const { expected } = await loadExpectedReturns(admin, orgId, r.id, access.storeIds).catch(() => ({ expected: [] as ExpectedReturn[], hidden: 0 }));
    return {
      orgId,
      riderId: r.id,
      riderName: r.full_name,
      cadenceDays,
      expected: expected.length,
      outOfCadence: expected.filter((e) => expectedBucket({ routeDate: e.routeDate, outcomeReason: e.outcomeReason, arrivedOn: today, cadenceDays }) === "falta").length,
      openManifestId: openBy.get(r.id) ?? null,
    };
  }));
}
