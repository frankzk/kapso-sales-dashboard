"use client";

import {
  DASHBOARD_SECTIONS,
  DASHBOARD_SUBSECTIONS,
  type ClientPerformanceMetric,
  type ClientPerformanceMetricName,
} from "@/lib/performance-metrics";

const PRIMARY_PANEL_PATHS = [
  "/dashboard/leads",
  "/dashboard/pedidos",
  "/dashboard/envios",
  "/dashboard/productividad",
  "/dashboard",
] as const;

const prefetchedAt = new Map<string, number>();
let pendingNavigation:
  | { from: string; to: string; startedAt: number; prefetchedAt?: number }
  | null = null;

function prefetchKey(value: string): string {
  try {
    return new URL(value, "https://dashboard.local").pathname;
  } catch {
    return value.split("?", 1)[0] || value;
  }
}

/** Reduces routes to non-sensitive dashboard sections before telemetry leaves
 * the browser. Query strings and dynamic ids are never reported. */
export function sanitizeDashboardPath(value: string): string {
  let pathname = value.split("?", 1)[0] || "/dashboard";
  try {
    pathname = new URL(value, "https://dashboard.local").pathname;
  } catch {
    // The split path above is already safe to normalize.
  }
  if (pathname === "/dashboard") return pathname;
  const [, section, sub] = pathname.split("/").filter(Boolean);
  // Una pantalla que se mide aparte de su sección (Repro Lima dentro de
  // «pedidos»): solo las de la lista, que son rutas fijas y sin ids.
  if ((DASHBOARD_SUBSECTIONS as readonly string[]).includes(`${section ?? ""}/${sub ?? ""}`)) {
    return `/dashboard/${section}/${sub}`;
  }
  // La lista vive en lib/performance-metrics.ts, que es también la que valida
  // al recibir: si se mantuvieran por separado volverían a separarse.
  if ((DASHBOARD_SECTIONS as readonly string[]).includes(section ?? "")) {
    return `/dashboard/${section}`;
  }
  return "/dashboard/other";
}

/** La sección de arriba, para decidir qué precargar: Repro Lima precarga lo mismo que «pedidos». */
function prefetchSection(value: string): string {
  const safe = sanitizeDashboardPath(value);
  const [, section] = safe.split("/").filter(Boolean);
  return section && (DASHBOARD_SECTIONS as readonly string[]).includes(section) ? `/dashboard/${section}` : safe;
}

export function panelPrefetchOrder(currentPath: string, isVendedoraOnly: boolean): string[] {
  const current = prefetchSection(currentPath);
  const available = isVendedoraOnly
    ? ["/dashboard/leads", "/dashboard/pedidos", "/dashboard/envios"]
    : [...PRIMARY_PANEL_PATHS];
  const priority: Record<string, string[]> = {
    "/dashboard": ["/dashboard/leads", "/dashboard/pedidos", "/dashboard/envios"],
    "/dashboard/leads": ["/dashboard/pedidos", "/dashboard/envios", "/dashboard/productividad"],
    "/dashboard/pedidos": ["/dashboard/envios", "/dashboard/leads", "/dashboard"],
    "/dashboard/envios": ["/dashboard/pedidos", "/dashboard/leads", "/dashboard/productividad"],
    "/dashboard/productividad": ["/dashboard/leads", "/dashboard/envios", "/dashboard"],
  };
  return (priority[current] ?? available).filter((href) => href !== current && available.includes(href));
}

export function canBackgroundPrefetch(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  return !connection?.saveData && connection?.effectiveType !== "slow-2g" && connection?.effectiveType !== "2g";
}

/** Prevents duplicate network work while keeping prefetched data fresh. */
export function registerPanelPrefetch(href: string): boolean {
  const path = prefetchKey(href);
  const now = Date.now();
  const previous = prefetchedAt.get(path);
  if (previous !== undefined && now - previous < 30_000) return false;
  prefetchedAt.set(path, now);
  return true;
}

export function startPanelNavigation(from: string, to: string) {
  if (typeof performance === "undefined") return;
  const safeFrom = sanitizeDashboardPath(from);
  const safeTo = sanitizeDashboardPath(to);
  if (safeFrom === safeTo) return;
  const preparedAt = prefetchedAt.get(prefetchKey(to));
  const recentPrefetch = preparedAt !== undefined && Date.now() - preparedAt < 30_000 ? preparedAt : undefined;
  pendingNavigation = {
    from: safeFrom,
    to: safeTo,
    startedAt: performance.now(),
    prefetchedAt: recentPrefetch,
  };
}

