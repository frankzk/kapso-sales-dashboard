"use client";

import { useMemo, useState } from "react";
import type {
  ClosureActionInput,
  ClosureActionKey,
} from "@/app/dashboard/pedidos/actions";
import { cn } from "@/components/ui";
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

export function OrderClosureDesk({
  stage,
  reasons,
  generalStatus,
  guides,
  permissions,
  pending,
  onAction,
}: {
  stage: string | null | undefined;
  reasons: MacroSubstage[];
  generalStatus: string;
  guides: ShipmentRow[];
  permissions: ClosurePermissions;
  pending: boolean;
  onAction: (input: ClosureActionInput) => Promise<boolean>;
}) {
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
      permissions.canFinalize
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
  }, [generalStatus, guides, permissions, reasons, stage]);

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

  return (
    <section className="rounded-xl border border-orange-200 bg-orange-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-800">
            Mesa de cierre
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Cada obligación se cierra con un hecho nuevo; el historial anterior no se modifica.
          </p>
        </div>
        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-orange-800 ring-1 ring-orange-200">
          {stage === "finalizado" ? "Cerrado" : `${reasons.length} pendiente${reasons.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {reasons.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {reasons.map((reason) => (
            <span key={reason} className="rounded-full bg-white px-2 py-1 text-xs text-orange-900 ring-1 ring-orange-200">
              {macroSubstageLabel(reason)}
            </span>
          ))}
        </div>
      )}

      {actions.length > 0 ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {actions.map((action) => {
            const meta = ACTION_META[action];
            return (
              <button
                key={action}
                type="button"
                disabled={pending}
                onClick={() => choose(action)}
                className={cn(
                  "rounded-lg border bg-white p-3 text-left transition hover:-translate-y-px hover:shadow-sm disabled:opacity-50",
                  meta.tone === "danger" ? "border-rose-200" : "border-orange-200",
                )}
              >
                <span className={cn("block text-sm font-semibold", meta.tone === "danger" ? "text-rose-800" : "text-slate-800")}>
                  {meta.label}
                </span>
                <span className="mt-1 block text-xs leading-4 text-slate-500">{meta.description}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs text-slate-500 ring-1 ring-orange-100">
          Tu rol puede consultar este cierre, pero no tiene una acción disponible sobre sus obligaciones actuales.
        </p>
      )}

      {selected && chosen && (
        <div className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div>
            <p className="text-sm font-semibold text-slate-900">{chosen.label}</p>
            <p className="text-xs text-slate-500">{chosen.description}</p>
          </div>
          {chosen.needsShipment && (
            <label className="block text-xs font-medium text-slate-600">
              Salida física
              <select
                value={shipmentId}
                onChange={(event) => setShipmentId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
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
            <label className="block text-xs font-medium text-slate-600">
              Monto (S/)
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
              />
            </label>
          )}
          <label className="block text-xs font-medium text-slate-600">
            Nota de auditoría
            <textarea
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Qué ocurrió, quién lo confirmó y qué evidencia se revisó"
              className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Referencia o evidencia (opcional)
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="N.º de operación, enlace, nombre de archivo o lote"
              className="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
            />
          </label>
          {selected === "refund_complete" && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
              Este botón no envía dinero. Úsalo solamente después de que Frankz haya hecho el reembolso.
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={
                pending ||
                !note.trim() ||
                (chosen.needsShipment && !shipmentId) ||
                (chosen.needsAmount &&
                  (!amount.trim() || !Number.isFinite(Number(amount)) || Number(amount) <= 0))
              }
              onClick={submit}
              className="rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
            >
              Guardar acción
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setSelected(null)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
