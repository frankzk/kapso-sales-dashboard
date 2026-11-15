"use client";

// «No se entregó» (owner, 15-11-2026; MOM §9.5, cuarta vuelta): en «Sin
// reporte de la ruta» del reparto propio, el equipo registra el no entregado
// por el motorizado cuando la clienta confirma que no lo recibió. Va por
// `reportStop`, el camino único de Coordinación: motivo del catálogo y la
// captura obligatoria (el chat o la llamada con la clienta). El motorizado igual
// tiene que devolver el paquete.
import { useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Banner, FIELD_BOX, OpsButton, choiceChipClass } from "@/components/ops-ui";
import { Sheet } from "@/components/filter-sheet";
import { PhotoCapture } from "@/components/photo-capture";
import { reportStop } from "@/app/reparto/actions";
import { loadNoEntregoStop, type NoEntregoStop } from "@/app/dashboard/pedidos/repro-lima/no-entrego-actions";
import { NON_DELIVERY_REASONS } from "@/lib/routes";
import { programDayLabel } from "@/lib/dispatch-day";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";

/** El motivo del reporte delegado (`reportStop` lo pide a quien reporta por el motorizado). */
export const NO_ENTREGO_REPORT_REASON = "Ruta sin reporte: la clienta confirmó en Repro Lima que no lo recibió.";

export function NoEntregoButton({ row, size = "sm", onDone }: {
  row: Pick<LimaPendingOrder, "orderId" | "orderName">;
  size?: "sm" | "md";
  onDone: (feedback: { kind: "notice" | "error"; text: string }) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [stop, setStop] = useState<NoEntregoStop | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function show() {
    setOpen(true);
    setError(null);
    setStop(null);
    loadNoEntregoStop(row.orderId)
      .then(setStop)
      .catch(() => setStop({ error: "No pudimos abrir la parada. Vuelve a intentarlo." }));
  }

  const ready = stop && "stopId" in stop ? stop : null;
  const missing = !reason ? "Elige por qué no se entregó." : reason === "otro" && !note.trim() ? "Con «Otro», escribe qué pasó." : !photoPath ? "Adjunta la captura del chat o de la llamada con la clienta." : null;

  function save() {
    if (!ready || missing || pending) return;
    setError(null);
    start(async () => {
      const result = await reportStop({
        stopId: ready.stopId,
        status: "no_entregado",
        paymentMethod: null,
        collectedAmount: null,
        outcomeReason: reason,
        note: note.trim() || null,
        photoPath,
        voucherPath: null,
        reportReason: NO_ENTREGO_REPORT_REASON,
      }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      if (!result.ok) {
        setError(result.error ?? "No se pudo registrar.");
        return;
      }
      setOpen(false);
      onDone({ kind: "notice", text: `${row.orderName}: no entregado registrado por ${ready.riderName}. Pasa a «Por reprogramar Lima»: acuerda el nuevo día en «Atender».` });
    });
  }

  return (
    <>
      <OpsButton ref={anchor} size={size} aria-expanded={open} onClick={() => (open ? setOpen(false) : show())} className="pointer-coarse:h-11">
        No se entregó
      </OpsButton>
      {open && (
        <Sheet look="ops" title={`No se entregó · ${row.orderName}`} onClose={() => setOpen(false)} anchored anchorRef={anchor}>
          <div className="w-full max-w-md space-y-3">
            {!stop && <p className="text-[13px] text-ink-500">Buscando la parada del motorizado…</p>}
            {stop && "error" in stop && <Banner tone="warn" role="status">{stop.error}</Banner>}
            {ready && (
              <>
                <p className="text-[13px] leading-5 text-ink-600">
                  Registras el no entregado por <b className="font-semibold text-ink-900">{ready.riderName}</b>
                  {ready.routeDate ? <> (ruta del {programDayLabel(ready.routeDate)})</> : null}. El pedido pasa a «Por reprogramar Lima» para acordar el nuevo día; {ready.riderName} igual tiene que devolver el paquete.
                </p>
                <fieldset>
                  <legend className="text-xs font-medium text-ink-600">¿Por qué no se entregó?</legend>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {NON_DELIVERY_REASONS.map((r) => (
                      <button key={r.code} type="button" aria-pressed={reason === r.code} onClick={() => setReason(r.code)} className={cn(choiceChipClass(reason === r.code), "pointer-coarse:h-11")}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className="grid gap-1 text-xs font-medium text-ink-600">
                  Nota{reason === "otro" ? "" : " (opcional)"}
                  <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="La clienta dice que nadie llegó el lunes" className={cn(FIELD_BOX, "h-9 w-full px-3 pointer-coarse:h-11")} />
                </label>
                <PhotoCapture stopId={ready.stopId} kind="entrega" photoPath={photoPath} label="Captura de la clienta (chat o llamada)" onResult={(r) => { if (r.path) setPhotoPath(r.path); }} />
              </>
            )}
            {error && <Banner tone="crit" role="alert">{error}</Banner>}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
              {ready && missing && <span className="mr-auto text-xs text-ink-500">{missing}</span>}
              <OpsButton variant="ghost" size="sm" onClick={() => setOpen(false)} className="pointer-coarse:h-11">Cancelar</OpsButton>
              <OpsButton variant="primary" size="sm" disabled={!ready || Boolean(missing) || pending} onClick={save} className="pointer-coarse:h-11">
                {pending ? "Registrando…" : "Registrar no entregado"}
              </OpsButton>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
