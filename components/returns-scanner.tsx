"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DispatchScanner } from "@/components/dispatch-scanner";
import { DispatchCamera } from "@/components/dispatch-camera";
import { returnUndeliveredByCode, returnUndeliveredOutputs } from "@/app/dashboard/courier/actions";
import type { PendingReturn } from "@/lib/courier-route-ledger";
import { nonDeliveryReasonLabel } from "@/lib/gf-delivery";
import { Badge, Banner, FIELD, OpsButton, type BadgeTone } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import { scanReturnManifest, setReturnManifestLineNote, type ReturnManifestScanResult } from "@/app/dashboard/pedidos/devoluciones/manifest-actions";

/**
 * Devoluciones (Despacho del día): el supervisor escanea (o teclea) cada paquete «No
 * entregado» que vuelve con el motorizado. Cámara en serie, como al asignar,
 * con «Devueltos X de N». Cada lectura lo saca de la caja (0188/0206) y lo
 * vuelve a «por asignar», rechazo incluido (v1.23). La caja reemplazada por
 * otra salida (0248) vuelve a stock. Se recibe por SALIDA: un pedido puede
 * tener dos cajas «No entregado» con dos motorizados.
 */
export function ReturnsScanner({ orgId, pending }: { orgId: string; pending: PendingReturn[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const receiving = useRef(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  // `repeat`: ya estaba recibida en oficina; en ámbar (05-11-2026). Sí sale de
  // la lista —y cuenta en «Devueltos X de N»—, porque la caja ya está aquí.
  const [lines, setLines] = useState<{ code: string; ok: boolean; text: string; repeat?: boolean }[]>([]);
  const [returned, setReturned] = useState<Set<string>>(new Set());
  // El total se fija al abrir: la lista se refresca y no debe cambiar la meta.
  const [total] = useState(pending.length);
  const left = pending.filter((p) => !returned.has(p.shipmentId));

  async function run(code: string, row?: PendingReturn) {
    if (receiving.current || !code.trim()) return;
    receiving.current = true;
    setBusy(true);
    try {
      const res = row ? await returnUndeliveredOutputs(orgId, [row.shipmentId]) : await returnUndeliveredByCode(orgId, code);
      const byCodeName = "orderName" in res && typeof res.orderName === "string" ? res.orderName : null;
      const name: string = row ? row.orderName : byCodeName ?? code;
      // La caja reemplazada dice que se desarma; el resto, lo de siempre.
      const toStock = row?.replaced || /reemplazada/i.test(res.notice ?? "");
      const repeatReceipt = /ya estaban? recibid/i.test(res.notice ?? "");
      // Repetida solo si el aviso EMPIEZA por «ya estaba recibida»: este
      // escaneo no recibió nada nuevo. La caja ya está en la oficina, así que
      // sale de la lista (otra persona la recibió en otra pantalla).
      const repeat = !res.error && /^\d+ salidas? ya estaban? recibidas? en oficina/i.test(res.notice ?? "");
      setLines((cur) => [{
        code: name,
        ok: !res.error,
        repeat,
        text: res.error ?? (repeat && res.notice ? `${res.notice} · sale de la lista` : (toStock || repeatReceipt) && res.notice ? res.notice : "Devuelto a la oficina"),
      }, ...cur].slice(0, 50));
      if (!res.error || res.receivedShipmentIds?.length) {
        // Por QR: la fila de ESA salida. Por número de pedido, solo si el
        // pedido tiene una sola caja por recibir (si tiene dos, el servidor
        // pide el QR y no llega aquí).
        const scanned = code.trim().toLowerCase();
        const byCode = pending.find((p) => p.code?.toLowerCase() === scanned);
        const byName = pending.filter((p) => p.orderName === name);
        const hit = row?.shipmentId ?? byCode?.shipmentId ?? (byName.length === 1 ? byName[0]!.shipmentId : undefined);
        const receivedIds = res.receivedShipmentIds ?? (hit ? [hit] : []);
        if (receivedIds.length) setReturned((cur) => new Set([...cur, ...receivedIds]));
        router.refresh();
      }
    } catch {
      setLines((cur) => [{ code, ok: false, text: "No se pudo registrar. Reintenta el mismo código; no se duplicará." }, ...cur]);
    } finally {
      receiving.current = false;
      setBusy(false);
    }
  }

  const last = lines[0] ?? null;
  return (
    <div>
      <DispatchScanner busy={busy} disabled={false} compact look="ops" buttonLabel="Escanear" onScan={(code) => void run(code)} onCamera={() => setCameraOpen(true)} />
      <p className="mt-3 text-[13px] text-ink-500">Confirma que la devolución llegó a la oficina: <b className="font-semibold tabular-nums text-ink-900">{total - left.length} de {total}</b> recibidas{left.length ? `, faltan ${left.length}` : ""}. Vuelven a «por asignar», también los rechazados; la caja reemplazada por otra salida se desarma y vuelve a stock.</p>
      {lines.length > 0 && (
        <ul className="mt-3 max-h-40 divide-y divide-line overflow-auto rounded-lg text-sm ring-1 ring-line" aria-live="polite">
          {lines.map((l, i) => (
            <li key={`${l.code}:${i}`} className="flex items-center gap-2 px-3 py-2">
              <span className="font-semibold text-ink-900">{l.code}</span>
              <Badge tone={l.repeat ? "warn" : l.ok ? "ok" : "crit"} className="min-w-0">{l.text}</Badge>
            </li>
          ))}
        </ul>
      )}
      {/* Cuáles son: lo que falta devolver, del más antiguo al más reciente. */}
      <div className="mt-4 max-h-[55vh] overflow-auto rounded-lg ring-1 ring-line">
        <table className="w-full min-w-[720px] table-fixed text-sm">
          <colgroup>
            <col className="w-[8.5rem]" />
            <col />
            <col className="w-[7rem]" />
            <col className="w-[5.5rem]" />
            <col className="w-[11rem]" />
            <col className="w-[6rem]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-white text-left text-xs font-semibold text-ink-600 shadow-[inset_0_-1px_0_var(--color-line)]">
            <tr>
              <th className="px-3 py-2.5">Pedido</th>
              <th className="px-3 py-2.5">Cliente</th>
              <th className="px-3 py-2.5">Motorizado</th>
              <th className="px-3 py-2.5">Caja del</th>
              <th className="px-3 py-2.5">Motivo</th>
              <th className="px-3 py-2.5"><span className="sr-only">Recibir</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {left.map((p) => (
              <tr key={p.shipmentId} className="align-top transition-colors hover:bg-wash">
                <td className="px-3 py-2.5">
                  <p className="truncate font-semibold text-ink-900" title={p.orderName}>{p.orderName}</p>
                  {p.code && <p className="truncate font-mono text-[11px] text-ink-500" title={p.code}>{p.code}</p>}
                  {p.replaced && <Badge tone="info" title="El pedido ya salió con otra salida: al recibirla se desarma y vuelve a stock.">reemplazada · a stock</Badge>}
                </td>
                <td className="px-3 py-2.5"><p className="truncate text-ink-900" title={`${p.customerName} · ${p.district}`}>{p.customerName}</p><p className="truncate text-xs text-ink-500" title={p.district}>{p.district}</p></td>
                <td className="truncate px-3 py-2.5 text-ink-700" title={p.riderName}>{p.riderName}</td>
                <td className="px-3 py-2.5 tabular-nums text-ink-700">{p.routeDate ? `${p.routeDate.slice(8, 10)}/${p.routeDate.slice(5, 7)}` : "—"}</td>
                <td className="px-3 py-2.5"><Badge tone={p.reason === "rechazado" ? "urgent" : "crit"} title={nonDeliveryReasonLabel(p.reason)}>{nonDeliveryReasonLabel(p.reason)}</Badge></td>
                <td className="px-3 py-2 text-right"><OpsButton size="sm" disabled={busy} onClick={() => void run(p.orderName, p)}>Recibir</OpsButton></td>
              </tr>
            ))}
            {!left.length && <tr><td colSpan={6} className="px-3 py-10 text-center text-sm font-medium text-ok-fg">Todas las devoluciones están en la oficina.</td></tr>}
          </tbody>
        </table>
      </div>
      <DispatchCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onScan={(value) => void run(value)}
        continuous
        progress={{ done: total - left.length, total, verb: "Devueltos" }}
        status={last ? { ok: last.ok, warn: last.repeat, text: `${last.code}: ${last.text}` } : null}
      />
    </div>
  );
}

/** El tono de cada respuesta del manifiesto, como en el resto de escáneres. */
function manifestScanTone(res: ReturnManifestScanResult): BadgeTone {
  if (res.kind === "recibido") return "ok";
  if (res.kind === "informativa") return "neutral";
  if (res.kind === "error" || res.flags?.includes("reportada_entregada")) return "crit";
  return "warn";
}

type ManifestScanLine = { code: string; tone: BadgeTone; text: string; lineId?: string; needsNote: boolean };

/**
 * El mismo escáner en modo manifiesto de devolución (0307, owner 04-11-2026):
 * cada lectura se anota en el manifiesto y, si la caja se esperaba (o llegó sin
 * reporte), se recibe con la recepción de siempre. Lo que no se recibe queda
 * como observación con su motivo; la «no identificada» pide una nota. Cámara en
 * serie con «Recibidos X de Y esperados».
 */
export function ReturnManifestScanner({ manifestId, progress, disabled = false }: {
  manifestId: string;
  /** Lo esperado que ya llegó, frente a lo esperado. */
  progress: { done: number; total: number };
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const receiving = useRef(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [lines, setLines] = useState<ManifestScanLine[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [noteError, setNoteError] = useState<string | null>(null);

  async function run(code: string) {
    if (receiving.current || !code.trim() || disabled) return;
    receiving.current = true;
    setBusy(true);
    try {
      const res = await scanReturnManifest(manifestId, code);
      const text = res.error ?? res.notice ?? (res.kind === "recibido" ? "Recibido en oficina" : "Anotado");
      setLines((cur) => [{ code: code.trim(), tone: manifestScanTone(res), text, lineId: res.lineId, needsNote: Boolean(res.needsNote) }, ...cur].slice(0, 50));
      if (res.ok) router.refresh();
    } catch {
      setLines((cur) => [{ code, tone: "crit" as BadgeTone, text: "No se pudo registrar. Reintenta el mismo código; no se duplicará.", needsNote: false }, ...cur]);
    } finally {
      receiving.current = false;
      setBusy(false);
    }
  }

  async function saveNote(lineId: string) {
    const text = (notes[lineId] ?? "").trim();
    setNoteError(null);
    const res = await setReturnManifestLineNote(lineId, text);
    if (!res.ok) { setNoteError(res.error ?? "No se pudo guardar la nota."); return; }
    setLines((cur) => cur.map((l) => (l.lineId === lineId ? { ...l, needsNote: false, text: `${l.text} · Nota: ${text}` } : l)));
    router.refresh();
  }

  const last = lines[0] ?? null;
  return (
    <div>
      <DispatchScanner busy={busy} disabled={disabled} compact look="ops" buttonLabel="Escanear" hint="QR de la caja, código de salida o nº de pedido" onScan={(code) => void run(code)} onCamera={() => setCameraOpen(true)} />
      <p className="mt-3 text-[13px] text-ink-500">
        Escanea cada caja que trajo: <b className="font-semibold tabular-nums text-ink-900">{progress.done} de {progress.total}</b> esperadas recibidas. La esperada se recibe en oficina; la que llegó sin reporte se reporta «No entregado» y se recibe; la que figura entregada queda como incidencia y no se recibe. Si un pedido tiene dos cajas, escanea el QR.
      </p>
      {lines.length > 0 && (
        <ul className="mt-3 max-h-64 divide-y divide-line overflow-auto rounded-lg text-sm ring-1 ring-line" aria-live="polite">
          {lines.map((l, i) => (
            <li key={`${l.code}:${i}`} className="space-y-2 px-3 py-2">
              <div className="flex items-start gap-2">
                <span className="shrink-0 font-semibold text-ink-900">{l.code}</span>
                <Badge tone={l.tone} wrap className="min-w-0">{l.text}</Badge>
              </div>
              {l.needsNote && l.lineId && (
                <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void saveNote(l.lineId!); }}>
                  <label className="min-w-0 flex-1">
                    <span className="sr-only">Qué es esta caja</span>
                    <input
                      value={notes[l.lineId] ?? ""}
                      onChange={(e) => setNotes((cur) => ({ ...cur, [l.lineId!]: e.target.value }))}
                      placeholder="Qué es: lo que dice la caja, de quién es…"
                      maxLength={600}
                      className={cn(FIELD, "min-w-[12rem]")}
                    />
                  </label>
                  <OpsButton size="sm" type="submit" disabled={(notes[l.lineId] ?? "").trim().length < 3}>Anotar</OpsButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {noteError && <Banner tone="crit" role="alert" className="mt-2">{noteError}</Banner>}
      <DispatchCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onScan={(value) => void run(value)}
        continuous
        // Sin total: llegan también cajas que no se esperaban, y la cámara no
        // debe cerrarse sola al completar las esperadas.
        progress={{ done: progress.done, label: `Recibidos ${progress.done} de ${progress.total} esperados` }}
        status={last ? { ok: last.tone === "ok" || last.tone === "neutral", text: `${last.code}: ${last.text}` } : null}
      />
    </div>
  );
}
