"use client";

import Link from "next/link";
import { useDeferredValue, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  observePayment,
  rejectPayment,
  validatePayment,
  type PaymentActionState,
} from "@/app/dashboard/pedidos/payment-actions";
import { cn } from "@/components/ui";
import {
  paymentKindLabel,
  paymentObservationLabel,
  type PaymentReviewLane,
} from "@/lib/payment-review";
import type { PaymentReviewBoardData, PaymentReviewItem } from "@/lib/payment-review-access";
import { yapeRecipientReadingFromVision } from "@/lib/yape-recipient";

const LANES: {
  key: PaymentReviewLane;
  title: string;
  description: string;
  tone: string;
  countTone: string;
}[] = [
  {
    key: "pending",
    title: "Pendientes",
    description: "Esperan una decisión financiera.",
    tone: "bg-amber-50/70",
    countTone: "bg-amber-100 text-amber-900",
  },
  {
    key: "observed",
    title: "Observados",
    description: "Necesitan corrección o una revisión adicional.",
    tone: "bg-rose-50/55",
    countTone: "bg-rose-100 text-rose-900",
  },
  {
    key: "validated",
    title: "Validados hoy",
    description: "Control de las decisiones tomadas en el día.",
    tone: "bg-emerald-50/55",
    countTone: "bg-emerald-100 text-emerald-900",
  },
];

function money(value: number | null): string {
  return value === null ? "Sin monto" : `S/ ${value.toFixed(2)}`;
}

