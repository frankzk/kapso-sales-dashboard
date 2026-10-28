"use client";

// «Anular pedido» en Gestión manual (§38.15-16). Mismo permiso específico:
// WooCommerce se anula en la tienda; una venta histórica Shopify, solo en Kapta.
//
// En su sitio y no en un modal: se abre en la misma zona, dice qué frena antes
// del clic (las reglas de lib/woo-cancel.ts, las mismas del servidor), pide el
// motivo en chips más una línea, y anula con un segundo clic en peligro que
// nombra el pedido. El servidor vuelve a comprobarlo todo (también los
// comprobantes, que la ficha no tiene a mano).

import { useEffect, useId, useState } from "react";
import { Banner, CARD_ZONE, FIELD, OpsButton, choiceChipClass } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import { wooSaleEndBlocks } from "@/lib/woo-sale-return";
import { LEGACY_SALE_CANCEL_REASONS, legacySaleCancelBlocks, validateLegacySaleCancelReason } from "@/lib/legacy-sale-cancel";
import {
  WOO_CANCEL_REASONS,
  WOO_CANCEL_REASON_MAX,
  WOO_CANCEL_REASON_MIN,
  validateWooCancelReason,
  wooCancelBlocks,
  type WooCancelFacts,
} from "@/lib/woo-cancel";

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function WooCancelZone({
  orderName,
  facts,
  pending,
  onCancel,
  mode = "woocommerce",
}: {
  mode?: "woocommerce" | "shopify_history" | "woocommerce_return";
  orderName: string | null;
  /** Lo que la ficha sabe; los comprobantes van en null (los mira el servidor). */
  facts: WooCancelFacts;
  pending: boolean;
  /** Llama a la acción; true si salió bien. */
  onCancel: (input: { reasonCode: string; reasonText: string; requestId: string }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  // Un id por confirmación: el doble clic o el reintento no anulan dos veces
  // ni dejan dos hechos en la Actividad.
  const [requestId, setRequestId] = useState("");
  const helpId = useId();
  useEffect(() => { setOpen(false); setCode(""); setText(""); setRequestId(""); }, [orderName, mode]);
  const historical = mode !== "woocommerce";
  const wooReturn = mode === "woocommerce_return";
  const blocks = historical ? (wooReturn ? wooSaleEndBlocks : legacySaleCancelBlocks)(facts).map((message, index) => ({ code: String(index), message })) : wooCancelBlocks(facts);
  const reason = historical ? validateLegacySaleCancelReason(code, text) : validateWooCancelReason(code, text);
  const reasons = historical ? LEGACY_SALE_CANCEL_REASONS : WOO_CANCEL_REASONS;
  const label = orderName ?? "este pedido";

  function start() {
    setRequestId(newRequestId());
    setCode("");
    setText("");
    setOpen(true);
  }

  async function confirm() {
    if (!reason.ok || pending) return;
    const ok = await onCancel({ reasonCode: code, reasonText: text, requestId });
    if (ok) setOpen(false);
  }

  return (
    <div className={cn(CARD_ZONE, "space-y-3")} data-woo-cancel>
      <div>
        <h4 className="text-sm font-semibold text-ink-900">{wooReturn ? "Terminar venta · retorno pendiente" : historical ? "Anular venta de pedido histórico" : "Anular pedido"}</h4>
        <p id={helpId} className="mt-0.5 text-[13px] leading-5 text-ink-600">
          {wooReturn ? "La venta termina en el Master y no habrá nuevos intentos. Se conserva el seguimiento de cada paquete. WooCommerce se cancelará y repondrá su stock cuando almacén confirme la recepción y el reingreso apto de todas las salidas." : historical
            ? "La venta termina en Kapta y no se intentará entregar nuevamente. El original de Shopify y el historial de sus salidas se conservan. Queda en la Actividad con tu nombre y el motivo."
            : "Lo pasa a «Cancelado» en WooCommerce, que devuelve el stock, sin entrar a wp-admin. No lo manda a la papelera. Queda en la Actividad con tu nombre y el motivo."}
        </p>
        {historical && <p className="mt-2 text-[13px] leading-5 text-ink-600">Las guías no se cancelan solas. Si hay una caja con el courier, un retorno, inventario o liquidación pendiente, deben resolverse por su propio flujo antes de finalizar.</p>}
      </div>

      {blocks.length > 0 ? (
        <Banner tone="warn" title="Todavía no se puede anular">
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {blocks.map((b, i) => (
              <li key={`${b.code}-${i}`}>{b.message}</li>
            ))}
          </ul>
        </Banner>
      ) : !open ? (
        <div>
          <OpsButton variant="secondary" disabled={pending} onClick={start} aria-describedby={helpId} className="pointer-coarse:h-11">
            {wooReturn ? "Terminar venta…" : "Anular pedido…"}
          </OpsButton>
        </div>
      ) : (
        <div className="space-y-3">
          <fieldset>
            <legend className="text-[13px] font-medium text-ink-700">Motivo</legend>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {reasons.map((r) => (
                <button
                  key={r.code}
                  type="button"
                  aria-pressed={code === r.code}
                  onClick={() => setCode(r.code)}
                  className={choiceChipClass(code === r.code)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
            Qué pasó
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              maxLength={WOO_CANCEL_REASON_MAX}
              placeholder="Llamó y pidió cancelar; se rehízo como #KP…"
              className={cn(FIELD, "h-auto py-2 font-normal leading-5")}
            />
            <span className="font-normal text-ink-500">
              Obligatorio, al menos {WOO_CANCEL_REASON_MIN} caracteres.
            </span>
          </label>
          <Banner tone="crit" title={`Se anula ${label} ${historical ? "en Kapta" : "en WooCommerce"}`}>
            <p>
              {historical
                ? "Confirmas que la venta terminó y no habrá más intentos de entrega. Esta acción no devuelve dinero ni stock y no confirma que una caja haya retornado. Si fue un error, un admin debe corregirlo desde la ficha, con motivo."
                : "La venta queda anulada en la tienda y en el Master. Volver atrás se hace en WooCommerce, reactivando el pedido."}
            </p>
          </Banner>
          <div className="flex flex-wrap gap-2">
            <OpsButton
              variant="danger"
              disabled={pending || !reason.ok}
              onClick={confirm}
              className="pointer-coarse:h-11"
            >
              {pending ? "Anulando…" : `Sí, anular ${label} ${historical ? "en Kapta" : "en WooCommerce"}`}
            </OpsButton>
            <OpsButton variant="ghost" disabled={pending} onClick={() => setOpen(false)} className="pointer-coarse:h-11">
              No anular
            </OpsButton>
          </div>
        </div>
      )}
    </div>
  );
}
