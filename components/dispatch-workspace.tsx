"use client";

import Link from "next/link";
import { FormEvent, useCallback, useMemo, useRef, useState } from "react";
import { DispatchCamera } from "@/components/dispatch-camera";
import { cn } from "@/components/ui";
import {
  addShipmentToManifest,
  cancelDispatchManifest,
  createDispatchManifest,
  loadDispatchWorkspace,
  markShipmentReady,
  removeManifestItem,
  scanManifestItem,
  type DispatchActionResult,
} from "@/app/dashboard/pedidos/despacho/actions";
import {
  DISPATCH_STATE_LABELS,
  activeDispatchItems,
  dispatchProgress,
  type DispatchManifestState,
} from "@/lib/dispatch";
import type {
  DispatchManifest,
  DispatchManifestItem,
  DispatchShipment,
  DispatchWorkspaceData,
} from "@/lib/dispatch-access";
import type { StoreSummary } from "@/lib/types";

type Mode = "prepare" | "office" | "pickup";

const STATE_TONE: Record<DispatchManifestState, string> = {
  draft: "bg-slate-100 text-slate-700",
  office_check: "bg-amber-100 text-amber-800",
  ready_for_pickup: "bg-blue-100 text-blue-800",
  pickup_check: "bg-violet-100 text-violet-800",
  in_custody: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-red-100 text-red-700",
};