export function finishPanelNavigation(pathname: string) {
  if (typeof performance === "undefined" || !pendingNavigation) return;
  const destination = sanitizeDashboardPath(pathname);
  if (pendingNavigation.to !== destination) return;
  const metric = pendingNavigation;
  pendingNavigation = null;
  const prefetchLeadMs = metric.prefetchedAt ? Math.max(0, Date.now() - metric.prefetchedAt) : undefined;
  reportClientPerformanceMetric("dashboard:navigation", performance.now() - metric.startedAt, {
    from: metric.from,
    to: metric.to,
    prefetched: metric.prefetchedAt !== undefined,
    ...(prefetchLeadMs !== undefined ? { prefetchLeadMs } : {}),
  });
}

function effectiveConnection(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType;
}

export function reportClientPerformanceMetric(
  name: ClientPerformanceMetricName,
  durationMs: number,
  context: Omit<ClientPerformanceMetric, "name" | "durationMs" | "connection"> = {},
) {
  if (typeof navigator === "undefined" || !Number.isFinite(durationMs) || durationMs < 0) return;
  const connection = effectiveConnection();
  const payload: ClientPerformanceMetric = {
    name,
    durationMs: Math.round(durationMs),
    ...context,
    ...(connection ? { connection } : {}),
  };
  const body = JSON.stringify(payload);
  if (navigator.sendBeacon?.("/api/performance", new Blob([body], { type: "application/json" }))) return;
  void fetch("/api/performance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Leads: lo que pesa la cola y cuánto se espera hasta verla (27-11-2026)
//
// POR QUÉ. La línea `[leads] carga` mide el servidor. Lo que no se sabía es lo
// que pasa después: «Por llamar» manda la cola entera al navegador (~6.700
// leads por tienda, ~11 MB sin comprimir, medido el 27-11) en cada carga y en
// cada recarga. Antes de cambiar cómo se lee, esto dice cuánto pesa de verdad y
// cuánto espera la asesora. Solo números: nada de leads, clientas ni tiendas.
// ---------------------------------------------------------------------------

const LEADS_PATH = "/dashboard/leads";
let leadsPayload: PerformanceResourceTiming | null = null;
let leadsWatching = false;
let lastLeadsStart = -1;

function pathOfUrl(url: string): string | null {
  try {
    return new URL(url, typeof location === "undefined" ? "http://localhost" : location.origin).pathname;
  } catch {
    return null;
  }
}

/**
 * Anota la última respuesta que trajo la pantalla de Leads (la navegación, una
 * recarga o una acción que la revalida). Se llama una vez, al montar el panel:
 * con `buffered` también llegan las de antes de montar, y un observador recibe
 * las respuestas aunque la lista del navegador ya esté llena.
 */
export function watchLeadsPayloads(): void {
  if (leadsWatching || typeof PerformanceObserver === "undefined") return;
  leadsWatching = true;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const resource = entry as PerformanceResourceTiming;
        if (resource.initiatorType === "fetch" && pathOfUrl(resource.name) === LEADS_PATH) leadsPayload = resource;
      }
    }).observe({ type: "resource", buffered: true });
  } catch {
    leadsWatching = false;
  }
}

/** La respuesta que trajo lo que se acaba de pintar: la más nueva, no contada, pedida antes de pintar. */
export function pickLeadsEntry(
  candidates: ReadonlyArray<Pick<PerformanceResourceTiming, "startTime" | "responseEnd">>,
  renderedAt: number,
  lastStart: number,
) {
  return [...candidates]
    .filter((entry) => entry.startTime > lastStart && entry.startTime <= renderedAt && entry.responseEnd > 0)
    .sort((a, b) => b.startTime - a.startTime)[0] ?? null;
}

/**
 * La cola llegó y se pintó: `leads:board-data` con cuánto se esperó desde que se
 * pidió (`durationMs`), cuánto tardó en bajar (`downloadMs`), cuánto pesa (`kb`,
 * `transferKb`) y cuántas filas son. La respuesta puede anotarse un poco después
 * de pintar (llega por partes): se espera hasta 3 s a que aparezca.
 */
export function reportLeadsBoardData(rows: number): void {
  if (typeof performance === "undefined" || typeof window === "undefined") return;
  const renderedAt = performance.now();
  const attempt = (tries: number) => {
    const candidates: PerformanceResourceTiming[] = [];
    if (leadsPayload) candidates.push(leadsPayload);
    const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav && pathOfUrl(nav.name) === LEADS_PATH) candidates.push(nav);
    const entry = pickLeadsEntry(candidates, renderedAt, lastLeadsStart) as PerformanceResourceTiming | null;
    if (!entry) {
      if (tries < 30) window.setTimeout(() => attempt(tries + 1), 100);
      return;
    }
    lastLeadsStart = entry.startTime;
    reportClientPerformanceMetric("leads:board-data", renderedAt - entry.startTime, {
      rows,
      downloadMs: Math.max(0, entry.responseEnd - entry.startTime),
      kb: Math.round((entry.decodedBodySize ?? 0) / 1024),
      transferKb: Math.round((entry.transferSize ?? 0) / 1024),
    });
  };
  attempt(0);
}

