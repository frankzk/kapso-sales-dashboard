"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { registerUrpiSource, syncUrpiSource } from "@/app/dashboard/urpi/actions";
import { URPI_SOURCE_EXAMPLES, sheetUrl, urpiAutoMonths } from "@/lib/urpi-programming";
import type { UrpiSource, UrpiSnapshot } from "@/lib/urpi-programming-db";

type Store = { id: string; name: string; prefix: string | null; canManage: boolean; canEdit: boolean };
type Props = {
  stores: Store[]; sources: UrpiSource[]; source: UrpiSource | null; snapshot: UrpiSnapshot | null;
  versions: Pick<UrpiSnapshot, "id" | "created_at" | "origin" | "row_count">[]; googleConfigured: boolean; autoSyncEnabled: boolean;
};
const field = "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500";
const button = "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const primary = "rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50";
const dateLabel = (value: string) => value.split("-").reverse().join("/");
const timeLabel = (value: string) => new Intl.DateTimeFormat("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }).format(new Date(value));
const money = (value: number) => new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" }).format(value);

export function UrpiProgrammingBoard({ stores, sources, source, snapshot, versions, googleConfigured, autoSyncEnabled }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [registerOpen, setRegisterOpen] = useState(sources.length === 0);
  const manageable = stores.filter((store) => store.canManage);
  // Los libros de Urpi mezclan tiendas: por defecto se registran todas a la vez.
  const registrable = manageable.filter((store) => store.prefix);
  const [target, setTarget] = useState(registrable.length > 1 ? "all" : registrable[0]?.id ?? "");
  const targets = target === "all" ? registrable : registrable.filter((store) => store.id === target);
  const selectedStore = stores.find((store) => store.id === source?.store_id);
  // Mismo Sheet y mes: actualizar o cargar el Excel procesa todas sus tiendas.
  const bookStores = source ? sources.filter((item) => item.spreadsheet_id === source.spreadsheet_id && item.month === source.month)
    .map((item) => `${stores.find((store) => store.id === item.store_id)?.name ?? item.name} (${item.order_prefix})`) : [];
  const [month, setMonth] = useState(new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).format(new Date()));
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [date, setDate] = useState("");
  const [onlyReview, setOnlyReview] = useState(false);
  const [page, setPage] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = pending || uploading;
  const historical = Boolean(snapshot && source && snapshot.id !== source.current_snapshot_id);
  const rows = snapshot?.payload.rows ?? [];
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("es");
    return rows.filter((row) => (!date || row.date === date) && (!onlyReview || row.issues.length > 0)
      && (!term || [row.orderCode, row.customer, row.phone, row.district].some((text) => text.toLocaleLowerCase("es").includes(term))));
  }, [rows, date, query, onlyReview]);
  const total = filtered.reduce((sum, row) => sum + (row.amount ?? 0), 0);
  const pageRows = filtered.slice(page * 50, (page + 1) * 50);
  const dates = [...new Set(rows.map((row) => row.date))].sort();

  function go(sourceId: string, version?: string) {
    const params = new URLSearchParams({ source: sourceId });
    if (version) params.set("version", version);
    router.push(`/dashboard/urpi?${params}`);
  }

  async function upload(file: File) {
    if (!source) return;
    setUploading(true); setNotice(null);
    try {
      const form = new FormData(); form.set("sourceId", source.id); form.set("file", file);
      const res = await fetch("/api/urpi/programming/import", { method: "POST", body: form });
      const result = await res.json() as { message?: string; error?: string; saved?: number };
      setNotice({ ok: res.ok, message: result.message ?? result.error ?? "No se pudo procesar el archivo." });
      if (res.ok || result.saved) { go(source.id); router.refresh(); }
    } catch { setNotice({ ok: false, message: "No se pudo completar la carga. La programación anterior se conserva." }); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  return <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Couriers externos</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Urpi · Programaciones enviadas</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">Archivos mensuales, fechas previstas y pedidos vinculados. El resultado de entrega se incorporará desde los reportes de Urpi.</p>
      </div>
      {manageable.length > 0 && <button className={primary} onClick={() => setRegisterOpen((open) => !open)} aria-expanded={registerOpen}>Registrar archivo mensual</button>}
    </header>

    {notice && <div role={notice.ok ? "status" : "alert"} className={`whitespace-pre-line rounded-lg border p-3 text-sm ${notice.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}>{notice.message}</div>}

    {registerOpen && manageable.length > 0 && <form className="space-y-4 rounded-xl border border-slate-200 bg-white p-5" onSubmit={(event) => {
      event.preventDefault(); setNotice(null);
      startTransition(async () => {
        const result = await registerUrpiSource({ storeIds: targets.map((store) => store.id), month, url }); setNotice(result);
        if (result.ok && result.sourceId) { setRegisterOpen(false); go(result.sourceId); router.refresh(); }
      });
    }}>
      <p className="text-sm text-slate-600">Registra el enlace una vez por mes. Con un archivo compartido, cada tienda importa solo los pedidos de su prefijo.</p>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="grid gap-1 text-sm">Tienda<select required className={field} value={target} onChange={(e) => setTarget(e.target.value)}>
          {registrable.length > 1 && <option value="all">{registrable.map((store) => store.name).join(" y ")} (mismo archivo)</option>}
          {manageable.map((store) => <option key={store.id} value={store.id} disabled={!store.prefix}>{store.name}{store.prefix ? "" : " · sin prefijo"}</option>)}
        </select></label>
        <label className="grid gap-1 text-sm">Mes<input required type="month" className={field} value={month} onChange={(e) => setMonth(e.target.value)} /></label>
        <div className="grid gap-1 text-sm"><span>Prefijo de pedido</span><p className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700">{targets.map((store) => `${store.prefix} (${store.name})`).join(" y ") || "—"}</p></div>
      </div>
      {registrable.length < manageable.length && <p className="text-xs text-amber-800">{manageable.filter((store) => !store.prefix).map((store) => store.name).join(", ")}: falta el prefijo de pedidos en Ajustes de la tienda.</p>}
      <label className="grid gap-1 text-sm">Enlace de Google Sheets<input required type="url" className={field} placeholder="https://docs.google.com/spreadsheets/d/…" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
      <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-slate-500">Archivos compartidos:</span>{URPI_SOURCE_EXAMPLES.map((example) => <button type="button" className="text-xs font-medium text-brand-700 underline underline-offset-2" key={example.month} onClick={() => { setMonth(example.month); setUrl(sheetUrl(example.spreadsheetId)); }}>{example.title}</button>)}</div>
      <button disabled={busy || !targets.length} className={primary}>{pending ? "Registrando…" : "Guardar archivo"}</button>
    </form>}

    {!sources.length ? <div className="rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center"><h2 className="font-semibold text-slate-900">Reúne aquí las programaciones de Urpi</h2><p className="mt-2 text-sm text-slate-600">Registra el archivo mensual y carga sus pestañas para consultar cada fecha y pedido.</p></div> : <>
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5" aria-label="Archivo mensual">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-60 flex-1 gap-1 text-sm font-medium">Archivo y tienda<select className={field} value={source?.id ?? ""} onChange={(e) => go(e.target.value)}>{sources.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.order_prefix}</option>)}</select></label>
          {source && <a className={button} href={sheetUrl(source.spreadsheet_id)} target="_blank" rel="noreferrer">Abrir Google Sheets ↗</a>}
          {source && selectedStore?.canEdit && <>
            <button disabled={busy || !googleConfigured} className={button} onClick={() => startTransition(async () => {
              setNotice(null); const result = await syncUrpiSource(source.id); setNotice(result);
              if (result.ok || result.saved) { go(source.id); router.refresh(); }
            })}>{pending ? "Leyendo Google Sheets…" : "Actualizar desde Google"}</button>
            <button disabled={busy} className={primary} onClick={() => fileInput.current?.click()}>{uploading ? "Importando…" : "Cargar Excel del mes"}</button>
            <input ref={fileInput} type="file" accept=".xlsx" className="hidden" aria-label="Excel mensual de Urpi" onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); }} />
          </>}
        </div>
        {bookStores.length > 1 && <p className="text-sm text-slate-600">Archivo compartido por {bookStores.join(" y ")}: cada lectura o Excel cargado actualiza todas sus tiendas.</p>}
        <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-500">
          <span>{source?.last_checked_at ? `Última lectura: ${timeLabel(source.last_checked_at)} · hora de Lima` : "Este archivo todavía no tiene una lectura guardada."}</span>
          <span>{googleConfigured ? "Conexión de lectura a Google configurada" : "Conexión a Google pendiente · disponible mediante Excel"}</span>
        </div>
        {!googleConfigured && selectedStore?.canEdit && <p className="text-sm text-slate-600">Para cargar ahora: abre el Sheet y elige Archivo → Descargar → Microsoft Excel (.xlsx). Se leerán todas las pestañas del mes seleccionado.</p>}
        <p className="text-sm text-slate-600">{!autoSyncEnabled ? "Lectura automática pendiente de activación." : source && urpiAutoMonths().includes(source.month) ? "Lectura automática programada cada 15 minutos. No necesitas mantener esta pantalla abierta." : "Archivo histórico: actualización manual disponible. La lectura automática cubre el mes anterior, actual y siguiente."}</p>
        {source?.last_auto_attempt_at && <p className="text-xs text-slate-500">Último intento automático: {timeLabel(source.last_auto_attempt_at)}{source.last_auto_success_at ? ` · Última lectura automática correcta: ${timeLabel(source.last_auto_success_at)}` : ""} · hora de Lima</p>}
        {source?.last_auto_error && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{source.last_auto_error}</p>}
      </section>

      {snapshot ? <>
        {snapshot.payload.unassigned?.length > 0 && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Hay {snapshot.payload.unassigned.length} fila(s) con destinatario y sin código de pedido en el libro. No se pueden asignar a una tienda. Revisa {snapshot.payload.unassigned.map((row) => `${row.tab}, fila ${row.rowNumber}`).join("; ")}.</div>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-6 text-sm"><span><strong className="text-xl text-slate-900">{filtered.length}</strong> programaciones</span><span><strong className="text-xl text-slate-900">{filtered.filter((row) => row.orderId).length}</strong> vinculadas</span><span><strong className="text-xl text-slate-900">{filtered.filter((row) => row.issues.length).length}</strong> por revisar</span><span><strong className="text-xl text-slate-900">{money(total)}</strong> a cobrar</span></div>
          <label className="grid gap-1 text-xs text-slate-500">Historial de lecturas<select className={field} value={snapshot.id} onChange={(e) => source && go(source.id, e.target.value)}>{versions.map((version) => <option key={version.id} value={version.id}>{timeLabel(version.created_at)} · {version.origin === "google" ? "Google" : "Excel"} · {version.row_count} filas{version.id === source?.current_snapshot_id ? " · actual" : ""}</option>)}</select></label>
        </div>
        {historical && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Estás viendo una versión anterior de la programación. <button className="font-semibold underline" onClick={() => source && go(source.id)}>Volver a la actual</button></p>}
        <div className="flex flex-wrap items-center gap-3">
          <input className={`${field} min-w-64 flex-1`} placeholder="Buscar pedido, cliente, teléfono o distrito" aria-label="Buscar programación" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
          <select className={field} aria-label="Fecha de entrega prevista" value={date} onChange={(e) => { setDate(e.target.value); setPage(0); }}><option value="">Todas las fechas</option>{dates.map((item) => <option key={item} value={item}>{dateLabel(item)}</option>)}</select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyReview} onChange={(e) => { setOnlyReview(e.target.checked); setPage(0); }} />Solo por revisar</label>
        </div>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[1000px] text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{["Fecha prevista", "Pedido", "Destinatario", "Distrito", "Productos", "A cobrar", "Revisión"].map((title) => <th key={title} className="px-4 py-3 font-medium">{title}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">{pageRows.map((row) => <tr key={row.key} className="align-top hover:bg-slate-50/60">
              <td className="whitespace-nowrap px-4 py-3"><div>{dateLabel(row.date)}</div><span className="text-xs text-slate-500">{row.shift}</span></td>
              <td className="px-4 py-3"><div>{row.orderId ? <Link href={`?source=${source!.id}&version=${snapshot.id}&ficha=${row.orderId}`} className="font-semibold text-brand-700 hover:underline">#{row.orderCode}</Link> : <span className="font-semibold">#{row.orderCode}</span>}</div><a href={sheetUrl(source!.spreadsheet_id, row.sheetId)} target="_blank" rel="noreferrer" className="text-xs text-slate-500 underline">{row.tab} · fila {row.rowNumber} ↗</a></td>
              <td className="px-4 py-3"><div className="font-medium">{row.customer || "Sin nombre"}</div><div className="text-xs text-slate-500">{row.phone}</div><details className="mt-1 max-w-64 text-xs text-slate-600"><summary className="cursor-pointer">Dirección y notas</summary><p className="mt-1 whitespace-pre-wrap">{[row.address, row.reference, row.notes].filter(Boolean).join("\n") || "Sin notas"}</p></details></td>
              <td className="px-4 py-3">{row.district}<div className="text-xs text-slate-500">{row.province}</div></td>
              <td className="max-w-72 px-4 py-3"><details><summary className="cursor-pointer line-clamp-2">{row.products || "Sin productos"}</summary><p className="mt-2 whitespace-pre-wrap text-xs">{row.products}</p></details></td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums">{row.amount === null ? "Sin monto" : money(row.amount)}</td>
              <td className="max-w-52 px-4 py-3 text-xs">{row.issues.length ? <ul className="space-y-1 text-amber-800">{row.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : row.orderId ? <span className="text-emerald-700">Vinculado</span> : <span className="text-amber-800">Sin vincular</span>}</td>
            </tr>)}</tbody>
          </table>
          {!filtered.length && <p className="p-10 text-center text-sm text-slate-500">No hay programaciones con estos filtros.{!rows.length ? " Comprueba el mes y el prefijo de la tienda." : ""}</p>}
        </div>
        <div className="flex items-center justify-between text-sm text-slate-500"><span>{filtered.length ? page * 50 + 1 : 0}–{Math.min((page + 1) * 50, filtered.length)} de {filtered.length}</span><div className="flex gap-2"><button className={button} disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Anterior</button><button className={button} disabled={(page + 1) * 50 >= filtered.length} onClick={() => setPage((value) => value + 1)}>Siguiente</button></div></div>
      </> : <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-600">Archivo registrado. Carga su primera programación para ver los pedidos aquí.</div>}
    </>}
    <p className="border-t border-slate-200 pt-4 text-xs text-slate-500">Regla de Urpi: un reporte «Reprogramado» corresponde al siguiente día de lunes a sábado; sábado pasa a lunes. La programación enviada se conserva como historial.</p>
  </div>;
}
