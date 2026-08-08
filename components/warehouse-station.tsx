"use client";

import Link from "next/link";
import { FormEvent, useCallback, useMemo, useRef, useState } from "react";
import { DispatchCamera } from "@/components/dispatch-camera";
import { cn } from "@/components/ui";
import { markShipmentReady, type DispatchActionResult } from "@/app/dashboard/pedidos/despacho/actions";
import { loadWarehouseStation } from "@/app/dashboard/pedidos/almacen/actions";
import { OPERATION_LABELS } from "@/lib/dispatch-routing";
import {
  buildWarehouseQueue,
  warehousePanels,
  type WarehousePanel,
  type WarehouseQueueEntry,
  type WarehouseQueueGroup,
} from "@/lib/warehouse-queue";
import type {
  DispatchShipment,
  WarehouseShipment,
  WarehouseStationData,
} from "@/lib/dispatch-access";
import type { StoreSummary } from "@/lib/types";

/**
 * La estación de almacén.
 *
 * Vive aparte de la Mesa de despacho a propósito: quien arma cajas no gestiona
 * rutas ni couriers, y la mesa no necesita el escáner de armado para asignar y
 * cotejar. Antes el armado era el paso 1 de una pantalla de cuatro pasos, así
 * que el almacén tenía que entrar por la puerta de despacho y no tenía dónde
 * ver su propia cola: sabía lo que ya había armado, nunca lo que le faltaba.
 */
