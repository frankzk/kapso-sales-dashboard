"use client";

// El detalle de un manifiesto de devolución (0307, MOM §9.4 y §29.13; owner
// 04-11-2026). Lo que contesta: de lo que Kapta esperaba que volviera con el
// motorizado, ¿qué llegó, qué no y qué llegó sin esperarse? Cada caja se recibe
// con la recepción de siempre; el manifiesto solo registra. Cerrado, no
// cambia: lo que pasa después («apareció el 06/11») se deriva en vivo.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { Sheet } from "@/components/filter-sheet";
import { Badge, Banner, FIELD, FIELD_BOX, OpsButton, opsButtonClass, SECTION_CARD, SectionHead, type BadgeTone } from "@/components/ops-ui";
import { IconAlert, IconDownload, IconImage } from "@/components/icons";
import { OrderLink } from "@/components/order-link";
import { ReturnManifestScanner } from "@/components/returns-scanner";
import { limaShortDateTime, RETURN_MANIFEST_STATE_TONE } from "@/components/return-manifests";
import {
  cancelReturnManifest,
  closeReturnManifest,
  discardReturnManifestLine,
  setReturnManifestLineNote,
  updateReturnManifestHeader,
} from "@/app/dashboard/pedidos/devoluciones/manifest-actions";
import { boxDayShort } from "@/lib/gf-scan-return";
import { nonDeliveryReasonLabel } from "@/lib/gf-delivery";
import { fitWithin } from "@/lib/photo-resize";
import {
  lineResultHead,
  REPROGRAMADO_KEEP_DAYS,
  reportedLabel,
  RETURN_LINE_FLAG_LABEL,
  RETURN_MANIFEST_STATE_LABEL,
  RETURN_MANIFESTS_TAB_PATH,
  returnManifestActaUrl,
  returnManifestPhotoUrl,
  type ExpectedRow,
  type ReturnLineFlag,
  type ReturnManifestLine,
} from "@/lib/return-manifest";
import type { ReturnManifestDetail, ReturnManifestLineExtra } from "@/lib/return-manifest-access";

const FLAG_TONE: Record<ReturnLineFlag, BadgeTone> = {
  otra_caja: "info",
  sin_reporte: "warn",
  reportada_entregada: "crit",
  ya_recibida: "neutral",
  no_identificada: "warn",
  reprogramado: "neutral",
};

const PHOTO_MAX_SIDE = 2400;

/** Una foto grande se achica antes de subir (la hoja tiene letra chica). */
async function shrinkPhoto(file: File): Promise<Blob> {
  if (file.size <= 3 * 1024 * 1024) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, PHOTO_MAX_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0, width, height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return out ?? file;
  } finally {
    bitmap.close();
  }
}

/** «Caja del 26/10 · Alexis». */
function boxOf(day: string | null, rider: string | null): string {
  return [day ? `caja del ${boxDayShort(day)}` : null, rider].filter(Boolean).join(" · ");
}

function OrderCell({ orderId, orderName, code }: { orderId: string | null; orderName: string | null; code: string | null }) {
  return (
    <div className="min-w-0">
      {orderId && orderName
        ? <OrderLink orderId={orderId} className="font-semibold tabular-nums text-ink-900 hover:text-brand-700">{orderName}</OrderLink>
        : <span className="font-semibold tabular-nums text-ink-900">{orderName ?? "—"}</span>}
      {code && <p className="truncate font-mono text-[11px] text-ink-500" title={code}>{code}</p>}
    </div>
  );
}

