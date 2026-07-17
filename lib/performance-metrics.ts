export const CLIENT_PERFORMANCE_METRIC_NAMES = [
  "dashboard:navigation",
  "kapso:lead-drawer-open",
  "kapso:call-save",
  "kapso:whatsapp-chat-first-paint",
  "kapso:whatsapp-send",
] as const;

export type ClientPerformanceMetricName = (typeof CLIENT_PERFORMANCE_METRIC_NAMES)[number];

export type ClientPerformanceMetric = {
  name: ClientPerformanceMetricName;
  durationMs: number;
  from?: string;
  to?: string;
  prefetched?: boolean;
  prefetchLeadMs?: number;
  connection?: string;
};

const METRIC_NAMES = new Set<string>(CLIENT_PERFORMANCE_METRIC_NAMES);
const CONNECTIONS = new Set(["slow-2g", "2g", "3g", "4g"]);
const DASHBOARD_ROUTES = new Set([
  "/dashboard",
  "/dashboard/leads",
  "/dashboard/envios",
  "/dashboard/productividad",
  "/dashboard/stores",
  "/dashboard/team",
  "/dashboard/other",
]);

function dashboardRoute(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DASHBOARD_ROUTES.has(value)) return undefined;
  return value;
}

/** Strict, privacy-safe parser for telemetry received from the browser. */
export function parseClientPerformanceMetric(value: unknown): ClientPerformanceMetric | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || !METRIC_NAMES.has(input.name)) return null;
  if (typeof input.durationMs !== "number" || !Number.isFinite(input.durationMs)) return null;
  if (input.durationMs < 0 || input.durationMs > 120_000) return null;

  const from = dashboardRoute(input.from);
  const to = dashboardRoute(input.to);
  if (input.from !== undefined && from === undefined) return null;
  if (input.to !== undefined && to === undefined) return null;

  const prefetched = input.prefetched === undefined ? undefined : input.prefetched;
  if (prefetched !== undefined && typeof prefetched !== "boolean") return null;

  const prefetchLeadMs = input.prefetchLeadMs === undefined ? undefined : input.prefetchLeadMs;
  if (
    prefetchLeadMs !== undefined &&
    (typeof prefetchLeadMs !== "number" || !Number.isFinite(prefetchLeadMs) || prefetchLeadMs < 0 || prefetchLeadMs > 3_600_000)
  ) {
    return null;
  }

  const connection = input.connection === undefined ? undefined : input.connection;
  if (connection !== undefined && (typeof connection !== "string" || !CONNECTIONS.has(connection))) return null;

  return {
    name: input.name as ClientPerformanceMetricName,
    durationMs: Math.round(input.durationMs),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(prefetched !== undefined ? { prefetched } : {}),
    ...(prefetchLeadMs !== undefined ? { prefetchLeadMs: Math.round(prefetchLeadMs) } : {}),
    ...(connection ? { connection } : {}),
  };
}
