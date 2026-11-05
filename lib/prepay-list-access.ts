// La página «Lista de pago adelantado» (MOM §41): qué ve cada quien.
//
//   * VER la lista: cualquiera que vea pedidos de la organización (todo
//     miembro que no sea motorizado). La lectura va con su sesión: la RLS de
//     la 0309 solo deja ver las altas de sus organizaciones.
//   * CAMBIARLA (agregar o quitar con motivo): `prepay_list.manage`, que traen
//     dueño y admin por su rol.
//
// El último pedido de cada celular se busca en lote en el Master, también con
// la sesión de quien mira: no ve pedidos de tiendas que no puede ver.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import { resolveAgentNames } from "@/lib/agent-names";
import { formatLimaDateTime } from "@/lib/automations-catalog";
import { PREPAY_ENTRY_COLUMNS, isMissingPrepayTable, type PrepayEntryRow } from "@/lib/prepay-list-server";
import { parsePrepayEvidence, prepayPhoneLabel, type PrepayEvidence } from "@/lib/prepay-list";

export interface PrepayEntryView {
  id: string;
  phone: string;
  phoneLabel: string;
  source: "auto" | "manual";
  reason: string;
  evidence: PrepayEvidence;
  /** El pedido más reciente de ese celular que quien mira puede ver. */
  lastOrderName: string | null;
  lastOrderId: string | null;
  addedAt: string;
  addedBy: string;
  removedAt: string | null;
  removedBy: string | null;
  removedReason: string | null;
}

export interface PrepayOrgView {
  orgId: string;
  orgName: string;
  canManage: boolean;
  active: PrepayEntryView[];
  removed: PrepayEntryView[];
  error: string | null;
}

export type PrepayPageData = { denied: true } | { denied: false; installed: boolean; orgs: PrepayOrgView[] };

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>;

async function allRows<T>(read: (from: number, to: number) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await read(from, from + 499);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    out.push(...(data ?? []));
    if ((data ?? []).length < 500) return out;
  }
}

/** El pedido más reciente de cada celular (canónico), en lote. */
async function lastOrders(sb: SupabaseClient, phones: string[]): Promise<Map<string, { id: string; name: string | null }>> {
  const out = new Map<string, { id: string; name: string | null; at: string }>();
  for (let i = 0; i < phones.length; i += 150) {
    const { data, error } = await sb
      .from("order_master")
      .select("order_id,order_name,customer_phone,order_created_at")
      .in("customer_phone", phones.slice(i, i + 150))
      .order("order_created_at", { ascending: false })
      .limit(1000);
    if (error) break;
    for (const r of (data ?? []) as { order_id: string; order_name: string | null; customer_phone: string; order_created_at: string | null }[]) {
      const prev = out.get(r.customer_phone);
      if (!prev || (r.order_created_at ?? "") > prev.at) out.set(r.customer_phone, { id: r.order_id, name: r.order_name, at: r.order_created_at ?? "" });
    }
  }
  return new Map([...out].map(([k, v]) => [k, { id: v.id, name: v.name }]));
}

export async function loadPrepayListPage(): Promise<PrepayPageData> {
  const user = await getCurrentUser();
  if (!user) return { denied: true };
  const sb = await createServerSupabase();
  const { data: memberships } = await sb.from("memberships").select("org_id,role").eq("user_id", user.id);
  const orgIds = [...new Set(((memberships ?? []) as { org_id: string; role: string }[]).filter((m) => m.role !== "motorizado").map((m) => m.org_id))];
  if (!orgIds.length) return { denied: true };

  const admin = createAdminSupabase();
  const [{ data: orgRows }, manage] = await Promise.all([
    admin.from("organizations").select("id,name").in("id", orgIds),
    Promise.all(orgIds.map((orgId) => hasOrgPermission(orgId, "prepay_list.manage"))),
  ]);
  const names = new Map(((orgRows ?? []) as { id: string; name: string | null }[]).map((o) => [o.id, o.name ?? "Organización"]));

  let rows: PrepayEntryRow[] = [];
  try {
    rows = await allRows<PrepayEntryRow>((from, to) =>
      sb
        .from("prepay_list_entries")
        .select(PREPAY_ENTRY_COLUMNS)
        .in("org_id", orgIds)
        .order("added_at", { ascending: false })
        .order("id")
        .range(from, to) as unknown as Page<PrepayEntryRow>,
    );
  } catch (e) {
    if (isMissingPrepayTable(e as { code?: string; message?: string })) return { denied: false, installed: false, orgs: [] };
    return {
      denied: false,
      installed: true,
      orgs: orgIds.map((orgId, i) => ({
        orgId,
        orgName: names.get(orgId) ?? "Organización",
        canManage: manage[i] === true,
        active: [],
        removed: [],
        error: "No se pudo leer la lista. Recarga la página.",
      })),
    };
  }

  const people = await resolveAgentNames(
    rows.flatMap((r) => [r.added_by, r.removed_by]).filter((id): id is string => !!id),
    admin,
  );
  const activePhones = [...new Set(rows.filter((r) => !r.removed_at).map((r) => r.phone))];
  const latest = await lastOrders(sb, activePhones);

  const view = (r: PrepayEntryRow): PrepayEntryView => ({
    id: r.id,
    phone: r.phone,
    phoneLabel: prepayPhoneLabel(r.phone),
    source: r.source,
    reason: r.reason,
    evidence: parsePrepayEvidence(r.evidence),
    lastOrderName: latest.get(r.phone)?.name ?? null,
    lastOrderId: latest.get(r.phone)?.id ?? null,
    addedAt: formatLimaDateTime(r.added_at),
    addedBy: r.added_by ? (people[r.added_by] ?? "Alguien del equipo") : "Kapta (automático)",
    removedAt: r.removed_at ? formatLimaDateTime(r.removed_at) : null,
    removedBy: r.removed_at ? (r.removed_by ? (people[r.removed_by] ?? "Alguien del equipo") : "Kapta") : null,
    removedReason: r.removed_reason,
  });

  const orgs: PrepayOrgView[] = orgIds.map((orgId, i) => {
    const mine = rows.filter((r) => r.org_id === orgId);
    return {
      orgId,
      orgName: names.get(orgId) ?? "Organización",
      canManage: manage[i] === true,
      active: mine.filter((r) => !r.removed_at).map(view),
      removed: mine.filter((r) => !!r.removed_at).map(view),
      error: null,
    };
  });
  orgs.sort((a, b) => a.orgName.localeCompare(b.orgName, "es"));
  return { denied: false, installed: true, orgs };
}
