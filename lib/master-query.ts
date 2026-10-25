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

import { ATTEMPTS_OR_MORE, DISPATCH_DATE_FILTERS, emptyFilters, type MasterFilters, type MasterSortKey } from "@/lib/order-master-filters";
import { MASTER_PATH } from "@/lib/order-drawer-href";

/** Claves cortas: la URL se lee y se comparte, y `?d=lince,ate` gana a
 *  `?districts=lince%2Cate` para algo que se mira todo el día. */
const SET_KEYS: { param: string; field: keyof MasterFilters }[] = [
  { param: "st", field: "stores" },
  { param: "g", field: "generalStatuses" },
  { param: "op", field: "operationalStatuses" },
  { param: "c", field: "couriers" },
  { param: "pc", field: "paymentChecks" },
  { param: "sm", field: "shippingModes" },
  { param: "r", field: "regions" },
  { param: "p", field: "provinces" },
  { param: "d", field: "districts" },
  { param: "cv", field: "coverages" },
  { param: "sw", field: "swaypAvailability" },
  { param: "cn", field: "salesChannels" },
  { param: "sc", field: "dispatchedWith" },
  { param: "pk", field: "pickupStates" },
  { param: "gd", field: "managementDays" },
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
  { param: "ex", field: "expiringSoon" },
  // «Comprobante por validar» (MOM §16.1).
  { param: "pv", field: "pendingVoucher" },
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

  // «Programar envío»: programado, hoy, vencido o sin fecha.
  const dispatchDate = get("ep") ?? "";
  if ((DISPATCH_DATE_FILTERS as readonly string[]).includes(dispatchDate)) f.dispatchDate = dispatchDate as MasterFilters["dispatchDate"];

  // Intentos: 0, 1, 2, 3 o 4 («4 a más»). El viejo `ma=1` («Más de un
  // intento») no tiene equivalente exacto y se ignora, como todo lo que no se
  // entiende. `at=` vacío no es 0: Number("") lo sería.
  const rawAttempts = get("at")?.trim() ?? "";
  const attempts = Number(rawAttempts);
  if (rawAttempts && Number.isInteger(attempts) && attempts >= 0 && attempts <= ATTEMPTS_OR_MORE) f.attempts = attempts;

  f.search = get("q")?.trim() ?? "";
  const confirmationDue = get("cq") ?? "";
  if (["vencido", "hoy", "proximo"].includes(confirmationDue)) {
    f.confirmationDue = confirmationDue as MasterFilters["confirmationDue"];
  }

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
  if (f.attempts !== null) out.set("at", String(f.attempts));
  if (f.dispatchDate) out.set("ep", f.dispatchDate);
  if (f.search.trim()) out.set("q", f.search.trim());
  if (f.confirmationDue) out.set("cq", f.confirmationDue);
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
    || Boolean(f.confirmationDue)
  );
}

/** Enlace a una cola del Master: etapa, subetapa y filtros por la URL (lo que lee app/dashboard/pedidos/page.tsx). Quien llama valida que la subetapa sea de esa etapa. */
export function masterQueueHref(opts: {
  view: string;
  substage?: string | null;
  coverages?: readonly string[];
  storeIds?: readonly string[];
}): string {
  const filters = { ...emptyFilters(), coverages: new Set(opts.coverages ?? []), stores: new Set(opts.storeIds ?? []) };
  const params = buildMasterQuery({ filters, sortKey: "created", page: 1 });
  params.set("view", opts.view);
  if (opts.substage) params.set("substage", opts.substage);
  return `${MASTER_PATH}?${params.toString()}`;
}
