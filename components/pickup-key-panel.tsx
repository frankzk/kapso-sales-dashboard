"use client";

// Panel de pagos Yape y gestión de la credencial Shalom dentro del pedido.
//
// En el mundo de operación de DESIGN.md (03-10-2026): el cobro es una tarjeta
// más de la ficha, con su título y su estado en chapa como las demás; los
// comprobantes, el registro y la credencial son zonas sobre hairlines, y el
// registro es una escalera de tres pasos con su disco y su estado.
//
// La clave NUNCA aparece en el listado ni en exportaciones: solo aquí, tras una
// acción explícita, y cada visualización queda registrada. El botón de mostrar
// solo aparece cuando el servidor ya dijo que se puede — y aun así el servidor
// lo vuelve a comprobar antes de descifrar nada.

import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { cn } from "@/components/ui";
import {
  Badge,
  Banner,
  CARD_ZONE,
  FIELD,
  FIELD_BOX,
  OpsButton,
  SectionHead,
  Skeleton,
  Step,
  type BadgeTone,
} from "@/components/ops-ui";
import {
  IconAlert,
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconImage,
  IconX,
} from "@/components/icons";
import {
  completePaymentData,
  overridePaymentValidation,
  createVoucherUpload,
  loadPaymentPanel,
  readVoucherFields,
  registerPayment,
  rejectPayment,
  revealPickupKey,
  setPickupKey,
  sharePickupKey,
  sendPickupKeyByWhatsapp,
  validatePayment,
  type PaymentRow,
  type PickupKeyPanel as PanelData,
} from "@/app/dashboard/pedidos/payment-actions";
import {
  loadShalomOrderDraft,
  lookupShalomPerson,
  saveShalomOrderDraft,
  searchShalomAgencies,
} from "@/app/dashboard/pedidos/shalom-actions";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import {
  PAYMENT_STATE_LABEL,
  SHALOM_MINIMUM_ADVANCE,
  nextPaymentKinds,
  paymentProgress,
  type PaymentKind,
  type PaymentState,
} from "@/lib/pickup-key";
import type { OrderPaymentPanelMode } from "@/lib/order-payment-panel";
import {
  describeCollectionAccount,
  verifyYapeRecipient,
  yapeRecipientReadingFromVision,
  type CollectionAccount,
  type YapeRecipientReading,
} from "@/lib/yape-recipient";
import { operationalLabel } from "@/lib/order-status";
import { documentError, shalomDraftDocumentToSave } from "@/lib/shalom/draft";
import type { ShalomAgency, ShalomDocumentType } from "@/lib/shalom/types";

const VOUCHER_BUCKET = "yape-vouchers";

const STATUS_LABEL: Record<string, string> = {
  pendiente_revision: "Pendiente de revisión",
  validado: "Validado",
  rechazado: "Rechazado",
  posible_duplicado: "Posible duplicado",
  info_incompleta: "Información incompleta",
  revision_admin: "En revisión administrativa",
};

const STATUS_TONE: Record<string, BadgeTone> = {
  validado: "ok",
  rechazado: "neutral",
  posible_duplicado: "crit",
  info_incompleta: "warn",
};

/** El estado del cobro en la chapa de la cabecera; el texto lo dice igual. */
const PAYMENT_STATE_TONE: Record<PaymentState, BadgeTone> = {
  sin_pago: "warn",
  adelanto_cargado: "info",
  adelanto_validado: "info",
  diferencia_cargada: "info",
  pago_total_cargado: "info",
  pago_completo: "ok",
  posible_duplicado: "crit",
};

