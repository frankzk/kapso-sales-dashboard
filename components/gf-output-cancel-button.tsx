"use client";

import { useId, useState } from "react";
import { Banner, FIELD, OpsButton } from "@/components/ops-ui";
import { cancelGfOutputBeforeDispatch } from "@/app/dashboard/pedidos/gf-output-cancel-actions";

export function GfOutputCancelButton({ orderId, shipmentId, label, onDone }: {
  orderId: string; shipmentId: string; label: string; onDone: (notice: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <OpsButton size="sm" variant="ghost" onClick={() => setOpen(true)}>Retirar y anular salida</OpsButton>;
  return <div className="w-full space-y-3 rounded-lg border border-line bg-white p-3">
    <p className="text-[13px] leading-5">Retirar <strong>{label}</strong> de la caja de Grupo GF y anular su salida. El pedido se anula después desde «Anular pedido».</p>
    <label htmlFor={id} className="block text-[13px] font-medium">Motivo del retiro</label>
    <textarea id={id} className={FIELD} value={reason} maxLength={500} disabled={busy} onChange={(e) => setReason(e.target.value)} />
    <label className="flex items-start gap-2 text-[13px] leading-5"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />Confirmé que el paquete sigue en almacén y el motorizado no lo recibió.</label>
    {error && <Banner tone="crit">{error}</Banner>}
    <div className="flex gap-2">
      <OpsButton size="sm" disabled={busy || !confirmed || reason.trim().length < 5} onClick={async () => {
        setBusy(true); setError(null);
        try {
          const result = await cancelGfOutputBeforeDispatch(orderId, shipmentId, reason);
          if (result.error) setError(result.error);
          else onDone(result.notice ?? "Salida retirada y anulada.");
        } catch { setError("No se pudo confirmar el retiro. Recarga la ficha antes de reintentar."); }
        finally { setBusy(false); }
      }}>{busy ? "Retirando…" : "Confirmar retiro y anulación"}</OpsButton>
      <OpsButton size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Volver</OpsButton>
    </div>
  </div>;
}
