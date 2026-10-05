"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { applyUrpiDeliveries, linkUrpiReportRow, resolveUrpiObservation } from "@/app/dashboard/urpi/report-actions";
import { URPI_RESULT_LABEL } from "@/lib/urpi-report";
import type { UrpiBucket, UrpiShipment } from "@/lib/urpi-report-view";

type Props = {
  nav?: ReactNode;
  orgId: string;
  canImport: boolean;
  canApply: boolean;
  days: number;
  lastImport: { created_at: string; filename: string | null; row_count: number; new_count: number; changed_count: number } | null;
  shipments: UrpiShipment[];
};

const field = "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500";
const button = "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const primary = "rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50";
const dateLabel = (value: string | null) => value ? value.split("-").reverse().join("/") : "Sin fecha";
const weekday = (value: string) => new Intl.DateTimeFormat("es-PE", { weekday: "short", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
const timeLabel = (value: string) => new Intl.DateTimeFormat("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }).format(new Date(value));
const money = (value: number) => new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" }).format(value);
const GENERAL_LABEL: Record<string, string> = { pendiente: "Pendiente", en_proceso: "En proceso", entregado: "Entregado", anulado: "Anulado", devuelto: "Devuelto" };
const RESULT_TONE: Record<string, string> = {
  entregado: "text-emerald-700", reprogramado: "text-amber-700", cancelado: "text-red-700", otro: "text-violet-700",
};

const TABS: { key: UrpiBucket; label: string; help: string }[] = [
  { key: "por_aplicar", label: "Entregados por marcar", help: "Urpi los entregó y Kapta todavía no lo sabe. Revisa y márcalos entregados: van al Master por la misma vía que la liquidación, y su salida «Por definir» pasa a ser la salida de Urpi entregada." },
  { key: "cancelado", label: "Cancelados por Urpi", help: "Urpi los canceló y siguen abiertos en Kapta. Seguimiento Lima decide si se llaman, salen con otro courier o vuelven. Kapta no cambia su estado." },
  { key: "reprogramado", label: "Reprogramados", help: "Urpi los reintenta el siguiente día de lunes a sábado desde la fecha del reporte." },
  { key: "por_vincular_entregado", label: "Por vincular – entregados", help: "Urpi los entregó, pero el teléfono no lleva a un único pedido. Elige el pedido o escribe su código: se vincula todo el envío y pasa a «Entregados por marcar»." },
  { key: "por_vincular_otro", label: "Por vincular – otros", help: "Cancelados, reprogramados o en curso cuyo teléfono no lleva a un único pedido. Elige el pedido o escribe su código: se vincula todo el envío." },
  { key: "observacion", label: "Observaciones", help: "Urpi entregó y cobró, pero el pedido está anulado en Shopify o devuelto. No se marca entregado: solo Shopify termina una venta. Si se rehízo el pedido en Shopify, vincúlalo al nuevo; si no, ciérrala con el motivo (queda en la actividad del pedido)." },
  { key: "no_reconocido", label: "Estado no reconocido", help: "Urpi escribió un estado que Kapta no conoce. Se guarda tal cual y no se interpreta." },
  { key: "en_curso", label: "En curso", help: "Programados o en coordinación con Urpi." },
  { key: "al_dia", label: "Al día", help: "Kapta ya los tiene entregados, anulados o devueltos, o la observación se cerró con motivo." },
];

export function UrpiResultsBoard({ nav, orgId, canImport, canApply, days, lastImport, shipments }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const counts = useMemo(() => {
    const map = new Map<UrpiBucket, number>();
    for (const shipment of shipments) map.set(shipment.bucket, (map.get(shipment.bucket) ?? 0) + 1);
    return map;
  }, [shipments]);
  const [tab, setTab] = useState<UrpiBucket>(() => TABS.find((item) => counts.get(item.key))?.key ?? "por_aplicar");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Entregados ya marcados cuya caja sigue «Por definir» (marcados antes de que
  // existiera el relleno): se completan con el mismo botón.
  const salidaPending = useMemo(() => shipments.filter((shipment) => shipment.latest.result_code === "entregado" && shipment.order?.salida_pending).map((shipment) => shipment.order!.order_id), [shipments]);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = pending || uploading;

  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("es");
    return shipments.filter((shipment) => shipment.bucket === tab && (!term || [
      shipment.order?.order_name, shipment.latest.data.recipient, shipment.latest.data.phone, shipment.order?.customer_name,
    ].some((text) => text?.toLocaleLowerCase("es").includes(term))));
  }, [shipments, tab, query]);
  const pageRows = visible.slice(page * 50, (page + 1) * 50);
  const applicable = visible.filter((shipment) => shipment.order).map((shipment) => shipment.order!.order_id);
  const current = TABS.find((item) => item.key === tab)!;

  async function upload(file: File) {
    setUploading(true); setNotice(null);
    try {
      const form = new FormData(); form.set("orgId", orgId); form.set("file", file);
      const res = await fetch("/api/urpi/report/import", { method: "POST", body: form });
      const result = await res.json() as { message?: string; error?: string };
      setNotice({ ok: res.ok, message: result.message ?? result.error ?? "No se pudo procesar el reporte." });
      if (res.ok) router.refresh();
    } catch { setNotice({ ok: false, message: "No se pudo completar la carga. Lo ya guardado se conserva." }); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  function run(action: () => Promise<{ ok: boolean; message: string }>, after?: () => void) {
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      setNotice(result);
      if (result.ok) { after?.(); router.refresh(); }
    });
  }

  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6">
    {nav}
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Couriers externos</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Urpi · Resultados de entrega</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">En Urpi, abre «Reporte del mes – detallado», pulsa <strong>Exportar</strong> y carga aquí el .csv. Kapta vincula cada envío por teléfono y te dice qué falta hacer. Se muestran los intentos de los últimos {days} días.</p>
      </div>
      {canImport && <div className="flex flex-col items-end gap-1">
        <button disabled={busy} className={primary} onClick={() => fileInput.current?.click()}>{uploading ? "Leyendo reporte…" : "Cargar reporte de Urpi"}</button>
        <input ref={fileInput} type="file" accept=".csv,text/csv" className="hidden" aria-label="Reporte de Urpi (.csv)" onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); }} />
        {lastImport && <span className="text-xs text-slate-500">Último reporte: {timeLabel(lastImport.created_at)} · {lastImport.row_count} intentos</span>}
      </div>}
    </header>

    {notice && <div role={notice.ok ? "status" : "alert"} className={`whitespace-pre-line rounded-lg border p-3 text-sm ${notice.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}>{notice.message}</div>}

    {!shipments.length ? <div className="rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center">
      <h2 className="font-semibold text-slate-900">Todavía no hay resultados de Urpi</h2>
      <p className="mt-2 text-sm text-slate-600">{canImport ? "Carga el export de «Reporte del mes – detallado» para empezar." : "Pide a quien gestiona Urpi que cargue su reporte."}</p>
    </div> : <>
      {salidaPending.length > 0 && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <span>{salidaPending.length} pedido(s) entregados por Urpi siguen con su salida «Por definir» pendiente, y la mesa de cierre los ve como «Salida adicional activa».</span>
        {canApply && <button className={button} disabled={busy} onClick={() => run(() => applyUrpiDeliveries(orgId, salidaPending))}>{pending ? "Actualizando…" : "Pasar a salida de Urpi entregada"}</button>}
      </div>}
      <div role="tablist" aria-label="Resultados de Urpi" className="flex flex-wrap gap-2">
        {TABS.filter((item) => counts.get(item.key) || item.key === "por_aplicar").map((item) => <button key={item.key} role="tab" aria-selected={tab === item.key}
          onClick={() => { setTab(item.key); setPage(0); setSelected(new Set()); }}
          className={`rounded-full border px-3 py-1.5 text-sm ${tab === item.key ? "border-brand-600 bg-brand-50 font-semibold text-brand-800" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
          {item.label} <span className="tabular-nums text-slate-500">{counts.get(item.key) ?? 0}</span>
        </button>)}
      </div>
      <p className="text-sm text-slate-600">{current.help}</p>
      <div className="flex flex-wrap items-center gap-3">
        <input className={`${field} min-w-64 flex-1`} placeholder="Buscar pedido, cliente o teléfono" aria-label="Buscar envío de Urpi" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
        {tab === "por_aplicar" && canApply && <>
          <button className={button} disabled={!applicable.length} onClick={() => setSelected(selected.size === applicable.length ? new Set() : new Set(applicable))}>{selected.size === applicable.length && applicable.length ? "Quitar selección" : "Seleccionar todos"}</button>
          <button className={primary} disabled={busy || !selected.size} onClick={() => {
            if (!window.confirm(`¿Marcar ${selected.size} pedido(s) como entregados en el Master según el reporte de Urpi?`)) return;
            run(() => applyUrpiDeliveries(orgId, [...selected]), () => setSelected(new Set()));
          }}>{pending ? "Marcando…" : `Marcar entregados (${selected.size})`}</button>
        </>}
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[1000px] text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>
          {tab === "por_aplicar" && canApply && <th className="w-10 px-4 py-3"><span className="sr-only">Seleccionar</span></th>}
          {["Último intento", "Pedido", "Destinatario", "Resultado de Urpi", COBRO_TABS.has(tab) ? "Cobro" : "Detalle", "En Kapta"].map((title) => <th key={title} className="px-4 py-3 font-medium">{title}</th>)}
        </tr></thead>
          <tbody className="divide-y divide-slate-100">{pageRows.map((shipment) => {
            const { latest, order } = shipment;
            const data = latest.data;
            return <tr key={shipment.key} className="align-top hover:bg-slate-50/60">
              {tab === "por_aplicar" && canApply && <td className="px-4 py-3">{order && <input type="checkbox" aria-label={`Seleccionar ${order.order_name ?? "pedido"}`} checked={selected.has(order.order_id)} onChange={() => toggle(order.order_id)} />}</td>}
              <td className="whitespace-nowrap px-4 py-3"><div>{dateLabel(latest.report_date)}</div>
                {shipment.nextDate && <div className="text-xs text-amber-800">Reintento: {weekday(shipment.nextDate)} {dateLabel(shipment.nextDate)}</div>}
                <div className="text-xs text-slate-500">Fila {latest.urpi_row}</div></td>
              <td className="px-4 py-3">{order
                ? <Link href={`?vista=resultados&ficha=${order.order_id}`} className="font-semibold text-brand-700 hover:underline">{order.order_name ?? "Ver pedido"}</Link>
                : <LinkPicker shipment={shipment} canLink={canImport} busy={busy} code={codes[shipment.key] ?? ""}
                    onCode={(value) => setCodes((prev) => ({ ...prev, [shipment.key]: value }))}
                    onLink={(ref) => run(() => linkUrpiReportRow(orgId, latest.urpi_row, ref))} />}
                {order && latest.link_method && <div className="text-xs text-slate-500">{latest.link_method === "manual" ? "Vinculado a mano" : "Vinculado por teléfono"}</div>}</td>
              <td className="px-4 py-3"><div className="font-medium">{data.recipient ?? "Sin nombre"}</div><div className="text-xs text-slate-500">{data.phone ?? "Sin teléfono válido"}</div></td>
              <td className="max-w-72 px-4 py-3">
                <div className={`font-semibold ${RESULT_TONE[latest.result_code] ?? "text-slate-700"}`}>{latest.result_code === "otro" ? data.resultWritten : URPI_RESULT_LABEL[latest.result_code]}</div>
                {data.reason && <div className="text-xs text-slate-600">{data.reason}</div>}
                <Attempts shipment={shipment} />
              </td>
              <td className="max-w-80 px-4 py-3 text-xs">{COBRO_TABS.has(tab) ? <div className="space-y-0.5">
                  <div>{data.paymentMethod ?? "Sin método"}{data.amountCollected !== null ? ` · ${money(data.amountCollected)}` : ""}</div>
                  {data.serviceFee !== null && <div className="text-slate-500">Servicio Urpi: {money(data.serviceFee)}</div>}
                  {shipment.amountGap !== null && Math.abs(shipment.amountGap) > 0.5 && <div className="text-amber-800">Total en Kapta {money(order?.order_total ?? 0)} · diferencia {shipment.amountGap > 0 ? "+" : "−"}{money(Math.abs(shipment.amountGap))}</div>}
                  <Evidence urls={data.evidence} />
                </div>
                : <><p className="line-clamp-3 whitespace-pre-wrap text-slate-600">{data.detail ?? "Sin detalle"}</p><Evidence urls={data.evidence} /></>}</td>
              <td className="max-w-72 px-4 py-3 text-xs">{order ? <>
                <div className="font-medium text-slate-800">{GENERAL_LABEL[order.general_status] ?? order.general_status}</div><div className="text-slate-500">{order.stage_label}</div>
                {shipment.annulledOnlyInKapta && <div className="mt-1 text-amber-800">Anulado solo en Kapta; en Shopify sigue vivo, así que se puede marcar.</div>}
                {shipment.bucket === "observacion" && <div className="mt-1 text-amber-800">{order.cancelled_at ? `Anulado en Shopify el ${timeLabel(order.cancelled_at).split(",")[0]}` : "Devuelto en Kapta"}{latest.report_date ? `; Urpi lo entregó el ${dateLabel(latest.report_date)}` : ""}.</div>}
                {shipment.bucket === "al_dia" && order.observation_resolved && <div className="mt-1 text-slate-600">Observación cerrada: {order.observation_resolved.note}</div>}
                {shipment.bucket === "observacion" && canImport && <ObservationActions busy={busy} note={notes[shipment.key] ?? ""} code={codes[shipment.key] ?? ""}
                  onNote={(value) => setNotes((prev) => ({ ...prev, [shipment.key]: value }))}
                  onCode={(value) => setCodes((prev) => ({ ...prev, [shipment.key]: value }))}
                  onResolve={(note) => run(() => resolveUrpiObservation(orgId, order.order_id, note))}
                  onRelink={(ref) => run(() => linkUrpiReportRow(orgId, latest.urpi_row, ref))} />}
              </> : <span className="text-slate-500">—</span>}</td>
            </tr>;
          })}</tbody>
        </table>
        {!visible.length && <p className="p-10 text-center text-sm text-slate-500">Nada en esta lista{query ? " con esa búsqueda" : ""}.</p>}
      </div>
      <div className="flex items-center justify-between text-sm text-slate-500"><span>{visible.length ? page * 50 + 1 : 0}–{Math.min((page + 1) * 50, visible.length)} de {visible.length}</span><div className="flex gap-2"><button className={button} disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Anterior</button><button className={button} disabled={(page + 1) * 50 >= visible.length} onClick={() => setPage((value) => value + 1)}>Siguiente</button></div></div>
    </>}
    <p className="border-t border-slate-200 pt-4 text-xs text-slate-500">Urpi no envía el código de pedido: el vínculo se hace por teléfono con un único pedido de los 45 días previos al envío; con varios, decides tú. Marcar entregados exige permiso para editar el Master y convierte la salida «Por definir» del pedido en la salida de Urpi entregada. Cancelados y reprogramados quedan registrados y no cambian el estado del pedido.</p>
  </div>;
}

