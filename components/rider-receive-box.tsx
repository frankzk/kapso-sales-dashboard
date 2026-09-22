"use client";

// «Recibir mi caja» (MOM §29.13): lo primero que ve el motorizado cuando la
// oficina ya cotejó su carga. Un escaneo por paquete; «No lo recojo» con
// motivo corto cuando algo no está, está dañado o no cabe. La ruta aparece
// recién cuando la caja quedó recibida.

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanAction } from "@/components/scan-action";
import { declineMyGfPackage, receiveMyGfPackage } from "@/app/reparto/receive";
import { DECLINE_REASONS } from "@/lib/rider-decline-reasons";
import type { RiderLoad, RiderLoadItem } from "@/lib/gf-rider-loads";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function RiderReceiveBox({ riderName, loads }: { riderName: string; loads: RiderLoad[] }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const busy = useRef(false);

  function receive(manifestId: string, value: string) {
    if (busy.current || !value.trim()) return;
    busy.current = true;
    start(async () => {
      try {
        const r = await receiveMyGfPackage(manifestId, value);
        setMessage(r.error ? { ok: false, text: r.error } : { ok: true, text: r.notice ?? "Paquete recibido." });
        if (!r.error) router.refresh();
      } catch {
        setMessage({ ok: false, text: "No pudimos confirmar la recepción. Reintenta el mismo código; no se duplicará." });
      } finally {
        busy.current = false;
      }
    });
  }

  function decline(manifestId: string, shipmentId: string, reasonCode: string, note: string) {
    start(async () => {
      const r = await declineMyGfPackage(manifestId, shipmentId, reasonCode, note);
      setMessage(r.error ? { ok: false, text: r.error } : { ok: true, text: r.notice ?? "Anotado." });
      if (!r.error) {
        setDeclining(null);
        router.refresh();
      }
    });
  }

  return (
    <main className="mx-auto min-h-screen max-w-md bg-slate-50 pb-24">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="text-base font-semibold text-slate-900">Recibir mi caja</h1>
        <p className="text-xs text-slate-500">{riderName} · escanea cada paquete que te entregan. Si uno no está, está dañado o no cabe, márcalo como «No lo recojo».</p>
      </header>
      {message && <p role="status" className={cn("mx-4 mt-3 rounded-lg px-3 py-2 text-sm", message.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>{message.text}</p>}
      {loads.map((load) => (
        <section key={load.id} aria-label={`Carga ${load.load_number} del ${load.route_date}`} className="m-4 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-baseline justify-between">
            <p className="font-semibold text-slate-900">{load.route_date} · Carga {load.load_number}</p>
            <p className="text-sm tabular-nums text-slate-700"><b>{load.received}</b> de {load.total} recibidos{load.declined ? ` · ${load.declined} no recogidos` : ""}</p>
          </div>
          <progress value={load.received} max={load.total || 1} aria-label="Paquetes recibidos" className="mt-2 h-2 w-full accent-brand-600" />
          <ScanAction context="motorizado_recepcion" manifestId={load.id} disabled={pending} continuous progress={{ done: load.received, total: load.total, verb: "Recibidos" }} onResult={(r) => { setMessage(r.error ? { ok: false, text: r.error } : { ok: true, text: r.notice ?? "Paquete recibido." }); if (!r.error) router.refresh(); }} />
          <ul className="mt-4 space-y-2">
            {load.items.map((item) => (
              <ReceiveRow
                key={item.id}
                item={item}
                pending={pending}
                declining={declining === item.id}
                onReceive={() => receive(load.id, item.output_code ?? item.guide_code ?? item.order_name ?? "")}
                onStartDecline={() => setDeclining(declining === item.id ? null : item.id)}
                onDecline={(code, note) => decline(load.id, item.shipment_id, code, note)}
              />
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

function ReceiveRow({ item, pending, declining, onReceive, onStartDecline, onDecline }: {
  item: RiderLoadItem;
  pending: boolean;
  declining: boolean;
  onReceive: () => void;
  onStartDecline: () => void;
  onDecline: (reasonCode: string, note: string) => void;
}) {
  const [reason, setReason] = useState<string>(DECLINE_REASONS[0].code);
  const [note, setNote] = useState("");
  const received = !!item.pickup_checked_at;
  const declined = !!item.pickup_declined_at;
  return (
    <li className={cn("rounded-xl border p-3", received ? "border-emerald-200 bg-emerald-50/60" : declined ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-white")}>
      <div className="flex items-start gap-3">
        <span aria-label={received ? "Recibido" : declined ? "No recogido" : "Pendiente"} className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-sm font-bold", received ? "bg-emerald-600 text-white" : declined ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-500")}>{received ? "✓" : declined ? "!" : "·"}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-950">{item.order_name ?? item.output_code ?? item.guide_code}</p>
          <p className="text-sm text-slate-600">{item.customer_name ?? "Cliente"} · {item.district ?? "Sin distrito"}</p>
          {declined && <p className="mt-1 text-xs text-amber-800">No lo recogiste: {item.pickup_declined_reason}</p>}
        </div>
      </div>
      {!received && !declined && (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={pending} onClick={onReceive} className="min-h-11 flex-1 rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white disabled:opacity-50">Lo tengo</button>
          <button type="button" disabled={pending} onClick={onStartDecline} aria-expanded={declining} className="min-h-11 rounded-lg border border-amber-300 px-3 text-sm font-medium text-amber-800 disabled:opacity-50">No lo recojo</button>
        </div>
      )}
      {declining && !received && !declined && (
        <div className="mt-2 space-y-2 rounded-lg bg-amber-50 p-2">
          <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Por qué no lo recoges" className="min-h-11 w-full rounded-lg border border-amber-300 px-2 text-sm">
            {DECLINE_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={reason === "otro" ? "Di en una línea qué pasó" : "Detalle (opcional)"} aria-label="Detalle" className="min-h-11 w-full rounded-lg border border-amber-300 px-2 text-sm" />
          <button type="button" disabled={pending} onClick={() => onDecline(reason, note)} className="min-h-11 w-full rounded-lg bg-amber-600 px-3 text-sm font-semibold text-white disabled:opacity-50">Confirmar que no lo recojo</button>
        </div>
      )}
    </li>
  );
}
