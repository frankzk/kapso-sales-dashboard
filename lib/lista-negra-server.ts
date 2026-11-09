import "server-only";

// La «Lista negra» unificada (MOM §41, owner 09-11-2026) — lo que lee el
// servidor: la marca de las filas de Leads y la búsqueda por UN celular de la
// página. La regla y las respuestas, puras, en lib/lista-negra.ts.
//
// NUNCA LA LISTA. Los celulares de la automática (`pago_online_phones`) solo
// los lee el servidor; aquí se contesta sí o no de los celulares que la página
// ya muestra (Leads) o del que una persona escribió (la búsqueda, con tope por
// persona: `lista_negra_searches`, 0329).

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgentNames } from "@/lib/agent-names";
import { formatLimaDateTime } from "@/lib/automations-catalog";
import { isMissingPagoOnline } from "@/lib/pago-online-lookup";
import {
  isPagoOnlineMode,
  isPagoOnlineReason,
  isPagoOnlineRequirement,
  pagoOnlineListedKey,
  pagoOnlinePhoneKey,
  PAGO_ONLINE_DEFAULT_REQUIREMENT,
} from "@/lib/pago-online";
import { isMissingPrepayTable, prepayLookup, withRequirementColumn } from "@/lib/prepay-list-server";
import { prepayPhoneKey } from "@/lib/prepay-list";
import {
  LISTA_NEGRA_SEARCH_LIMIT,
  LISTA_NEGRA_SEARCH_ORDERS,
  LISTA_NEGRA_SEARCH_WINDOW_MIN,
  listaNegraSearchLimited,
  listaNegraAutoMark,
  listaNegraManualMark,
  listaNegraMergeMarks,
  listaNegraSearchView,
  type ListaNegraMark,
  type ListaNegraSearchView,
} from "@/lib/lista-negra";

/**
 * Los celulares de una página que están en la Lista negra —la automática
 * vigente (Activo, sin las excepciones de Kapta) o un alta viva a mano—, como
 * llaves `listaNegraKey(org, celular)` → su marca (motivo y requisito, con las
 * cuentas del propio cliente). UNA lectura por página, como la chapa del
 * Master: las dos listas a la par y los trozos de celulares también. Con el
 * cliente de servicio: los celulares de la automática no se leen desde el
 * navegador, y aquí solo se contesta de los que la página ya muestra. Lanza si
 * la base falla; sin la 0326 o la 0309, esa lista no marca nada.
 */
export async function listaNegraMarksAmong(
  admin: SupabaseClient,
  orgIds: readonly string[],
  rawPhones: readonly (string | null | undefined)[],
): Promise<Map<string, ListaNegraMark>> {
  const out = new Map<string, ListaNegraMark>();
  const orgs = [...new Set(orgIds.filter(Boolean))];
  const phones9 = [...new Set(rawPhones.map(pagoOnlinePhoneKey).filter((p): p is string => !!p))];
  if (!orgs.length || !phones9.length) return out;
  const chunks: string[][] = [];
  for (let i = 0; i < phones9.length; i += 200) chunks.push(phones9.slice(i, i + 200));

  const { data: settingsRows, error: sErr } = await admin
    .from("pago_online_settings")
    .select("org_id,current_run_id,requirement")
    .in("org_id", orgs)
    .eq("mode", "activo");
  if (sErr && !isMissingPagoOnline(sErr)) throw new Error(sErr.message);
  const runs = ((settingsRows ?? []) as { org_id: string; current_run_id: string | null; requirement?: string }[]).filter((r) => r.current_run_id);
  const runOrg = new Map(runs.map((r) => [r.current_run_id!, r]));

  const auto = new Map<string, ListaNegraMark>();
  const manual = new Map<string, ListaNegraMark>();
  await Promise.all(
    chunks.map(async (chunk) => {
      const canonical = chunk.map((p) => `51${p}`);
      const [hits, exc, entries] = await Promise.all([
        runOrg.size
          ? admin.from("pago_online_phones").select("run_id,phone,reason,failed,orders").in("run_id", [...runOrg.keys()]).in("phone", chunk)
          : Promise.resolve({ data: [], error: null }),
        runOrg.size
          ? admin
              .from("pago_online_exceptions")
              .select("org_id,phone")
              .in("org_id", [...new Set(runs.map((r) => r.org_id))])
              .in("phone", chunk)
              .is("removed_at", null)
          : Promise.resolve({ data: [], error: null }),
        withRequirementColumn((columns) =>
          admin
            .from("prepay_list_entries")
            .select(columns.endsWith(",requirement") ? "org_id,phone,reason,requirement" : "org_id,phone,reason")
            .in("org_id", orgs)
            .in("phone", canonical)
            .is("removed_at", null),
        ),
      ]);
      if (hits.error) throw new Error(hits.error.message);
      if (exc.error) throw new Error(exc.error.message);
      if (entries.error && !isMissingPrepayTable(entries.error)) throw new Error(entries.error.message ?? "error de la base");
      const excepted = new Set(((exc.data ?? []) as { org_id: string; phone: string }[]).map((e) => pagoOnlineListedKey(e.org_id, e.phone)));
      for (const h of (hits.data ?? []) as { run_id: string; phone: string; reason: string; failed: number | null; orders: number | null }[]) {
        const run = runOrg.get(h.run_id);
        if (!run) continue;
        const key = pagoOnlineListedKey(run.org_id, h.phone);
        if (excepted.has(key)) continue;
        auto.set(
          key,
          listaNegraAutoMark(
            { reason: isPagoOnlineReason(h.reason) ? h.reason : "devuelto", failed: h.failed, orders: h.orders },
            isPagoOnlineRequirement(run.requirement) ? run.requirement : PAGO_ONLINE_DEFAULT_REQUIREMENT,
          ),
        );
      }
      for (const e of (entries.error ? [] : (entries.data ?? [])) as unknown as { org_id: string; phone: string; reason: string; requirement?: unknown }[]) {
        manual.set(pagoOnlineListedKey(e.org_id, e.phone.slice(-9)), listaNegraManualMark(e));
      }
    }),
  );
  for (const key of new Set([...auto.keys(), ...manual.keys()])) {
    const mark = listaNegraMergeMarks(manual.get(key), auto.get(key));
    if (mark) out.set(key, mark);
  }
  return out;
}