function Panel({ id, title, count, tone, hint, children }: { id: string; title: string; count: number; tone: BadgeTone; hint: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-lg bg-white shadow-control ring-1 ring-line">
      <div className="px-4 pb-3 pt-4 sm:px-5">
        <div className="flex items-center gap-2">
          <h2 id={id} className="text-base font-semibold leading-6 text-ink-900">{title}</h2>
          <Badge tone={count ? tone : "neutral"} className="tabular-nums">{count}</Badge>
        </div>
        <p className="mt-0.5 text-[13px] text-ink-500">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="mx-4 mb-4 rounded-lg border border-dashed border-line-strong py-8 text-center text-sm text-ink-500 sm:mx-5">{children}</p>;
}

/** Una línea escaneada: pedido, salida, caja, reportado, resultado y sus marcas. */
function LineRow({ line, extra, canEdit, onChanged }: { line: ReturnManifestLine; extra: ReturnManifestLineExtra | undefined; canEdit: boolean; onChanged: (notice: string | null, error: string | null) => void }) {
  const [mode, setMode] = useState<"idle" | "note" | "discard">("idle");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const removable = canEdit && (line.outcome === "held" || line.outcome === "info");
  const noteMissing = line.outcome === "held" && line.flags.includes("no_identificada") && !line.note;

  async function submit() {
    setBusy(true);
    const res = mode === "note" ? await setReturnManifestLineNote(line.id, text) : await discardReturnManifestLine(line.id, text);
    setBusy(false);
    if (!res.ok) { onChanged(null, res.error ?? "No se pudo guardar."); return; }
    setMode("idle");
    setText("");
    onChanged(res.notice ?? (mode === "note" ? "Nota guardada." : "Línea descartada."), null);
  }

  return (
    <li className="space-y-1.5 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <OrderCell orderId={line.orderId} orderName={line.orderName} code={line.outputCode ?? line.scannedCode} />
        <span className="text-xs tabular-nums text-ink-500">{boxOf(line.sourceRouteDate, line.sourceRiderName)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral" title="Lo que reportó el motorizado">{reportedLabel(line.reportedStatus, line.reportedReason)}</Badge>
        <Badge tone={line.outcome === "received" ? (line.receiptOutcome === "a_inventario_anulado" ? "info" : "ok") : line.outcome === "held" ? "warn" : "neutral"} wrap>{lineResultHead(line)}</Badge>
        {line.flags.filter((f) => f !== "reprogramado").map((f) => <Badge key={f} tone={FLAG_TONE[f]}>{RETURN_LINE_FLAG_LABEL[f]}</Badge>)}
        {line.scanCount > 1 && <span className="text-xs tabular-nums text-ink-500">escaneada {line.scanCount} veces</span>}
      </div>
      {line.message && <p className="text-xs text-pretty text-ink-600">{line.message}</p>}
      {line.note && <p className="text-xs text-ink-700"><b className="font-semibold">Nota:</b> {line.note}</p>}
      {noteMissing && <p className="text-xs font-medium text-warn-fg">Anota qué es o descártala: sin nota no se puede cerrar.</p>}
      {extra?.resolvedAt && <Badge tone="ok">Recibida después, el {limaShortDateTime(extra.resolvedAt)}</Badge>}
      {extra?.notebookIncident && <Banner tone="crit" className="py-2 text-xs">{extra.notebookIncident}</Banner>}
      {(removable || (canEdit && line.outcome !== "missing")) && mode === "idle" && (
        <div className="flex flex-wrap gap-3 pt-0.5">
          {canEdit && line.outcome !== "missing" && (
            <button type="button" className="min-h-0 p-0 text-xs font-medium text-brand-700 hover:underline" onClick={() => { setText(line.note ?? ""); setMode("note"); }}>
              {line.note ? "Cambiar nota" : "Anotar"}
            </button>
          )}
          {removable && (
            <button type="button" className="min-h-0 p-0 text-xs font-medium text-crit-fg hover:underline" onClick={() => { setText(""); setMode("discard"); }}>
              Descartar
            </button>
          )}
        </div>
      )}
      {mode !== "idle" && (
        <form className="flex flex-wrap items-center gap-2 pt-1" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label className="min-w-0 flex-1">
            <span className="sr-only">{mode === "note" ? "Nota de la línea" : "Motivo del descarte"}</span>
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={mode === "note" ? 600 : 300}
              placeholder={mode === "note" ? "Qué es, qué dijo el motorizado…" : "Por qué se descarta: escaneo equivocado, no es una devolución…"}
              className={cn(FIELD, "min-w-[12rem]")}
            />
          </label>
          <OpsButton size="sm" type="submit" variant={mode === "discard" ? "danger" : "primary"} disabled={busy || text.trim().length < (mode === "note" ? 3 : 5)}>
            {mode === "note" ? "Guardar nota" : "Descartar"}
          </OpsButton>
          <OpsButton size="sm" variant="ghost" onClick={() => setMode("idle")}>Cancelar</OpsButton>
        </form>
      )}
    </li>
  );
}

/** Una caja esperada que no llegó: el día de su caja, cuántos días lleva y su motivo. */
function ExpectedItem({ row, appeared }: { row: ExpectedRow; appeared?: string | null }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5">
      <OrderCell orderId={row.orderId} orderName={row.orderName} code={row.outputCode} />
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-right">
        <Badge tone="neutral" title="Lo que reportó el motorizado">{nonDeliveryReasonLabel(row.outcomeReason)}</Badge>
        <span className="text-xs tabular-nums text-ink-500">
          {row.routeDate ? `caja del ${boxDayShort(row.routeDate)}` : "—"}
          {row.routeDate ? ` · ${row.ageDays === 0 ? "hoy" : `hace ${row.ageDays} ${row.ageDays === 1 ? "día" : "días"}`}` : ""}
        </span>
        {appeared && <Badge tone="ok">{appeared}</Badge>}
      </div>
    </li>
  );
}

function ExpectedGroup({ title, hint, tone, rows, extras }: { title: string; hint: string; tone: BadgeTone; rows: ExpectedRow[]; extras?: Map<string, string | null> }) {
  if (!rows.length) return null;
  return (
    <div className="border-t border-line">
      <div className="flex items-center gap-2 px-4 pt-3 sm:px-5">
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        <Badge tone={tone} className="tabular-nums">{rows.length}</Badge>
      </div>
      <p className="px-4 text-xs text-ink-500 sm:px-5">{hint}</p>
      <ul className="mt-1 divide-y divide-line">
        {rows.map((row) => <ExpectedItem key={row.shipmentId} row={row} appeared={extras?.get(row.shipmentId) ?? null} />)}
      </ul>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "ok" | "warn" | "crit" }) {
  const cell = tone === "warn" ? "bg-warn-wash" : tone === "crit" ? "bg-crit-wash" : "bg-white";
  const fg = tone === "ok" ? "text-ok-fg" : tone === "warn" ? "text-warn-fg" : tone === "crit" ? "text-crit-fg" : "text-ink-900";
  return (
    <div className={cn("min-w-0 px-4 py-3", cell)}>
      <dt className={cn("text-[13px]", tone === "warn" || tone === "crit" ? cn("font-medium", fg) : "text-ink-500")}>{label}</dt>
      <dd className={cn("mt-0.5 text-xl font-semibold leading-7 tabular-nums", fg)}>{value}</dd>
    </div>
  );
}

export function ReturnManifestDetailView({ detail }: { detail: ReturnManifestDetail }) {
  const router = useRouter();
  const { header, buckets, totals, extras, canEdit } = detail;
  const [handedOverBy, setHandedOverBy] = useState(header.handedOverBy ?? "");
  const [declared, setDeclared] = useState(header.declaredCount == null ? "" : String(header.declaredCount));
  const [note, setNote] = useState(header.note ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "crit"; text: string } | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [closeWho, setCloseWho] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [acting, setActing] = useState(false);
  const [uploading, setUploading] = useState(false);

  const dirty = handedOverBy.trim() !== (header.handedOverBy ?? "")
    || declared.trim() !== (header.declaredCount == null ? "" : String(header.declaredCount))
    || note.trim() !== (header.note ?? "");
  const declaredValid = declared.trim() === "" || /^\d{1,4}$/.test(declared.trim());
  const unnoted = detail.lines.filter((l) => !l.removedAt && l.outcome === "held" && l.flags.includes("no_identificada") && !l.note).length;
  // Abierto, lo listado; cerrado, lo que el cierre contó (no se lista, no cambia).
  const pendingAtClose = buckets.pending.conElMotorizado + buckets.pending.reprogramado;
  const missingAppeared = new Map(detail.lines.filter((l) => l.outcome === "missing" && l.shipmentId).map((l) => [l.shipmentId!, extras[l.id]?.appeared ?? null]));
  const rider = header.riderName?.trim().split(/\s+/)[0] ?? "el motorizado";

  function changed(notice: string | null, error: string | null) {
    setMessage(error ? { tone: "crit", text: error } : notice ? { tone: "ok", text: notice } : null);
    if (!error) router.refresh();
  }

  async function saveHeader() {
    if (!declaredValid) { setMessage({ tone: "crit", text: "La cifra declarada debe ser un número entero." }); return; }
    setSaving(true);
    const res = await updateReturnManifestHeader(header.id, {
      handedOverBy: handedOverBy.trim() || null,
      declaredCount: declared.trim() === "" ? null : Number(declared.trim()),
      note: note.trim() || null,
    });
    setSaving(false);
    changed(res.ok ? "Cabecera guardada." : null, res.ok ? null : res.error ?? "No se pudo guardar.");
  }

  async function close() {
    setActing(true);
    const res = await closeReturnManifest(header.id, closeWho);
    setActing(false);
    if (!res.ok) { setMessage({ tone: "crit", text: res.error ?? "No se pudo cerrar." }); return; }
    setCloseOpen(false);
    changed(res.notice ?? "Manifiesto cerrado.", null);
  }

  async function cancel() {
    setActing(true);
    const res = await cancelReturnManifest(header.id, cancelReason);
    setActing(false);
    if (!res.ok) { setMessage({ tone: "crit", text: res.error ?? "No se pudo anular." }); return; }
    setCancelOpen(false);
    changed(res.notice ?? "Manifiesto anulado.", null);
  }

  async function upload(file: File) {
    setUploading(true);
    setMessage(null);
    try {
      const body = new FormData();
      const blob = await shrinkPhoto(file);
      body.append("file", blob instanceof File ? blob : new File([blob], "acta.jpg", { type: "image/jpeg" }));
      const res = await fetch(returnManifestPhotoUrl(header.id), { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setMessage({ tone: "crit", text: json.error ?? "No se pudo subir la foto." }); return; }
      changed("Foto guardada.", null);
    } catch {
      setMessage({ tone: "crit", text: "No se pudo subir la foto. Reintenta." });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 pb-24">
      <header>
        <Link href={RETURN_MANIFESTS_TAB_PATH} className="text-[13px] font-medium text-ink-500 hover:text-ink-900">← Manifiestos de devolución</Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">{header.label}</h1>
          <Badge tone={RETURN_MANIFEST_STATE_TONE[header.state]}>{RETURN_MANIFEST_STATE_LABEL[header.state]}</Badge>
        </div>
        <p className="mt-1 text-sm text-ink-500">
          Grupo GF · {header.riderName ?? "Motorizado"} · llegó el {boxDayShort(header.arrivedOn)} · plazo de {header.cadenceDays} {header.cadenceDays === 1 ? "día" : "días"} para «Falta»
          {header.createdByName ? ` · abrió ${header.createdByName} el ${limaShortDateTime(header.createdAt)}` : ""}
        </p>
      </header>

      {header.stale && (
        <Banner tone="warn" role="status" title={`Abierto desde el ${limaShortDateTime(header.createdAt)}`}>
          Ciérralo cuando termines de escanear, o anúlalo si se abrió por error: mientras esté abierto, lo que faltó no queda anotado.
        </Banner>
      )}
      {header.state === "closed" && (
        <Banner tone="info" role="status" title={`Cerrado${header.closedByName ? ` por ${header.closedByName}` : ""} el ${limaShortDateTime(header.closedAt)}`}>
          Un manifiesto cerrado no cambia. Si una caja que faltó llega después, se recibe normal y aquí se ve «apareció el dd/mm».
        </Banner>
      )}
      {header.state === "cancelled" && (
        <Banner tone="warn" role="status" title={`Anulado${header.cancelledByName ? ` por ${header.cancelledByName}` : ""} el ${limaShortDateTime(header.cancelledAt)}`}>
          {header.cancellationReason}
        </Banner>
      )}
      {message && <Banner tone={message.tone} role={message.tone === "crit" ? "alert" : "status"}>{message.text}</Banner>}

      {/* El contador: lo esperado frente a lo que llegó, y lo que él declaró. */}
      <section aria-label="Contador" className="rounded-lg bg-white shadow-control ring-1 ring-line">
        <p className="px-4 pt-4 text-base font-semibold text-ink-900 sm:px-6">{detail.counter}</p>
        <div className="p-4 sm:px-6">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line max-sm:[&>*:last-child:nth-child(odd)]:col-span-2 sm:grid-flow-col sm:auto-cols-fr sm:grid-cols-none">
            <Stat label="Llegaron" value={totals.arrived} />
            <Stat label="Recibidas" value={totals.received} tone={totals.received ? "ok" : undefined} />
            <Stat label="Con observación" value={totals.withObservation} tone={totals.withObservation ? "warn" : undefined} />
            <Stat label={header.state === "open" ? "Fuera de plazo" : "Faltan"} value={totals.missing} tone={totals.missing ? "crit" : undefined} />
            <Stat
              label={totals.declared == null ? "Declaró" : `Declaró ${totals.declared} · llegaron ${totals.arrived}`}
              value={totals.declaredGap == null ? "—" : totals.declaredGap === 0 ? "cuadra" : totals.declaredGap > 0 ? `faltan ${totals.declaredGap}` : `sobran ${-totals.declaredGap}`}
              tone={totals.declaredGap ? "warn" : totals.declaredGap === 0 ? "ok" : undefined}
            />
          </dl>
          {totals.toInventory > 0 && (
            <p className="mt-2 text-[13px] text-ink-600">{totals.toInventory} {totals.toInventory === 1 ? "caja es de un pedido anulado en la tienda: va" : "cajas son de pedidos anulados en la tienda: van"} a inventario (Almacén decide stock o merma), no a «por asignar».</p>
          )}
          {detail.hiddenOtherStores > 0 && (
            <p className="mt-2 text-xs text-ink-500">Además, {rider} tiene {detail.hiddenOtherStores} {detail.hiddenOtherStores === 1 ? "caja esperada" : "cajas esperadas"} de tiendas que no ves: no se cuentan aquí.</p>
          )}
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        {/* Cabecera: quién entregó, cuántas dijo, nota y la foto opcional. */}
        <section aria-labelledby="cabecera-manifiesto" className={SECTION_CARD}>
          <SectionHead id="cabecera-manifiesto" title="Cabecera" help="Lo que dice quien entrega. La foto de la hoja o del acta firmada es opcional." />
          <form className="mt-4 grid gap-3" onSubmit={(e) => { e.preventDefault(); void saveHeader(); }}>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
              <label className="grid gap-1.5">
                <span className="text-[13px] font-medium text-ink-700">Entregó</span>
                <input value={handedOverBy} onChange={(e) => setHandedOverBy(e.target.value)} disabled={!canEdit} maxLength={120} placeholder={`Ej. ${rider}`} className={FIELD} />
              </label>
              <label className="grid gap-1.5">
                <span className="text-[13px] font-medium text-ink-700">Declara <span className="font-normal text-ink-500">(opcional)</span></span>
                <input value={declared} onChange={(e) => setDeclared(e.target.value)} disabled={!canEdit} inputMode="numeric" placeholder="N paquetes" aria-invalid={!declaredValid} className={cn(FIELD, "tabular-nums")} />
              </label>
            </div>
            <label className="grid gap-1.5">
              <span className="text-[13px] font-medium text-ink-700">Nota <span className="font-normal text-ink-500">(opcional)</span></span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} disabled={!canEdit} maxLength={1000} rows={2} placeholder="Lo que dijo al entregar, cómo llegó la caja…" className={cn(FIELD_BOX, "w-full px-3 py-2")} />
            </label>
            {canEdit && (
              <div>
                <OpsButton type="submit" size="sm" disabled={saving || !dirty || !declaredValid}>{saving ? "Guardando…" : "Guardar cabecera"}</OpsButton>
              </div>
            )}
          </form>
          <div className="mt-4 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-ink-900">Fotos</h3>
              <Badge className="tabular-nums">{header.photoPaths.length}</Badge>
              {header.state !== "cancelled" && (
                <label className={cn(opsButtonClass("secondary", "sm"), "ml-auto cursor-pointer", uploading && "pointer-events-none opacity-60")}>
                  <IconImage aria-hidden className="text-ink-500" />
                  {uploading ? "Subiendo…" : "Añadir foto"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    disabled={uploading}
                    onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }}
                  />
                </label>
              )}
            </div>
            {header.photoPaths.length ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {header.photoPaths.map((path, i) => (
                  <li key={path}>
                    <a href={returnManifestPhotoUrl(header.id, path)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md ring-1 ring-line hover:ring-brand-500">
                      {/* eslint-disable-next-line @next/next/no-img-element -- privada, servida por nuestra ruta */}
                      <img src={returnManifestPhotoUrl(header.id, path)} alt={`Foto ${i + 1} del manifiesto`} className="size-20 object-cover" loading="lazy" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-ink-500">Sin fotos. Se puede añadir también después de cerrar, cuando se firme el acta.</p>
            )}
          </div>
        </section>

        <section aria-labelledby="escaner-manifiesto" className={SECTION_CARD}>
          <SectionHead id="escaner-manifiesto" title="Escanear lo que llegó" help="Cada caja, una por una. Un escaneo repetido no duplica la línea." />
          <div className="mt-4">
            {canEdit
              ? <ReturnManifestScanner manifestId={header.id} progress={{ done: totals.expectedReceived, total: totals.expectedTotal }} />
              : <p className="text-sm text-ink-500">El manifiesto está {RETURN_MANIFEST_STATE_LABEL[header.state].toLowerCase()}: ya no se escanea. Lo que llegue después se recibe en Devoluciones o en un manifiesto nuevo.</p>}
          </div>
        </section>
      </div>

      {/* Los tres paneles. */}
      <div className="grid gap-5 xl:grid-cols-3">
        <Panel id="panel-llego" title="Llegó" count={buckets.llego.length} tone="ok" hint="Se esperaban y se recibieron en oficina.">
          {buckets.llego.length
            ? <ul className="divide-y divide-line border-t border-line">{buckets.llego.map((l) => <LineRow key={l.id} line={l} extra={extras[l.id]} canEdit={canEdit} onChanged={changed} />)}</ul>
            : <Empty>Todavía no llegó ninguna de las esperadas.</Empty>}
        </Panel>

        <Panel
          id="panel-no-llego"
          title="Esperado y no llegó"
          count={buckets.noLlego.falta.length + pendingAtClose}
          tone={buckets.noLlego.falta.length ? "crit" : "warn"}
          hint={header.state === "open"
            ? `«No entregado» que siguen en las cajas de ${rider}. Fuera de plazo (${header.cadenceDays} ${header.cadenceDays === 1 ? "día" : "días"}; reprogramado, ${REPROGRAMADO_KEEP_DAYS}) es «Falta» al cerrar.`
            : "Lo que se anotó como «Falta» al cerrar."}
        >
          <ExpectedGroup title="Falta" tone="crit" rows={buckets.noLlego.falta} extras={missingAppeared}
            hint={header.state === "open" ? "Pasó su plazo y no llegó: al cerrar queda anotado como faltante." : "Siguen «No entregado» a nombre del motorizado."} />
          <ExpectedGroup title="Con el motorizado" tone="neutral" rows={buckets.noLlego.conElMotorizado} hint="Todavía dentro de su plazo: no falta." />
          <ExpectedGroup title="Reprogramado, sigue con él" tone="neutral" rows={buckets.noLlego.reprogramado} hint={`Reprogramado hace ${REPROGRAMADO_KEEP_DAYS} días o menos: lo vuelve a llevar.`} />
          {header.state !== "open" && pendingAtClose > 0 && (
            <p className="mx-4 mb-4 text-xs text-ink-500 sm:mx-5">
              Al cerrar, <b className="font-semibold tabular-nums">{pendingAtClose}</b> {pendingAtClose === 1 ? "seguía" : "seguían"} dentro de plazo con el motorizado
              {buckets.pending.reprogramado ? ` (${buckets.pending.reprogramado} reprogramado${buckets.pending.reprogramado === 1 ? "" : "s"})` : ""}: no se anotaron como «Falta».
            </p>
          )}
          {!buckets.noLlego.falta.length && !pendingAtClose && <Empty>{header.state === "open" ? "No falta nada de lo esperado." : "No faltó nada."}</Empty>}
        </Panel>

        <Panel id="panel-sin-esperarse" title="Llegó sin esperarse" count={buckets.sinEsperarse.length} tone="warn" hint="De otra caja, sin reporte, reportada entregada, ya recibida o no identificada. La reportada entregada es una incidencia: no se recibe.">
          {buckets.sinEsperarse.length
            ? <ul className="divide-y divide-line border-t border-line">{buckets.sinEsperarse.map((l) => <LineRow key={l.id} line={l} extra={extras[l.id]} canEdit={canEdit} onChanged={changed} />)}</ul>
            : <Empty>Nada fuera de lo esperado.</Empty>}
        </Panel>
      </div>

      {buckets.descartadas.length > 0 && (
        <details className="rounded-lg bg-white shadow-control ring-1 ring-line">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink-900 sm:px-5">Descartadas <Badge className="ml-1 tabular-nums">{buckets.descartadas.length}</Badge></summary>
          <ul className="divide-y divide-line border-t border-line">
            {buckets.descartadas.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 sm:px-5">
                <OrderCell orderId={l.orderId} orderName={l.orderName} code={l.outputCode ?? l.scannedCode} />
                <span className="text-xs text-ink-500">{l.removalReason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* El pie: cerrar, anular y el acta. */}
      <section aria-label="Acciones del manifiesto" className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-4 shadow-control ring-1 ring-line sm:px-5">
        {canEdit && (
          <>
            <OpsButton variant="primary" onClick={() => { setCloseWho(handedOverBy.trim() || header.handedOverBy || ""); setCloseOpen(true); }}>Cerrar manifiesto</OpsButton>
            <OpsButton variant="ghost" disabled={totals.received > 0} title={totals.received > 0 ? "Ya se recibieron cajas: ciérralo en vez de anularlo." : undefined} onClick={() => { setCancelReason(""); setCancelOpen(true); }}>Anular</OpsButton>
          </>
        )}
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <a href={returnManifestActaUrl(header.id, "pdf")} className={opsButtonClass()}><IconDownload aria-hidden className="text-ink-500" />Descargar PDF</a>
          <a href={returnManifestActaUrl(header.id, "xlsx")} className={opsButtonClass()}><IconDownload aria-hidden className="text-ink-500" />Descargar Excel</a>
        </div>
        <p className="w-full text-xs text-ink-500">El acta lleva #pedido, salida, día de la caja, lo reportado, el resultado, los totales y las firmas «Entregó» y «Recibió». Sin datos de clientes.</p>
      </section>

      {closeOpen && (
        <Sheet look="ops" title="Cerrar el manifiesto" onClose={() => setCloseOpen(false)}>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void close(); }}>
            <ul className="space-y-1 text-[13px] text-ink-700">
              <li><b className="font-semibold tabular-nums">{totals.received}</b> recibidas{totals.toInventory ? ` (${totals.toInventory} a inventario)` : ""}.</li>
              {totals.withObservation > 0 && <li><b className="font-semibold tabular-nums">{totals.withObservation}</b> con observación: quedan abiertas, no se reciben.</li>}
              <li className={buckets.noLlego.falta.length ? "text-crit-fg" : undefined}><b className="font-semibold tabular-nums">{buckets.noLlego.falta.length}</b> fuera de plazo se anotarán como «Falta»; siguen «No entregado» a nombre de {rider}.</li>
              {pendingAtClose > 0 && <li><b className="font-semibold tabular-nums">{pendingAtClose}</b> dentro de plazo siguen con el motorizado: no faltan.</li>}
              {totals.declared != null && <li>Declaró {totals.declared}, llegaron {totals.arrived}.</li>}
            </ul>
            {unnoted > 0 && (
              <Banner tone="warn" role="alert">
                {unnoted} {unnoted === 1 ? "caja no identificada sin nota" : "cajas no identificadas sin nota"}: anota qué es o descártala antes de cerrar.
              </Banner>
            )}
            <label className="grid gap-1.5">
              <span className="text-[13px] font-medium text-ink-700">Entregó</span>
              <input autoFocus value={closeWho} onChange={(e) => setCloseWho(e.target.value)} maxLength={120} placeholder={`Ej. ${rider}`} className={FIELD} />
            </label>
            <p className="text-xs text-ink-500">Cerrado no cambia: no toca ningún pedido. Recibió: tú.</p>
            <div className="flex flex-wrap gap-2">
              <OpsButton type="submit" variant="primary" disabled={acting || closeWho.trim().length < 3 || unnoted > 0}>{acting ? "Cerrando…" : "Cerrar manifiesto"}</OpsButton>
              <OpsButton variant="ghost" onClick={() => setCloseOpen(false)}>Volver</OpsButton>
            </div>
          </form>
        </Sheet>
      )}

      {cancelOpen && (
        <Sheet look="ops" title="Anular el manifiesto" onClose={() => setCancelOpen(false)}>
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void cancel(); }}>
            <p className="text-[13px] text-ink-600">Solo si se abrió por error y no tiene cajas recibidas. Queda en el registro, anulado y con su motivo.</p>
            <label className="grid gap-1.5">
              <span className="text-[13px] font-medium text-ink-700">Motivo</span>
              <input autoFocus value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={300} placeholder="Ej. se abrió para otro motorizado" className={FIELD} />
            </label>
            <div className="flex flex-wrap gap-2">
              <OpsButton type="submit" variant="danger" disabled={acting || cancelReason.trim().length < 5}>{acting ? "Anulando…" : "Anular manifiesto"}</OpsButton>
              <OpsButton variant="ghost" onClick={() => setCancelOpen(false)}>Volver</OpsButton>
            </div>
          </form>
        </Sheet>
      )}
      {unnoted > 0 && canEdit && !closeOpen && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-warn-fg"><IconAlert aria-hidden className="size-3.5" />{unnoted} sin identificar: anótalas o descártalas antes de cerrar.</p>
      )}
    </div>
  );
}
