"use client";

// La «Lista negra» automática en la ficha del pedido (MOM §41.11): el aviso de
// siempre (`ListaNegraBanner`, textos de lib/lista-negra-copy.ts) con las
// cuentas del propio cliente y, para quien tiene `prepay_list.manage`,
// «Exceptuar de la Lista negra» con motivo. Ningún dato de otros clientes.

import { useId, useState, useTransition } from "react";
import { OpsButton } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import { ListaNegraBanner } from "@/components/lista-negra-banner";
import { PAGO_ONLINE_REASON_MIN, pagoOnlineMotivo } from "@/lib/pago-online";
import { LN_EXCEPT_BUTTON, LN_EXCEPT_REASON_LABEL, LN_EXCEPT_REASON_PLACEHOLDER } from "@/lib/lista-negra-copy";

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
  if (!status) return null;
  return (
    <ListaNegraBanner
      motivo={pagoOnlineMotivo({ reason: status.reason, failed: status.failed, orders: status.orders })}
      requirement={status.requirement}
      context="order"
      met={status.met}
      className={className}
    >
      {status.canExcept && <ExceptControl onExcept={onExcept} canEdit={canEdit} />}
    </ListaNegraBanner>
  );
}

/** «Exceptuar de la Lista negra», con motivo. Lo usan la ficha del pedido y la búsqueda de la página. */
export function ExceptControl({
  onExcept,
  canEdit,
}: {
  onExcept?: (reason: string) => Promise<{ error?: string; notice?: string }>;
  canEdit: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<{ error?: string; notice?: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-2 space-y-2">
      {result?.notice ? null : !open ? (
        <OpsButton size="sm" disabled={!canEdit} onClick={() => setOpen(true)} className="pointer-coarse:h-11">
          {LN_EXCEPT_BUTTON}
        </OpsButton>
      ) : (
        <div className="space-y-1">
          <label htmlFor={id} className="text-[13px] font-medium text-ink-700">
            {LN_EXCEPT_REASON_LABEL}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={id}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={LN_EXCEPT_REASON_PLACEHOLDER}
              className={cn("h-8 min-w-0 flex-1 rounded-md bg-white px-2 text-[13px] text-ink-900 ring-1 ring-inset ring-line-strong pointer-coarse:h-11")}
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
              {pending ? "Guardando…" : LN_EXCEPT_BUTTON}
            </OpsButton>
          </div>
        </div>
      )}
      <div aria-live="polite" className="empty:hidden">
        {result?.error && <p className="text-[13px] text-crit-fg">{result.error}</p>}
        {result?.notice && <p className="text-[13px] text-ok-fg">{result.notice}</p>}
      </div>
    </div>
  );
}
