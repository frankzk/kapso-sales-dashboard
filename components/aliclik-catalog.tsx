"use client";

// Pantalla de mapeo SKU de Shopify → EAN de Aliclik.
//
// Sin esto no se puede crear ninguna guía, y el mapeo no sale gratis: los SKUs
// de las dos plataformas no tienen relación. El sync empareja por NOMBRE lo que
// puede; esta pantalla es donde una persona resuelve el resto y revisa lo que se
// propuso automáticamente.
//
// La cola de trabajo son los productos SIN mapear, así que salen primero y el
// filtro abre en ellos.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Card, EmptyState } from "@/components/ui";
import {
  mapSku,
  searchAliclikSkus,
  syncCatalog,
  unmapSku,
  type AliclikSkuOption,
  type CatalogRow,
  type CatalogView,
} from "@/app/dashboard/envios/aliclik/actions";

type Filter = "sin_mapear" | "mapeados" | "todos";

export function AliclikCatalog({
  view,
  storeId,
  storeName,
  canManage,
}: {
  view: CatalogView;
  storeId: string;
  storeName: string;
  canManage: boolean;
}) {
  const [filter, setFilter] = useState<Filter>(view.unmapped ? "sin_mapear" : "todos");
  const [search, setSearch] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return view.rows.filter((r) => {
      if (filter === "sin_mapear" && r.ean) return false;
      if (filter === "mapeados" && !r.ean) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        (r.variantTitle ?? "").toLowerCase().includes(q) ||
        (r.shopifySku ?? "").toLowerCase().includes(q)
      );
    });
  }, [view.rows, filter, search]);

  const run = (fd: FormData, fn: typeof mapSku) => {
    setMsg(null);
    startTransition(async () => {
      const res = await fn({}, fd);
      if (res.error) setMsg({ kind: "error", text: res.error });
      else if (res.notice) setMsg({ kind: "ok", text: res.notice });
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Catálogo Aliclik · {storeName}</h1>
          <p className="text-sm text-slate-500">
            {view.mapped} de {view.mapped + view.unmapped} productos asociados ·{" "}
            {view.catalogSize} SKUs en el catálogo de Aliclik
            {view.syncedAt ? ` · sincronizado ${new Date(view.syncedAt).toLocaleString("es-PE")}` : ""}
          </p>
        </div>
        {canManage && (
          <form
            action={(fd) => {
              fd.set("store_id", storeId);
              run(fd, syncCatalog);
            }}
          >
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {pending ? "Sincronizando…" : "Sincronizar catálogo"}
            </button>
          </form>
        )}
      </div>

      {view.unmapped > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-medium">{view.unmapped} producto(s) sin asociar.</span> Un pedido que
          incluya cualquiera de ellos no se puede crear en Aliclik: no sabemos qué producto pedirle.
        </div>
      )}

      {view.missingSku > 0 && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <span className="font-medium">{view.missingSku} producto(s) activo(s) no tienen SKU en Shopify.</span>{" "}
          Ya aparecen en esta pantalla, pero deben recibir un SKU antes de poder asociarlos y crear guías en Aliclik.
        </div>
      )}

      {msg && (
        <p
          className={`rounded-lg border px-3 py-2 text-sm ${
            msg.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-700"
          }`}
        >
          {msg.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(["sin_mapear", "mapeados", "todos"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              filter === f
                ? "bg-brand-700 text-white"
                : "border border-slate-300 text-slate-700 hover:bg-slate-50"
            }`}
          >
            {f === "sin_mapear" ? `Sin asociar (${view.unmapped})` : f === "mapeados" ? `Asociados (${view.mapped})` : "Todos"}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre o SKU"
          className="ml-auto w-64 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Nada que mostrar">
          {view.catalogSize === 0
            ? "El catálogo de Aliclik está vacío. Pulsa «Sincronizar catálogo»."
            : "Ningún producto coincide con el filtro."}
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <CatalogRowCard
              key={r.rowKey}
              row={r}
              storeId={storeId}
              canManage={canManage}
              pending={pending}
              onMap={(fd) => run(fd, mapSku)}
              onUnmap={(fd) => run(fd, unmapSku)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CatalogRowCard({
  row,
  storeId,
  canManage,
  pending,
  onMap,
  onUnmap,
}: {
  row: CatalogRow;
  storeId: string;
  canManage: boolean;
  pending: boolean;
  onMap: (fd: FormData) => void;
  onUnmap: (fd: FormData) => void;
}) {
  const [choice, setChoice] = useState(row.suggestion?.ean ?? "");

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900">{row.title}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-medium uppercase tracking-wide text-slate-400">
              Variante Shopify
            </span>
            <span
              className={`rounded px-1.5 py-0.5 ${
                row.variantTitle
                  ? "bg-sky-50 font-medium text-sky-800"
                  : "bg-slate-100 text-slate-500"
              }`}
            >
              {row.variantTitle ?? "Sin variante"}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            SKU Shopify{" "}
            {row.shopifySku ? (
              <code className="rounded bg-slate-100 px-1">{row.shopifySku}</code>
            ) : (
              <span className="rounded bg-rose-50 px-1.5 py-0.5 font-medium text-rose-700">
                Falta SKU en Shopify
              </span>
            )}
          </p>

          {!row.shopifySku ? (
            <p className="mt-1 text-xs text-rose-700">
              Abre este producto en Shopify, asigna un SKU a la variante y vuelve a sincronizar.
            </p>
          ) : row.ean ? (
            <p className="mt-1 text-xs text-emerald-700">
              ✓ EAN {row.ean}
              {row.aliclikName ? ` · ${row.aliclikName}` : ""}
              {row.aliclikVariant ? ` · Variante Aliclik: ${row.aliclikVariant}` : ""}
              {row.warehouseName ? ` · ${row.warehouseName}` : ""}
              {row.stockVirtual != null ? ` · stock ${row.stockVirtual}` : ""}
              {row.source === "auto" ? (
                <span className="ml-1 text-slate-500">(automático — conviene revisarlo)</span>
              ) : null}
            </p>
          ) : row.suggestion ? (
            <p className="mt-1 text-xs text-amber-700">
              Candidato por nombre: {row.suggestion.name} (EAN {row.suggestion.ean})
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Sin candidato automático: elígelo de la lista.
            </p>
          )}
        </div>

        {canManage && (
          <div className="flex shrink-0 items-center gap-2">
            {!row.shopifySku ? (
              <span className="max-w-xs rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                No se puede asociar sin SKU.
              </span>
            ) : row.ean ? (
              <form
                action={(fd) => {
                  fd.set("store_id", storeId);
                  fd.set("shopify_sku", row.shopifySku!);
                  onUnmap(fd);
                }}
              >
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Desasociar
                </button>
              </form>
            ) : (
              <form
                action={(fd) => {
                  fd.set("store_id", storeId);
                  fd.set("shopify_sku", row.shopifySku!);
                  onMap(fd);
                }}
                className="flex flex-col gap-2"
              >
                <input type="hidden" name="ean" value={choice} />
                <SkuPicker
                  storeId={storeId}
                  value={choice}
                  suggestion={row.suggestion}
                  onPick={setChoice}
                />
                <button
                  type="submit"
                  disabled={pending || !choice}
                  className="rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
                >
                  Asociar
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Buscador de productos de Aliclik.
 *
 * Reemplaza a un `<select>` con miles de opciones. El catálogo pasa de 3.600
 * SKUs: en el móvil ese desplegable abre una lista alfabética interminable por
 * la que hay que desplazarse a ciegas, sin forma de filtrar. Y mandar las 3.600
 * opciones al navegador son cientos de kilobytes por cada carga de la página.
 *
 * Así que la búsqueda ocurre en el SERVIDOR y devuelve como mucho 40
 * resultados. Se escribe, se ve, se elige.
 */
function SkuPicker({
  storeId,
  value,
  suggestion,
  onPick,
}: {
  storeId: string;
  value: string;
  suggestion: { ean: string; name: string } | null;
  onPick: (ean: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<AliclikSkuOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const picked = useRef<AliclikSkuOption | null>(null);

  // Búsqueda con freno: sin esto cada tecla dispara una consulta y las
  // respuestas pueden llegar desordenadas, pintando resultados de una búsqueda
  // vieja sobre la nueva. `cancelled` cierra esa carrera.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      const res = await searchAliclikSkus(storeId, query);
      if (cancelled) return;
      setOptions(res);
      setLoading(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open, storeId]);

  const chosen = picked.current && picked.current.ean === value ? picked.current : null;

  if (value && chosen) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-emerald-900">{chosen.label}</span>
          {chosen.variantLabel ? (
            <span className="block text-xs font-medium text-emerald-800">
              Variante Aliclik: {chosen.variantLabel}
            </span>
          ) : null}
          <span className="text-xs text-emerald-700">
            EAN {chosen.ean}
            {chosen.sku ? ` · SKU ${chosen.sku}` : ""}
            {chosen.warehouseName ? ` · ${chosen.warehouseName}` : ""}
            {chosen.stockVirtual != null ? ` · stock ${chosen.stockVirtual}` : ""}
          </span>
        </span>
        <button
          type="button"
          onClick={() => {
            picked.current = null;
            onPick("");
            setOpen(true);
          }}
          className="shrink-0 text-xs text-emerald-800 underline"
        >
          Cambiar
        </button>
      </div>
    );
  }

  return (
    <div className="w-full sm:w-96">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="Buscar producto de Aliclik por nombre, SKU o EAN…"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />

      {/* El candidato por nombre, a un toque. Es el caso mayoritario cuando lo
          hay, y obligar a buscar lo que ya sabemos sería trabajo de más. */}
      {suggestion && !query ? (
        <button
          type="button"
          onClick={() => {
            picked.current = {
              ean: suggestion.ean,
              label: suggestion.name,
              variantLabel: null,
              sku: null,
              warehouseName: null,
              stockVirtual: null,
            };
            onPick(suggestion.ean);
            setOpen(false);
          }}
          className="mt-1 block w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-left text-xs text-amber-900"
        >
          Usar el candidato por nombre: <span className="font-medium">{suggestion.name}</span>
        </button>
      ) : null}

      {open ? (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white">
          {loading ? (
            <p className="px-3 py-2 text-xs text-slate-500">Buscando…</p>
          ) : options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-500">
              {query ? "Sin resultados. Prueba con menos palabras." : "Escribe para buscar."}
            </p>
          ) : (
            options.map((o) => (
              <button
                key={o.ean}
                type="button"
                onClick={() => {
                  picked.current = o;
                  onPick(o.ean);
                  setOpen(false);
                  setQuery("");
                }}
                className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-slate-50"
              >
                <span className="block truncate text-slate-900">{o.label}</span>
                {o.variantLabel ? (
                  <span className="block text-xs font-medium text-sky-700">
                    Variante Aliclik: {o.variantLabel}
                  </span>
                ) : null}
                <span className="text-xs text-slate-500">
                  EAN {o.ean}
                  {o.sku ? ` · SKU ${o.sku}` : ""}
                  {o.warehouseName ? ` · ${o.warehouseName}` : ""}
                  {o.stockVirtual != null ? ` · stock ${o.stockVirtual}` : ""}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
