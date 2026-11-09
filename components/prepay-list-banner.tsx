"use client";

// La «Lista negra» agregada a mano en la ficha del pedido (MOM §41): el aviso
// de siempre (`ListaNegraBanner`, textos de lib/lista-negra-copy.ts), igual
// que la automática salvo el motivo y «pago total», y «Enviar link de pago»,
// que crea el link de Flow por lo que falta del total (el total, o el saldo si
// ya hay un adelanto) y lo muestra para copiar: Kapta no lo manda por
// WhatsApp. Sin nada que cobrar todavía no ofrece el botón.

import { useState, useTransition } from "react";
import { OpsButton } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import { copyLabel, useCopyToClipboard } from "@/components/copy-button";
import { ListaNegraBanner } from "@/components/lista-negra-banner";
import { prepayEntryMotivo, prepayEntryRequirementOf, type PrepayEntryRequirement, type PrepayEvidence } from "@/lib/prepay-list";

export interface PrepayBannerStatus {
  listed: boolean;
  fullyPaid?: boolean;
  /** Ya tiene lo que pide el alta (el adelanto validado, o el pago total). */
  met?: boolean;
  requirement?: PrepayEntryRequirement;
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
  onCreateLink,
  canCreateLink = false,
  className,
}: {
  status: PrepayBannerStatus | null;
  /** Crea el link de Flow por lo que falta. */
  onCreateLink?: () => Promise<PrepayLinkOutcome>;
  canCreateLink?: boolean;
  className?: string;
}) {
  const [result, setResult] = useState<PrepayLinkOutcome | null>(null);
  const { state: copyState, copy, reset: resetCopy } = useCopyToClipboard();
  const [pending, startTransition] = useTransition();
  if (!status?.listed) return null;
  const requirement = prepayEntryRequirementOf(status.requirement);
  const met = status.met ?? !!status.fullyPaid;
  const due = status.due ?? null;

  return (
    <ListaNegraBanner motivo={prepayEntryMotivo(status.reason)} requirement={requirement} context="order" met={met} className={className}>
      {!met && (
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
    </ListaNegraBanner>
  );
}
