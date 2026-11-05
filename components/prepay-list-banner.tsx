"use client";

// El aviso de la «Lista de pago adelantado» (MOM §41) en la ficha del pedido
// y en la del lead: el cliente paga el total por adelantado, con el motivo, el
// origen (automático o manual) y los pedidos que lo dispararon. En la ficha
// del pedido, «Enviar link de pago» crea el link de Flow por lo que falta (el
// total, o el saldo si ya hay un adelanto) y lo muestra para copiar: Kapta no
// lo manda por WhatsApp. Sin nada que cobrar todavía no ofrece el botón.

import { useState, useTransition } from "react";
import { Banner, OpsButton } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import { copyLabel, useCopyToClipboard } from "@/components/copy-button";
import {
  PREPAY_LIST_LABEL,
  PREPAY_LIST_SYNONYM,
  PREPAY_TRIGGER_LABEL,
  prepaySourceLabel,
  type PrepayEvidence,
} from "@/lib/prepay-list";

export interface PrepayBannerStatus {
  listed: boolean;
  fullyPaid?: boolean;
  source?: "auto" | "manual";
  reason?: string;
  addedAt?: string;
  evidence?: PrepayEvidence;
  flowAvailable?: boolean;
  total?: number | null;
  due?: { kind: "total" | "diferencia"; amount: number; alreadyPaid: number } | null;
  dueProblem?: string | null;
}

export interface PrepayLinkOutcome {
  error?: string;
  link?: string;
  reused?: boolean;
  amount?: number;
  kind?: "total" | "diferencia";
}

const money = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function PrepayListBanner({
  status,
  context,
  onCreateLink,
  canCreateLink = false,
  className,
}: {
  status: PrepayBannerStatus | null;
  context: "order" | "lead";
  /** Solo en la ficha del pedido: crea el link de Flow por lo que falta. */
  onCreateLink?: () => Promise<PrepayLinkOutcome>;
  canCreateLink?: boolean;
  className?: string;
}) {
  const [result, setResult] = useState<PrepayLinkOutcome | null>(null);
  const { state: copyState, copy, reset: resetCopy } = useCopyToClipboard();
  const [pending, startTransition] = useTransition();
  if (!status?.listed) return null;
  const evidence = status.evidence?.kind === "auto" ? status.evidence.orders : [];
  const due = status.due ?? null;

  return (
    <Banner
      tone={status.fullyPaid ? "info" : "crit"}
      role={status.fullyPaid ? "status" : "alert"}
      className={className}
      title={`${PREPAY_LIST_LABEL}: este cliente paga el total por adelantado`}
    >
      <p className="mt-0.5 text-[13px] leading-5">
        {status.reason}
        <span className="text-ink-500">
          {" "}
          · {prepaySourceLabel(status.source ?? "manual")}
          {status.addedAt ? ` · desde el ${status.addedAt}` : ""}
        </span>
      </p>
      {evidence.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[13px] leading-5 text-ink-600">
          {evidence.slice(0, 5).map((o) => (
            <li key={`${o.order_id}:${o.kind}`}>
              {o.order_name ?? "Pedido"} · {PREPAY_TRIGGER_LABEL[o.kind]}
              {o.detail ? ` (${o.detail})` : ""}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1.5 text-[13px] leading-5">
        {status.fullyPaid
          ? "Este pedido ya está pagado completo: sigue, y su guía sale con cobro cero."
          : context === "order"
            ? "No se confirma contra entrega ni sale ninguna guía hasta que el total esté pagado y validado."
            : `Kapta no genera pedidos contra entrega para este celular (${PREPAY_LIST_SYNONYM}). Que pague el total en la web con «Tarjeta o Yape» (Flow).`}
      </p>

      {context === "order" && !status.fullyPaid && (
        <div className="mt-2 space-y-2">
          {!due ? (
            <p className="text-[13px] leading-5 text-ink-600">{status.dueProblem ?? "No hay un importe que cobrar por link."}</p>
          ) : status.flowAvailable ? (
            <OpsButton
              size="sm"
              disabled={!canCreateLink || pending || !onCreateLink}
              onClick={() => {
                if (!onCreateLink) return;
                setResult(null);
                resetCopy();
                startTransition(async () => {
                  try {
                    setResult(await onCreateLink());
                  } catch {
                    setResult({ error: "No se pudo crear el link. Revisa la conexión y vuelve a intentar." });
                  }
                });
              }}
              className="pointer-coarse:h-11"
            >
              {pending
                ? "Creando link…"
                : due.kind === "total"
                  ? `Enviar link de pago (total ${money(due.amount)})`
                  : `Enviar link de pago (saldo ${money(due.amount)})`}
            </OpsButton>
          ) : (
            <p className="text-[13px] leading-5 text-ink-600">
              {due.kind === "total"
                ? "La tienda no tiene Flow configurado: pide el pago total por Yape y súbelo como «Pago total»."
                : `La tienda no tiene Flow configurado: pide el saldo (${money(due.amount)}) por Yape y súbelo como «Diferencia».`}
            </p>
          )}
          {due?.kind === "diferencia" && (
            <p className="text-xs text-ink-500">Ya tiene {money(due.alreadyPaid)} validados: el link cobra solo lo que falta para el total.</p>
          )}
          <div aria-live="polite" className="empty:hidden">
            {result?.error && <p className="text-[13px] text-crit-fg">{result.error}</p>}
            {result?.link && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  readOnly
                  value={result.link}
                  aria-label={result.kind === "diferencia" ? "Link de pago del saldo" : "Link de pago del total"}
                  onFocus={(e) => e.currentTarget.select()}
                  className={cn("h-8 min-w-0 flex-1 rounded-md bg-white px-2 text-[13px] text-ink-900 ring-1 ring-inset ring-line-strong")}
                />
                <OpsButton size="sm" onClick={() => copy(result.link!)}>
                  {copyLabel(copyState)}
                </OpsButton>
                <p className="w-full text-xs text-ink-500">
                  {result.amount ? `${money(result.amount)}. ` : ""}
                  {result.reused ? "Es el link que ya estaba vivo por este importe." : "Link nuevo."} Cópialo y envíaselo a la clienta: Kapta no
                  lo manda solo. Al pagarse, el pago entra validado.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </Banner>
  );
}
