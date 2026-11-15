"use client";

// Panel del Master para GF Courier por API (MOM §29.17). Pregunta al servidor si corresponde mostrarse: la regla de
// elegibilidad vive en un solo lugar (gfCourierPanelState), no se repite en el navegador.
import { useCallback, useEffect, useState, useTransition } from "react";
import { cancelGfCourierGuide, createGfCourierGuide, gfCourierPanelState, type GfActionResult, type GfPanelState } from "@/app/dashboard/pedidos/gf-courier-actions";

export function GfCourierGuidePanel({ orderId, onChanged }: { orderId: string; onChanged?: () => void }) {
  const [state, setState] = useState<GfPanelState | null>(null);
  const [result, setResult] = useState<GfActionResult | null>(null);
  const [reason, setReason] = useState("");
  // Anular es destructivo y poco frecuente: primero un botón; el motivo se pide solo al elegirlo.
  const [cancelling, setCancelling] = useState(false);
  const [pending, start] = useTransition();
  const load = useCallback(() => { void gfCourierPanelState(orderId).then(setState).catch(() => setState(null)); }, [orderId]);
  useEffect(() => { load(); }, [load]);
  if (!state?.visible) return null;
  const live = state.guide && ["pendiente", "en_ruta"].includes(state.guide.status);
  const run = (fn: () => Promise<GfActionResult>) => start(async () => { const r = await fn(); setResult(r); load(); if (!r.error) onChanged?.(); });
  return (
    <div className="space-y-2 text-sm">
      <h3 className="font-semibold">GF Courier</h3>
      {state.guide ? (
        <p>Guía <strong>{state.guide.trackingId}</strong> · {state.guide.status}
          {state.guide.shippingCost != null ? ` · envío S/ ${Number(state.guide.shippingCost).toFixed(2)}` : ""}</p>
      ) : <p>Crea la guía de contraentrega en GF Courier: prepara, asigna motorizado, entrega y liquida.</p>}
      {state.reason ? <p className="text-warn-fg">{state.reason}</p> : null}
      {!live && state.canCreate ? (
        <button type="button" disabled={pending || Boolean(state.reason)} className="rounded-md bg-black px-3 py-1.5 text-white disabled:opacity-50"
          onClick={() => run(() => createGfCourierGuide(orderId))}>{pending ? "Creando…" : "Crear guía en GF Courier"}</button>
      ) : null}
      {live && state.canCancel && !cancelling ? (
        <button type="button" disabled={pending} className="rounded-md border px-3 py-1.5 disabled:opacity-50" onClick={() => setCancelling(true)}>Anular guía</button>
      ) : null}
      {live && state.canCancel && cancelling ? (
        <div className="flex flex-wrap items-center gap-2">
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo de la anulación (mínimo 5 letras)" className="min-w-0 flex-1 rounded-md border px-2 py-1" />
          <button type="button" disabled={pending || reason.trim().length < 5} className="rounded-md border border-crit-fg px-3 py-1.5 text-crit-fg disabled:opacity-50"
            onClick={() => run(async () => { const r = await cancelGfCourierGuide(orderId, reason); if (!r.error) { setCancelling(false); setReason(""); } return r; })}>{pending ? "Anulando…" : "Confirmar anulación"}</button>
          <button type="button" disabled={pending} className="px-2 py-1.5 text-ink-500 underline" onClick={() => { setCancelling(false); setReason(""); }}>Cancelar</button>
        </div>
      ) : null}
      {result?.notice ? <p role="status" className="text-ok-fg">{result.notice}</p> : null}
      {result?.error ? (
        <div role="alert" className="text-crit-fg">
          <p>{result.error}</p>
          {Array.isArray(result.allowed) && result.allowed.length ? <p className="text-xs">Válidos: {result.allowed.slice(0, 30).join(", ")}</p> : null}
          {result.pending ? <p className="text-xs">Vuelve a pulsar «Crear guía»: se reintenta con la misma clave y GF no duplica la guía.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
