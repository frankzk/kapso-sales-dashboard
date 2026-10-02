// Un cotejo completo de «Cotejar Olva» (MOM §12): traer del portal, cotejar,
// vincular lo exacto y dejar la bitácora. Lo llaman el cron, el botón y
// «Pegar respuesta»; los tres pasan por aquí para que la regla sea UNA.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptOrNull } from "@/lib/crypto";
import { linkOlvaTrackingIfEmpty } from "@/lib/olva/link";
import {
  fetchOlvaPortalTrackings,
  olvaPortalLogin,
  type OlvaPortalRow,
} from "@/lib/olva/portal";
import { matchPortalRows, type CotejoCandidate, type CotejoOutcome } from "@/lib/olva/portal-match";
import { formatOlvaTracking } from "@/lib/olva/tracking";

/** Días hacia atrás que mira el cotejo automático y el botón. */
export const COTEJO_DEFAULT_DAYS = 7;

/** Una cuenta del portal y las tiendas cuyas salidas coteja. */
export interface OlvaPortalAccount {
  orgId: string;
  /** La tienda donde están las credenciales (o la elegida al pegar). */
  storeId: string;
  storeIds: string[];
  username: string | null;
  password: string | null;
  ruc: string | null;
}

interface StoreRow {
  id: string;
  org_id: string;
  olva_portal_username: string | null;
  olva_portal_password_enc: string | null;
  olva_portal_ruc: string | null;
}

/**
 * Las tiendas de la organización que despachan con esa cuenta: todas, menos
 * las que tienen OTRO RUC de Olva puesto. Una tienda sin credenciales propias
 * entra en la cuenta de su organización.
 */
function storesForAccount(all: StoreRow[], orgId: string, ruc: string | null): string[] {
  return all.filter((s) => s.org_id === orgId && (!s.olva_portal_ruc || s.olva_portal_ruc === ruc)).map((s) => s.id);
}

