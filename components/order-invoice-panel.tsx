"use client";

// Panel «Comprobante» en el drawer del pedido (MOM §35.4, §35.7, §35.9).
//
// Dice si el pedido tiene boleta y cuál, o por qué no la lleva, con las mismas
// frases que guarda el barrido (`INVOICE_REASON_LABEL`). No tiene «Emitir»:
// emitir lo hace solo el barrido, y un pedido que no cumple las reglas no se
// fuerza desde aquí (§35.7). Quien tiene «Boletas y facturas» puede, además,
// registrar una boleta emitida a mano, pedir que se vuelva a intentar un error y
// liberar una en duda después de buscarla en SimpleFact.
//
// Es una zona más de la tarjeta «Cobro», sobre su hairline, como el agente de
// voz en la de confirmación. Las acciones pasan por el `run` del drawer: sus
// avisos van en la cabecera fija, que es donde se leen.
//
// No importa lib/invoicing/server ni lib/crypto: arrastran node:crypto al
// navegador (test/invoicing-drawer.test.ts lo vigila). Las reglas puras sí.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, CARD_ZONE, FIELD, OpsButton, type BadgeTone } from "@/components/ops-ui";
import { IconArrowUpRight } from "@/components/icons";
import {
  loadInvoicePanel,
  registerExternalInvoice,
  releaseDoubtfulInvoice,
  requestInvoiceRetry,
  type InvoiceActionState,
  type InvoicePanelData,
  type InvoicePanelRow,
} from "@/app/dashboard/pedidos/invoice-actions";
import {
  INVOICE_MODE_LABEL,
  INVOICE_REASON_LABEL,
  INVOICE_STATUS_LABEL,
  LIVE_REAL_STATUSES,
  invoiceNoteRef,
  type InvoiceReason,
} from "@/lib/invoicing/rules";
import { subscribePaymentPanelChange } from "@/lib/payment-panel-sync";

type Run = (action: () => Promise<InvoiceActionState>) => Promise<boolean>;

const hora = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function cuando(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? hora.format(new Date(t)) : "";
}

