"use client";

// Panel de pagos Yape y clave de recojo, dentro del detalle del pedido.
//
// La clave NUNCA aparece en el listado ni en exportaciones: solo aquí, tras una
// acción explícita, y cada visualización queda registrada. El botón de mostrar
// solo aparece cuando el servidor ya dijo que se puede — y aun así el servidor
// lo vuelve a comprobar antes de descifrar nada.

import { useEffect, useMemo, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import {
  createVoucherUpload,
  loadPaymentPanel,
  registerPayment,
  rejectPayment,
  revealPickupKey,
  setPickupKey,
  sharePickupKey,
  validatePayment,
  type PaymentRow,
  type PickupKeyPanel as PanelData,
} from "@/app/dashboard/pedidos/payment-actions";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { PAYMENT_STATE_LABEL, type PaymentState } from "@/lib/pickup-key";

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
        pending={pending}
        onValidate={(id) => run(() => validatePayment(id))}
        onReject={(id, reason) => run(() => rejectPayment(id, reason))}
      />

      {panel.canRegister && (
        <VoucherForm
          orderId={orderId}
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
  pending,
  onValidate,
  onReject,
}: {
  payments: PaymentRow[];
  canValidate: boolean;
  pending: boolean;
  onValidate: (id: string) => void;
  onReject: (id: string, reason: string) => void;
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
          {canValidate && p.validation_status !== "validado" && p.validation_status !== "rechazado" && (
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

function VoucherForm({
  orderId,
  existing,
  pending,
  onRegistered,
  onError,
  onNotice,
}: {
  orderId: string;
  existing: PaymentRow[];
  pending: boolean;
  onRegistered: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string | null) => void;
}) {
  const taken = new Set(
    existing.filter((p) => p.validation_status !== "rechazado").map((p) => p.kind),
  );
  const [kind, setKind] = useState<"adelanto" | "diferencia">(
    taken.has("adelanto") ? "diferencia" : "adelanto",
  );
  const [amount, setAmount] = useState("");
  const [operation, setOperation] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [payer, setPayer] = useState("");
  const [phone, setPhone] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    onError(null);
    onNotice(null);
    try {
      let path: string | null = null;
      let sha256: string | null = null;
      if (file) {
        sha256 = await fileSha256(file);
        const prep = await createVoucherUpload(orderId, file.type || "image/jpeg", file.name);
        if ("error" in prep) {
          onError(prep.error);
          return;
        }
        const supabase = createBrowserSupabase();
        const { error } = await supabase.storage
          .from(VOUCHER_BUCKET)
          .uploadToSignedUrl(prep.path, prep.token, file, {
            contentType: file.type || "image/jpeg",
          });
        if (error) {
          onError(`No se pudo subir el comprobante: ${error.message}`);
          return;
        }
        path = prep.path;
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
      onNotice(res.notice ?? null);
      setAmount("");
      setOperation("");
      setPaidAt("");
      setPayer("");
      setPhone("");
      setFile(null);
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
      <div className="flex flex-wrap gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "adelanto" | "diferencia")}
          className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        >
          <option value="adelanto">Adelanto</option>
          <option value="diferencia">Diferencia</option>
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
      <input
        type="file"
        accept="image/*"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block text-sm text-slate-600"
      />
      <p className="text-xs text-slate-400">
        Cargar la imagen no valida el pago: queda pendiente hasta que alguien lo revise.
      </p>
      <button
        disabled={busy || pending}
        onClick={submit}
        className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {busy ? "Registrando…" : "Registrar pago"}
      </button>
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
        panel.canViewKey ? (
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