function todayLima(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function packageCode(shipment: DispatchShipment | null): string {
  return shipment?.output_code ?? shipment?.guide_code ?? "Salida sin código";
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DispatchWorkspace({
  initialData,
  stores,
  canPrepare,
  canManage,
  canPickup,
}: {
  initialData: DispatchWorkspaceData;
  stores: StoreSummary[];
  canPrepare: boolean;
  canManage: boolean;
  canPickup: boolean;
}) {
  const [data, setData] = useState(initialData);
  const defaultMode: Mode = canPrepare ? "prepare" : canManage ? "office" : "pickup";
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialData.manifests.find((manifest) => !["in_custody", "cancelled"].includes(manifest.state))?.id ?? null,
  );
  const [scan, setScan] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => data.manifests.find((manifest) => manifest.id === selectedId) ?? null,
    [data.manifests, selectedId],
  );
  const activeManifests = data.manifests.filter((manifest) => manifest.state !== "cancelled");
  const storeName = useMemo(() => new Map(stores.map((store) => [store.id, store.name])), [stores]);

  async function refresh(preferId?: string) {
    const fresh = await loadDispatchWorkspace();
    setData(fresh);
    if (preferId) setSelectedId(preferId);
  }

  function showResult(result: DispatchActionResult) {
    setMessage({ tone: result.error ? "error" : "ok", text: result.error ?? result.notice ?? "Listo." });
  }

  const executeScan = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    setMessage(null);
    let result: DispatchActionResult;
    if (mode === "prepare") {
      result = await markShipmentReady(value);
    } else if (!selected) {
      result = { error: "Elige una ruta antes de escanear." };
    } else if (mode === "office") {
      const added = await addShipmentToManifest(selected.id, value);
      result = added.error ? added : await scanManifestItem(selected.id, value, "office");
    } else {
      result = await scanManifestItem(selected.id, value, "pickup");
    }
    showResult(result);
    setScan("");
    await refresh(selected?.id);
    setBusy(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [busy, mode, selected]);

  function submitScan(event: FormEvent) {
    event.preventDefault();
    void executeScan(scan);
  }

  const onCameraScan = useCallback((value: string) => {
    void executeScan(value);
  }, [executeScan]);

  const stats = useMemo(() => {
    const active = data.manifests.filter((m) => !["in_custody", "cancelled"].includes(m.state));
    return {
      ready: data.readyShipments.length,
      routes: active.length,
      officeReady: active.filter((m) => m.state === "ready_for_pickup").length,
      transferred: data.manifests.filter((m) => m.state === "in_custody" && m.route_date === todayLima()).length,
    };
  }, [data]);

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 pb-24">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <Link href="/dashboard/pedidos" className="text-xs font-medium text-slate-500 hover:text-slate-900">← Master de Pedidos</Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Mesa de despacho</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Dos cotejos, una sola verdad: la custodia cambia únicamente cuando el motorizado recibe el 100 %.</p>
        </div>
        {canManage && (
          <button onClick={() => setShowCreate(true)} className="min-h-11 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800">+ Nueva ruta</button>
        )}
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Listos sin ruta" value={stats.ready} tone="slate" />
        <Metric label="Rutas abiertas" value={stats.routes} tone="amber" />
        <Metric label="Listas para recojo" value={stats.officeReady} tone="blue" />
        <Metric label="Entregadas hoy" value={stats.transferred} tone="green" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="order-2 space-y-3 xl:order-1">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Rutas recientes</h2>
            <span className="text-xs text-slate-400">{activeManifests.length}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
            {activeManifests.length ? activeManifests.map((manifest) => (
              <ManifestCard
                key={manifest.id}
                manifest={manifest}
                active={selectedId === manifest.id}
                onClick={() => { setSelectedId(manifest.id); setMode(manifest.state === "ready_for_pickup" || manifest.state === "pickup_check" ? "pickup" : "office"); }}
              />
            )) : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">Aún no hay rutas. Crea una para comenzar.</div>}
          </div>
        </aside>

        <main className="order-1 min-w-0 space-y-4 xl:order-2">
          <div className="grid grid-cols-3 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
            <ModeButton active={mode === "prepare"} disabled={!canPrepare} onClick={() => setMode("prepare")} number="1" label="Preparar" />
            <ModeButton active={mode === "office"} disabled={!canManage} onClick={() => setMode("office")} number="2" label="Cotejar ruta" />
            <ModeButton active={mode === "pickup"} disabled={!canPickup} onClick={() => setMode("pickup")} number="3" label="Recibir" />
          </div>

          <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 p-5 sm:p-7">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">{mode === "prepare" ? "Almacén" : selected ? `${selected.courier} · ${selected.route_label}` : "Selecciona una ruta"}</p>
                  <h2 className="mt-1 text-xl font-semibold text-slate-950">{mode === "prepare" ? "Dejar paquete listo" : mode === "office" ? "Cotejo de oficina" : "Cotejo del motorizado"}</h2>
                  <p className="mt-1 text-sm text-slate-500">{mode === "prepare" ? "Escanea cuando el pedido esté completo, rotulado y dentro de su caja de despacho." : mode === "office" ? "Cada escaneo agrega el paquete a la ruta y confirma que está físicamente en la caja correcta." : "El propio motorizado escanea cada paquete que recibe. Al llegar al 100 %, la custodia cambia automáticamente."}</p>
                </div>
                {selected && mode !== "prepare" && <StateBadge state={selected.state} />}
              </div>

              <form onSubmit={submitScan} className="mt-6 flex flex-col gap-3 sm:flex-row">
                <label className="relative min-w-0 flex-1">
                  <span className="sr-only">Código QR o guía</span>
                  <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl text-slate-400">⌁</span>
                  <input
                    ref={inputRef}
                    autoFocus
                    value={scan}
                    onChange={(event) => setScan(event.target.value)}
                    disabled={busy || (mode !== "prepare" && !selected)}
                    placeholder="Escanea QR o escribe la guía"
                    className="h-14 w-full rounded-2xl border-2 border-slate-200 bg-slate-50 pl-12 pr-4 text-base font-medium outline-none transition focus:border-slate-950 focus:bg-white disabled:opacity-50"
                  />
                </label>
                <button type="button" onClick={() => setCameraOpen(true)} disabled={busy || (mode !== "prepare" && !selected)} className="h-14 rounded-2xl border border-slate-300 px-5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Abrir cámara</button>
                <button disabled={busy || !scan.trim() || (mode !== "prepare" && !selected)} className="h-14 rounded-2xl bg-slate-950 px-7 font-semibold text-white hover:bg-slate-800 disabled:opacity-40">{busy ? "Procesando…" : "Confirmar"}</button>
              </form>
              {message && <div className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", message.tone === "error" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800")}>{message.text}</div>}
            </div>

            {mode === "prepare" ? (
              <ReadyQueue shipments={data.readyShipments} storeName={storeName} />
            ) : selected ? (
              <ManifestDetail manifest={selected} mode={mode} canManage={canManage} onChanged={() => refresh(selected.id)} showResult={showResult} />
            ) : (
              <div className="p-12 text-center text-sm text-slate-500">Elige una ruta de la lista o crea una nueva.</div>
            )}
          </section>
        </main>
      </div>

      <DispatchCamera open={cameraOpen} onClose={() => setCameraOpen(false)} onScan={onCameraScan} />
      {showCreate && <CreateManifestModal onClose={() => setShowCreate(false)} onCreated={async (result) => { showResult(result); if (result.manifestId) { await refresh(result.manifestId); setSelectedId(result.manifestId); setMode("office"); } setShowCreate(false); }} />}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "slate" | "amber" | "blue" | "green" }) {
  const tones = { slate: "bg-slate-950", amber: "bg-amber-500", blue: "bg-blue-600", green: "bg-emerald-600" };
  return <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className={cn("mb-4 h-1.5 w-8 rounded-full", tones[tone])} /><p className="text-2xl font-semibold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-xs font-medium text-slate-500">{label}</p></div>;
}

