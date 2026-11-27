import "server-only";

// «Correo · Resend» del lado del servidor (MOM §46, 0355): lo que lee la
// pantalla, guardar la clave, dejar listos en Resend el tema de cada tienda y
// sus segmentos, y subir un tramo. La clave se descifra solo aquí y solo para
// llamar a Resend; nunca vuelve al navegador ni se registra.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { hasOrgPermission, orgsWithPermission } from "@/lib/permissions-access";
import { resolveAgentNames } from "@/lib/agent-names";
import {
  RESEND_BUCKETS,
  RESEND_TYPO_DOMAINS,
  filterResendContacts,
  isResendMigrationMissing,
  resendBucket,
  resendContactsCsv,
  resendCsvFilename,
  resendErrorMessage,
  resendImportDetail,
  resendImportStatus,
  resendSegmentKey,
  resendSegmentName,
  resendTopicDescription,
  resendTopicName,
  type ResendBucket,
  type ResendContact,
  type ResendContactRow,
  type ResendImportStatus,
  type ResendApiError,
} from "@/lib/resend-marketing";
import {
  createResendContactImport,
  createResendSegment,
  createResendTopic,
  getResendContactImport,
  listResendSegments,
  listResendTopics,
  type ResendFetch,
} from "@/lib/resend-client";

export interface ResendStoreView {
  id: string;
  name: string;
  /** Cuántos hay por tramo; null si no se pudo contar. */
  counts: Record<ResendBucket, number> | null;
  /** El tema de la tienda ya existe en Resend. */
  topicReady: boolean;
  /** Los segmentos que ya existen en Resend, por tramo. */
  segmentsReady: ResendBucket[];
}