function dateTime(value: string | null): string {
  if (!value) return "Fecha no indicada";
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function normalizedSearch(item: PaymentReviewItem): string {
  return [
    item.orderName,
    item.customerName,
    item.customerPhone,
    item.operationNumber,
    item.storeName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("es");
}

function RecipientSignal({ item }: { item: PaymentReviewItem }) {
  const reading = yapeRecipientReadingFromVision(item.vision);
  const config =
    reading.status === "verified"
      ? { label: "Cuenta GF verificada", tone: "bg-emerald-50 text-emerald-700" }
      : reading.status === "mismatch"
        ? { label: "Cuenta receptora no coincide", tone: "bg-red-50 text-red-700" }
        : reading.status === "partial"
          ? { label: "Receptor leído parcialmente", tone: "bg-amber-50 text-amber-800" }
          : { label: "Receptor por cotejar", tone: "bg-slate-100 text-slate-600" };
  return (
    <span className={cn("inline-flex rounded-full px-2 py-1 text-[11px] font-semibold", config.tone)}>
      {config.label}
    </span>
  );
}

function ReviewCard({ item, lane }: { item: PaymentReviewItem; lane: PaymentReviewLane }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"observe" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<PaymentActionState | null>(null);
  const recipient = yapeRecipientReadingFromVision(item.vision);
  const canApprove = Boolean(item.operationNumber) && recipient.status !== "mismatch";
  const remaining =
    item.orderTotal === null ? null : Math.max(0, item.orderTotal - item.validatedTotal);

  function run(action: () => Promise<PaymentActionState>) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      setMessage(result);
      if (!result.error) {
        setMode(null);
        setReason("");
        router.refresh();
      }
    });
  }

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm shadow-slate-900/[0.03]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/dashboard/pedidos?q=${encodeURIComponent(item.orderName)}`}
            className="text-sm font-semibold text-slate-950 hover:text-brand-700 hover:underline"
          >
            {item.orderName}
          </Link>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {item.customerName || "Cliente sin nombre"}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600">
          {item.storeName}
        </span>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3 border-y border-slate-100 py-2.5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
            {paymentKindLabel(item.kind)}
          </p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-950">
            {money(item.amount)}
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <p>Pedido: <strong className="font-semibold text-slate-700">{money(item.orderTotal)}</strong></p>
          <p>
            Validado: <strong className="font-semibold text-emerald-700">{money(item.validatedTotal)}</strong>
          </p>
          {remaining !== null && remaining > 0 && <p>Falta: {money(remaining)}</p>}
        </div>
      </div>

      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div>
          <dt className="text-slate-400">Operación</dt>
          <dd className={cn("mt-0.5 font-medium", item.operationNumber ? "text-slate-700" : "text-red-700")}>
            {item.operationNumber || "Falta completar"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Pago realizado</dt>
          <dd className="mt-0.5 font-medium text-slate-700">{dateTime(item.paidAt)}</dd>
        </div>
      </dl>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <RecipientSignal item={item} />
        {lane === "observed" && (
          <span className="inline-flex rounded-full bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700">
            {paymentObservationLabel(item.validationStatus)}
          </span>
        )}
      </div>

      {item.notes && (
        <p className="mt-2.5 whitespace-pre-line rounded-lg bg-rose-50 px-2.5 py-2 text-xs leading-relaxed text-rose-800">
          {item.notes}
        </p>
      )}

      {item.hasVoucher ? (
        <a
          href={`/api/payments/${item.id}/voucher`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 block overflow-hidden rounded-lg border border-slate-200 bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          title="Abrir comprobante a tamaño completo"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/payments/${item.id}/voucher`}
            alt={`Comprobante del pedido ${item.orderName}`}
            loading="lazy"
            decoding="async"
            className="h-52 w-full object-contain"
          />
          <span className="block border-t border-slate-200 bg-white px-3 py-2 text-center text-xs font-semibold text-brand-700">
            Abrir comprobante completo
          </span>
        </a>
      ) : (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          Registro manual sin imagen. Coteja la operación antes de decidir.
        </p>
      )}

      {lane !== "validated" && (
        <div className="mt-3 space-y-2">
          {!canApprove && (
            <p className="text-xs font-medium text-red-700">
              {!item.operationNumber
                ? "Completa el número de operación desde el pedido antes de validar."
                : "La cuenta receptora no coincide; no se puede validar."}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending || !canApprove}
              onClick={() => run(() => validatePayment(item.id))}
              className="flex-1 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
            >
              {pending ? "Guardando…" : "Validar pago"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setMode(lane === "pending" ? "observe" : "reject")}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-50"
            >
              {lane === "pending" ? "Observar" : "Rechazar"}
            </button>
          </div>
          {mode && (
            <div className="rounded-lg bg-slate-50 p-2.5">
              <label className="text-xs font-semibold text-slate-700" htmlFor={`reason-${item.id}`}>
                {mode === "observe" ? "¿Qué debe revisarse?" : "Motivo del rechazo"}
              </label>
              <textarea
                id={`reason-${item.id}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                autoFocus
                placeholder="Escribe una explicación corta"
                className="mt-1.5 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setMode(null);
                    setReason("");
                  }}
                  className="px-2 py-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={pending || !reason.trim()}
                  onClick={() =>
                    run(() =>
                      mode === "observe"
                        ? observePayment(item.id, reason)
                        : rejectPayment(item.id, reason),
                    )
                  }
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50",
                    mode === "observe" ? "bg-amber-700 hover:bg-amber-800" : "bg-red-700 hover:bg-red-800",
                  )}
                >
                  {mode === "observe" ? "Enviar a Observados" : "Confirmar rechazo"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {lane === "validated" && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
          Validado el {dateTime(item.validatedAt)}
        </p>
      )}

      {message?.error && <p className="mt-2 text-xs font-medium text-red-700">{message.error}</p>}
      {message?.notice && <p className="mt-2 text-xs font-medium text-emerald-700">{message.notice}</p>}
    </article>
  );
}

export function PaymentReviewBoard({ data }: { data: PaymentReviewBoardData }) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase("es"));
  const filtered = useMemo(() => {
    if (!deferredSearch) return data.lanes;
    return {
      pending: data.lanes.pending.filter((item) => normalizedSearch(item).includes(deferredSearch)),
      observed: data.lanes.observed.filter((item) => normalizedSearch(item).includes(deferredSearch)),
      validated: data.lanes.validated.filter((item) => normalizedSearch(item).includes(deferredSearch)),
    };
  }, [data.lanes, deferredSearch]);

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-brand-700">Finanzas</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">Validación de pagos</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Coteja la constancia con la operación y la cuenta receptora. La decisión queda registrada con tu usuario.
          </p>
        </div>
        <label className="relative block w-full lg:w-80">
          <span className="sr-only">Buscar comprobante</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Pedido, cliente, teléfono u operación"
            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          />
        </label>
      </header>

      <div className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3.5 py-3 text-sm text-sky-900">
        <span aria-hidden="true" className="mt-0.5 font-bold">i</span>
        <p>
          Durante la convivencia con Excel, validar un comprobante actualiza el estado financiero y el historial. No cambia automáticamente la macroetapa ni marca Shopify como pagado.
        </p>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-3">
        {LANES.map((lane) => {
          const items = filtered[lane.key];
          return (
            <section key={lane.key} className={cn("min-w-0 rounded-2xl p-3", lane.tone)}>
              <div className="flex items-start justify-between gap-3 px-1 pb-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-950">{lane.title}</h2>
                  <p className="mt-0.5 text-xs text-slate-600">{lane.description}</p>
                </div>
                <span className={cn("rounded-full px-2.5 py-1 text-xs font-bold tabular-nums", lane.countTone)}>
                  {deferredSearch ? items.length : data.counts[lane.key]}
                </span>
              </div>

              <div className="space-y-3">
                {items.map((item) => <ReviewCard key={item.id} item={item} lane={lane.key} />)}
                {!items.length && (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-white/70 px-4 py-10 text-center">
                    <p className="text-sm font-semibold text-slate-700">
                      {deferredSearch ? "No coincide con la búsqueda" : "Cola al día"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {deferredSearch ? "Prueba con otro dato del pedido." : "No hay comprobantes en este estado."}
                    </p>
                  </div>
                )}
                {!deferredSearch && data.truncated[lane.key] && (
                  <p className="px-2 py-1 text-center text-xs text-slate-500">
                    Se muestran los {items.length} más recientes de esta cola.
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
