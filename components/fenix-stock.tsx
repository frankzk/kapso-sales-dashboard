"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Card, cn } from "@/components/ui";
import { FENIX_CITIES } from "@/lib/shipments";
import type { DemandRow } from "@/lib/fenix-demand";
import type { FenixStockRowDb, StoreSummary } from "@/lib/types";
import {
  deleteFenixStock,
  getFenixStockMovements,
  recomputeFenixEligibility,
  recordFenixStockMovement,
  searchStockProducts,
  upsertFenixStock,
} from "@/app/dashboard/envios/actions";
import { STOCK_MOVEMENT_LABEL, type StockMovementKind } from "@/lib/fenix-ledger";

type ProductResult = Awaited<ReturnType<typeof searchStockProducts>>[number];

export function FenixStockEditor({
  rows,
  canEdit,
  stores,
  demand = [],
}: {
  rows: FenixStockRowDb[];
  canEdit: boolean;
  stores: StoreSummary[];
  demand?: DemandRow[];
}) {
  const router = useRouter();
  const [storeId, setStoreId] = useState<string>(stores[0]?.id ?? "");
  const [city, setCity] = useState<string>(FENIX_CITIES[0] ?? "cusco");
  const [product, setProduct] = useState("");
  const [sku, setSku] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("0");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [cityFilter, setCityFilter] = useState<string | null>(null); // null = todas
  const [kardexRow, setKardexRow] = useState<FenixStockRowDb | null>(null);

  // Provincias presentes en el inventario, para el filtro.
  const cityOptions = Array.from(new Set(rows.map((r) => r.city))).sort((a, b) => a.localeCompare(b));
  const visibleRows = cityFilter ? rows.filter((r) => r.city === cityFilter) : rows;

  function add() {
    start(async () => {
      const r = await upsertFenixStock({
        city,
        product,
        quantity: Number(quantity) || 0,
        sku,
      });
      setMsg(r.error ?? r.notice ?? null);
      if (!r.error) {
        setProduct("");
        setSku(null);
        setQuantity("0");
        router.refresh();
      }
    });
  }

  function remove(id: string) {
    start(async () => {
      await deleteFenixStock(id);
      router.refresh();
    });
  }

  function recompute() {
    start(async () => {
      const r = await recomputeFenixEligibility();
      setMsg("error" in r ? r.error : r.notice);
      if (!("error" in r)) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-900">Stock Fenix por ciudad</h1>
        <div className="flex items-center gap-3">
          {canEdit && (
            <button
              onClick={recompute}
              disabled={pending}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Recalcular elegibilidad
            </button>
          )}
          <a href="/dashboard/envios" className="text-sm text-brand-700 hover:underline">
            ← Volver a Repro Provincia
          </a>
        </div>
      </div>

      <DemandReport demand={demand} />

      {!canEdit && (
        <Card>
          <p className="text-sm text-amber-700">
            Solo un administrador puede editar el stock. Lo ves en modo lectura.
          </p>
        </Card>
      )}

      {canEdit && (
        <Card className="space-y-3">
          <p className="text-sm font-medium text-slate-800">Agregar / actualizar</p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs text-slate-400">Tienda</label>
              <select
                value={storeId}
                onChange={(e) => {
                  setStoreId(e.target.value);
                  setProduct(""); // catalog changes → reset the picked product
                  setSku(null);
                }}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400">Ciudad</label>
              <select
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm capitalize"
              >
                {FENIX_CITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[16rem] flex-1">
              <label className="block text-xs text-slate-400">Producto</label>
              <ProductCombobox
                storeId={storeId}
                value={product}
                onChange={(p, s) => {
                  setProduct(p);
                  setSku(s);
                }}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400">Cantidad</label>
              <input
                type="number"
                min={0}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-24 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
              />
            </div>
            <button
              onClick={add}
              disabled={pending || !product.trim()}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Guardar
            </button>
          </div>
          {msg && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}
        </Card>
      )}

      <Card className="p-0">
        {rows.length === 0 ? (
          <p className="p-5 text-sm text-slate-400">Sin stock registrado.</p>
        ) : (
          <>
            {cityOptions.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-4 py-2.5">
                <span className="text-xs text-slate-400">Provincia:</span>
                <button
                  type="button"
                  onClick={() => setCityFilter(null)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition",
                    cityFilter === null
                      ? "border-brand-200 bg-brand-50 text-brand-700"
                      : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                  )}
                >
                  Todas
                </button>
                {cityOptions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCityFilter(c)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition",
                      cityFilter === c
                        ? "border-brand-200 bg-brand-50 text-brand-700"
                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                    )}
                  >
                    {c}
                  </button>
                ))}
                <span className="ml-auto text-xs text-slate-400">
                  {visibleRows.length} producto(s) · {visibleRows.reduce((n, r) => n + r.quantity, 0)} u.
                </span>
              </div>
            )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="px-4 py-2.5 text-left font-medium">Ciudad</th>
                  <th className="px-4 py-2.5 text-left font-medium">Producto</th>
                  <th className="px-4 py-2.5 text-right font-medium">Saldo</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5 capitalize text-slate-700">{r.city}</td>
                    <td className="px-4 py-2.5 text-slate-700">{r.product}</td>
                    <td
                      className={cn(
                        "px-4 py-2.5 text-right font-medium tabular-nums",
                        r.quantity < 0 ? "text-rose-600" : "text-slate-700",
                      )}
                    >
                      {r.quantity}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => setKardexRow(r)}
                          className="text-xs text-brand-700 hover:underline"
                        >
                          Movimientos
                        </button>
                        {canEdit && (
                          <button
                            onClick={() => remove(r.id)}
                            disabled={pending}
                            className="text-xs text-rose-600 hover:underline"
                          >
                            Eliminar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>

      {kardexRow && (
        <StockKardexModal row={kardexRow} canEdit={canEdit} onClose={() => setKardexRow(null)} onChanged={() => router.refresh()} />
      )}
    </div>
  );
}

const DEMAND_BADGE: Record<string, string> = {
  sin_stock: "bg-rose-50 text-rose-700",
  reponer: "bg-amber-50 text-amber-700",
  ok: "bg-emerald-50 text-emerald-700",
};
const DEMAND_LABEL: Record<string, string> = {
  sin_stock: "Sin stock",
  reponer: "Reponer",
  ok: "OK",
};

/**
 * Demand-vs-stock report: what pending guides need in each province vs. what's
 * in stock. Rows needing action (shortfall > 0) float to the top, so the list
 * doubles as the "prepare & send" checklist. Recomputed on every page load, so
 * it tracks the queue as order states change.
 */
function DemandReport({ demand }: { demand: DemandRow[] }) {
  const toSend = demand.filter((d) => d.shortfall > 0);
  const cities = new Set(toSend.map((d) => d.city)).size;
  const units = toSend.reduce((n, d) => n + d.shortfall, 0);

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
        <p className="text-sm font-medium text-slate-800">Demanda por ciudad (guías pendientes)</p>
        {toSend.length > 0 ? (
          <span className="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700">
            ⚠ {toSend.length} producto(s) por reponer · {units} unidad(es) · {cities} ciudad(es)
          </span>
        ) : (
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
            Stock cubre la demanda actual
          </span>
        )}
      </div>
      {demand.length === 0 ? (
        <p className="p-5 text-sm text-slate-400">Sin guías pendientes en ciudades Fenix.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-500">
                <th className="px-4 py-2.5 text-left font-medium">Ciudad</th>
                <th className="px-4 py-2.5 text-left font-medium">Producto</th>
                <th className="px-4 py-2.5 text-right font-medium">Pendientes</th>
                <th className="px-4 py-2.5 text-right font-medium">Stock</th>
                <th className="px-4 py-2.5 text-right font-medium">Faltante</th>
                <th className="px-4 py-2.5 text-left font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {demand.map((d, i) => (
                <tr key={`${d.city}-${d.product}-${i}`} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5 capitalize text-slate-700">{d.city}</td>
                  <td className="px-4 py-2.5 text-slate-700">{d.product}</td>
                  <td className="px-4 py-2.5 text-right text-slate-700">{d.demand}</td>
                  <td className="px-4 py-2.5 text-right text-slate-700">{d.stock}</td>
                  <td
                    className={cn(
                      "px-4 py-2.5 text-right font-medium",
                      d.shortfall > 0 ? "text-rose-600" : "text-slate-400",
                    )}
                  >
                    {d.shortfall > 0 ? d.shortfall : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                        DEMAND_BADGE[d.status] ?? "bg-slate-100 text-slate-600",
                      )}
                    >
                      {DEMAND_LABEL[d.status] ?? d.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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
  onChange,
}: {
  storeId: string;
  value: string;
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
        onChange={(e) => {
          onChange(e.target.value, null); // typing clears the picked SKU
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Buscar producto…"
        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
      />
      {open && (results !== null || searching) && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
          {searching && <p className="px-2.5 py-1.5 text-xs text-slate-400">Buscando…</p>}
          {results && results.length === 0 && !searching && (
            <p className="px-2.5 py-1.5 text-xs text-slate-400">
              Sin resultados (o falta el permiso read_products). Puedes escribir el nombre.
            </p>
          )}
          {results && results.length > 0 && (
            <ul className="max-h-56 overflow-y-auto py-1">
              {results.map((p) => (
                <li key={p.variantId}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(p.title, p.sku ?? null);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-slate-50"
                  >
                    <span className="flex-1 text-sm text-slate-800">{p.title}</span>
                    <span
                      className={cn(
                        "text-xs",
                        (p.inventory ?? 0) > 0 ? "text-slate-400" : "text-amber-600",
                      )}
                    >
                      {p.inventory != null ? `stock ${p.inventory}` : ""}
                    </span>
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
  entrada: "text-emerald-700",
  salida_entrega: "text-slate-600",
  salida_merma: "text-rose-600",
  ajuste: "text-sky-700",
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
 * Merma / Ajuste (conteo Fénix). Las salidas por entrega aparecen en el
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
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reload = () =>
    getFenixStockMovements(row.id).then((m) => setMoves(m as KardexMovement[]));
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
    if (!Number.isFinite(n)) {
      setMsg(kind === "ajuste" ? "Ingresa el conteo real de Fénix." : "Ingresa la cantidad.");
      return;
    }
    start(async () => {
      const r = await recordFenixStockMovement({ stockId: row.id, kind, quantity: n, note });
      setMsg(r.error ?? r.notice ?? null);
      if (!r.error) {
        setQty("");
        setNote("");
        await reload();
        onChanged();
      }
    });
  }

  const qtyLabel =
    kind === "ajuste" ? "Conteo real de Fénix" : kind === "salida_merma" ? "Unidades que salieron" : "Unidades que llegaron";

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-slate-900/30 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Movimientos de stock</h2>
            <p className="text-xs text-slate-500 capitalize">
              {row.city} · <span className="normal-case">{row.product}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>

        {canEdit && (
          <div className="mt-3 space-y-2 rounded-xl border border-slate-200 p-3">
            <div className="flex flex-wrap gap-1.5">
              {(["entrada", "salida_merma", "ajuste"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                    kind === k
                      ? "border-brand-200 bg-brand-50 text-brand-700"
                      : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                  )}
                >
                  {STOCK_MOVEMENT_LABEL[k]}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-xs text-slate-400">{qtyLabel}</label>
                <input
                  type="number"
                  min={0}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="w-40 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                />
              </div>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={kind === "salida_merma" ? "Motivo (obligatorio)" : "Nota (opcional)"}
                className="min-w-[10rem] flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
              />
              <button
                onClick={submit}
                disabled={pending}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                Registrar
              </button>
            </div>
            {kind === "ajuste" && (
              <p className="text-[11px] text-slate-400">
                El sistema calcula la diferencia contra el saldo actual y la deja registrada como ajuste.
              </p>
            )}
            {msg && <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-sm text-slate-700">{msg}</p>}
          </div>
        )}

        <p className="mt-4 mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">Historial</p>
        {moves === null ? (
          <p className="text-sm text-slate-400">Cargando…</p>
        ) : moves.length === 0 ? (
          <p className="text-sm text-slate-400">Sin movimientos todavía.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {moves.map((m) => (
              <li key={m.id} className="flex items-baseline gap-2 py-1.5 text-sm">
                <span className={cn("w-40 shrink-0 font-medium", MOVEMENT_TONE[m.kind] ?? "text-slate-600")}>
                  {STOCK_MOVEMENT_LABEL[m.kind]}
                </span>
                <span className={cn("w-12 shrink-0 text-right tabular-nums", m.delta < 0 ? "text-rose-600" : "text-emerald-700")}>
                  {m.delta > 0 ? `+${m.delta}` : m.delta}
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-slate-500">= {m.balance_after}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
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
  );
}