export type ListaNegraSearchResult = { ok: true; view: ListaNegraSearchView } | { ok: false; error: string };

/**
 * ¿Pasó el tope de búsquedas de esta persona? Cuenta y anota la búsqueda (sin
 * el celular). Sin la 0329 no hay dónde contar: deja pasar, como el tope del
 * conector de IA (el permiso de la página sigue mandando).
 */
async function searchLimited(admin: SupabaseClient, orgId: string, userId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - LISTA_NEGRA_SEARCH_WINDOW_MIN * 60_000).toISOString();
  const { count, error } = await admin
    .from("lista_negra_searches")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  if (error) return false;
  if (listaNegraSearchLimited(count ?? 0)) return true;
  await admin.from("lista_negra_searches").insert({ org_id: orgId, user_id: userId, created_at: now.toISOString() });
  return false;
}

/**
 * LA BÚSQUEDA DE LA PÁGINA: todo lo de UN celular en una organización —si está
 * en la automática y por qué, si Kapta lo exceptuó, si tiene un alta a mano y
 * sus pedidos recientes— y nada de ningún otro. `sb` es la sesión de quien
 * busca: sus pedidos se leen con su RLS. Nunca lanza.
 */
export async function searchListaNegra(
  admin: SupabaseClient,
  sb: SupabaseClient,
  input: { orgId: string; phone: string; userId: string; canManage: boolean; now?: Date },
): Promise<ListaNegraSearchResult> {
  const canonical = prepayPhoneKey(input.phone);
  if (!canonical) return { ok: false, error: "Escribe un celular peruano de 9 dígitos que empiece por 9." };
  const phone9 = canonical.slice(2);
  try {
    if (await searchLimited(admin, input.orgId, input.userId, input.now ?? new Date())) {
      return { ok: false, error: `Ya buscaste ${LISTA_NEGRA_SEARCH_LIMIT} celulares en ${LISTA_NEGRA_SEARCH_WINDOW_MIN} minutos: espera un poco y vuelve a buscar.` };
    }
    const [settingsRes, excRes, manual, storesRes] = await Promise.all([
      admin.from("pago_online_settings").select("mode,requirement,current_run_id").eq("org_id", input.orgId).maybeSingle(),
      admin
        .from("pago_online_exceptions")
        .select("id,reason,order_name,added_by,added_at")
        .eq("org_id", input.orgId)
        .eq("phone", phone9)
        .is("removed_at", null)
        .limit(1),
      prepayLookup(admin, input.orgId, canonical),
      admin.from("stores").select("id").eq("org_id", input.orgId),
    ]);
    if (settingsRes.error && !isMissingPagoOnline(settingsRes.error)) return { ok: false, error: "No se pudo leer la lista automática. Intenta de nuevo." };
    if (excRes.error && !isMissingPagoOnline(excRes.error)) return { ok: false, error: "No se pudieron leer las excepciones. Intenta de nuevo." };
    if (manual.state === "unread") return { ok: false, error: "No se pudo leer la lista a mano. Intenta de nuevo." };
    if (storesRes.error) return { ok: false, error: "No se pudieron leer las tiendas. Intenta de nuevo." };

    const settings = (settingsRes.data ?? null) as { mode?: string; requirement?: string; current_run_id?: string | null } | null;
    const mode = isPagoOnlineMode(settings?.mode) ? settings!.mode : "apagado";
    const runId = settings?.current_run_id ?? null;
    const storeIds = ((storesRes.data ?? []) as { id: string }[]).map((s) => s.id);
    const [autoRes, ordersRes] = await Promise.all([
      runId && mode === "activo"
        ? admin.from("pago_online_phones").select("reason,failed,orders").eq("run_id", runId).eq("phone", phone9).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      storeIds.length
        ? sb
            .from("order_master")
            .select("order_id,order_name,general_status,order_created_at")
            .in("store_id", storeIds)
            .in("customer_phone", [canonical, phone9, `+${canonical}`])
            .order("order_created_at", { ascending: false })
            .limit(LISTA_NEGRA_SEARCH_ORDERS)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (autoRes.error) return { ok: false, error: "No se pudo leer la lista automática. Intenta de nuevo." };
    const auto = autoRes.data as { reason?: string; failed?: number | null; orders?: number | null } | null;
    const exc = ((excRes.data ?? []) as { id: string; reason: string; order_name: string | null; added_by: string | null; added_at: string }[])[0] ?? null;
    const entry = manual.state === "listed" ? manual.entry : null;
    const people = await resolveAgentNames([exc?.added_by, entry?.added_by].filter((id): id is string => !!id), admin);
    const who = (id: string | null | undefined, fallback: string) => (id ? (people[id] ?? "Alguien del equipo") : fallback);

    const view = listaNegraSearchView({
      phone: canonical,
      mode,
      requirement: isPagoOnlineRequirement(settings?.requirement) ? settings!.requirement : PAGO_ONLINE_DEFAULT_REQUIREMENT,
      hasCurrentList: !!runId,
      autoRow: auto
        ? { reason: isPagoOnlineReason(auto.reason) ? auto.reason : "devuelto", failed: auto.failed ?? null, orders: auto.orders ?? null }
        : null,
      exception: exc ? { id: exc.id, reason: exc.reason, added_at: exc.added_at, order_name: exc.order_name, added_by_name: who(exc.added_by, "Kapta") } : null,
      manual: entry
        ? { id: entry.id, reason: entry.reason, requirement: entry.requirement, added_at: entry.added_at, source: entry.source, added_by_name: who(entry.added_by, "Kapta (automático)") }
        : null,
      // Lo que no se pudo leer de sus pedidos no tumba la respuesta: sin pedidos.
      orders: ordersRes.error ? [] : ((ordersRes.data ?? []) as { order_id: string; order_name: string | null; general_status: string | null; order_created_at: string | null }[]),
      canManage: input.canManage,
      formatAt: formatLimaDateTime,
    });
    return { ok: true, view };
  } catch {
    return { ok: false, error: "No se pudo buscar. Intenta de nuevo." };
  }
}

/** ¿Este celular está en la corrida vigente de la automática (Activo)? Para «Exceptuar» desde la búsqueda. Lanza si la base falla. */
export async function inCurrentAutoList(admin: SupabaseClient, orgId: string, rawPhone: string): Promise<boolean> {
  const canonical = prepayPhoneKey(rawPhone);
  if (!canonical) return false;
  const { data: s, error } = await admin.from("pago_online_settings").select("mode,current_run_id").eq("org_id", orgId).maybeSingle();
  if (error) {
    if (isMissingPagoOnline(error)) return false;
    throw new Error(error.message);
  }
  const settings = s as { mode?: string; current_run_id?: string | null } | null;
  if (settings?.mode !== "activo" || !settings.current_run_id) return false;
  const { data, error: pErr } = await admin
    .from("pago_online_phones")
    .select("phone")
    .eq("run_id", settings.current_run_id)
    .eq("phone", canonical.slice(2))
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  return !!data;
}
