"use client";

// Módulo de Costos (§17). Tres pestañas: costos logísticos, de producto y
// adicionales.
//
// Lo que hay que entender al leer esta pantalla: **nada se edita en su sitio**.
// Registrar una tarifa nueva cierra la anterior y abre otra desde la fecha
// indicada, de modo que los pedidos ya calculados sigan costando lo que
// costaron. Por eso la tabla muestra siempre la vigencia y conserva el histórico.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, cn } from "@/components/ui";
import { COST_CONCEPTS } from "@/lib/costs";
import {
  closeTariff,
  upsertAdditionalCost,
  upsertProductCost,
  upsertTariff,
  type CostsSnapshot,
  type ProductCatalogItem,
} from "@/app/dashboard/costos/actions";
import type { StoreSummary } from "@/lib/types";

type Tab = "logisticos" | "productos" | "adicionales";

const TABS: { key: Tab; label: string }[] = [
  { key: "logisticos", label: "Costos logísticos" },
  { key: "productos", label: "Costos de productos" },
  { key: "adicionales", label: "Costos adicionales" },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtMoney(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? `S/ ${n.toFixed(2)}` : "—";
}

function str(value: unknown): string {
  return typeof value === "string" && value ? value : "—";
}

/** Una tarifa sin fecha final es la que rige hoy. */
function ValidityCell({ from, to }: { from: unknown; to: unknown }) {
  const open = !to;
  return (
    <span className={cn("text-xs", open ? "font-medium text-emerald-700" : "text-slate-500")}>
      {String(from)} → {open ? "vigente" : String(to)}
    </span>
  );
}

export function CostsBoard({
  orgId,
  stores,
  costs,
  canEdit,
}: {
  orgId: string;
  stores: StoreSummary[];
  costs: CostsSnapshot;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("logisticos");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ error?: string; notice?: string }>) {
    startTransition(async () => {
      const res = await action();
      setError(res.error ?? null);
      setNotice(res.notice ?? null);
      if (!res.error) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Costos</h1>
        <p className="text-xs text-slate-500">
          Cada tarifa tiene fecha de inicio de vigencia: al cambiarla se cierra la anterior y se
          abre una nueva, para que los cálculos históricos no se muevan.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition",
              t.key === tab ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
      )}
      {!canEdit && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          Solo lectura: tu rol no permite modificar los costos.
        </p>
      )}

      {tab === "logisticos" && (
        <LogisticsTab
          orgId={orgId}
          stores={stores}
          rows={costs.tariffs}
          canEdit={canEdit}
          pending={pending}
          onSubmit={(input) => run(() => upsertTariff(input))}
          onClose={(id, date) => run(() => closeTariff(orgId, id, date))}
        />
      )}
      {tab === "productos" && (
        <ProductsTab
          orgId={orgId}
          stores={stores}
          rows={costs.productCosts}
          catalog={costs.productCatalog}
          canEdit={canEdit}
          pending={pending}
          onSubmit={(input) => run(() => upsertProductCost(input))}
        />
      )}
      {tab === "adicionales" && (
        <AdditionalTab
          orgId={orgId}
          stores={stores}
          rows={costs.additionalCosts}
          canEdit={canEdit}
          pending={pending}
          onSubmit={(input) => run(() => upsertAdditionalCost(input))}
        />
      )}
    </div>
  );
}

