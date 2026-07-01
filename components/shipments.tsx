"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Card } from "@/components/ui";
import {
  DELIVERY_STATUSES,
  attemptLabel,
  isFenixDistrict,
  labelOf,
  type RerouteDisposition,
} from "@/lib/shipments";
import type { ShipmentCallRow, ShipmentRow, StoreSummary } from "@/lib/types";
import { SHIPMENT_VIEWS, type ShipmentView } from "@/lib/shipments-access";
import {
  claimShipment,
  createFenixGuide,
  loadShipmentDetail,
  registerRerouteCall,
  releaseShipment,
  searchShipments,
  setShipmentStatus,
} from "@/app/dashboard/envios/actions";
import { OrderLinkPicker } from "@/components/order-link-picker";

const CATEGORY_BADGE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700",
  in_route: "bg-violet-50 text-violet-700",
  delivered: "bg-emerald-50 text-emerald-700",
  closed: "bg-slate-100 text-slate-600",
};

const DISPOSITIONS: { key: RerouteDisposition; label: string }[] = [
  { key: "confirma", label: "Cliente confirma (→ En ruta)" },
  { key: "no_contesta", label: "No contesta" },
  { key: "entregado", label: "Entregado (Fenix)" },
  { key: "cancela", label: "Cliente cancela / anula" },
];

/** Human sub-state suffix: "· Intento 3" for pending, "· por Fenix" for entregado. */
function subState(s: { status_category: string; reroute_attempts: number; delivered_source: string | null }): string {
  if (s.status_category === "pending") return ` · ${attemptLabel(s.reroute_attempts)}`;
  if (s.status_category === "delivered" && s.delivered_source)
    return ` · por ${s.delivered_source === "fenix" ? "Fenix" : "Aliclik"}`;
  return "";
}

function StatusBadge({
  category,
  status,
  suffix,
}: {
  category: string;
  status: string;
  suffix?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        CATEGORY_BADGE[category] ?? "bg-slate-100 text-slate-600",
      )}
    >
      {labelOf(status)}
      {suffix}
    </span>
  );
}

const SIN_DISTRITO = "(sin distrito)";