export interface ResendImportView {
  id: string;
  storeName: string;
  bucket: ResendBucket;
  rows: number;
  excluded: number;
  status: ResendImportStatus;
  detail: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface ResendOrgView {
  id: string;
  name: string;
  keyHint: string | null;
  keyUpdatedAt: string | null;
  stores: ResendStoreView[];
  imports: ResendImportView[];
  /** Puede subir y bajar contactos (`data.export`); sin él solo ve las cifras. */
  canExport: boolean;
}

export interface ResendPanelData {
  denied: boolean;
  migrationMissing: boolean;
  orgs: ResendOrgView[];
}

interface SettingsRow {
  org_id: string;
  api_key_enc: string | null;
  key_hint: string | null;
  topics: Record<string, string> | null;
  segments: Record<string, string> | null;
  updated_at: string | null;
}

interface ImportRow {
  id: string;
  org_id: string;
  store_id: string;
  bucket: ResendBucket;
  resend_import_id: string | null;
  rows: number;
  excluded: number;
  status: ResendImportStatus;
  detail: string | null;
  created_by: string | null;
  created_at: string;
}

/** Una importación sigue «procesando» en Resend: se pregunta al abrir la página, si es de las últimas 48 h. */
const REFRESH_WINDOW_MS = 48 * 3600_000;

export async function loadResendPanel(now: Date = new Date()): Promise<ResendPanelData> {
  const memberships = await orgsWithPermission("automations.manage");
  if (!memberships.length) return { denied: true, migrationMissing: false, orgs: [] };
  const orgIds = [...new Set(memberships.map((m) => m.org_id))];
  const sb = await createServerSupabase();
  const admin = createAdminSupabase();
  const [{ data: orgRows }, { data: storeRows }, settingsRes, importsRes, exportFlags] = await Promise.all([
    admin.from("organizations").select("id, name").in("id", orgIds),
    // RLS: solo las tiendas que la persona ve.
    sb.from("stores").select("id, name, org_id").in("org_id", orgIds).order("name"),
    admin.from("resend_settings").select("org_id, api_key_enc, key_hint, topics, segments, updated_at").in("org_id", orgIds),
    admin
      .from("resend_imports")
      .select("id, org_id, store_id, bucket, resend_import_id, rows, excluded, status, detail, created_by, created_at")
      .in("org_id", orgIds)
      .order("created_at", { ascending: false })
      .limit(60),
    Promise.all(orgIds.map((id) => hasOrgPermission(id, "data.export"))),
  ]);
  if (isResendMigrationMissing(settingsRes.error) || isResendMigrationMissing(importsRes.error)) {
    return { denied: false, migrationMissing: true, orgs: [] };
  }
  if (settingsRes.error) throw new Error(`No pudimos leer la configuración de Resend: ${settingsRes.error.message}`);
  const settings = new Map(((settingsRes.data ?? []) as SettingsRow[]).map((s) => [s.org_id, s]));
  const imports = (importsRes.data ?? []) as ImportRow[];

  // Las importaciones que siguen en curso: se pregunta a Resend cómo van.
  await refreshPendingImports(admin, imports, settings, now);

  const stores = (storeRows ?? []) as { id: string; name: string; org_id: string }[];
  const countsByOrg = new Map<string, Map<string, Record<ResendBucket, number>>>();
  const countRes = await Promise.all(
    orgIds.map((orgId) =>
      admin.rpc("resend_marketing_counts", { p_org: orgId, p_exclude_domains: [...RESEND_TYPO_DOMAINS] }),
    ),
  );
  countRes.forEach((res, i) => {
    if (isResendMigrationMissing(res.error)) return;
    const map = new Map<string, Record<ResendBucket, number>>();
    for (const r of (res.data ?? []) as { store_id: string; total: number; last_6m: number; last_9m?: number | null; last_12m: number }[]) {
      map.set(r.store_id, {
        "6m": Number(r.last_6m) || 0,
        "9m": Number(r.last_9m) || 0,
        "12m": Number(r.last_12m) || 0,
        todos: Number(r.total) || 0,
      });
    }
    countsByOrg.set(orgIds[i]!, map);
  });

  const authorIds = [...new Set(imports.map((r) => r.created_by).filter((v): v is string => !!v))];
  const authors: Record<string, string> = authorIds.length ? await resolveAgentNames(authorIds, admin) : {};

  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const orgs: ResendOrgView[] = ((orgRows ?? []) as { id: string; name: string }[])
    .sort((a, b) => a.name.localeCompare(b.name, "es"))
    .map((org) => {
      const s = settings.get(org.id);
      const topics = s?.topics ?? {};
      const segments = s?.segments ?? {};
      const counts = countsByOrg.get(org.id);
      return {
        id: org.id,
        name: org.name,
        keyHint: s?.api_key_enc ? s.key_hint : null,
        keyUpdatedAt: s?.api_key_enc ? s.updated_at : null,
        canExport: exportFlags[orgIds.indexOf(org.id)] ?? false,
        stores: stores
          .filter((st) => st.org_id === org.id)
          .map((st) => ({
            id: st.id,
            name: st.name,
            counts: counts?.get(st.id) ?? (counts ? { "6m": 0, "9m": 0, "12m": 0, todos: 0 } : null),
            topicReady: !!topics[st.id],
            segmentsReady: RESEND_BUCKETS.map((b) => b.key).filter((b) => !!segments[resendSegmentKey(st.id, b)]),
          })),
        imports: imports
          .filter((r) => r.org_id === org.id && storeName.has(r.store_id))
          .map((r) => ({
            id: r.id,
            storeName: storeName.get(r.store_id) ?? "—",
            bucket: r.bucket,
            rows: r.rows,
            excluded: r.excluded,
            status: r.status,
            detail: r.detail,
            createdAt: r.created_at,
            createdBy: r.created_by ? authors[r.created_by] ?? null : null,
          })),
      };
    });
  return { denied: false, migrationMissing: false, orgs };
}

async function refreshPendingImports(
  admin: SupabaseClient,
  imports: ImportRow[],
  settings: Map<string, SettingsRow>,
  now: Date,
  fetchImpl: ResendFetch = fetch,
): Promise<void> {
  const pending = imports.filter(
    (r) =>
      (r.status === "enviada" || r.status === "procesando") &&
      r.resend_import_id &&
      now.getTime() - Date.parse(r.created_at) < REFRESH_WINDOW_MS,
  );
  if (!pending.length) return;
  const keys = new Map<string, string | null>();
  await Promise.all(
    pending.slice(0, 10).map(async (r) => {
      if (!keys.has(r.org_id)) keys.set(r.org_id, readKey(settings.get(r.org_id)));
      const key = keys.get(r.org_id);
      if (!key) return;
      const res = await getResendContactImport(key, r.resend_import_id!, fetchImpl);
      if (!res.ok) return;
      const status = resendImportStatus(res.data.status);
      const detail = resendImportDetail(res.data.counts) ?? r.detail;
      if (status === r.status && detail === r.detail) return;
      await admin
        .from("resend_imports")
        .update({ status, detail, updated_at: new Date().toISOString() })
        .eq("id", r.id);
      r.status = status;
      r.detail = detail;
    }),
  );
}

function readKey(s: SettingsRow | undefined): string | null {
  if (!s?.api_key_enc) return null;
  try {
    return decrypt(s.api_key_enc);
  } catch {
    return null;
  }
}

/** La clave de la organización, descifrada; null si no hay. */
export async function resendKeyFor(admin: SupabaseClient, orgId: string): Promise<string | null> {
  const { data } = await admin
    .from("resend_settings")
    .select("org_id, api_key_enc, key_hint, topics, segments, updated_at")
    .eq("org_id", orgId)
    .maybeSingle();
  return readKey((data ?? undefined) as SettingsRow | undefined);
}

export type ResendStepResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Deja en Resend lo que hace falta, y nada más (26-11-2026: el plan gratis de
 * Resend permite 3 segmentos y Kapta pedía 6 de golpe):
 * - el tema de cada tienda de `stores`;
 * - solo los segmentos de `buckets` (tienda y tramo): uno se crea recién
 *   cuando se sube ese tramo, no al guardar la clave.
 * Idempotente: usa el id guardado si sigue existiendo, si no el del mismo
 * nombre, y solo crea lo que falta. Lo que alcanzó a crear se guarda en
 * `resend_settings` aunque Resend rechace el siguiente; si no, la próxima vez
 * lo encuentra por nombre igual, pero Kapta mostraba «Sin crear».
 */
export async function ensureResendSetup(
  admin: SupabaseClient,
  orgId: string,
  key: string,
  stores: readonly { id: string; name: string }[],
  buckets: readonly ResendBucket[] = [],
  fetchImpl: ResendFetch = fetch,
): Promise<ResendStepResult<{ topics: Record<string, string>; segments: Record<string, string>; created: number }>> {
  const [{ data: row }, topicsRes, segmentsRes] = await Promise.all([
    admin.from("resend_settings").select("topics, segments").eq("org_id", orgId).maybeSingle(),
    listResendTopics(key, fetchImpl),
    buckets.length ? listResendSegments(key, fetchImpl) : Promise.resolve({ ok: true as const, data: [] }),
  ]);
  if (!topicsRes.ok) return { ok: false, error: resendErrorMessage(topicsRes.error) };
  if (!segmentsRes.ok) return { ok: false, error: resendErrorMessage(segmentsRes.error) };
  const saved = (row ?? {}) as { topics?: Record<string, string> | null; segments?: Record<string, string> | null };
  const topics: Record<string, string> = {};
  const segments: Record<string, string> = {};
  const topicIds = new Set(topicsRes.data.map((t) => t.id));
  const segmentIds = new Set(segmentsRes.data.map((s) => s.id));
  const topicByName = new Map(topicsRes.data.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const segmentByName = new Map(segmentsRes.data.map((s) => [s.name.trim().toLowerCase(), s.id]));
  let created = 0;

  const persist = async () => {
    const merged = {
      topics: { ...(saved.topics ?? {}), ...topics },
      segments: { ...(saved.segments ?? {}), ...segments },
    };
    await admin
      .from("resend_settings")
      .update({ ...merged, updated_at: new Date().toISOString() })
      .eq("org_id", orgId);
    return merged;
  };
  const fail = async (error: ResendApiError): Promise<ResendStepResult<never>> => {
    if (created) await persist();
    return { ok: false, error: resendErrorMessage(error) };
  };

  // En serie: Resend deja 10 llamadas por segundo y son pocas.
  for (const store of stores) {
    const topicName = resendTopicName(store.name);
    const savedTopic = saved.topics?.[store.id];
    let topicId = savedTopic && topicIds.has(savedTopic) ? savedTopic : topicByName.get(topicName.toLowerCase());
    if (!topicId) {
      const res = await createResendTopic(key, topicName, resendTopicDescription(store.name), fetchImpl);
      if (!res.ok) return fail(res.error);
      topicId = res.data.id;
      created += 1;
    }
    topics[store.id] = topicId;
    for (const bucket of buckets) {
      const segKey = resendSegmentKey(store.id, bucket);
      const name = resendSegmentName(store.name, bucket);
      const savedSeg = saved.segments?.[segKey];
      let segmentId = savedSeg && segmentIds.has(savedSeg) ? savedSeg : segmentByName.get(name.toLowerCase());
      if (!segmentId) {
        const res = await createResendSegment(key, name, fetchImpl);
        if (!res.ok) return fail(res.error);
        segmentId = res.data.id;
        created += 1;
      }
      segments[segKey] = segmentId;
    }
  }
  const merged = await persist();
  return { ok: true, value: { ...merged, created } };
}

/** Los contactos de un tramo, listos para el CSV. */
export async function exportResendContacts(
  admin: SupabaseClient,
  storeId: string,
  bucket: ResendBucket,
): Promise<ResendStepResult<{ contacts: ResendContact[]; excluded: number }>> {
  const { data, error } = await admin.rpc("resend_marketing_export", {
    p_store: storeId,
    p_months: resendBucket(bucket).months,
    p_exclude_domains: [],
  });
  if (error) {
    return { ok: false, error: isResendMigrationMissing(error) ? "Falta la migración 0355." : `No pudimos leer los contactos: ${error.message}` };
  }
  const rows = (Array.isArray(data) ? data : []) as ResendContactRow[];
  return { ok: true, value: filterResendContacts(rows) };
}

/**
 * Sube un tramo de una tienda: prepara el tema y los segmentos, arma el CSV y
 * pide la importación. Deja constancia en `resend_imports`.
 */
export async function importResendBucket(
  input: { orgId: string; store: { id: string; name: string }; bucket: ResendBucket; userId: string; day: string },
  fetchImpl: ResendFetch = fetch,
): Promise<ResendStepResult<{ rows: number; excluded: number }>> {
  const admin = createAdminSupabase();
  const key = await resendKeyFor(admin, input.orgId);
  if (!key) return { ok: false, error: "Primero guarda la clave de Resend." };
  const setup = await ensureResendSetup(admin, input.orgId, key, [input.store], [input.bucket], fetchImpl);
  if (!setup.ok) return setup;
  const segmentId = setup.value.segments[resendSegmentKey(input.store.id, input.bucket)];
  if (!segmentId) return { ok: false, error: "No encontramos el segmento en Resend. Vuelve a intentarlo." };
  const exported = await exportResendContacts(admin, input.store.id, input.bucket);
  if (!exported.ok) return exported;
  const { contacts, excluded } = exported.value;
  if (!contacts.length) return { ok: false, error: "Ese tramo no tiene contactos para subir." };
  const csv = resendContactsCsv(contacts);
  const res = await createResendContactImport(
    key,
    { csv, filename: resendCsvFilename(input.store.name, input.bucket, input.day), segmentId },
    fetchImpl,
  );
  const failed = !res.ok;
  const { error: insertError } = await admin.from("resend_imports").insert({
    org_id: input.orgId,
    store_id: input.store.id,
    bucket: input.bucket,
    resend_import_id: res.ok ? res.data.id : null,
    rows: contacts.length,
    excluded,
    status: failed ? "fallida" : "procesando",
    detail: failed ? resendErrorMessage(res.error) : null,
    created_by: input.userId,
  });
  if (insertError) console.error("[resend] no se guardó la importación", insertError.message);
  if (!res.ok) return { ok: false, error: resendErrorMessage(res.error) };
  return { ok: true, value: { rows: contacts.length, excluded } };
}
