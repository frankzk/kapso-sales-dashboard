"use client";

import Link from "next/link";
import { FormEvent, useCallback, useRef, useState } from "react";
import { DispatchCamera } from "@/components/dispatch-camera";
import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton } from "@/components/ops-ui";
import { IconCamera } from "@/components/icons";
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
        <Link href="/dashboard/pedidos/almacen" className="text-[13px] font-medium text-ink-500 hover:text-ink-900">← Almacén</Link>
        <h1 className="mt-1 text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Devoluciones de Tanders</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-500">
          Escanea el QR de Tanders de cada caja que vuelve al almacén. Lo que Tanders dio por devuelto y nadie escaneó es lo que falta que te devuelvan.
        </p>
      </header>

      <section className="rounded-lg bg-white shadow-control ring-1 ring-line">
        {/* El escaneo es la tarea: el mismo gesto que el armado en Almacén. */}
        <div className="p-4 sm:p-6">
          <h2 className="text-base font-semibold leading-6 text-ink-900">Registrar caja devuelta</h2>
          <p className="mt-0.5 text-[13px] text-ink-600">Sirve el QR de Tanders, el nº de seguimiento (TANDER…) o el nº de pedido.</p>

          <form onSubmit={submitScan} className="mt-4 flex flex-col gap-2 sm:flex-row">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">QR de Tanders, nº de seguimiento o nº de pedido</span>
              <svg aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-ink-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 9v6M11 9v6M14 9v6M17 9v6" /></svg>
              <input
                ref={inputRef}
                autoFocus
                value={scan}
                onChange={(event) => setScan(event.target.value)}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="go"
                placeholder="Escanea el QR de Tanders o escribe TANDER…"
                className="h-12 w-full rounded-md border-0 bg-white pl-11 pr-3 text-base font-medium text-ink-900 shadow-control ring-1 ring-inset ring-line-strong placeholder:font-normal placeholder:text-ink-500 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:bg-wash disabled:text-ink-500"
              />
            </label>
            <OpsButton size="lg" className="h-12" onClick={() => setCameraOpen(true)} disabled={busy}>
              <IconCamera aria-hidden />
              Abrir cámara
            </OpsButton>
            <OpsButton type="submit" variant="primary" size="lg" className="h-12 px-6" disabled={busy || !scan.trim()}>{busy ? "Procesando…" : "Recibir"}</OpsButton>
          </form>
          {message && <Banner tone={message.tone === "error" ? "crit" : "ok"} role={message.tone === "error" ? "alert" : "status"} className="mt-4">{message.text}</Banner>}
        </div>

        {/* El cuadre en una línea de cifras: lo que Tanders dice, lo que llegó
            y lo que falta. «Faltan» se pinta en rojo solo si hay algo que reclamar. */}
        <div className="p-4 shadow-[inset_0_1px_0_var(--color-line)] sm:p-6">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line sm:grid-cols-4">
            <Stat label="Tanders dice que devolvió" value={declaradas} />
            <Stat label="Recibidas en almacén" value={data.recibidas.length} tone="ok" />
            <Stat label="Faltan (te las debe)" value={data.faltan.length} tone={data.faltan.length ? "crit" : undefined} />
            <Stat label="Vienen en camino" value={data.enCamino.length} />
          </dl>
        </div>

        <div className="grid grid-cols-1 shadow-[inset_0_1px_0_var(--color-line)] lg:grid-cols-2">
          <div className="min-w-0 p-4 sm:p-6">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-ink-900">Faltan por llegar</h3>
              <Badge tone={data.faltan.length ? "crit" : "neutral"} className="tabular-nums">{data.faltan.length}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-ink-500">Tanders las dio por devueltas y nadie las ha escaneado. Las más antiguas primero: una caja que no aparece tras días no es un retraso.</p>
            <GuideList rows={data.faltan} empty="Todo lo que Tanders dio por devuelto está en el almacén." when={(r) => r.returned_at} whenLabel="devuelta según Tanders" />
          </div>
          <div className="min-w-0 p-4 shadow-[inset_0_1px_0_var(--color-line)] sm:p-6 lg:shadow-[inset_1px_0_0_var(--color-line)]">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-ink-900">Recibidas</h3>
              <Badge tone={data.recibidas.length ? "ok" : "neutral"} className="tabular-nums">{data.recibidas.length}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-ink-500">Confirmadas por alguien con la caja en la mano.</p>
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

/** Una cifra del cuadre; el tono solo tiñe el número y, si es crítico, la celda. */
function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "crit" }) {
  return (
    <div className={cn("min-w-0 px-4 py-3", tone === "crit" ? "bg-crit-wash" : "bg-white")}>
      <dt className={cn("text-[13px]", tone === "crit" ? "font-medium text-crit-fg" : "text-ink-500")}>{label}</dt>
      <dd className={cn("mt-0.5 text-xl font-semibold leading-7 tabular-nums", tone === "ok" ? "text-ok-fg" : tone === "crit" ? "text-crit-fg" : "text-ink-900")}>{value.toLocaleString("es-PE")}</dd>
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
    return <div className="mt-3 rounded-lg border border-dashed border-line-strong py-8 text-center text-sm text-ink-500">{empty}</div>;
  }
  return (
    <ul className="mt-3 max-h-[28rem] divide-y divide-line overflow-y-auto rounded-lg ring-1 ring-line">
      {rows.map((row) => {
        const days = daysSince(when(row));
        return (
          <li key={row.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
            {/* El pedido y la guía se leen enteros; la antigüedad es la que parte línea. */}
            <div className="shrink-0">
              <p className="text-sm font-semibold tabular-nums text-ink-900">{row.order_name ?? "—"}</p>
              <p className="font-mono text-xs text-ink-500">{row.guide_code}</p>
            </div>
            <span className="min-w-0 pt-0.5 text-right text-xs text-pretty tabular-nums text-ink-500">
              {days == null ? "" : days === 0 ? `${whenLabel} hoy` : `${whenLabel} hace ${days} día${days === 1 ? "" : "s"}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
