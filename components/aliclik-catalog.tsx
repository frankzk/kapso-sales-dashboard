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

import { useMemo, useState, useTransition } from "react";
import { Card, EmptyState } from "@/components/ui";
import {
  mapSku,
  syncCatalog,
  unmapSku,
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
      return r.title.toLowerCase().includes(q) || r.shopifySku.toLowerCase().includes(q);
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
              key={r.shopifySku}
              row={r}
              options={view.aliclikSkus}
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
  options,
  storeId,
  canManage,
  pending,
  onMap,
  onUnmap,
}: {
  row: CatalogRow;
  options: { ean: string; label: string }[];
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
          <p className="mt-0.5 text-xs text-slate-500">
            SKU Shopify <code className="rounded bg-slate-100 px-1">{row.shopifySku}</code>
          </p>

          {row.ean ? (
            <p className="mt-1 text-xs text-emerald-700">
              ✓ EAN {row.ean}
              {row.aliclikName ? ` · ${row.aliclikName}` : ""}
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
            {row.ean ? (
              <form
                action={(fd) => {
                  fd.set("store_id", storeId);
                  fd.set("shopify_sku", row.shopifySku);
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
                  fd.set("shopify_sku", row.shopifySku);
                  onMap(fd);
                }}
                className="flex items-center gap-2"
              >
                <select
                  name="ean"
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                  className="w-72 rounded-lg border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">Elegir producto de Aliclik…</option>
                  {options.map((o) => (
                    <option key={o.ean} value={o.ean}>
                      {o.label}
                    </option>
                  ))}
                </select>
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
