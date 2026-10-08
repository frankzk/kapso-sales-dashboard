import { Suspense } from "react";
import { getAccessibleStores, getCurrentUser, getUserRoleSummary } from "@/lib/access";
import { getProductivityBoard, getSalesTotals, productivityInitialRange } from "@/lib/productivity";
import {
  fullMonthRange,
  monthName,
  monthPace,
  monthView,
  parseMonthParam,
  recentMonths,
} from "@/lib/productivity-month";
import { ProductivityBoard, type ProductivityMonth } from "@/components/productivity";
import { EmptyState } from "@/components/ui";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";

export const dynamic = "force-dynamic";

type SearchParams = { from?: string; to?: string; store?: string; src?: string; mes?: string };

export default function ProductividadPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  return (
    <Suspense fallback={<DashboardRouteSkeleton />}>
      <ProductividadContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ProductividadContent({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [role, sp, stores, user] = await Promise.all([
    getUserRoleSummary(),
    searchParams,
    getAccessibleStores(),
    getCurrentUser(),
  ]);
  // Vendedoras ven el tablero en modo SOLO: únicamente su propia fila (el
  // filtrado ocurre AQUÍ, server-side — al cliente nunca viaja el resto del
  // equipo), sin presencia de otras ni comparativas del equipo.
  const solo = role.isVendedoraOnly;
  if (!stores.length) {
    return <EmptyState title="Aún no tienes tiendas conectadas" />;
  }

  const storeIds = stores.map((s) => s.id);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : null;
  const scopeIds = storeId ? [storeId] : storeIds;
  const source =
    sp.src === "meta_ad" ||
    sp.src === "fb_web" ||
    sp.src === "cod_cart" ||
    sp.src === "abandoned_browse" ||
    sp.src === "organic"
      ? sp.src
      : null;

  const first = stores[0]!;
  const currency = stores.every((s) => s.currency === first.currency) ? first.currency : "PEN";
  // Infer active hours by each store's local day; mixed tz → Lima (the business default).
  const tz = stores.every((s) => s.timezone === first.timezone) ? first.timezone : "America/Lima";

  // Vista por mes (`?mes=2026-09`): el mes exacto, o del 1 a hoy si es el mes en
  // curso, comparado con el mes anterior (lib/productivity-month.ts). Un mes
  // inválido o futuro cae al rango normal.
  const view = (() => {
    const month = parseMonthParam(sp.mes);
    return month ? monthView(month, tz) : null;
  })();
  const range = view?.range ?? productivityInitialRange(sp, tz);
  const [board, prevMonthTotals] = await Promise.all([
    getProductivityBoard(scopeIds, range, source, tz, view ? { prevRange: view.prevRange } : {}),
    // «Agosto cerró en …»: el mes anterior entero. En modo solo, solo lo suyo —
    // al cliente no viaja ninguna cifra del equipo, y sin usuario no hay cifra.
    view && (!solo || user)
      ? getSalesTotals(scopeIds, fullMonthRange(view.prevMonth), source, tz, solo ? user!.id : null)
      : Promise.resolve(null),
  ]);
  // Modo solo: la fila propia con la escala de calor propia; los totales del
  // periodo anterior son del EQUIPO, así que se ocultan los deltas (hasPrev).
  const rows = solo ? board.rows.filter((r) => r.userId === user?.id) : board.rows;
  const heatMax = solo ? Math.max(1, ...rows.flatMap((r) => r.heat)) : board.heatMax;
  const onlineIdle = solo ? [] : board.onlineIdle;
  // Dots iniciales: asesoras del tablero online + las online sin actividad.
  const initialOnlineIds = solo
    ? []
    : [...board.rows.filter((r) => r.online).map((r) => r.userId), ...board.onlineIdle.map((i) => i.userId)];

  const month: ProductivityMonth | null = view
    ? {
        view,
        pace: monthPace(solo ? (board.dailyByAgent[user?.id ?? ""] ?? []) : board.daily, view),
        prevMonthName: monthName(view.prevMonth),
        prevMonthTotals,
      }
    : null;

  return (
    <ProductivityBoard
      rows={rows}
      prevTotals={board.prevTotals}
      prevRange={board.prevRange}
      hasPrev={solo ? false : board.hasPrev}
      range={range}
      currency={currency}
      stores={stores}
      storeId={storeId}
      source={source}
      tz={tz}
      heatMax={heatMax}
      heatMode={board.heatMode}
      onlineIdle={onlineIdle}
      initialOnlineIds={initialOnlineIds}
      firstTouch={solo ? null : board.firstTouch}
      solo={solo}
      month={month}
      months={recentMonths(tz)}
    />
  );
}
