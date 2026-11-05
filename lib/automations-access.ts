import "server-only";

// Lectura del panel «Automatizaciones» (MOM §40). Entra quien tiene
// `automations.manage` en la organización (el owner, o a quien él se lo dé);
// todo lo demás se lee con el cliente de servicio DESPUÉS de comprobarlo,
// porque varias de estas tablas solo dejan leer a `service_role`
// (`chatby_auto_settings` sí deja leer a miembros, `auto_order_cohorts` no).
//
// Un fallo de una lectura no tumba el panel: la parte que falló se dice en
// la página y el resto se puede seguir usando. Lo que no se pudo leer NUNCA
// se muestra como «Apagado»: un interruptor que no se sabe cómo está se
// bloquea y dice «Sin dato».

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { orgsWithPermission } from "@/lib/permissions-access";
import { resolveAgentNames } from "@/lib/agent-names";
import { limaTodayKey } from "@/lib/shipments";
import { urpiAutoEnabled } from "@/lib/urpi-auto-sync";
import {
  RETRY_DAILY_CAP_DEFAULT,
  RETRY_OUTCOME_LABEL,
  RETRY_OUTCOMES,
  RETRY_OUTCOMES_COUNTED,
  isRetryVariant,
  retryModes,
  retryVariantLabel,
  type RetryMode,
  type RetryOutcome,
  type RetryVariant,
} from "@/lib/lima-retry-auto";
import {
  AUTOMATIONS,
  ORG_AUTOMATION_TABLES,
  ORG_TABLE_SHAPE,
  STORE_AUTOMATION_COLUMNS,
  automationEventLabel,
  automationValueLabel,
  formatLimaDateTime,
  joinNames,
  type OrgAutomationTable,
} from "@/lib/automations-catalog";
import { loadPrepaySettings } from "@/lib/prepay-list-server";
import { parsePrepaySimulationSummary, type PrepayMode, type PrepaySimulationSummary } from "@/lib/prepay-list";
import {
  GEOCODE_KEY_MISSING,
  geocodeLimaGate,
  parseGeocodeLimaRunSummary,
  type GeocodeLimaGate,
  type GeocodeLimaRunSummary,
} from "@/lib/geocode-google";

/** Un renglón de «Hoy y ayer». */
export interface RetryLogView {
  id: number;
  day: "hoy" | "ayer";
  orderId: string;
  orderName: string;
  storeId: string;
  storeName: string | null;
  variantLabel: string;
  mode: "simulacion" | "activo";
  outcome: RetryOutcome | null;
  outcomeLabel: string;
  transport: string | null;
  guideCode: string | null;
  detail: string | null;
  at: string;
}

export interface RetryView {
  /** Falso si la migración 0306 aún no está: la parte se muestra bloqueada. */
  available: boolean;
  error: string | null;
  modes: Record<RetryVariant, RetryMode>;
  dailyCap: number;
  /** Guías automáticas que hoy cuentan para el tope. */
  countedToday: number;
  log: RetryLogView[];
  geocode: RetryGeocodeView;
}

/**
 * «Usar la ubicación por dirección (Google)» de los reintentos (0308, owner
 * 05-11-2026) y la última medición de Lima, de la que depende poder encenderlo.
 */
export interface RetryGeocodeView {
  /** Falso si la migración 0308 aún no está: el interruptor y el botón se bloquean. */
  available: boolean;
  enabled: boolean;
  /** `GOOGLE_GEOCODING_API_KEY` está en el entorno. */
  keyPresent: boolean;
  /** La última medición de Lima: fecha de Lima y solo cuentas. */
  latest: { at: string; summary: GeocodeLimaRunSummary | null } | null;
  /** ¿La última medición deja encenderlo? Apagar se puede siempre. */
  gate: GeocodeLimaGate;
  /** Por qué no se puede encender ahora (la clave, la medición o la base), o null. */
  blocked: string | null;
  error: string | null;
}

/** El estado de un interruptor de la organización. `unknown`: no se pudo leer. */
export interface OrgSwitchView {
  state: "on" | "off" | "missing" | "unknown";
  requiresOn: boolean;
}

export interface StoreSwitchView {
  storeId: string;
  storeName: string;
  on: boolean;
  requiresOn: boolean;
}

export interface ReadonlyStateView {
  label: string;
  tone: "ok" | "neutral" | "warn";
}

export interface SwitchEventView {
  id: number;
  at: string;
  what: string;
  storeName: string | null;
  previous: string;
  next: string;
  actor: string;
}

