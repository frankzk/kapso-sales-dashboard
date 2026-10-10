"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { cn, OVER_TABLE_Z } from "@/components/ui";
import {
  Badge,
  Banner,
  CARD_ZONE,
  CHECKBOX,
  ChoiceChip,
  FIELD,
  OpsButton,
  SECTION_CARD,
  SectionHead,
  StatusCard,
  type BadgeTone,
} from "@/components/ops-ui";
import { opsButtonClass } from "@/components/ops-styles";
import { IconArrowLeft, IconChevronDown, IconSearch, IconX } from "@/components/icons";
import { FENIX_CITIES } from "@/lib/shipments";
import type { DemandRow } from "@/lib/fenix-demand";
import type { FenixStockRowDb, StoreSummary } from "@/lib/types";
import type { BodegaSwaypResumen } from "@/lib/swayp-guide";
import { ciudadSinControl, sinControlDeCantidad } from "@/lib/fenix";
import {
  deleteFenixStock,
  getFenixStockMovements,
  importarInventarioSwayp,
  recomputeFenixEligibility,
  recordFenixStockMovement,
  searchStockProducts,
  swaypInventoryDryRun,
  swaypInventoryEstado,
  swaypInventorySync,
  type SwaypSyncEstado,
  upsertFenixStock,
  type DryRunResult,
} from "@/app/dashboard/envios/actions";
import { STOCK_MOVEMENT_LABEL, type StockMovementKind } from "@/lib/fenix-ledger";
import type { SyncResult } from "@/lib/swayp-inventory-sync";

type ProductResult = Awaited<ReturnType<typeof searchStockProducts>>[number];
type Msg = { kind: "ok" | "error"; text: string } | null;

/** Lo que la página sabe del sync diario, para cualquiera que la mire (ver page.tsx). */
export interface SyncResumen {
  automaticoActivo: boolean;
  /** Qué falta configurar; vacío para quien no es administrador. */
  faltan: string[];
  ultima: { created_at: string; source: "cron" | "manual"; ok: boolean; cambios: number } | null;
  retenidas: number;
}

const CARD = "rounded-lg bg-white shadow-control ring-1 ring-line";
const LABEL = "grid gap-1.5 text-[13px] font-medium text-ink-700";
const HELP = "text-[13px] font-normal leading-5 text-ink-500";
const H4 = "text-sm font-semibold leading-5 text-ink-900";
const nf = new Intl.NumberFormat("es-PE");
// Sin el color: `cn` no resuelve choques de Tailwind, cada botón pone el suyo.
const ROW_ACTION =
  "inline-flex h-8 items-center rounded-md px-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11";

