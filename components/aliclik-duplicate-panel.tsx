"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { getAliclikDuplicateHold, resolveAliclikDuplicate } from "@/app/dashboard/pedidos/aliclik-duplicate-actions";
import { DUPLICATE_DECISIONS, type DuplicateDecision, type DuplicateHold } from "@/lib/aliclik-duplicate";
import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";

export function AliclikDuplicatePanel({ orderId, initialHold, onGateChange, onChanged }: {
  orderId: string;
  initialHold?: DuplicateHold | null;
  onGateChange?: (allowed: boolean) => void;
  onChanged?: () => void;
}) {
  const id = useId();
  const [hold, setHold] = useState<DuplicateHold | null>(initialHold ?? null);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<DuplicateDecision | "">("");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    let alive = true;
    setHold(initialHold ?? null);
    setError(null);
    if (initialHold) return;
    void getAliclikDuplicateHold(orderId).then((result) => {
      if (!alive) return;
      if ("error" in result) setError(result.error);
      else setHold(result.hold);
    }).catch(() => { if (alive) setError("No se pudo verificar el posible duplicado. Reintenta."); });
    return () => { alive = false; };
  }, [orderId, initialHold]);
  useEffect(() => {
    onGateChange?.(Boolean(hold?.allowed && !error && !pending));
  }, [hold, error, pending, onGateChange]);

  const refresh = () => startTransition(async () => {
    setError(null);
    try {
      const result = await getAliclikDuplicateHold(orderId);
      if ("error" in result) { setHold(null); setError(result.error); }
      else { setHold(result.hold); onChanged?.(); }
    } catch { setHold(null); setError("No se pudo verificar el posible duplicado. Reintenta."); }
  });
  const save = () => {
    if (!decision || !hold?.fingerprint) return;
    startTransition(async () => {
      setError(null);
      try {
        const result = await resolveAliclikDuplicate(orderId, { decision, reason, fingerprint: hold.fingerprint! });
        if ("error" in result) setError(result.error);
        else { setHold(result.hold); setDecision(""); setReason(""); onChanged?.(); }
      } catch { setError("No se pudo guardar la resolución. Reintenta."); }
    });
  };
  if (hold && !hold.conflicts.length && !error) return null;
  return (
    <section aria-label="Revisión de posible duplicado" className={`space-y-2 rounded-lg border p-3 text-xs ${hold?.allowed && !error ? "border-emerald-300 bg-emerald-50 text-emerald-950" : "border-rose-300 bg-rose-50 text-rose-950"}`}>
      <p className="font-bold">{!hold && !error ? "Verificando historial para Aliclik" : hold?.allowed && !error ? "Duplicado revisado para Aliclik" : "Guía Aliclik retenida · posible duplicado"}</p>
      {error ? <p role="alert">{error}</p> : <p>{hold?.message ?? "Verificando otros envíos del mismo teléfono y producto…"}</p>}
      {hold?.conflicts.map((conflict) => (
        <p key={conflict.shipmentId}>
          <a className="font-semibold underline" href={`/dashboard/pedidos?abrir=${encodeURIComponent(conflict.orderId)}`} target="_blank" rel="noreferrer">{conflict.orderName}</a>
          {` · ${conflict.courier} · ${conflict.guideCode} · despachado, sin entrega ni recuperación registrada`}
        </p>
      ))}
      {hold?.resolution && <p>Última resolución: <strong>{DUPLICATE_DECISIONS[hold.resolution.decision]}</strong>. {hold.resolution.reason}</p>}
      {hold?.conflicts.length ? <>
        <p>Si quiere ambos: registra su confirmación y valida al menos {ADELANTO_MINIMO_LABEL} en este pedido. Si es reemplazo: espera la recuperación física del anterior.</p>
        {hold.canResolve && <>
          <label className="block font-semibold" htmlFor={`${id}-decision`}>Resolución del caso</label>
          <select id={`${id}-decision`} value={decision} onChange={(e) => setDecision(e.target.value as DuplicateDecision | "")} disabled={pending} className="w-full rounded border border-rose-200 bg-white p-2 text-slate-900">
            <option value="">Selecciona qué confirmó el cliente</option>
            {(Object.entries(DUPLICATE_DECISIONS) as [DuplicateDecision, string][]).filter(([key]) => key !== "exception" || hold.canOverride).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          {decision && <>
            <label className="block font-semibold" htmlFor={`${id}-reason`}>{decision === "both" ? "Detalle de la confirmación expresa (canal y qué indicó)" : "Motivo y gestión realizada"}</label>
            <textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} disabled={pending} className="w-full rounded border border-rose-200 bg-white p-2 text-slate-900" />
            <button type="button" onClick={save} disabled={pending || reason.trim().length < 12} className="rounded bg-rose-900 px-3 py-2 font-semibold text-white disabled:opacity-50">{pending ? "Guardando…" : "Registrar resolución"}</button>
          </>}
        </>}
      </> : null}
      <button type="button" onClick={refresh} disabled={pending} className="block font-semibold underline disabled:opacity-50">{pending ? "Actualizando…" : "Volver a verificar pagos y envíos"}</button>
    </section>
  );
}
