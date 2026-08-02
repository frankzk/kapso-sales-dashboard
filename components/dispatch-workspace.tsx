"use client";

import Link from "next/link";
import { FormEvent, useCallback, useMemo, useRef, useState } from "react";
import { DispatchCamera } from "@/components/dispatch-camera";
import { cn } from "@/components/ui";
import { isCourierTbd } from "@/lib/shipment-output";
import { courierKey } from "@/lib/dispatch";
import {
  addShipmentsToManifest,
  cancelDispatchManifest,
  createDispatchManifest,
  handOverToCourier,
  loadDispatchWorkspace,
  markShipmentReady,
  removeManifestItem,
  scanManifestItem,
  type DispatchActionResult,
} from "@/app/dashboard/pedidos/despacho/actions";
import {
  DISPATCH_STATE_LABELS,
  ROUTE_KIND_LABELS,
  activeDispatchItems,
  dispatchProgress,
  needsRiderCheck,
  type DispatchManifestState,
} from "@/lib/dispatch";
import type {
  DispatchManifest,
  DispatchManifestItem,
  DispatchRider,
  DispatchShipment,
  DispatchWorkspaceData,
} from "@/lib/dispatch-access";
import {
  DISPATCH_COURIERS,
  courierLabelFor,
  courierOptionByKey,
  ridersForCourier,
} from "@/lib/couriers/catalog";
import { routeKindForCourier } from "@/lib/dispatch-routing";
import type { StoreSummary } from "@/lib/types";

/**
 * Los cuatro momentos del despacho, en orden (MOM Fase 2).
 *
 * `build` es el que faltaba: antes la ruta se CONSTRUÍA escaneando en el cotejo
 * de oficina, así que no había forma de decidir en la computadora qué va con
 * quién y después verificarlo. Ahora se decide aquí y el cotejo solo confirma.
 */
type Mode = "prepare" | "build" | "office" | "pickup";

/** ¿El paquete ya pasó por el escaneo de almacén? */
function isArmed(shipment: { preparation_state: string } | null | undefined): boolean {
  return shipment?.preparation_state === "listo_despacho";
}

/** En qué paso conviene abrir una ruta según cómo esté. */
function modeForManifest(manifest: DispatchManifest): Mode {
  if (manifest.state === "draft") return "build";
  if (manifest.state === "office_check") return "office";
  return needsRiderCheck(manifest.kind) ? "pickup" : "office";
}

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
  riders,
  canPrepare,
  canManage,
  canPickup,
}: {
  initialData: DispatchWorkspaceData;
  stores: StoreSummary[];
  riders: DispatchRider[];
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
    } else {
      // El cotejo SOLO confirma lo que ya se decidió al armar la ruta. Antes
      // agregaba el paquete en el mismo gesto, así que un escaneo distraído
      // metía una caja ajena a la ruta y la daba por cotejada.
      result = await scanManifestItem(selected.id, value, mode === "office" ? "office" : "pickup");
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
      ready: data.assignableShipments.filter(isArmed).length,
      pending: data.assignableShipments.filter((s) => !isArmed(s)).length,
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
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Primero se asigna la ruta, después se coteja. La custodia cambia solo cuando el motorizado recibe el 100 % — o, si no hay motorizado, cuando se anota quién recoge.</p>
        </div>
        {canManage && (
          <button onClick={() => setShowCreate(true)} className="min-h-11 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800">+ Nueva ruta</button>
        )}
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Armados sin ruta" value={stats.ready} tone="slate" />
        <Metric label="Por armar en almacén" value={stats.pending} tone="amber" />
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
                onClick={() => { setSelectedId(manifest.id); setMode(modeForManifest(manifest)); }}
              />
            )) : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">Aún no hay rutas. Crea una para comenzar.</div>}
          </div>
        </aside>

        <main className="order-1 min-w-0 space-y-4 xl:order-2">
          <div className="grid grid-cols-4 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
            <ModeButton active={mode === "prepare"} disabled={!canPrepare} onClick={() => setMode("prepare")} number="1" label="Armar en almacén" />
            <ModeButton active={mode === "build"} disabled={!canManage} onClick={() => setMode("build")} number="2" label="Asignar a ruta" />
            <ModeButton active={mode === "office"} disabled={!canManage} onClick={() => setMode("office")} number="3" label="Cotejar oficina" />
            <ModeButton active={mode === "pickup"} disabled={!canPickup || (!!selected && !needsRiderCheck(selected.kind))} onClick={() => setMode("pickup")} number="4" label="Recibir" />
          </div>

          <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 p-5 sm:p-7">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">{mode === "prepare" ? "Almacén" : selected ? `${courierLabelFor(selected.courier)} · ${selected.route_label}` : "Selecciona una ruta"}</p>
                  <h2 className="mt-1 text-xl font-semibold text-slate-950">{MODE_TITLES[mode]}</h2>
                  <p className="mt-1 text-sm text-slate-500">{MODE_HINTS[mode]}</p>
                </div>
                {selected && mode !== "prepare" && <StateBadge state={selected.state} />}
              </div>

              {mode !== "build" && (
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
              )}
              {message && <div className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", message.tone === "error" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800")}>{message.text}</div>}
            </div>

            {mode === "prepare" ? (
              <ReadyQueue shipments={data.assignableShipments} storeName={storeName} />
            ) : mode === "build" ? (
              selected ? (
                <BuildRoute
                  manifest={selected}
                  shipments={data.assignableShipments}
                  storeName={storeName}
                  onAdded={async (result) => { showResult(result); await refresh(selected.id); }}
                />
              ) : (
                <div className="p-12 text-center text-sm text-slate-500">Elige una ruta de la lista o crea una nueva.</div>
              )
            ) : selected ? (
              <ManifestDetail manifest={selected} mode={mode} canManage={canManage} onChanged={() => refresh(selected.id)} showResult={showResult} />
            ) : (
              <div className="p-12 text-center text-sm text-slate-500">Elige una ruta de la lista o crea una nueva.</div>
            )}
          </section>
        </main>
      </div>

      <DispatchCamera open={cameraOpen} onClose={() => setCameraOpen(false)} onScan={onCameraScan} />
      {showCreate && <CreateManifestModal riders={riders} onClose={() => setShowCreate(false)} onCreated={async (result) => { showResult(result); if (result.manifestId) { await refresh(result.manifestId); setSelectedId(result.manifestId); setMode("build"); } setShowCreate(false); }} />}
    </div>
  );
}

