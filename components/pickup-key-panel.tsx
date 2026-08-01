"use client";

// Panel de pagos Yape y clave de recojo, dentro del detalle del pedido.
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
  lookupShalomPerson,
  saveShalomOrderDraft,
  searchShalomAgencies,
} from "@/app/dashboard/pedidos/shalom-actions";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { PAYMENT_STATE_LABEL, type PaymentState } from "@/lib/pickup-key";
import { documentError } from "@/lib/shalom/draft";
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

export function PickupKeyPanel({ orderId, onChanged }: { orderId: string; onChanged: () => void }) {
  const [panel, setPanel] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reload = useMemo(
    () => async () => {
      const res = await loadPaymentPanel(orderId);
      if ("error" in res) setError(res.error);
      else {
        setPanel(res.panel);
        setError(null);
      }
    },
    [orderId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

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
    return <p className="text-sm text-slate-400">Cargando pagos…</p>;
  }

  return (
    <section className="space-y-4 border-t border-slate-200 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Pagos Yape y clave de recojo
        </h3>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
          {PAYMENT_STATE_LABEL[panel.paymentState as PaymentState] ?? panel.paymentState}
        </span>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
      )}

      <PaymentList
        payments={panel.payments}
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
          existing={panel.payments}
          pending={pending}
          onRegistered={() => {
            void reload();
            onChanged();
          }}
          onError={setError}
          onNotice={setNotice}
        />
      )}

      <KeySection
        panel={panel}
        orderId={orderId}
        pending={pending}
        onSetKey={(key) => run(() => setPickupKey(orderId, key))}
        onShare={(channel, note) => run(() => sharePickupKey(orderId, { channel, note }))}
        onError={setError}
      />
    </section>
  );
}