function ModeButton({ active, disabled, onClick, number, label }: { active: boolean; disabled: boolean; onClick: () => void; number: string; label: string }) {
  return <button disabled={disabled} onClick={onClick} className={cn("flex min-h-12 items-center justify-center gap-2 rounded-xl px-2 text-xs font-semibold transition sm:text-sm", active ? "bg-slate-950 text-white shadow-sm" : "text-slate-500 hover:bg-slate-50", disabled && "cursor-not-allowed opacity-30")}><span className={cn("grid size-5 place-items-center rounded-full text-[10px]", active ? "bg-white/20" : "bg-slate-100")}>{number}</span>{label}</button>;
}

function StateBadge({ state }: { state: DispatchManifestState }) {
  return <span className={cn("inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold", STATE_TONE[state])}>{DISPATCH_STATE_LABELS[state]}</span>;
}

function ManifestCard({ manifest, active, onClick }: { manifest: DispatchManifest; active: boolean; onClick: () => void }) {
  const progress = dispatchProgress(manifest.items);
  const completed = manifest.state === "in_custody" ? progress.total : progress.pickupChecked;
  return <button onClick={onClick} className={cn("w-full rounded-2xl border p-4 text-left transition", active ? "border-slate-950 bg-slate-950 text-white shadow-lg" : "border-slate-200 bg-white hover:border-slate-400")}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className={cn("text-xs font-semibold uppercase tracking-wide", active ? "text-slate-300" : "text-slate-500")}>{manifest.courier}</p><p className="truncate font-semibold">{manifest.route_label}</p></div><span className={cn("text-xs tabular-nums", active ? "text-slate-300" : "text-slate-500")}>{manifest.route_date.slice(5).split("-").reverse().join("/")}</span></div><div className={cn("mt-4 h-1.5 overflow-hidden rounded-full", active ? "bg-white/15" : "bg-slate-100")}><div className={cn("h-full rounded-full", active ? "bg-emerald-400" : "bg-slate-950")} style={{ width: `${manifest.state === "in_custody" ? 100 : progress.percent}%` }} /></div><div className={cn("mt-2 flex items-center justify-between text-xs", active ? "text-slate-300" : "text-slate-500")}><span>{DISPATCH_STATE_LABELS[manifest.state]}</span><span>{completed}/{progress.total}</span></div></button>;
}

