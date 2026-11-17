"use client";

// «Anular guía GF» en «Salidas y guías» de la ficha (MOM §29.17). Es la misma
// acción que la tarjeta GF Courier de la Mesa de ruta (`cancelGfCourierGuide`):
// la pide GF por su API, GF decide si puede y si cobra, y Kapta aplica lo que
// devuelve. Va también aquí porque es donde se mira la guía (owner, 17-11-2026:
// «no me deja cancelar la guía para poder ponerlo programado en Repro Lima con
// otro courier como Aliclik», #AUR901039).

import { useId, useState } from "react";
import { Banner, FIELD_BOX, OpsButton } from "@/components/ops-ui";
import { cancelGfCourierGuide } from "@/app/dashboard/pedidos/gf-courier-actions";

export function GfCourierCancelButton({
  orderId,
  guideCode,
  prepared,
  onDone,
}: {
  orderId: string;
  guideCode: string;
  /** GF ya preparó el paquete (Lista para recojo): anularla puede tener costo. */
  prepared: boolean;
  onDone: (notice: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <OpsButton size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Anular guía GF
      </OpsButton>
    );
  }
  const ready = reason.trim().length >= 5;
  return (
    <div className="w-full space-y-3 rounded-lg bg-white p-3 ring-1 ring-line">
      <p className="text-[13px] leading-5 text-ink-700">
        Anula <span className="font-mono font-medium text-ink-900">{guideCode}</span> en GF Courier.
        {prepared ? " GF ya preparó el paquete: puede cobrar la anulación y lo dice al anular." : " GF todavía no prepara el paquete: sin costo."}{" "}
        Después puedes acordar otro courier en Repro Lima o crear otra guía en la Mesa de ruta.
      </p>
      <div>
        <label htmlFor={id} className="block text-[13px] font-medium leading-5 text-ink-700">
          Motivo
        </label>
        <textarea
          id={id}
          rows={2}
          maxLength={500}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.currentTarget.value)}
          placeholder="Ej.: sale con Aliclik el viernes"
          className={`${FIELD_BOX} mt-1 w-full px-3 py-2`}
        />
      </div>
      {error && <Banner tone="crit">{error}</Banner>}
      <div className="flex flex-wrap gap-2">
        <OpsButton
          size="sm"
          variant="danger"
          disabled={busy || !ready}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const result = await cancelGfCourierGuide(orderId, reason);
              if (result.error) setError(result.error);
              else {
                setOpen(false);
                setReason("");
                onDone(result.notice ?? `Guía ${guideCode} anulada en GF Courier.`);
              }
            } catch {
              setError("No se pudo confirmar la anulación. Recarga la ficha antes de reintentar.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Anulando…" : "Anular en GF Courier"}
        </OpsButton>
        <OpsButton size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Volver
        </OpsButton>
      </div>
    </div>
  );
}