function PaymentList({
  payments,
  canValidate,
  canRegister,
  pending,
  onValidate,
  onReject,
  onComplete,
}: {
  payments: PaymentRow[];
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
            {p.payer_name ? ` · ${p.payer_name}` : ""}
          </p>
          {p.notes && <p className="text-xs text-slate-500">{p.notes}</p>}
          {/* El comprobante se guardaba y no se podía ver: quien validaba tenía
              que fiarse de los campos transcritos, que es justo lo que la imagen
              sirve para contrastar. La miniatura abre el original en pestaña. */}
          {p.file_path && (
            <a
              href={`/api/payments/${p.id}/voucher`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block"
              title="Ver el comprobante en grande"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/payments/${p.id}/voucher`}
                alt="Comprobante de Yape"
                className="max-h-32 rounded-lg border border-slate-200 object-contain"
              />
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
                disabled={pending}
                onClick={() => onValidate(p.id)}
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
        <div className="flex flex-wrap items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt="Comprobante por subir"
            className="max-h-32 rounded-lg border border-slate-200 object-contain"
          />
          <div className="space-y-1 text-xs text-slate-600">
            <p className="font-medium text-slate-800">{file?.name}</p>
            <p>{file ? `${Math.round(file.size / 1024)} KB · ${file.type || "imagen"}` : ""}</p>
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

function VoucherForm({
  orderId,
  storeId,
  existing,
  pending,
  onRegistered,
  onError,
  onNotice,
}: {
  orderId: string;
  storeId: string;
  existing: PaymentRow[];
  pending: boolean;
  onRegistered: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string | null) => void;
}) {
  const taken = new Set(
    existing.filter((p) => p.validation_status !== "rechazado").map((p) => p.kind),
  );
  const [kind, setKind] = useState<"adelanto" | "diferencia" | "total">(
    taken.has("adelanto") ? "diferencia" : "adelanto",
  );
  const [amount, setAmount] = useState("");
  const [operation, setOperation] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [payer, setPayer] = useState("");
  const [phone, setPhone] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [readNotice, setReadNotice] = useState<string | null>(null);
  const [readWarning, setReadWarning] = useState<string | null>(null);
  const [recipientCheck, setRecipientCheck] = useState<{
    status: "verified" | "partial" | "mismatch" | "missing";
    name: string | null;
    phoneLastDigits: string | null;
  } | null>(null);
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

  function changeDocument(value: string) {
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
    setPhone("");
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
      setPhone("");
      setRecipientCheck({
        status: result.fields.recipientCheck,
        name: result.fields.recipientName,
        phoneLastDigits: result.fields.recipientPhoneLastDigits,
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
        payerPhone: phone.trim() || null,
        path,
        sha256,
      });
      if (res.error) {
        onError(res.error);
        return;
      }
      // Se guarda DESPUÉS del pago y sin condicionarlo: si esto fallara, el
      // cobro ya quedó registrado, que es lo que no puede perderse.
      if (shalomDoc.trim() || shalomAgency) {
        const pre = await saveShalomOrderDraft(orderId, {
          documentType: shalomDocType,
          document: shalomDoc.trim() || null,
          destinyTerminalId: shalomAgency?.id ?? null,
          destinyTerminalName: shalomAgency?.nombre ?? null,
        });
        if ("error" in pre) onError(`El pago se registró, pero los datos de Shalom no: ${pre.error}`);
      }

      onNotice(res.notice ?? null);
      setAmount("");
      setOperation("");
      setPaidAt("");
      setPayer("");
      setPhone("");
      setFile(null);
      setUploadedVoucher(null);
      setReadNotice(null);
      setReadWarning(null);
      setShalomDoc("");
      setDocumentNotice(null);
      setShalomAgencyQuery("");
      setShalomAgency(null);
      setShalomAgencies([]);
      onRegistered();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Cargar comprobante
      </p>
      <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        {[
          ["1", "Imagen", Boolean(file)],
          ["2", "Leer datos", Boolean(readNotice)],
          ["3", "Registrar", false],
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
      <div className="flex flex-wrap gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "adelanto" | "diferencia" | "total")}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        >
          <option value="adelanto">Adelanto</option>
          <option value="diferencia">Diferencia</option>
          <option value="total">Pago total</option>
        </select>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="Monto"
          className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <input
          value={operation}
          onChange={(e) => setOperation(e.target.value)}
          placeholder="Nº de operación"
          className="w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <input
          type="datetime-local"
          value={paidAt}
          onChange={(e) => setPaidAt(e.target.value)}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          value={payer}
          onChange={(e) => setPayer(e.target.value)}
          placeholder="Titular / pagador"
          className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Teléfono"
          className="w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
      </div>
      <VoucherPicker file={file} onPick={pickVoucher} />
      {file && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-sky-950">Rellenar desde la imagen</p>
              <p className="text-xs text-sky-700">
                Lee monto, operación, fecha, hora y titular; luego podrás corregirlos.
              </p>
            </div>
            <button
              type="button"
              onClick={readAndPrefill}
              disabled={reading || busy || pending}
              className="rounded-lg bg-sky-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-sky-800 disabled:cursor-wait disabled:opacity-50"
            >
              {reading ? "Leyendo imagen…" : readNotice ? "Volver a leer" : "Leer y rellenar"}
            </button>
          </div>
          {readNotice && (
            <p className="mt-2 rounded-lg bg-white/80 px-2.5 py-2 text-xs font-medium text-emerald-700">
              ✓ {readNotice}
            </p>
          )}
          {readWarning && (
            <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-xs font-medium text-amber-800">
              ⚠ {readWarning}
            </p>
          )}
          {recipientCheck && (
            <p
              className={cn(
                "mt-2 rounded-lg px-2.5 py-2 text-xs font-semibold",
                recipientCheck.status === "verified"
                  ? "bg-emerald-100 text-emerald-800"
                  : recipientCheck.status === "mismatch"
                    ? "bg-red-100 text-red-800"
                    : "bg-amber-100 text-amber-800",
              )}
            >
              {recipientCheck.status === "verified"
                ? "✓ Receptor verificado: Grupo GF S.A.C. · ***309"
                : recipientCheck.status === "mismatch"
                  ? `⚠ Receptor distinto al esperado: ${recipientCheck.name ?? "sin nombre"} · ${
                      recipientCheck.phoneLastDigits
                        ? `***${recipientCheck.phoneLastDigits}`
                        : "sin teléfono"
                    }. Debe revisarse.`
                  : `⚠ Receptor parcialmente verificado: ${
                      recipientCheck.name ?? "Grupo GF no legible"
                    } · ${
                      recipientCheck.phoneLastDigits
                        ? `***${recipientCheck.phoneLastDigits}`
                        : "teléfono no legible"
                    }.`
              }
            </p>
          )}
        </div>
      )}

      {/* Datos de Shalom, adelantados y OPCIONALES (0073).
          Van aquí porque quien registra el Yape acaba de hablar con la clienta y
          tiene el DNI a mano; quien crea la guía suele ser otra persona en otro
          momento, y hoy tiene que volver a pedirlo. Nada de esto condiciona el
          pago: un cobro no puede quedarse esperando a un DNI. */}
      <details className="rounded-lg border border-slate-200 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-slate-600">
          Adelantar datos para la guía Shalom (opcional)
        </summary>
        <p className="mt-2 text-xs text-slate-400">
          Si ya tienes el documento del cliente o sabes a qué agencia va, apúntalo acá y quien cree
          la guía se lo encontrará puesto: solo tendrá que cotizar y crear.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            value={shalomDocType}
            onChange={(e) => {
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
                  #{shalomAgency.id} · {[shalomAgency.departamento, shalomAgency.provincia, shalomAgency.distrito]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShalomAgency(null);
                  setShalomAgencyQuery("");
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
                          setShalomAgency(agency);
                          setShalomAgencyQuery(agency.nombre);
                          setShalomAgencies([]);
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
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
        <p className="max-w-md text-xs text-slate-500">
          Revisa los datos antes de registrar. La imagen no valida el pago: quedará pendiente de revisión.
        </p>
        <button
          // Sin imagen y sin nº de operación no hay nada que registrar: dejar el
          // botón activo solo consigue que parezca que no hace nada.
          disabled={busy || reading || pending || (!file && !operation.trim())}
          onClick={submit}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? "Registrando…" : "Registrar pago"}
        </button>
      </div>
      {!file && !operation.trim() && (
        <p className="text-xs text-slate-400">
          Elige la imagen del Yape, o escribe el nº de operación si lo vas a cargar a mano.
        </p>
      )}
    </div>
  );
}

function KeySection({
  panel,
  orderId,
  pending,
  onSetKey,
  onShare,
  onError,
}: {
  panel: PanelData;
  orderId: string;
  pending: boolean;
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
    <div className="space-y-2 rounded-lg border border-slate-200 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Clave de recojo</p>

      {!panel.hasKey ? (
        panel.canManageKey ? (
          <div className="flex gap-2">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="Clave que entrega la agencia"
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
