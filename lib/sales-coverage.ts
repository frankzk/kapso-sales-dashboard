// Desde cuándo cuenta cada tienda TODAS sus ventas (MOM §17.3, «Desde cuándo
// responde»; MOM §17.4).
//
// Una tienda tiene todas sus ventas, con su origen, desde el más tardío de dos
// días: `ORDERS_SYNC_FROM` (antes la sincronización solo trae los pedidos del
// bot) y el día en que la tienda empezó a usar Kapta (su primera venta de
// asesora registrada o, sin ninguna, su primer lead: antes, una venta de asesora
// no tenía dónde registrarse y caería en «Web» u «Otros»). Medido: una tienda
// tenía 3.898 pedidos en junio de 2026 y su primera venta registrada es del
// 04-07.
//
// CADA TIENDA CUENTA DESDE SU PROPIO DÍA. Con varias tiendas no se recorta a
// todas al día de la que empezó último: conectar una tienda nueva dejaría la
// cabecera de todas en un solo día. El Consolidado suma cada tienda en su
// ventana y lo dice. Una tienda que todavía no usa Kapta queda fuera y se nombra.

export type CoverageCause = "sync" | "tienda";

/** El día local en que la tienda empezó a usar Kapta; null = todavía no lo usa. */
export interface StoreStart {
  id: string;
  start: string | null;
}

/** Una tienda que cuenta en el periodo, con la parte del periodo que cubre. */
export interface StoreWindow {
  storeId: string;
  from: string;
  to: string;
  /** Desde cuándo tiene todas sus ventas. */
  floor: string;
  cause: CoverageCause;
  /** El periodo empezaba antes de `floor`. */
  clipped: boolean;
}

/** Una tienda que solo tiene todas sus ventas después del periodo. */
export interface StoreLater {
  storeId: string;
  floor: string;
  cause: CoverageCause;
}

export interface WindowPlan {
  windows: StoreWindow[];
  later: StoreLater[];
  /** Tiendas que todavía no usan Kapta (sin ventas registradas ni leads). */
  excluded: string[];
  /** Se pidió más de una tienda. */
  multiStore: boolean;
}

/** Desde cuándo la tienda tiene todas sus ventas, y qué lo fija. */
export function storeFloor(syncFrom: string, start: string): { floor: string; cause: CoverageCause } {
  return start > syncFrom ? { floor: start, cause: "tienda" } : { floor: syncFrom, cause: "sync" };
}

/** La ventana de cada tienda dentro del periodo. */
export function planWindows(
  syncFrom: string,
  stores: readonly StoreStart[],
  range: { from: string; to: string },
): WindowPlan {
  const plan: WindowPlan = { windows: [], later: [], excluded: [], multiStore: stores.length > 1 };
  for (const s of stores) {
    if (s.start == null) {
      plan.excluded.push(s.id);
      continue;
    }
    const { floor, cause } = storeFloor(syncFrom, s.start);
    if (range.to < floor) {
      plan.later.push({ storeId: s.id, floor, cause });
      continue;
    }
    const clipped = range.from < floor;
    plan.windows.push({ storeId: s.id, from: clipped ? floor : range.from, to: range.to, floor, cause, clipped });
  }
  return plan;
}

/**
 * ¿Se puede comparar con el periodo anterior? Solo si cada tienda que cuenta
 * ahora contaba el periodo anterior ENTERO: si no, el anterior saldría con
 * menos ventas de las que hubo y el cambio sería falso.
 */
export function comparablePrev(plan: WindowPlan, prev: WindowPlan): boolean {
  if (!plan.windows.length) return false;
  return plan.windows.every((w) => !w.clipped && prev.windows.some((p) => p.storeId === w.storeId && !p.clipped));
}

const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;

const ASESORA_ANTES =
  "Antes de que una tienda use Kapta, una venta de asesora no tenía dónde registrarse y caería en «Web» u «Otros», así que cada tienda cuenta desde ese día.";
const BOT_ANTES = "Antes de ese día Kapta no tiene los pedidos que no son del bot.";

function excludedLine(plan: WindowPlan, name: (id: string) => string): string | null {
  const n = plan.excluded.length;
  if (!n) return null;
  return `${joinNames(plan.excluded.map(name))} todavía no ${n > 1 ? "usan" : "usa"} Kapta (sin ventas registradas ni leads): sus pedidos no entran en este total.`;
}

/**
 * Los textos de la cobertura cuando hay ventas que contar: el aviso del panel
 * (título y cuerpo) y las coletillas de la tarjeta («desde el …», «sin …»).
 * Nada si cada tienda cuenta el periodo entero.
 */
