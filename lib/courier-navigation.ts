export const COURIER_REPARTO_PATH = "/dashboard/courier/reparto";

/** Preserve bookmarks and route identity without trusting a redirect destination. */
export function courierRouteHref(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
    else if (value !== undefined) query.set(key, value);
  }
  return COURIER_REPARTO_PATH + (query.size ? `?${query}` : "");
}
