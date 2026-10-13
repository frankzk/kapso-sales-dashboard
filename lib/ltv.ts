// LTV : CPA por mes de primera compra (MOM §17, 13-10-2026). Puro + testeado.
//
// La métrica que el dueño eligió para saber si el negocio se sostiene: lo que
// vende cada clienta nueva en sus primeros días (ingreso bruto de pedidos
// entregados) dividido entre lo que costó traerla (gasto de Meta del mes ÷
// clientas nuevas con entrega ese mes). Las sumas las hace la base
// (`ltv_cohorts`, `meta_spend_by_month`, migración 0252); acá se convierte la
// moneda, se arma el ratio y se decide qué horizontes ya se pueden leer.
//
// Como LTV/CPA = (valor ÷ clientas) ÷ (gasto ÷ clientas), el ratio de un mes es
// simplemente su valor entre su gasto.

/** Dólares a soles. El dueño fijó 3.75 el 13-10-2026. */
export const USD_TO_PEN = 3.75;

/** Desde cuándo hay historial completo de pedidos en Kapta (ORDERS_SYNC_FROM). */
export const LTV_SINCE = "2026-06-01";

/** Días desde la primera compra a los que se mide el valor de la clienta. */
export const HORIZONS = [30, 60, 90, 180, 365] as const;
export type Horizon = (typeof HORIZONS)[number];

/**
 * Cuánto se espera, después de que cierra un horizonte, a que se entreguen los
 * pedidos hechos en sus últimos días. En contraentrega a provincia la entrega
 * tarda hasta tres semanas; antes de eso el valor sale bajo y se marca
 * provisional.
 */
export const DELIVERY_SETTLE_DAYS = 21;

export type ZoneKey = "pierde" | "estable" | "gana" | "domina";

/** La escala que eligió el dueño, de abajo hacia arriba. */
export const LTV_ZONES: readonly { key: ZoneKey; label: string; range: string; meaning: string; tone: "crit" | "warn" | "ok" }[] = [
  { key: "pierde", label: "Pierde caja", range: "menos de 3", meaning: "Se pierde flujo de caja en cada venta.", tone: "crit" },
  { key: "estable", label: "Estable", range: "3 a 3.5", meaning: "Operación estable, pero no escala de forma eficiente.", tone: "warn" },
  { key: "gana", label: "Gana cuota", range: "3.5 a 4", meaning: "Lo que compra después sostiene la pauta.", tone: "ok" },
  { key: "domina", label: "Dominio", range: "más de 4", meaning: "Se puede pagar un CPA más alto que la competencia.", tone: "ok" },
];

export function ratioZone(ratio: number): (typeof LTV_ZONES)[number] {
  if (ratio < 3) return LTV_ZONES[0]!;
  if (ratio < 3.5) return LTV_ZONES[1]!;
  if (ratio <= 4) return LTV_ZONES[2]!;
  return LTV_ZONES[3]!;
}

/** Una fila de `ltv_cohorts`. */
export interface CohortRow {
  storeId: string;
  /** Primer día del mes de la primera entrega, `YYYY-MM-01`. */
  month: string;
  newCustomers: number;
  /** La última primera compra del mes: hasta ella cierra cada horizonte. */
  lastFirstAt: string;
  values: Record<Horizon, number>;
  repeat90: number;
}

/** Una fila de `meta_spend_by_month`. */
export interface SpendRow {
  storeId: string;
  month: string;
  currency: string;
  spend: number;
}

/**
 * El gasto de un mes en la moneda de la tienda. Dólares y soles se convierten
 * con `USD_TO_PEN`; cualquier otra moneda no se suma y se devuelve aparte, para
 * no mezclar costos que no se pueden comparar.
 */
export function spendInCurrency(rows: readonly SpendRow[], storeCurrency: string): { amount: number; unknown: string[] } {
  const target = storeCurrency.toUpperCase();
  let amount = 0;
  const unknown = new Set<string>();
  for (const row of rows) {
    const from = row.currency.toUpperCase();
    if (from === target) amount += row.spend;
    else if (from === "USD" && target === "PEN") amount += row.spend * USD_TO_PEN;
    else if (from === "PEN" && target === "USD") amount += row.spend / USD_TO_PEN;
    else if (row.spend > 0) unknown.add(from);
  }
  return { amount, unknown: [...unknown].sort() };
}

export type HorizonState = "cerrado" | "provisional" | "abierto";

const DAY = 86_400_000;

/**
 * ¿Ya se puede leer el valor de este horizonte? Abierto mientras la última
 * clienta del mes no cumpla los días; provisional las tres semanas siguientes,
 * mientras se entregan los pedidos de esos últimos días; cerrado después.
 */
export function horizonState(lastFirstAt: string, horizon: Horizon, today: Date): HorizonState {
  const closes = new Date(lastFirstAt).getTime() + horizon * DAY;
  if (today.getTime() < closes) return "abierto";
  if (today.getTime() < closes + DELIVERY_SETTLE_DAYS * DAY) return "provisional";
  return "cerrado";
}

export interface CohortCell {
  state: HorizonState;
  /** Valor por clienta a ese horizonte, en la moneda de la tienda. */
  ltv: number | null;
  ratio: number | null;
}

