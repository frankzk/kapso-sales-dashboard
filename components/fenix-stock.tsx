"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Card, cn } from "@/components/ui";
import { FENIX_CITIES } from "@/lib/shipments";
import type { FenixStockRowDb, StoreSummary } from "@/lib/types";
import {
  deleteFenixStock,
  recomputeFenixEligibility,
  searchStockProducts,
  upsertFenixStock,
} from "@/app/dashboard/envios/actions";

type ProductResult = Awaited<ReturnType<typeof searchStockProducts>>[number];

export function FenixStockEditor({
  rows,
  canEdit,
  stores,
}: {
  rows: FenixStockRowDb[];
  canEdit: boolean;
  stores: StoreSummary[];
}) {
  const router = useRouter();
  const [storeId, setStoreId] = useState<string>(stores[0]?.id ?? "");
  const [city, setCity] = useState<string>(FENIX_CITIES[0] ?? "cusco");
  const [product, setProduct] = useState("");
  const [sku, setSku] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("0");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

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
            ← Volver a Envíos
          </a>
        </div>
      </div>

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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="px-4 py-2.5 text-left font-medium">Ciudad</th>
                  <th className="px-4 py-2.5 text-left font-medium">Producto</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cantidad</th>
                  {canEdit && <th className="px-4 py-2.5"></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5 capitalize text-slate-700">{r.city}</td>
                    <td className="px-4 py-2.5 text-slate-700">{r.product}</td>
                    <td className="px-4 py-2.5 text-right text-slate-700">{r.quantity}</td>
                    {canEdit && (
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={() => remove(r.id)}
                          disabled={pending}
                          className="text-xs text-rose-600 hover:underline"
                        >
                          Eliminar
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
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
