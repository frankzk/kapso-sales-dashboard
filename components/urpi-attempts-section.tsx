"use client";

import { useEffect, useState } from "react";
import { loadUrpiAttempts, type UrpiAttempt } from "@/app/dashboard/urpi/report-actions";
import { URPI_RESULT_LABEL } from "@/lib/urpi-report";

const dateLabel = (value: string | null) => value ? value.split("-").reverse().join("/") : "Sin fecha";
const money = (value: number) => new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" }).format(value);
const TONE: Record<string, string> = { entregado: "bg-emerald-500", cancelado: "bg-red-500", reprogramado: "bg-amber-500" };

/** Los intentos que Urpi reportó para el pedido (MOM §30.11). Solo informa: no
 * cambia el estado. Sin intentos, no se pinta. */
export function UrpiAttemptsSection({ orderId, className }: { orderId: string; className?: string }) {
  const [attempts, setAttempts] = useState<UrpiAttempt[] | null>(null);
  useEffect(() => {
    let alive = true;
    loadUrpiAttempts(orderId).then((rows) => { if (alive) setAttempts(rows); }).catch(() => { if (alive) setAttempts([]); });
    return () => { alive = false; };
  }, [orderId]);
  if (!attempts?.length) return null;
  return <section aria-label="Intentos de Urpi" className={className}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-base font-semibold text-ink-900">Intentos de Urpi</h3>
      <span className="text-xs text-ink-500">Según su reporte · {attempts[0]!.linkMethod === "manual" ? "vinculado a mano" : "vinculado por teléfono"}</span>
    </div>
    <ol className="mt-3 space-y-3">{attempts.map((attempt) => <li key={attempt.urpiRow} className="flex gap-3 text-sm">
      <span aria-hidden className={`mt-1.5 size-2.5 shrink-0 rounded-full ${TONE[attempt.resultCode] ?? "bg-slate-400"}`} />
      <div className="min-w-0">
        <div><span className="font-medium">{attempt.resultCode === "otro" ? attempt.resultWritten : URPI_RESULT_LABEL[attempt.resultCode]}</span>
          <span className="text-ink-500"> · {dateLabel(attempt.reportDate)}{attempt.reason ? ` · ${attempt.reason}` : ""}</span></div>
        {attempt.resultCode === "entregado" && <div className="text-xs text-ink-600">{attempt.paymentMethod ?? "Sin método"}{attempt.amountCollected !== null ? ` · ${money(attempt.amountCollected)}` : ""}{attempt.serviceFee !== null ? ` · servicio ${money(attempt.serviceFee)}` : ""}</div>}
        {attempt.detail && <p className="whitespace-pre-wrap text-xs text-ink-600">{attempt.detail}</p>}
        {attempt.evidence.length > 0 && <div className="mt-0.5 flex gap-2 text-xs">{attempt.evidence.map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer" className="text-brand-700 underline">Foto {i + 1} ↗</a>)}</div>}
      </div>
    </li>)}</ol>
  </section>;
}
