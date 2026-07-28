// Los filtros del Master, viajando por la URL. Puro + testeado.
//
// Existe porque los filtros dejaron de aplicarse en el navegador y pasaron al
// servidor. Para eso el servidor tiene que SABER qué filtros hay puestos, y el
// único sitio donde caben sin inventar estado paralelo es la URL.
//
// Dos ventajas que salen gratis de haberlo hecho así:
//   - una vista filtrada se puede compartir o guardar como marcador;
//   - atrás y adelante del navegador funcionan como cualquiera espera.
//
// La regla del códec: lo que no se entiende se ignora, nunca rompe. Una URL
// manipulada o de una versión vieja tiene que dar un listado sensato, no un
// error — es la pantalla de trabajo diaria del equipo.

import { emptyFilters, type MasterFilters, type MasterSortKey } from "@/lib/order-master-filters";

/** Claves cortas: la URL se lee y se comparte, y `?d=lince,ate` gana a
 *  `?districts=lince%2Cate` para algo que se mira todo el día. */
const SET_KEYS: { param: string; field: keyof MasterFilters }[] = [
  { param: "st", field: "stores" },
  { param: "g", field: "generalStatuses" },
  { param: "op", field: "operationalStatuses" },
  { param: "c", field: "couriers" },
  { param: "sm", field: "shippingModes" },
  { param: "r", field: "regions" },
  { param: "p", field: "provinces" },
  { param: "d", field: "districts" },
  { param: "pk", field: "pickupStates" },
];

const DATE_KEYS: { param: string; field: keyof MasterFilters }[] = [
  { param: "cf", field: "createdFrom" },
  { param: "ct", field: "createdTo" },
  { param: "df", field: "dispatchedFrom" },
  { param: "dt", field: "dispatchedTo" },
  { param: "mf", field: "movementFrom" },
  { param: "mt", field: "movementTo" },
  { param: "ef", field: "deliveredFrom" },
  { param: "et", field: "deliveredTo" },
];

const FLAG_KEYS: { param: string; field: keyof MasterFilters }[] = [
  { param: "wc", field: "withComments" },
  { param: "mc", field: "multiCourier" },
  { param: "ma", field: "multiAttempt" },
  { param: "ex", field: "expiringSoon" },
];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface MasterQuery {
  filters: MasterFilters;
  sortKey: MasterSortKey;
  page: number;
}

const SORT_KEYS: MasterSortKey[] = [
  "created",
  "movement",
  "status_age",
  "attempts",
  "couriers",
  "total",
];

/** Lee la URL. Nunca lanza: lo que no entiende, lo ignora. */
export function parseMasterQuery(params: URLSearchParams | Record<string, string | undefined>): MasterQuery {
  const get = (k: string): string | null => {
    if (params instanceof URLSearchParams) return params.get(k);
    return params[k] ?? null;
  };

  const f = emptyFilters();

  for (const { param, field } of SET_KEYS) {
    const raw = get(param);
    if (!raw) continue;
    const values = raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    (f[field] as Set<string>) = new Set(values);
  }

  for (const { param, field } of DATE_KEYS) {
    const raw = get(param)?.trim() ?? "";
    // Media fecha es ninguna fecha: se descarta en vez de filtrar por algo raro.
    if (ISO_DAY.test(raw)) (f[field] as string) = raw;
  }

  for (const { param, field } of FLAG_KEYS) {
    if (get(param) === "1") (f[field] as boolean) = true;
  }

  const stale = Number(get("sd") ?? "");
  if (Number.isFinite(stale) && stale > 0) f.staleDays = Math.trunc(stale);

  f.search = get("q")?.trim() ?? "";

  const rawSort = get("s") ?? "";
  const sortKey = SORT_KEYS.includes(rawSort as MasterSortKey)
    ? (rawSort as MasterSortKey)
    : "created";

  const rawPage = Number(get("pg") ?? "1");
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;

  return { filters: f, sortKey, page };
}

/**
 * Escribe la URL. Solo pone lo que NO está por defecto, para que una vista sin
 * filtrar tenga la URL limpia y se note de un vistazo cuándo hay algo puesto.
 */
export function buildMasterQuery(q: MasterQuery): URLSearchParams {
  const out = new URLSearchParams();
  const f = q.filters;

  for (const { param, field } of SET_KEYS) {
    const set = f[field] as Set<string>;
    if (set?.size) out.set(param, [...set].join(","));
  }
  for (const { param, field } of DATE_KEYS) {
    const v = (f[field] as string) ?? "";
    if (v) out.set(param, v);
  }
  for (const { param, field } of FLAG_KEYS) {
    if (f[field] as boolean) out.set(param, "1");
  }
  if (f.staleDays > 0) out.set("sd", String(f.staleDays));
  if (f.search.trim()) out.set("q", f.search.trim());
  if (q.sortKey !== "created") out.set("s", q.sortKey);
  // La página vuelve a 1 sola: si cambia un filtro, quedarse en la página 7 del
  // resultado anterior es una pantalla en blanco sin explicación.
  if (q.page > 1) out.set("pg", String(q.page));

  return out;
}

/** ¿Hay algo puesto? Sirve para ofrecer "limpiar filtros" solo cuando toca. */
export function hasQueryFilters(f: MasterFilters): boolean {
  return (
    SET_KEYS.some(({ field }) => (f[field] as Set<string>)?.size > 0) ||
    DATE_KEYS.some(({ field }) => Boolean(f[field] as string)) ||
    FLAG_KEYS.some(({ field }) => Boolean(f[field] as boolean)) ||
    f.staleDays > 0 ||
    Boolean(f.search.trim())
  );
}