export interface CohortView {
  storeId: string;
  month: string;
  newCustomers: number;
  /** Gasto de Meta del mes en la moneda de la tienda; null sin gasto registrado. */
  spend: number | null;
  cpa: number | null;
  /**
   * Mientras se entregan los pedidos del mes, siguen apareciendo clientas
   * nuevas de ese mes y el CPA baja: es provisional hasta tres semanas después
   * de que termina el mes.
   */
  cpaProvisional: boolean;
  /**
   * El mes todavía no termina: sus clientas nuevas son solo las que ya
   * recibieron, así que su CPA sale inflado y no se compara con nada.
   */
  inProgress: boolean;
  /** Monedas de Meta que no se pudieron convertir (no entran al gasto). */
  unknownCurrencies: string[];
  cells: Record<Horizon, CohortCell>;
  /** Parte de las clientas que compró de nuevo en 90 días, cuando ya se puede leer. */
  repeat90: { share: number; state: HorizonState } | null;
}

/** Los meses de cada tienda, del más reciente al más antiguo. */
export function buildCohorts(
  cohorts: readonly CohortRow[],
  spend: readonly SpendRow[],
  currencyByStore: Readonly<Record<string, string>>,
  today: Date,
): CohortView[] {
  return cohorts
    .filter((row) => row.newCustomers > 0)
    .map((row) => {
      const monthSpend = spendInCurrency(
        spend.filter((s) => s.storeId === row.storeId && s.month === row.month),
        currencyByStore[row.storeId] ?? "PEN",
      );
      const total = monthSpend.amount > 0 ? monthSpend.amount : null;
      const cells = Object.fromEntries(
        HORIZONS.map((horizon) => {
          const state = horizonState(row.lastFirstAt, horizon, today);
          const value = row.values[horizon];
          return [
            horizon,
            {
              state,
              ltv: state === "abierto" ? null : value / row.newCustomers,
              ratio: state === "abierto" || total == null ? null : value / total,
            },
          ];
        }),
      ) as Record<Horizon, CohortCell>;
      const repeatState = horizonState(row.lastFirstAt, 90, today);
      const [year, month] = row.month.split("-").map(Number) as [number, number];
      const monthEnd = Date.UTC(year, month, 1);
      return {
        storeId: row.storeId,
        month: row.month,
        newCustomers: row.newCustomers,
        spend: total,
        cpa: total == null ? null : total / row.newCustomers,
        cpaProvisional: today.getTime() < monthEnd + DELIVERY_SETTLE_DAYS * DAY,
        inProgress: today.getTime() < monthEnd,
        unknownCurrencies: monthSpend.unknown,
        cells,
        repeat90: repeatState === "abierto" ? null : { share: row.repeat90 / row.newCustomers, state: repeatState },
      };
    })
    .sort((a, b) => a.storeId.localeCompare(b.storeId) || b.month.localeCompare(a.month));
}

export interface StoreHeadline {
  /** El mes más reciente con sus primeros 30 días ya leíbles. */
  latest: { month: string; ratio: number; state: HorizonState; cpa: number } | null;
  /**
   * El último mes ya terminado que todavía no cumple 30 días, con su CPA: el
   * ratio no se puede leer aún, pero un salto en lo que cuesta traer a una
   * clienta se tiene que ver ya. El mes en curso no cuenta: su CPA sale
   * inflado mientras no se entregan sus pedidos.
   */
  current: { month: string; cpa: number; provisional: boolean } | null;
  /** El horizonte más largo ya leíble, en el mes más antiguo que lo tiene, y cuánto subió desde sus 30 días. */
  longest: { month: string; horizon: Horizon; ratio: number; from30: number; state: HorizonState } | null;
}

/** Lo que se lee primero de una tienda: cómo vienen las clientas nuevas y cuánto suma la recompra. */
export function storeHeadline(views: readonly CohortView[]): StoreHeadline {
  const newestFirst = [...views].sort((a, b) => b.month.localeCompare(a.month));
  const latestView = newestFirst.find((view) => view.cells[30].ratio != null && view.cpa != null);
  let longest: StoreHeadline["longest"] = null;
  for (const view of [...newestFirst].reverse()) {
    const from30 = view.cells[30].ratio;
    if (from30 == null) continue;
    for (const horizon of [...HORIZONS].reverse()) {
      const cell = view.cells[horizon];
      if (horizon === 30 || cell.ratio == null) continue;
      if (!longest || horizon > longest.horizon) {
        longest = { month: view.month, horizon, ratio: cell.ratio, from30, state: cell.state };
      }
      break;
    }
  }
  const currentView = newestFirst.find(
    (view) =>
      !view.inProgress &&
      view.cpa != null &&
      (!latestView || view.month > latestView.month) &&
      view.cells[30].state === "abierto",
  );
  return {
    latest: latestView
      ? { month: latestView.month, ratio: latestView.cells[30].ratio!, state: latestView.cells[30].state, cpa: latestView.cpa! }
      : null,
    current: currentView ? { month: currentView.month, cpa: currentView.cpa!, provisional: currentView.cpaProvisional } : null,
    longest,
  };
}

const MONTH = new Intl.DateTimeFormat("es-PE", { month: "long", year: "numeric", timeZone: "UTC" });

/** «septiembre de 2026». */
export function monthLabel(month: string): string {
  return MONTH.format(new Date(`${month}T00:00:00Z`));
}

const RATIO = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** «3.56». */
export function formatRatio(ratio: number): string {
  return RATIO.format(ratio);
}