const MODE_TITLES: Record<Mode, string> = {
  prepare: "Dejar paquete listo",
  build: "Asignar paquetes a la ruta",
  office: "Cotejo de oficina",
  pickup: "Cotejo del motorizado",
};

const MODE_HINTS: Record<Mode, string> = {
  prepare: "Escanea cuando el pedido esté completo, rotulado y dentro de su caja de despacho.",
  build:
    "Decide aquí qué va con quién, sin escanear. Almacén puede seguir armando: el cotejo verificará después que cada caja entró de verdad.",
  office: "Escanea cada paquete que entra en la caja. Solo confirma lo asignado: lo que no esté en la ruta se avisa, no se agrega.",
  pickup: "El propio motorizado escanea cada paquete que recibe. Al llegar al 100 %, la custodia cambia automáticamente.",
};

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
  const rider = needsRiderCheck(manifest.kind);
  // Sin segundo cotejo, el avance de la tarjeta es el de oficina: si no, una
  // entrega a Aliclik se veía siempre en 0 % por esperar un escaneo imposible.
  const completed = manifest.state === "in_custody"
    ? progress.total
    : rider ? progress.pickupChecked : progress.officeChecked;
  const percent = progress.total ? Math.round((completed / progress.total) * 100) : 0;
  // Quién se lleva la caja: es lo primero que se busca al mirar la lista de rutas.
  const who = manifest.received_by ?? manifest.driver_name;
  return <button onClick={onClick} className={cn("w-full rounded-2xl border p-4 text-left transition", active ? "border-slate-950 bg-slate-950 text-white shadow-lg" : "border-slate-200 bg-white hover:border-slate-400")}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className={cn("text-xs font-semibold uppercase tracking-wide", active ? "text-slate-300" : "text-slate-500")}>{courierLabelFor(manifest.courier)}</p><p className="truncate font-semibold">{manifest.route_label}</p></div><span className={cn("text-xs tabular-nums", active ? "text-slate-300" : "text-slate-500")}>{manifest.route_date.slice(5).split("-").reverse().join("/")}</span></div><p className={cn("mt-1 truncate text-xs", active ? "text-slate-300" : "text-slate-500")}>{who ? `${rider ? "Motorizado" : "Recoge"}: ${who}` : rider ? "Motorizado sin asignar" : ROUTE_KIND_LABELS[manifest.kind]}</p><div className={cn("mt-3 h-1.5 overflow-hidden rounded-full", active ? "bg-white/15" : "bg-slate-100")}><div className={cn("h-full rounded-full", active ? "bg-emerald-400" : "bg-slate-950")} style={{ width: `${manifest.state === "in_custody" ? 100 : percent}%` }} /></div><div className={cn("mt-2 flex items-center justify-between text-xs", active ? "text-slate-300" : "text-slate-500")}><span>{DISPATCH_STATE_LABELS[manifest.state]}</span><span>{completed}/{progress.total}</span></div></button>;
}