export function coverageCopy(
  plan: WindowPlan,
  name: (id: string) => string,
  day: (iso: string) => string,
): { title: string | null; body: string | null; sub: string[] } {
  const clipped = plan.windows.filter((w) => w.clipped);
  if (!plan.multiStore) {
    const w = clipped[0];
    if (!w) return { title: null, body: null, sub: [] };
    const reason =
      w.cause === "tienda"
        ? `Ese día ${name(w.storeId)} empezó a usar Kapta. Antes, una venta de asesora no tenía dónde registrarse y caería en «Web» u «Otros», así que los días anteriores del periodo no entran aquí.`
        : "Antes de ese día Kapta no tiene los pedidos que no son del bot, así que los días anteriores del periodo no entran aquí.";
    return { title: `Cuenta desde el ${day(w.from)}`, body: reason, sub: [`desde el ${day(w.from)}`] };
  }

  const lines: string[] = [];
  for (const w of clipped) {
    lines.push(
      w.cause === "tienda"
        ? `${name(w.storeId)} cuenta desde el ${day(w.from)}, el día en que empezó a usar Kapta.`
        : `${name(w.storeId)} cuenta desde el ${day(w.from)}.`,
    );
  }
  for (const l of plan.later) {
    lines.push(
      l.cause === "tienda"
        ? `${name(l.storeId)} no entra: empezó a usar Kapta el ${day(l.floor)}, después de este periodo.`
        : `${name(l.storeId)} no entra: Kapta tiene todas sus ventas desde el ${day(l.floor)}, después de este periodo.`,
    );
  }
  const excl = excludedLine(plan, name);
  if (excl) lines.push(excl);
  if (!lines.length) return { title: null, body: null, sub: [] };

  const why: string[] = [];
  if ([...clipped, ...plan.later].some((w) => w.cause === "tienda")) why.push(ASESORA_ANTES);
  if ([...clipped, ...plan.later].some((w) => w.cause === "sync")) why.push(BOT_ANTES);
  if (clipped.length) why.push("La página de cada tienda dice desde cuándo cuenta.");

  const sub: string[] = [];
  if (clipped.length === 1) sub.push(`${name(clipped[0]!.storeId)} desde el ${day(clipped[0]!.from)}`);
  else if (clipped.length > 1) sub.push("algunas tiendas desde otra fecha");
  const out = [...plan.later.map((l) => l.storeId), ...plan.excluded];
  if (out.length) sub.push(`sin ${joinNames(out.map(name))}`);

  return { title: "No todas las tiendas cuentan el periodo entero", body: [...lines, ...why].join(" "), sub };
}

/**
 * El aviso cuando ninguna tienda tiene ventas que contar en el periodo (la
 * vista vuelve a la anterior, solo con los pedidos del bot), y la coletilla.
 */
export function noCoverageCopy(
  plan: WindowPlan,
  name: (id: string) => string,
  day: (iso: string) => string,
): { note: string; sub: string } {
  const back = " Esto es la vista anterior: solo los pedidos del bot de Kapso.";
  if (!plan.multiStore) {
    const l = plan.later[0];
    if (!l) {
      return {
        note: `Esta tienda todavía no usa Kapta (sin ventas registradas ni leads): no hay con qué contar todas sus ventas ni decir quién cerró cada una.${back}`,
        sub: "La tienda todavía no usa Kapta",
      };
    }
    const why =
      l.cause === "tienda"
        ? `Todas las ventas cuentan desde el ${day(l.floor)}, el día en que ${name(l.storeId)} empezó a usar Kapta: antes, una venta de asesora no tenía dónde registrarse.`
        : `Todas las ventas cuentan desde el ${day(l.floor)}: antes Kapta no tiene los pedidos que no son del bot.`;
    return { note: `${why} Para este periodo no hay con qué contarlas.${back}`, sub: "Periodo anterior a que Kapta tuviera todas las ventas" };
  }
  const lines = plan.later.map((l) =>
    l.cause === "tienda"
      ? `${name(l.storeId)} empezó a usar Kapta el ${day(l.floor)}.`
      : `Kapta tiene todas las ventas de ${name(l.storeId)} desde el ${day(l.floor)}.`,
  );
  const excl = excludedLine(plan, name);
  if (excl) lines.push(excl.replace(": sus pedidos no entran en este total.", "."));
  const all = !plan.later.length;
  return {
    note: `Ninguna de estas tiendas tiene todas sus ventas en este periodo. ${lines.join(" ")}${back}`,
    sub: all ? "Las tiendas todavía no usan Kapta" : "Periodo anterior a que Kapta tuviera todas las ventas",
  };
}
