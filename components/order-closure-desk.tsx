"use client";

import { useMemo, useState } from "react";
import type {
  ClosureActionInput,
  ClosureActionKey,
} from "@/app/dashboard/pedidos/actions";
import { cn } from "@/components/ui";
import { Badge, Banner, CARD_ZONE, FIELD, OpsButton, SectionHead } from "@/components/ops-ui";
import {
  GF_ROUTE_PATH_LABEL,
  OVERRIDE_PERMISSION_LABEL,
  costBlockNeedsTariff,
  costTariffScreen,
  gfOpenRouteBlock,
  gfRouteReportHref,
  liquidationCostBlock,
  logisticsCostFactsFromRow,
  type ClosureGfDelivery,
  type LogisticsCostRow,
} from "@/lib/closure-blocks";
import type { GfTariffCheck } from "@/lib/gf-tariff";
import { macroSubstageLabel, type MacroSubstage } from "@/lib/order-macro-stage";
import { outputDisplayCode } from "@/lib/shipment-output";
import type { ShipmentRow } from "@/lib/types";

interface ClosurePermissions {
  canReturn: boolean;
  canInventory: boolean;
  canFinance: boolean;
  canFinalize: boolean;
  canRefund: boolean;
  canReopen: boolean;
  /** `costs.manage`: puede cargar la tarifa que falta en Costos › Costos logísticos. */
  canManageCosts: boolean;
  /** `logistics.manage`: puede cargar la de Grupo GF en Grupo GF Courier › Tarifario. */
  canManageLogistics: boolean;
}

interface ActionMeta {
  label: string;
  description: string;
  tone?: "normal" | "danger";
  needsShipment?: boolean;
  needsAmount?: boolean;
}

const ACTION_META: Record<ClosureActionKey, ActionMeta> = {
  return_request: {
    label: "Solicitar retorno",
    description: "La salida sigue fuera y debe volver físicamente.",
    needsShipment: true,
  },
  return_receive: {
    label: "Recibir devolución",
    description: "Almacén confirma que la caja ya regresó.",
    needsShipment: true,
  },
  inventory_restock: {
    label: "Reingresar a inventario",
    description: "Yelitza verificó la caja y el producto vuelve a estar disponible.",
    needsShipment: true,
  },
  inventory_merma: {
    label: "Cerrar como merma",
    description: "El producto no puede volver a inventario.",
    tone: "danger",
    needsShipment: true,
  },
  liquidation_observe: {
    label: "Observar liquidación",
    description: "El lote o el pago tiene una diferencia que debe resolverse.",
  },
  liquidation_close: {
    label: "Conciliar liquidación",
    description: "El dinero y el costo logístico ya cuadran.",
  },
  indemnity_request: {
    label: "Solicitar indemnización Aliclik",
    description: "Registra el reclamo y la referencia de sus evidencias.",
    needsShipment: true,
    needsAmount: true,
  },
  indemnity_resolve: {
    label: "Resolver indemnización",
    description: "Aliclik pagó o el reclamo quedó cerrado.",
    needsShipment: true,
  },
  refund_request: {
    label: "Solicitar reembolso",
    description: "Deja el caso pendiente para Frankz.",
    needsAmount: true,
  },
  refund_complete: {
    label: "Confirmar reembolso ejecutado",
    description: "Solo registra el hecho después de que Frankz envió el dinero.",
    needsAmount: true,
    tone: "danger",
  },
  customer_return_start: {
    label: "Abrir devolución del cliente",
    description: "La venta fue entregada y el cliente la devuelve después.",
  },
  customer_return_resolve: {
    label: "Resolver devolución del cliente",
    description: "La devolución posterior quedó conciliada.",
  },
  finalize: {
    label: "Finalizar expediente",
    description: "Confirma que no queda ninguna obligación abierta.",
  },
  reopen: {
    label: "Reabrir expediente",
    description: "Frankz o Yohalis vuelven a abrir un pedido finalizado.",
    tone: "danger",
  },
};