function StoreSelect({
  stores,
  value,
  onChange,
}: {
  stores: StoreSummary[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
    >
      <option value="">Todas las tiendas</option>
      {stores.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

function LogisticsTab({
  orgId,
  stores,
  rows,
  canEdit,
  pending,
  onSubmit,
  onClose,
}: {
  orgId: string;
  stores: StoreSummary[];
  rows: Record<string, unknown>[];
  canEdit: boolean;
  pending: boolean;
  onSubmit: (input: Parameters<typeof upsertTariff>[0]) => void;
  onClose: (id: string, date: string) => void;
}) {
  const [concept, setConcept] = useState(COST_CONCEPTS[0]!.code as string);
  const [storeId, setStoreId] = useState("");
  const [courier, setCourier] = useState("");
  const [region, setRegion] = useState("");
  const [province, setProvince] = useState("");
  const [district, setDistrict] = useState("");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(today());

  const storeName = useMemo(() => {
    const map = new Map(stores.map((s) => [s.id, s.name]));
    return (id: unknown) => (typeof id === "string" ? (map.get(id) ?? "—") : "Todas");
  }, [stores]);

  return (
    <div className="space-y-4">
      {canEdit && (
        <Card className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Registrar tarifa
          </p>
          <p className="text-xs text-slate-500">
            El ámbito más específico gana: distrito &gt; provincia &gt; región &gt; courier &gt;
            tienda. Deja en blanco lo que no quieras acotar.
          </p>
          <div className="flex flex-wrap gap-2">
            <select
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            >
              {COST_CONCEPTS.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <StoreSelect stores={stores} value={storeId} onChange={setStoreId} />
            <input
              value={courier}
              onChange={(e) => setCourier(e.target.value)}
              placeholder="Courier"
              className="w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="Región"
              className="w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <input
              value={province}
              onChange={(e) => setProvince(e.target.value)}
              placeholder="Provincia"
              className="w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <input
              value={district}
              onChange={(e) => setDistrict(e.target.value)}
              placeholder="Distrito"
              className="w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="Importe"
              className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <button
              disabled={pending || !amount.trim()}
              onClick={() =>
                onSubmit({
                  orgId,
                  storeId: storeId || null,
                  courier,
                  region,
                  province,
                  district,
                  concept,
                  amount,
                  effectiveFrom: from,
                })
              }
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Registrar
            </button>
          </div>
        </Card>
      )}

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-4 py-2 font-medium">Concepto</th>
                <th className="px-2 py-2 font-medium">Tienda</th>
                <th className="px-2 py-2 font-medium">Courier</th>
                <th className="px-2 py-2 font-medium">Región</th>
                <th className="px-2 py-2 font-medium">Provincia</th>
                <th className="px-2 py-2 font-medium">Distrito</th>
                <th className="px-2 py-2 text-right font-medium">Importe</th>
                <th className="px-2 py-2 font-medium">Vigencia</th>
                {canEdit && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5 text-slate-800">
                    {COST_CONCEPTS.find((c) => c.code === r.concept)?.label ?? String(r.concept)}
                  </td>
                  <td className="px-2 py-2.5 text-slate-600">{storeName(r.store_id)}</td>
                  <td className="px-2 py-2.5 capitalize text-slate-600">{str(r.courier)}</td>
                  <td className="px-2 py-2.5 text-slate-600">{str(r.region)}</td>
                  <td className="px-2 py-2.5 text-slate-600">{str(r.province)}</td>
                  <td className="px-2 py-2.5 text-slate-600">{str(r.district)}</td>
                  <td className="px-2 py-2.5 text-right text-slate-800">{fmtMoney(r.amount)}</td>
                  <td className="px-2 py-2.5">
                    <ValidityCell from={r.effective_from} to={r.effective_to} />
                  </td>
                  {canEdit && (
                    <td className="px-4 py-2.5 text-right">
                      {!r.effective_to && (
                        <button
                          disabled={pending}
                          onClick={() => onClose(String(r.id), today())}
                          className="text-xs text-slate-500 hover:underline"
                        >
                          Cerrar hoy
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-sm text-slate-400">
                    Todavía no hay tarifas configuradas. Sin ellas, el Master muestra el costo en
                    blanco en vez de suponer cero.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ProductCatalogCombobox({
  catalog,
  storeId,
  selectedKey,
  onSelect,
}: {
  catalog: ProductCatalogItem[];
  storeId: string;
  selectedKey: string;
  onSelect: (product: ProductCatalogItem | null) => void;
}) {
  const selected = catalog.find((item) => item.key === selectedKey) ?? null;
  const [query, setQuery] = useState(selected?.title ?? "");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) setQuery(selected.title);
  }, [selected?.key, selected?.title]);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog
      .filter((item) => !storeId || item.storeIds.includes(storeId))
      .filter(
        (item) =>
          !needle ||
          item.title.toLowerCase().includes(needle) ||
          item.sku?.toLowerCase().includes(needle) ||
          item.storeNames.some((name) => name.toLowerCase().includes(needle)),
      )
      .slice(0, 80);
  }, [catalog, query, storeId]);

  return (
    <div ref={boxRef} className="relative min-w-[320px] flex-1">
      <div
        className={cn(
          "flex items-center rounded-lg border bg-white",
          selected ? "border-emerald-300 ring-1 ring-emerald-100" : "border-slate-200",
        )}
      >
        <input
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            onSelect(null);
            setOpen(true);
          }}
          placeholder="Buscar producto, variante o SKU…"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm outline-none"
        />
        {selected && (
          <button
            type="button"
            onClick={() => {
              onSelect(null);
              setQuery("");
              setOpen(true);
            }}
            className="px-3 text-xs text-slate-500 hover:text-slate-800"
          >
            Cambiar
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-100 px-3 py-2 text-[11px] text-slate-500">
            Selecciona una variante existente. Escribir solo filtra el catálogo.
          </div>
          {catalog.length === 0 ? (
            <p className="px-3 py-4 text-sm text-amber-700">
              No se pudo cargar el catálogo de Shopify.
            </p>
          ) : options.length === 0 ? (
            <p className="px-3 py-4 text-sm text-slate-500">
              No existe una variante del catálogo con esa búsqueda.
            </p>
          ) : (
            <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
              {options.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(item);
                      setQuery(item.title);
                      setOpen(false);
                    }}
                    className="flex w-full items-start justify-between gap-4 px-3 py-2 text-left hover:bg-slate-50"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800">{item.title}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {item.sku ? `SKU ${item.sku}` : "Sin SKU en Shopify"}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {item.storeNames.join(" · ")}
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

function ProductsTab({
  orgId,
  stores,
  rows,
  catalog,
  canEdit,
  pending,
  onSubmit,
}: {
  orgId: string;
  stores: StoreSummary[];
  rows: Record<string, unknown>[];
  catalog: ProductCatalogItem[];
  canEdit: boolean;
  pending: boolean;
  onSubmit: (input: Parameters<typeof upsertProductCost>[0]) => void;
}) {
  const [selectedKey, setSelectedKey] = useState("");
  const [supplier, setSupplier] = useState("");
  const [batch, setBatch] = useState("");
  const [storeId, setStoreId] = useState("");
  const [cost, setCost] = useState("");
  const [from, setFrom] = useState(today());
  const selectedProduct = catalog.find((item) => item.key === selectedKey) ?? null;

  useEffect(() => {
    if (selectedProduct && storeId && !selectedProduct.storeIds.includes(storeId)) {
      setSelectedKey("");
    }
  }, [selectedProduct, storeId]);

  const missingProducts = useMemo(() => {
    const now = today();
    const activeRows = rows.filter((row) => {
      const fromDate = String(row.effective_from ?? "");
      const toDate = row.effective_to ? String(row.effective_to) : null;
      return fromDate <= now && (!toDate || toDate >= now);
    });
    const generalSkus = new Set(
      activeRows
        .filter((row) => !row.store_id)
        .map((row) => String(row.sku ?? "").trim().toLowerCase())
        .filter(Boolean),
    );
    const storeSkus = new Set(
      activeRows
        .filter((row) => row.store_id)
        .map(
          (row) =>
            `${String(row.store_id)}:${String(row.sku ?? "").trim().toLowerCase()}`,
        ),
    );

    return catalog
      .map((item) => {
        if (!item.sku) {
          return { item, missingStores: item.storeNames, missingSku: true };
        }
        const sku = item.sku.toLowerCase();
        if (generalSkus.has(sku)) return null;
        const missingStores = item.storeIds
          .map((id, index) => ({ id, name: item.storeNames[index] ?? id }))
          .filter(({ id }) => !storeSkus.has(`${id}:${sku}`))
          .map(({ name }) => name);
        return missingStores.length
          ? { item, missingStores, missingSku: false }
          : null;
      })
      .filter(
        (
          value,
        ): value is {
          item: ProductCatalogItem;
          missingStores: string[];
          missingSku: boolean;
        } => Boolean(value),
      );
  }, [catalog, rows]);

  return (
    <div className="space-y-4">
      <Card className="border-amber-200 bg-amber-50/40">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Productos pendientes de costeo</p>
            <p className="mt-0.5 text-xs text-slate-600">
              Se compara cada variante activa de Shopify con los costos vigentes.
            </p>
          </div>
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-semibold",
              missingProducts.length
                ? "bg-amber-100 text-amber-800"
                : "bg-emerald-100 text-emerald-700",
            )}
          >
            {missingProducts.length} sin costeo completo
          </span>
        </div>
        {catalog.length === 0 ? (
          <p className="mt-3 rounded-lg bg-white px-3 py-3 text-sm text-amber-700">
            No se pudo leer el catálogo de Aurela y Kenku Perú. Revisa la conexión y el permiso
            <code className="mx-1 rounded bg-amber-100 px-1">read_products</code>.
          </p>
        ) : missingProducts.length === 0 ? (
          <p className="mt-3 text-sm text-emerald-700">
            Todas las variantes con SKU tienen un costo vigente para sus tiendas.
          </p>
        ) : (
          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-amber-100 bg-white">
            {missingProducts.map(({ item, missingStores, missingSku }) => (
              <button
                key={item.key}
                type="button"
                disabled={missingSku || !canEdit}
                onClick={() => {
                  setSelectedKey(item.key);
                  if (missingStores.length === 1) {
                    const index = item.storeNames.indexOf(missingStores[0]!);
                    setStoreId(index >= 0 ? item.storeIds[index]! : "");
                  }
                }}
                className="flex w-full items-center justify-between gap-4 border-b border-slate-100 px-3 py-2 text-left last:border-0 hover:bg-amber-50 disabled:cursor-default disabled:hover:bg-white"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-800">
                    {item.title}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {item.sku ? `SKU ${item.sku}` : "Sin SKU en Shopify"}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs text-amber-700">
                  {missingSku ? "Completar SKU" : `Falta: ${missingStores.join(", ")}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {canEdit && (
        <Card className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Registrar costo de producto
          </p>
          <p className="text-xs text-slate-500">
            El producto debe existir en Shopify. Escribe para buscar y luego selecciónalo del
            desplegable.
          </p>
          <div className="flex flex-wrap gap-2">
            <ProductCatalogCombobox
              key={storeId}
              catalog={catalog}
              storeId={storeId}
              selectedKey={selectedKey}
              onSelect={(product) => setSelectedKey(product?.key ?? "")}
            />
            <input
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              placeholder="Proveedor"
              className="w-36 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <input
              value={batch}
              onChange={(e) => setBatch(e.target.value)}
              placeholder="Lote"
              className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <StoreSelect stores={stores} value={storeId} onChange={setStoreId} />
            <input
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              inputMode="decimal"
              placeholder="Costo unitario"
              className="w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <button
              disabled={pending || !selectedProduct?.sku || !cost.trim()}
              onClick={() =>
                onSubmit({
                  orgId,
                  storeId: storeId || null,
                  sku: selectedProduct?.sku ?? "",
                  productName: selectedProduct?.title ?? "",
                  supplier,
                  batch,
                  unitCost: cost,
                  effectiveFrom: from,
                })
              }
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Registrar
            </button>
          </div>
          {selectedProduct && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <span className="font-semibold">Seleccionado:</span>
              <span>{selectedProduct.title}</span>
              <span>· SKU {selectedProduct.sku ?? "faltante"}</span>
              <span>· {selectedProduct.storeNames.join(", ")}</span>
            </div>
          )}
        </Card>
      )}

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-4 py-2 font-medium">SKU</th>
                <th className="px-2 py-2 font-medium">Producto</th>
                <th className="px-2 py-2 font-medium">Proveedor</th>
                <th className="px-2 py-2 font-medium">Lote</th>
                <th className="px-2 py-2 text-right font-medium">Costo unitario</th>
                <th className="px-4 py-2 font-medium">Vigencia</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-700">{str(r.sku)}</td>
                  <td className="px-2 py-2.5 text-slate-700">{str(r.product_name)}</td>
                  <td className="px-2 py-2.5 text-slate-600">{str(r.supplier)}</td>
                  <td className="px-2 py-2.5 text-slate-600">{str(r.batch)}</td>
                  <td className="px-2 py-2.5 text-right text-slate-800">{fmtMoney(r.unit_cost)}</td>
                  <td className="px-4 py-2.5">
                    <ValidityCell from={r.effective_from} to={r.effective_to} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-slate-400">
                    Sin costos de producto configurados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function AdditionalTab({
  orgId,
  stores,
  rows,
  canEdit,
  pending,
  onSubmit,
}: {
  orgId: string;
  stores: StoreSummary[];
  rows: Record<string, unknown>[];
  canEdit: boolean;
  pending: boolean;
  onSubmit: (input: Parameters<typeof upsertAdditionalCost>[0]) => void;
}) {
  const [concept, setConcept] = useState("empaque");
  const [amount, setAmount] = useState("");
  const [basis, setBasis] = useState("pedido");
  const [storeId, setStoreId] = useState("");
  const [from, setFrom] = useState(today());

  return (
    <div className="space-y-4">
      {canEdit && (
        <Card className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Registrar costo adicional
          </p>
          <div className="flex flex-wrap gap-2">
            <select
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            >
              <option value="empaque">Empaque</option>
              <option value="materiales">Materiales</option>
              <option value="preparacion">Preparación</option>
              <option value="comision">Comisión</option>
              <option value="otro">Otro</option>
            </select>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="Importe"
              className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <select
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            >
              <option value="pedido">Por pedido (S/)</option>
              <option value="porcentaje">% del total</option>
            </select>
            <StoreSelect stores={stores} value={storeId} onChange={setStoreId} />
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <button
              disabled={pending || !amount.trim()}
              onClick={() =>
                onSubmit({
                  orgId,
                  storeId: storeId || null,
                  concept,
                  amount,
                  basis,
                  effectiveFrom: from,
                })
              }
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Registrar
            </button>
          </div>
        </Card>
      )}

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-4 py-2 font-medium">Concepto</th>
                <th className="px-2 py-2 text-right font-medium">Importe</th>
                <th className="px-2 py-2 font-medium">Base</th>
                <th className="px-4 py-2 font-medium">Vigencia</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5 capitalize text-slate-800">{str(r.concept)}</td>
                  <td className="px-2 py-2.5 text-right text-slate-800">
                    {r.basis === "porcentaje" ? `${Number(r.amount)} %` : fmtMoney(r.amount)}
                  </td>
                  <td className="px-2 py-2.5 text-slate-600">
                    {r.basis === "porcentaje" ? "% del total" : "Por pedido"}
                  </td>
                  <td className="px-4 py-2.5">
                    <ValidityCell from={r.effective_from} to={r.effective_to} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-400">
                    Sin costos adicionales configurados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
