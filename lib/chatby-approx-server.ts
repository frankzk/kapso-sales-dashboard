import "server-only";

// La «Prueba de ubicación aproximada» del panel Automatizaciones (0316, MOM
// §6.1 y §40): la posición de «Aceptar ubicación aproximada en la calle
// correcta» y, pedido por pedido, la distancia entre el punto aproximado de
// Google y el punto de la guía de Aliclik que se entregó o se intentó (el que
// el Master toma como «lo que el courier geolocalizó al ir a la puerta»).
//
// Se calcula al abrir el panel, sin cron ni columnas nuevas: tres lecturas
// chicas (los puntos aproximados de la organización, como mucho 200; su fila
// del Master; sus guías de Aliclik), y la cuenta en lib/geocode-approx.ts.
// Sin la 0316 no hay puntos ni posición: el panel lo dice y la trata como
// Apagado.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  APPROX_REPORT_LIMIT,
  approxModeFrom,
  approxReference,
  approxSummary,
  type ApproxMode,
  type ApproxReference,
  type ApproxShipment,
  type ApproxSummary,
} from "@/lib/geocode-approx";

export interface ApproxReportRow {
  orderId: string;
  orderName: string;
  address: string | null;
  /** Con qué posición se guardó el punto (Activo si una guía se creó con él). */
  mode: "simulacion" | "activo";
  approx: { lat: number; lng: number };
  reference: ApproxReference;
}

export interface ChatbyApproxView {
  /** Falso si la 0316 aún no está: el control se bloquea y todo es Apagado. */
  available: boolean;
  /** La organización tiene su fila de la confirmación por Chatby (si no, no hay nada que cambiar). */
  rowExists: boolean;
  mode: ApproxMode;
  rows: ApproxReportRow[];
  summary: ApproxSummary;
  error: string | null;
}

/** «No existe» (tabla o columna): la migración no está aplicada. */
function isMissing(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return (
    ["42P01", "42703", "PGRST205", "PGRST204"].includes(error.code ?? "") ||
    /does not exist|could not find/i.test(error.message ?? "")
  );
}

const ID_CHUNK = 100;

export async function loadChatbyApproxView(admin: SupabaseClient, orgId: string): Promise<ChatbyApproxView> {
  const empty: ChatbyApproxView = {
    available: false,
    rowExists: false,
    mode: "apagado",
    rows: [],
    summary: approxSummary([]),
    error: null,
  };
  // `*`: sin la 0316, `approx_mode` no viene y es Apagado.
  const { data: settings, error: sErr } = await admin.from("chatby_auto_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (sErr) {
    if (isMissing(sErr)) return empty;
    return { ...empty, error: "No se pudo leer la ubicación aproximada de Chatby: no se puede cambiar ahora." };
  }
  const row = settings as Record<string, unknown> | null;
  if (row && !("approx_mode" in row)) return empty;
  const base: ChatbyApproxView = { ...empty, available: true, rowExists: !!row, mode: approxModeFrom(row?.approx_mode) };

  try {
    const { data: stores, error: stErr } = await admin.from("stores").select("id").eq("org_id", orgId);
    if (stErr) throw new Error(stErr.message);
    const storeIds = ((stores ?? []) as { id: string }[]).map((s) => s.id);
    if (!storeIds.length) return base;
    const rows = await loadApproxRows(admin, storeIds);
    return { ...base, rows, summary: approxSummary(rows.map((r) => r.reference)) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...base, error: `No se pudo leer la prueba de ubicación aproximada: ${message}` };
  }
}

interface ApproxGeocodeRow {
  order_id: string;
  approx_latitude: number | null;
  approx_longitude: number | null;
  approx_mode: string | null;
  approx_used_at: string | null;
}

/** Los puntos aproximados guardados de esas tiendas, con su punto del motorizado. Lanza si una lectura falla. */
export async function loadApproxRows(admin: SupabaseClient, storeIds: string[]): Promise<ApproxReportRow[]> {
  const { data, error } = await admin
    .from("order_geocodes")
    .select("order_id,approx_latitude,approx_longitude,approx_mode,approx_used_at")
    .in("store_id", storeIds)
    .eq("approx_kind", "calle")
    .order("approx_checked_at", { ascending: false })
    .limit(APPROX_REPORT_LIMIT);
  if (error) throw new Error(`leer los puntos aproximados: ${error.message}`);
  const points = ((data ?? []) as ApproxGeocodeRow[]).filter((p) => p.approx_latitude != null && p.approx_longitude != null);
  if (!points.length) return [];
  const ids = points.map((p) => p.order_id);

  const masters = new Map<string, { order_name: string | null; address: string | null }>();
  const shipments = new Map<string, ApproxShipment[]>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const [mRes, sRes] = await Promise.all([
      admin.from("order_master").select("order_id,order_name,address").in("order_id", chunk),
      admin
        .from("shipments")
        .select("order_id,delivery_status,aliclik_attempts,latitude,longitude,created_at")
        .eq("courier", "aliclik")
        .in("order_id", chunk),
    ]);
    if (mRes.error) throw new Error(`leer el Master: ${mRes.error.message}`);
    if (sRes.error) throw new Error(`leer las guías: ${sRes.error.message}`);
    for (const m of (mRes.data ?? []) as { order_id: string; order_name: string | null; address: string | null }[]) masters.set(m.order_id, m);
    for (const s of (sRes.data ?? []) as (ApproxShipment & { order_id: string })[]) {
      shipments.set(s.order_id, [...(shipments.get(s.order_id) ?? []), s]);
    }
  }

  return points.map((p) => {
    const approx = { lat: Number(p.approx_latitude), lng: Number(p.approx_longitude) };
    const master = masters.get(p.order_id);
    return {
      orderId: p.order_id,
      orderName: master?.order_name ?? "Pedido",
      address: master?.address ?? null,
      mode: p.approx_used_at || p.approx_mode === "activo" ? "activo" : "simulacion",
      approx,
      reference: approxReference({ ...approx, usedAt: p.approx_used_at }, shipments.get(p.order_id) ?? []),
    };
  });
}
