"use client";

import { useState } from "react";
import { Banner, OpsButton } from "@/components/ops-ui";
import { GfCourierCancelButton } from "@/components/gf-courier-cancel-button";
import { GfOutputCancelButton } from "@/components/gf-output-cancel-button";
import { FenixCancelButton, ManualOutputCancelButton, ShalomCancelButton } from "@/components/order-master-shared";
import { cancelAliclikGuide } from "@/app/dashboard/pedidos/aliclik-actions";
import { gfCancelRequested } from "@/lib/gf-courier-status";
import { gfOutputIsCancelableBeforeDispatch } from "@/lib/gf-output-cancel";
import { shipmentIsReturning } from "@/lib/order-status";
import { fenixOutputIsCancelable, manualOutputIsCancelable, nombreDeCourier } from "@/lib/shipment-output";
import { shalomGuideIsCancelable } from "@/lib/shalom/draft";
import { legacySaleCancelBlocks } from "@/lib/legacy-sale-cancel";
import { wooSaleEndBlocks } from "@/lib/woo-sale-return";
import { wooCancelBlocks, type WooCancelFacts } from "@/lib/woo-cancel";
import { DISCARD_REASON_MIN } from "@/lib/recovery-discard";
import { reproSaleGuideBlocks } from "@/lib/repro-sale-cancel";
import type { OrderMasterDetail } from "@/lib/orders-master-access";

export type ReproSaleCancelContext = {
  mode: "woocommerce" | "woocommerce_return" | "shopify_history";
  facts: WooCancelFacts;
  guides: OrderMasterDetail["guides"];
  gfDeliveries: OrderMasterDetail["gfDeliveries"];
  filledOutputIds: string[];
  canCancelGfGuide: boolean;
  canEdit: boolean;
  canCreateShalomGuide: boolean;
  refresh: () => Promise<void>;
};

/** Las mismas guardas comerciales de Operar, sin interpretar la guía como venta. */
export function reproSaleCancelBlocks(context: Pick<ReproSaleCancelContext, "mode" | "facts">): string[] {
  return context.mode === "woocommerce" ? wooCancelBlocks(context.facts).map((b) => b.message)
    : [...(context.mode === "woocommerce_return" ? wooSaleEndBlocks : legacySaleCancelBlocks)(context.facts), ...reproSaleGuideBlocks(context.facts)];
}

