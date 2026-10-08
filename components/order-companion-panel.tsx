"use client";

// Pedido acompañante en la ficha (MOM §32), dentro de «Salidas y guías».
//
// Tres caras, según el pedido:
//   - VIAJA en la caja de otro: dice cuál, con su guía y su estado, y deja
//     desvincularlo. Si esa caja se anuló sin salir, lo dice: ya no existe.
//   - LLEVA otros en su caja: los lista y dice cuánto tiene que cobrar la guía
//     en la puerta —la suma—, avisando si el courier informó otra cifra.
//   - NINGUNA de las dos y sin salida propia viva: ofrece vincularlo, primero
//     enseñando las cajas del principal con lo que impediría usar cada una.

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton } from "@/components/ops-ui";
import { IconArrowUpRight } from "@/components/icons";
import { fmtDate, fmtMoney } from "@/components/order-master-shared";
import {
  linkCompanionOrder,
  previewCompanionHost,
  unlinkCompanionOrder,
  type CompanionHostPreview,
} from "@/app/dashboard/pedidos/companion-actions";
import { COMPANION_REASON_MIN } from "@/lib/order-companion";
import { masterOrderHref } from "@/lib/order-drawer-href";
import type { OrderCompanionInfo } from "@/lib/orders-master-access";

const TEXTAREA = cn(FIELD, "h-auto py-2 leading-5");
const LINK =
  "inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 underline-offset-2 hover:underline pointer-coarse:min-h-11";

/** Cómo se lee la caja según su estado de entrega. */
const BOX_STATE: Record<string, string> = {
  pendiente: "En la empresa, por salir",
  en_ruta: "En ruta",
  entregado: "Entregada",
  anulado: "Anulada",
  transferido: "Transferida a otra guía",
};

function boxState(status: string | null | undefined): string {
  return (status && BOX_STATE[status]) || status || "—";
}

type Run = (action: () => Promise<{ error?: string; notice?: string }>) => Promise<boolean>;

export function OrderCompanionPanel({
  orderId,
  orderName,
  orderTotal,
  companion,
  canEdit,
  canBeCompanion,
  pending,
  run,
}: {
  orderId: string;
  orderName: string | null;
  orderTotal: number | null;
  companion: OrderCompanionInfo;
  canEdit: boolean;
  /** Sin salida propia viva ni expediente finalizado: puede viajar en otra caja. */
  canBeCompanion: boolean;
  pending: boolean;
  run: Run;
}) {
  if (companion.error) {
    return (
      <Banner tone="warn" title="No se pudo leer si este pedido viaja con otro">
        <p>{companion.error}</p>
      </Banner>
    );
  }
  if (companion.travelsIn) {
    return (
      <TravelsIn
        orderId={orderId}
        info={companion.travelsIn}
        canEdit={canEdit}
        pending={pending}
        run={run}
      />
    );
  }
  if (companion.carries.length) {
    return (
      <Carries
        orderTotal={orderTotal}
        companion={companion}
        canEdit={canEdit}
        pending={pending}
        run={run}
      />
    );
  }
  if (!canEdit || !canBeCompanion) return null;
  return <LinkForm orderId={orderId} orderName={orderName} pending={pending} run={run} />;
}

