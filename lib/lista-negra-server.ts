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
import { forgetListaNegraIndex, LISTA_NEGRA_INDEX_TTL_MS, listaNegraIndexCache } from "@/lib/lista-negra-cache";
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
 * Cuánto vive en memoria el índice de la Lista negra de una organización
 * (11-11-2026). Leads se refresca sola cada ~30 s en la pantalla de cada
 * asesora y cada refresco preguntaba por TODOS los celulares de la cola: tres
 * lecturas por cada 200 celulares, unas 22 000 por hora a la base (la puerta de
 * PostgREST se saturó y la base se reinició a las 10:31 de Lima). Ahora cada
 * instancia del servidor lee la lista ENTERA de la organización —~3 100
 * celulares, unos cientos de KB— como mucho cada dos minutos y contesta en
 * memoria. Un alta, una baja o una excepción se ven en otra instancia hasta dos
 * minutos después; en la que la hizo, al instante (`forgetListaNegraIndex`,
 * lib/lista-negra-cache.ts).
 */
interface ListaNegraOrgIndex {
  /** La automática vigente sin las excepciones: celular (9 dígitos) → marca. */
  auto: Map<string, ListaNegraMark>;
  /** Las altas vivas a mano: celular (9 dígitos) → marca. */
  manual: Map<string, ListaNegraMark>;
}

const indexCache = listaNegraIndexCache as Map<string, { at: number; index: Promise<ListaNegraOrgIndex> }>;
export { forgetListaNegraIndex, LISTA_NEGRA_INDEX_TTL_MS };

const PAGE = 1000;

/** Lee la lista entera de la organización. Lanza si la base falla. */
async function loadListaNegraOrgIndex(admin: SupabaseClient, orgId: string): Promise<ListaNegraOrgIndex> {
  const auto = new Map<string, ListaNegraMark>();
  const manual = new Map<string, ListaNegraMark>();

  const { data: settingsRow, error: sErr } = await admin
    .from("pago_online_settings")
    .select("org_id,current_run_id,requirement")
    .eq("org_id", orgId)
    .eq("mode", "activo")
    .maybeSingle();
  if (sErr && !isMissingPagoOnline(sErr)) throw new Error(sErr.message);
  const run = settingsRow as { current_run_id: string | null; requirement?: string } | null;

  const [phones, exceptions, entries] = await Promise.all([
    (async () => {
      const rows: { phone: string; reason: string; failed: number | null; orders: number | null }[] = [];
      if (!run?.current_run_id) return rows;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await admin
          .from("pago_online_phones")
          .select("phone,reason,failed,orders")
          .eq("run_id", run.current_run_id)
          .order("phone")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const page = (data ?? []) as typeof rows;
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
    })(),
    run?.current_run_id
      ? admin.from("pago_online_exceptions").select("phone").eq("org_id", orgId).is("removed_at", null)
      : Promise.resolve({ data: [], error: null }),
    withRequirementColumn((columns) =>
      admin
        .from("prepay_list_entries")
        .select(columns.endsWith(",requirement") ? "phone,reason,requirement" : "phone,reason")
        .eq("org_id", orgId)
        .is("removed_at", null),
    ),
  ]);
  if (exceptions.error) throw new Error(exceptions.error.message);
  if (entries.error && !isMissingPrepayTable(entries.error)) throw new Error(entries.error.message ?? "error de la base");

  const excepted = new Set(((exceptions.data ?? []) as { phone: string }[]).map((e) => pagoOnlinePhoneKey(e.phone)).filter(Boolean));
  const requirement = isPagoOnlineRequirement(run?.requirement) ? run!.requirement! : PAGO_ONLINE_DEFAULT_REQUIREMENT;
  for (const h of phones) {
    const phone = pagoOnlinePhoneKey(h.phone);
    if (!phone || excepted.has(phone)) continue;
    auto.set(
      phone,
      listaNegraAutoMark(
        { reason: isPagoOnlineReason(h.reason) ? h.reason : "devuelto", failed: h.failed, orders: h.orders },
        requirement as Parameters<typeof listaNegraAutoMark>[1],
      ),
    );
  }
  for (const e of (entries.error ? [] : (entries.data ?? [])) as unknown as { phone: string; reason: string; requirement?: unknown }[]) {
    const phone = pagoOnlinePhoneKey(e.phone);
    if (phone) manual.set(phone, listaNegraManualMark(e));
  }
  return { auto, manual };
}

/** El índice de la organización, de memoria si tiene menos de dos minutos. */
function listaNegraOrgIndex(admin: SupabaseClient, orgId: string, now = Date.now()): Promise<ListaNegraOrgIndex> {
  const hit = indexCache.get(orgId);
  if (hit && now - hit.at < LISTA_NEGRA_INDEX_TTL_MS) return hit.index;
  const index = loadListaNegraOrgIndex(admin, orgId);
  indexCache.set(orgId, { at: now, index });
  // Si la lectura falla, no se guarda: la próxima vuelve a intentar.
  index.catch(() => {
    if (indexCache.get(orgId)?.index === index) indexCache.delete(orgId);
  });
  return index;
}

/**
 * Los celulares de una página que están en la Lista negra —la automática
 * vigente (Activo, sin las excepciones de Kapta) o un alta viva a mano—, como
 * llaves `listaNegraKey(org, celular)` → su marca (motivo y requisito, con las
 * cuentas del propio cliente). Contesta desde el índice en memoria de cada
 * organización (`LISTA_NEGRA_INDEX_TTL_MS`); la lista no sale del servidor.
 * Lanza si la base falla; sin la 0326 o la 0309, esa lista no marca nada.
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
  const indexes = await Promise.all(orgs.map((org) => listaNegraOrgIndex(admin, org)));
  orgs.forEach((org, i) => {
    const index = indexes[i]!;
    for (const phone of phones9) {
      const mark = listaNegraMergeMarks(index.manual.get(phone), index.auto.get(phone));
      if (mark) out.set(pagoOnlineListedKey(org, phone), mark);
    }
  });
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
