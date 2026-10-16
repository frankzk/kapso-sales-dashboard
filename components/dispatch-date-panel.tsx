"use client";

// «Programar envío» en la ficha del pedido (MOM §6.2): la fecha acordada para
// despachar un pedido confirmado que todavía no tiene guía. Vive dentro de la
// tarjeta «Elegir ruta y generar el rótulo», que es justo donde se notaba que
// un pedido programado parecía olvidado.

import { useState, useTransition } from "react";
import { Badge, FIELD_BOX, OpsButton, type BadgeTone } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import { clearOrderDispatchDate, scheduleOrderDispatch } from "@/app/dashboard/pedidos/actions";
import { DISPATCH_DATE_MAX_DAYS, dispatchDateBadge } from "@/lib/dispatch-date";
import { AUTO_GUIDE_HINT } from "@/lib/aliclik-scheduled";

const TONE: Record<"info" | "warn" | "danger", BadgeTone> = { info: "info", warn: "warn", danger: "crit" };

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function DispatchDatePanel({
  orderId,
  scheduledOn,
  note,
  scheduledBy,
  today,
  autoAliclik = false,
  onSaved,
}: {
  orderId: string;
  scheduledOn: string | null;
  note: string | null;
  scheduledBy: string | null;
  /** Hoy en Lima, YYYY-MM-DD. */
  today: string;
  /** Provincia COD: ese día la guía Aliclik se crea sola (MOM §6.2). */
  autoAliclik?: boolean;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "edit" | "clear">("idle");
  const [date, setDate] = useState(scheduledOn ?? "");
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ error?: string; notice?: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      setMessage({ ok: true, text: result.notice ?? "Listo." });
      setMode("idle");
      setText("");
      onSaved();
    });
  }

  const badge = scheduledOn ? dispatchDateBadge(scheduledOn, today) : null;

  return (
    <div className="space-y-2" data-testid="dispatch-date-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {badge ? (
          <Badge tone={TONE[badge.tone]}>{badge.text}</Badge>
        ) : (
          <p className="text-[13px] text-ink-600">¿Se acordó despacharlo otro día? Prográmalo y no parecerá olvidado.</p>
        )}
        {mode === "idle" && (
          <>
            <OpsButton disabled={pending} onClick={() => { setDate(scheduledOn ?? ""); setMode("edit"); }} className="pointer-coarse:h-11">
              {scheduledOn ? "Cambiar fecha" : "Programar envío"}
            </OpsButton>
            {scheduledOn && (
              <OpsButton disabled={pending} onClick={() => setMode("clear")} className="pointer-coarse:h-11">
                Quitar
              </OpsButton>
            )}
          </>
        )}
      </div>
      {scheduledOn && (note || scheduledBy) && mode === "idle" && (
        <p className="text-[13px] text-ink-600">
          {note}
          {note && scheduledBy ? " · " : ""}
          {scheduledBy ? `programó ${scheduledBy}` : ""}
        </p>
      )}
      {autoAliclik && (scheduledOn || mode === "edit") && mode !== "clear" && (
        <p className="text-[13px] text-ink-500">{AUTO_GUIDE_HINT}</p>
      )}
      {mode === "edit" && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => scheduleOrderDispatch(orderId, { date, note: text }));
          }}
        >
          <label className="grid gap-1 text-[13px] font-medium text-ink-700">
            Sale el
            <input
              type="date"
              required
              value={date}
              min={today}
              max={addDays(today, DISPATCH_DATE_MAX_DAYS)}
              onChange={(e) => setDate(e.target.value)}
              className={cn(FIELD_BOX, "h-9 w-40 px-3 pointer-coarse:h-11")}
            />
          </label>
          <label className="grid min-w-48 flex-1 gap-1 text-[13px] font-medium text-ink-700">
            Nota (opcional)
            <input
              value={text}
              maxLength={500}
              placeholder="Ej.: recibe en su trabajo"
              onChange={(e) => setText(e.target.value)}
              className={cn(FIELD_BOX, "h-9 px-3 pointer-coarse:h-11")}
            />
          </label>
          <OpsButton type="submit" variant="primary" disabled={pending || !date} className="pointer-coarse:h-11">
            {pending ? "Guardando…" : "Guardar"}
          </OpsButton>
          <OpsButton type="button" disabled={pending} onClick={() => setMode("idle")} className="pointer-coarse:h-11">
            Cancelar
          </OpsButton>
        </form>
      )}
      {mode === "clear" && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => clearOrderDispatchDate(orderId, text));
          }}
        >
          <label className="grid min-w-48 flex-1 gap-1 text-[13px] font-medium text-ink-700">
            ¿Por qué se quita la fecha?
            <input
              required
              value={text}
              maxLength={500}
              placeholder="Ej.: la clienta pidió que salga ya"
              onChange={(e) => setText(e.target.value)}
              className={cn(FIELD_BOX, "h-9 px-3 pointer-coarse:h-11")}
            />
          </label>
          <OpsButton type="submit" disabled={pending || text.trim().length < 3} className="pointer-coarse:h-11">
            {pending ? "Quitando…" : "Quitar fecha"}
          </OpsButton>
          <OpsButton type="button" disabled={pending} onClick={() => setMode("idle")} className="pointer-coarse:h-11">
            Cancelar
          </OpsButton>
        </form>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={cn("text-[13px]", message.ok ? "text-ok-fg" : "text-crit-fg")}>
          {message.text}
        </p>
      )}
    </div>
  );
}
