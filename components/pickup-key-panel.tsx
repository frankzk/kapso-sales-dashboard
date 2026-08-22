"use client";

// Panel de pagos Yape y gestión de la credencial Shalom dentro del pedido.
//
// La clave NUNCA aparece en el listado ni en exportaciones: solo aquí, tras una
// acción explícita, y cada visualización queda registrada. El botón de mostrar
// solo aparece cuando el servidor ya dijo que se puede — y aun así el servidor
// lo vuelve a comprobar antes de descifrar nada.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import {
  completePaymentData,
  createVoucherUpload,
  loadPaymentPanel,
  readVoucherFields,
  registerPayment,
  rejectPayment,
  revealPickupKey,
  setPickupKey,
  sharePickupKey,
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

const STATUS_TONE: Record<string, string> = {
  validado: "bg-emerald-100 text-emerald-800",
  rechazado: "bg-slate-200 text-slate-600",
  posible_duplicado: "bg-red-100 text-red-800",
  info_incompleta: "bg-amber-100 text-amber-800",
};

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
    <div className={cn("space-y-2", className)}>
      <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        Intentar nuevamente
      </button>
    </div>
  );
}

export function PickupKeyPanel({
  orderId,
  onChanged,
  mode = "required",
}: {
  orderId: string;
  onChanged: () => void;
  mode?: OrderPaymentPanelMode;
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

  if (!panel) {
    if (error) return <PanelLoadError message={error} onRetry={() => void reload()} />;
    return <p className="text-sm text-slate-400">Cargando pagos…</p>;
  }

  const paymentOptional = mode === "optional";
  const paymentLabel =
    paymentOptional && panel.paymentState === "sin_pago"
      ? "Sin pago requerido"
      : PAYMENT_STATE_LABEL[panel.paymentState as PaymentState] ?? panel.paymentState;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3
            className={cn(
              "text-xs font-bold uppercase tracking-[0.12em]",
              paymentOptional ? "text-slate-700" : "text-amber-900",
            )}
          >
            Cobro para envío por agencia
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {paymentOptional
              ? "Opcional para Provincia COD. Úsalo si el pedido irá por Agencia o el historial del cliente exige adelanto."
              : "El pago acumulado habilita la guía; el pago completo permite entregar la clave desde la salida Shalom."}
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
          {paymentLabel}
        </span>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
      )}

      <PaymentMoneySummary payments={panel.payments} orderTotal={panel.orderTotal} />

      <PaymentList
        payments={panel.payments}
        accounts={panel.collectionAccounts}
        canValidate={panel.canValidate}
        canRegister={panel.canRegister}
        pending={pending}
        onValidate={(id) => run(() => validatePayment(id))}
        onReject={(id, reason) => run(() => rejectPayment(id, reason))}
        onComplete={(id, data) => run(() => completePaymentData(id, data))}
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

  if (!panel) {
    if (error) {
      return (
        <PanelLoadError
          message={error}
          onRetry={() => void reload()}
          className="border-t border-sky-100 pt-3"
        />
      );
    }
    return (
      <p className="border-t border-sky-100 pt-3 text-sm text-slate-400">
        Cargando credencial Shalom…
      </p>
    );
  }

  return (
    <div className="space-y-3 border-t border-sky-100 pt-3">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
      )}
      <KeySection
        panel={panel}
        orderId={orderId}
        pending={pending}
        embedded
        onSetKey={(key) => run(() => setPickupKey(orderId, key))}
        onShare={(channel, note) => run(() => sharePickupKey(orderId, { channel, note }))}
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

  return (
    <div className="space-y-2 rounded-lg bg-slate-50 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
        <p className="font-semibold text-slate-900">
          S/ {progress.validatedTotal.toFixed(2)} validados
          {progress.orderTotal !== null ? ` de S/ ${progress.orderTotal.toFixed(2)}` : ""}
        </p>
        <p className="text-xs text-slate-600">
          Cargado: <strong className="text-slate-800">S/ {progress.registeredTotal.toFixed(2)}</strong>
          {progress.registeredRemaining !== null && (
            <> · Saldo por cargar: <strong className="text-slate-800">S/ {progress.registeredRemaining.toFixed(2)}</strong></>
          )}
        </p>
      </div>
      {progress.orderTotal !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-200" aria-label={`${ratio}% del pedido validado`}>
          <div className="h-full rounded-full bg-emerald-600 transition-[width] duration-200" style={{ width: `${ratio}%` }} />
        </div>
      )}
      <p
        className={cn(
          "text-xs font-medium",
          progress.advanceValidated
            ? "text-emerald-700"
            : progress.advanceRegistered
              ? "text-amber-700"
              : "text-slate-500",
        )}
      >
        {progress.advanceValidated ? "✓ " : progress.advanceRegistered ? "◷ " : ""}
        {advanceCopy}
      </p>
    </div>
  );
}

