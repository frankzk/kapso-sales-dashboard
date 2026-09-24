"use client";

import Link from "next/link";
import { FormEvent, useCallback, useRef, useState } from "react";
import { DispatchCamera } from "@/components/dispatch-camera";
import { cn } from "@/components/ui";
import {
  receiveReturnedPackage,
  type DispatchActionResult,
} from "@/app/dashboard/pedidos/despacho/actions";
import { loadReturnsReception } from "@/app/dashboard/pedidos/devoluciones/actions";
import {
  daysSince,
  type ReconciliationBuckets,
  type ReconciliationRow,
} from "@/lib/returns-reception";

/**
 * Recepción de devoluciones de Tanders.
 *
 * La pregunta que contesta: ¿el courier me está devolviendo TODO lo que no
 * entregó? Tanders dice qué devolvió; esta pantalla registra qué llegó de
 * verdad, escaneando su QR —que lleva literalmente el nº de seguimiento—. Lo
 * que el courier dio por devuelto y nadie escaneó es lo que te debe.
 *
 * Mismo gesto que el armado de la estación de almacén, otro contexto (MOM
 * §29.13): la pantalla declara qué significa escanear, el usuario solo escanea.
 */
export function ReturnsReception({ initialData }: { initialData: ReconciliationBuckets }) {
  const [data, setData] = useState(initialData);
  const [scan, setScan] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const executeScan = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    setMessage(null);
    const result: DispatchActionResult = await receiveReturnedPackage(value);
    setMessage({ tone: result.error ? "error" : "ok", text: result.error ?? result.notice ?? "Listo." });
    setScan("");
    setData(await loadReturnsReception());
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

  // El avance cuenta lo que el courier DICE que devolvió: es contra eso contra
  // lo que se cuadra. Lo que aún viene de vuelta no entra en el total.
  const declaradas = data.recibidas.length + data.faltan.length;

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 pb-24">
      <header>
        <Link href="/dashboard/pedidos/almacen" className="text-xs font-medium text-slate-500 hover:text-slate-900">← Almacén</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Devoluciones de Tanders</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          Escanea el QR de Tanders de cada caja que vuelve al almacén. Lo que Tanders dio por devuelto y nadie escaneó es lo que falta que te devuelvan.
        </p>
      </header>

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-5 sm:p-7">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">Recibir</p>
          <h2 className="mt-1 text-xl font-semibold text-slate-950">Registrar caja devuelta</h2>
          <p className="mt-1 text-sm text-slate-500">Sirve el QR de Tanders, el nº de seguimiento (TANDER…) o el nº de pedido.</p>

          <form onSubmit={submitScan} className="mt-6 flex flex-col gap-3 sm:flex-row">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">QR de Tanders, nº de seguimiento o nº de pedido</span>
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl text-slate-400">⌁</span>
              <input
                ref={inputRef}
                autoFocus
                value={scan}
                onChange={(event) => setScan(event.target.value)}
                disabled={busy}
                placeholder="Escanea el QR de Tanders o escribe TANDER…"
                className="h-14 w-full rounded-2xl border-2 border-slate-200 bg-slate-50 pl-12 pr-4 text-base font-medium outline-none transition focus:border-slate-950 focus:bg-white disabled:opacity-50"
              />
            </label>
            <button type="button" onClick={() => setCameraOpen(true)} disabled={busy} className="h-14 rounded-2xl border border-slate-300 px-5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Abrir cámara</button>
            <button disabled={busy || !scan.trim()} className="h-14 rounded-2xl bg-slate-950 px-7 font-semibold text-white hover:bg-slate-800 disabled:opacity-40">{busy ? "Procesando…" : "Recibir"}</button>
          </form>
          {message && <div className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-medium", message.tone === "error" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800")}>{message.text}</div>}
        </div>

        <dl className="grid grid-cols-2 gap-4 border-b border-slate-200 bg-slate-50/70 p-5 sm:grid-cols-4 sm:p-7">
          <Stat label="Tanders dice que devolvió" value={declaradas} />
          <Stat label="Recibidas en almacén" value={data.recibidas.length} tone="text-emerald-700" />
          <Stat label="Faltan (te las debe)" value={data.faltan.length} tone={data.faltan.length ? "text-red-700" : "text-slate-900"} />
          <Stat label="Vienen en camino" value={data.enCamino.length} tone="text-slate-600" />
        </dl>

        <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-2">
          <div>
            <h3 className="font-semibold text-slate-900">Faltan por llegar</h3>
            <p className="mt-0.5 text-xs text-slate-500">Tanders las dio por devueltas y nadie las ha escaneado. Las más antiguas primero: una caja que no aparece tras días no es un retraso.</p>
            <GuideList rows={data.faltan} empty="Todo lo que Tanders dio por devuelto está en el almacén." when={(r) => r.returned_at} whenLabel="devuelta según Tanders" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-900">Recibidas</h3>
            <p className="mt-0.5 text-xs text-slate-500">Confirmadas por alguien con la caja en la mano.</p>
            <GuideList rows={data.recibidas} empty="Todavía no se ha escaneado ninguna devolución." when={(r) => r.received_at} whenLabel="recibida" />
          </div>
        </div>
      </section>

      <DispatchCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onScan={onCameraScan}
        continuous
        progress={{ done: data.recibidas.length, total: declaradas, verb: "Recibidas" }}
        status={message ? { ok: message.tone === "ok", text: message.text } : null}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={cn("text-2xl font-semibold tabular-nums", tone ?? "text-slate-900")}>{value}</dd>
    </div>
  );
}

function GuideList({
  rows,
  empty,
  when,
  whenLabel,
}: {
  rows: ReconciliationRow[];
  empty: string;
  when: (row: ReconciliationRow) => string | null;
  whenLabel: string;
}) {
  if (!rows.length) {
    return <div className="mt-3 rounded-2xl border border-dashed border-slate-300 py-8 text-center text-sm text-slate-500">{empty}</div>;
  }
  return (
    <ul className="mt-3 max-h-[28rem] divide-y divide-slate-100 overflow-y-auto rounded-2xl border border-slate-200">
      {rows.map((row) => {
        const days = daysSince(when(row));
        return (
          <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
            <span className="font-medium text-slate-900">{row.order_name ?? "—"}</span>
            <span className="font-mono text-xs text-slate-500">{row.guide_code}</span>
            <span className="w-full text-xs text-slate-500 sm:w-auto">
              {days == null ? "" : days === 0 ? `${whenLabel} hoy` : `${whenLabel} hace ${days} día${days === 1 ? "" : "s"}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