/** Listas donde lo que importa es lo que cobró Urpi, no el detalle del intento. */
const COBRO_TABS = new Set<UrpiBucket>(["por_aplicar", "observacion", "por_vincular_entregado"]);

function ObservationActions({ busy, note, code, onNote, onCode, onResolve, onRelink }: {
  busy: boolean; note: string; code: string; onNote: (value: string) => void; onCode: (value: string) => void;
  onResolve: (note: string) => void; onRelink: (ref: string) => void;
}) {
  return <div className="mt-2 space-y-2">
    <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (code.trim()) onRelink(code); }}>
      <input className="h-8 w-28 rounded border border-slate-300 px-2 text-xs" placeholder="KP12345" aria-label="Código del pedido rehecho en Shopify" value={code} onChange={(e) => onCode(e.target.value.toUpperCase())} />
      <button disabled={busy || !code.trim()} className="rounded border border-slate-300 px-2 text-xs disabled:opacity-50">Vincular a otro</button>
    </form>
    <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); if (note.trim().length >= 5) onResolve(note); }}>
      <textarea rows={2} className="w-full rounded border border-slate-300 px-2 py-1 text-xs" placeholder="Motivo: p. ej. anulado por error; se cobra en la liquidación de Urpi" aria-label="Motivo para cerrar la observación" value={note} onChange={(e) => onNote(e.target.value)} />
      <button disabled={busy || note.trim().length < 5} className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-50">Cerrar con motivo</button>
    </form>
  </div>;
}

