"use client";

import type { ClientPerformanceMetric, ClientPerformanceMetricName } from "@/lib/performance-metrics";

const PRIMARY_PANEL_PATHS = [
  "/dashboard/leads",
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
  const section = pathname.split("/").filter(Boolean)[1];
  if (["leads", "envios", "productividad", "stores", "team"].includes(section ?? "")) {
    return `/dashboard/${section}`;
  }
  return "/dashboard/other";
}

export function panelPrefetchOrder(currentPath: string, isVendedoraOnly: boolean): string[] {
  const current = sanitizeDashboardPath(currentPath);
  const available = isVendedoraOnly
    ? ["/dashboard/leads", "/dashboard/envios"]
    : [...PRIMARY_PANEL_PATHS];
  const priority: Record<string, string[]> = {
    "/dashboard": ["/dashboard/leads", "/dashboard/envios", "/dashboard/productividad"],
    "/dashboard/leads": ["/dashboard/envios", "/dashboard/productividad", "/dashboard"],
    "/dashboard/envios": ["/dashboard/leads", "/dashboard/productividad", "/dashboard"],
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