function PaymentList({
  payments,
  accounts,
  canValidate,
  canRegister,
  pending,
  onValidate,
  onReject,
  onComplete,
}: {
  payments: PaymentRow[];
  /** Las cuentas de cobro de la tienda, para juzgar el receptor de cada uno. */
  accounts: CollectionAccount[];
  canValidate: boolean;
  canRegister: boolean;
  pending: boolean;
  onValidate: (id: string) => void;
  onReject: (id: string, reason: string) => void;
  onComplete: (id: string, data: { operationNumber: string; amount: number | null; paidAt: string | null }) => void;
}) {
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  if (!payments.length) {
    return <p className="text-sm text-slate-400">Todavía no se ha cargado ningún comprobante.</p>;
  }

  return (
    <ul className="space-y-2">
      {payments.map((p) => (
        <li key={p.id} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium capitalize text-slate-800">{p.kind}</span>
            {p.amount !== null && <span className="text-slate-700">S/ {p.amount.toFixed(2)}</span>}
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                STATUS_TONE[p.validation_status] ?? "bg-slate-100 text-slate-700",
              )}
            >
              {STATUS_LABEL[p.validation_status] ?? p.validation_status}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            {p.operation_number ? `Op. ${p.operation_number} · ` : ""}
            {fmtDateTime(p.paid_at)}
            {p.payer_name ? ` · Pagó: ${p.payer_name}` : ""}
          </p>
          <StoredRecipientStatus
            vision={p.vision}
            hasVoucher={Boolean(p.file_path)}
            accounts={accounts}
          />
          {p.notes && <p className="text-xs text-slate-500">{p.notes}</p>}
          {/* El comprobante se guardaba y no se podía ver: quien validaba tenía
              que fiarse de los campos transcritos, que es justo lo que la imagen
              sirve para contrastar. La miniatura abre el original en pestaña. */}
          {p.file_path && (
            <a
              href={`/api/payments/${p.id}/voucher`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex flex-col items-start gap-1"
              title="Ver el comprobante en grande"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/payments/${p.id}/voucher`}
                alt="Comprobante de Yape"
                className="max-h-64 max-w-full rounded-lg border border-slate-200 bg-slate-50 object-contain"
              />
              <span className="text-[11px] font-medium text-brand-700">Abrir a tamaño completo</span>
            </a>
          )}
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
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                disabled={
                  pending ||
                  yapeRecipientReadingFromVision(p.vision, accounts).status === "mismatch"
                }
                onClick={() => onValidate(p.id)}
                title={
                  yapeRecipientReadingFromVision(p.vision, accounts).status === "mismatch"
                    ? "El receptor leído no coincide con ninguna cuenta de cobro de la tienda"
                    : "Validar comprobante"
                }
                className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Validar
              </button>
              {rejecting === p.id ? (
                <>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Motivo del rechazo"
                    className="flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                  />
                  <button
                    disabled={pending || !reason.trim()}
                    onClick={() => {
                      onReject(p.id, reason);
                      setRejecting(null);
                      setReason("");
                    }}
                    className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 disabled:opacity-50"
                  >
                    Confirmar rechazo
                  </button>
                </>
              ) : (
                <button
                  disabled={pending}
                  onClick={() => setRejecting(p.id)}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Rechazar
                </button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function StoredRecipientStatus({
  vision,
  hasVoucher,
  accounts,
}: {
  vision: unknown;
  hasVoucher: boolean;
  accounts: CollectionAccount[];
}) {
  const reading = yapeRecipientReadingFromVision(vision, accounts);
  if (!hasVoucher && reading.status === "missing") return null;
  const label =
    reading.status === "verified"
      // Se nombra la cuenta con la que encajó: con varias cuentas de cobro,
      // "verificada" a secas ya no dice a cuál llegó el dinero.
      ? `Cuenta receptora verificada: ${reading.account?.name ?? "cuenta de cobro"} · ***${reading.account?.phoneLastDigits ?? "···"}`
      : reading.status === "mismatch"
        ? `Receptor distinto: ${reading.name ?? "nombre no leído"} · ${
            reading.phoneLastDigits ? `***${reading.phoneLastDigits}` : "celular no leído"
          }`
        : // El voucher corta el destinatario y esa lectura corta NO acusa a
          // nadie: se nombra lo leído para que se contraste con la imagen, sin
          // afirmar que la cuenta sea otra.
          verifyYapeRecipient(reading.name, reading.phoneLastDigits, accounts).nameCutShort
          ? `Destinatario leído a medias: «${reading.name}». Contrasta la imagen antes de validar.`
          : reading.status === "partial"
            ? "Cuenta receptora parcialmente leída. Contrasta la imagen antes de validar."
            : "La cuenta receptora no pudo leerse. Contrasta la imagen antes de validar.";
  return (
    <p
      className={cn(
        "mt-1 text-xs font-medium",
        reading.status === "verified"
          ? "text-emerald-700"
          : reading.status === "mismatch"
            ? "text-red-700"
            : "text-amber-700",
      )}
    >
      {reading.status === "verified" ? "✓ " : "⚠ "}
      {label}
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
function VoucherPicker({ file, onPick }: { file: File | null; onPick: (f: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    // Sin esto cada imagen elegida deja su blob retenido en memoria.
    return () => URL.revokeObjectURL(url);
  }, [file]);

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
      className={cn(
        "rounded-lg border border-dashed px-3 py-3 transition",
        over ? "border-brand-500 bg-brand-50" : "border-slate-300",
      )}
    >
      {preview ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,0.9fr)_minmax(0,1.1fr)]">
          <a
            href={preview}
            target="_blank"
            rel="noreferrer"
            className="grid min-h-72 place-items-center rounded-lg bg-slate-100 p-3"
            title="Abrir comprobante a tamaño completo"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt="Comprobante por subir"
              className="max-h-[28rem] w-full rounded-md object-contain"
            />
          </a>
          <div className="space-y-2 self-start text-xs text-slate-600">
            <p className="font-medium text-slate-800">{file?.name}</p>
            <p>{file ? `${Math.round(file.size / 1024)} KB · ${file.type || "imagen"}` : ""}</p>
            <p>La imagen queda visible mientras cotejas los datos leídos. Haz clic para ampliarla.</p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          Arrastra el comprobante aquí, <strong>pégalo con Ctrl+V</strong> o elígelo con el botón.
        </p>
      )}
      {/* El input nativo se pintaba como texto suelto ("Seleccionar archivo /
          Ningún archivo seleccionado") y no se leía como algo pulsable. Se
          esconde y se pone un botón de verdad. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          {file ? "Cambiar imagen" : "Elegir imagen del Yape"}
        </button>
        {file && (
          <button
            type="button"
            onClick={() => {
              onPick(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="text-xs text-slate-500 underline hover:text-slate-700"
          >
            Quitar
          </button>
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
    <div className="mt-1.5 space-y-1.5 rounded-lg bg-amber-50 px-2.5 py-2">
      <p className="text-xs text-amber-900">
        Sin nº de operación no se puede validar. Si la captura está recortada, pide al cliente el
        comprobante completo o escribe el número aquí.
      </p>
      {canRegister && (
        <div className="flex flex-wrap gap-1.5">
          <input
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
            placeholder="Nº de operación"
            autoComplete="off"
            className="w-40 rounded-lg border border-amber-200 px-2 py-1 text-xs"
          />
          {payment.amount === null && (
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="Monto"
              className="w-24 rounded-lg border border-amber-200 px-2 py-1 text-xs"
            />
          )}
          {!payment.paid_at && (
            <input
              type="datetime-local"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              className="rounded-lg border border-amber-200 px-2 py-1 text-xs"
            />
          )}
          <button
            disabled={pending || operation.replace(/[^a-z0-9]/gi, "").length < 4}
            onClick={() =>
              onComplete(payment.id, {
                operationNumber: operation,
                amount: amount.trim() ? Number(amount) : null,
                paidAt: paidAt ? new Date(paidAt).toISOString() : null,
              })
            }
            className="rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            Completar datos
          </button>
        </div>
      )}
    </div>
  );
}

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
    <div
      className={cn(
        "rounded-lg border bg-white px-3 py-2",
        tone === "neutral"
          ? "border-slate-200"
          : tone === "ok"
            ? "border-emerald-300 bg-emerald-50/50"
            : tone === "partial"
              ? "border-amber-300 bg-amber-50/50"
              : "border-red-300 bg-red-50/50",
      )}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold",
            tone === "neutral"
              ? "bg-slate-100 text-slate-400"
              : tone === "ok"
                ? "bg-emerald-600 text-white"
                : tone === "partial"
                  ? "bg-amber-500 text-white"
                  : "bg-red-600 text-white",
          )}
        >
          {tone === "neutral" ? "·" : tone === "ok" ? "✓" : tone === "partial" ? "~" : "×"}
        </span>
        <span className={cn("min-w-0 truncate text-sm font-semibold", present ? "text-slate-900" : "text-slate-400")}>
          {value}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">Debe coincidir con {expected}</p>
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
  const verification = verifyYapeRecipient(reading?.name, reading?.phoneLastDigits, accounts);
  // Corregir la lectura invertida en silencio sería peor que no corregirla: esto
  // decide si el dinero se desvió, y quien valida tiene que saber que el nombre
  // que está viendo salió del campo del pagador.
  const swapNotice = reading?.swapped
    ? " La lectura vino con el pagador y el receptor cambiados de sitio; se corrigió, pero contrasta la imagen."
    : "";
  const message =
    verification.status === "verified"
      ? `Cuenta receptora verificada: ${verification.account?.name ?? ""}. Las dos señales coinciden.`
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
  const fullMessage = message + swapNotice;

  return (
    <fieldset className="rounded-lg bg-slate-50 p-3" aria-live="polite">
      <legend className="px-1 text-xs font-semibold text-slate-700">Cuenta receptora del Yape</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <RecipientSignal
          label="Destinatario leído"
          value={reading?.name ?? "Pendiente de lectura"}
          expected={accounts.map((a) => a.name).join(" o ") || "una cuenta de cobro configurada"}
          present={verification.hasName}
          matches={verification.nameMatches}
          cutShort={verification.nameCutShort}
        />
        <RecipientSignal
          label="Celular receptor"
          value={reading?.phoneLastDigits ? `*** *** ${reading.phoneLastDigits}` : "Pendiente de lectura"}
          expected={
            accounts.map((a) => `terminación ${a.phoneLastDigits}`).join(" o ") ||
            "una cuenta de cobro configurada"
          }
          present={verification.hasPhone}
          matches={verification.phoneMatches}
        />
      </div>
      <p
        className={cn(
          "mt-2 text-xs font-medium",
          verification.status === "verified"
            ? "text-emerald-700"
            : verification.status === "mismatch"
              ? "text-red-700"
              : verification.status === "partial"
                ? "text-amber-700"
                : "text-slate-500",
        )}
      >
        {verification.status === "verified" ? "✓ " : verification.status === "mismatch" ? "⚠ " : ""}
        {fullMessage}
      </p>
    </fieldset>
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

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 p-3">
      <div>
        <p className="text-sm font-semibold text-slate-900">Registrar un pago</p>
        <p className="mt-0.5 text-xs text-slate-500">
          Prepara el destino, coteja la imagen y registra únicamente los datos que realmente aparecen.
        </p>
      </div>
      <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        {[
          // Lo GUARDADO, no lo tecleado: ver `shalomSaved`.
          ["1", "DNI y agencia", Boolean(shalomSaved.document || shalomSaved.terminalId)],
          ["2", "Comprobante", Boolean(file)],
          ["3", "Revisar y registrar", Boolean(readNotice)],
        ].map(([step, label, done]) => (
          <div
            key={String(step)}
            className={cn(
              "flex items-center justify-center gap-1.5 border-r border-slate-200 px-2 py-2 text-[11px] font-semibold last:border-r-0",
              done ? "bg-emerald-50 text-emerald-700" : "text-slate-500",
            )}
          >
            <span
              className={cn(
                "grid size-5 place-items-center rounded-full text-[10px]",
                done ? "bg-emerald-600 text-white" : "bg-white text-slate-500 ring-1 ring-slate-200",
              )}
            >
              {done ? "✓" : step}
            </span>
            {label}
          </div>
        ))}
      </div>

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
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">1. DNI y agencia Shalom</p>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
              🔒 Ya en la guía
            </span>
          </div>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-slate-400">Documento</dt>
              <dd className="font-medium text-slate-800">
                {shalomDoc ? `${shalomDocType} ${shalomDoc}` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Agencia de destino</dt>
              <dd className="font-medium text-slate-800">{shalomAgency?.nombre ?? "—"}</dd>
            </div>
          </dl>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
            <span>Guía</span>
            {shalomGuide.guideCode && (
              <span className="font-mono font-semibold text-slate-800">
                N° {shalomGuide.guideCode}
              </span>
            )}
            {shalomGuide.codigo && (
              <span className="rounded bg-white px-1.5 py-0.5 font-mono font-medium text-slate-700 ring-1 ring-slate-200">
                {shalomGuide.codigo}
              </span>
            )}
            <span className="text-slate-500">
              · {operationalLabel(shalomGuide.pickupState ?? shalomGuide.deliveryStatus)}
            </span>
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            El destinatario y el destino ya viajan impresos en el rótulo de Shalom. Para cambiarlos
            hay que anular esa guía —desde «Salidas y guías»— y crear otra.
          </p>
        </div>
      ) : (
      <details open className="rounded-lg bg-slate-50 px-3 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
          1. DNI y agencia Shalom <span className="font-normal text-slate-500">(opcional)</span>
        </summary>
        <p className="mt-2 text-xs text-slate-400">
          Completa primero estos datos si el cliente recogerá por Shalom. Se guardan solos y quedan
          listos para crear la guía, aunque el comprobante llegue después.
        </p>
        {/* El guardado ocurre solo, así que tiene que VERSE: una escritura
            silenciosa que falla es indistinguible de una que funcionó, y eso es
            justo lo que hacía perder el DNI sin que nadie se enterara. */}
        {(shalomSaving || shalomSaveError || shalomSaved.document || shalomSaved.terminalId) && (
          <p
            className={cn(
              "mt-1 text-xs font-medium",
              shalomSaveError ? "text-red-600" : shalomSaving ? "text-slate-500" : "text-emerald-600",
            )}
            aria-live="polite"
          >
            {shalomSaveError
              ? `No se pudo guardar: ${shalomSaveError}`
              : shalomSaving
                ? "Guardando…"
                : `✓ Guardado${shalomSaved.document ? ` · ${shalomSaved.document}` : ""}`}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            value={shalomDocType}
            onChange={(e) => {
              shalomTouched.current = true;
              setShalomDocType(e.target.value as ShalomDocumentType);
              setShalomDoc("");
              setDocumentNotice(null);
            }}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          >
            <option value="DNI">DNI</option>
            <option value="RUC">RUC</option>
            <option value="CE">CE</option>
          </select>
          <div className="min-w-[260px] flex-1">
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
                aria-invalid={Boolean(shalomDocumentProblem)}
                className={cn(
                  "min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-sm outline-none focus:ring-2",
                  shalomDocumentProblem
                    ? "border-red-300 focus:border-red-400 focus:ring-red-100"
                    : shalomDoc
                      ? "border-emerald-300 focus:border-emerald-400 focus:ring-emerald-100"
                      : "border-slate-200 focus:border-brand-400 focus:ring-brand-100",
                )}
              />
              <button
                type="button"
                onClick={validateDocument}
                disabled={documentChecking || !shalomDoc.trim() || Boolean(shalomDocumentProblem)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                {documentChecking ? "Validando…" : "Validar"}
              </button>
            </div>
            {shalomDocumentProblem && (
              <p className="mt-1 text-xs font-medium text-red-600">{shalomDocumentProblem}</p>
            )}
            {!shalomDocumentProblem && shalomDoc && !documentNotice && (
              <p className="mt-1 text-xs font-medium text-emerald-600">
                ✓ Formato válido
              </p>
            )}
            {documentNotice && (
              <p className="mt-1 text-xs text-slate-600">{documentNotice}</p>
            )}
          </div>
        </div>
        <div className="relative mt-2">
          {shalomAgency ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-emerald-900">
                  ✓ {shalomAgency.nombre}
                </p>
                <p className="truncate text-xs text-emerald-700">
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
              <button
                type="button"
                onClick={() => {
                  shalomTouched.current = true;
                  setShalomAgency(null);
                  setShalomAgencyQuery("");
                  // Quitarla también se guarda: si no, recargar la resucitaría.
                  void persistShalomDraft({ terminalId: null, terminalName: null });
                }}
                className="shrink-0 text-xs font-medium text-emerald-800 underline"
              >
                Cambiar
              </button>
            </div>
          ) : (
            <>
              <input
                value={shalomAgencyQuery}
                onChange={(e) => setShalomAgencyQuery(e.target.value)}
                placeholder="Buscar agencia por ciudad, distrito o nombre"
                autoComplete="off"
                role="combobox"
                aria-expanded={shalomAgencies.length > 0}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              />
              {agencySearching && <p className="mt-1 text-xs text-slate-400">Buscando agencias…</p>}
              {agencyError && <p className="mt-1 text-xs font-medium text-red-600">{agencyError}</p>}
              {!agencySearching && !agencyError && shalomAgencyQuery.trim().length >= 2 && shalomAgencies.length === 0 && (
                <p className="mt-1 text-xs text-slate-500">No encontramos agencias con ese texto.</p>
              )}
              {shalomAgencies.length > 0 && (
                <ul
                  role="listbox"
                  className="absolute z-30 mt-1 max-h-52 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl shadow-slate-900/10"
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
                        className="block w-full rounded-lg px-3 py-2 text-left hover:bg-brand-50"
                      >
                        <span className="text-sm font-semibold text-slate-800">{agency.nombre}</span>{" "}
                        <span className="text-xs text-slate-400">#{agency.id}</span>
                        <span className="block text-xs text-slate-500">
                          {[agency.departamento, agency.provincia, agency.distrito].filter(Boolean).join(" · ")}
                        </span>
                        {agency.direccion && (
                          <span className="block truncate text-[11px] text-slate-400">{agency.direccion}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </details>
      )}

      {availableKinds.length > 0 ? (
        <>
          <section className="space-y-3">
            <div>
              <h4 className="text-sm font-semibold text-slate-900">2. Comprobante de Yape</h4>
              <p className="mt-0.5 text-xs text-slate-500">
                Pega o sube la imagen. Permanecerá grande y visible mientras cotejas la lectura.
              </p>
            </div>
            <VoucherPicker file={file} onPick={pickVoucher} />
            {file && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-sky-50 px-3 py-3">
                <div>
                  <p className="text-sm font-semibold text-sky-950">Leer datos del comprobante</p>
                  <p className="text-xs text-sky-700">
                    Obtiene monto, operación, fecha y cuenta receptora. Tú confirmas contra la imagen.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={readAndPrefill}
                  disabled={reading || busy || pending}
                  className="rounded-lg bg-sky-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-sky-800 focus:outline-none focus:ring-2 focus:ring-sky-300 disabled:cursor-wait disabled:opacity-50"
                >
                  {reading ? "Leyendo imagen…" : readNotice ? "Volver a leer" : "Leer y rellenar"}
                </button>
                {readNotice && (
                  <p className="basis-full rounded-lg bg-white/80 px-2.5 py-2 text-xs font-medium text-emerald-700">
                    ✓ {readNotice}
                  </p>
                )}
                {readWarning && (
                  <p className="basis-full rounded-lg bg-amber-50 px-2.5 py-2 text-xs font-medium text-amber-800">
                    ⚠ {readWarning}
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="space-y-3 border-t border-slate-200 pt-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold text-slate-900">3. Revisa y registra</h4>
                <p className="mt-0.5 text-xs text-slate-500">
                  {file
                    ? "Contrasta los datos rellenados con el comprobante visible arriba."
                    : "También puedes completar los datos manualmente si no tienes una imagen."}
                </p>
              </div>
              {progress.registeredRemaining !== null && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                  Saldo por cargar: S/ {progress.registeredRemaining.toFixed(2)}
                </span>
              )}
            </div>

            {availableKinds.length === 1 ? (
              <div className="flex items-center justify-between rounded-lg bg-indigo-50 px-3 py-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600">Tipo de este pago</p>
                  <p className="text-sm font-semibold text-indigo-950">Diferencia</p>
                </div>
                <span className="text-xs text-indigo-700">El adelanto ya fue registrado</span>
              </div>
            ) : (
              <div
                className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1"
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
                      "min-w-0 rounded-md px-2 py-2 text-xs font-semibold transition focus:outline-none focus:ring-2 focus:ring-brand-300",
                      kind === value
                        ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
                        : "text-slate-500 hover:text-slate-800",
                    )}
                  >
                    {value === "adelanto" ? "Adelanto" : "Pago total"}
                  </button>
                ))}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-xs font-medium text-slate-600">
                <span>Monto</span>
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
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                />
              </label>
              <label className="space-y-1 text-xs font-medium text-slate-600">
                <span>Nº de operación</span>
                <input
                  value={operation}
                  onChange={(e) => setOperation(e.target.value)}
                  placeholder="Número del Yape"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                />
              </label>
              <label className="space-y-1 text-xs font-medium text-slate-600">
                <span>Fecha y hora</span>
                <input
                  type="datetime-local"
                  value={paidAt}
                  onChange={(e) => setPaidAt(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                />
              </label>
            </div>
            <RecipientAccountCheck reading={recipientCheck} accounts={accounts} />
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
            <p className="max-w-md text-xs text-slate-500">
              La lectura rellena datos, pero no valida el ingreso. El pago quedará pendiente de revisión.
            </p>
            <button
              disabled={busy || reading || pending || (!file && !operation.trim())}
              onClick={submit}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-300 disabled:opacity-50"
            >
              {busy ? "Registrando…" : `Registrar ${kind === "total" ? "pago total" : kind}`}
            </button>
          </div>
          {!file && !operation.trim() && (
            <p className="text-xs text-slate-400">
              Elige la imagen del Yape, o escribe el nº de operación si lo registrarás manualmente.
            </p>
          )}
        </>
      ) : (
        <div className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
          <p className="font-semibold">✓ El monto cargado ya cubre el total del pedido.</p>
          <p className="mt-0.5 text-xs">No corresponde registrar otro comprobante mientras estos pagos sigan vigentes.</p>
        </div>
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
  onError,
}: {
  panel: PanelData;
  orderId: string;
  pending: boolean;
  embedded?: boolean;
  onSetKey: (key: string) => void;
  onShare: (channel: string, note: string) => void;
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
    <div className={cn("space-y-2", !embedded && "rounded-lg border border-slate-200 p-3")}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-900">
          Credencial de recojo Shalom
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          Pertenece a la salida Shalom. El pago completo controla cuándo puede mostrarse y entregarse.
        </p>
      </div>

      {!panel.hasKey ? (
        panel.canManageKey ? (
          <div className="flex gap-2">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="Clave emitida por Shalom"
              className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
            <button
              disabled={pending || !newKey.trim()}
              onClick={() => {
                onSetKey(newKey);
                setNewKey("");
              }}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Registrar clave
            </button>
          </div>
        ) : (
          <p className="text-sm text-slate-400">Todavía no se ha registrado la clave.</p>
        )
      ) : (
        <>
          {!panel.canReveal && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              🔒 Clave bloqueada. {panel.blockers}
            </p>
          )}
          {panel.canViewKey ? (
            <div className="space-y-2">
              {revealed ? (
                <p className="rounded-lg bg-slate-900 px-3 py-2 font-mono text-lg tracking-widest text-white">
                  {revealed}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    disabled={busy || !panel.canReveal}
                    onClick={() => reveal(false)}
                    className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                  >
                    Mostrar clave
                  </button>
                  {!panel.canReveal && panel.canOverride && (
                    <>
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Motivo de la excepción (obligatorio)"
                        className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                      />
                      <button
                        disabled={busy || !reason.trim()}
                        onClick={() => reveal(true)}
                        className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                      >
                        Mostrar como excepción
                      </button>
                    </>
                  )}
                </div>
              )}
              <p className="text-xs text-slate-400">
                Cada visualización queda registrada con tu usuario, la fecha y el estado de los
                pagos en ese momento.
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              Tu rol no permite ver la clave; solicítala a un administrador.
            </p>
          )}

          {panel.canViewKey && panel.canReveal && (
            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-2">
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
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
                className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              />
              <button
                disabled={pending}
                onClick={() => {
                  onShare(channel, shareNote);
                  setShareNote("");
                }}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Registrar entrega al cliente
              </button>
            </div>
          )}
        </>
      )}

      {panel.shares.length > 0 && (
        <ul className="space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-500">
          {panel.shares.map((s) => (
            <li key={s.id}>
              Enviada por {s.channel} el {fmtDateTime(s.shared_at)}
              {s.note ? ` — ${s.note}` : ""}
            </li>
          ))}
        </ul>
      )}

      {panel.views.length > 0 && (
        <details className="border-t border-slate-100 pt-2 text-xs text-slate-500">
          <summary className="cursor-pointer">
            Consultas de la clave ({panel.views.length})
          </summary>
          <ul className="mt-1 space-y-1">
            {panel.views.map((v) => (
              <li key={v.id}>
                {fmtDateTime(v.viewed_at)}
                {v.override ? " · EXCEPCIÓN" : ""}
                {v.reason ? ` — ${v.reason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