function Evidence({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return <div className="mt-1 flex gap-2">{urls.map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer" className="text-brand-700 underline">Foto {i + 1} ↗</a>)}</div>;
}

function Attempts({ shipment }: { shipment: UrpiShipment }) {
  if (shipment.attempts.length < 2) return null;
  return <details className="mt-1 text-xs text-slate-600"><summary className="cursor-pointer">{shipment.attempts.length} intentos</summary>
    <ol className="mt-1 space-y-1">{shipment.attempts.map((attempt) => <li key={attempt.urpi_row}>
      {dateLabel(attempt.report_date)} · <span className={RESULT_TONE[attempt.result_code] ?? ""}>{attempt.result_code === "otro" ? attempt.data.resultWritten : URPI_RESULT_LABEL[attempt.result_code]}</span>{attempt.data.reason ? ` · ${attempt.data.reason}` : ""}
    </li>)}</ol>
  </details>;
}

function LinkPicker({ shipment, canLink, busy, code, onCode, onLink }: {
  shipment: UrpiShipment; canLink: boolean; busy: boolean; code: string; onCode: (value: string) => void; onLink: (ref: string) => void;
}) {
  const status = shipment.latest.link_status;
  return <div className="space-y-1.5">
    <div className="text-xs text-amber-800">{status === "varios" ? "Varios pedidos con este teléfono" : status === "sin_telefono" ? "Urpi no trae un teléfono válido" : "Ningún pedido con este teléfono"}</div>
    {canLink && <>
      {shipment.candidates.map((candidate) => <button key={candidate.order_id} disabled={busy} className="block text-left text-xs font-medium text-brand-700 underline disabled:opacity-50"
        onClick={() => onLink(candidate.order_id)}>{candidate.order_name ?? "Pedido"} · {GENERAL_LABEL[candidate.general_status] ?? candidate.general_status}</button>)}
      <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (code.trim()) onLink(code); }}>
        <input className="h-8 w-28 rounded border border-slate-300 px-2 text-xs" placeholder="KP12345" aria-label="Código de pedido" value={code} onChange={(e) => onCode(e.target.value.toUpperCase())} />
        <button disabled={busy || !code.trim()} className="rounded border border-slate-300 px-2 text-xs disabled:opacity-50">Vincular</button>
      </form>
    </>}
  </div>;
}