export function ReproLimaSaleCancel({ orderId, orderName, context, reason, pending, onRefresh, onConfirm }: {
  orderId: string;
  orderName: string;
  context: ReproSaleCancelContext | null;
  reason: string;
  pending: boolean;
  onRefresh: () => void;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Otro pedido / cambio de nota exige una confirmación nueva. La clave del
  // padre remonta al cambiar de pedido; aquí la confirmación se liga al motivo.
  const [confirmedReason, setConfirmedReason] = useState("");
  const [confirmedState, setConfirmedState] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  if (!context) return <Banner tone="warn">Necesitas el permiso «Anular pedidos» para confirmar la venta desde aquí. El pedido todavía no se anuló.</Banner>;
  const blocks = reproSaleCancelBlocks(context);
  const live = context.guides.filter((g) => ["pendiente", "por_preparar", "en_ruta"].includes(g.delivery_status) && !g.returned_at);
  const state = JSON.stringify([context.mode, context.facts]);
  const ready = reason.trim().length >= DISCARD_REASON_MIN && reason.trim().length <= 500 && !blocks.length && !pending && !refreshing;
  async function refresh() {
    setConfirming(false); setRefreshing(true);
    try { await context!.refresh(); onRefresh(); }
    finally { setRefreshing(false); }
  }
  const done = (message: string) => { setNotice(message); void refresh(); };
  const scope = context.mode === "woocommerce" ? "en WooCommerce"
    : context.mode === "woocommerce_return" ? "en Kapta, con retorno pendiente" : "en Kapta";
  return <div className="space-y-4 border-t border-line pt-4" aria-label="Anular pedido desde Atender">
    <div className="space-y-2">
      <h4 className="text-[13px] font-semibold">1. Resolver guías y salidas</h4>
      {!live.length && <p className="text-[13px] text-ink-600">No hay guías activas pendientes de resolver.</p>}
      {live.map((g) => {
        const courier = g.courier.trim().toLowerCase();
        const gf = context.gfDeliveries.find((d) => d.shipmentId === g.id);
        const gfLocal = gfOutputIsCancelableBeforeDispatch(g) && !gf?.stop && !gf?.box?.pickupCheckedAt
          && !["in_custody", "cancelled"].includes(gf?.box?.boxState ?? "");
        const waitingGf = courier === "gf_courier" && gfCancelRequested(g.reported_status);
        const isReturning = g.custody_state === "retorno" || shipmentIsReturning({ deliveryStatus: g.delivery_status,
          courier: g.courier, swaypState: g.swayp_state ?? null, reportedStatus: g.reported_status ?? null });
        const hasAction = (courier === "gf_courier" && Boolean(g.guide_code) && !isReturning && !waitingGf && context.canCancelGfGuide)
          || gfLocal || (context.canEdit && (fenixOutputIsCancelable(g) || manualOutputIsCancelable(g) || courier === "aliclik"))
          || (context.canCreateShalomGuide && shalomGuideIsCancelable(g));
        return <div key={g.id} className="space-y-2 border-b border-line py-3 text-[13px]">
          <p className="font-medium">{nombreDeCourier(g.courier)} · {g.guide_code ?? g.output_code ?? "Sin guía"}</p>
          <p className="text-ink-600">{isReturning ? "Paquete retornando: falta recepción en almacén."
            : g.custody_state === "courier" ? "Paquete con el courier. Anular la guía no confirma su retorno."
              : g.custody_state === "empresa" ? "Paquete registrado en la empresa." : "Custodia pendiente de confirmar."}</p>
          {waitingGf && <p className="text-warn-fg">Anulación pedida a GF. La guía sigue activa hasta que GF la confirme.</p>}
          {courier === "gf_courier" && g.guide_code && !isReturning && !waitingGf && context.canCancelGfGuide &&
            <GfCourierCancelButton orderId={orderId} shipmentId={g.id} purpose="cancel_sale" defaultReason={reason} guideCode={g.guide_code} prepared={/^READY_FOR_PICKUP/i.test(g.reported_status ?? "")} onDone={done} />}
          {gfLocal && <GfOutputCancelButton orderId={orderId} shipmentId={g.id} label={g.output_code ?? g.guide_code ?? "esta salida"} onDone={done} />}
          {context.canEdit && fenixOutputIsCancelable(g) && <FenixCancelButton shipmentId={g.id} guideCode={g.guide_code} wasFilled={context.filledOutputIds.includes(g.id)} onDone={done} />}
          {context.canEdit && manualOutputIsCancelable(g) && <ManualOutputCancelButton shipmentId={g.id} label={g.output_code ?? g.guide_code ?? "esta salida"} onDone={done} />}
          {context.canCreateShalomGuide && shalomGuideIsCancelable(g) && <ShalomCancelButton shipmentId={g.id} guideCode={g.guide_code} codigo={g.shalom_codigo ?? null} onDone={done} />}
          {context.canEdit && courier === "aliclik" && <AliclikCancellation orderId={orderId} shipmentId={g.id} guideCode={g.guide_code} reason={reason} onDone={done} />}
          {!hasAction && !waitingGf && <p className="text-warn-fg">Esta guía requiere resolución por su responsable o permisos de su courier. Su pendiente se conserva.</p>}
        </div>;
      })}
      <OpsButton size="sm" variant="ghost" disabled={pending || refreshing} onClick={() => void refresh()}>{refreshing ? "Actualizando guías…" : "Actualizar estado de las guías"}</OpsButton>
    </div>
    {notice && <Banner tone="info" role="status">{notice}</Banner>}
    <div className="space-y-3">
      <h4 className="text-[13px] font-semibold">2. Confirmar anulación de la venta</h4>
      <p className="text-[13px] leading-5 text-ink-600">{context.mode === "woocommerce"
        ? "El pedido quedará cancelado en WooCommerce y en Kapta. WooCommerce repone su stock."
        : context.mode === "woocommerce_return"
          ? "La venta termina en Kapta y no se reintentará. WooCommerce y su stock esperan la recepción y el reingreso apto de todas las salidas. Retornos y liquidaciones siguen pendientes."
          : "La venta termina solo en Kapta. El original de Shopify se conserva; los retornos, inventario y liquidaciones mantienen sus pendientes."}</p>
      {blocks.length > 0 && <Banner tone="warn" title="Todavía no se puede confirmar"><ul className="list-disc space-y-1 pl-4">{blocks.map((b) => <li key={b}>{b}</li>)}</ul></Banner>}
      {(!confirming || confirmedReason !== reason || confirmedState !== state) ? <OpsButton variant="danger" className="h-auto min-h-9 whitespace-normal py-2" disabled={!ready} onClick={() => { setConfirmedReason(reason); setConfirmedState(state); setConfirming(true); }}>Revisar anulación de {orderName}</OpsButton>
        : <Banner tone="crit" title={`Se anula ${orderName} ${scope}`}>
          <p className="text-[13px]">Motivo: {reason}. Se registrará el resultado de la llamada con tu nombre.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <OpsButton variant="danger" className="h-auto min-h-9 whitespace-normal py-2" disabled={!ready} onClick={onConfirm}>{pending ? "Anulando…" : `Sí, anular ${orderName} ${scope}`}</OpsButton>
            <OpsButton variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>No anular</OpsButton>
          </div>
        </Banner>}
    </div>
  </div>;
}

/** Aliclik conserva su API, permiso y respuesta: no se edita la guía localmente. */
function AliclikCancellation({ orderId, shipmentId, guideCode, reason, onDone }: { orderId: string; shipmentId: string; guideCode: string | null; reason: string; onDone: (notice: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="space-y-2">
    {error && <Banner tone="crit" role="alert">{error}</Banner>}
    {!confirming ? <OpsButton size="sm" variant="danger" disabled={reason.trim().length < 8} onClick={() => setConfirming(true)}>Anular guía Aliclik</OpsButton>
      : <><p>¿Anular la guía {guideCode ?? "activa"} en Aliclik? La venta se confirma por separado.</p>
        <OpsButton size="sm" variant="danger" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            const result = await cancelAliclikGuide(orderId, reason, shipmentId);
            if (result.error) setError(result.error);
            else { setConfirming(false); onDone(result.notice ?? "Respuesta de Aliclik registrada. Actualiza para comprobar el estado."); }
          } catch { setError("No se pudo confirmar la respuesta de Aliclik. Actualiza antes de reintentar."); }
          finally { setBusy(false); }
        }}>{busy ? "Anulando…" : `Sí, anular guía ${guideCode ?? "Aliclik"}`}</OpsButton>
        <OpsButton size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Volver</OpsButton></>}
  </div>;
}