/** Etiqueta de un campo de formulario. */
const LABEL = "grid gap-1.5 text-[13px] font-medium text-ink-700";

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(+d)
    ? "—"
    : d.toLocaleString("es-PE", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

/** sha256 del archivo, en el navegador: es la huella que detecta la re-subida. */
async function fileSha256(file: File): Promise<string | null> {
  try {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/**
 * Carga del panel, compartida por los dos que lo usan.
 *
 * Está extraída porque el arreglo tenía que caer en los dos sitios y estaban
 * copiados letra por letra: el siguiente que toque uno no puede dejar al otro
 * atrás. Lo que arregla es que un fallo de carga se vea COMO fallo — antes la
 * server action podía devolver "Sin acceso a este pedido." y esa frase no
 * llegaba nunca a la pantalla, porque el `return` de "Cargando…" iba por delante
 * del sitio donde se pinta el error.
 */
function usePaymentPanel(orderId: string) {
  const [panel, setPanel] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reload = useMemo(
    () => async () => {
      try {
        const res = await loadPaymentPanel(orderId);
        if ("error" in res) setError(res.error);
        else {
          setPanel(res.panel);
          setError(null);
        }
      } catch {
        // Una server action que no llega —red caída, despliegue a medias, sesión
        // caducada— deja la promesa rechazada. Sin este catch el panel se
        // quedaba en "Cargando pagos…" para siempre: ni error, ni reintento, ni
        // forma de saber que había un comprobante esperando del otro lado.
        setError("No se pudo cargar el panel de pagos. Revisa la conexión y vuelve a intentarlo.");
      }
    },
    [orderId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { panel, error, setError, notice, setNotice, pending, startTransition, reload };
}

/**
 * Lo que se enseña cuando el panel NO cargó: el motivo y un botón para volver a
 * intentar. Nunca el contenido del panel — un panel vacío por error se lee como
 * "este pedido no tiene pagos", que es justo lo contrario de lo que pasó.
 */
function PanelLoadError({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      <Banner tone="crit" role="alert">
        {message}
      </Banner>
      <OpsButton size="sm" onClick={onRetry} className="pointer-coarse:h-11">
        Intentar nuevamente
      </OpsButton>
    </div>
  );
}

export function PickupKeyPanel({
  orderId,
  onChanged,
  mode = "required",
  gatewayNote = null,
}: {
  orderId: string;
  onChanged: () => void;
  mode?: OrderPaymentPanelMode;
  /**
   * Cuando Shopify dice «pagado» pero NO lo cobró el checkout (lo marcó alguien
   * a mano): se dice, para que se entienda por qué el panel sigue pidiendo la
   * constancia. Solo el checkout se la salta (lib/payment-gateway.ts).
   */
  gatewayNote?: string | null;
}) {
  const { panel, error, setError, notice, setNotice, pending, startTransition, reload } =
    usePaymentPanel(orderId);

  function run(action: () => Promise<{ error?: string; notice?: string }>) {
    startTransition(async () => {
      const res = await action();
      setError(res.error ?? null);
      setNotice(res.notice ?? null);
      if (!res.error) {
        await reload();
        onChanged();
      }
    });
  }

  const paymentOptional = mode === "optional";
  // La cabecera es la misma mientras carga, si falla y con el panel listo: la
  // tarjeta dice qué es antes de saber cuánto se cobró.
  const head = (badge?: ReactNode) => (
    <SectionHead
      title={mode === "prepaid" ? "Cobro" : "Cobro para envío por agencia"}
      badge={badge}
      help={
        mode === "prepaid"
          ? undefined
          : paymentOptional
            ? "Opcional para Provincia COD. Úsalo si el pedido irá por Agencia o el historial del cliente exige adelanto."
            : "El pago acumulado habilita la guía; el pago completo permite entregar la clave desde la salida Shalom."
      }
    />
  );

  if (!panel) {
    if (error) {
      return (
        <section className="space-y-4">
          {head()}
          <PanelLoadError message={error} onRetry={() => void reload()} />
        </section>
      );
    }
    return (
      <section className="space-y-4">
        {head()}
        <div className="space-y-2" aria-busy="true" aria-label="Cargando pagos">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      </section>
    );
  }

  // PAGADO EN EL CHECKOUT: no hay cobro que gestionar. El panel colapsa a una
  // constancia en vez de pedir un comprobante de Yape y enseñar «saldo por
  // cargar» sobre dinero que ya entró. Lo que SÍ sigue haciendo falta en Agencia
  // —el DNI y la agencia de Shalom— no es cobro: son datos de entrega, y viven
  // en el panel de la salida, no acá.
  if (mode === "prepaid") {
    return (
      <section className="@container space-y-4">
        {head(<Badge tone="ok">Pagado por web</Badge>)}
        <Banner tone="ok">
          Este pedido se pagó en el checkout
          {panel.orderTotal != null ? (
            <span className="tabular-nums">: S/ {panel.orderTotal.toFixed(2)}</span>
          ) : null}
          . No hay que cobrar en la entrega ni cargar comprobante.
        </Banner>
        {error && (
          <Banner tone="crit" role="alert">
            {error}
          </Banner>
        )}
        {/* Si además hay comprobantes cargados se siguen listando: un pedido
            puede tener historia de Yape antes de haberse pagado por web, y
            esconderla dejaría dinero registrado sin rastro en pantalla. */}
        {panel.payments.length > 0 && (
          <PaymentList
            payments={panel.payments}
            accounts={panel.collectionAccounts}
            customerName={panel.customerName}
            canValidate={panel.canValidate}
            canRegister={false}
            pending={pending}
            onValidate={(id, sendKey) => run(() => validatePayment(id, { sendKey }))}
            onReject={(id, reason) => run(() => rejectPayment(id, reason))}
            onComplete={(id, data) => run(() => completePaymentData(id, data))}
            canOverride={panel.canOverride}
            onReassign={(id, targetOrderName, reason) =>
              run(() => overridePaymentValidation(id, { targetOrderName, reason }))
            }
          />
        )}
      </section>
    );
  }

  const paymentLabel =
    paymentOptional && panel.paymentState === "sin_pago"
      ? "Sin pago requerido"
      : PAYMENT_STATE_LABEL[panel.paymentState as PaymentState] ?? panel.paymentState;
  const paymentTone: BadgeTone =
    paymentOptional && panel.paymentState === "sin_pago"
      ? "neutral"
      : PAYMENT_STATE_TONE[panel.paymentState as PaymentState] ?? "neutral";

  return (
    <section className="@container space-y-4">
      {head(<Badge tone={paymentTone}>{paymentLabel}</Badge>)}

      {gatewayNote && (
        <p className="rounded-lg bg-wash px-4 py-2.5 text-[13px] leading-5 text-ink-700">{gatewayNote}</p>
      )}

      {error && (
        <Banner tone="crit" role="alert">
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="ok" role="status">
          {notice}
        </Banner>
      )}

      <PaymentMoneySummary payments={panel.payments} orderTotal={panel.orderTotal} />

      <PaymentList
        payments={panel.payments}
        accounts={panel.collectionAccounts}
        customerName={panel.customerName}
        canValidate={panel.canValidate}
        canRegister={panel.canRegister}
        pending={pending}
        onValidate={(id, sendKey) => run(() => validatePayment(id, { sendKey }))}
        onReject={(id, reason) => run(() => rejectPayment(id, reason))}
        onComplete={(id, data) => run(() => completePaymentData(id, data))}
        canOverride={panel.canOverride}
        onReassign={(id, targetOrderName, reason) =>
          run(() => overridePaymentValidation(id, { targetOrderName, reason }))
        }
        keyAutosend={panel.keyAutosend}
      />

      {panel.canRegister && (
        <VoucherForm
          orderId={orderId}
          storeId={panel.storeId}
          accounts={panel.collectionAccounts}
          orderTotal={panel.orderTotal}
          existing={panel.payments}
          shalomGuide={panel.shalomGuide}
          pending={pending}
          onRegistered={() => {
            void reload();
            onChanged();
          }}
          onError={setError}
          onNotice={setNotice}
        />
      )}

    </section>
  );
}

/**
 * Credencial ligada a la salida Shalom. Se renderiza dentro de "Salidas y
 * guías", nunca dentro del formulario que registra comprobantes. El pago
 * completo sigue siendo la compuerta que autoriza revelarla o entregarla.
 */
export function ShalomPickupKeyPanel({
  orderId,
  onChanged,
}: {
  orderId: string;
  onChanged: () => void;
}) {
  const { panel, error, setError, notice, setNotice, pending, startTransition, reload } =
    usePaymentPanel(orderId);

  function run(action: () => Promise<{ error?: string; notice?: string }>) {
    startTransition(async () => {
      const res = await action();
      setError(res.error ?? null);
      setNotice(res.notice ?? null);
      if (!res.error) {
        await reload();
        onChanged();
      }
    });
  }

  // Una zona más de la tarjeta «Salidas y guías», sobre su hairline.
  if (!panel) {
    if (error) {
      return <PanelLoadError message={error} onRetry={() => void reload()} className={CARD_ZONE} />;
    }
    return <p className={cn(CARD_ZONE, "text-[13px] text-ink-500")}>Cargando credencial Shalom…</p>;
  }

  return (
    <div className={cn(CARD_ZONE, "space-y-3")}>
      {error && (
        <Banner tone="crit" role="alert">
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="ok" role="status">
          {notice}
        </Banner>
      )}
      <KeySection
        panel={panel}
        orderId={orderId}
        pending={pending}
        embedded
        onSetKey={(key) => run(() => setPickupKey(orderId, key))}
        onShare={(channel, note) => run(() => sharePickupKey(orderId, { channel, note }))}
        onSendWhatsapp={() => run(() => sendPickupKeyByWhatsapp(orderId))}
        onError={setError}
      />
    </div>
  );
}

function PaymentMoneySummary({
  payments,
  orderTotal,
}: {
  payments: PaymentRow[];
  orderTotal: number | null;
}) {
  const progress = paymentProgress(payments, orderTotal);
  const ratio = progress.orderTotal
    ? Math.min(100, Math.round((progress.validatedTotal / progress.orderTotal) * 100))
    : 0;
  const advanceCopy = progress.advanceValidated
    ? "Adelanto mínimo validado"
    : progress.advanceRegistered
      ? "Adelanto cargado, falta validarlo"
      : `Faltan S/ ${Math.max(0, SHALOM_MINIMUM_ADVANCE - progress.registeredTotal).toFixed(2)} para el adelanto mínimo`;

  // El resumen de cifras del mundo (DESIGN.md, Panel lateral): un marco con
  // hairlines entre celdas y el saldo sobre `wash`. Escrito como frase, en el
  // teléfono «S/» quedaba en una línea y el monto en la siguiente.
  const cells: { label: string; value: string; note?: string; balance?: boolean }[] = [
    {
      label: "Validado",
      value: `S/ ${progress.validatedTotal.toFixed(2)}`,
      note: progress.orderTotal !== null ? `de S/ ${progress.orderTotal.toFixed(2)}` : undefined,
    },
    { label: "Cargado", value: `S/ ${progress.registeredTotal.toFixed(2)}` },
    ...(progress.registeredRemaining !== null
      ? [{ label: "Saldo por cargar", value: `S/ ${progress.registeredRemaining.toFixed(2)}`, balance: true }]
      : []),
  ];

  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-inset ring-line">
      <dl className={cn("grid divide-y divide-line @md:divide-x @md:divide-y-0", cells.length === 3 ? "@md:grid-cols-3" : "@md:grid-cols-2")}>
        {cells.map((cell) => (
          <div
            key={cell.label}
            className={cn(
              "flex items-baseline justify-between gap-3 px-4 py-2.5 @md:block @md:py-3",
              cell.balance && "bg-wash",
            )}
          >
            <dt className="text-[13px] text-ink-600">{cell.label}</dt>
            <dd className="text-right @md:mt-0.5 @md:text-left">
              <span className="whitespace-nowrap text-base font-semibold tabular-nums text-ink-900">{cell.value}</span>
              {cell.note && (
                <span className="ml-1.5 whitespace-nowrap text-[13px] tabular-nums text-ink-600">{cell.note}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-line px-4 py-3">
        {progress.orderTotal !== null && (
          <div
            className="mb-2.5 h-1.5 overflow-hidden rounded-full bg-line-strong"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={ratio}
            aria-label={`${ratio}% del pedido validado`}
          >
            <div
              className="h-full rounded-full bg-ok-fg transition-[width] duration-200 motion-reduce:transition-none"
              style={{ width: `${ratio}%` }}
            />
          </div>
        )}
        <p
          className={cn(
            "flex items-center gap-1.5 text-[13px] font-medium",
            progress.advanceValidated
              ? "text-ok-fg"
              : progress.advanceRegistered
                ? "text-warn-fg"
                : "text-ink-600",
          )}
        >
          {progress.advanceValidated ? (
            <IconCheck aria-hidden className="size-4 shrink-0" />
          ) : progress.advanceRegistered ? (
            <IconClock aria-hidden className="size-4 shrink-0" />
          ) : null}
          {advanceCopy}
        </p>
      </div>
    </div>
  );
}

function PaymentList({
  payments,
  accounts,
  customerName,
  canValidate,
  canRegister,
  pending,
  onValidate,
  onReject,
  onComplete,
  canOverride,
  onReassign,
  keyAutosend,
}: {
  payments: PaymentRow[];
  /** Las cuentas de cobro de la tienda, para juzgar el receptor de cada uno. */
  accounts: CollectionAccount[];
  /** La clienta: su nombre leído como receptor es la nota del Yape. */
  customerName: string | null;
  canValidate: boolean;
  canRegister: boolean;
  pending: boolean;
  onValidate: (id: string, sendKey: boolean) => void;
  onReject: (id: string, reason: string) => void;
  onComplete: (id: string, data: { operationNumber: string; amount: number | null; paidAt: string | null }) => void;
  /** Mover el pago al pedido correcto. Solo para quien puede corregir. */
  canOverride: boolean;
  onReassign: (paymentId: string, targetOrderName: string, reason: string) => void;
  /** El envío de la clave al validar (0173). Ausente = la tienda no lo tiene. */
  keyAutosend?: PanelData["keyAutosend"];
}) {
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  if (!payments.length) {
    return <p className="text-[13px] text-ink-500">Todavía no se ha cargado ningún comprobante.</p>;
  }

  return (
    // Una zona de la tarjeta, con los comprobantes en filas de borde a borde:
    // cada uno en su recuadro era un marco dentro de otro.
    <div className={cn(CARD_ZONE, "space-y-3")}>
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-ink-900">Comprobantes</h4>
        <Badge className="tabular-nums">{payments.length}</Badge>
      </div>
      <ul className="-mx-4 divide-y divide-line sm:-mx-5 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0">
        {payments.map((p) => (
          <li key={p.id} className="flex gap-4 px-4 py-3 sm:px-5">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold capitalize text-ink-900">{p.kind}</span>
                {p.amount !== null && (
                  <span className="text-sm tabular-nums text-ink-900">S/ {p.amount.toFixed(2)}</span>
                )}
                <Badge tone={STATUS_TONE[p.validation_status] ?? "neutral"}>
                  {STATUS_LABEL[p.validation_status] ?? p.validation_status}
                </Badge>
              </div>
              {/* Sin operación, fecha ni pagador la línea decía solo «—». */}
              {(p.operation_number || p.paid_at || p.payer_name) && (
                <p className="-mt-1 text-[13px] tabular-nums text-ink-500">
                  {[
                    p.operation_number ? `Op. ${p.operation_number}` : null,
                    p.paid_at ? fmtDateTime(p.paid_at) : null,
                    p.payer_name ? `Pagó: ${p.payer_name}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              <StoredRecipientStatus
                vision={p.vision}
                hasVoucher={Boolean(p.file_path)}
                accounts={accounts}
                customerName={customerName}
              />
              {p.notes && <p className="text-[13px] leading-5 text-ink-600">{p.notes}</p>}
              {!p.operation_number && p.validation_status !== "rechazado" && (
                <MissingOperation
                  payment={p}
                  canRegister={canRegister}
                  pending={pending}
                  onComplete={onComplete}
                />
              )}
              {canValidate &&
                p.operation_number &&
                p.validation_status !== "validado" &&
                p.validation_status !== "rechazado" && (
                <ValidateActions
                  payment={p}
                  accounts={accounts}
                  customerName={customerName}
                  pending={pending}
                  onValidate={onValidate}
                  keyAutosend={keyAutosend}
                >
                  {/* Rechazar vive dentro para quedar en la misma fila. */}
                  {rejecting === p.id ? (
                    <>
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Motivo del rechazo"
                        aria-label="Motivo del rechazo"
                        className={cn(FIELD_BOX, "h-8 min-w-40 flex-1 px-2.5 text-[13px] pointer-coarse:h-11")}
                      />
                      <OpsButton
                        size="sm"
                        variant="danger"
                        disabled={pending || !reason.trim()}
                        onClick={() => {
                          onReject(p.id, reason);
                          setRejecting(null);
                          setReason("");
                        }}
                        className="pointer-coarse:h-11"
                      >
                        Confirmar rechazo
                      </OpsButton>
                    </>
                  ) : (
                    <OpsButton
                      size="sm"
                      disabled={pending}
                      onClick={() => setRejecting(p.id)}
                      className="pointer-coarse:h-11"
                    >
                      Rechazar
                    </OpsButton>
                  )}
                </ValidateActions>
              )}
              {/* Reasignar vive FUERA del bloque de validar/rechazar: un pago
                  cargado en el pedido equivocado casi siempre se descubre DESPUÉS
                  de validarlo, y ahí el bloque de arriba ya no se dibuja. Colgarlo
                  de la misma condición lo habría dejado invisible justo en el caso
                  que viene a resolver. */}
              {canOverride && p.validation_status !== "rechazado" && (
                <ReassignPayment payment={p} pending={pending} onReassign={onReassign} />
              )}
            </div>
            {/* El comprobante se guardaba y no se podía ver: quien validaba tenía
                que fiarse de los campos transcritos, que es justo lo que la imagen
                sirve para contrastar. La miniatura, a la derecha de sus datos para
                cotejarlos de un vistazo, abre el original en otra pestaña. */}
            {p.file_path && (
              <a
                href={`/api/payments/${p.id}/voucher`}
                target="_blank"
                rel="noreferrer"
                className="group flex w-20 shrink-0 flex-col items-start gap-1 sm:w-24"
                title="Ver el comprobante en grande"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/payments/${p.id}/voucher`}
                  alt="Comprobante de Yape"
                  className="max-h-40 w-full rounded-md bg-wash object-cover object-top ring-1 ring-line"
                />
                <span className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 underline-offset-2 group-hover:underline pointer-coarse:min-h-11">
                  Ampliar
                  <IconArrowUpRight aria-hidden className="size-3" />
                </span>
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Validar, y —cuando ESTE comprobante es el que libera la clave— validar y
 * mandársela a la clienta en el mismo clic (MOM §12, migración 0173).
 *
 * POR QUÉ UN BOTÓN DISTINTO Y NO UN AJUSTE SILENCIOSO. Medido el 21-09-2026:
 * 786 pedidos pagados con clave, 770 con la clave ya consultada y 3 con la
 * entrega registrada. La clave se entrega a mano y el registro se pierde. Esto
 * junta las dos cosas, pero mandar la llave del paquete no puede ser un efecto
 * secundario de un botón que dice «Validar»: el botón cambia de texto, enseña
 * el mensaje exacto que va a salir —con la clave tapada, que nunca viaja al
 * navegador— y solo aparece en el comprobante que de verdad libera.
 *
 * Validar desde la bandeja de revisión NO manda nada: allí no hay este botón.
 */
function ValidateActions({
  payment,
  accounts,
  customerName,
  pending,
  onValidate,
  keyAutosend,
  children,
}: {
  payment: PaymentRow;
  accounts: CollectionAccount[];
  customerName: string | null;
  pending: boolean;
  onValidate: (id: string, sendKey: boolean) => void;
  keyAutosend?: PanelData["keyAutosend"];
  children: React.ReactNode;
}) {
  const [verPrevia, setVerPrevia] = useState(false);
  const mismatch =
    yapeRecipientReadingFromVision(payment.vision, accounts, customerName).status === "mismatch";
  const libera = Boolean(keyAutosend?.enabled && keyAutosend.unlocks.includes(payment.id));
  // Liberar la clave y poder escribirle son dos cosas distintas: fuera de las
  // 24 h el botón vuelve a ser «Validar» y se dice por qué, en vez de prometer
  // un envío que WhatsApp va a rechazar.
  const enviará = libera && Boolean(keyAutosend?.windowOpen);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <OpsButton
          size="sm"
          variant="primary"
          disabled={pending || mismatch}
          onClick={() => onValidate(payment.id, enviará)}
          title={
            mismatch
              ? "El receptor leído no coincide con ninguna cuenta de cobro de la tienda"
              : enviará
                ? "Validar y mandarle la clave de recojo por WhatsApp"
                : "Validar comprobante"
          }
          className="pointer-coarse:h-11"
        >
          {enviará ? "Validar y enviar la clave" : "Validar"}
        </OpsButton>
        {children}
      </div>

      {/* Un desplegable, como «Consultas de la clave»: es lo que va a salir,
          no un aviso de que algo salió bien. */}
      {enviará && (
        <div>
          <button
            type="button"
            onClick={() => setVerPrevia((v) => !v)}
            aria-expanded={verPrevia}
            className="inline-flex min-h-8 items-center gap-1.5 text-[13px] font-medium text-ink-600 hover:text-ink-900 pointer-coarse:min-h-11"
          >
            <IconChevronDown
              aria-hidden
              className={cn(
                "size-4 text-ink-500 transition-transform duration-150 motion-reduce:transition-none",
                verPrevia ? "rotate-0" : "-rotate-90",
              )}
            />
            {verPrevia ? "Ocultar el mensaje" : "Ver el mensaje que se enviará"}
          </button>
          {verPrevia && (
            <pre className="ml-5.5 mt-1 whitespace-pre-wrap rounded-md bg-wash px-3 py-2 font-sans text-[13px] leading-5 text-ink-900">
              {keyAutosend?.preview}
            </pre>
          )}
        </div>
      )}
      {libera && !enviará && (
        <p className="text-[13px] leading-5 text-warn-fg">
          La clave no saldrá sola: la clienta no escribe hace más de 24 h y WhatsApp no deja
          mandarle texto libre fuera de esa ventana. Entrégasela tú y regístralo.
        </p>
      )}
    </div>
  );
}

/**
 * Mover un pago al pedido correcto.
 *
 * POR QUÉ EXISTE. Cargar el comprobante en el pedido de al lado es un error de
 * dedo corriente, y hasta ahora la única salida era rechazarlo y volver a
 * subirlo. Eso funciona —un rechazo libera el nº de operación— pero deja en el
 * historial de la clienta un pago RECHAZADO, que se lee como «mandó un
 * comprobante malo». No fue eso lo que pasó.
 *
 * La server action ya existía desde la 0049 y nunca se conectó a nada.
 */
function ReassignPayment({
  payment,
  pending,
  onReassign,
}: {
  payment: PaymentRow;
  pending: boolean;
  onReassign: (paymentId: string, targetOrderName: string, reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const ready = target.trim().length > 2 && reason.trim().length > 0;

  if (!open) {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => setOpen(true)}
        className="flex w-fit items-center text-[13px] font-medium text-ink-600 underline underline-offset-2 hover:text-ink-900 disabled:opacity-50 pointer-coarse:min-h-11"
      >
        Está en el pedido equivocado
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg bg-wash p-3">
      <p className="text-[13px] font-semibold text-ink-900">Mover este pago a otro pedido</p>
      <div className="flex flex-wrap gap-2">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="#KP130243"
          autoComplete="off"
          aria-label="Pedido de destino"
          className={cn(FIELD_BOX, "h-8 w-36 px-2.5 font-mono text-[13px] pointer-coarse:h-11")}
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Motivo (obligatorio)"
          aria-label="Motivo de la corrección"
          className={cn(FIELD_BOX, "h-8 min-w-40 flex-1 px-2.5 text-[13px] pointer-coarse:h-11")}
        />
      </div>
      {/* Se dice ANTES, no como confirmación después: quien mueve dinero entre
          pedidos tiene que saber que queda firmado en los dos. */}
      <p className="text-[13px] leading-5 text-ink-600">
        Quedará en el historial de los dos pedidos, con tu nombre y el motivo.
      </p>
      <div className="flex gap-2">
        <OpsButton
          size="sm"
          variant="primary"
          disabled={pending || !ready}
          onClick={() => {
            onReassign(payment.id, target, reason);
            setOpen(false);
            setTarget("");
            setReason("");
          }}
          className="pointer-coarse:h-11"
        >
          Mover el pago
        </OpsButton>
        <OpsButton size="sm" variant="ghost" onClick={() => setOpen(false)} className="pointer-coarse:h-11">
          Cancelar
        </OpsButton>
      </div>
    </div>
  );
}

function StoredRecipientStatus({
  vision,
  hasVoucher,
  accounts,
  customerName,
}: {
  vision: unknown;
  hasVoucher: boolean;
  accounts: CollectionAccount[];
  customerName: string | null;
}) {
  const reading = yapeRecipientReadingFromVision(vision, accounts, customerName);
  if (!hasVoucher && reading.status === "missing") return null;
  const label =
    reading.status === "verified"
      // Se nombra la cuenta con la que encajó: con varias cuentas de cobro,
      // "verificada" a secas ya no dice a cuál llegó el dinero.
      ? reading.receivedView
        ? "Captura de nuestro Yape Empresa («Te yapearon»): llegó a la cuenta de la tienda"
        : `Cuenta receptora verificada: ${
            reading.account ? describeCollectionAccount(reading.account) : "cuenta de cobro"
          }`
      : reading.status === "mismatch"
        ? `Receptor distinto: ${reading.name ?? "nombre no leído"} · ${
            reading.phoneLastDigits ? `***${reading.phoneLastDigits}` : "celular no leído"
          }`
        : // El nombre de la clienta leído como receptor —la nota del Yape— no
          // contó. Se dice cuál, para que no parezca que no se leyó nada.
          reading.ignoredName
          ? `El nombre leído «${reading.ignoredName}» es el de la clienta (la nota del Yape), no el receptor. El celular ***${reading.phoneLastDigits} es nuestro; contrasta la imagen antes de validar.`
          : // El voucher corta el destinatario y esa lectura corta NO acusa a
          // nadie: se nombra lo leído para que se contraste con la imagen, sin
          // afirmar que la cuenta sea otra.
          verifyYapeRecipient(reading.name, reading.phoneLastDigits, accounts).nameCutShort
          ? `Destinatario leído a medias: «${reading.name}». Contrasta la imagen antes de validar.`
          : reading.receivedView
            ? "Captura «Te yapearon» sin el aviso de Yape Empresa: confirma en nuestro Yape que el pago entró antes de validar."
          : reading.status === "partial"
            ? "Cuenta receptora parcialmente leída. Contrasta la imagen antes de validar."
            : "La cuenta receptora no pudo leerse. Contrasta la imagen antes de validar.";
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-[13px] font-medium leading-5",
        reading.status === "verified"
          ? "text-ok-fg"
          : reading.status === "mismatch"
            ? "text-crit-fg"
            : "text-warn-fg",
      )}
    >
      {reading.status === "verified" ? (
        <IconCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
      ) : (
        <IconAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      )}
      <span>{label}</span>
    </p>
  );
}

/**
 * Un comprobante sin nº de operación no se puede validar: es el único dato que
 * garantiza que ese Yape no se reutilice en otro pedido (el índice único no
 * puede actuar sobre un nulo). Ocurre cuando la captura llega recortada y la
 * lectura automática no encuentra el número — el camino es completarlo a mano o
 * pedirle al cliente el comprobante entero.
 */
/**
 * Elegir el comprobante: clic, arrastrar o **pegar**.
 *
 * Pegar es lo que más se usa y lo que faltaba: el comprobante de Yape llega por
 * WhatsApp y se copia con Ctrl+C. Obligar a guardarlo en Descargas para luego
 * buscarlo en un diálogo de archivos es trabajo inventado.
 *
 * La previsualización tampoco es adorno: la imagen se sube y la lee una visión
 * que rellena los campos en blanco, así que subir la equivocada se descubría al
 * revisar el pago, no al cargarlo. Con la miniatura delante, el error se ve
 * antes de registrar nada.
 *
 * El `accept` va explícito además del `image/*` porque algunos navegadores en
 * Windows filtran de más con el comodín y esconden los .webp — que es
 * exactamente el formato en el que Chrome guarda muchas capturas.
 */
function VoucherPicker({
  file,
  preview,
  onPick,
}: {
  file: File | null;
  /** La imagen elegida, ya como URL local (`useObjectUrl`). */
  preview: string | null;
  onPick: (f: File | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  // El pegado se escucha en toda la ventana: pedirle a alguien que "haga foco en
  // la zona de subida" antes de Ctrl+V es pedirle que sepa algo que no se ve.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const img = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (!img) return;
      const f = img.getAsFile();
      if (f) {
        e.preventDefault();
        onPick(f);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onPick]);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith("image/"));
        if (f) onPick(f);
      }}
      // Discontinuo: en este mundo es «vacío o disponible», y aquí se suelta.
      className={cn(
        "rounded-lg border border-dashed p-3 transition-colors",
        over ? "border-brand-500 bg-brand-50" : "border-line-strong",
      )}
    >
      {preview ? (
        <div className="space-y-2">
          {/* En una tarjeta ancha la imagen vive a la derecha de los campos
              (`VoucherForm`); aquí solo cuando no cabe al lado. */}
          <VoucherPreview src={preview} className="@2xl:hidden" />
          <p className="text-[13px] leading-5 text-ink-600">
            <span className="font-medium text-ink-900">{file?.name}</span>
            {file ? ` · ${Math.round(file.size / 1024)} KB · ${file.type || "imagen"}` : ""}
          </p>
          <p className="text-[13px] leading-5 text-ink-500">
            La imagen queda visible mientras cotejas los datos leídos. Haz clic para ampliarla.
          </p>
        </div>
      ) : (
        <p className="text-[13px] leading-5 text-ink-600">
          Arrastra el comprobante aquí, <strong className="font-semibold text-ink-900">pégalo con Ctrl+V</strong> o
          elígelo con el botón.
        </p>
      )}
      {/* El input nativo se pintaba como texto suelto ("Seleccionar archivo /
          Ningún archivo seleccionado") y no se leía como algo pulsable. Se
          esconde y se pone un botón de verdad. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <OpsButton size="sm" onClick={() => inputRef.current?.click()} className="pointer-coarse:h-11">
          <IconImage aria-hidden className="text-ink-500" />
          {file ? "Cambiar imagen" : "Elegir imagen del Yape"}
        </OpsButton>
        {file && (
          <OpsButton
            size="sm"
            variant="ghost"
            onClick={() => {
              onPick(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="pointer-coarse:h-11"
          >
            Quitar
          </OpsButton>
        )}
        <input
          ref={inputRef}
          type="file"
          // El comodín basta en el servidor, pero algunos navegadores en Windows
          // filtran de más con él y esconden los .webp — justo el formato en que
          // Chrome guarda muchas capturas. Por eso van nombrados.
          accept="image/*,image/webp,image/heic,image/heif,.webp,.heic,.heif"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
      </div>
    </div>
  );
}

/** La URL local de la imagen elegida, para enseñarla antes de subirla. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    // Sin esto cada imagen elegida deja su blob retenido en memoria.
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

/** El comprobante elegido, grande, y un clic para abrirlo a tamaño completo. */
function VoucherPreview({ src, className, tall = false }: { src: string; className?: string; tall?: boolean }) {
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className={cn("grid place-items-center rounded-lg bg-wash p-2 ring-1 ring-inset ring-line", className)}
      title="Abrir comprobante a tamaño completo"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Comprobante por subir"
        className={cn("w-full rounded-md object-contain", tall ? "max-h-[28rem]" : "max-h-80")}
      />
    </a>
  );
}

function MissingOperation({
  payment,
  canRegister,
  pending,
  onComplete,
}: {
  payment: PaymentRow;
  canRegister: boolean;
  pending: boolean;
  onComplete: (id: string, data: { operationNumber: string; amount: number | null; paidAt: string | null }) => void;
}) {
  const [operation, setOperation] = useState("");
  const [amount, setAmount] = useState(payment.amount !== null ? String(payment.amount) : "");
  const [paidAt, setPaidAt] = useState("");

  return (
    <div className="space-y-2 rounded-lg bg-warn-wash px-3 py-2.5">
      {/* El texto depende de si HAY campo debajo. Decía «escribe el número
          aquí» siempre, también cuando `canRegister` es falso y no se dibuja
          ninguna casilla: una pantalla que nombra una acción que no ofrece
          manda a quien la lee a buscar algo que no existe. */}
      <p className="flex items-start gap-1.5 text-[13px] leading-5 text-ink-700">
        <IconAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn-fg" />
        <span>
          {canRegister
            ? "Sin nº de operación no se puede validar. Si la captura está recortada, pide al cliente el comprobante completo o escribe el número aquí."
            : "Sin nº de operación no se puede validar, y tu rol no permite completarlo. Pide al cliente el comprobante completo o avisa a quien registre pagos."}
        </span>
      </p>
      {canRegister && (
        <div className="flex flex-wrap gap-2">
          <input
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
            placeholder="Nº de operación"
            aria-label="Nº de operación"
            autoComplete="off"
            className={cn(FIELD_BOX, "h-8 w-40 px-2.5 text-[13px] tabular-nums pointer-coarse:h-11")}
          />
          {payment.amount === null && (
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="Monto"
              aria-label="Monto"
              className={cn(FIELD_BOX, "h-8 w-24 px-2.5 text-[13px] tabular-nums pointer-coarse:h-11")}
            />
          )}
          {!payment.paid_at && (
            <input
              type="datetime-local"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              aria-label="Fecha y hora del pago"
              className={cn(FIELD_BOX, "h-8 w-auto px-2.5 text-[13px] tabular-nums pointer-coarse:h-11")}
            />
          )}
          <OpsButton
            size="sm"
            variant="primary"
            disabled={pending || operation.replace(/[^a-z0-9]/gi, "").length < 4}
            onClick={() =>
              onComplete(payment.id, {
                operationNumber: operation,
                amount: amount.trim() ? Number(amount) : null,
                paidAt: paidAt ? new Date(paidAt).toISOString() : null,
              })
            }
            className="pointer-coarse:h-11"
          >
            Completar datos
          </OpsButton>
        </div>
      )}
    </div>
  );
}

/** El disco de cada señal dice en qué quedó; el texto lo repite para el lector. */
const SIGNAL_DISC = {
  neutral: "bg-line-strong text-ink-600",
  ok: "bg-ok-fg text-white",
  partial: "bg-warn-fg text-white",
  bad: "bg-crit-fg text-white",
} as const;

function RecipientSignal({
  label,
  value,
  expected,
  present,
  matches,
  // Leído a medias: ni confirma ni desmiente. Sin este tercer estado, un nombre
  // que la pantalla del banco cortó se pintaba con la misma × roja que un
  // receptor de verdad distinto.
  cutShort = false,
}: {
  label: string;
  value: string;
  expected: string;
  present: boolean;
  matches: boolean;
  cutShort?: boolean;
}) {
  const tone = !present ? "neutral" : matches ? "ok" : cutShort ? "partial" : "bad";
  return (
    // Una columna sobre el `wash` del grupo, sin recuadro propio: un marco
    // dentro de otro marco dentro de la tarjeta era un nivel de más.
    <div className="min-w-0 py-1 @md:px-3 @md:first:pl-0 @md:last:pr-0">
      <p className="text-xs font-medium text-ink-600">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn("grid size-5 shrink-0 place-items-center rounded-full", SIGNAL_DISC[tone])}
        >
          {tone === "neutral" ? (
            <span className="size-1.5 rounded-full bg-ink-600" />
          ) : tone === "ok" ? (
            <IconCheck className="size-3" strokeWidth={2.6} />
          ) : tone === "partial" ? (
            <IconAlert className="size-3" />
          ) : (
            <IconX className="size-3" strokeWidth={2.6} />
          )}
        </span>
        <span className={cn("min-w-0 truncate text-sm font-semibold", present ? "text-ink-900" : "text-ink-600")}>
          {value}
        </span>
        {/* El tono no puede ser la única señal: el lector oye en qué quedó. */}
        <span className="sr-only">
          {tone === "neutral" ? "(sin leer)" : tone === "ok" ? "(coincide)" : tone === "partial" ? "(leído a medias)" : "(no coincide)"}
        </span>
      </div>
      <p className="mt-1 text-xs leading-4 text-ink-600">Debe coincidir con {expected}</p>
    </div>
  );
}

function RecipientAccountCheck({
  reading,
  accounts,
}: {
  reading: YapeRecipientReading | null;
  accounts: CollectionAccount[];
}) {
  const titleId = useId();
  // «Te yapearon»: la captura es de nuestra propia cuenta, así que no hay
  // receptor que contrastar — el nombre y el celular son de quien pagó.
  if (reading?.receivedView) {
    return (
      <div role="group" aria-labelledby={titleId} aria-live="polite" className="space-y-2 rounded-lg bg-wash p-3">
        <p id={titleId} className="text-[13px] font-semibold text-ink-700">
          Cuenta receptora del Yape
        </p>
        {reading.yapeEmpresa ? (
          <p className="flex items-start gap-1.5 text-[13px] font-medium leading-5 text-ok-fg">
            <IconCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              Captura de nuestro Yape Empresa («Te yapearon»): el dinero llegó a la cuenta de la tienda. El nombre y
              el celular que muestra son de quien pagó.
            </span>
          </p>
        ) : (
          <p className="flex items-start gap-1.5 text-[13px] font-medium leading-5 text-warn-fg">
            <IconAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              Captura «Te yapearon» sin el aviso de Yape Empresa: puede ser de cualquier cuenta que recibió un Yape,
              no necesariamente la nuestra. Confirma en nuestro Yape que el pago entró antes de validar.
            </span>
          </p>
        )}
      </div>
    );
  }
  const verification = verifyYapeRecipient(reading?.name, reading?.phoneLastDigits, accounts);
  // Corregir la lectura invertida en silencio sería peor que no corregirla: esto
  // decide si el dinero se desvió, y quien valida tiene que saber que el nombre
  // que está viendo salió del campo del pagador.
  const swapNotice = reading?.swapped
    ? " La lectura vino con el pagador y el receptor cambiados de sitio; se corrigió, pero contrasta la imagen."
    : "";
  // Lo mismo con el nombre de la clienta tomado por receptor: se descartó, y se
  // dice cuál, para que el operador lo contraste con la imagen.
  const ignoredNotice = reading?.ignoredName
    ? ` El nombre leído «${reading.ignoredName}» es el de la clienta —la nota que escribió en el Yape—, no el receptor: no cuenta.`
    : "";
  const message =
    verification.status === "verified"
      ? verification.account && !verification.account.phoneLastDigits
        // La pasarela (Flow) no cobra con celular: su nombre es la única señal.
        ? `Cuenta receptora verificada: ${verification.account.name}. Coincide el nombre; esta cuenta no cobra con celular.`
        : `Cuenta receptora verificada: ${verification.account?.name ?? ""}. Las dos señales coinciden.`
      : verification.status === "mismatch"
        ? "El comprobante apunta a una cuenta que no es de la tienda. No podrá validarse."
        : verification.unknownAccounts
          // Sin cuentas configuradas no se puede juzgar, y decirlo así evita que
          // el operador lea "revisa la imagen" cuando el problema es de ajustes.
          ? "La tienda no tiene cuentas de cobro configuradas, así que no se puede contrastar el receptor. Avisa a un administrador."
        : verification.nameCutShort
          ? "El destinatario se leyó a medias: el voucher lo corta. Empieza como la cuenta esperada, pero confírmalo en la imagen antes de validar."
          : verification.status === "partial"
            ? "Verificación parcial. Revisa la señal que no pudo leerse antes de validar."
            : "Se completa automáticamente al pulsar Leer y rellenar.";
  const fullMessage = message + swapNotice + ignoredNotice;

  return (
    <div role="group" aria-labelledby={titleId} aria-live="polite" className="space-y-2 rounded-lg bg-wash p-3">
      <p id={titleId} className="text-[13px] font-semibold text-ink-700">
        Cuenta receptora del Yape
      </p>
      <div className="grid divide-y divide-line @md:grid-cols-2 @md:divide-x @md:divide-y-0">
        <RecipientSignal
          label="Destinatario leído"
          value={
            reading?.name ??
            (reading?.ignoredName ? `«${reading.ignoredName}» (nota del Yape)` : "Pendiente de lectura")
          }
          expected={accounts.map((a) => a.name).join(" o ") || "una cuenta de cobro configurada"}
          present={verification.hasName}
          matches={verification.nameMatches}
          cutShort={verification.nameCutShort}
        />
        <RecipientSignal
          label="Celular receptor"
          value={reading?.phoneLastDigits ? `*** *** ${reading.phoneLastDigits}` : "Pendiente de lectura"}
          expected={
            accounts
              .filter((a) => a.phoneLastDigits)
              .map((a) => `terminación ${a.phoneLastDigits}`)
              .join(" o ") || "una cuenta de cobro configurada"
          }
          present={verification.hasPhone}
          matches={verification.phoneMatches}
        />
      </div>
      <p
        className={cn(
          "flex items-start gap-1.5 text-[13px] font-medium leading-5",
          verification.status === "verified"
            ? "text-ok-fg"
            : verification.status === "mismatch"
              ? "text-crit-fg"
              : verification.status === "partial"
                ? "text-warn-fg"
                : "text-ink-600",
        )}
      >
        {verification.status === "verified" ? (
          <IconCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
        ) : verification.status === "mismatch" || verification.status === "partial" ? (
          <IconAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        ) : null}
        <span>{fullMessage}</span>
      </p>
    </div>
  );
}

function VoucherForm({
  orderId,
  storeId,
  accounts,
  orderTotal,
  existing,
  shalomGuide,
  pending,
  onRegistered,
  onError,
  onNotice,
}: {
  orderId: string;
  storeId: string;
  /** Las cuentas de cobro de la tienda, para juzgar el receptor leído. */
  accounts: CollectionAccount[];
  orderTotal: number | null;
  existing: PaymentRow[];
  shalomGuide: PanelData["shalomGuide"];
  pending: boolean;
  onRegistered: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string | null) => void;
}) {
  const availableKinds = useMemo(
    () => nextPaymentKinds(existing, orderTotal),
    [existing, orderTotal],
  );
  const progress = useMemo(
    () => paymentProgress(existing, orderTotal),
    [existing, orderTotal],
  );
  const [kind, setKind] = useState<PaymentKind>(availableKinds[0] ?? "diferencia");
  const [amount, setAmount] = useState("");
  const [operation, setOperation] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [payer, setPayer] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [readNotice, setReadNotice] = useState<string | null>(null);
  const [readWarning, setReadWarning] = useState<string | null>(null);
  const [recipientCheck, setRecipientCheck] = useState<YapeRecipientReading | null>(null);
  const [uploadedVoucher, setUploadedVoucher] = useState<{
    fileKey: string;
    path: string;
    sha256: string | null;
  } | null>(null);
  // Datos de Shalom que se pueden adelantar acá (0073). OPCIONALES: no
  // condicionan el pago — bloquear un cobro por falta de un DNI sería peor que
  // el problema que resuelve.
  const [shalomDoc, setShalomDoc] = useState("");
  const [shalomDocType, setShalomDocType] = useState<ShalomDocumentType>("DNI");
  const [documentChecking, setDocumentChecking] = useState(false);
  const [documentNotice, setDocumentNotice] = useState<string | null>(null);
  const [shalomAgencyQuery, setShalomAgencyQuery] = useState("");
  const [shalomAgency, setShalomAgency] = useState<ShalomAgency | null>(null);
  const [shalomAgencies, setShalomAgencies] = useState<ShalomAgency[]>([]);
  const [agencySearching, setAgencySearching] = useState(false);
  const [agencyError, setAgencyError] = useState<string | null>(null);
  const agencyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** La operadora ya tocó los campos de Shalom: no rellenar por encima. */
  const shalomTouched = useRef(false);

  // LO QUE EL SERVIDOR CONFIRMÓ, aparte de lo que hay escrito en pantalla.
  //
  // Son dos cosas distintas y confundirlas fue el bug: el paso «1. DNI y
  // agencia» se marcaba hecho con `Boolean(shalomDoc || shalomAgency)` —estado
  // local— así que el ✓ se encendía al teclear, sin haber tocado la base. Y como
  // el guardado solo ocurría al registrar el pago, quien rellenaba el DNI y
  // recargaba la página lo perdía: la pantalla le había dicho que estaba.
  //
  // Un indicador que se enciende con lo tecleado vuelve a mentir el día que la
  // escritura falle, así que ahora refleja esto y no aquello.
  const [shalomSaved, setShalomSaved] = useState<{
    document: string | null;
    terminalId: number | null;
  }>({ document: null, terminalId: null });
  const savedRef = useRef(shalomSaved);
  savedRef.current = shalomSaved;
  const [shalomSaving, setShalomSaving] = useState(false);
  const [shalomSaveError, setShalomSaveError] = useState<string | null>(null);

  // Pintar lo que YA se apuntó en un pago anterior.
  //
  // `loadShalomOrderDraft` existía desde 0073 —su comentario dice literalmente
  // "para pintarlo en el panel de pagos"— y nunca se llegó a llamar. El modal de
  // la guía sí lo leía y lo anunciaba ("el documento y la agencia venían
  // apuntados desde el registro del pago"), así que el dato estaba guardado y
  // visible en un sitio pero no en el otro.
  //
  // No era solo estético: el paso "1. DNI y agencia" se marcaba pendiente con el
  // dato ya guardado, y eso invita a reescribirlo. Volver a teclear un DNI que ya
  // estaba bien solo puede empeorarlo.
  useEffect(() => {
    let alive = true;
    void loadShalomOrderDraft(orderId).then((res) => {
      if (!alive || "error" in res || !res.draft) return;
      const draft = res.draft;
      // Si tecleó mientras cargaba, manda ella: la red no le pisa lo escrito.
      if (shalomTouched.current) return;
      if (draft.documentType) setShalomDocType(draft.documentType);
      if (draft.document) setShalomDoc(draft.document);
      setShalomSaved({
        document: draft.document ?? null,
        terminalId: draft.destinyTerminalId ?? null,
      });
      if (draft.destinyTerminalId && draft.destinyTerminalName) {
        // El borrador solo guarda id y nombre, que es lo que `ShalomAgency`
        // exige; el resto son opcionales y solo decoran la ficha.
        setShalomAgency({ id: draft.destinyTerminalId, nombre: draft.destinyTerminalName });
      }
    });
    return () => {
      alive = false;
    };
  }, [orderId]);

  useEffect(() => {
    const nextKind = availableKinds[0];
    if (nextKind && !availableKinds.includes(kind)) {
      setKind(nextKind);
    }
  }, [availableKinds, kind]);

  const shalomDocumentProblem = shalomDoc.trim()
    ? documentError(shalomDocType, shalomDoc)
    : null;

  useEffect(() => {
    if (shalomAgency) return;
    const query = shalomAgencyQuery.trim();
    if (query.length < 2) {
      setShalomAgencies([]);
      setAgencyError(null);
      return;
    }
    if (agencyTimer.current) clearTimeout(agencyTimer.current);
    agencyTimer.current = setTimeout(() => {
      setAgencySearching(true);
      setAgencyError(null);
      void searchShalomAgencies(storeId, query).then((res) => {
        setAgencySearching(false);
        if ("error" in res) {
          setShalomAgencies([]);
          setAgencyError(res.error);
          return;
        }
        setShalomAgencies(res.agencies);
      });
    }, 450);
    return () => {
      if (agencyTimer.current) clearTimeout(agencyTimer.current);
    };
  }, [shalomAgencyQuery, shalomAgency, storeId]);

  /**
   * Guarda el borrador de Shalom en cuanto se decide, sin esperar al pago.
   *
   * Antes esto solo ocurría dentro del envío del pago, y por tanto el paso 1 no
   * existía sin el paso 3: quien apuntaba el DNI y la agencia mientras hablaba
   * con la clienta —que es EXACTAMENTE para lo que está ahí— los perdía si el
   * comprobante llegaba más tarde.
   *
   * EL DOCUMENTO SOLO VIAJA SI ES VÁLIDO. El servidor lo valida con la misma
   * función que la creación de la guía y rechaza la escritura entera si no pasa;
   * mandar un DNI a medio teclear impediría guardar la AGENCIA, que no tiene
   * nada que ver. Si lo escrito todavía no vale, se conserva lo último guardado
   * en vez de borrarlo — y el propio campo lo guardará al salir de él.
   */
  async function persistShalomDraft(over: {
    document?: string | null;
    terminalId?: number | null;
    terminalName?: string | null;
  }): Promise<void> {
    const document =
      over.document !== undefined
        ? over.document
        : shalomDraftDocumentToSave(shalomDoc, !shalomDocumentProblem, savedRef.current.document);
    const terminalId = over.terminalId !== undefined ? over.terminalId : (shalomAgency?.id ?? null);
    const terminalName =
      over.terminalName !== undefined ? over.terminalName : (shalomAgency?.nombre ?? null);

    // Nada que decir: ni hay dato nuevo ni hay dato guardado que quitar.
    if (!document && !terminalId && !savedRef.current.document && !savedRef.current.terminalId) {
      return;
    }

    setShalomSaving(true);
    setShalomSaveError(null);
    const res = await saveShalomOrderDraft(orderId, {
      documentType: shalomDocType,
      document,
      destinyTerminalId: terminalId,
      destinyTerminalName: terminalName,
    });
    setShalomSaving(false);
    if ("error" in res && res.error) {
      // No se toca `shalomSaved`: el ✓ tiene que seguir diciendo la verdad.
      setShalomSaveError(res.error);
      return;
    }
    setShalomSaved({ document, terminalId });
  }

  function changeDocument(value: string) {
    shalomTouched.current = true;
    const normalized =
      shalomDocType === "CE"
        ? value.toUpperCase().replace(/[^A-Z0-9]/g, "")
        : value.replace(/\D/g, "");
    setShalomDoc(normalized);
    setDocumentNotice(null);
  }

  function validateDocument() {
    if (!shalomDoc.trim() || shalomDocumentProblem) return;
    setDocumentChecking(true);
    setDocumentNotice(null);
    void lookupShalomPerson(storeId, shalomDoc.trim(), shalomDocType).then((res) => {
      setDocumentChecking(false);
      if ("error" in res) {
        setDocumentNotice(res.error);
        return;
      }
      setDocumentNotice(
        res.person
          ? `Documento encontrado en Shalom Pro: ${[res.person.name, res.person.lastName, res.person.surName].filter(Boolean).join(" ")}.`
          : "Formato válido. El documento todavía no figura en Shalom Pro.",
      );
    });
  }

  function pickVoucher(nextFile: File | null) {
    setFile(nextFile);
    setUploadedVoucher(null);
    // Cada archivo es una transacción distinta. Nunca conservamos la lectura
    // anterior: fue la causa del falso duplicado 08615551 / 05510030.
    setAmount("");
    setOperation("");
    setPaidAt("");
    setPayer("");
    setReadNotice(null);
    setReadWarning(null);
    setRecipientCheck(null);
  }

  async function ensureVoucherUploaded(): Promise<
    { path: string; sha256: string | null } | { error: string }
  > {
    if (!file) return { error: "Primero carga una imagen del comprobante." };
    const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
    if (uploadedVoucher?.fileKey === fileKey) {
      return { path: uploadedVoucher.path, sha256: uploadedVoucher.sha256 };
    }

    const sha256 = await fileSha256(file);
    const prep = await createVoucherUpload(orderId, file.type || "image/jpeg", file.name);
    if ("error" in prep) return prep;
    const supabase = createBrowserSupabase();
    const { error } = await supabase.storage
      .from(VOUCHER_BUCKET)
      .uploadToSignedUrl(prep.path, prep.token, file, {
        contentType: file.type || "image/jpeg",
      });
    if (error) return { error: `No se pudo subir el comprobante: ${error.message}` };

    setUploadedVoucher({ fileKey, path: prep.path, sha256 });
    return { path: prep.path, sha256 };
  }

  async function readAndPrefill() {
    if (!file) return;
    setReading(true);
    setReadNotice(null);
    setReadWarning(null);
    onError(null);
    try {
      const uploaded = await ensureVoucherUploaded();
      if ("error" in uploaded) {
        onError(uploaded.error);
        return;
      }
      const result = await readVoucherFields(orderId, uploaded.path);
      if ("error" in result) {
        onError(result.error);
        return;
      }

      // "Leer y rellenar" reemplaza los campos con lo que pertenece a ESTA
      // imagen. El operador puede corregirlos después de la lectura.
      setOperation(result.fields.operationNumber || "");
      setAmount(result.fields.amount !== null ? String(result.fields.amount) : "");
      setPaidAt(toDatetimeLocal(result.fields.paidAt));
      setPayer(result.fields.payerName || "");
      setRecipientCheck({
        status: result.fields.recipientCheck,
        name: result.fields.recipientName,
        phoneLastDigits: result.fields.recipientPhoneLastDigits,
        account: result.fields.recipientAccount,
        swapped: result.fields.recipientSwapped,
        ignoredName: result.fields.recipientIgnoredName,
        receivedView: result.fields.recipientReceivedView,
        yapeEmpresa: result.fields.recipientYapeEmpresa,
      });
      setReadNotice(result.notice);
      if (!result.isVoucher) {
        setReadWarning("La imagen no parece un comprobante Yape completo. Revísala antes de registrar.");
      }
    } finally {
      setReading(false);
    }
  }

  async function submit() {
    setBusy(true);
    onError(null);
    onNotice(null);
    try {
      let path: string | null = null;
      let sha256: string | null = null;
      if (file) {
        const uploaded = await ensureVoucherUploaded();
        if ("error" in uploaded) {
          onError(uploaded.error);
          return;
        }
        path = uploaded.path;
        sha256 = uploaded.sha256;
      }

      const res = await registerPayment(orderId, {
        kind,
        amount: amount.trim() ? Number(amount) : null,
        operationNumber: operation.trim() || null,
        // El input datetime-local da hora local; se convierte a instante real.
        paidAt: paidAt ? new Date(paidAt).toISOString() : null,
        payerName: payer.trim() || null,
        // El celular que aparece en el Yape es el RECEPTOR de Grupo GF, no el
        // teléfono del pagador. Se conserva en la auditoría de visión y no se
        // mezcla con `payer_phone`.
        payerPhone: null,
        path,
        sha256,
      });
      if (res.error) {
        onError(res.error);
        return;
      }
      // Red de seguridad. Desde que el paso 1 se guarda solo, esto ya no es la
      // única oportunidad — cubre el caso de teclear el DNI y darle a registrar
      // sin salir del campo, que no dispara el `onBlur`.
      //
      // Va DESPUÉS del pago y sin condicionarlo: si esto fallara, el cobro ya
      // quedó registrado, que es lo que no puede perderse.
      if (shalomDoc.trim() || shalomAgency) {
        const document = shalomDoc.trim() || null;
        const terminalId = shalomAgency?.id ?? null;
        const pre = await saveShalomOrderDraft(orderId, {
          documentType: shalomDocType,
          document,
          destinyTerminalId: terminalId,
          destinyTerminalName: shalomAgency?.nombre ?? null,
        });
        if ("error" in pre && pre.error) {
          onError(`El pago se registró, pero los datos de Shalom no: ${pre.error}`);
        } else {
          setShalomSaved({ document, terminalId });
        }
      }

      onNotice(res.notice ?? null);
      setAmount("");
      setOperation("");
      setPaidAt("");
      setPayer("");
      setFile(null);
      setUploadedVoucher(null);
      setReadNotice(null);
      setReadWarning(null);
      setRecipientCheck(null);
      // El DNI y la agencia NO se limpian: son del PEDIDO, no de este pago. Se
      // limpiaban porque solo existían como carga del formulario; ahora están
      // guardados y siguen sirviendo para la guía y para el siguiente cobro.
      setDocumentNotice(null);
      onRegistered();
    } finally {
      setBusy(false);
    }
  }

  const preview = useObjectUrl(file);
  const step1Saved = Boolean(shalomSaved.document || shalomSaved.terminalId);
  const canRegisterNow = Boolean(file || operation.trim());
  const hasKinds = availableKinds.length > 0;

  return (
    // Una zona de la tarjeta de cobro. `@container`: lo que cabe al lado de qué
    // lo decide el ancho de la tarjeta, no el de la ventana — la ficha mide
    // 880 px como mucho aunque la pantalla mida el doble.
    <div className={cn(CARD_ZONE, "@container space-y-4")}>
      <div>
        <h4 className="text-sm font-semibold text-ink-900">Registrar un pago</h4>
        <p className="mt-0.5 max-w-[68ch] text-[13px] leading-5 text-ink-500">
          Prepara el destino, coteja la imagen y registra únicamente los datos que realmente aparecen.
        </p>
      </div>

      {/* Con la imagen elegida y sitio de sobra, el comprobante se queda a la
          derecha y fijo mientras se baja por los campos: cotejar es mirar la
          imagen y el campo a la vez, no de memoria. Sin sitio, va dentro del
          paso 2. */}
      <div
        className={cn(
          preview && hasKinds && "@2xl:grid @2xl:grid-cols-[minmax(0,1fr)_15rem] @2xl:items-start @2xl:gap-6",
        )}
      >
        {/* Los tres pasos en una escalera vertical: disco con su número (o el
            visto cuando está hecho), título y su estado en chapa. Antes había
            además una barra de pasos arriba que repetía los mismos tres títulos. */}
        <ol className="min-w-0">
          <Step
            n={1}
            last={!hasKinds}
            done={Boolean(shalomGuide) || step1Saved}
            title="DNI y agencia Shalom"
            badge={
              shalomGuide ? (
                <Badge>Ya en la guía</Badge>
              ) : shalomSaving ? (
                <Badge>Guardando…</Badge>
              ) : shalomSaveError ? (
                <Badge tone="crit">Sin guardar</Badge>
              ) : step1Saved ? (
                <Badge tone="ok">Guardado</Badge>
              ) : (
                <Badge>Opcional</Badge>
              )
            }
            help={
              shalomGuide
                ? undefined
                : "Completa primero estos datos si el cliente recogerá por Shalom. Se guardan solos y quedan listos para crear la guía, aunque el comprobante llegue después."
            }
          >
            {/* Datos de Shalom, adelantados y OPCIONALES (0073).
                Van aquí porque quien registra el Yape acaba de hablar con la clienta y
                tiene el DNI a mano; quien crea la guía suele ser otra persona en otro
                momento, y hoy tiene que volver a pedirlo. Nada de esto condiciona el
                pago: un cobro no puede quedarse esperando a un DNI. */}
            {/* Con la guía ya creada estos datos dejan de ser un borrador: Shalom los
                tiene, los imprimió en su rótulo y el paquete viaja con ellos.
                Editarlos acá no cambia nada allá — solo hace que Kapta y el rótulo
                físico digan cosas distintas, que es peor que no poder tocarlos. La
                salida real es anular la guía y crear otra, y eso se dice. */}
            {shalomGuide ? (
              <>
                <dl className="grid gap-x-6 gap-y-3 @md:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-[13px] leading-5 text-ink-500">Documento</dt>
                    <dd className="mt-0.5 text-sm font-medium tabular-nums text-ink-900">
                      {shalomDoc ? `${shalomDocType} ${shalomDoc}` : "—"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[13px] leading-5 text-ink-500">Agencia de destino</dt>
                    <dd className="mt-0.5 break-words text-sm font-medium text-ink-900">{shalomAgency?.nombre ?? "—"}</dd>
                  </div>
                </dl>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-600">
                  <span>Guía</span>
                  {shalomGuide.guideCode && (
                    <span className="select-all font-mono font-semibold text-ink-900">N° {shalomGuide.guideCode}</span>
                  )}
                  {shalomGuide.codigo && (
                    <span className="rounded bg-wash px-1.5 py-0.5 font-mono text-xs font-medium text-ink-700 ring-1 ring-inset ring-line">
                      {shalomGuide.codigo}
                    </span>
                  )}
                  <span className="text-ink-500">
                    · {operationalLabel(shalomGuide.pickupState ?? shalomGuide.deliveryStatus)}
                  </span>
                </p>
                <p className="max-w-[68ch] text-[13px] leading-5 text-ink-500">
                  El destinatario y el destino ya viajan impresos en el rótulo de Shalom. Para cambiarlos
                  hay que anular esa guía —desde «Salidas y guías»— y crear otra.
                </p>
              </>
            ) : (
              <>
                {/* El guardado ocurre solo, así que tiene que VERSE: una escritura
                    silenciosa que falla es indistinguible de una que funcionó, y eso es
                    justo lo que hacía perder el DNI sin que nadie se enterara. La chapa
                    del paso dice en qué quedó; esta línea lo anuncia al lector. */}
                <p
                  className={cn(
                    "text-[13px] font-medium empty:hidden",
                    shalomSaveError ? "text-crit-fg" : shalomSaving ? "text-ink-500" : "text-ok-fg",
                  )}
                  aria-live="polite"
                >
                  {shalomSaveError
                    ? `No se pudo guardar: ${shalomSaveError}`
                    : shalomSaving
                      ? "Guardando…"
                      : step1Saved
                        ? `Guardado${shalomSaved.document ? ` · ${shalomSaved.document}` : ""}`
                        : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  <select
                    value={shalomDocType}
                    onChange={(e) => {
                      shalomTouched.current = true;
                      setShalomDocType(e.target.value as ShalomDocumentType);
                      setShalomDoc("");
                      setDocumentNotice(null);
                    }}
                    aria-label="Tipo de documento"
                    className={cn(FIELD_BOX, "h-9 w-24 px-2.5 pointer-coarse:h-11")}
                  >
                    <option value="DNI">DNI</option>
                    <option value="RUC">RUC</option>
                    <option value="CE">CE</option>
                  </select>
                  <div className="min-w-[15rem] flex-1">
                    <div className="flex gap-2">
                      <input
                        value={shalomDoc}
                        onChange={(e) => changeDocument(e.target.value)}
                        // Al salir del campo, no en cada tecla: un DNI a medio escribir
                        // no es una decisión, y el servidor lo rechazaría igual.
                        onBlur={() => void persistShalomDraft({})}
                        inputMode={shalomDocType === "CE" ? "text" : "numeric"}
                        maxLength={shalomDocType === "DNI" ? 8 : shalomDocType === "RUC" ? 11 : 20}
                        placeholder={
                          shalomDocType === "DNI"
                            ? "DNI de 8 dígitos"
                            : shalomDocType === "RUC"
                              ? "RUC de 11 dígitos"
                              : "Carné de extranjería"
                        }
                        aria-label="Número de documento"
                        aria-invalid={Boolean(shalomDocumentProblem)}
                        className={cn(FIELD_BOX, "h-9 min-w-0 flex-1 px-3 tabular-nums pointer-coarse:h-11")}
                      />
                      <OpsButton
                        onClick={validateDocument}
                        disabled={documentChecking || !shalomDoc.trim() || Boolean(shalomDocumentProblem)}
                        className="pointer-coarse:h-11"
                      >
                        {documentChecking ? "Validando…" : "Validar"}
                      </OpsButton>
                    </div>
                    {shalomDocumentProblem && (
                      <p className="mt-1.5 text-[13px] font-medium text-crit-fg">{shalomDocumentProblem}</p>
                    )}
                    {!shalomDocumentProblem && shalomDoc && !documentNotice && (
                      <p className="mt-1.5 flex items-center gap-1 text-[13px] font-medium text-ok-fg">
                        <IconCheck aria-hidden className="size-3.5" />
                        Formato válido
                      </p>
                    )}
                    {documentNotice && <p className="mt-1.5 text-[13px] leading-5 text-ink-600">{documentNotice}</p>}
                  </div>
                </div>
                <div className="relative">
                  {shalomAgency ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-ok-wash px-3 py-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-sm font-semibold text-ink-900">
                          <IconCheck aria-hidden className="size-4 shrink-0 text-ok-fg" />
                          <span className="truncate">{shalomAgency.nombre}</span>
                        </p>
                        <p className="truncate pl-[22px] text-[13px] text-ink-600">
                          {/* La agencia rescatada del borrador solo trae id y nombre: sin
                              esto quedaría un "#612 · " con el separador colgando. */}
                          {[
                            `#${shalomAgency.id}`,
                            shalomAgency.departamento,
                            shalomAgency.provincia,
                            shalomAgency.distrito,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <OpsButton
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          shalomTouched.current = true;
                          setShalomAgency(null);
                          setShalomAgencyQuery("");
                          // Quitarla también se guarda: si no, recargar la resucitaría.
                          void persistShalomDraft({ terminalId: null, terminalName: null });
                        }}
                        className="shrink-0 pointer-coarse:h-11"
                      >
                        Cambiar
                      </OpsButton>
                    </div>
                  ) : (
                    <>
                      <input
                        value={shalomAgencyQuery}
                        onChange={(e) => setShalomAgencyQuery(e.target.value)}
                        placeholder="Buscar agencia por ciudad, distrito o nombre"
                        aria-label="Agencia Shalom de destino"
                        autoComplete="off"
                        role="combobox"
                        aria-expanded={shalomAgencies.length > 0}
                        className={cn(FIELD, "pointer-coarse:h-11")}
                      />
                      {agencySearching && <p className="mt-1.5 text-[13px] text-ink-500">Buscando agencias…</p>}
                      {agencyError && <p className="mt-1.5 text-[13px] font-medium text-crit-fg">{agencyError}</p>}
                      {!agencySearching && !agencyError && shalomAgencyQuery.trim().length >= 2 && shalomAgencies.length === 0 && (
                        <p className="mt-1.5 text-[13px] text-ink-500">No encontramos agencias con ese texto.</p>
                      )}
                      {shalomAgencies.length > 0 && (
                        <ul
                          role="listbox"
                          className="absolute z-30 mt-1 max-h-52 w-full overflow-y-auto rounded-lg bg-white p-1 shadow-pop"
                        >
                          {shalomAgencies.map((agency) => (
                            <li key={agency.id} role="option" aria-selected="false">
                              <button
                                type="button"
                                onClick={() => {
                                  shalomTouched.current = true;
                                  setShalomAgency(agency);
                                  setShalomAgencyQuery(agency.nombre);
                                  setShalomAgencies([]);
                                  // Elegirla ES la decisión: se guarda aquí, no al pagar.
                                  void persistShalomDraft({
                                    terminalId: agency.id,
                                    terminalName: agency.nombre,
                                  });
                                }}
                                className="block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-wash"
                              >
                                <span className="text-sm font-semibold text-ink-900">{agency.nombre}</span>{" "}
                                <span className="text-xs tabular-nums text-ink-500">#{agency.id}</span>
                                <span className="block text-[13px] text-ink-600">
                                  {[agency.departamento, agency.provincia, agency.distrito].filter(Boolean).join(" · ")}
                                </span>
                                {agency.direccion && (
                                  <span className="block truncate text-xs text-ink-500">{agency.direccion}</span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </Step>

          {hasKinds && (
            <>
              <Step
                n={2}
                done={Boolean(file)}
                title="Comprobante de Yape"
                badge={readNotice ? <Badge tone="ok">Leído</Badge> : file ? <Badge>Imagen cargada</Badge> : undefined}
                help="Pega o sube la imagen. Permanecerá grande y visible mientras cotejas la lectura."
              >
                <VoucherPicker file={file} preview={preview} onPick={pickVoucher} />
                {file && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-wash px-4 py-3">
                    <div className="min-w-0 flex-1 basis-60">
                      <p className="text-sm font-semibold text-ink-900">Leer datos del comprobante</p>
                      <p className="text-[13px] leading-5 text-ink-600">
                        Obtiene monto, operación, fecha y cuenta receptora. Tú confirmas contra la imagen.
                      </p>
                    </div>
                    {/* El paso que toca lleva el azul: antes de leer es «Leer y
                        rellenar»; después, «Registrar». Un solo principal a la vez. */}
                    <OpsButton
                      variant={readNotice ? "secondary" : "primary"}
                      onClick={readAndPrefill}
                      disabled={reading || busy || pending}
                      className="shrink-0 pointer-coarse:h-11"
                    >
                      {reading ? "Leyendo imagen…" : readNotice ? "Volver a leer" : "Leer y rellenar"}
                    </OpsButton>
                    {readNotice && (
                      <p className="flex basis-full items-start gap-1.5 text-[13px] font-medium leading-5 text-ok-fg">
                        <IconCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
                        <span>{readNotice}</span>
                      </p>
                    )}
                    {readWarning && (
                      <p className="flex basis-full items-start gap-1.5 text-[13px] font-medium leading-5 text-warn-fg">
                        <IconAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                        <span>{readWarning}</span>
                      </p>
                    )}
                  </div>
                )}
              </Step>

              <Step
                n={3}
                last
                done={Boolean(readNotice)}
                title="Revisa y registra"
                badge={
                  progress.registeredRemaining !== null ? (
                    <Badge className="tabular-nums">Saldo por cargar: S/ {progress.registeredRemaining.toFixed(2)}</Badge>
                  ) : undefined
                }
                help={
                  file
                    ? "Contrasta los datos rellenados con el comprobante."
                    : "También puedes completar los datos manualmente si no tienes una imagen."
                }
              >
                {availableKinds.length === 1 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-wash px-4 py-2.5">
                    <p className="text-[13px] text-ink-600">
                      Tipo de este pago: <strong className="font-semibold text-ink-900">Diferencia</strong>
                    </p>
                    <span className="text-[13px] text-ink-600">El adelanto ya fue registrado</span>
                  </div>
                ) : (
                  // El control segmentado de DESIGN.md: pista en `wash` y la
                  // opción elegida en blanco con sombra de control.
                  <div
                    className="grid grid-cols-2 gap-0.5 rounded-lg bg-wash p-0.5 ring-1 ring-inset ring-line"
                    role="radiogroup"
                    aria-label="Tipo del primer pago"
                  >
                    {availableKinds.map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={kind === value}
                        onClick={() => setKind(value)}
                        className={cn(
                          "h-8 min-w-0 rounded-md px-2 text-[13px] font-semibold transition-colors pointer-coarse:h-11",
                          kind === value
                            ? "bg-white text-ink-900 shadow-control ring-1 ring-line"
                            : "text-ink-600 hover:text-ink-900",
                        )}
                      >
                        {value === "adelanto" ? "Adelanto" : "Pago total"}
                      </button>
                    ))}
                  </div>
                )}

                {/* Su propio `@container`: al lado de la imagen hay menos sitio
                    que a todo el ancho, y los campos se acomodan a lo que tienen. */}
                <div className="@container space-y-3">
                  <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
                    <label className={LABEL}>
                      Monto
                      <input
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        inputMode="decimal"
                        placeholder={
                          kind === "adelanto"
                            ? `Mínimo S/ ${SHALOM_MINIMUM_ADVANCE.toFixed(0)}`
                            : progress.registeredRemaining !== null
                              ? `Saldo S/ ${progress.registeredRemaining.toFixed(2)}`
                              : "Monto leído"
                        }
                        className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
                      />
                    </label>
                    <label className={LABEL}>
                      Nº de operación
                      <input
                        value={operation}
                        onChange={(e) => setOperation(e.target.value)}
                        placeholder="Número del Yape"
                        className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
                      />
                    </label>
                    <label className={LABEL}>
                      Fecha y hora
                      <input
                        type="datetime-local"
                        value={paidAt}
                        onChange={(e) => setPaidAt(e.target.value)}
                        className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
                      />
                    </label>
                  </div>
                  <RecipientAccountCheck reading={recipientCheck} accounts={accounts} />
                </div>
              </Step>
            </>
          )}
        </ol>

        {preview && hasKinds && (
          <div className="sticky top-[calc(var(--ficha-head,9rem)_+_1rem)] hidden space-y-1.5 @2xl:block">
            <VoucherPreview src={preview} tall />
            <p className="text-xs text-ink-500">Haz clic en la imagen para ampliarla.</p>
          </div>
        )}
      </div>

      {hasKinds ? (
        <div className={cn(CARD_ZONE, "flex flex-wrap items-center justify-between gap-3")}>
          <p className="max-w-md text-[13px] leading-5 text-ink-500">
            La lectura rellena datos, pero no valida el ingreso. El pago quedará pendiente de revisión.
          </p>
          <OpsButton
            variant={file && !readNotice ? "secondary" : "primary"}
            disabled={busy || reading || pending || !canRegisterNow}
            onClick={submit}
            className="pointer-coarse:h-11"
          >
            {busy ? "Registrando…" : `Registrar ${kind === "total" ? "pago total" : kind}`}
          </OpsButton>
          {!canRegisterNow && (
            <p className="basis-full text-[13px] text-ink-500">
              Elige la imagen del Yape, o escribe el nº de operación si lo registrarás manualmente.
            </p>
          )}
        </div>
      ) : (
        <Banner tone="ok" title="El monto cargado ya cubre el total del pedido.">
          No corresponde registrar otro comprobante mientras estos pagos sigan vigentes.
        </Banner>
      )}
    </div>
  );
}

function KeySection({
  panel,
  orderId,
  pending,
  embedded = false,
  onSetKey,
  onShare,
  onSendWhatsapp,
  onError,
}: {
  panel: PanelData;
  orderId: string;
  pending: boolean;
  embedded?: boolean;
  onSetKey: (key: string) => void;
  onShare: (channel: string, note: string) => void;
  /** Manda la clave por WhatsApp de la tienda y registra la entrega. */
  onSendWhatsapp: () => void;
  onError: (msg: string | null) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [channel, setChannel] = useState("whatsapp");
  const [shareNote, setShareNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function reveal(override: boolean) {
    setBusy(true);
    onError(null);
    try {
      const res = await revealPickupKey(orderId, { reason, override });
      if ("error" in res) {
        onError(res.error);
        setRevealed(null);
      } else {
        setRevealed(res.key);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("space-y-3", !embedded && "rounded-lg p-4 ring-1 ring-inset ring-line")}>
      <div>
        <h4 className="text-sm font-semibold text-ink-900">Credencial de recojo Shalom</h4>
        <p className="mt-0.5 max-w-[68ch] text-[13px] leading-5 text-ink-500">
          Pertenece a la salida Shalom. El pago completo controla cuándo puede mostrarse y entregarse.
        </p>
      </div>

      {!panel.hasKey ? (
        panel.canManageKey ? (
          <div className="flex flex-wrap gap-2">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="Clave emitida por Shalom"
              aria-label="Clave emitida por Shalom"
              autoComplete="off"
              className={cn(FIELD_BOX, "h-9 min-w-48 flex-1 px-3 font-mono pointer-coarse:h-11")}
            />
            <OpsButton
              disabled={pending || !newKey.trim()}
              onClick={() => {
                onSetKey(newKey);
                setNewKey("");
              }}
              className="pointer-coarse:h-11"
            >
              Registrar clave
            </OpsButton>
          </div>
        ) : (
          <p className="text-[13px] text-ink-500">Todavía no se ha registrado la clave.</p>
        )
      ) : (
        <>
          {!panel.canReveal && (
            <Banner tone="warn" title="Clave bloqueada">
              {panel.blockers}
            </Banner>
          )}
          {panel.canViewKey ? (
            <div className="space-y-2">
              {revealed ? (
                // Sin fondo oscuro: este mundo no tiene tema oscuro parcial. La
                // clave se lee por el tamaño y la monoespaciada, y se copia de un clic.
                <p className="select-all rounded-md bg-wash px-3 py-2 font-mono text-lg font-semibold tracking-widest text-ink-900 ring-1 ring-inset ring-line">
                  {revealed}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <OpsButton
                    variant="primary"
                    disabled={busy || !panel.canReveal}
                    onClick={() => reveal(false)}
                    className="pointer-coarse:h-11"
                  >
                    Mostrar clave
                  </OpsButton>
                  {!panel.canReveal && panel.canOverride && (
                    <>
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Motivo de la excepción (obligatorio)"
                        aria-label="Motivo de la excepción"
                        className={cn(FIELD_BOX, "h-9 min-w-48 flex-1 px-3 pointer-coarse:h-11")}
                      />
                      <OpsButton
                        variant="danger"
                        disabled={busy || !reason.trim()}
                        onClick={() => reveal(true)}
                        className="pointer-coarse:h-11"
                      >
                        Mostrar como excepción
                      </OpsButton>
                    </>
                  )}
                </div>
              )}
              <p className="text-[13px] leading-5 text-ink-500">
                Cada visualización queda registrada con tu usuario, la fecha y el estado de los
                pagos en ese momento.
              </p>
            </div>
          ) : (
            <p className="text-[13px] text-ink-500">
              Tu rol no permite ver la clave; solicítala a un administrador.
            </p>
          )}

          {panel.canViewKey && panel.canReveal && (
            // El envío que no salió solo (10-10-2026): la clave de un pago que
            // validó el estado de cuenta antes de que lo hiciera, o una que la
            // clienta perdió. Mismas rejas que al validar (ventana de 24 h
            // incluida); si no se puede, el aviso dice por qué.
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
              <OpsButton variant="primary" disabled={pending} onClick={onSendWhatsapp} className="pointer-coarse:h-11">
                Enviar clave por WhatsApp
              </OpsButton>
              <p className="text-[13px] leading-5 text-ink-500">
                {panel.shares.length ? "Ya consta una entrega; enviarla otra vez la repite." : "Todavía no consta ninguna entrega."}
              </p>
            </div>
          )}

          {panel.canViewKey && panel.canReveal && (
            <div className="flex flex-wrap gap-2 pt-1">
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                aria-label="Canal de entrega"
                className={cn(FIELD_BOX, "h-9 w-auto px-2.5 pointer-coarse:h-11")}
              >
                <option value="whatsapp">WhatsApp</option>
                <option value="llamada">Llamada</option>
                <option value="mensaje">Mensaje</option>
                <option value="otro">Otro</option>
              </select>
              <input
                value={shareNote}
                onChange={(e) => setShareNote(e.target.value)}
                placeholder="Observación (opcional)"
                aria-label="Observación de la entrega"
                className={cn(FIELD_BOX, "h-9 min-w-48 flex-1 px-3 pointer-coarse:h-11")}
              />
              <OpsButton
                disabled={pending}
                onClick={() => {
                  onShare(channel, shareNote);
                  setShareNote("");
                }}
                className="pointer-coarse:h-11"
              >
                Registrar entrega al cliente
              </OpsButton>
            </div>
          )}
        </>
      )}

      {panel.shares.length > 0 && (
        <ul className="space-y-1 text-[13px] leading-5 text-ink-600">
          {panel.shares.map((s) => (
            <li key={s.id}>
              Enviada por {s.channel} el <span className="tabular-nums">{fmtDateTime(s.shared_at)}</span>
              {s.note ? ` — ${s.note}` : ""}
            </li>
          ))}
        </ul>
      )}

      {panel.views.length > 0 && (
        <details className="group text-[13px] text-ink-600">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 font-medium hover:text-ink-900 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <IconChevronDown
              aria-hidden
              className="size-4 -rotate-90 text-ink-500 transition-transform duration-150 group-open:rotate-0 motion-reduce:transition-none"
            />
            Consultas de la clave ({panel.views.length})
          </summary>
          <ul className="mt-1 space-y-1 pl-5.5">
            {panel.views.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-x-2">
                <span className="tabular-nums">{fmtDateTime(v.viewed_at)}</span>
                {v.override && <Badge tone="crit">Excepción</Badge>}
                {v.reason ? <span>— {v.reason}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