export function WarehouseStation({
  initialData,
  stores,
}: {
  initialData: WarehouseStationData;
  stores: StoreSummary[];
}) {
  const [data, setData] = useState(initialData);
  const [scan, setScan] = useState("");
  const [query, setQuery] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const storeName = useMemo(() => new Map(stores.map((store) => [store.id, store.name])), [stores]);

  const executeScan = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    setMessage(null);
    const result: DispatchActionResult = await markShipmentReady(value);
    setMessage({ tone: result.error ? "error" : "ok", text: result.error ?? result.notice ?? "Listo." });
    setScan("");
    setData(await loadWarehouseStation());
    setBusy(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [busy]);

  function submitScan(event: FormEvent) {
    event.preventDefault();
    void executeScan(scan);
  }

  const onCameraScan = useCallback((value: string) => {
    void executeScan(value);
  }, [executeScan]);

  const needle = query.trim().toLowerCase();
  const pending = needle ? data.pending.filter((s) => matches(s, needle)) : data.pending;
  const queue = useMemo(() => buildWarehouseQueue(pending), [pending]);
  const blocked = needle ? data.blocked.filter((b) => matches(b.shipment, needle)) : data.blocked;

  // El panel cuenta SIEMPRE la cola entera: buscar una caja concreta no puede
  // bajar el número que el turno tiene que dejar en cero.
  const panels = useMemo(() => warehousePanels(buildWarehouseQueue(data.pending)), [data.pending]);

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 pb-24">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <Link href="/dashboard/pedidos" className="text-xs font-medium text-slate-500 hover:text-slate-900">← Master de Pedidos</Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Almacén</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Escanea el rótulo cuando el pedido esté completo, rotulado y dentro de su caja. Eso lo deja listo para despacho; la ruta se decide después, en la mesa.</p>
        </div>
        <Link href="/dashboard/pedidos/despacho" className="min-h-11 rounded-xl border border-slate-300 px-5 text-sm font-semibold leading-[2.75rem] text-slate-700 hover:bg-slate-50">Mesa de despacho →</Link>
      </header>

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-5 sm:p-7">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">Armar</p>
          <h2 className="mt-1 text-xl font-semibold text-slate-950">Dejar paquete listo</h2>
          <p className="mt-1 text-sm text-slate-500">Sirve el QR, el código de barras del pedido, el código de salida o la guía.</p>

          <form onSubmit={submitScan} className="mt-6 flex flex-col gap-3 sm:flex-row">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Código QR, guía o número de pedido</span>
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl text-slate-400">⌁</span>
              <input
                ref={inputRef}
                autoFocus
                value={scan}
                onChange={(event) => setScan(event.target.value)}
                disabled={busy}
                placeholder="Escanea el rótulo o escribe la guía"
                className="h-14 w-full rounded-2xl border-2 border-slate-200 bg-slate-50 pl-12 pr-4 text-base font-medium outline-none transition focus:border-slate-950 focus:bg-white disabled:opacity-50"
              />
            </label>
            <button type="button" onClick={() => setCameraOpen(true)} disabled={busy} className="h-14 rounded-2xl border border-slate-300 px-5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Abrir cámara</button>
            <button disabled={busy || !scan.trim()} className="h-14 rounded-2xl bg-slate-950 px-7 font-semibold text-white hover:bg-slate-800 disabled:opacity-40">{busy ? "Procesando…" : "Confirmar"}</button>
          </form>
          {message && <div className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", message.tone === "error" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800")}>{message.text}</div>}
        </div>

        <div className="border-b border-slate-200 bg-slate-50/70 p-5 sm:p-7">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="font-semibold text-slate-900">Por empacar</h3>
            <p className="text-xs text-slate-500">Cuenta la cola completa, no lo que filtre el buscador.</p>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {panels.map((panel) => (
              <OperationPanel key={panel.operation} panel={panel} />
            ))}
          </div>
        </div>

        <div className="grid gap-5 p-5 sm:p-7 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-900">Por armar</h3>
                <p className="mt-0.5 text-xs text-slate-500">En el orden de prioridad del almacén: Lima, agencia y al final provincia.</p>
              </div>
              <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">{data.pending.length}</span>
            </div>
            {data.pending.length > 8 && (
              <label className="relative mb-4 block">
                <span className="sr-only">Buscar paquete por armar</span>
                <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">⌕</span>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por código, pedido, cliente o distrito" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-slate-950 focus:bg-white" />
              </label>
            )}
            {queue.groups.length ? (
              <div className="space-y-6">
                {queue.groups.map((group) => (
                  <QueueGroup key={group.operation} group={group} storeName={storeName} />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 py-12 text-center text-sm text-slate-500">
                {needle ? `Nada por armar coincide con «${query.trim()}».` : "No queda nada por armar. Buen trabajo."}
              </div>
            )}
            {data.pendingOmitted > 0 && <p className="mt-3 text-xs text-amber-700">Hay {data.pendingOmitted} salidas más por armar fuera de este corte.</p>}

            {blocked.length > 0 && (
              <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <h4 className="text-sm font-semibold text-slate-900">No se pueden armar · {blocked.length}</h4>
                <p className="mt-1 text-xs text-slate-500">Siguen contadas en el Master porque el pedido sigue vivo, pero esta caja concreta ya no se empaca: necesita una salida nueva o ya salió.</p>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {blocked.slice(0, 12).map(({ shipment, reason }) => (
                    <div key={shipment.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                      <p className="truncate text-sm font-semibold text-slate-900">{packageCode(shipment)}</p>
                      <p className="truncate text-xs text-slate-500">{shipment.order_name} · {reason}</p>
                    </div>
                  ))}
                </div>
                {blocked.length > 12 && <p className="mt-2 text-xs text-slate-400">y {blocked.length - 12} más.</p>}
              </div>
            )}
          </div>

          <div className="xl:border-l xl:border-slate-200 xl:pl-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-semibold text-slate-900">Armados hoy</h3>
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">{data.armedToday.length}</span>
            </div>
            {data.armedToday.length ? (
              <div className="space-y-2">
                {data.armedToday.slice(0, 30).map((shipment) => (
                  <div key={shipment.id} className="rounded-xl border border-slate-200 px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-slate-950">{packageCode(shipment)}</p>
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">{fmtTime(shipment.ready_at)}</span>
                    </div>
                    <p className="truncate text-xs text-slate-500">{shipment.customer_name ?? "Cliente"} · {shipment.district ?? shipment.province ?? "Sin distrito"}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 py-12 text-center text-sm text-slate-500">Escanea un paquete terminado y aparecerá aquí.</div>
            )}
          </div>
        </div>
      </section>

      <DispatchCamera open={cameraOpen} onClose={() => setCameraOpen(false)} onScan={onCameraScan} />
    </div>
  );
}

/**
 * Un recuadro por operación: cuánto falta empacar y qué lo cierra.
 *
 * El cero se dibuja distinto a propósito. Lo que el almacén necesita ver de un
 * vistazo al cerrar el turno es si Lima quedó limpia, y eso no se lee bien en un
 * número más de una lista: se lee en que el recuadro cambie de estado.
 */
function OperationPanel({ panel }: { panel: WarehousePanel }) {
  const done = panel.total === 0;
  return (
    <div
      className={cn(
        "rounded-2xl border p-4",
        done ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={cn("text-sm font-semibold", done ? "text-emerald-900" : "text-slate-700")}>
          {OPERATION_LABELS[panel.operation] ?? panel.operation}
        </p>
        {panel.stalled > 0 && (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
            {panel.stalled} detenidas
          </span>
        )}
      </div>
      <p className={cn("mt-2 text-4xl font-semibold tabular-nums", done ? "text-emerald-700" : "text-slate-950")}>
        {panel.total}
      </p>
      <p className={cn("mt-1 text-xs", done ? "text-emerald-700" : "text-slate-500")}>
        {done ? "En cero. Nada por empacar." : panelHint(panel.closer)}
      </p>
    </div>
  );
}

/** Qué cierra las cajas que quedan, dicho en una línea. */
function panelHint(closer: WarehousePanel["closer"]): string {
  if (closer === "courier") return "Empácalas; las cierra el reporte del courier.";
  if (closer === "mixto") return "Unas las cierra tu escaneo y otras el courier.";
  return "Por empacar y escanear aquí.";
}

const GROUP_LIMIT = 24;

/**
 * Un bloque por operación, en la prioridad de almacén del MOM §6.2.
 *
 * El encabezado dice de una vez cuánto falta y —cuando el grupo no lo cierra el
 * lector— quién lo cierra. Provincia COD sigue apareciendo porque la caja SÍ se
 * empaca aquí; lo que cambia es que ya no se lee como pendiente de escanear.
 */
function QueueGroup({
  group,
  storeName,
}: {
  group: WarehouseQueueGroup<WarehouseShipment>;
  storeName: Map<string, string>;
}) {
  const byCourier = group.waitingOnCourier === group.entries.length;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h4 className="font-semibold text-slate-900">{OPERATION_LABELS[group.operation] ?? group.operation}</h4>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{group.entries.length}</span>
        {byCourier && (
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">Las cierra el courier con su reporte, no tu escaneo</span>
        )}
        {group.stalled > 0 && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">{group.stalled} detenidas</span>
        )}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {group.entries.slice(0, GROUP_LIMIT).map((entry) => (
          <PendingCard key={entry.shipment.id} entry={entry} storeName={storeName} />
        ))}
      </div>
      {group.entries.length > GROUP_LIMIT && (
        <p className="mt-3 text-xs text-slate-400">Se muestran {GROUP_LIMIT} de {group.entries.length}. Usa el buscador para llegar a una concreta.</p>
      )}
    </section>
  );
}

function PendingCard({
  entry,
  storeName,
}: {
  entry: WarehouseQueueEntry<WarehouseShipment>;
  storeName: Map<string, string>;
}) {
  const { shipment, closer, ageDays, stalled } = entry;
  return (
    <div className={cn("rounded-2xl border p-4", stalled ? "border-amber-300 bg-amber-50/40" : "border-slate-200")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-950">{packageCode(shipment)}</p>
          <p className="truncate text-xs text-slate-500">{shipment.order_name} · {storeName.get(shipment.store_id) ?? "Tienda"}</p>
        </div>
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-slate-400">{ageLabel(ageDays)}</span>
      </div>
      <p className="mt-3 truncate text-sm text-slate-700">{shipment.customer_name ?? "Cliente"} · {shipment.district ?? shipment.province ?? "Sin distrito"}</p>
      {shipment.product && <p className="mt-1 truncate text-xs text-slate-400">{shipment.product}</p>}
      {closer === "courier" && (
        <p className="mt-2 text-[11px] text-slate-500">Empácala; sale de la cola cuando {courierLabel(shipment.courier)} la reporte preparada.</p>
      )}
    </div>
  );
}

function ageLabel(days: number): string {
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  return `hace ${days} días`;
}

function courierLabel(courier: string | null): string {
  return courier === "aliclik" ? "Aliclik" : (courier ?? "el courier");
}

function matches(shipment: WarehouseShipment, needle: string): boolean {
  return [
    shipment.output_code,
    shipment.guide_code,
    shipment.order_name,
    shipment.customer_name,
    shipment.district,
    shipment.province,
  ].some((field) => (field ?? "").toLowerCase().includes(needle));
}

function packageCode(shipment: DispatchShipment): string {
  return shipment.output_code ?? shipment.guide_code ?? "Salida sin código";
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
  });
}
