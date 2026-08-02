"use client";

// Módulo de Costos (§17). Tres pestañas: costos logísticos, de producto y
// adicionales.
//
// Lo que hay que entender al leer esta pantalla: **nada se edita en su sitio**.
// Registrar una tarifa nueva cierra la anterior y abre otra desde la fecha
// indicada, de modo que los pedidos ya calculados sigan costando lo que
// costaron. Por eso la tabla muestra siempre la vigencia y conserva el histórico.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, cn } from "@/components/ui";
import { COST_CONCEPTS, buildProductCostViews, type ProductCostRow } from "@/lib/costs";
import {
  closeTariff,
  upsertAdditionalCost,
  upsertProductCost,
  upsertTariff,
  type CostsSnapshot,
  type ShopifyProduct,
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
  products,
  canEdit,
}: {
  orgId: string;
  stores: StoreSummary[];
  costs: CostsSnapshot;
  products: ShopifyProduct[];
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
          products={products}
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

function toProductCostRows(rows: Record<string, unknown>[]): ProductCostRow[] {
  return rows.map((r) => ({
    id: String(r.id),
    store_id: (r.store_id as string | null) ?? null,
    sku: String(r.sku ?? ""),
    product_name: (r.product_name as string | null) ?? null,
    supplier: (r.supplier as string | null) ?? null,
    batch: (r.batch as string | null) ?? null,
    unit_cost: Number(r.unit_cost) || 0,
    effective_from: String(r.effective_from ?? ""),
    effective_to: (r.effective_to as string | null) ?? null,
  }));
}

// Los productos son siempre los de Shopify (Kapta no los crea). Esta pestaña
// lista los SKU vistos en pedidos y permite asignarles un costo con vigencia:
// cada cambio abre un periodo nuevo y cierra el anterior, sin mover el histórico.
function ProductsTab({
  orgId,
  stores,
  rows,
  products,
  canEdit,
  pending,
  onSubmit,
}: {
  orgId: string;
  stores: StoreSummary[];
  rows: Record<string, unknown>[];
  products: ShopifyProduct[];
  canEdit: boolean;
  pending: boolean;
  onSubmit: (input: Parameters<typeof upsertProductCost>[0]) => void;
}) {
  const [storeId, setStoreId] = useState("");
  const [query, setQuery] = useState("");
  const [openSku, setOpenSku] = useState<string | null>(null);

  const costRows = useMemo(() => toProductCostRows(rows), [rows]);
  const views = useMemo(
    () => buildProductCostViews(products, costRows, storeId || null),
    [products, costRows, storeId],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return views;
    return views.filter(
      (v) =>
        v.sku.toLowerCase().includes(q) || (v.productName ?? "").toLowerCase().includes(q),
    );
  }, [views, query]);

  const assigned = views.filter((v) => v.currentCost !== null).length;

  return (
    <div className="space-y-4">
      <Card className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Costos de productos
        </p>
        <p className="text-xs text-slate-500">
          Los productos vienen de Shopify: aquí se les asigna un costo, no se dan de alta. Cada
          cambio marca un punto en el tiempo (abre un periodo nuevo y cierra el anterior), así que
          los pedidos ya calculados conservan su costo.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <StoreSelect stores={stores} value={storeId} onChange={setStoreId} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por SKU o nombre"
            className="w-64 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
          <span className="text-xs text-slate-500">
            {assigned}/{views.length} con costo asignado
          </span>
        </div>
      </Card>

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-4 py-2 font-medium">Producto</th>
                <th className="px-2 py-2 font-medium">SKU</th>
                <th className="px-2 py-2 text-right font-medium">Pedidos</th>
                <th className="px-2 py-2 text-right font-medium">Costo vigente</th>
                <th className="px-4 py-2 text-right font-medium">{canEdit ? "Acción" : ""}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => {
                const isOpen = openSku === v.sku;
                return (
                  <FragmentRow
                    key={v.sku || v.productName || Math.random().toString()}
                    view={v}
                    isOpen={isOpen}
                    canEdit={canEdit}
                    pending={pending}
                    colSpan={5}
                    onToggle={() => setOpenSku(isOpen ? null : v.sku)}
                    onSubmit={(cost, date, supplier, batch) =>
                      onSubmit({
                        orgId,
                        storeId: storeId || null,
                        sku: v.sku,
                        productName: v.productName,
                        supplier: supplier || null,
                        batch: batch || null,
                        unitCost: cost,
                        effectiveFrom: date,
                      })
                    }
                  />
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-400">
                    {products.length === 0
                      ? "Todavía no hay productos en pedidos de Shopify para esta organización."
                      : "Ningún producto coincide con la búsqueda."}
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

function FragmentRow({
  view,
  isOpen,
  canEdit,
  pending,
  colSpan,
  onToggle,
  onSubmit,
}: {
  view: ReturnType<typeof buildProductCostViews>[number];
  isOpen: boolean;
  canEdit: boolean;
  pending: boolean;
  colSpan: number;
  onToggle: () => void;
  onSubmit: (cost: string, date: string, supplier: string, batch: string) => void;
}) {
  return (
    <>
      <tr className="border-b border-slate-100 last:border-0">
        <td className="px-4 py-2.5 text-slate-700">
          {view.productName ?? <span className="text-slate-400">Sin nombre</span>}
          {!view.fromShopify && (
            <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
              fuera de Shopify
            </span>
          )}
        </td>
        <td className="px-2 py-2.5 font-mono text-xs text-slate-600">{view.sku || "—"}</td>
        <td className="px-2 py-2.5 text-right text-slate-500">{view.orderCount || "—"}</td>
        <td className="px-2 py-2.5 text-right">
          {view.currentCost !== null ? (
            <span className="text-slate-800">{fmtMoney(view.currentCost)}</span>
          ) : (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
              sin asignar
            </span>
          )}
        </td>
        <td className="px-4 py-2.5 text-right">
          <button onClick={onToggle} className="text-xs text-brand-700 hover:underline">
            {isOpen ? "Cerrar" : view.history.length ? "Historial / cambiar" : "Asignar costo"}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-slate-50/60">
          <td colSpan={colSpan} className="px-4 py-3">
            <ProductCostEditor
              view={view}
              canEdit={canEdit}
              pending={pending}
              onSubmit={onSubmit}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function ProductCostEditor({
  view,
  canEdit,
  pending,
  onSubmit,
}: {
  view: ReturnType<typeof buildProductCostViews>[number];
  canEdit: boolean;
  pending: boolean;
  onSubmit: (cost: string, date: string, supplier: string, batch: string) => void;
}) {
  const [cost, setCost] = useState("");
  const [date, setDate] = useState(today());
  const [supplier, setSupplier] = useState("");
  const [batch, setBatch] = useState("");

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">
            Costo unitario
            <input
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              inputMode="decimal"
              placeholder="S/ 0.00"
              className="mt-0.5 block w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-500">
            Rige desde
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-0.5 block rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-500">
            Proveedor (opcional)
            <input
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              className="mt-0.5 block w-36 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-slate-500">
            Lote (opcional)
            <input
              value={batch}
              onChange={(e) => setBatch(e.target.value)}
              className="mt-0.5 block w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </label>
          <button
            disabled={pending || !cost.trim()}
            onClick={() => onSubmit(cost, date, supplier, batch)}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Marcar cambio de costo
          </button>
        </div>
      )}

      <div>
        <p className="mb-1 text-xs font-medium text-slate-500">Línea de tiempo</p>
        {view.history.length === 0 ? (
          <p className="text-xs text-slate-400">Sin costos registrados todavía.</p>
        ) : (
          <ul className="space-y-1">
            {view.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-3 text-xs">
                <span className="w-20 text-right font-medium text-slate-800">
                  {fmtMoney(h.unit_cost)}
                </span>
                <ValidityCell from={h.effective_from} to={h.effective_to} />
                {h.supplier && <span className="text-slate-500">· {h.supplier}</span>}
                {h.batch && <span className="text-slate-500">· lote {h.batch}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
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