/** Las cuentas con credenciales completas, una por organización y RUC. */
export async function loadOlvaPortalAccounts(
  admin: SupabaseClient,
  filter: { orgIds?: string[] } = {},
): Promise<OlvaPortalAccount[]> {
  let q = admin.from("stores").select("id,org_id,olva_portal_username,olva_portal_password_enc,olva_portal_ruc");
  if (filter.orgIds) q = q.in("org_id", filter.orgIds);
  const { data, error } = await q;
  if (error) throw new Error(`No se pudieron leer las tiendas: ${error.message}`);
  const all = (data ?? []) as StoreRow[];
  const seen = new Set<string>();
  const accounts: OlvaPortalAccount[] = [];
  for (const s of all) {
    if (!s.olva_portal_username || !s.olva_portal_password_enc || !s.olva_portal_ruc) continue;
    const key = `${s.org_id}:${s.olva_portal_ruc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({
      orgId: s.org_id,
      storeId: s.id,
      storeIds: storesForAccount(all, s.org_id, s.olva_portal_ruc),
      username: s.olva_portal_username,
      password: decryptOrNull(s.olva_portal_password_enc),
      ruc: s.olva_portal_ruc,
    });
  }
  return accounts;
}

/** Para «Pegar respuesta»: la cuenta de una tienda, tenga o no credenciales. */
export async function olvaPortalAccountForStore(
  admin: SupabaseClient,
  storeId: string,
): Promise<OlvaPortalAccount | null> {
  const { data: own } = await admin.from("stores").select("org_id,olva_portal_ruc").eq("id", storeId).maybeSingle();
  const store = own as { org_id: string; olva_portal_ruc: string | null } | null;
  if (!store) return null;
  const { data } = await admin
    .from("stores")
    .select("id,org_id,olva_portal_username,olva_portal_password_enc,olva_portal_ruc")
    .eq("org_id", store.org_id);
  return {
    orgId: store.org_id,
    storeId,
    storeIds: storesForAccount((data ?? []) as StoreRow[], store.org_id, store.olva_portal_ruc),
    username: null,
    password: null,
    ruc: store.olva_portal_ruc,
  };
}

/** Una fila de la bitácora, en el formato que la pantalla pinta. */
export interface CotejoResumenRow {
  tracking: string;
  estado: string | null;
  destinatario: string;
  distrito: string | null;
  direccion: string;
  fecha: string | null;
  docExterno: string | null;
  outcome: "vinculado" | "ya_vinculado" | "revisar" | "sin_pareja";
  via?: string;
  orderName?: string | null;
  shipmentId?: string;
  reason?: string;
  hints?: { shipmentId: string; orderName: string | null; customerName: string | null; address: string | null; why: string }[];
}

export interface CotejoResumen {
  skipped: number;
  rows: CotejoResumenRow[];
}

export interface CotejoRunResult {
  ok: boolean;
  error?: string;
  blocked?: boolean;
  fetched: number;
  linked: number;
  review: number;
  unmatched: number;
}

function baseRow(row: OlvaPortalRow): Omit<CotejoResumenRow, "outcome"> {
  return {
    tracking: formatOlvaTracking(row.id),
    estado: row.estado,
    destinatario: row.destinatario,
    distrito: row.distrito,
    direccion: row.direccion,
    fecha: row.fechaRegistro,
    docExterno: row.docExterno,
  };
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function limaDayKey(now: Date = new Date()): string {
  return new Date(now.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}

export function defaultCotejoRange(now: Date = new Date()): { desde: string; hasta: string } {
  const hasta = limaDayKey(now);
  return { desde: addDays(hasta, -(COTEJO_DEFAULT_DAYS - 1)), hasta };
}

async function loadCandidates(admin: SupabaseClient, storeIds: string[], rows: OlvaPortalRow[]): Promise<CotejoCandidate[]> {
  const days = rows.map((r) => r.fechaRegistro).filter((d): d is string => Boolean(d)).sort();
  const from = addDays(days[0] ?? limaDayKey(), -30);
  const { data, error } = await admin
    .from("shipments")
    .select("id,store_id,order_name,guide_code,customer_name,delivery_address,district,created_at,delivery_status")
    .in("store_id", storeIds)
    .eq("courier", "olva")
    .is("olva_tracking", null)
    .neq("delivery_status", "anulado")
    .gte("created_at", `${from}T05:00:00Z`)
    .limit(2000);
  if (error) throw new Error(`No se pudieron leer las salidas de Olva: ${error.message}`);
  return ((data ?? []) as {
    id: string;
    store_id: string;
    order_name: string | null;
    guide_code: string | null;
    customer_name: string | null;
    delivery_address: string | null;
    district: string | null;
    created_at: string;
  }[]).map((s) => ({
    shipmentId: s.id,
    storeId: s.store_id,
    orderName: s.order_name,
    guideCode: s.guide_code,
    customerName: s.customer_name,
    address: s.delivery_address,
    district: s.district,
    createdAt: s.created_at,
  }));
}

/** Qué trackings del lote ya están en alguna salida, de cualquier tienda. */
async function loadLinked(admin: SupabaseClient, rows: OlvaPortalRow[]): Promise<Map<string, string | null>> {
  const linked = new Map<string, string | null>();
  const trackings = [...new Set(rows.map((r) => r.id.tracking))];
  for (let i = 0; i < trackings.length; i += 200) {
    const { data, error } = await admin
      .from("shipments")
      .select("olva_tracking,olva_emision,order_name")
      .in("olva_tracking", trackings.slice(i, i + 200));
    if (error) throw new Error(`No se pudieron leer los trackings vinculados: ${error.message}`);
    for (const s of (data ?? []) as { olva_tracking: string; olva_emision: string; order_name: string | null }[]) {
      linked.set(formatOlvaTracking({ tracking: s.olva_tracking, emision: s.olva_emision }), s.order_name);
    }
  }
  return linked;
}

async function applyOutcomes(
  admin: SupabaseClient,
  outcomes: CotejoOutcome[],
  actor: string | null,
): Promise<CotejoResumenRow[]> {
  const out: CotejoResumenRow[] = [];
  for (const o of outcomes) {
    const base = baseRow(o.row);
    if (o.kind === "ya_vinculado") {
      out.push({ ...base, outcome: "ya_vinculado", orderName: o.orderName });
    } else if (o.kind === "sin_pareja") {
      out.push({ ...base, outcome: "sin_pareja" });
    } else if (o.kind === "revisar") {
      out.push({
        ...base,
        outcome: "revisar",
        reason: o.reason,
        hints: o.hints.map((h) => ({
          shipmentId: h.candidate.shipmentId,
          orderName: h.candidate.orderName,
          customerName: h.candidate.customerName,
          address: h.candidate.address,
          why: h.why,
        })),
      });
    } else {
      const via = o.via === "doc_externo" ? "el Doc. externo es el pedido" : "nombre y dirección idénticos";
      const res = await linkOlvaTrackingIfEmpty(admin, {
        shipmentId: o.candidate.shipmentId,
        id: o.row.id,
        actor,
        note: `Tracking Olva ${base.tracking} registrado por «Cotejar Olva» (${via}).`,
        payload: { via: `cotejo_${o.via}` },
      });
      if (res.ok) {
        out.push({ ...base, outcome: "vinculado", via: o.via, orderName: o.candidate.orderName, shipmentId: o.candidate.shipmentId });
      } else {
        out.push({
          ...base,
          outcome: "revisar",
          reason: res.error,
          hints: [
            {
              shipmentId: o.candidate.shipmentId,
              orderName: o.candidate.orderName,
              customerName: o.candidate.customerName,
              address: o.candidate.address,
              why: via,
            },
          ],
        });
      }
    }
  }
  return out;
}

/**
 * Corre un cotejo. Con `rows` (pegado) no entra al portal; sin ellas necesita
 * las credenciales de la cuenta. Nunca lanza: el error queda en la bitácora.
 */
export async function runOlvaCotejo(
  admin: SupabaseClient,
  input: {
    account: OlvaPortalAccount;
    source: "cron" | "manual" | "pegado";
    actor: string | null;
    desde?: string;
    hasta?: string;
    rows?: OlvaPortalRow[];
    skipped?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<CotejoRunResult> {
  const range = input.desde && input.hasta ? { desde: input.desde, hasta: input.hasta } : defaultCotejoRange();
  const record = async (r: CotejoRunResult, resumen: CotejoResumen = { skipped: 0, rows: [] }) => {
    await admin.from("olva_portal_runs").insert({
      org_id: input.account.orgId,
      store_id: input.account.storeId,
      source: input.source,
      desde: input.rows ? null : range.desde,
      hasta: input.rows ? null : range.hasta,
      ok: r.ok,
      error: r.error ?? null,
      fetched: r.fetched,
      linked: r.linked,
      resumen,
      created_by: input.actor,
    });
    return r;
  };
  const fail = (error: string, blocked = false) =>
    record({ ok: false, error, blocked, fetched: 0, linked: 0, review: 0, unmatched: 0 });

  try {
    let rows = input.rows;
    let skipped = input.skipped ?? 0;
    if (!rows) {
      const { username, password, ruc } = input.account;
      if (!username || !password || !ruc) return fail("Faltan el usuario, la contraseña o el RUC del portal de Olva en Ajustes.");
      const login = await olvaPortalLogin({ username, password }, input.fetchImpl);
      if (!login.ok) return fail(login.error, login.kind === "blocked");
      const res = await fetchOlvaPortalTrackings({ jwt: login.jwt, ruc, ...range }, input.fetchImpl);
      if (!res.ok) return fail(res.error, res.kind === "blocked");
      rows = res.rows;
      skipped = res.skipped;
    }

    const [candidates, linked] = await Promise.all([
      loadCandidates(admin, input.account.storeIds, rows),
      loadLinked(admin, rows),
    ]);
    const resumenRows = await applyOutcomes(admin, matchPortalRows(rows, candidates, linked), input.actor);
    const count = (k: CotejoResumenRow["outcome"]) => resumenRows.filter((r) => r.outcome === k).length;
    return record(
      {
        ok: true,
        fetched: rows.length,
        linked: count("vinculado"),
        review: count("revisar"),
        unmatched: count("sin_pareja"),
      },
      { skipped, rows: resumenRows },
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