export function ShipmentsBoard({
  stores,
  view,
  counts,
  shipments,
}: {
  stores: StoreSummary[];
  view: ShipmentView;
  counts: Record<ShipmentView, number>;
  shipments: ShipmentRow[];
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);

  // client-side filters over the loaded view. Empty store/district set = "all".
  const [storeFilter, setStoreFilter] = useState<Set<string>>(new Set());
  const [districtFilter, setDistrictFilter] = useState<Set<string>>(new Set());
  const [dateFilter, setDateFilter] = useState(""); // YYYY-MM-DD on next_followup_at
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);

  // global search (across all tabs, server-side)
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ShipmentRow[] | null>(null);
  const [searching, setSearching] = useState(false);

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "—";

  // distinct districts present in this view, for the picker
  const districtOptions = Array.from(
    new Set(shipments.map((s) => s.district || SIN_DISTRITO)),
  ).sort((a, b) => a.localeCompare(b));

  // On view change, default-select the Fenix-served districts present (the
  // "routable" ones) and reset the date filter.
  useEffect(() => {
    const covered = new Set(
      Array.from(new Set(shipments.map((s) => s.district || SIN_DISTRITO))).filter(
        (d) => d !== SIN_DISTRITO && isFenixDistrict(d),
      ),
    );
    setDistrictFilter(covered);
    setDateFilter("");
    setUnmatchedOnly(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // debounced global search
  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchShipments(term);
      if (alive) {
        setResults(r);
        setSearching(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search]);

  const filtered = shipments.filter(
    (s) =>
      (storeFilter.size === 0 || storeFilter.has(s.store_id)) &&
      (districtFilter.size === 0 || districtFilter.has(s.district || SIN_DISTRITO)) &&
      (!dateFilter || (s.next_followup_at ? s.next_followup_at.slice(0, 10) === dateFilter : false)) &&
      (!unmatchedOnly || !s.matched),
  );

  const searchActive = search.trim().length >= 2;

  function go(params: Record<string, string>) {
    const sp = new URLSearchParams({ view, ...params });
    router.push(`/dashboard/envios?${sp.toString()}`);
  }

  function toggleStore(id: string) {
    setStoreFilter((prev) => {
      const next = new Set(prev);
      if (next.size === 0) stores.forEach((s) => next.add(s.id)); // "all" → start from all
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-900">Envíos</h1>
        <div className="flex items-center gap-2">
          {/* global search */}
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
              🔍
            </span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar guía, pedido, guía Fenix, celular…"
              className="w-64 rounded-lg border border-slate-200 py-1.5 pl-8 pr-7 text-sm"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            )}
          </div>
          <a
            href="/dashboard/envios/import"
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Importar reporte
          </a>
          <a
            href="/dashboard/envios/stock"
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Stock Fenix
          </a>
        </div>
      </div>

      {searchActive ? (
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <p className="text-sm font-medium text-slate-800">
              Resultados de búsqueda {results ? `(${results.length})` : ""}
            </p>
            <button onClick={() => setSearch("")} className="text-xs text-slate-500 hover:underline">
              Limpiar búsqueda
            </button>
          </div>
          {searching ? (
            <p className="p-5 text-sm text-slate-400">Buscando…</p>
          ) : results && results.length > 0 ? (
            <ShipmentTable rows={results} stores={stores} storeName={storeName} onOpen={setOpenId} />
          ) : (
            <p className="p-5 text-sm text-slate-400">Sin coincidencias.</p>
          )}
        </Card>
      ) : (
        <>
          {/* tabs */}
          <div className="flex flex-wrap gap-1.5">
            {SHIPMENT_VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => go({ view: v.key })}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  v.key === view ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50",
                )}
              >
                {v.label}
                <span className="ml-1.5 text-xs text-slate-400">{counts[v.key]}</span>
              </button>
            ))}
          </div>

          {/* filters: store chips + district multi-select + programación date */}
          {view !== "revision" && (
            <div className="flex flex-wrap items-center gap-2">
              {stores.length > 1 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-400">Tienda:</span>
                  {stores.map((s) => {
                    const active = storeFilter.size === 0 || storeFilter.has(s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() => toggleStore(s.id)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                          active
                            ? "border-brand-200 bg-brand-50 text-brand-700"
                            : "border-slate-200 bg-white text-slate-400",
                        )}
                      >
                        {s.name}
                      </button>
                    );
                  })}
                </div>
              )}
              {districtOptions.length > 1 && (
                <ChecklistFilter
                  label="Distrito"
                  options={districtOptions}
                  selected={districtFilter}
                  onChange={setDistrictFilter}
                />
              )}
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                Programación:
                <input
                  type="date"
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={unmatchedOnly}
                  onChange={(e) => setUnmatchedOnly(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Solo sin pedido
              </label>
              {(storeFilter.size > 0 || districtFilter.size > 0 || dateFilter || unmatchedOnly) && (
                <button
                  onClick={() => {
                    setStoreFilter(new Set());
                    setDistrictFilter(new Set());
                    setDateFilter("");
                    setUnmatchedOnly(false);
                  }}
                  className="text-xs text-slate-500 hover:underline"
                >
                  Limpiar filtros
                </button>
              )}
              <span className="ml-auto text-xs text-slate-400">
                Mostrando {filtered.length} de {shipments.length}
              </span>
            </div>
          )}

          {view === "revision" ? (
            <Card>
              <p className="text-sm text-slate-500">
                Las filas por revisar se gestionan desde{" "}
                <a className="text-brand-700 underline" href="/dashboard/envios/import">
                  Importar reporte
                </a>
                .
              </p>
            </Card>
          ) : (
            <Card className="p-0">
              {filtered.length === 0 ? (
                <p className="p-5 text-sm text-slate-400">
                  {shipments.length === 0 ? "Sin envíos en esta vista." : "Ningún envío con esos filtros."}
                </p>
              ) : (
                <ShipmentTable rows={filtered} stores={stores} storeName={storeName} onOpen={setOpenId} />
              )}
            </Card>
          )}
        </>
      )}

      {openId && <ShipmentDrawer shipmentId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function ShipmentTable({
  rows,
  stores,
  storeName,
  onOpen,
}: {
  rows: ShipmentRow[];
  stores: StoreSummary[];
  storeName: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-500">
            <th className="px-4 py-2.5 text-left font-medium">Guía</th>
            {stores.length > 1 && <th className="px-4 py-2.5 text-left font-medium">Tienda</th>}
            <th className="px-4 py-2.5 text-left font-medium">Pedido</th>
            <th className="px-4 py-2.5 text-left font-medium">Cliente</th>
            <th className="px-4 py-2.5 text-left font-medium">Distrito / Ciudad</th>
            <th className="px-4 py-2.5 text-left font-medium">Estado</th>
            <th className="px-4 py-2.5 text-right font-medium">Intentos</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s.id}
              onClick={() => onOpen(s.id)}
              className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
            >
              <td className="px-4 py-2.5 font-mono text-xs text-slate-700">
                {s.guide_code}
                {s.courier === "fenix" && (
                  <span className="ml-1 rounded bg-orange-50 px-1 text-[10px] text-orange-700">Fenix</span>
                )}
              </td>
              {stores.length > 1 && (
                <td className="px-4 py-2.5 text-slate-600">{storeName(s.store_id)}</td>
              )}
              <td className="px-4 py-2.5 text-slate-700">
                <OrderNameLabel name={s.order_name} matched={s.matched} />
              </td>
              <td className="px-4 py-2.5 text-slate-700">
                {s.customer_name ?? "—"}
                <span className="block text-xs text-slate-400">{s.customer_phone ?? ""}</span>
              </td>
              <td className="px-4 py-2.5 text-slate-700">
                {s.district ?? "—"}
                <span className="block text-xs capitalize text-slate-400">
                  {s.city ?? ""}
                  {s.fenix_eligible && <span className="ml-1 text-emerald-600">· Fenix ok</span>}
                </span>
              </td>
              <td className="px-4 py-2.5">
                <StatusBadge category={s.status_category} status={s.delivery_status} suffix={subState(s)} />
              </td>
              <td className="px-4 py-2.5 text-right text-slate-600">
                {s.status_category === "pending" ? `${s.reroute_attempts} / 7` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShipmentDrawer({ shipmentId, onClose }: { shipmentId: string; onClose: () => void }) {
  const router = useRouter();
  const [detail, setDetail] = useState<
    { shipment: ShipmentRow; calls: ShipmentCallRow[] } | { error: string } | null
  >(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // form state
  const [disposition, setDisposition] = useState<RerouteDisposition>("confirma");
  const [note, setNote] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [manualStatus, setManualStatus] = useState("");
  const [fenixGuide, setFenixGuide] = useState("");
  const [showOrderPicker, setShowOrderPicker] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    loadShipmentDetail(shipmentId).then((d) => {
      if (alive) setDetail(d);
    });
    return () => {
      alive = false;
    };
  }, [shipmentId, reloadKey]);

  function refresh() {
    setDetail(null);
    setReloadKey((k) => k + 1);
    router.refresh();
  }

  function run(fn: () => Promise<{ error?: string; notice?: string }>) {
    start(async () => {
      const r = await fn();
      setMsg(r.error ?? r.notice ?? null);
      if (!r.error) refresh();
    });
  }

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-slate-900/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {detail && "error" in detail ? (
          <p className="text-sm text-rose-600">{detail.error}</p>
        ) : !detail ? (
          <p className="text-sm text-slate-400">Cargando…</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-mono text-sm text-slate-800">{detail.shipment.guide_code}</p>
                <StatusBadge
                  category={detail.shipment.status_category}
                  status={detail.shipment.delivery_status}
                  suffix={subState(detail.shipment)}
                />
              </div>
              <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-700">
                Cerrar
              </button>
            </div>

            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-xs text-slate-400">Pedido</dt>
                <dd className="text-slate-700">
                  <OrderNameLabel name={detail.shipment.order_name} matched={detail.shipment.matched} />
                </dd>
              </div>
              <Field label="Cliente" value={detail.shipment.customer_name} />
              <Field label="Teléfono" value={detail.shipment.customer_phone} />
              <Field label="Ciudad" value={detail.shipment.city} />
              <Field label="Distrito" value={detail.shipment.district} />
              <Field label="Producto" value={detail.shipment.product} />
              <Field label="Intentos" value={`${detail.shipment.reroute_attempts} / 7`} />
              <Field
                label="Fenix"
                value={detail.shipment.fenix_eligible ? "Elegible" : "No elegible"}
              />
            </dl>

            {msg && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}

            {/* order link — search+link (not just a raw UUID) for any shipment,
                so a wrong auto-match can also be corrected here */}
            <section className="space-y-2 rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-800">Pedido</p>
                {detail.shipment.matched && (
                  <button
                    onClick={() => setShowOrderPicker((v) => !v)}
                    className="text-xs text-brand-700 hover:underline"
                  >
                    {showOrderPicker ? "Cancelar" : "Cambiar"}
                  </button>
                )}
              </div>
              {detail.shipment.matched && !showOrderPicker ? (
                <p className="text-sm text-slate-700">{detail.shipment.order_name ?? "—"}</p>
              ) : (
                <OrderLinkPicker
                  shipmentId={shipmentId}
                  prefill={detail.shipment.order_name}
                  customerPhone={detail.shipment.customer_phone}
                  onLinked={() => {
                    setShowOrderPicker(false);
                    refresh();
                  }}
                />
              )}
            </section>

            {/* claim + re-route call */}
            <section className="space-y-2 rounded-xl border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-800">Registrar llamada (reprogramación)</p>
              <div className="flex gap-2">
                <button
                  onClick={() => run(() => claimShipment(shipmentId))}
                  disabled={pending}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50"
                >
                  Tomar
                </button>
                <button
                  onClick={() => run(() => releaseShipment(shipmentId))}
                  disabled={pending}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50"
                >
                  Liberar
                </button>
              </div>
              <select
                value={disposition}
                onChange={(e) => setDisposition(e.target.value as RerouteDisposition)}
                className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
              >
                {DISPOSITIONS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={nextDate}
                onChange={(e) => setNextDate(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                placeholder="Próximo intento"
              />
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Nota de la llamada…"
                className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                rows={2}
              />
              <button
                onClick={() =>
                  run(() =>
                    registerRerouteCall(shipmentId, {
                      disposition,
                      note,
                      nextFollowupAt: nextDate ? new Date(nextDate).toISOString() : null,
                    }),
                  )
                }
                disabled={pending}
                className="w-full rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
              >
                Registrar llamada
              </button>
            </section>

            {/* Fenix guide */}
            <section className="space-y-2 rounded-xl border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-800">Generar guía Fenix</p>
              {detail.shipment.fenix_shipment_id ? (
                <p className="text-xs text-emerald-700">Ya tiene guía Fenix vinculada.</p>
              ) : (
                <>
                  <input
                    value={fenixGuide}
                    onChange={(e) => setFenixGuide(e.target.value)}
                    placeholder="N° de guía Fenix"
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                  />
                  <button
                    onClick={() => run(() => createFenixGuide(shipmentId, { guideCode: fenixGuide }))}
                    disabled={pending || !fenixGuide.trim()}
                    className="w-full rounded-lg border border-orange-300 bg-orange-50 px-3 py-1.5 text-sm font-medium text-orange-800 hover:bg-orange-100 disabled:opacity-50"
                  >
                    Crear guía Fenix
                  </button>
                </>
              )}
            </section>

            {/* manual status */}
            <section className="space-y-2 rounded-xl border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-800">Cambiar estado (manual)</p>
              <div className="flex gap-2">
                <select
                  value={manualStatus}
                  onChange={(e) => setManualStatus(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                >
                  <option value="">Selecciona…</option>
                  {DELIVERY_STATUSES.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => manualStatus && run(() => setShipmentStatus(shipmentId, manualStatus))}
                  disabled={pending || !manualStatus}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
                >
                  Aplicar
                </button>
              </div>
            </section>

            {/* history */}
            <section className="space-y-2">
              <p className="text-sm font-medium text-slate-800">Historial</p>
              {detail.calls.length === 0 ? (
                <p className="text-xs text-slate-400">Sin registros.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.calls.map((c) => (
                    <li key={c.id} className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      <div className="flex justify-between">
                        <span className="font-medium text-slate-700">
                          {c.kind}
                          {c.new_status ? ` → ${labelOf(c.new_status)}` : ""}
                        </span>
                        <span className="text-slate-400">{c.agent_name ?? ""}</span>
                      </div>
                      {c.note && <p className="mt-0.5">{c.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/** Multi-select city filter: a button + popover checklist with a search box.
 *  Empty selection = no filter (all cities shown). */
function ChecklistFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const term = q.trim().toLowerCase();
  const shown = term ? options.filter((o) => o.toLowerCase().includes(term)) : options;

  function toggle(city: string) {
    const next = new Set(selected);
    if (next.has(city)) next.delete(city);
    else next.add(city);
    onChange(next);
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "rounded-lg border px-2.5 py-1 text-xs font-medium",
          selected.size > 0
            ? "border-brand-200 bg-brand-50 text-brand-700"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
        )}
      >
        {label}{selected.size > 0 ? ` (${selected.size})` : ""} ▾
      </button>
      {open && (
        <div className="absolute left-0 z-10 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Buscar ${label.toLowerCase()}…`}
            className="mb-2 w-full rounded border border-slate-200 px-2 py-1 text-xs"
          />
          {selected.size > 0 && (
            <button
              onClick={() => onChange(new Set())}
              className="mb-1 text-xs text-slate-500 hover:underline"
            >
              Limpiar selección
            </button>
          )}
          <ul className="max-h-60 overflow-y-auto">
            {shown.map((city) => (
              <li key={city}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm capitalize hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={selected.has(city)}
                    onChange={() => toggle(city)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-slate-700">{city}</span>
                </label>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-1.5 py-1 text-xs text-slate-400">Sin coincidencias.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-slate-700">{value || "—"}</dd>
    </div>
  );
}

/** The Aliclik NOTA parse can guess an order reference before it's actually
 *  linked (matched=false) — shown muted + "(candidato)" so it's never
 *  mistaken for a confirmed vínculo, in the table or the drawer. */
function OrderNameLabel({ name, matched }: { name: string | null; matched: boolean }) {
  if (!name) return <span className="text-slate-400">—</span>;
  if (matched) return <>{name}</>;
  return (
    <span
      className="italic text-slate-400"
      title="Referencia detectada en la nota del reporte — aún no vinculada a un pedido real"
    >
      {name} <span className="text-[10px] not-italic">(candidato)</span>
    </span>
  );
}