/** La regla automática de la «Lista de pago adelantado» (0309, MOM §41). */
export interface PrepayAutoView {
  /** Falso si la migración 0309 aún no está: el control se bloquea. */
  available: boolean;
  mode: PrepayMode;
  /** Cuántos celulares hay hoy en la lista (vivos). Null: no se pudo contar. */
  activeCount: number | null;
  lastSimulation: { at: string; summary: PrepaySimulationSummary } | null;
  lastRun: { at: string; summary: PrepaySimulationSummary } | null;
  error: string | null;
}

export interface AutomationsOrgView {
  orgId: string;
  orgName: string;
  /** Las tiendas activas: una por interruptor de tienda y por enlace a sus ajustes. */
  stores: { id: string; name: string }[];
  retry: RetryView;
  prepay: PrepayAutoView;
  org: Record<string, OrgSwitchView>;
  /** Interruptores de tienda; `null` si no se pudieron leer las tiendas. */
  store: Record<string, StoreSwitchView[]> | null;
  readonly: Record<string, ReadonlyStateView>;
  events: SwitchEventView[];
  /** Las partes que no se pudieron leer, en llano. */
  errors: string[];
}

export type AutomationsPanelData = { denied: true } | { denied: false; orgs: AutomationsOrgView[] };

const LOG_LIMIT = 200;
const EVENTS_LIMIT = 20;

/** La tabla aún no existe (migración sin aplicar): PostgREST o Postgres. */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(error.message ?? "");
}

