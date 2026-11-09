"use client";

// El aviso de «Pago solo online (lista automática)» en la ficha del pedido
// (MOM §41.11): por qué este pedido no sale contra entrega, con las cuentas
// del propio cliente (entregas fallidas y 0 recibidas), lo que se cobra
// («Adelanto (regla §8)» o «Pago completo») y, para quien tiene
// `prepay_list.manage`, «Exceptuar» con motivo. Ningún dato de otros clientes.

import { useState, useTransition } from "react";
import { Banner, OpsButton } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import { PAGO_ONLINE_REASON_MIN, pagoOnlineHeadline } from "@/lib/pago-online";
import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";

export interface PagoOnlineBannerStatus {
  reason: "devuelto" | "anulador";
  failed: number | null;
  orders: number | null;
  requirement: "adelanto" | "pago_completo";
  requirementLabel: string;
  met: boolean;
  canExcept: boolean;
}

export function PagoOnlineBanner({
  status,
  onExcept,
  canEdit = false,
  className,
}: {
  status: PagoOnlineBannerStatus | null | undefined;
  onExcept?: (reason: string) => Promise<{ error?: string; notice?: string }>;
  canEdit?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<{ error?: string; notice?: string } | null>(null);
  const [pending, startTransition] = useTransition();
  if (!status) return null;
  // Las cuentas del propio cliente, y nada de otros.
  const counts =
    status.reason === "anulador"
      ? `Anuló ${status.failed ?? "?"} de ${status.orders ?? "?"} pedidos contra entrega y no recibió ninguno`
      : status.failed
        ? `${status.failed} ${status.failed === 1 ? "pedido devuelto" : "pedidos devueltos"} y 0 recibidos`
        : "0 recibidos";
  const title = pagoOnlineHeadline({ reason: status.reason, failed: status.failed, orders: status.orders }, status.requirement);
  const what = status.requirement === "adelanto" ? `el adelanto de ${ADELANTO_MINIMO_LABEL} validado (o el pago online completo)` : "el pago completo validado";

  return (
    <Banner tone={status.met ? "info" : "crit"} role={status.met ? "status" : "alert"} className={className} title={title}>
      <p className="mt-0.5 text-[13px] leading-5">
        {counts}, en los pedidos contra entrega de las tiendas. <span className="text-ink-500">Lista automática · se cobra: {status.requirementLabel}</span>
      </p>
      <p className="mt-1.5 text-[13px] leading-5">
        {status.met
          ? "Este pedido ya tiene lo que se pide: sigue."
          : `No se confirma contra entrega ni sale ninguna guía sin ${what}. Kapta no le escribe a la clienta sobre la lista.`}
      </p>
      {status.canExcept && !result?.notice && (
        <div className="mt-2 space-y-2">
          {!open ? (
            <OpsButton size="sm" disabled={!canEdit} onClick={() => setOpen(true)} className="pointer-coarse:h-11">
              Exceptuar a este cliente
            </OpsButton>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Motivo (por qué sí puede pagar contra entrega)"
                aria-label="Motivo de la excepción"
                className={cn("h-8 min-w-0 flex-1 rounded-md bg-white px-2 text-[13px] text-ink-900 ring-1 ring-inset ring-line-strong")}
              />
              <OpsButton
                size="sm"
                disabled={!onExcept || pending || reason.trim().length < PAGO_ONLINE_REASON_MIN}
                onClick={() => {
                  if (!onExcept) return;
                  setResult(null);
                  startTransition(async () => {
                    try {
                      setResult(await onExcept(reason));
                    } catch {
                      setResult({ error: "No se pudo guardar. Revisa la conexión y vuelve a intentar." });
                    }
                  });
                }}
                className="pointer-coarse:h-11"
              >
                {pending ? "Guardando…" : "Exceptuar"}
              </OpsButton>
            </div>
          )}
        </div>
      )}
      <div aria-live="polite" className="empty:hidden">
        {result?.error && <p className="mt-1 text-[13px] text-crit-fg">{result.error}</p>}
        {result?.notice && <p className="mt-1 text-[13px] text-ok-fg">{result.notice}</p>}
      </div>
    </Banner>
  );
}