function soles(value: number): string {
  return `S/ ${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
}

/** «B001-97». Sin correlativo, la serie sola; sin serie, nada. */
function serieDe(row: InvoicePanelRow): string | null {
  if (!row.serie) return null;
  return row.correlative ? `${row.serie}-${row.correlative}` : row.serie;
}

/** El motivo con la frase del barrido; uno que no se conoce se enseña tal cual. */
function motivo(reason: string, detail: string | null): string {
  const label = INVOICE_REASON_LABEL[reason as InvoiceReason] ?? reason;
  return detail ? `${label} ${detail}` : label;
}

/**
 * El PDF viene en la respuesta de SimpleFact. Solo se enlaza si es https: un
 * enlace que no lo es no lo puso SimpleFact.
 */
function pdfHref(url: string | null): string | null {
  return url && /^https:\/\//i.test(url.trim()) ? url.trim() : null;
}

// ── Qué se enseña ────────────────────────────────────────────────────────────

export interface InvoicePanelView {
  badge: { tone: BadgeTone; label: string };
  /** El comprobante real vivo: emitiendo, emitida, en duda o externa. Uno a lo más (0257). */
  live: InvoicePanelRow | null;
  simulated: InvoicePanelRow | null;
  /** El último intento real terminó en error y no hay comprobante vivo. */
  failed: InvoicePanelRow | null;
  /** Los otros errores: se quedan como historia (§35.6). */
  history: InvoicePanelRow[];
  /** Sin comprobante vivo, lo que dicen hoy las reglas. */
  showReview: boolean;
  /** La última pasada del barrido, si dice otra cosa que la revisión de ahora. */
  check: InvoicePanelData["check"];
  canRetry: boolean;
  canRelease: boolean;
  canRegisterExternal: boolean;
}

const LIVE = new Set<string>(LIVE_REAL_STATUSES);

export function invoicePanelView(data: InvoicePanelData): InvoicePanelView {
  const live = data.invoices.find((i) => i.mode === "real" && LIVE.has(i.status)) ?? null;
  const simulated = data.invoices.find((i) => i.status === "simulada") ?? null;
  const lastReal = data.invoices.find((i) => i.mode === "real") ?? null;
  const failed = !live && lastReal?.status === "error" ? lastReal : null;
  const history = data.invoices.filter((i) => i.mode === "real" && i.status === "error" && i.id !== failed?.id);
  const reviewReason = data.review.state === "no" ? data.review.reason : null;

  let badge: InvoicePanelView["badge"];
  if (live) {
    badge = {
      tone: live.status === "en_duda" ? "warn" : live.status === "emitiendo" ? "info" : "ok",
      label: INVOICE_STATUS_LABEL[live.status],
    };
  } else if (failed && !failed.retryRequestedAt) {
    badge = { tone: "crit", label: INVOICE_STATUS_LABEL.error };
  } else if (data.review.state === "lista") {
    badge = { tone: "info", label: data.review.mode === "real" ? "Por emitir" : "Por simular" };
  } else if (simulated) {
    badge = { tone: "neutral", label: INVOICE_STATUS_LABEL.simulada };
  } else if (data.review.state === "sin_revisar") {
    badge = { tone: "neutral", label: "Sin revisar" };
  } else {
    badge = { tone: "neutral", label: "Sin comprobante" };
  }

  return {
    badge,
    live,
    simulated,
    failed,
    history,
    showReview: !live,
    check: !live && data.check && data.check.reason !== reviewReason ? data.check : null,
    canRetry: data.canManage && !!failed && !failed.retryRequestedAt,
    canRelease: data.canManage && live?.status === "en_duda",
    canRegisterExternal: data.canManage && !live && data.issuers.length > 0,
  };
}

// ── El panel ─────────────────────────────────────────────────────────────────

/**
 * Carga lo suyo con `loadInvoicePanel` (como el cobro y el agente de voz) y se
 * relee cuando el drawer termina una acción —anular el pedido cambia el aviso
 * de nota de crédito— o cuando el panel de cobro cambia los pagos.
 */
export function OrderInvoicePanel({
  orderId,
  pending,
  run,
}: {
  orderId: string;
  pending: boolean;
  run: Run;
}) {
  const [data, setData] = useState<InvoicePanelData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // El panel se relee al empezar y al terminar cada acción del drawer: si la
  // lectura vieja contesta después de la nueva, no pisa lo que ya se enseña.
  const turno = useRef(0);
  const cargar = useCallback(async () => {
    const mio = ++turno.current;
    try {
      const res = await loadInvoicePanel(orderId);
      if (mio !== turno.current) return;
      if ("error" in res) {
        setLoadError(res.error);
        setData(null);
      } else {
        setLoadError(null);
        setData(res.data);
      }
    } catch {
      if (mio !== turno.current) return;
      // Una server action que no llega deja la promesa rechazada: sin esto el
      // panel desaparecía sin decir nada, que se lee como «no lleva boleta».
      setLoadError("No se pudo cargar el comprobante. Revisa la conexión y vuelve a intentarlo.");
      setData(null);
    }
  }, [orderId]);

  useEffect(() => {
    void cargar();
  }, [cargar, pending]);

  // Validar o rechazar un pago en «Cobro» cambia si lleva comprobante y de qué RUC.
  const source = useId();
  useEffect(() => subscribePaymentPanelChange(orderId, source, () => void cargar()), [orderId, source, cargar]);

  if (loadError) {
    return (
      <section aria-labelledby={`comprobante-${orderId}`} className={cn(CARD_ZONE, "mt-4 space-y-3 sm:mt-5")}>
        <h4 id={`comprobante-${orderId}`} className="text-sm font-semibold text-ink-900">
          Comprobante
        </h4>
        <Banner tone="crit" role="alert">
          {loadError}
        </Banner>
        <OpsButton size="sm" onClick={() => void cargar()} className="pointer-coarse:h-11">
          Intentar nuevamente
        </OpsButton>
      </section>
    );
  }
  // Mientras carga, nada: una organización sin RUC no dibuja el panel, y un
  // esqueleto que aparece y se va es peor que esperar.
  if (!data?.active) return null;
  return <OrderInvoicePanelView orderId={orderId} data={data} pending={pending} run={run} />;
}

/** El panel con sus datos ya leídos. Separado para poder pintarlo en las pruebas. */
export function OrderInvoicePanelView({
  orderId,
  data,
  pending,
  run,
}: {
  orderId: string;
  data: InvoicePanelData;
  pending: boolean;
  run: Run;
}) {
  const view = invoicePanelView(data);
  const [releasing, setReleasing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const { live, simulated, failed } = view;
  const review = data.review;

  return (
    <section aria-labelledby={`comprobante-${orderId}`} className={cn(CARD_ZONE, "mt-4 space-y-3 sm:mt-5")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`comprobante-${orderId}`} className="text-sm font-semibold text-ink-900">
          Comprobante
        </h4>
        <Badge tone={view.badge.tone}>{view.badge.label}</Badge>
      </div>

      {data.creditNote && <Banner tone="warn">{data.creditNote}</Banner>}

      {live && <LiveInvoice row={live} />}

      {live?.status === "en_duda" &&
        (view.canRelease ? (
          releasing ? (
            <ReleaseDoubtForm
              pending={pending}
              onCancel={() => setReleasing(false)}
              onSubmit={async (note) => {
                const ok = await run(() => releaseDoubtfulInvoice(live.id, note));
                if (ok) setReleasing(false);
                return ok;
              }}
            />
          ) : (
            <OpsButton size="sm" disabled={pending} onClick={() => setReleasing(true)} className="pointer-coarse:h-11">
              No está en SimpleFact: volver a intentar
            </OpsButton>
          )
        ) : (
          <p className="text-[13px] leading-5 text-ink-500">
            Si no aparece, la revisa quien tiene «Boletas y facturas».
          </p>
        ))}

      {live && review.state === "sin_revisar" && (
        <p className="text-[13px] leading-5 text-ink-500">
          No se pudo revisar si corresponde una nota de crédito: {review.error}
        </p>
      )}

      {failed && (
        <div className="space-y-2">
          <p className="text-[13px] leading-5">
            <span className="font-medium text-crit-fg">{INVOICE_STATUS_LABEL.error}</span>
            <span className="text-ink-700">
              {" "}
              · {soles(failed.total)} · RUC {failed.ruc} · {cuando(failed.createdAt)}
            </span>
          </p>
          {failed.error && <p className="text-[13px] leading-5 text-ink-700">{failed.error}</p>}
          {failed.note && <p className="text-[13px] leading-5 text-ink-500">Nota: {failed.note}</p>}
          {failed.retryRequestedAt ? (
            <p className="text-[13px] leading-5 text-ink-500">
              Se pidió volver a intentar el {cuando(failed.retryRequestedAt)}.
            </p>
          ) : view.canRetry ? (
            <OpsButton
              size="sm"
              disabled={pending}
              onClick={() => void run(() => requestInvoiceRetry(failed.id))}
              className="pointer-coarse:h-11"
            >
              Volver a intentar
            </OpsButton>
          ) : (
            <p className="text-[13px] leading-5 text-ink-500">
              No se reintenta solo: lo pide quien tiene «Boletas y facturas».
            </p>
          )}
        </div>
      )}

      {view.showReview && <Review data={data} hideSimulated={!!simulated} />}

      {view.check && (
        <p className="text-[13px] leading-5 text-ink-500">
          Última pasada ({INVOICE_MODE_LABEL[view.check.mode as "simulacion" | "real"] ?? view.check.mode},{" "}
          {cuando(view.check.checkedAt)}): {motivo(view.check.reason, view.check.detail)}
        </p>
      )}

      {simulated && <SimulatedInvoice row={simulated} />}

      {view.history.length > 0 && (
        <div className="space-y-1">
          <p className="text-[13px] font-medium text-ink-700">Intentos anteriores</p>
          <ul className="divide-y divide-line border-t border-line text-[13px] leading-5">
            {view.history.map((h) => (
              <li key={h.id} className="py-1.5 text-ink-600">
                <span className="tabular-nums text-ink-500">{cuando(h.createdAt)}</span> ·{" "}
                {INVOICE_STATUS_LABEL[h.status]}
                {h.error ? `: ${h.error}` : ""}
                {h.retryRequestedAt ? " (se pidió volver a intentar)" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.canRegisterExternal &&
        (registering ? (
          <ExternalInvoiceForm
            issuers={data.issuers}
            pending={pending}
            onCancel={() => setRegistering(false)}
            onSubmit={async (input) => {
              const ok = await run(() =>
                registerExternalInvoice(orderId, input.issuerId, input.serieNumber, input.note),
              );
              if (ok) setRegistering(false);
              return ok;
            }}
          />
        ) : (
          <OpsButton
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setRegistering(true)}
            className="pointer-coarse:h-11"
          >
            Ya tiene comprobante
          </OpsButton>
        ))}
    </section>
  );
}

// ── Las piezas ───────────────────────────────────────────────────────────────

/** El comprobante real vivo: lo que es, por cuánto, de qué RUC y su PDF. */
function LiveInvoice({ row }: { row: InvoicePanelRow }) {
  const serie = serieDe(row);
  const pdf = pdfHref(row.pdfUrl);
  return (
    <div className="space-y-1 text-[13px] leading-5">
      <p className="text-ink-900">
        <span className="font-medium">
          {INVOICE_STATUS_LABEL[row.status]}
          {serie ? ` ${serie}` : ""}
        </span>
        <span className="tabular-nums">
          {" "}
          · {soles(row.total)} · RUC {row.ruc}
        </span>
      </p>
      <p className="text-ink-500">
        {[row.legalName, row.status === "externa" ? "Registrada a mano" : null, cuando(row.createdAt)]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {row.status === "emitiendo" && (
        <p className="text-ink-600">
          Kapta reservó el turno y espera a SimpleFact. Si no contesta, la busca en SimpleFact por su nota: nunca se
          manda dos veces.
        </p>
      )}
      {row.status === "en_duda" && (
        <p className="text-ink-600">
          SimpleFact no contestó con claridad: la boleta puede existir. El barrido la busca en las ventas de hoy y de
          ayer por la nota «{invoiceNoteRef(row.id)}» y nunca la reenvía sola.
        </p>
      )}
      {row.error && row.status !== "emitida" && <p className="text-ink-500">{row.error}</p>}
      {row.note && <p className="text-ink-500">Nota: {row.note}</p>}
      {pdf && (
        <a
          href={pdf}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-brand-700 underline-offset-2 hover:underline pointer-coarse:min-h-11"
        >
          Ver PDF
          <IconArrowUpRight aria-hidden className="size-3.5" />
        </a>
      )}
    </div>
  );
}

/** Lo que dicen hoy las reglas (§35.3), o que no se pudo revisar. Nunca las dos. */
function Review({ data, hideSimulated }: { data: InvoicePanelData; hideSimulated: boolean }) {
  const review = data.review;
  if (review.state === "sin_revisar") {
    // FALLA CERRADA: sin los hechos no se dice «lista» ni ningún motivo.
    return (
      <p className="text-[13px] leading-5 text-ink-600">No se pudo revisar si lleva comprobante: {review.error}</p>
    );
  }
  if (review.state === "lista") {
    return (
      <div className="space-y-0.5 text-[13px] leading-5">
        <p className="text-ink-900">
          Lista para emitirse en la próxima pasada (RUC {review.ruc}, modo {INVOICE_MODE_LABEL[review.mode]}).
        </p>
        <p className="text-ink-500">
          {review.mode === "real"
            ? "Antes de emitir, el barrido vuelve a leer el pedido en Shopify."
            : "En simulación se arma la boleta y se guarda sin enviarla a SimpleFact."}
        </p>
      </div>
    );
  }
  // La simulación ya se ve abajo: repetir «Ya tiene su simulación» no dice nada.
  if (review.reason === "ya_simulado" && hideSimulated) return null;
  return <p className="text-[13px] leading-5 text-ink-600">{motivo(review.reason, review.detail)}</p>;
}

/** «Simulada: lo que habría enviado» — la boleta exacta, que no salió de Kapta. */
function SimulatedInvoice({ row }: { row: InvoicePanelRow }) {
  const items = row.items ?? [];
  return (
    <div className="space-y-2 rounded-lg bg-wash p-3 text-[13px] leading-5">
      <p className="text-ink-900">
        <span className="font-medium">{INVOICE_STATUS_LABEL.simulada}:</span> lo que habría enviado
        <span className="tabular-nums">
          {" "}
          · {soles(row.total)} · RUC {row.ruc}
        </span>
      </p>
      <p className="text-ink-500">{cuando(row.createdAt)} · No se envió a SimpleFact.</p>
      {items.length ? (
        <table className="w-full text-left">
          <thead className="text-ink-500">
            <tr>
              <th className="py-1 pr-2 font-normal">Código</th>
              <th className="py-1 pr-2 font-normal">Producto</th>
              <th className="py-1 pr-2 text-right font-normal">Cant.</th>
              <th className="py-1 text-right font-normal">Precio</th>
            </tr>
          </thead>
          <tbody className="text-ink-700">
            {items.map((item, i) => (
              <tr key={`${item.code}-${i}`} className="border-t border-line align-top">
                <td className="py-1 pr-2 break-all">{item.code}</td>
                <td className="py-1 pr-2">{item.name}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{item.qty}</td>
                <td className="py-1 text-right tabular-nums">{soles(item.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-ink-500">Sin ítems guardados.</p>
      )}
    </div>
  );
}

/**
 * Liberar un `en_duda` (§35.4): solo después de buscarlo en SimpleFact, y
 * dejando escrito qué se revisó. El servidor vuelve a exigir la nota.
 */
export function ReleaseDoubtForm({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  onSubmit: (note: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div className="space-y-3 rounded-lg bg-wash p-3">
      <p className="text-[13px] leading-5 text-ink-700">
        Libérala solo si confirmaste en SimpleFact que la boleta no existe: pasa a error y se vuelve a intentar en la
        próxima pasada. Si existiera, saldría otra.
      </p>
      <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
        Qué revisaste en SimpleFact
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Busqué la nota en las ventas de hoy y de ayer y no aparece"
          className={cn(FIELD, "h-auto py-2 font-normal leading-5")}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <OpsButton
          size="sm"
          variant="primary"
          disabled={pending || !note.trim()}
          onClick={() => void onSubmit(note)}
          className="pointer-coarse:h-11"
        >
          Liberar y volver a intentar
        </OpsButton>
        <OpsButton size="sm" variant="ghost" onClick={onCancel} className="pointer-coarse:h-11">
          Cancelar
        </OpsButton>
      </div>
    </div>
  );
}

/**
 * «Ya tiene comprobante» (§35.4): la boleta se emitió a mano en SimpleFact y se
 * registra para que Kapta no emita otra. El servidor valida la serie.
 */
export function ExternalInvoiceForm({
  issuers,
  pending,
  onSubmit,
  onCancel,
}: {
  issuers: InvoicePanelData["issuers"];
  pending: boolean;
  onSubmit: (input: { issuerId: string; serieNumber: string; note: string }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [issuerId, setIssuerId] = useState(issuers[0]?.id ?? "");
  const [serieNumber, setSerieNumber] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="space-y-3 rounded-lg bg-wash p-3">
      <p className="text-[13px] leading-5 text-ink-700">
        Si la boleta se emitió a mano en SimpleFact —por ejemplo, una de más de S/ 700 con DNI—, regístrala: Kapta no
        emitirá otra por este pedido.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
          RUC
          <select
            value={issuerId}
            onChange={(e) => setIssuerId(e.target.value)}
            className={cn(FIELD, "font-normal pointer-coarse:h-11")}
          >
            {issuers.map((i) => (
              <option key={i.id} value={i.id}>
                {i.ruc} · {i.legalName}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
          Serie y número
          <input
            value={serieNumber}
            onChange={(e) => setSerieNumber(e.target.value)}
            placeholder="B001-123"
            autoCapitalize="characters"
            className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
          />
        </label>
      </div>
      <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
        Nota
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="Opcional: quién la emitió y por qué"
          className={cn(FIELD, "font-normal pointer-coarse:h-11")}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <OpsButton
          size="sm"
          variant="primary"
          disabled={pending || !issuerId || !serieNumber.trim()}
          onClick={() => void onSubmit({ issuerId, serieNumber, note })}
          className="pointer-coarse:h-11"
        >
          Registrar
        </OpsButton>
        <OpsButton size="sm" variant="ghost" onClick={onCancel} className="pointer-coarse:h-11">
          Cancelar
        </OpsButton>
      </div>
    </div>
  );
}