function yesterdayKey(today: string): string {
  return new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

const on = (label: string): ReadonlyStateView => ({ label, tone: "ok" });
const off = (label: string): ReadonlyStateView => ({ label, tone: "neutral" });

export async function loadAutomationsPanel(): Promise<AutomationsPanelData> {
  const memberships = await orgsWithPermission("automations.manage");
  if (memberships.length === 0) return { denied: true };
  const admin = createAdminSupabase();
  const orgIds = [...new Set(memberships.map((m) => m.org_id))];
  const { data: orgRows } = await admin.from("organizations").select("id,name").in("id", orgIds);
  const names = new Map(((orgRows ?? []) as { id: string; name: string | null }[]).map((o) => [o.id, o.name ?? "Organización"]));
  const orgs = await Promise.all(orgIds.map((orgId) => loadOrg(admin, orgId, names.get(orgId) ?? "Organización")));
  orgs.sort((a, b) => a.orgName.localeCompare(b.orgName, "es"));
  return { denied: false, orgs };
}

type StoreRow = { id: string; name: string | null; status: string | null } & Record<string, unknown>;

async function loadOrg(admin: SupabaseClient, orgId: string, orgName: string): Promise<AutomationsOrgView> {
  const errors: string[] = [];
  const now = new Date();
  const today = limaTodayKey(now);
  const yesterday = yesterdayKey(today);

  // Las columnas de tienda que se leen: interruptores, requisitos y lo poco
  // que dicen las automatizaciones sin interruptor. Nunca credenciales.
  const storeColumns = ["id", "name", "status", ...STORE_AUTOMATION_COLUMNS, "aliclik_enabled", "telegram_chat_id"];
  const storesQuery = admin.from("stores").select(storeColumns.join(",")).eq("org_id", orgId).order("name");

  const [storesRes, retry, orgSwitches, eventsRes, invoicesRes, routingRes, cohortsRes, prepay] = await Promise.all([
    storesQuery,
    loadRetry(admin, orgId, today, yesterday),
    loadOrgSwitches(admin, orgId),
    admin
      .from("automation_switch_events")
      .select("id,store_id,automation,previous,next,actor,occurred_at")
      .eq("org_id", orgId)
      .order("occurred_at", { ascending: false })
      .limit(EVENTS_LIMIT),
    admin.from("invoice_issuers").select("mode").eq("org_id", orgId),
    admin.from("lead_routing_settings").select("enabled").eq("org_id", orgId).maybeSingle(),
    admin.from("auto_order_cohorts").select("enabled,starts_at,ends_at"),
    loadPrepayAuto(admin, orgId),
  ]);

  const allStores = storesRes.error ? [] : ((storesRes.data ?? []) as unknown as StoreRow[]);
  if (storesRes.error) errors.push("No se pudieron leer las tiendas: sus interruptores no se muestran.");
  const storeName = new Map(allStores.map((s) => [s.id, s.name ?? "Tienda"]));
  const active = allStores.filter((s) => s.status === "active");

  // Interruptores de tienda, uno por tienda activa.
  let store: Record<string, StoreSwitchView[]> | null = null;
  if (!storesRes.error) {
    store = {};
    for (const entry of AUTOMATIONS) {
      if (entry.control.kind !== "store_column") continue;
      const { column, requires } = entry.control;
      store[entry.key] = active.map((s) => ({
        storeId: s.id,
        storeName: s.name ?? "Tienda",
        on: s[column] === true,
        requiresOn: requires ? s[requires] === true : true,
      }));
    }
  }

  // Las que no tienen interruptor aquí: su estado donde es barato saberlo.
  const readonly: Record<string, ReadonlyStateView> = {};
  const namesWhere = (pred: (s: StoreRow) => boolean) => active.filter(pred).map((s) => s.name ?? "Tienda");

  if (!storesRes.error) {
    const aliclik = namesWhere((s) => s.aliclik_enabled === true);
    readonly.aliclik_scheduled = !env.aliclikWriteEnabled()
      ? off("Apagada en el servidor")
      : aliclik.length
        ? on(`Encendida en ${joinNames(aliclik)}`)
        : off("Apagada");
    const telegram = namesWhere((s) => typeof s.telegram_chat_id === "string" && s.telegram_chat_id.trim() !== "");
    readonly.telegram_reports = telegram.length ? on(`Llega a ${joinNames(telegram)}`) : off("Sin Telegram");
  }

  if (invoicesRes.error) {
    if (!isMissingTable(invoicesRes.error)) errors.push("No se pudo leer el estado de los comprobantes.");
  } else {
    const modes = ((invoicesRes.data ?? []) as { mode: string }[]).map((r) => r.mode);
    const label: Record<string, string> = { real: "real", simulacion: "simulación", manual: "manual", apagado: "apagado" };
    if (modes.length === 0) readonly.invoices = off("Sin RUC");
    else {
      const counts = new Map<string, number>();
      for (const m of modes) counts.set(m, (counts.get(m) ?? 0) + 1);
      const parts = [...counts].map(([m, n]) => `${n} RUC en ${label[m] ?? m}`);
      readonly.invoices = modes.some((m) => m === "real") ? on(parts.join(" · ")) : off(parts.join(" · "));
    }
  }

  if (!routingRes.error) {
    readonly.lead_routing = (routingRes.data as { enabled?: boolean } | null)?.enabled ? on("Encendido") : off("Apagado");
  } else if (!isMissingTable(routingRes.error)) errors.push("No se pudo leer el reparto de leads.");

  if (!cohortsRes.error) {
    const live = ((cohortsRes.data ?? []) as { enabled: boolean; starts_at: string | null; ends_at: string | null }[]).filter(
      (c) => c.enabled && c.starts_at && c.ends_at && Date.parse(c.starts_at) <= now.getTime() && now.getTime() < Date.parse(c.ends_at),
    );
    const until = live.map((c) => c.ends_at!).sort().at(-1);
    readonly.auto_orders = until ? on(`Encendida hasta el ${formatLimaDateTime(until).split(" · ")[0]}`) : off("Apagada");
  } else if (!isMissingTable(cohortsRes.error)) errors.push("No se pudo leer el estado de las recompras automáticas.");

  readonly.woo_sale_returns = on("Siempre encendido");
  readonly.tanders_payments = on("Siempre encendido");
  readonly.urpi_programming = urpiAutoEnabled() && process.env.VERCEL_ENV === "production" ? on("Encendida") : off("Apagada");
  readonly.yape_statement = env.yapeMovementsWebhookSecret() ? on("Recibe reportes") : off("Sin configurar");

  if (active.length) {
    const { data, error } = await admin.from("bot_order_secrets").select("store_id").in("store_id", active.map((s) => s.id));
    if (!error) {
      const withBot = ((data ?? []) as { store_id: string }[]).map((r) => storeName.get(r.store_id) ?? "Tienda");
      readonly.kapso_bot_orders = withBot.length ? on(`Activo en ${joinNames(withBot)}`) : off("Apagado");
    } else if (!isMissingTable(error)) errors.push("No se pudo leer el estado del bot de Kapso.");
  } else {
    readonly.kapso_bot_orders = off("Apagado");
  }

  // Últimos cambios, con quién los hizo.
  let events: SwitchEventView[] = [];
  if (eventsRes.error) {
    if (!isMissingTable(eventsRes.error)) errors.push("No se pudieron leer los últimos cambios.");
  } else {
    const rows = (eventsRes.data ?? []) as {
      id: number;
      store_id: string | null;
      automation: string;
      previous: string | null;
      next: string;
      actor: string | null;
      occurred_at: string;
    }[];
    const actors = await resolveAgentNames(rows.map((r) => r.actor).filter((a): a is string => !!a), admin);
    events = rows.map((r) => ({
      id: r.id,
      at: formatLimaDateTime(r.occurred_at),
      what: automationEventLabel(r.automation),
      storeName: r.store_id ? (storeName.get(r.store_id) ?? "Tienda") : null,
      previous: automationValueLabel(r.automation, r.previous),
      next: automationValueLabel(r.automation, r.next),
      actor: r.actor ? (actors[r.actor] ?? "Alguien del equipo") : "Kapta",
    }));
  }

  if (retry.error) errors.push(retry.error);
  if (prepay.error) errors.push(prepay.error);
  errors.push(...orgSwitches.errors);

  // El nombre de la tienda en el registro de los reintentos.
  retry.log = retry.log.map((row) => ({ ...row, storeName: storeName.get(row.storeId) ?? null }));

  return {
    orgId,
    orgName,
    stores: active.map((s) => ({ id: s.id, name: s.name ?? "Tienda" })),
    retry,
    prepay,
    org: orgSwitches.view,
    store,
    readonly,
    events,
    errors,
  };
}

/** Posición de cada variante, tope y lo que hicieron las pasadas de hoy y ayer. */
async function loadRetry(admin: SupabaseClient, orgId: string, today: string, yesterday: string): Promise<RetryView> {
  const keyPresent = !!env.googleGeocodingApiKey();
  const noGeocode = (error: string | null): RetryGeocodeView => ({
    available: false,
    enabled: false,
    keyPresent,
    latest: null,
    gate: geocodeLimaGate(null),
    blocked: "La ubicación por dirección aún no está instalada en la base de datos.",
    error,
  });
  const empty: RetryView = {
    available: false,
    error: null,
    modes: retryModes([]),
    dailyCap: RETRY_DAILY_CAP_DEFAULT,
    countedToday: 0,
    log: [],
    geocode: noGeocode(null),
  };
  const [variantsRes, settingsRes, logRes, runRes] = await Promise.all([
    admin.from("lima_retry_auto_variants").select("variant,mode").eq("org_id", orgId),
    // `*`: sin la 0308, `geocode_enabled` no viene y el interruptor se bloquea.
    admin.from("lima_retry_auto_settings").select("*").eq("org_id", orgId).maybeSingle(),
    admin
      .from("lima_retry_auto_log")
      .select("id,store_id,order_id,order_name,lima_day,variant,mode,outcome,transport,guide_code,detail,updated_at")
      .eq("org_id", orgId)
      .in("lima_day", [today, yesterday])
      .order("updated_at", { ascending: false })
      .limit(LOG_LIMIT),
    admin
      .from("geocode_pilot_runs")
      .select("created_at,summary")
      .eq("org_id", orgId)
      .eq("coverage", "lima")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if ([variantsRes.error, settingsRes.error, logRes.error].some(isMissingTable)) {
    return { ...empty, error: "Los reintentos automáticos aún no están instalados en la base de datos." };
  }
  if (variantsRes.error || settingsRes.error) {
    return { ...empty, error: "No se pudo leer la posición de los reintentos: no se pueden cambiar ahora." };
  }
  const rows = (logRes.data ?? []) as {
    id: number;
    store_id: string;
    order_id: string;
    order_name: string | null;
    lima_day: string;
    variant: string;
    mode: "simulacion" | "activo";
    outcome: string;
    transport: string | null;
    guide_code: string | null;
    detail: string | null;
    updated_at: string;
  }[];
  const outcomeOf = (o: string): RetryOutcome | null => ((RETRY_OUTCOMES as readonly string[]).includes(o) ? (o as RetryOutcome) : null);
  const log: RetryLogView[] = rows.map((r) => {
    const outcome = outcomeOf(r.outcome);
    return {
      id: r.id,
      day: r.lima_day === today ? "hoy" : "ayer",
      orderId: r.order_id,
      orderName: r.order_name ?? "Pedido",
      storeId: r.store_id,
      // Se pone al final, cuando ya se leyeron las tiendas (en paralelo).
      storeName: null,
      variantLabel: isRetryVariant(r.variant) ? retryVariantLabel(r.variant) : r.variant,
      mode: r.mode,
      outcome,
      outcomeLabel: outcome ? RETRY_OUTCOME_LABEL[outcome] : r.outcome,
      transport: r.transport,
      guideCode: r.guide_code,
      detail: r.detail,
      at: formatLimaDateTime(r.updated_at),
    };
  });
  const countedToday = log.filter((r) => r.day === "hoy" && r.mode === "activo" && r.outcome && RETRY_OUTCOMES_COUNTED.includes(r.outcome)).length;

  // La ubicación por dirección: el interruptor y la última medición de Lima.
  const settings = settingsRes.data as { daily_cap?: number; geocode_enabled?: boolean } | null;
  let geocode: RetryGeocodeView;
  const installed = (settings ? "geocode_enabled" in settings : true) && !isMissingTable(runRes.error);
  if (!installed) geocode = noGeocode(null);
  else if (runRes.error) {
    geocode = {
      ...noGeocode("No se pudo leer la última medición de Lima: el interruptor no se puede encender ahora."),
      available: true,
      enabled: settings?.geocode_enabled === true,
      blocked: "No se pudo leer la última medición de Lima.",
    };
  } else {
    const row = ((runRes.data ?? []) as { created_at: string; summary: unknown }[])[0];
    const latest = row ? { at: formatLimaDateTime(row.created_at), summary: parseGeocodeLimaRunSummary(row.summary) } : null;
    const gate = geocodeLimaGate(latest?.summary ?? null);
    geocode = {
      available: true,
      enabled: settings?.geocode_enabled === true,
      keyPresent,
      latest,
      gate,
      blocked: !keyPresent ? GEOCODE_KEY_MISSING : gate.ok ? null : gate.reason,
      error: null,
    };
  }

  return {
    available: true,
    error: logRes.error ? "No se pudo leer lo que hicieron las pasadas de hoy y ayer." : null,
    modes: retryModes((variantsRes.data ?? []) as { variant: string; mode: string }[]),
    dailyCap: settings?.daily_cap ?? RETRY_DAILY_CAP_DEFAULT,
    countedToday,
    log,
    geocode,
  };
}

/** Cada interruptor de organización: encendido, apagado, sin fila o sin dato. */
async function loadOrgSwitches(admin: SupabaseClient, orgId: string): Promise<{ view: Record<string, OrgSwitchView>; errors: string[] }> {
  const errors: string[] = [];
  const rows = new Map<OrgAutomationTable, Record<string, unknown> | null | "error">();
  await Promise.all(
    ORG_AUTOMATION_TABLES.map(async (table) => {
      const { data, error } = await admin.from(table).select(ORG_TABLE_SHAPE[table].columns.join(",")).eq("org_id", orgId).maybeSingle();
      if (error && !isMissingTable(error)) {
        rows.set(table, "error");
        errors.push("No se pudo leer el estado de una automatización: su interruptor queda bloqueado.");
      } else rows.set(table, error ? null : ((data as Record<string, unknown> | null) ?? null));
    }),
  );
  const view: Record<string, OrgSwitchView> = {};
  for (const entry of AUTOMATIONS) {
    if (entry.control.kind !== "org_table") continue;
    const row = rows.get(entry.control.table);
    if (row === "error" || row === undefined) {
      view[entry.key] = { state: "unknown", requiresOn: false };
      continue;
    }
    if (row === null) {
      view[entry.key] = { state: "missing", requiresOn: false };
      continue;
    }
    view[entry.key] = {
      state: row[entry.control.column] === true ? "on" : "off",
      requiresOn: entry.control.requires ? row[entry.control.requires] === true : true,
    };
  }
  return { view, errors: [...new Set(errors)] };
}

/** La posición de la regla de la lista de pago adelantado y sus últimos resúmenes. */
async function loadPrepayAuto(admin: SupabaseClient, orgId: string): Promise<PrepayAutoView> {
  const { settings, missing, error } = await loadPrepaySettings(admin, orgId);
  const empty: PrepayAutoView = { available: false, mode: "apagado", activeCount: null, lastSimulation: null, lastRun: null, error: null };
  if (missing) return empty;
  if (error) return { ...empty, error: "No se pudo leer la regla de la lista de pago adelantado: no se puede cambiar ahora." };
  const { count } = await admin
    .from("prepay_list_entries")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .is("removed_at", null);
  const sim = parsePrepaySimulationSummary(settings.last_simulation);
  const run = parsePrepaySimulationSummary(settings.last_run);
  return {
    available: true,
    mode: settings.auto_mode,
    activeCount: typeof count === "number" ? count : null,
    lastSimulation: sim ? { at: formatLimaDateTime(sim.at), summary: sim } : null,
    lastRun: run ? { at: formatLimaDateTime(run.at), summary: run } : null,
    error: null,
  };
}
