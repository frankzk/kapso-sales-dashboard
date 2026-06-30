"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Card } from "@/components/ui";
import {
  DELIVERY_STATUSES,
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
  setShipmentStatus,
} from "@/app/dashboard/envios/actions";

const CATEGORY_BADGE: Record<string, string> = {
  in_transit: "bg-sky-50 text-sky-700",
  delivered: "bg-emerald-50 text-emerald-700",
  failure: "bg-amber-50 text-amber-700",
  rerouting: "bg-violet-50 text-violet-700",
  closed: "bg-slate-100 text-slate-600",
};

const DISPOSITIONS: { key: RerouteDisposition; label: string }[] = [
  { key: "reprograma", label: "Acepta reprogramar" },
  { key: "no_contesta", label: "No contesta" },
  { key: "entregado", label: "Entregado" },
  { key: "rechaza", label: "Rechaza / cancela" },
];

function StatusBadge({ category, status }: { category: string; status: string }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        CATEGORY_BADGE[category] ?? "bg-slate-100 text-slate-600",
      )}
    >
      {labelOf(status)}
    </span>
  );
}

export function ShipmentsBoard({
  stores,
  storeId,
  view,
  counts,
  shipments,
}: {
  stores: StoreSummary[];
  storeId: string;
  view: ShipmentView;
  counts: Record<ShipmentView, number>;
  shipments: ShipmentRow[];
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);

  function go(params: Record<string, string>) {
    const sp = new URLSearchParams({ store: storeId, view, ...params });
    router.push(`/dashboard/envios?${sp.toString()}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-900">Envíos</h1>
        <div className="flex items-center gap-2">
          <select
            value={storeId}
            onChange={(e) => go({ store: e.target.value })}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
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
          {shipments.length === 0 ? (
            <p className="p-5 text-sm text-slate-400">Sin envíos en esta vista.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="px-4 py-2.5 text-left font-medium">Guía</th>
                    <th className="px-4 py-2.5 text-left font-medium">Pedido</th>
                    <th className="px-4 py-2.5 text-left font-medium">Cliente</th>
                    <th className="px-4 py-2.5 text-left font-medium">Ciudad</th>
                    <th className="px-4 py-2.5 text-left font-medium">Estado</th>
                    <th className="px-4 py-2.5 text-right font-medium">Intentos</th>
                  </tr>
                </thead>
                <tbody>
                  {shipments.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => setOpenId(s.id)}
                      className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                    >
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-700">
                        {s.guide_code}
                        {s.courier === "fenix" && (
                          <span className="ml-1 rounded bg-orange-50 px-1 text-[10px] text-orange-700">
                            Fenix
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{s.order_name ?? "—"}</td>
                      <td className="px-4 py-2.5 text-slate-700">
                        {s.customer_name ?? "—"}
                        <span className="block text-xs text-slate-400">{s.customer_phone ?? ""}</span>
                      </td>
                      <td className="px-4 py-2.5 capitalize text-slate-700">
                        {s.city ?? "—"}
                        {s.fenix_eligible && (
                          <span className="ml-1 rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">
                            Fenix ok
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge category={s.status_category} status={s.delivery_status} />
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-600">{s.reroute_attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {openId && <ShipmentDrawer shipmentId={openId} onClose={() => setOpenId(null)} />}
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
  const [disposition, setDisposition] = useState<RerouteDisposition>("reprograma");
  const [note, setNote] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [manualStatus, setManualStatus] = useState("");
  const [fenixGuide, setFenixGuide] = useState("");

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
                />
              </div>
              <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-700">
                Cerrar
              </button>
            </div>

            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Field label="Pedido" value={detail.shipment.order_name} />
              <Field label="Cliente" value={detail.shipment.customer_name} />
              <Field label="Teléfono" value={detail.shipment.customer_phone} />
              <Field label="Ciudad" value={detail.shipment.city} />
              <Field label="Distrito" value={detail.shipment.district} />
              <Field label="Producto" value={detail.shipment.product} />
              <Field
                label="Intentos"
                value={`${detail.shipment.reroute_attempts} / 5`}
              />
              <Field
                label="Fenix"
                value={detail.shipment.fenix_eligible ? "Elegible" : "No elegible"}
              />
            </dl>

            {msg && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}

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

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-slate-700">{value || "—"}</dd>
    </div>
  );
}