function TravelsIn({
  orderId,
  info,
  canEdit,
  pending,
  run,
}: {
  orderId: string;
  info: NonNullable<OrderCompanionInfo["travelsIn"]>;
  canEdit: boolean;
  pending: boolean;
  run: Run;
}) {
  const host = info.hostOrderName ?? "su pedido principal";
  return (
    <div className="space-y-3 rounded-lg bg-info-wash p-4" data-companion="viaja">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Badge tone="info">Pedido acompañante</Badge>
        <p className="text-sm font-semibold text-ink-900">Viaja en la caja de {host}</p>
      </div>
      <p className="text-[13px] leading-5 text-ink-700">
        <span className="capitalize">{info.courier ?? "Courier"}</span>
        {info.guideCode ? (
          <>
            {" "}
            · guía <span className="select-all font-mono font-semibold text-ink-900">{info.guideCode}</span>
          </>
        ) : null}{" "}
        · {boxState(info.deliveryStatus)} · vinculado el <span className="tabular-nums">{fmtDate(info.linkedAt)}</span>
      </p>
      <p className="text-[13px] leading-5 text-ink-600">
        No necesita rótulo ni guía propia: su estado, su entrega y su liquidación siguen a esa caja.
      </p>
      {!info.lends && (
        <Banner tone="warn" title="Esa caja ya no existe">
          <p>
            La guía se anuló sin salir de la empresa. Desvincúlalo y dale salida propia, o vincúlalo a la caja nueva de{" "}
            {host}.
          </p>
        </Banner>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link href={masterOrderHref(info.hostOrderId)} className={LINK}>
          Abrir {host}
          <IconArrowUpRight aria-hidden className="size-3.5" />
        </Link>
        {canEdit && (
          <UnlinkButton
            label={`Desvincular de ${host}`}
            pending={pending}
            onUnlink={(reason) => run(() => unlinkCompanionOrder(orderId, { reason }))}
          />
        )}
      </div>
    </div>
  );
}

function Carries({
  orderTotal,
  companion,
  canEdit,
  pending,
  run,
}: {
  orderTotal: number | null;
  companion: OrderCompanionInfo;
  canEdit: boolean;
  pending: boolean;
  run: Run;
}) {
  const companionsSum = companion.carries
    .filter((row) => row.lends)
    .reduce((sum, row) => sum + (row.companionTotal ?? 0), 0);
  const mismatch =
    companion.collectTotal != null &&
    companion.reportedCollect != null &&
    Math.abs(companion.collectTotal - companion.reportedCollect) > 0.005;
  return (
    <div className="space-y-3 rounded-lg bg-info-wash p-4" data-companion="lleva">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Badge tone="info">Caja compartida</Badge>
        <p className="text-sm font-semibold text-ink-900">
          Lleva también {companion.carries.length === 1 ? "otro pedido" : `${companion.carries.length} pedidos`} en su caja
        </p>
      </div>
      <ul className="divide-y divide-line rounded-md bg-white ring-1 ring-line">
        {companion.carries.map((row) => (
          <li key={row.companionOrderId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
            <Link href={masterOrderHref(row.companionOrderId)} className={LINK}>
              {row.companionOrderName ?? "Pedido"}
              <IconArrowUpRight aria-hidden className="size-3.5" />
            </Link>
            <span className="text-[13px] tabular-nums text-ink-900">{fmtMoney(row.companionTotal)}</span>
            {row.guideCode && <span className="font-mono text-xs text-ink-600">{row.guideCode}</span>}
            {!row.lends && <Badge tone="warn">Caja anulada sin salir</Badge>}
            {canEdit && (
              <span className="ml-auto">
                <UnlinkButton
                  label="Desvincular"
                  pending={pending}
                  onUnlink={(reason) => run(() => unlinkCompanionOrder(row.companionOrderId, { reason }))}
                />
              </span>
            )}
          </li>
        ))}
      </ul>
      {companion.collectTotal != null && (
        <p className="text-[13px] leading-5 text-ink-700">
          La guía debe cobrar en la puerta{" "}
          <strong className="font-semibold tabular-nums text-ink-900">{fmtMoney(companion.collectTotal)}</strong>{" "}
          <span className="tabular-nums">
            ({fmtMoney(orderTotal)} de este pedido + {fmtMoney(Math.round(companionsSum * 100) / 100)} de lo que lleva)
          </span>
          . La liquidación de esa guía se cuadra contra la suma.
        </p>
      )}
      {mismatch ? (
        <Banner tone="warn" title="El courier informa otro cobro">
          <p>
            Aliclik dice que esta guía cobra {fmtMoney(companion.reportedCollect)}, no {fmtMoney(companion.collectTotal)}.
            Corrige el monto en el portal de Aliclik antes de que salga, o la diferencia se cobra de menos.
          </p>
        </Banner>
      ) : companion.reportedCollect == null && companion.collectTotal != null ? (
        <p className="text-[13px] leading-5 text-ink-600">
          Comprueba en el portal de Aliclik que la guía cobre esa suma: de las guías creadas en el portal, Kapta no recibe el monto.
        </p>
      ) : null}
    </div>
  );
}

function UnlinkButton({
  label,
  pending,
  onUnlink,
}: {
  label: string;
  pending: boolean;
  onUnlink: (reason: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <OpsButton variant="ghost" size="sm" onClick={() => setOpen(true)} className="pointer-coarse:h-11">
        {label}
      </OpsButton>
    );
  }
  return (
    <div className="mt-1 w-full space-y-2 rounded-md bg-white p-3 ring-1 ring-line">
      <p className="text-[13px] leading-5 text-ink-700">
        El pedido vuelve a su propia situación —normalmente Preparación— y deja de seguir a esa caja. Queda en el historial
        de los dos pedidos.
      </p>
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        aria-label="Motivo de la desvinculación"
        placeholder="Motivo (obligatorio): p. ej. sale por separado, la clienta pidió dos envíos"
        className={cn(FIELD, "pointer-coarse:h-11")}
      />
      <div className="flex gap-2">
        <OpsButton
          variant="danger"
          size="sm"
          disabled={pending || reason.trim().length < COMPANION_REASON_MIN}
          onClick={async () => {
            if (await onUnlink(reason)) {
              setOpen(false);
              setReason("");
            }
          }}
          className="pointer-coarse:h-11"
        >
          Desvincular
        </OpsButton>
        <OpsButton
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setReason("");
          }}
          className="pointer-coarse:h-11"
        >
          Cancelar
        </OpsButton>
      </div>
    </div>
  );
}

function LinkForm({
  orderId,
  orderName,
  pending,
  run,
}: {
  orderId: string;
  orderName: string | null;
  pending: boolean;
  run: Run;
}) {
  const [open, setOpen] = useState(false);
  const [hostName, setHostName] = useState("");
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<CompanionHostPreview | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [shipmentId, setShipmentId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const reset = () => {
    setOpen(false);
    setHostName("");
    setPreview(null);
    setSearchError(null);
    setShipmentId(null);
    setReason("");
  };

  if (!open) {
    return (
      <div className="flex justify-end">
        <OpsButton variant="ghost" size="sm" onClick={() => setOpen(true)} className="pointer-coarse:h-11">
          ¿Viaja en la caja de otro pedido?
        </OpsButton>
      </div>
    );
  }

  const search = async () => {
    setSearching(true);
    setSearchError(null);
    setPreview(null);
    setShipmentId(null);
    try {
      const res = await previewCompanionHost(orderId, hostName);
      if ("error" in res) setSearchError(res.error);
      else {
        setPreview(res.preview);
        const usable = res.preview.options.filter((option) => !option.problem);
        setShipmentId(usable.length === 1 ? usable[0]!.shipmentId : null);
      }
    } catch {
      setSearchError("No se pudo buscar el pedido. Vuelve a intentarlo.");
    } finally {
      setSearching(false);
    }
  };

  const chosen = preview?.options.find((option) => option.shipmentId === shipmentId) ?? null;
  return (
    <div className="space-y-3 rounded-lg bg-wash p-4" data-companion="vincular">
      <div>
        <p className="text-sm font-semibold text-ink-900">Viaja en la caja de otro pedido</p>
        <p className="mt-0.5 text-[13px] leading-5 text-ink-700">
          Para cuando la misma clienta tiene dos pedidos —de Kenku y de Aurela, por ejemplo— y salen juntos con una sola guía de
          Aliclik que cobra los dos. {orderName ?? "Este pedido"} seguirá a esa caja: su entrega, su devolución y su liquidación.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="grid min-w-48 flex-1 gap-1.5 text-[13px] font-medium text-ink-700">
          Pedido principal (el que tiene la guía)
          <input
            value={hostName}
            onChange={(event) => setHostName(event.target.value)}
            placeholder="#AUR177622"
            autoComplete="off"
            className={cn(FIELD, "pointer-coarse:h-11")}
          />
        </label>
        <OpsButton type="submit" size="sm" disabled={searching || !hostName.trim()} className="pointer-coarse:h-11">
          {searching ? "Buscando…" : "Buscar"}
        </OpsButton>
      </form>
      {searchError && (
        <Banner tone="crit" role="alert">
          <p>{searchError}</p>
        </Banner>
      )}
      {preview && (
        <div className="space-y-3">
          <p className="text-[13px] leading-5 text-ink-700">
            <strong className="font-semibold text-ink-900">{preview.hostOrderName}</strong>
            {preview.hostCustomerName ? ` · ${preview.hostCustomerName}` : ""} · {fmtMoney(preview.hostTotal)}
          </p>
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-[13px] font-medium text-ink-700">¿En qué caja viaja?</legend>
            {preview.options.map((option) => (
              <label
                key={option.shipmentId}
                className={cn(
                  "flex items-start gap-2 rounded-md bg-white px-3 py-2 ring-1 ring-line",
                  option.problem ? "opacity-70" : "cursor-pointer",
                )}
              >
                <input
                  type="radio"
                  name="companion-host-shipment"
                  value={option.shipmentId}
                  disabled={Boolean(option.problem)}
                  checked={shipmentId === option.shipmentId}
                  onChange={() => setShipmentId(option.shipmentId)}
                  className="mt-1"
                />
                <span className="min-w-0 text-[13px] leading-5">
                  <span className="font-medium capitalize text-ink-900">{option.courier}</span>{" "}
                  <span className="font-mono text-xs text-ink-700">{option.guideCode ?? option.outputCode ?? "sin guía"}</span>{" "}
                  · {boxState(option.deliveryStatus)}
                  {option.problem && <span className="block text-warn-fg">{option.problem}</span>}
                </span>
              </label>
            ))}
          </fieldset>
          {chosen && (
            <>
              <p className="text-[13px] leading-5 text-ink-700">
                Con este pedido dentro, la guía {chosen.guideCode} debe cobrar en la puerta{" "}
                <strong className="font-semibold tabular-nums text-ink-900">{fmtMoney(preview.collectTotal)}</strong>.
                Compruébalo en el portal de Aliclik.
              </p>
              <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
                Por qué viajan juntos
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={2}
                  placeholder="p. ej. misma clienta, pidió por el catálogo especial; sale en una sola guía"
                  className={TEXTAREA}
                />
              </label>
            </>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <OpsButton
          variant="primary"
          size="sm"
          disabled={pending || !chosen || reason.trim().length < COMPANION_REASON_MIN}
          onClick={async () => {
            if (!chosen) return;
            if (await run(() => linkCompanionOrder(orderId, { hostShipmentId: chosen.shipmentId, reason }))) reset();
          }}
          className="pointer-coarse:h-11"
        >
          Vincular a esta caja
        </OpsButton>
        <OpsButton variant="ghost" size="sm" onClick={reset} className="pointer-coarse:h-11">
          Cancelar
        </OpsButton>
      </div>
    </div>
  );
}