function unique(actions: ClosureActionKey[]): ClosureActionKey[] {
  return [...new Set(actions)];
}

const DESK_LINK = "font-medium text-brand-700 underline-offset-2 hover:underline";

/** «Grupo GF Courier › Rutas › «Reparto y liquidación»», con enlace a la ruta si se conoce. */
function GfRoutePath({ routeId }: { routeId: string | undefined }) {
  if (!routeId) return <>{GF_ROUTE_PATH_LABEL}</>;
  return (
    <>
      Grupo GF Courier › Rutas ›{" "}
      <a href={gfRouteReportHref(routeId)} className={DESK_LINK}>
        «Reparto y liquidación»
      </a>
    </>
  );
}

export function OrderClosureDesk({
  stage,
  reasons,
  generalStatus,
  guides,
  row,
  costTariffGap,
  gfDeliveries,
  cancelledInShopify,
  permissions,
  pending,
  onAction,
}: {
  stage: string | null | undefined;
  reasons: MacroSubstage[];
  generalStatus: string;
  guides: ShipmentRow[];
  /**
   * La fila del Master: con ella la Mesa avisa de la tarifa que falta antes del
   * clic, con el courier y el día que usa el recálculo.
   */
  row?: LogisticsCostRow;
  /**
   * Grupo GF (`detail.gfCostTariffGap`): por qué su Tarifario no le da tarifa y
   * desde cuándo rige la del distrito, lo mismo que dirá el servidor; o que ya
   * la tiene y la fila es vieja (`vigente`).
   */
  costTariffGap?: GfTariffCheck | null;
  /** Grupo GF (`detail.gfDeliveries`): con ellas la Mesa sabe si la ruta sigue abierta. */
  gfDeliveries?: readonly ClosureGfDelivery[];
  /**
   * `orders.cancelled_at` existe (Shopify o WooCommerce): cerrar la ruta no lo
   * marca entregado (MOM §11.4). Se dice «anulado en la tienda», el mismo texto
   * para las dos plataformas (MOM §38.12).
   */
  cancelledInShopify?: boolean;
  permissions: ClosurePermissions;
  pending: boolean;
  onAction: (input: ClosureActionInput) => Promise<boolean>;
}) {
  // Los motivos ya no son exclusivos de Por cerrar: confirmación también los
  // usa para el abono de Agencia. Esta mesa cierra obligaciones finales, así que
  // solo cuenta y muestra los suyos; si no, un pedido recién llamado aparecería
  // con «1 pendiente» en la mesa de cierre.
  const openReasons = stage === "por_cerrar" ? reasons : [];
  // Los mismos bloqueos que aplica el servidor (lib/closure-blocks.ts), dichos
  // antes del clic. La ruta de Grupo GF abierta quita «Finalizar expediente»:
  // ese pedido lo cierra la ruta, no esta mesa —y si está anulado en Shopify,
  // tampoco la ruta: decide una persona—. La tarifa que falta NO quita
  // «Conciliar liquidación»: el servidor recalcula el costo al guardar, y quien
  // acaba de cargar la tarifa tiene que poder conciliar sin esperar a que el
  // Master se recalcule solo.
  const gfRouteBlock =
    stage === "por_cerrar" ? gfOpenRouteBlock(guides, gfDeliveries ?? [], { cancelledInShopify }) : null;
  const gfRouteOpen = Boolean(gfRouteBlock);
  const liquidationOpen = reasons.includes("pendiente_liquidacion") || reasons.includes("liquidacion_observada");
  const costFacts =
    stage === "por_cerrar" && liquidationOpen && row
      ? { ...logisticsCostFactsFromRow(row), tarifario: costTariffGap ?? null }
      : null;
  const costBlock = costFacts
    ? liquidationCostBlock({
        ...costFacts,
        canManageCosts: permissions.canManageCosts,
        canManageLogistics: permissions.canManageLogistics,
      })
    : null;
  // Una tarifa lo arregla solo si se sabe el courier; el enlace a la pantalla
  // —Costos, o el Tarifario para Grupo GF—, además, solo a quien puede cargarla.
  const costNeedsTariff = Boolean(costFacts && costBlockNeedsTariff(costFacts));
  const costScreen = costTariffScreen(costFacts ?? { courier: null });
  const costLink =
    costNeedsTariff &&
    (costScreen.permission === "logistics.manage" ? permissions.canManageLogistics : permissions.canManageCosts);
  const actions = useMemo(() => {
    const next: ClosureActionKey[] = [];
    if (stage === "finalizado" && permissions.canReopen) next.push("reopen");
    if (stage !== "por_cerrar") return unique(next);

    if (reasons.includes("devolucion_fisica_pendiente") && permissions.canReturn) {
      next.push("return_request", "return_receive");
    }
    if (reasons.includes("devolucion_pendiente_inventario") && permissions.canInventory) {
      next.push("inventory_restock", "inventory_merma");
    }
    if (
      (reasons.includes("pendiente_liquidacion") || reasons.includes("liquidacion_observada")) &&
      permissions.canFinance
    ) {
      if (!reasons.includes("liquidacion_observada")) next.push("liquidation_observe");
      next.push("liquidation_close");
    }
    if (reasons.includes("indemnizacion_pendiente") && permissions.canFinance) {
      next.push("indemnity_resolve");
    }
    if (reasons.includes("reembolso_pendiente") && permissions.canRefund) {
      next.push("refund_complete");
    }
    if (reasons.includes("devolucion_cliente") && permissions.canReturn) {
      next.push("customer_return_resolve");
    }
    if (
      reasons.length > 0 &&
      reasons.every((reason) => reason === "validacion_cierre_pendiente") &&
      permissions.canFinalize &&
      !gfRouteOpen
    ) {
      next.push("finalize");
    }
    if (generalStatus === "entregado" && permissions.canReturn && !reasons.includes("devolucion_cliente")) {
      next.push("customer_return_start");
    }
    if (
      permissions.canFinance &&
      guides.some((guide) => guide.courier?.toLowerCase() === "aliclik") &&
      !reasons.includes("indemnizacion_pendiente")
    ) {
      next.push("indemnity_request");
    }
    if (permissions.canFinance && !reasons.includes("reembolso_pendiente")) {
      next.push("refund_request");
    }
    return unique(next);
  }, [generalStatus, gfRouteOpen, guides, permissions, reasons, stage]);

  const [selected, setSelected] = useState<ClosureActionKey | null>(null);
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [shipmentId, setShipmentId] = useState("");

  if (stage !== "por_cerrar" && stage !== "finalizado") return null;
  const chosen = selected ? ACTION_META[selected] : null;
  const selectableGuides = useMemo(() => {
    if (!selected) return guides;
    if (["inventory_restock", "inventory_merma"].includes(selected)) {
      return guides.filter(
        (guide) => guide.custody_state === "devuelto" || Boolean(guide.returned_at),
      );
    }
    if (["return_request", "return_receive"].includes(selected)) {
      return guides.filter(
        (guide) =>
          guide.delivery_status !== "entregado" &&
          guide.custody_state !== "empresa" &&
          guide.custody_state !== "devuelto" &&
          (selected !== "return_request" || guide.custody_state !== "retorno") &&
          !guide.returned_at,
      );
    }
    if (["indemnity_request", "indemnity_resolve"].includes(selected)) {
      return guides.filter((guide) => guide.courier?.toLowerCase() === "aliclik");
    }
    return guides;
  }, [guides, selected]);

  function choose(action: ClosureActionKey) {
    setSelected(action);
    const aliclik = guides.find((guide) => guide.courier?.toLowerCase() === "aliclik");
    setShipmentId(
      ["indemnity_request", "indemnity_resolve"].includes(action) && aliclik
        ? aliclik.id
        : "",
    );
    setNote("");
    setAmount("");
    setReference("");
  }

  async function submit() {
    if (!selected || !note.trim()) return;
    const saved = await onAction({
      action: selected,
      note,
      shipmentId: shipmentId || null,
      amount: amount.trim() ? Number(amount) : null,
      reference: reference.trim() || null,
    });
    if (saved) setSelected(null);
  }

  const FIELD_LABEL = "grid gap-1.5 text-[13px] font-medium text-ink-700";
  const canSave = !(
    pending ||
    !note.trim() ||
    (chosen?.needsShipment && !shipmentId) ||
    (chosen?.needsAmount &&
      (!amount.trim() || !Number.isFinite(Number(amount)) || Number(amount) <= 0))
  );

  return (
    <section className="space-y-4">
      <SectionHead
        title="Mesa de cierre"
        badge={
          <Badge tone={stage === "finalizado" ? "ok" : openReasons.length ? "warn" : "neutral"} className="tabular-nums">
            {stage === "finalizado"
              ? "Cerrado"
              : `${openReasons.length} pendiente${openReasons.length === 1 ? "" : "s"}`}
          </Badge>
        }
        help="Cada obligación se cierra con un hecho nuevo; el historial anterior no se modifica."
      />

      {openReasons.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Obligaciones abiertas">
          {openReasons.map((reason) => (
            <Badge key={reason} tone="warn">
              {macroSubstageLabel(reason)}
            </Badge>
          ))}
        </div>
      )}
      {/* Entrega declarada (MOM §8.3) no tiene botón aquí: la cierra el courier
          al reportarla o un admin fijando el estado. Sin esta línea sería un
          pendiente sin salida a la vista. Desde el 15-10-2026 el estado a mano
          es solo de owner y admin (MOM §16): la frase dice quién lo fija, porque
          esta mesa la ve también quien concilia o cierra sin ser admin. */}
      {openReasons.includes("entrega_declarada") && (
        <p className="text-[13px] leading-5 text-ink-600">
          Alguien declaró que el cliente recibió este envío y el courier no lo reportó. Confirma la entrega y el cobro
          con el courier; el estado lo fija un admin en «Gestión manual»: entregado si se confirmó; el que corresponda si
          no.
        </p>
      )}
      {/* Grupo GF: el motorizado reportó la entrega y la ruta sigue abierta
          (MOM §29.13). Finalizar no es el paso; lo es terminar la ruta. */}
      {gfRouteBlock?.kind === "ruta_abierta" && (
        <p className="text-[13px] leading-5 text-ink-600" data-closure-block="ruta-gf-abierta">
          El motorizado de Grupo GF ya reportó la entrega, pero su ruta sigue abierta. Termina la ruta en{" "}
          <GfRoutePath routeId={gfRouteBlock.routeIds[0]} />: al cerrarla, el pedido pasa a entregado y sigue a su
          liquidación.
        </p>
      )}
      {/* El mismo caso anulado en la tienda (#KP137541): la puerta a «entregado»
          no escribe sobre la anulación (MOM §11.4), así que cerrar la ruta no
          lo marca entregado. No se promete; decide una persona. */}
      {gfRouteBlock?.kind === "anulado_shopify" && (
        <p className="text-[13px] leading-5 text-ink-600" data-closure-block="ruta-gf-anulado-shopify">
          El motorizado de Grupo GF reportó la entrega y su ruta sigue abierta, pero el pedido está anulado en la tienda:
          terminar la ruta en <GfRoutePath routeId={gfRouteBlock.routeIds[0]} /> no lo marca entregado. Si la entrega
          vale, la cambia desde esta ficha («Gestión manual»), con motivo, quien tenga «{OVERRIDE_PERMISSION_LABEL}».
        </p>
      )}
      {/* Sin tarifa no hay costo, y sin costo la liquidación no cuadra (MOM §14). */}
      {costBlock && (
        <p className="text-[13px] leading-5 text-ink-600" data-closure-block="tarifa-faltante">
          {costBlock}
          {costLink && (
            <>
              {" "}
              <a href={costScreen.href} className={DESK_LINK}>
                {costScreen.link}
              </a>
            </>
          )}
        </p>
      )}

      {actions.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Acciones de cierre">
          {actions.map((action) => {
            const meta = ACTION_META[action];
            const active = selected === action;
            return (
              <button
                key={action}
                type="button"
                disabled={pending}
                aria-pressed={active}
                onClick={() => choose(action)}
                className={cn(
                  "rounded-lg p-3 text-left transition-shadow disabled:cursor-not-allowed disabled:opacity-50",
                  active
                    ? "bg-brand-50 ring-2 ring-inset ring-brand-600"
                    : "bg-white ring-1 ring-inset ring-line-strong hover:ring-ink-300",
                )}
              >
                <span
                  className={cn(
                    "block text-sm font-semibold",
                    meta.tone === "danger" ? "text-crit-fg" : active ? "text-brand-700" : "text-ink-900",
                  )}
                >
                  {meta.label}
                </span>
                <span className="mt-0.5 block text-[13px] leading-5 text-ink-500">{meta.description}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg bg-wash px-4 py-3 text-[13px] leading-5 text-ink-600">
          Tu rol puede consultar este cierre, pero no tiene una acción disponible sobre sus obligaciones actuales.
        </p>
      )}

      {selected && chosen && (
        // El formulario de la acción elegida es una zona más de la tarjeta.
        <div className={cn(CARD_ZONE, "space-y-4")}>
          <div>
            <p className="text-sm font-semibold text-ink-900">{chosen.label}</p>
            <p className="mt-0.5 text-[13px] leading-5 text-ink-500">{chosen.description}</p>
          </div>
          {chosen.needsShipment && (
            <label className={FIELD_LABEL}>
              Salida física
              <select
                value={shipmentId}
                onChange={(event) => setShipmentId(event.target.value)}
                className={cn(FIELD, "font-normal pointer-coarse:h-11")}
              >
                <option value="">Elige una salida</option>
                {selectableGuides.map((guide) => (
                  <option key={guide.id} value={guide.id}>
                    {outputDisplayCode(guide.output_code, guide.courier) || guide.guide_code} · {guide.courier} · {guide.delivery_status}
                  </option>
                ))}
              </select>
            </label>
          )}
          {chosen.needsAmount && (
            <label className={cn(FIELD_LABEL, "sm:w-48")}>
              Monto (S/)
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
              />
            </label>
          )}
          <label className={FIELD_LABEL}>
            Nota de auditoría
            <textarea
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Qué ocurrió, quién lo confirmó y qué evidencia se revisó"
              className={cn(FIELD, "h-auto py-2 font-normal leading-5")}
            />
          </label>
          <label className={FIELD_LABEL}>
            Referencia o evidencia (opcional)
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="N.º de operación, enlace, nombre de archivo o lote"
              className={cn(FIELD, "font-normal pointer-coarse:h-11")}
            />
          </label>
          {selected === "liquidation_close" && costBlock && (
            <Banner tone="warn">
              {costBlock}
              {costNeedsTariff &&
                " Al guardar se vuelve a calcular el costo: si la tarifa ya está cargada y rige el día del pedido, se concilia."}
            </Banner>
          )}
          {selected === "refund_complete" && (
            <Banner tone="crit">
              Este botón no envía dinero. Úsalo solamente después de que Frankz haya hecho el reembolso.
            </Banner>
          )}
          <div className="flex gap-2 pt-1">
            <OpsButton
              variant={chosen.tone === "danger" ? "danger" : "primary"}
              disabled={!canSave}
              onClick={submit}
              className="pointer-coarse:h-11"
            >
              Guardar acción
            </OpsButton>
            <OpsButton disabled={pending} onClick={() => setSelected(null)} className="pointer-coarse:h-11">
              Cancelar
            </OpsButton>
          </div>
        </div>
      )}
    </section>
  );
}