function ReadyQueue({ shipments, storeName }: { shipments: DispatchShipment[]; storeName: Map<string, string> }) {
  // Esta vista es la del almacén: solo lo que ya escaneó como armado.
  const armed = shipments.filter(isArmed);
  return <div className="p-5 sm:p-7"><div className="mb-4 flex items-center justify-between"><h3 className="font-semibold text-slate-900">Paquetes armados sin ruta</h3><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{armed.length}</span></div>{armed.length ? <div className="grid gap-2 md:grid-cols-2">{armed.slice(0, 24).map((shipment) => <div key={shipment.id} className="rounded-2xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-slate-950">{packageCode(shipment)}</p><p className="text-xs text-slate-500">{shipment.order_name} · {storeName.get(shipment.store_id) ?? "Tienda"}</p></div><span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold uppercase text-slate-600">{shipment.courier}</span></div><p className="mt-3 truncate text-sm text-slate-700">{shipment.customer_name ?? "Cliente"} · {shipment.district ?? shipment.province ?? "Sin distrito"}</p><p className="mt-1 text-xs text-slate-400">Listo {fmtTime(shipment.ready_at)}</p></div>)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 py-12 text-center text-sm text-slate-500">Escanea un paquete terminado y aparecerá aquí.</div>}</div>;
}

/**
 * Asignar paquetes a la ruta sin escanear: el paso 2.
 *
 * Muestra si almacén ya armó cada caja, pero no lo exige — la ruta se planifica
 * antes de que el almacén termine. Lo que sí se marca es el desajuste de
 * courier, porque una salida ya comprometida con otro no puede cambiarse aquí.
 */
function BuildRoute({
  manifest,
  shipments,
  storeName,
  onAdded,
}: {
  manifest: DispatchManifest;
  shipments: DispatchShipment[];
  storeName: Map<string, string>;
  onAdded: (result: DispatchActionResult) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [onlyMatching, setOnlyMatching] = useState(true);

  const matches = useCallback(
    (shipment: DispatchShipment) =>
      isCourierTbd(shipment.courier) ||
      courierKey(shipment.courier) === courierKey(manifest.courier),
    [manifest.courier],
  );
  const visible = useMemo(
    () => (onlyMatching ? shipments.filter(matches) : shipments),
    [shipments, onlyMatching, matches],
  );

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const closed = ["in_custody", "cancelled"].includes(manifest.state);

  return (
    <div className="p-5 sm:p-7">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-slate-900">Paquetes sin ruta</h3>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={onlyMatching} onChange={(e) => setOnlyMatching(e.target.checked)} className="size-4" />
          Solo los que pueden ir con {courierLabelFor(manifest.courier)}
        </label>
      </div>

      {closed ? (
        <div className="rounded-2xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500">Esta ruta ya está cerrada.</div>
      ) : visible.length ? (
        <>
          <div className="grid gap-2 md:grid-cols-2">
            {visible.slice(0, 60).map((shipment) => (
              <label
                key={shipment.id}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition",
                  picked.has(shipment.id) ? "border-slate-950 bg-slate-50" : "border-slate-200 hover:border-slate-400",
                )}
              >
                <input type="checkbox" checked={picked.has(shipment.id)} onChange={() => toggle(shipment.id)} className="mt-1 size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-3">
                    <span className="font-semibold text-slate-950">{packageCode(shipment)}</span>
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold uppercase text-slate-600">
                      {isCourierTbd(shipment.courier) ? "Por definir" : courierLabelFor(shipment.courier)}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-sm text-slate-700">{shipment.customer_name ?? "Cliente"} · {shipment.district ?? shipment.province ?? "Sin distrito"}</span>
                  <span className="mt-1 block text-xs text-slate-400">{shipment.order_name} · {storeName.get(shipment.store_id) ?? "Tienda"}</span>
                  <span className={cn("mt-2 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold", isArmed(shipment) ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800")}>
                    {isArmed(shipment) ? "Armado en almacén" : "Almacén aún no lo escaneó"}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {visible.length > 60 && <p className="mt-3 text-xs text-slate-400">Se muestran 60 de {visible.length}. Asigna estos y vuelve por el resto.</p>}
          <button
            disabled={busy || !picked.size}
            onClick={async () => {
              setBusy(true);
              const result = await addShipmentsToManifest(manifest.id, [...picked]);
              setPicked(new Set());
              await onAdded(result);
              setBusy(false);
            }}
            className="mt-5 h-12 w-full rounded-xl bg-slate-950 font-semibold text-white disabled:opacity-40 sm:w-auto sm:px-8"
          >
            {busy ? "Asignando…" : `Asignar ${picked.size || ""} a la ruta`.trim()}
          </button>
        </>
      ) : (
        <div className="rounded-2xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500">
          No hay paquetes libres {onlyMatching ? `para ${courierLabelFor(manifest.courier)}` : ""}.
        </div>
      )}
    </div>
  );
}

/** Cierre de una entrega al courier: no hay motorizado, hay quien recoge. */
function HandOverPanel({ manifest, onDone }: { manifest: DispatchManifest; onDone: (r: DispatchActionResult) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const progress = dispatchProgress(manifest.items);
  if (!progress.officeComplete) {
    return (
      <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
        Completa el cotejo de oficina ({progress.officeChecked} de {progress.total}) y anota aquí quién recoge.
      </p>
    );
  }
  return (
    <div className="mt-5 rounded-2xl border border-slate-200 p-4">
      <p className="text-sm font-semibold text-slate-900">¿Quién recoge?</p>
      <p className="mt-1 text-xs text-slate-500">
        Esta ruta no tiene motorizado que coteje. El nombre de quien se lleva las cajas es la única prueba de la entrega.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre y DNI de quien recoge" className="h-11 min-w-0 flex-1 rounded-xl border border-slate-200 px-3" />
        <button
          disabled={busy || name.trim().length < 3}
          onClick={async () => { setBusy(true); await onDone(await handOverToCourier(manifest.id, name)); setBusy(false); }}
          className="h-11 rounded-xl bg-slate-950 px-6 font-semibold text-white disabled:opacity-40"
        >
          {busy ? "Cerrando…" : "Entregar al courier"}
        </button>
      </div>
    </div>
  );
}

function ManifestDetail({ manifest, mode, canManage, onChanged, showResult }: { manifest: DispatchManifest; mode: Mode; canManage: boolean; onChanged: () => Promise<void>; showResult: (r: DispatchActionResult) => void }) {
  const active = activeDispatchItems(manifest.items);
  const removed = manifest.items.filter((item) => !!item.removed_at);
  const progress = dispatchProgress(manifest.items);
  const checked = mode === "office" ? progress.officeChecked : progress.pickupChecked;
  return <div className="p-5 sm:p-7"><div className="grid gap-3 sm:grid-cols-[1fr_auto]"><div><div className="flex items-end justify-between text-sm"><span className="font-medium text-slate-700">{mode === "office" ? "Cotejo de oficina" : "Recepción del motorizado"}</span><span className="font-semibold tabular-nums text-slate-950">{checked} de {progress.total}</span></div><div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-100"><div className={cn("h-full rounded-full transition-all", mode === "office" ? "bg-blue-600" : "bg-emerald-600")} style={{ width: `${progress.total ? (checked / progress.total) * 100 : 0}%` }} /></div></div>{manifest.driver_name && <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm"><span className="text-slate-500">{needsRiderCheck(manifest.kind) ? "Motorizado" : "Contacto"}</span><p className="font-semibold text-slate-900">{manifest.driver_name}</p></div>}</div>{!needsRiderCheck(manifest.kind) && manifest.state !== "in_custody" && canManage && <HandOverPanel manifest={manifest} onDone={async (r) => { showResult(r); await onChanged(); }} />}<div className="mt-6 space-y-2">{active.length ? active.map((item) => <PackageRow key={item.id} item={item} mode={mode} canRemove={canManage && manifest.state !== "in_custody"} onRemoved={async (reason) => { showResult(await removeManifestItem(manifest.id, item.shipment_id, reason)); await onChanged(); }} />) : <div className="rounded-2xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-500">Escanea el primer paquete para incorporarlo a esta ruta.</div>}</div>{removed.length > 0 && <details className="mt-5 rounded-2xl bg-slate-50 p-4"><summary className="cursor-pointer text-sm font-medium text-slate-600">Retirados de esta ruta ({removed.length})</summary><div className="mt-3 space-y-2">{removed.map((item) => <div key={item.id} className="flex justify-between gap-3 text-xs text-slate-500"><span>{packageCode(item.shipment)}</span><span>{item.removal_reason}</span></div>)}</div></details>}{canManage && !["in_custody", "cancelled"].includes(manifest.state) && <button onClick={async () => { const reason = window.prompt("Motivo de cancelación de la ruta"); if (!reason) return; showResult(await cancelDispatchManifest(manifest.id, reason)); await onChanged(); }} className="mt-6 text-xs font-medium text-red-600 hover:underline">Cancelar esta ruta</button>}</div>;
}

function PackageRow({ item, mode, canRemove, onRemoved }: { item: DispatchManifestItem; mode: Mode; canRemove: boolean; onRemoved: (reason: string) => Promise<void> }) {
  const checked = mode === "office" ? item.office_checked_at : item.pickup_checked_at;
  return <div className={cn("flex items-center gap-3 rounded-2xl border p-3.5", checked ? "border-emerald-200 bg-emerald-50/60" : "border-slate-200 bg-white")}><span className={cn("grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold", checked ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-400")}>{checked ? "✓" : "·"}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2"><p className="font-semibold text-slate-950">{packageCode(item.shipment)}</p><span className="text-[11px] font-semibold uppercase text-slate-400">{item.shipment?.courier}</span></div><p className="truncate text-xs text-slate-500">{item.shipment?.customer_name ?? "Cliente"} · {item.shipment?.district ?? item.shipment?.province ?? "Sin distrito"}</p></div>{canRemove && <button onClick={async () => { const reason = window.prompt("¿Por qué se retira este paquete de la ruta?"); if (reason) await onRemoved(reason); }} className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Retirar</button>}</div>;
}

function CreateManifestModal({ riders, onClose, onCreated }: { riders: DispatchRider[]; onClose: () => void; onCreated: (result: DispatchActionResult) => void }) {
  const [courierSel, setCourierSel] = useState("");
  const [routeDate, setRouteDate] = useState(todayLima());
  const [routeLabel, setRouteLabel] = useState("");
  const [riderId, setRiderId] = useState("");
  const [busy, setBusy] = useState(false);

  const option = courierSel ? courierOptionByKey(courierSel) : null;
  const riderOptions = useMemo(() => ridersForCourier(riders, option), [riders, option]);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-6">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!option) return;
          setBusy(true);
          onCreated(
            await createDispatchManifest({
              courier: option.value,
              routeDate,
              routeLabel,
              riderId: riderId || undefined,
            }),
          );
          setBusy(false);
        }}
        className="w-full rounded-t-3xl bg-white p-6 shadow-2xl sm:max-w-lg sm:rounded-3xl"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Nueva ruta</h2>
            <p className="text-sm text-slate-500">Una caja o agrupación distinta por courier y ruta.</p>
          </div>
          <button type="button" onClick={onClose} className="grid size-10 place-items-center rounded-full bg-slate-100 text-lg">×</button>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="Courier">
            <select
              required
              value={courierSel}
              onChange={(e) => {
                setCourierSel(e.target.value);
                setRiderId("");
              }}
              className="h-11 w-full rounded-xl border border-slate-200 px-3"
            >
              <option value="">Elige un courier</option>
              {DISPATCH_COURIERS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fecha">
            <input required type="date" value={routeDate} onChange={(e) => setRouteDate(e.target.value)} className="h-11 w-full rounded-xl border border-slate-200 px-3" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Nombre de la ruta">
              <input required value={routeLabel} onChange={(e) => setRouteLabel(e.target.value)} placeholder="Ej. Lima Norte · tarde" className="h-11 w-full rounded-xl border border-slate-200 px-3" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label={option && !needsRiderCheck(routeKindForCourier(option.value)) ? "Contacto del courier (opcional)" : "Motorizado"}>
              <select
                value={riderId}
                onChange={(e) => setRiderId(e.target.value)}
                disabled={!option}
                className="h-11 w-full rounded-xl border border-slate-200 px-3 disabled:bg-slate-50"
              >
                <option value="">Sin asignar</option>
                {riderOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.full_name}
                  </option>
                ))}
              </select>
              {option && riderOptions.length === 0 && (
                <p className="mt-1 text-xs text-slate-400">
                  No hay motorizados de {option.label} registrados. Deja «Sin asignar» o agrégalos en Equipo → Motorizados.
                </p>
              )}
            </Field>
          </div>
        </div>
        {option && (
          <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600">
            {needsRiderCheck(routeKindForCourier(option.value))
              ? "Ruta de reparto: la cierra el cotejo del motorizado, escaneando lo que recibe."
              : "Entrega al courier: no hay motorizado que coteje, así que se cierra anotando quién recoge las cajas."}
          </p>
        )}
        <button disabled={busy || !option} className="mt-6 h-12 w-full rounded-xl bg-slate-950 font-semibold text-white disabled:opacity-50">
          {busy ? "Creando…" : "Crear ruta"}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-600">{label}</span>{children}</label>;
}