/** «san roman» → «San Roman»: las ciudades vienen normalizadas en minúscula. */
function titulo(s: string): string {
  return s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function capitalizar(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * LAS TRES VISTAS DE UNA SOLA TABLA. La demanda ya trae todos los renglones de
 * stock (con 0 pendientes) más lo que se pide sin stock anotado, así que la
 * tabla de stock de abajo repetía casi las mismas filas. Ahora es una tabla y
 * se elige qué mirar:
 * - «Por reponer»: falta para las guías pendientes (lo que hay que mandar).
 * - «Sin stock»: en 0 en su bodega, con o sin pedidos (no se puede prometer).
 * - «Inventario»: todo, para responder «¿hay esto en Juliaca?».
 */
type View = "reponer" | "sinstock" | "inventario";

function enVista(r: DemandRow, view: View): boolean {
  if (view === "reponer") return r.shortfall > 0;
  if (view === "sinstock") return !r.unlimited && r.stock <= 0;
  return true;
}

/** La chapa de la fila. Lo que pide acción va en su tono; lo que está bien, en
 *  verde solo si hay pedidos que cubrir. Sin pedidos no hay chapa, tampoco en
 *  0: el stock en 0 ya se lee en su columna y en la vista «Sin stock». */
function estadoDe(r: DemandRow): { tone: BadgeTone; label: string } | null {
  if (r.unlimited) return { tone: "neutral", label: "Sin control" };
  if (r.status === "sin_stock") return { tone: "crit", label: "Sin stock" };
  if (r.status === "reponer") return { tone: "warn", label: "Reponer" };
  if (r.demand > 0 && r.stock > 0) return { tone: "ok", label: "Cubre" };
  return null;
}

export function FenixStockEditor({
  rows,
  canEdit,
  stores,
  demand = [],
  bodegas = [],
  syncResumen = null,
}: {
  rows: FenixStockRowDb[];
  canEdit: boolean;
  stores: StoreSummary[];
  demand?: DemandRow[];
  bodegas?: BodegaSwaypResumen[];
  syncResumen?: SyncResumen | null;
}) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, start] = useTransition();
  const [kardexRow, setKardexRow] = useState<FenixStockRowDb | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // El detalle del sync diario (solo administradores) lo muestra la tarjeta del
  // pie; la cabecera usa el resumen que arma el servidor para todos.
  const [estado, setEstado] = useState<SwaypSyncEstado | null>(null);
  const [estadoError, setEstadoError] = useState(false);

  const porReponer = useMemo(() => demand.filter((r) => enVista(r, "reponer")), [demand]);
  const [view, setView] = useState<View>(porReponer.length ? "reponer" : "inventario");
  const [cityFilter, setCityFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const stockById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  function cargarEstado() {
    setEstadoError(false);
    swaypInventoryEstado()
      .then((r) => {
        if ("error" in r) {
          setEstado(null);
          setEstadoError(true);
        } else setEstado(r);
      })
      .catch(() => {
        setEstado(null);
        setEstadoError(true);
      });
  }
  useEffect(() => {
    if (canEdit) cargarEstado();
  }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  // «/» lleva a la búsqueda desde cualquier parte de la página, como en el
  // tablero de Repro Provincia; Escape la borra.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable='true']") || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function recompute() {
    start(async () => {
      const r = await recomputeFenixEligibility();
      setMsg("error" in r ? { kind: "error", text: r.error } : { kind: "ok", text: r.notice });
      if (!("error" in r)) router.refresh();
    });
  }

  function remove(id: string) {
    start(async () => {
      const r = await deleteFenixStock(id);
      setConfirmDelete(null);
      setMsg(r.error ? { kind: "error", text: r.error } : r.notice ? { kind: "ok", text: r.notice } : null);
      router.refresh();
    });
  }

  const counts = {
    reponer: porReponer.length,
    sinstock: demand.filter((r) => enVista(r, "sinstock")).length,
    inventario: demand.length,
  };
  const unidadesPorReponer = porReponer.reduce((n, r) => n + r.shortfall, 0);
  const ciudadesPorReponer = new Set(porReponer.map((r) => r.city)).size;

  // Vista → ciudad → búsqueda. Las ciudades salen de la vista, con su cifra.
  const inView = useMemo(() => {
    const v = demand.filter((r) => enVista(r, view));
    // «Por reponer» va por faltante (ya viene así); las otras, por ciudad y producto.
    return view === "reponer"
      ? v
      : [...v].sort((a, b) => a.city.localeCompare(b.city) || a.product.localeCompare(b.product));
  }, [demand, view]);
  const cityCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of inView) m.set(r.city, (m.get(r.city) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [inView]);
  const q = query.trim().toLowerCase();
  const visible = inView.filter(
    (r) =>
      (!cityFilter || r.city === cityFilter) &&
      (!q || r.product.toLowerCase().includes(q) || (r.sku ?? "").toLowerCase().includes(q)),
  );
  const unidadesVisibles = visible.filter((r) => !r.unlimited).reduce((n, r) => n + Math.max(0, r.stock), 0);

  function elegirVista(v: View) {
    setView(v);
    setCityFilter(null);
    setConfirmDelete(null);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Stock Swayp</h1>
          <p className="mt-1 max-w-[68ch] text-pretty text-sm text-ink-500">
            Lo que hay en cada bodega de Swayp y lo que piden las guías pendientes de Repro Provincia.
          </p>
          <SyncLine resumen={syncResumen} canEdit={canEdit} />
          {!canEdit && (
            <p className="mt-1 text-[13px] leading-5 text-ink-500">
              Solo un administrador puede editar el stock. Lo ves en modo lectura.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <OpsButton
              onClick={recompute}
              disabled={pending}
              title="Vuelve a calcular qué guías pendientes puede atender Swayp con el stock actual."
              className="pointer-coarse:h-11"
            >
              Recalcular elegibilidad
            </OpsButton>
          )}
          <a href="/dashboard/envios" className={opsButtonClass("ghost", "md", "pointer-coarse:h-11")}>
            <IconArrowLeft aria-hidden className="text-ink-500" />
            Repro Provincia
          </a>
        </div>
      </header>

      {msg && (
        <Banner tone={msg.kind === "ok" ? "ok" : "crit"} role={msg.kind === "ok" ? "status" : "alert"}>
          <p>{msg.text}</p>
        </Banner>
      )}

      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <StatusCard
          label="Por reponer"
          value={counts.reponer}
          active={view === "reponer"}
          onClick={() => elegirVista("reponer")}
          hint={
            counts.reponer
              ? `${nf.format(unidadesPorReponer)} ${unidadesPorReponer === 1 ? "unidad" : "unidades"} en ${ciudadesPorReponer} ${ciudadesPorReponer === 1 ? "ciudad" : "ciudades"}`
              : "El stock cubre las guías pendientes"
          }
        />
        <StatusCard
          label="Sin stock"
          value={counts.sinstock}
          active={view === "sinstock"}
          onClick={() => elegirVista("sinstock")}
          hint="En 0 en su bodega, con o sin pedidos"
        />
        <StatusCard
          label="Inventario"
          value={counts.inventario}
          active={view === "inventario"}
          onClick={() => elegirVista("inventario")}
          hint="Todos los productos por ciudad"
        />
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {cityCounts.length > 1 ? (
          <div role="group" aria-label="Ciudad" className="flex flex-wrap items-center gap-2">
            <ChoiceChip label="Todas" count={inView.length} active={cityFilter === null} onClick={() => setCityFilter(null)} />
            {cityCounts.map(([c, n]) => (
              <ChoiceChip key={c} label={titulo(c)} count={n} active={cityFilter === c} onClick={() => setCityFilter(c)} />
            ))}
          </div>
        ) : (
          <span />
        )}
        <label className="relative block lg:w-72">
          <span className="sr-only">Buscar producto</span>
          <IconSearch aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
          <input
            ref={searchRef}
            type="search"
            aria-keyshortcuts="/"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Buscar producto o SKU"
            className={cn(FIELD, "pl-9 pointer-coarse:h-11")}
          />
        </label>
      </div>

      <section aria-label="Productos" className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
          <p role="status" className="text-sm text-ink-700">
            <b className="font-semibold tabular-nums text-ink-900">{nf.format(visible.length)}</b>{" "}
            {visible.length === 1 ? "producto" : "productos"}
            {view === "reponer" ? (
              <span className="text-ink-500">
                {" "}
                · faltan{" "}
                <b className="font-semibold tabular-nums text-ink-900">
                  {nf.format(visible.reduce((n, r) => n + r.shortfall, 0))}
                </b>{" "}
                unidades para las guías pendientes
              </span>
            ) : view === "sinstock" ? (
              // En 0 por definición: lo que importa es cuántos ya tienen pedidos.
              <span className="text-ink-500">
                {" "}
                · {nf.format(visible.filter((r) => r.demand > 0).length)} con guías pendientes
              </span>
            ) : (
              <span className="text-ink-500">
                {" "}
                · {nf.format(unidadesVisibles)} unidades en bodega
                {visible.some((r) => r.unlimited) && ` · ${visible.filter((r) => r.unlimited).length} sin control de cantidad`}
              </span>
            )}
          </p>
          {(cityFilter || q) && (
            <OpsButton
              size="sm"
              variant="ghost"
              onClick={() => {
                setCityFilter(null);
                setQuery("");
              }}
              className="pointer-coarse:h-11"
            >
              Limpiar filtros
            </OpsButton>
          )}
        </div>

        {visible.length === 0 ? (
          <p className="border-t border-line px-4 py-8 text-sm text-ink-500 sm:px-5">
            {q || cityFilter
              ? "Sin coincidencias con los filtros."
              : view === "reponer"
                ? "Nada por reponer: el stock cubre las guías pendientes."
                : view === "sinstock"
                  ? "Ningún producto está en 0."
                  : "Sin stock registrado."}
          </p>
        ) : (
          <StockTable
            rows={visible}
            stockById={stockById}
            canEdit={canEdit}
            pending={pending}
            confirmDelete={confirmDelete}
            onAskDelete={setConfirmDelete}
            onDelete={remove}
            onKardex={setKardexRow}
          />
        )}
      </section>

      {canEdit && (
        <SyncCard
          stores={stores}
          bodegas={bodegas}
          estado={estado}
          estadoError={estadoError}
          onEstadoChanged={() => {
            cargarEstado();
            router.refresh();
          }}
          onMsg={setMsg}
        />
      )}

      {kardexRow && (
        <StockKardexModal row={kardexRow} canEdit={canEdit} onClose={() => setKardexRow(null)} onChanged={() => router.refresh()} />
      )}
    </div>
  );
}

/**
 * La tabla de la página: desde 768 px una tabla fija sin desplazamiento
 * horizontal; en el teléfono, una lista con las cifras dichas en palabras.
 */
function StockTable({
  rows,
  stockById,
  canEdit,
  pending,
  confirmDelete,
  onAskDelete,
  onDelete,
  onKardex,
}: {
  rows: DemandRow[];
  stockById: Map<string, FenixStockRowDb>;
  canEdit: boolean;
  pending: boolean;
  confirmDelete: string | null;
  onAskDelete: (id: string | null) => void;
  onDelete: (id: string) => void;
  onKardex: (row: FenixStockRowDb) => void;
}) {
  const acciones = (r: DemandRow) => {
    const stock = r.stockId ? stockById.get(r.stockId) : undefined;
    if (!stock) return null;
    // ELIMINAR PIDE UN SEGUNDO CLIC QUE NOMBRA EL PRODUCTO: antes borraba el
    // renglón —y recalculaba las guías— con un solo clic junto a «Movimientos».
    if (confirmDelete === stock.id) {
      return (
        <div className="flex flex-wrap justify-end gap-1.5">
          <OpsButton size="sm" variant="ghost" onClick={() => onAskDelete(null)} className="pointer-coarse:h-11">
            No
          </OpsButton>
          <OpsButton
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() => onDelete(stock.id)}
            aria-label={`Sí, eliminar ${stock.product} de ${titulo(stock.city)}`}
            className="pointer-coarse:h-11"
          >
            Sí, eliminar
          </OpsButton>
        </div>
      );
    }
    // Acciones de texto en peso 500: repetidas en cada fila, no pueden pesar
    // más que el nombre del producto. Eliminar, en su tono.
    return (
      <div className="flex flex-wrap justify-end gap-1">
        {!sinControlDeCantidad(stock) && (
          <button
            type="button"
            onClick={() => onKardex(stock)}
            className={cn(ROW_ACTION, "text-ink-600 hover:bg-wash hover:text-ink-900")}
          >
            Movimientos
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            disabled={pending}
            onClick={() => onAskDelete(stock.id)}
            aria-label={`Eliminar ${stock.product} de ${titulo(stock.city)}`}
            className={cn(ROW_ACTION, "text-crit-fg hover:bg-crit-wash")}
          >
            Eliminar
          </button>
        )}
      </div>
    );
  };

  const stockCell = (r: DemandRow) =>
    r.unlimited ? (
      <span title="Sin control de cantidad: siempre disponible" className="text-ink-500">
        ∞
      </span>
    ) : (
      <span className={r.stock < 0 ? "font-semibold text-crit-fg" : undefined}>{nf.format(r.stock)}</span>
    );

  return (
    <>
      <table className="hidden w-full table-fixed text-left md:table">
        <thead className="text-xs font-medium text-ink-600">
          <tr>
            <th className="sticky top-0 z-[1] w-[15%] border-y border-line bg-white py-2 pl-4 pr-3 font-medium sm:pl-5">Ciudad</th>
            <th className="sticky top-0 z-[1] border-y border-line bg-white py-2 pr-3 font-medium">Producto</th>
            <th className="sticky top-0 z-[1] w-[9%] border-y border-line bg-white py-2 pr-3 text-right font-medium">Pendientes</th>
            <th className="sticky top-0 z-[1] w-[8%] border-y border-line bg-white py-2 pr-3 text-right font-medium">Stock</th>
            <th className="sticky top-0 z-[1] w-[8%] border-y border-line bg-white py-2 pr-3 text-right font-medium">Faltante</th>
            <th className="sticky top-0 z-[1] w-[11%] border-y border-line bg-white py-2 pl-4 pr-3 font-medium">Estado</th>
            <th className="sticky top-0 z-[1] w-[18%] border-y border-line bg-white py-2 pr-4 font-medium sm:pr-5">
              <span className="sr-only">Acciones</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const estado = estadoDe(r);
            return (
              <tr key={r.stockId ?? `${r.city}-${r.product}-${i}`} className="border-b border-line align-top last:border-0 hover:bg-wash">
                <td className="py-2.5 pl-4 pr-3 sm:pl-5">
                  <p className="text-sm leading-5 text-ink-900">{titulo(r.city)}</p>
                  {r.department.toLowerCase() !== r.city && (
                    <p className="text-[13px] leading-5 text-ink-500">{r.department}</p>
                  )}
                </td>
                <td className="py-2.5 pr-3">
                  <p className="line-clamp-2 text-sm leading-5 text-ink-900" title={r.product}>
                    {r.product}
                  </p>
                  {r.sku && <p className="truncate font-mono text-xs leading-5 text-ink-500">{r.sku}</p>}
                </td>
                <td className="py-2.5 pr-3 text-right text-sm tabular-nums text-ink-900">
                  {r.demand > 0 ? nf.format(r.demand) : <span className="text-ink-300">—</span>}
                </td>
                <td className="py-2.5 pr-3 text-right text-sm tabular-nums text-ink-900">{stockCell(r)}</td>
                <td className="py-2.5 pr-3 text-right text-sm tabular-nums">
                  {r.shortfall > 0 ? (
                    <span className="font-semibold text-crit-fg">{nf.format(r.shortfall)}</span>
                  ) : (
                    <span className="text-ink-300">—</span>
                  )}
                </td>
                <td className="py-2.5 pl-4 pr-3">{estado && <Badge tone={estado.tone}>{estado.label}</Badge>}</td>
                <td className="py-1.5 pr-4 sm:pr-5">{acciones(r)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ul className="divide-y divide-line border-t border-line md:hidden">
        {rows.map((r, i) => {
          const estado = estadoDe(r);
          const act = acciones(r);
          return (
            <li key={r.stockId ?? `${r.city}-${r.product}-${i}`} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-sm leading-5 text-ink-900">{r.product}</p>
                {/* La chapa no cede: el nombre largo del producto es el que parte. */}
                {estado && (
                  <span className="shrink-0">
                    <Badge tone={estado.tone}>{estado.label}</Badge>
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[13px] leading-5 text-ink-500">
                {titulo(r.city)}
                {r.department.toLowerCase() !== r.city && ` · ${r.department}`}
              </p>
              <p className="mt-1 text-[13px] leading-5 tabular-nums text-ink-700">
                {r.demand > 0 ? `${nf.format(r.demand)} ${r.demand === 1 ? "pendiente" : "pendientes"}` : "Sin pendientes"} · stock{" "}
                {stockCell(r)}
                {r.shortfall > 0 && (
                  <>
                    {" "}
                    · <span className="font-semibold text-crit-fg">faltan {nf.format(r.shortfall)}</span>
                  </>
                )}
              </p>
              {act && <div className="mt-2 flex justify-start">{act}</div>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** «hace 12 min», «hace 3 h», «hace 2 días». */
function haceCuanto(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? "día" : "días"}`;
}

/**
 * Qué tan frescos son los números, en la cabecera y para todos: el sync
 * diario, la última corrida y —al administrador, que puede actuar— las
 * ciudades retenidas, con un enlace a la tarjeta del pie.
 */
function SyncLine({ resumen, canEdit }: { resumen: SyncResumen | null; canEdit: boolean }) {
  if (!resumen) return null;
  const { ultima, retenidas } = resumen;
  const bien = resumen.automaticoActivo && (!ultima || ultima.ok) && !retenidas;
  return (
    <p className="mt-2 flex items-start gap-2 text-[13px] leading-5 text-ink-600">
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", bien ? "bg-ok-fg" : "bg-warn-fg")} />
      <span>
        {resumen.automaticoActivo
          ? "Sync diario con Swayp activo"
          : `Sync diario sin configurar${resumen.faltan.length ? ` (falta ${resumen.faltan.join(", ")})` : ""}`}
        {ultima ? (
          <>
            {" "}
            · última sincronización {haceCuanto(ultima.created_at)}, {ultima.source === "cron" ? "automática" : "manual"}
            {ultima.ok ? (
              ultima.cambios ? (
                `, ${ultima.cambios} ${ultima.cambios === 1 ? "ciudad con cambios" : "ciudades con cambios"}`
              ) : (
                ", sin cambios"
              )
            ) : (
              <span className="font-semibold text-warn-fg">, falló</span>
            )}
          </>
        ) : (
          " · todavía sin sincronizaciones"
        )}
        {retenidas > 0 && (
          <>
            {" "}
            ·{" "}
            {canEdit ? (
              <a href="#sincronizar" className="font-medium text-brand-700 underline-offset-2 hover:underline">
                {retenidas} {retenidas === 1 ? "ciudad retenida" : "ciudades retenidas"}
              </a>
            ) : (
              `${retenidas} ${retenidas === 1 ? "ciudad retenida" : "ciudades retenidas"}`
            )}
          </>
        )}
      </span>
    </p>
  );
}

/**
 * Las herramientas del administrador, al pie: lo de todos los días es ver qué
 * falta; esto es de vez en cuando. El orden es el del MOM —el conteo de Swayp
 * es la fuente y la carga a mano el parche—: leer por API, el Excel de
 * respaldo, anotar a mano y, plegadas, las bodegas configuradas.
 */
function SyncCard({
  stores,
  bodegas,
  estado,
  estadoError,
  onEstadoChanged,
  onMsg,
}: {
  stores: StoreSummary[];
  bodegas: BodegaSwaypResumen[];
  estado: SwaypSyncEstado | null;
  estadoError: boolean;
  onEstadoChanged: () => void;
  onMsg: (m: Msg) => void;
}) {
  return (
    <section id="sincronizar" aria-labelledby="sincronizar-titulo" className={cn(SECTION_CARD, "scroll-mt-6")}>
      <SectionHead
        id="sincronizar-titulo"
        title="Sincronizar stock desde Swayp"
        help="El sync diario deja cada ciudad igual a Swayp sin que nadie haga nada. Aquí se lee al momento, se importa el Excel de respaldo o se anota a mano lo que Swayp no cubre."
      />
      <DryRunSwayp estado={estado} estadoError={estadoError} onEstadoChanged={onEstadoChanged} />
      <ImportarDeSwayp onDone={onMsg} />
      <AnotarAMano stores={stores} onMsg={onMsg} />
      {bodegas.length > 0 && <BodegasSwayp bodegas={bodegas} />}
    </section>
  );
}

const CATALOGO_HREF = "/dashboard/envios/aliclik";
const LINK = "font-medium text-brand-700 underline-offset-2 hover:underline";

/**
 * Sync del inventario de Swayp por API, en dos pasos: «Leer» trae todas las
 * bodegas y muestra qué cambiaría por ciudad SIN escribir; «Aplicar» vuelve a
 * leer en el servidor y escribe las ciudades marcadas, por el kardex, igual que
 * el importador de Excel. El token se pega a mano y no se guarda (dura ~1 h).
 * Correo, RUC e idCompany vienen precargados con los de la organización.
 */
function DryRunSwayp({
  estado,
  estadoError,
  onEstadoChanged,
}: {
  estado: SwaypSyncEstado | null;
  estadoError: boolean;
  onEstadoChanged: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [accion, setAccion] = useState<"leer" | "aplicar" | null>(null);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("fkc@monono.pe");
  const [ruc, setRuc] = useState("20610091823");
  const [idCompany, setIdCompany] = useState("IsjvRm8cEqQBFP4r0TxF");
  const [res, setRes] = useState<DryRunResult | null>(null);
  const [aplicado, setAplicado] = useState<Extract<SyncResult, { ok: true }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  // Aplicar sobrescribe el stock de ciudades enteras: se confirma con un
  // segundo clic que las nombra, en la página y no en un diálogo del navegador.
  const [confirmar, setConfirmar] = useState(false);
  const [diag, setDiag] = useState<
    { label: string; host: string; method: string; status: number; ok: boolean; body: string }[] | null
  >(null);

  // Si pegan «Bearer <token>», se le quita el prefijo: el código ya lo agrega,
  // y con doble «Bearer» el panel rechaza (403).
  const limpio = token.trim().replace(/^Bearer\s+/i, "");
  // Sin token pegado se lee la API de integraciones (la del sync diario).
  const puedeLeer = !!limpio || !!estado?.automaticoActivo;

  function leer() {
    if (!puedeLeer) return;
    setErr(null);
    setAplicado(null);
    setRes(null);
    setDiag(null);
    setConfirmar(false);
    setAccion("leer");
    start(async () => {
      const r = await swaypInventoryDryRun({ token: limpio, email, user: ruc, idCompany });
      if ("error" in r) {
        setErr(r.error);
        setDiag(r.diagnostico ?? null);
        return;
      }
      setRes(r);
      // Se marcan de entrada las ciudades donde algo cambiaría.
      setMarcadas(new Set(r.ciudades.filter((c) => c.ajustes.length || c.altas.length).map((c) => c.ciudad)));
    });
  }

  function aplicar() {
    if (!puedeLeer || !marcadas.size) return;
    setErr(null);
    setConfirmar(false);
    setAccion("aplicar");
    start(async () => {
      const r = await swaypInventorySync({ token: limpio, email, user: ruc, idCompany, ciudades: [...marcadas] });
      if ("error" in r) {
        setErr(r.error);
        return;
      }
      setAplicado(r);
      // El diff ya no vale: lo que mostraba acaba de aplicarse.
      setRes(null);
      onEstadoChanged();
      router.refresh();
    });
  }

  function alternar(ciudad: string) {
    setConfirmar(false);
    setMarcadas((prev) => {
      const next = new Set(prev);
      if (next.has(ciudad)) next.delete(ciudad);
      else next.add(ciudad);
      return next;
    });
  }

  const leyendo = pending && accion === "leer";
  const aplicando = pending && accion === "aplicar";
  const bodegasEnSync = res?.bodegas.filter((b) => b.enSync).length ?? 0;
  const filasHuerfanas = res?.bodegasSinCiudad.filter((b) => !res.bodegas.some((w) => w.id === b.idWarehouse)) ?? [];
  const lista = [...marcadas].map(capitalizar).join(", ");

  return (
    <div className="space-y-4 pt-4 sm:pt-5">
      <div>
        <h3 className={H4}>Leer el inventario de Swayp</h3>
        <p className={HELP}>Trae todas las bodegas y muestra qué cambiaría en cada ciudad.</p>
      </div>

      {estado ? (
        <EstadoAutomatico estado={estado} />
      ) : estadoError ? (
        <Banner tone="warn" role="alert" title="No se pudo leer el estado del sync">
          <OpsButton size="sm" onClick={onEstadoChanged} className="mt-2 pointer-coarse:h-11">
            Reintentar
          </OpsButton>
        </Banner>
      ) : (
        <p className="rounded-md bg-wash px-3 py-2.5 text-[13px] text-ink-500">Leyendo el estado del sync…</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <OpsButton
          variant={res ? "secondary" : "primary"}
          onClick={leer}
          disabled={pending || !puedeLeer}
          className="pointer-coarse:h-11"
        >
          {leyendo ? "Leyendo Swayp…" : res ? "Volver a leer" : "Leer inventario"}
        </OpsButton>
        <span className={HELP}>Leer no cambia nada en Kapta: muestra qué cambiaría, y tú decides qué aplicar.</span>
      </div>

      <details className="group text-[13px] text-ink-600">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 font-medium text-ink-600 hover:text-ink-900 [&::-webkit-details-marker]:hidden">
          <IconChevronDown aria-hidden className="size-4 -rotate-90 text-ink-500 transition-transform group-open:rotate-0 motion-reduce:transition-none" />
          Respaldo: leer con un token del panel de Swayp
        </summary>
        <div className="mt-2 space-y-3 pl-5">
          <p className={HELP}>
            Solo si la API de integraciones falla. Con tu sesión abierta en Swayp: DevTools → Red → cualquier petición → valor
            de «Authorization». Se usa para esta lectura y no se guarda.
          </p>
          <label className={LABEL}>
            Token
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && leer()}
              placeholder="Pega el token (con o sin «Bearer»)"
              autoComplete="off"
              className={cn(FIELD, "font-normal")}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={LABEL}>
              Correo
              <input value={email} onChange={(e) => setEmail(e.target.value)} className={cn(FIELD, "font-normal")} />
            </label>
            <label className={LABEL}>
              RUC
              <input value={ruc} onChange={(e) => setRuc(e.target.value)} className={cn(FIELD, "font-normal")} />
            </label>
            <label className={LABEL}>
              Id de empresa
              <input value={idCompany} onChange={(e) => setIdCompany(e.target.value)} className={cn(FIELD, "font-normal")} />
            </label>
          </div>
          <p className={HELP}>Con un token pegado, «Leer» y «Aplicar» usan el panel en vez de la API.</p>
        </div>
      </details>

      {err && (
        <Banner tone="crit" role="alert">
          <p>{err}</p>
          {diag && (
            <details className="mt-2 text-[13px]">
              <summary className="cursor-pointer select-none font-medium">Detalle técnico</summary>
              <ul className="mt-1.5 space-y-1.5">
                {diag.map((d, i) => (
                  <li key={i}>
                    <span className="font-medium">
                      {d.method} {d.label}: {d.status === 0 ? "sin conexión" : d.status}
                    </span>
                    {d.body && <span className="block break-all font-mono text-xs">{d.body}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Banner>
      )}

      {aplicado && <ResultadoSync r={aplicado} />}

      {res && (
        <div className="overflow-hidden rounded-md ring-1 ring-line">
          <div className="space-y-1 bg-wash px-3 py-2.5 text-[13px] leading-5 text-ink-700">
            <p>
              <b className="font-semibold tabular-nums text-ink-900">{nf.format(res.totalFilasInventario)} filas</b> en{" "}
              {res.bodegas.length} bodegas · {bodegasEnSync} se sincronizan ·{" "}
              {res.fuente === "integracion" ? "API de integraciones" : "panel, con el token pegado"}
            </p>
            <details className="group">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 font-medium text-ink-600 hover:text-ink-900 [&::-webkit-details-marker]:hidden">
                <IconChevronDown aria-hidden className="size-4 -rotate-90 text-ink-500 transition-transform group-open:rotate-0 motion-reduce:transition-none" />
                Ver bodegas y su ciudad
              </summary>
              <table className="mt-2 w-full max-w-xl text-left">
                <thead className="text-ink-500">
                  <tr>
                    <th className="py-1 pr-3 font-normal">Bodega</th>
                    <th className="py-1 pr-3 font-normal">Ciudad</th>
                    <th className="py-1 text-right font-normal">Filas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {res.bodegas.map((b) => (
                    <tr key={b.id}>
                      <td className="py-1 pr-3 text-ink-900">{b.name}</td>
                      <td className="py-1 pr-3">
                        <span className="capitalize">{b.city ?? "Sin ciudad"}</span>
                        {!b.enSync && <span className="text-warn-fg"> · no se sincroniza</span>}
                      </td>
                      <td className="py-1 text-right tabular-nums text-ink-600">{b.filas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filasHuerfanas.length > 0 && (
                <p className="mt-2 text-warn-fg">
                  Filas de bodegas que Swayp no listó (se saltan):{" "}
                  {filasHuerfanas.map((b) => `${b.idWarehouse || "sin id"} (${b.filas})`).join(", ")}.
                </p>
              )}
            </details>
          </div>

          <ul className="divide-y divide-line border-t border-line">
            {res.ciudades.map((c) => (
              <CiudadDiff key={c.ciudad} c={c} marcada={marcadas.has(c.ciudad)} onToggle={() => alternar(c.ciudad)} />
            ))}
          </ul>

          <div className="space-y-3 border-t border-line bg-wash px-3 py-3">
            {confirmar && marcadas.size > 0 && (
              <Banner tone="warn" role="alert" title={`${lista}: el stock de Kapta quedará igual al de Swayp.`}>
                <p>
                  Cada cambio se registra en el kardex. Swayp se vuelve a leer ahora, así que el resultado puede variar un poco
                  de lo que ves.
                </p>
              </Banner>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {confirmar ? (
                <>
                  <OpsButton variant="primary" onClick={aplicar} disabled={pending} className="pointer-coarse:h-11">
                    {aplicando ? "Aplicando…" : `Sí, aplicar a ${lista}`}
                  </OpsButton>
                  <OpsButton onClick={() => setConfirmar(false)} disabled={pending} className="pointer-coarse:h-11">
                    Cancelar
                  </OpsButton>
                </>
              ) : (
                <>
                  <OpsButton
                    variant="primary"
                    onClick={() => setConfirmar(true)}
                    disabled={pending || !marcadas.size || !puedeLeer}
                    className="pointer-coarse:h-11"
                  >
                    {marcadas.size
                      ? `Aplicar a ${marcadas.size} ${marcadas.size === 1 ? "ciudad" : "ciudades"}…`
                      : "Marca una ciudad para aplicar"}
                  </OpsButton>
                  <span className={HELP}>Vuelve a leer Swayp al aplicar y registra cada cambio en el kardex.</span>
                </>
              )}
            </div>
          </div>

          <details className="group border-t border-line px-3 py-2.5 text-[13px] text-ink-500">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 font-medium hover:text-ink-900 [&::-webkit-details-marker]:hidden">
              <IconChevronDown aria-hidden className="size-4 -rotate-90 transition-transform group-open:rotate-0 motion-reduce:transition-none" />
              Detalle técnico: muestra cruda
            </summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(res.muestra, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

/**
 * El sync diario: si está activo, cuándo fue el último y qué no pudo aplicar.
 * Un fallo o una ciudad retenida se ven aquí, en vez de perderse en los logs.
 */
function EstadoAutomatico({ estado }: { estado: SwaypSyncEstado }) {
  const ultima = estado.corridas[0];
  const ultimaAuto = estado.corridas.find((c) => c.source === "cron");
  const retenidas = ultimaAuto?.ok ? (ultimaAuto.resumen.retenidas ?? []) : [];
  const conCambios = (c: typeof ultima) => c?.resumen.ciudades?.length ?? 0;

  return (
    <div className="space-y-1 rounded-md bg-wash px-3 py-2.5 text-[13px] leading-5 text-ink-600">
      <p>
        <span className="font-semibold text-ink-900">Sync diario: </span>
        {estado.automaticoActivo ? (
          <span>activo. Lee la API de integraciones de Swayp una vez al día, sin que nadie haga nada.</span>
        ) : (
          <span className="text-warn-fg">sin configurar (falta {estado.faltan.join(", ")}).</span>
        )}
      </p>
      <p>
        {ultima ? (
          <>
            Última sincronización {haceCuanto(ultima.created_at)} · {ultima.source === "cron" ? "automática" : "manual"} ·{" "}
            {ultima.ok ? (
              conCambios(ultima) ? (
                `${conCambios(ultima)} ${conCambios(ultima) === 1 ? "ciudad con cambios" : "ciudades con cambios"}`
              ) : (
                "sin cambios"
              )
            ) : (
              <span className="font-semibold text-crit-fg">falló</span>
            )}
            .
          </>
        ) : (
          "Todavía no hay sincronizaciones registradas."
        )}
      </p>
      {ultima && !ultima.ok && ultima.source === "cron" && (
        <p className="text-crit-fg">
          El último intento automático falló: {ultima.error} Se reintenta solo a la hora siguiente.
        </p>
      )}
      {retenidas.length > 0 && (
        <div className="text-warn-fg">
          <p className="font-semibold">El sync automático no aplicó estas ciudades. Léelas y revísalas antes de aplicar:</p>
          <ul className="mt-0.5 space-y-0.5">
            {retenidas.map((r) => (
              <li key={r.ciudad}>
                <span className="capitalize">{r.ciudad}</span>: {r.motivo}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Una ciudad del diff: qué cambia, con el detalle a un clic. */
function CiudadDiff({
  c,
  marcada,
  onToggle,
}: {
  c: DryRunResult["ciudades"][number];
  marcada: boolean;
  onToggle: () => void;
}) {
  const sinControl = ciudadSinControl(c.ciudad);
  const bajan = c.ajustes.filter((a) => a.cantidadNueva < a.cantidadAnterior);
  const aCero = bajan.filter((a) => a.cantidadNueva === 0);
  const suben = c.ajustes.length - bajan.length;
  const sinVincular = c.huerfanos.filter((h) => h.motivo === "sin_vinculo");
  const sinEtiqueta = c.huerfanos.filter((h) => h.motivo === "sin_etiqueta");
  const hayCambios = c.ajustes.length > 0 || c.altas.length > 0;
  // Bajan primero (lo que más duele si está mal), y dentro, los que van a 0.
  const ordenados = [...c.ajustes].sort(
    (x, y) => x.cantidadNueva - x.cantidadAnterior - (y.cantidadNueva - y.cantidadAnterior),
  );
  const id = `ciudad-${c.ciudad}`;

  return (
    <li className="px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <input id={id} type="checkbox" checked={marcada} onChange={onToggle} disabled={!hayCambios} className={CHECKBOX} />
        <label htmlFor={id} className="text-sm font-semibold capitalize text-ink-900">
          {c.ciudad}
        </label>
        <div className="flex flex-wrap gap-1.5">
          {hayCambios ? (
            <>
              {bajan.length > 0 && (
                <Badge tone="crit" className="tabular-nums">
                  {nf.format(bajan.length)} {bajan.length === 1 ? "baja" : "bajan"}
                </Badge>
              )}
              {suben > 0 && (
                <Badge tone="ok" className="tabular-nums">
                  {nf.format(suben)} {suben === 1 ? "sube" : "suben"}
                </Badge>
              )}
              {c.altas.length > 0 && (
                <Badge tone="info" className="tabular-nums">
                  {nf.format(c.altas.length)} {c.altas.length === 1 ? "alta" : "altas"}
                </Badge>
              )}
            </>
          ) : (
            <span className="text-[13px] text-ink-500">Ya coincide con Swayp</span>
          )}
          {sinVincular.length > 0 && <Badge tone="warn" className="tabular-nums">{nf.format(sinVincular.length)} sin vincular</Badge>}
        </div>
        <span className="ml-auto text-[13px] tabular-nums text-ink-500">
          {sinControl ? (
            "Sin control de cantidad: solo altas"
          ) : (
            <>
              {nf.format(c.totalNuestro)} → <span className="font-semibold text-ink-900">{nf.format(c.totalSwayp)}</span> u.
            </>
          )}
        </span>
      </div>

      {sinVincular.length > 0 && aCero.length > 0 && (
        <p className="mt-2.5 rounded-md bg-warn-wash px-3 py-2 text-[13px] leading-5 text-ink-700">
          {aCero.length} {aCero.length === 1 ? "producto pasaría" : "productos pasarían"} a 0, y Swayp tiene{" "}
          {sinVincular.length} {sinVincular.length === 1 ? "código" : "códigos"} sin vincular. Si es el mismo producto,
          vincúlalo en{" "}
          <a href={CATALOGO_HREF} className={LINK}>
            Catálogo de productos
          </a>{" "}
          y vuelve a leer antes de aplicar.
        </p>
      )}

      {(c.ajustes.length > 0 || c.altas.length > 0 || c.huerfanos.length > 0) && (
        <details className="group mt-2.5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-ink-600 hover:text-ink-900 [&::-webkit-details-marker]:hidden">
            <IconChevronDown aria-hidden className="size-4 -rotate-90 text-ink-500 transition-transform group-open:rotate-0 motion-reduce:transition-none" />
            Ver detalle
          </summary>
          <div className="mt-2 space-y-3 text-[13px] leading-5">
            {ordenados.length > 0 && (
              <table className="w-full table-fixed text-left">
                <thead className="text-ink-500">
                  <tr>
                    <th className="py-1 pr-3 font-normal">Producto</th>
                    <th className="w-12 py-1 pr-2 text-right font-normal sm:w-16 sm:pr-3">Kapta</th>
                    <th className="w-12 py-1 pr-2 text-right font-normal sm:w-16 sm:pr-3">Swayp</th>
                    <th className="w-14 py-1 text-right font-normal sm:w-16">Cambio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {ordenados.map((a) => {
                    const d = a.cantidadNueva - a.cantidadAnterior;
                    return (
                      <tr key={a.id}>
                        <td className="py-1 pr-3 text-ink-900">
                          <div className="flex min-w-0 gap-1.5" title={a.product}>
                            {a.codbar && <span className="shrink-0 font-mono text-xs leading-5 text-ink-500">{a.codbar}</span>}
                            <span className="truncate">{a.product}</span>
                          </div>
                        </td>
                        <td className="py-1 pr-2 text-right tabular-nums text-ink-500 sm:pr-3">{a.cantidadAnterior}</td>
                        <td className="py-1 pr-2 text-right font-semibold tabular-nums text-ink-900 sm:pr-3">{a.cantidadNueva}</td>
                        <td className={cn("py-1 text-right font-semibold tabular-nums", d < 0 ? "text-crit-fg" : "text-ok-fg")}>
                          {a.cantidadNueva === 0 ? "a 0" : `${d > 0 ? "+" : "−"}${Math.abs(d)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {c.altas.length > 0 && (
              <div>
                <p className="font-semibold text-ink-900">Se dan de alta</p>
                <ul className="mt-1 space-y-0.5 text-ink-600">
                  {c.altas.map((a) => (
                    <li key={a.codbar + a.sku}>
                      <span className="mr-1.5 font-mono text-xs text-ink-500">{a.codbar}</span>
                      {a.product} · <span className="tabular-nums">{nf.format(a.cantidad)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {sinVincular.length > 0 && (
              <div>
                <p className="font-semibold text-warn-fg">
                  No se cargan: sin vincular en{" "}
                  <a href={CATALOGO_HREF} className={LINK}>
                    Catálogo de productos
                  </a>
                </p>
                <ul className="mt-1 space-y-0.5 text-ink-600">
                  {sinVincular.map((h) => (
                    <li key={h.codbar}>
                      <span className="mr-1.5 font-mono text-xs text-ink-500">{h.codbar}</span>
                      {h.nombre} · <span className="tabular-nums">{nf.format(h.disponible)}</span> en Swayp
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {sinEtiqueta.length > 0 && (
              <div>
                <p className="font-semibold text-ink-900">No se cargan: vinculados, pero ninguna ciudad tiene ese SKU</p>
                <ul className="mt-1 space-y-0.5 text-ink-600">
                  {sinEtiqueta.map((h) => (
                    <li key={h.codbar}>
                      <span className="mr-1.5 font-mono text-xs text-ink-500">{h.codbar}</span>
                      {h.nombre} · <span className="tabular-nums">{nf.format(h.disponible)}</span> en Swayp
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </li>
  );
}

/** Lo que dejó «Aplicar», ciudad por ciudad. */
function ResultadoSync({ r }: { r: Extract<SyncResult, { ok: true }> }) {
  const pendientes = r.ciudades.flatMap((c) => c.sinVincular);
  const unicos = [...new Set(pendientes)];
  return (
    <Banner tone="ok" role="status" title="Stock sincronizado con Swayp">
      <ul className="mt-1.5 space-y-1">
        {r.ciudades.map((c) => {
          const sinControl = ciudadSinControl(c.ciudad);
          const partes = [
            c.bajan ? `${c.bajan} ${c.bajan === 1 ? "baja" : "bajan"}${c.aCero ? ` (${c.aCero} a 0)` : ""}` : null,
            c.suben ? `${c.suben} ${c.suben === 1 ? "sube" : "suben"}` : null,
            c.altas ? `${c.altas} ${c.altas === 1 ? "alta" : "altas"}` : null,
          ].filter(Boolean);
          return (
            <li key={c.ciudad} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold capitalize text-ink-900">{c.ciudad}</span>
              <span>{partes.length ? partes.join(" · ") : "sin cambios"}</span>
              {!sinControl && (
                <span className="text-[13px] tabular-nums text-ink-500">
                  {nf.format(c.unidadesAntes)} → {nf.format(c.unidadesDespues)} u.
                </span>
              )}
              {c.fallidos > 0 && <span className="text-[13px] font-semibold text-crit-fg">{c.fallidos} no se pudieron aplicar</span>}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[13px] leading-5">
        {r.guias !== null
          ? `${nf.format(r.guias)} guías recalculadas con el stock nuevo.`
          : `El stock quedó aplicado, pero no se pudieron recalcular las guías: ${r.errorGuias ?? "error desconocido"}.`}
        {r.noVinieron.length > 0 && ` Sin datos de Swayp, no se tocaron: ${r.noVinieron.map(capitalizar).join(", ")}.`}
      </p>
      {unicos.length > 0 && (
        <p className="mt-2 text-[13px] leading-5 text-warn-fg">
          Quedaron sin cargar {unicos.length} {unicos.length === 1 ? "código" : "códigos"} ({unicos.join(", ")}): vincúlalos en{" "}
          <a href={CATALOGO_HREF} className={LINK}>
            Catálogo de productos
          </a>{" "}
          y vuelve a sincronizar.
        </p>
      )}
    </Banner>
  );
}

/**
 * Subir el "Inventario por bodega" que exporta Swayp y dejar esa ciudad igual
 * que allá.
 *
 * Va antes de la carga manual a propósito: el conteo de Swayp es la verdad y la
 * carga a mano el parche. Cuando el orden era al revés, la tabla se llenaba a
 * mano y nadie importaba nada.
 *
 * La ciudad NO se elige acá: sale de la columna «Bodega» del propio archivo.
 * Un selector sería una forma de equivocarse —importar Trujillo sobre Juliaca
 * pone a cero toda una ciudad— y el dato ya viene en el Excel.
 */
function ImportarDeSwayp({ onDone }: { onDone: (m: Msg) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [archivo, setArchivo] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function subir() {
    if (!archivo) return;
    start(async () => {
      const fd = new FormData();
      fd.set("archivo", archivo);
      const r = await importarInventarioSwayp(fd);
      onDone(r.error ? { kind: "error", text: r.error } : r.notice ? { kind: "ok", text: r.notice } : null);
      if (!r.error) {
        setArchivo(null);
        if (inputRef.current) inputRef.current.value = "";
        router.refresh();
      }
    });
  }

  return (
    <div className={cn(CARD_ZONE, "mt-5 space-y-3")}>
      <div>
        <h3 className={H4}>Importar el Excel de Swayp</h3>
        <p className={HELP}>
          El respaldo si la API no responde. En Swayp: <b className="font-semibold text-ink-700">Stock → Inventario</b>, elige la
          bodega y «Enviar a Excel». Un archivo por bodega; la ciudad sale del propio archivo.
        </p>
      </div>
      {/* El campo de archivo del navegador («Choose File / No file chosen»)
          no es de este mundo ni de este idioma: va oculto detrás de su
          etiqueta, con el foco dibujado en ella. */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          id="importar-swayp"
          type="file"
          accept=".xlsx,.csv"
          onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
          className="peer sr-only"
        />
        <label
          htmlFor="importar-swayp"
          className={opsButtonClass(
            "secondary",
            "md",
            "cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500 pointer-coarse:h-11",
          )}
        >
          Elegir archivo
        </label>
        <span className={cn("min-w-0 truncate text-[13px]", archivo ? "text-ink-900" : "text-ink-500")}>
          {archivo?.name ?? "Ningún archivo"}
        </span>
        <OpsButton onClick={subir} disabled={pending || !archivo} className="pointer-coarse:h-11">
          {pending ? "Importando…" : "Importar"}
        </OpsButton>
      </div>
      <p className="rounded-md bg-wash px-3 py-2 text-[13px] leading-5 text-ink-600">
        Los productos que Swayp no lista quedan en 0: si esa bodega no lo tiene, no se puede prometer. Sólo se toca la ciudad del
        archivo.
      </p>
    </div>
  );
}

/** Agregar un producto a una ciudad o corregir su saldo: el parche, a mano. */
function AnotarAMano({ stores, onMsg }: { stores: StoreSummary[]; onMsg: (m: Msg) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [storeId, setStoreId] = useState<string>(stores[0]?.id ?? "");
  const [city, setCity] = useState<string>(FENIX_CITIES[0] ?? "cusco");
  const [product, setProduct] = useState("");
  const [sku, setSku] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("0");
  // Sin control de cantidad (Lima): el producto existe en la bodega y no se
  // cuenta. Se recuerda entre altas porque se cargan de a muchos.
  const [unlimited, setUnlimited] = useState(false);
  const reglaCiudad = ciudadSinControl(city);
  const libre = unlimited || reglaCiudad;

  function add() {
    start(async () => {
      const r = await upsertFenixStock({
        city,
        product,
        quantity: libre ? 0 : Number(quantity) || 0,
        sku,
        unlimited: libre,
      });
      onMsg(r.error ? { kind: "error", text: r.error } : r.notice ? { kind: "ok", text: r.notice } : null);
      if (!r.error) {
        setProduct("");
        setSku(null);
        setQuantity("0");
        router.refresh();
      }
    });
  }

  return (
    <div className={cn(CARD_ZONE, "mt-5 space-y-3")}>
      <div>
        <h3 className={H4}>Anotar a mano</h3>
        <p className={HELP}>Agrega un producto a una ciudad o corrige su saldo. Es el parche: la fuente es el conteo de Swayp.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,10rem)_minmax(0,9rem)_minmax(0,1fr)_minmax(0,7rem)]">
        <label className={LABEL}>
          Tienda
          <select
            value={storeId}
            onChange={(e) => {
              setStoreId(e.target.value);
              setProduct(""); // catalog changes → reset the picked product
              setSku(null);
            }}
            className={cn(FIELD, "font-normal pointer-coarse:h-11")}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Ciudad
          <select
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className={cn(FIELD, "font-normal capitalize pointer-coarse:h-11")}
          >
            {FENIX_CITIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div className={cn(LABEL, "sm:col-span-2 lg:col-span-1")}>
          <span id="anotar-producto">Producto</span>
          <ProductCombobox
            storeId={storeId}
            value={product}
            labelledBy="anotar-producto"
            onChange={(p, s) => {
              setProduct(p);
              setSku(s);
            }}
          />
        </div>
        <label className={LABEL}>
          Cantidad
          <input
            type="number"
            min={0}
            value={libre ? "" : quantity}
            placeholder={libre ? "∞" : undefined}
            disabled={libre}
            onChange={(e) => setQuantity(e.target.value)}
            className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <label
          className="flex items-center gap-2 text-[13px] text-ink-700 pointer-coarse:min-h-11"
          title={
            reglaCiudad
              ? `${city} no lleva control de cantidad: todo producto anotado vale como disponible.`
              : "El producto existe en la bodega y no se cuenta: siempre disponible, la entrega no descuenta y el Excel no lo toca."
          }
        >
          <input
            type="checkbox"
            checked={libre}
            disabled={reglaCiudad}
            onChange={(e) => setUnlimited(e.target.checked)}
            className={CHECKBOX}
          />
          {reglaCiudad ? "Sin control de cantidad (regla de la ciudad)" : "Sin control de cantidad"}
        </label>
        <OpsButton onClick={add} disabled={pending || !product.trim()} className="pointer-coarse:h-11">
          Guardar
        </OpsButton>
      </div>
      {reglaCiudad && (
        <p className="rounded-md bg-wash px-3 py-2 text-[13px] leading-5 text-ink-600">
          <span className="capitalize">{city}</span> no usa esta tabla: todo producto pasa la reja de stock, y el vínculo en
          Catálogo de productos se exige al crear la guía. Anotar renglones acá es opcional y sólo informativo.
        </p>
      )}
    </div>
  );
}

/**
 * Qué bodegas ve la app en `SWAYP_SENDERS`, ciudad por ciudad.
 *
 * La variable es Secret en Vercel —de sólo escritura— y una ciudad mal escrita
 * se descarta en silencio. Sin este cuadro, la única forma de saber qué había
 * configurado era editar a ciegas y ver si Arequipa seguía emitiendo. Muestra
 * los datos completos porque son los de nuestras bodegas, no credenciales: es
 * exactamente lo que hay que copiar para reescribir la variable sin perder
 * nada. Va plegado: se mira cuando algo deja de emitir.
 */
function BodegasSwayp({ bodegas }: { bodegas: BodegaSwaypResumen[] }) {
  const porApi = bodegas.filter((b) => b.porApi).length;
  return (
    <details className={cn(CARD_ZONE, "group mt-5")}>
      <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
        <IconChevronDown
          aria-hidden
          className="mt-0.5 size-4 shrink-0 -rotate-90 text-ink-500 transition-transform group-open:rotate-0 motion-reduce:transition-none"
        />
        <span>
          <span className={cn(H4, "block")}>Bodegas Swayp configuradas</span>
          <span className={cn(HELP, "block")}>
            {porApi} de {bodegas.length} ciudades emiten por API
          </span>
        </span>
      </summary>
      <ul className="-mx-4 mt-3 divide-y divide-line border-t border-line sm:-mx-5">
        {bodegas.map((b) => (
          <li key={b.city} className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:px-5">
            <div className="flex flex-wrap items-center gap-2 sm:block sm:space-y-1">
              <p className="text-sm font-semibold capitalize text-ink-900">{b.city}</p>
              {b.porApi ? (
                <Badge tone="ok">por API</Badge>
              ) : b.configurada ? (
                <Badge tone="warn" wrap>configurada, sin ubigeo</Badge>
              ) : (
                <Badge>sin bodega → Excel</Badge>
              )}
            </div>
            <dl className="grid gap-x-6 gap-y-1 text-[13px] leading-5 sm:grid-cols-2">
              {(
                [
                  ["Nombre", b.nombre, false],
                  ["Dirección", b.direccion, false],
                  ["Teléfono", b.telefono, true],
                  ["Email", b.email, false],
                  ["RUC", b.nit === "" ? "vacío" : b.nit, true],
                  ["idWarehouse", b.idWarehouse, true],
                ] as const
              ).map(([k, v, mono]) => (
                <div key={k} className="flex min-w-0 gap-2">
                  <dt className="shrink-0 text-ink-500">{k}</dt>
                  <dd className={cn("min-w-0 break-words text-ink-900", mono && "font-mono text-xs leading-5", v == null && "text-ink-300")}>
                    {v ?? "—"}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Product typeahead sourced from the selected store's Shopify catalog (mirrors
 * the leads ProductPicker). Empty query → active products, so focusing the field
 * shows the catalog as a dropdown. Picking a product also carries its SKU; free
 * typing keeps working (and clears the SKU) when read_products isn't granted.
 */
function ProductCombobox({
  storeId,
  value,
  labelledBy,
  onChange,
}: {
  storeId: string;
  value: string;
  labelledBy?: string;
  onChange: (product: string, sku: string | null) => void;
}) {
  const [results, setResults] = useState<ProductResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // search on (value, store) change, debounced; empty value lists active products
  useEffect(() => {
    if (!storeId) {
      setResults(null);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchStockProducts(storeId, value.trim());
      if (alive) {
        setResults(r);
        setSearching(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value, storeId]);

  // close the dropdown on outside click
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <input
        value={value}
        aria-labelledby={labelledBy}
        onChange={(e) => {
          onChange(e.target.value, null); // typing clears the picked SKU
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder="Buscar producto…"
        className={cn(FIELD, "font-normal pointer-coarse:h-11")}
      />
      {open && (results !== null || searching) && (
        <div className={cn("absolute mt-1 w-full rounded-lg bg-white py-1 shadow-pop ring-1 ring-line", OVER_TABLE_Z)}>
          {searching && <p className="px-3 py-1.5 text-[13px] text-ink-500">Buscando…</p>}
          {results && results.length === 0 && !searching && (
            <p className="px-3 py-1.5 text-[13px] leading-5 text-ink-500">
              Sin resultados (o falta el permiso read_products). Puedes escribir el nombre.
            </p>
          )}
          {results && results.length > 0 && (
            <ul className="max-h-56 overflow-y-auto">
              {results.map((p) => (
                <li key={p.variantId}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(p.title, p.sku ?? null);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-wash pointer-coarse:min-h-11"
                  >
                    <span className="flex-1 text-sm font-normal text-ink-900">{p.title}</span>
                    {p.inventory != null && (
                      <span className={cn("shrink-0 text-[13px] tabular-nums", p.inventory > 0 ? "text-ink-500" : "text-warn-fg")}>
                        stock {p.inventory}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const MOVEMENT_TONE: Record<string, string> = {
  entrada: "text-ok-fg",
  salida_entrega: "text-ink-600",
  salida_merma: "text-crit-fg",
  ajuste: "text-info-fg",
};

type KardexMovement = {
  id: string;
  kind: StockMovementKind;
  delta: number;
  balance_after: number;
  note: string | null;
  shipment_id: string | null;
  created_at: string;
  by: string | null;
};

/**
 * Kardex de un producto: historial de movimientos + formularios de Entrada /
 * Merma / Ajuste (conteo de Swayp). Las salidas por entrega aparecen en el
 * historial pero se registran solas al entregar cada guía.
 */
function StockKardexModal({
  row,
  canEdit,
  onClose,
  onChanged,
}: {
  row: FenixStockRowDb;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [moves, setMoves] = useState<KardexMovement[] | null>(null);
  const [kind, setKind] = useState<"entrada" | "salida_merma" | "ajuste">("entrada");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, start] = useTransition();
  const panel = useRef<HTMLDivElement>(null);

  // El foco entra al abrir y vuelve a quien lo abrió al cerrar.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => before?.focus?.();
  }, []);

  const reload = () => getFenixStockMovements(row.id).then((m) => setMoves(m as KardexMovement[]));
  useEffect(() => {
    let alive = true;
    getFenixStockMovements(row.id).then((m) => {
      if (alive) setMoves(m as KardexMovement[]);
    });
    return () => {
      alive = false;
    };
  }, [row.id]);

  function submit() {
    const n = Number(qty);
    if (qty.trim() === "" || !Number.isFinite(n)) {
      setMsg({ kind: "error", text: kind === "ajuste" ? "Ingresa el conteo real de Swayp." : "Ingresa la cantidad." });
      return;
    }
    start(async () => {
      const r = await recordFenixStockMovement({ stockId: row.id, kind, quantity: n, note });
      setMsg(r.error ? { kind: "error", text: r.error } : r.notice ? { kind: "ok", text: r.notice } : null);
      if (!r.error) {
        setQty("");
        setNote("");
        await reload();
        onChanged();
      }
    });
  }

  const qtyLabel =
    kind === "ajuste" ? "Conteo real de Swayp" : kind === "salida_merma" ? "Unidades que salieron" : "Unidades que llegaron";

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-ink-900/30 p-4" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kardex-titulo"
        tabIndex={-1}
        style={{ outline: "none" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          onClose();
        }}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-lg bg-white shadow-pop"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-white px-5 pb-3 pt-4">
          <div className="min-w-0">
            <h2 id="kardex-titulo" className="text-lg font-semibold leading-7 text-ink-900">
              Movimientos de stock
            </h2>
            <p className="text-[13px] leading-5 text-ink-500">
              <span className="capitalize">{row.city}</span> · {row.product} · saldo{" "}
              <b className="font-semibold tabular-nums text-ink-900">{row.quantity}</b>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:size-11"
          >
            <IconX aria-hidden className="size-4" />
          </button>
        </header>

        <div className="space-y-5 px-5 py-4">
          {canEdit && (
            <div className="space-y-3">
              <div role="group" aria-label="Tipo de movimiento" className="flex flex-wrap gap-2">
                {(["entrada", "salida_merma", "ajuste"] as const).map((k) => (
                  <ChoiceChip key={k} label={STOCK_MOVEMENT_LABEL[k]} active={kind === k} onClick={() => setKind(k)} />
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <label className={LABEL}>
                  {qtyLabel}
                  <input
                    type="number"
                    min={0}
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
                  />
                </label>
                <label className={LABEL}>
                  {kind === "salida_merma" ? "Motivo (obligatorio)" : "Nota (opcional)"}
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className={cn(FIELD, "font-normal pointer-coarse:h-11")}
                  />
                </label>
              </div>
              {kind === "ajuste" && (
                <p className={HELP}>El sistema calcula la diferencia contra el saldo actual y la deja registrada como ajuste.</p>
              )}
              <div className="flex justify-end">
                <OpsButton variant="primary" onClick={submit} disabled={pending} className="pointer-coarse:h-11">
                  Registrar
                </OpsButton>
              </div>
              {msg && (
                <Banner tone={msg.kind === "ok" ? "ok" : "crit"} role={msg.kind === "ok" ? "status" : "alert"}>
                  <p>{msg.text}</p>
                </Banner>
              )}
            </div>
          )}

          <div className={cn(canEdit && "border-t border-line pt-4")}>
            <h3 className={H4}>Historial</h3>
            {moves === null ? (
              <p className="mt-2 text-sm text-ink-500">Cargando…</p>
            ) : moves.length === 0 ? (
              <p className="mt-2 text-sm text-ink-500">Sin movimientos todavía.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {moves.map((m) => (
                  <li key={m.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 py-2">
                    <span className={cn("text-sm font-medium", MOVEMENT_TONE[m.kind] ?? "text-ink-600")}>
                      {STOCK_MOVEMENT_LABEL[m.kind]}
                    </span>
                    <span
                      className={cn(
                        "text-right text-sm font-semibold tabular-nums",
                        m.delta < 0 ? "text-crit-fg" : "text-ok-fg",
                      )}
                    >
                      {m.delta > 0 ? `+${m.delta}` : m.delta < 0 ? `−${Math.abs(m.delta)}` : "0"}
                    </span>
                    <span className="w-14 text-right text-sm tabular-nums text-ink-500">= {m.balance_after}</span>
                    <span className="col-span-3 text-[13px] leading-5 text-ink-500">
                      {new Date(m.created_at).toLocaleString("es-PE", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {m.by ? ` · ${m.by}` : ""}
                      {m.note ? ` · ${m.note}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