function ReadyQueue({ shipments, storeName }: { shipments: DispatchShipment[]; storeName: Map<string, string> }) {
  return <div className="p-5 sm:p-7"><div className="mb-4 flex items-center justify-between"><h3 className="font-semibold text-slate-900">Paquetes listos sin ruta</h3><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{shipments.length}</span></div>{shipments.length ? <div className="grid gap-2 md:grid-cols-2">{shipments.slice(0, 24).map((shipment) => <div key={shipment.id} className="rounded-2xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-slate-950">{packageCode(shipment)}</p><p className="text-xs text-slate-500">{shipment.order_name} · {storeName.get(shipment.store_id) ?? "Tienda"}</p></div><span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold uppercase text-slate-600">{shipment.courier}</span></div><p className="mt-3 truncate text-sm text-slate-700">{shipment.customer_name ?? "Cliente"} · {shipment.district ?? shipment.province ?? "Sin distrito"}</p><p className="mt-1 text-xs text-slate-400">Listo {fmtTime(shipment.ready_at)}</p></div>)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 py-12 text-center text-sm text-slate-500">Escanea un paquete terminado y aparecerá aquí.</div>}</div>;
}

function ManifestDetail({ manifest, mode, canManage, onChanged, showResult }: { manifest: DispatchManifest; mode: Mode; canManage: boolean; onChanged: () => Promise<void>; showResult: (r: DispatchActionResult) => void }) {
  const active = activeDispatchItems(manifest.items);
  const removed = manifest.items.filter((item) => !!item.removed_at);
  const progress = dispatchProgress(manifest.items);
  const checked = mode === "office" ? progress.officeChecked : progress.pickupChecked;
  return <div className="p-5 sm:p-7"><div className="grid gap-3 sm:grid-cols-[1fr_auto]"><div><div className="flex items-end justify-between text-sm"><span className="font-medium text-slate-700">{mode === "office" ? "Cotejo de oficina" : "Recepción del motorizado"}</span><span className="font-semibold tabular-nums text-slate-950">{checked} de {progress.total}</span></div><div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-100"><div className={cn("h-full rounded-full transition-all", mode === "office" ? "bg-blue-600" : "bg-emerald-600")} style={{ width: `${progress.total ? (checked / progress.total) * 100 : 0}%` }} /></div></div>{manifest.driver_name && <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm"><span className="text-slate-500">Motorizado</span><p className="font-semibold text-slate-900">{manifest.driver_name}</p></div>}</div><div className="mt-6 space-y-2">{active.length ? active.map((item) => <PackageRow key={item.id} item={item} mode={mode} canRemove={canManage && manifest.state !== "in_custody"} onRemoved={async (reason) => { showResult(await removeManifestItem(manifest.id, item.shipment_id, reason)); await onChanged(); }} />) : <div className="rounded-2xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500">Escanea el primer paquete para incorporarlo a esta ruta.</div>}</div>{removed.length > 0 && <details className="mt-5 rounded-2xl bg-slate-50 p-4"><summary className="cursor-pointer text-sm font-medium text-slate-600">Retirados de esta ruta ({removed.length})</summary><div className="mt-3 space-y-2">{removed.map((item) => <div key={item.id} className="flex justify-between gap-3 text-xs text-slate-500"><span>{packageCode(item.shipment)}</span><span>{item.removal_reason}</span></div>)}</div></details>}{canManage && !["in_custody", "cancelled"].includes(manifest.state) && <button onClick={async () => { const reason = window.prompt("Motivo de cancelación de la ruta"); if (!reason) return; showResult(await cancelDispatchManifest(manifest.id, reason)); await onChanged(); }} className="mt-6 text-xs font-medium text-red-600 hover:underline">Cancelar esta ruta</button>}</div>;
}

function PackageRow({ item, mode, canRemove, onRemoved }: { item: DispatchManifestItem; mode: Mode; canRemove: boolean; onRemoved: (reason: string) => Promise<void> }) {
  const checked = mode === "office" ? item.office_checked_at : item.pickup_checked_at;
  return <div className={cn("flex items-center gap-3 rounded-2xl border p-3.5", checked ? "border-emerald-200 bg-emerald-50/60" : "border-slate-200 bg-white")}><span className={cn("grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold", checked ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-400")}>{checked ? "✓" : "·"}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2"><p className="font-semibold text-slate-950">{packageCode(item.shipment)}</p><span className="text-[11px] font-semibold uppercase text-slate-400">{item.shipment?.courier}</span></div><p className="truncate text-xs text-slate-500">{item.shipment?.customer_name ?? "Cliente"} · {item.shipment?.district ?? item.shipment?.province ?? "Sin distrito"}</p></div>{canRemove && <button onClick={async () => { const reason = window.prompt("¿Por qué se retira este paquete de la ruta?"); if (reason) await onRemoved(reason); }} className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Retirar</button>}</div>;
}

function CreateManifestModal({ onClose, onCreated }: { onClose: () => void; onCreated: (result: DispatchActionResult) => void }) {
  const [courier, setCourier] = useState("");
  const [routeDate, setRouteDate] = useState(todayLima());
  const [routeLabel, setRouteLabel] = useState("");
  const [driverName, setDriverName] = useState("");
  const [busy, setBusy] = useState(false);
  return <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-6"><form onSubmit={async (event) => { event.preventDefault(); setBusy(true); onCreated(await createDispatchManifest({ courier, routeDate, routeLabel, driverName })); setBusy(false); }} className="w-full rounded-t-3xl bg-white p-6 shadow-2xl sm:max-w-lg sm:rounded-3xl"><div className="flex items-center justify-between"><div><h2 className="text-xl font-semibold text-slate-950">Nueva ruta</h2><p className="text-sm text-slate-500">Una caja o agrupación distinta por courier y ruta.</p></div><button type="button" onClick={onClose} className="grid size-10 place-items-center rounded-full bg-slate-100 text-lg">×</button></div><div className="mt-6 grid gap-4 sm:grid-cols-2"><Field label="Courier"><input required value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="Ej. Axel Courier" className="h-11 w-full rounded-xl border border-slate-200 px-3" /></Field><Field label="Fecha"><input required type="date" value={routeDate} onChange={(e) => setRouteDate(e.target.value)} className="h-11 w-full rounded-xl border border-slate-200 px-3" /></Field><div className="sm:col-span-2"><Field label="Nombre de la ruta"><input required value={routeLabel} onChange={(e) => setRouteLabel(e.target.value)} placeholder="Ej. Lima Norte · tarde" className="h-11 w-full rounded-xl border border-slate-200 px-3" /></Field></div><div className="sm:col-span-2"><Field label="Motorizado (opcional)"><input value={driverName} onChange={(e) => setDriverName(e.target.value)} placeholder="Nombre de quien recoge" className="h-11 w-full rounded-xl border border-slate-200 px-3" /></Field></div></div><button disabled={busy} className="mt-6 h-12 w-full rounded-xl bg-slate-950 font-semibold text-white disabled:opacity-50">{busy ? "Creando…" : "Crear ruta"}</button></form></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-600">{label}</span>{children}</label>;
}

