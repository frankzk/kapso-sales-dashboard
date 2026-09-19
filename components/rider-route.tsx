"use client";

// La pantalla del motorizado. Pensada para un teléfono, con una mano, en la
// calle y con mala señal:
//
//   - una parada a la vez, no una tabla;
//   - botones grandes y pocos;
//   - la dirección y el mapa antes que nada, que es lo que necesita primero;
//   - el formulario valida ANTES de subir nada, para no gastarle datos;
//   - la foto se sube aparte del reporte, así una caída de red no le borra lo
//     que ya escribió.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  NON_DELIVERY_REASONS,
  PAYMENT_METHODS,
  routeTotals,
  validateStopReport,
  type PaymentMethod,
  type StopStatus,
} from "@/lib/routes";
import type { RouteRow, StopWithOrder } from "@/lib/routes-access";
import { addManualStop, addSheetOnlyPoint, reportStop, searchOrdersForRider } from "@/app/reparto/actions";
import { ScanAction } from "@/components/scan-action";
import type { RiderOrderCandidate, RiderVocabulary } from "@/lib/sheets/rider-access";
import { resolveWrittenForStop } from "@/lib/sheets/stop-bridge";
import { montoDiffers } from "@/lib/sheets/rider-cuaderno";
import { REPARTO_PAYMENT_METHODS } from "@/lib/sheets/templates";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `S/ ${n.toFixed(2)}`;

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Enlace al mapa: por coordenadas si las hay, si no por la dirección escrita. */
function mapHref(stop: StopWithOrder): string {
  const o = stop.order;
  if (o?.latitude != null && o?.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${o.latitude},${o.longitude}`;
  }
  const parts = [o?.address, o?.district, o?.province, "Perú"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts)}`;
}

export function RiderRouteScreen({
  riderName,
  routes,
  route,
  stops,
  coordinator,
  routeLabels,
  vocabulary,
  today,
}: {
  riderName: string;
  routes: RouteRow[];
  route: RouteRow | null;
  stops: StopWithOrder[];
  coordinator?: string;
  routeLabels?: Record<string, string>;
  /** Vocabulario de su hoja de Reparto propio (MOM §30.9); ausente si no tiene hoja. */
  vocabulary?: RiderVocabulary | null;
  /** Hoy en Lima, para los puntos añadidos a mano. */
  today?: string;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const totals = useMemo(() => routeTotals(stops), [stops]);
  const closed = route?.status === "cerrada";

  if (!route) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Hola, {riderName}</h1>
          <p className="mt-2 text-sm text-slate-500">
            Todavía no tienes ninguna ruta asignada. Cuando el coordinador te la entregue, aparecerá
            aquí. Si ya saliste con paquetes, añádelos abajo.
          </p>
        </div>
        {!coordinator && vocabulary && today && <AddPointPanel fecha={today} onDone={() => router.refresh()} />}
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-md bg-slate-50 pb-24">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-slate-900">{riderName}</h1>
          {routes.length > 1 ? (
            <select
              value={route.id}
              onChange={(e) => router.push(`/reparto?ruta=${e.target.value}${coordinator ? "&modo=coordinacion" : ""}`)}
              aria-label="Ruta a reportar"
              className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600"
            >
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {routeLabels?.[r.id] ?? r.route_date}
                  {r.status === "cerrada" ? " (cerrada)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-slate-500">{route.route_date}</span>
          )}
        </div>
        {coordinator && <p className="mt-2 text-sm text-slate-600">Reportas como <strong>{coordinator}</strong> por el motorizado. Tu usuario quedará registrado. <a className="underline" href="/dashboard/courier/reparto">Volver a Rutas</a></p>}
        <div className="mt-2 flex gap-3 text-xs">
          <Pill label="Por entregar" value={totals.pendientes} tone="pend" />
          <Pill label="Entregados" value={totals.entregados} tone="ok" />
          <Pill label="No entregados" value={totals.noEntregados} tone="bad" />
        </div>
        {totals.efectivo > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            {coordinator ? "Efectivo reportado por la ruta:" : "Efectivo en tu mano:"}{" "}
            <strong className="text-slate-800">{money(totals.efectivo)}</strong>
            {totals.yape > 0 && <> · Yape {money(totals.yape)}</>}
            {totals.pos > 0 && <> · POS {money(totals.pos)}</>}
          </p>
        )}
        {closed && (
          <p className="mt-2 rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-600">
            Esta ruta ya está cerrada. Si algo quedó mal, avisa al coordinador.
          </p>
        )}
      </header>

      <ul className="space-y-2 p-3">
        {stops.map((stop) => (
          <li key={stop.id}>
            <StopCard
              stop={stop}
              open={openId === stop.id}
              readOnly={closed}
              delegated={Boolean(coordinator)}
              vocabulary={vocabulary ?? null}
              onToggle={() => setOpenId(openId === stop.id ? null : stop.id)}
              onDone={() => {
                setOpenId(null);
                router.refresh();
              }}
            />
          </li>
        ))}
        {stops.length === 0 && (
          <li className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            Esta ruta no tiene paradas.
          </li>
        )}
      </ul>

      {!closed && !coordinator && vocabulary && (
        <div className="px-3 pb-3">
          <AddPointPanel fecha={route.route_date} onDone={() => router.refresh()} />
        </div>
      )}

      {totals.completa && !closed && !coordinator && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-md border-t border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-sm text-emerald-800">
          Terminaste tus {totals.total} paradas. Ya puedes entregar{" "}
          <strong>{money(totals.efectivo)}</strong> en efectivo.
        </div>
      )}
    </main>
  );
}

function Pill({ label, value, tone }: { label: string; value: number; tone: "pend" | "ok" | "bad" }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "ok" && "bg-emerald-50 text-emerald-700",
        tone === "bad" && "bg-red-50 text-red-700",
        tone === "pend" && "bg-slate-100 text-slate-600",
      )}
    >
      {value} {label}
    </span>
  );
}

function StopCard({
  stop,
  open,
  readOnly,
  delegated = false,
  vocabulary = null,
  onToggle,
  onDone,
}: {
  stop: StopWithOrder;
  open: boolean;
  readOnly: boolean;
  delegated?: boolean;
  vocabulary?: RiderVocabulary | null;
  onToggle: () => void;
  onDone: () => void;
}) {
  const o = stop.order;
  const done = stop.status !== "pendiente";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-white",
        stop.status === "entregado" && "border-emerald-200",
        stop.status === "no_entregado" && "border-red-200",
        stop.status === "pendiente" && "border-slate-200",
      )}
    >
      <button onClick={onToggle} className="w-full px-4 py-3 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">
              {o?.customer_name ?? "Sin nombre"}
            </p>
            <p className="truncate text-xs text-slate-500">
              {o?.district ?? "—"} · {o?.name ?? "—"}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold text-slate-800">{money(o?.total)}</p>
            <p
              className={cn(
                "text-[11px]",
                stop.status === "entregado" && "text-emerald-700",
                stop.status === "no_entregado" && "text-red-700",
                stop.status === "pendiente" && "text-slate-400",
              )}
            >
              {stop.written_status
                ? stop.written_status
                : stop.status === "entregado"
                  ? "Entregado"
                  : stop.status === "no_entregado"
                    ? "No entregado"
                    : "Por entregar"}
            </p>
          </div>
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-100 px-4 py-3">
          <div className="text-sm text-slate-700">
            <p>{o?.address ?? "Sin dirección"}</p>
            {o?.reference && <p className="text-xs text-slate-500">Ref: {o.reference}</p>}
          </div>
          <div className="flex gap-2">
            <a
              href={mapHref(stop)}
              target="_blank"
              rel="noreferrer"
              className="flex-1 rounded-lg bg-slate-800 px-3 py-2.5 text-center text-sm font-medium text-white"
            >
              Abrir mapa
            </a>
            {o?.customer_phone && (
              <a
                href={`tel:${o.customer_phone}`}
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-center text-sm font-medium text-slate-700"
              >
                Llamar
              </a>
            )}
          </div>

          {readOnly ? (
            <p className="text-xs text-slate-500">
              {done ? "Ya reportada." : "Sin reportar."} La ruta está cerrada.
            </p>
          ) : (
            <ReportForm stop={stop} onDone={onDone} delegated={delegated} vocabulary={vocabulary} />
          )}
        </div>
      )}
    </div>
  );
}

export function ReportForm({ stop, onDone, delegated = false, vocabulary = null }: { stop: StopWithOrder; onDone: () => void; delegated?: boolean; vocabulary?: RiderVocabulary | null }) {
  const [pending, start] = useTransition();
  // Lo que escribe el motorizado, tal cual (MOM §30.7): se guarda literal y se
  // resuelve con el vocabulario de su hoja; si resuelve, mueve los botones.
  const [written, setWritten] = useState(stop.written_status ?? "");
  const [writtenPayment, setWrittenPayment] = useState(stop.written_payment ?? "");
  const [reasonCode, setReasonCode] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const resolved = useMemo(() => (vocabulary ? resolveWrittenForStop(written, vocabulary) : null), [written, vocabulary]);
  const [status, setStatus] = useState<StopStatus>(
    stop.status === "pendiente" ? "entregado" : stop.status,
  );
  const [method, setMethod] = useState<PaymentMethod | null>(
    (stop.payment_method as PaymentMethod | null) ?? null,
  );
  const [amount, setAmount] = useState(
    stop.collected_amount != null ? String(stop.collected_amount) : String(stop.collection?.remaining ?? ""),
  );
  const [reason, setReason] = useState(stop.outcome_reason ?? "");
  const [note, setNote] = useState(stop.note ?? "");
  const [photoPath, setPhotoPath] = useState<string | null>(stop.photo_path);
  const [voucherPath, setVoucherPath] = useState<string | null>(stop.voucher_path);
  const [err, setErr] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("");

  const numericAmount = amount.trim() ? Number(amount.replace(",", ".")) : null;
  const collectedForReason = status === "entregado" ? (method === "sin_cobro" ? 0 : numericAmount) : null;
  const mustExplain = status === "entregado" && Boolean(vocabulary) && montoDiffers(collectedForReason, stop.order?.total ?? null);

  function applyWritten(text: string) {
    setWritten(text);
    if (!vocabulary) return;
    const res = resolveWrittenForStop(text, vocabulary);
    if (!res.target) return;
    if (res.target.status === "entregado") setStatus("entregado");
    else if (res.target.status === "no_entregado") {
      setStatus("no_entregado");
      setReason(res.target.outcome_reason ?? "");
    }
  }

  function submit() {
    if (delegated && !reportReason.trim()) {
      setErr("Indica por qué reportas por el motorizado.");
      return;
    }
    if (delegated && !photoPath) {
      setErr("Adjunta la evidencia del reporte por el motorizado.");
      return;
    }
    // Se valida con la MISMA función que el servidor, para avisarle antes de
    // gastarle datos en una petición que va a rebotar igual.
    const check = validateStopReport({
      status,
      paymentMethod: status === "entregado" ? method : null,
      collectedAmount: status === "entregado" ? (method === "sin_cobro" ? 0 : numericAmount) : null,
      outcomeReason: status === "no_entregado" ? reason || null : null,
      note,
      hasPhoto: Boolean(photoPath),
      hasVoucher: Boolean(voucherPath),
    });
    if (!check.ok) {
      setErr(check.errors.join(" "));
      return;
    }
    if (mustExplain && !reasonCode) {
      setErr(`Cobraste ${money(collectedForReason)} y el pedido es de ${money(stop.order?.total)}. Elige por qué.`);
      return;
    }
    if (mustExplain && reasonCode === "otro" && reasonNote.trim().length < 3) {
      setErr("Con motivo «Otro», escribe una nota.");
      return;
    }
    start(async () => {
      setErr(null);
      try {
        const res = await reportStop({
          stopId: stop.id,
          status,
          paymentMethod: status === "entregado" ? method : null,
          collectedAmount: status === "entregado" ? (method === "sin_cobro" ? 0 : numericAmount) : null,
          outcomeReason: status === "no_entregado" ? reason || null : null,
          note: note.trim() || null,
          photoPath,
          voucherPath,
          reportReason: delegated ? reportReason : null,
          writtenStatus: written.trim() || null,
          writtenStatusCode: resolved?.code ?? null,
          writtenPayment: writtenPayment.trim() || null,
          reasonCode: mustExplain ? reasonCode : null,
          reasonNote: mustExplain ? reasonNote.trim() || null : null,
        });
        if (!res.ok) setErr(res.error ?? "No se pudo guardar.");
        else onDone();
      } catch {
        setErr("No se pudo confirmar el guardado. Revisa tu conexión y actualiza la ruta antes de reintentar.");
      }
    });
  }

  return (
    <div className="space-y-3">
      {delegated && <label className="block text-sm text-slate-700">Motivo del reporte por el motorizado
        <input required value={reportReason} onChange={(e) => setReportReason(e.target.value)} placeholder="Ej. Roy envió la evidencia y está sin conexión" className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base" />
      </label>}
      {vocabulary && (
        <label className="block text-sm text-slate-700">
          ¿Qué pasó? Escríbelo como en tu cuaderno
          <input
            list={`estados-${stop.id}`}
            value={written}
            onChange={(e) => applyWritten(e.target.value)}
            placeholder="ENTREGADO, NO RESPONDE, LO DEJA…"
            className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base uppercase"
            autoCapitalize="characters"
          />
          <datalist id={`estados-${stop.id}`}>
            {vocabulary.suggestions.map((sug) => (
              <option key={sug} value={sug} />
            ))}
          </datalist>
          {written.trim() && (
            <p className={cn("mt-1 text-xs", resolved?.code ? "text-emerald-700" : "text-amber-700")}>
              {resolved?.code ? `Se entiende como «${resolved.label}».` : "Todavía no tiene equivalente: se guarda igual y alguien lo asignará."}
            </p>
          )}
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setStatus("entregado")}
          className={cn(
            "rounded-lg px-3 py-2.5 text-sm font-medium",
            status === "entregado"
              ? "bg-emerald-600 text-white"
              : "border border-slate-300 text-slate-700",
          )}
        >
          Entregado
        </button>
        <button
          onClick={() => setStatus("no_entregado")}
          className={cn(
            "rounded-lg px-3 py-2.5 text-sm font-medium",
            status === "no_entregado"
              ? "bg-red-600 text-white"
              : "border border-slate-300 text-slate-700",
          )}
        >
          No entregado
        </button>
      </div>

      {status === "entregado" && (
        <>
          <div className="space-y-1 rounded-lg bg-slate-50 p-3 text-sm">
            <p className="font-semibold">Saldo por cobrar: {stop.collection?.remaining == null ? "No disponible, actualiza la ruta" : money(stop.collection.remaining)}</p>
            {!!stop.collection?.validated && <p>Pagos previos validados: {money(stop.collection.validated)}</p>}
            {!!stop.collection?.pending && <p className="text-amber-800">Hay {money(stop.collection.pending)} pendientes de validar. Consulta a coordinación antes de volver a cobrar.</p>}
          </div>
          <p className="text-sm font-medium">¿Cómo se pagó esta entrega? Elige una opción.</p>
          <div className="flex flex-wrap gap-1.5">
            {PAYMENT_METHODS.map((m) => (
              <button
                key={m.code}
                type="button"
                aria-pressed={method === m.code}
                disabled={pending}
                onClick={() => setMethod(m.code)}
                className={cn(
                  "min-h-12 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50",
                  method === m.code
                    ? "bg-slate-800 text-white"
                    : "border border-slate-300 text-slate-700",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          {method && method !== "sin_cobro" && (
            <label className="block text-sm font-medium">Importe cobrado en esta entrega
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="¿Cuánto cobraste?"
              className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
            />
            </label>
          )}
          {vocabulary && method && method !== "sin_cobro" && (
            <label className="block text-sm text-slate-700">Detalle del pago (a qué cuenta, como en el cuaderno)
              <input
                list={`pagos-${stop.id}`}
                value={writtenPayment}
                onChange={(e) => setWrittenPayment(e.target.value)}
                placeholder="YAPE GF, PLIN FRANKZ, IZIPAY…"
                className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base uppercase"
                autoCapitalize="characters"
              />
              <datalist id={`pagos-${stop.id}`}>
                {REPARTO_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          )}
          {mustExplain && vocabulary && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <p className="font-medium text-amber-900">Cobraste {money(collectedForReason)} y el pedido es de {money(stop.order?.total)}. ¿Por qué?</p>
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} aria-label="Motivo de la diferencia" className="min-h-12 w-full rounded-lg border border-amber-300 bg-white px-3 text-base">
                <option value="">Elige el motivo</option>
                {vocabulary.reasons.map((r) => (
                  <option key={r.code} value={r.code}>{r.label}</option>
                ))}
              </select>
              <input value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder="Nota (obligatoria con «Otro»)" aria-label="Nota del motivo" className="min-h-12 w-full rounded-lg border border-amber-300 bg-white px-3 text-base" />
            </div>
          )}
          {method === "sin_cobro" && <p className="text-sm">Se registrará S/ 0.00. Si queda saldo, explica el motivo en la nota.</p>}
          {method === "yape" && <p className="text-sm text-slate-600">Yape reportado a la empresa. La captura no equivale a validación bancaria.</p>}
          <ScanAction
            context="motorizado_entrega"
            stopId={stop.id}
            photoKind="entrega"
            photoPath={photoPath}
            label="Foto de la entrega"
            onResult={(r) => { if (r.error) setErr(r.error); else if (r.path) setPhotoPath(r.path); }}
          />
          {method === "yape" && (
            <ScanAction
              context="motorizado_entrega"
              stopId={stop.id}
              photoKind="yape"
              photoPath={voucherPath}
              label="Captura del Yape"
              onResult={(r) => { if (r.error) setErr(r.error); else if (r.path) setVoucherPath(r.path); }}
            />
          )}
        </>
      )}

      {status === "no_entregado" && (
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
        >
          <option value="">¿Por qué no se entregó?</option>
          {NON_DELIVERY_REASONS.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
      )}

      {status === "no_entregado" && delegated && <ScanAction
        context="motorizado_entrega"
        stopId={stop.id}
        photoKind="entrega"
        photoPath={photoPath}
        label="Evidencia del reporte"
        onResult={(r) => { if (r.error) setErr(r.error); else if (r.path) setPhotoPath(r.path); }}
      />}
      <textarea
        aria-label="Nota del reporte"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Nota (opcional)"
        rows={2}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />

      {err && <p role="alert" className="text-sm text-red-600">{err}</p>}

      <button
        onClick={submit}
        disabled={pending || (status === "entregado" && (method === null || stop.collection?.remaining == null))}
        className="w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Guardando…" : stop.status === "pendiente" ? "Guardar" : "Corregir"}
      </button>
    </div>
  );
}

/**
 * Puntos que no vienen de una carga: un pedido de Kapta se crea como PARADA en
 * la ruta del día (la verdad, MOM §29.12); un punto sin pedido (Kast) vive
 * solo en la hoja porque una parada exige pedido.
 */
function AddPointPanel({ fecha, onDone }: { fecha: string; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RiderOrderCandidate[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [kastName, setKastName] = useState("");

  async function search() {
    const q = query.trim();
    if (q.length < 3) return;
    const res = await searchOrdersForRider(q);
    setResults(res.results);
    if (!res.ok) setMsg({ ok: false, text: res.error ?? "No se pudo buscar." });
  }
  function add(orderId: string) {
    start(async () => {
      const res = await addManualStop({ orderId, fecha });
      setMsg({ ok: res.ok, text: res.ok ? (res.message ?? "Añadido.") : (res.error ?? "No se pudo añadir.") });
      if (res.ok) {
        setResults([]);
        setQuery("");
        onDone();
      }
    });
  }
  function addKast() {
    start(async () => {
      const res = await addSheetOnlyPoint({ fecha, cliente: kastName, tienda: "Kast" });
      setMsg({ ok: res.ok, text: res.ok ? (res.message ?? "Añadido.") : (res.error ?? "No se pudo añadir.") });
      if (res.ok) setKastName("");
    });
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="w-full rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700">
        + Añadir un punto que no está en mi ruta
      </button>
    );
  }
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4" aria-label="Añadir punto">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Añadir punto · {fecha}</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-500 underline">Cerrar</button>
      </div>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="Nº de pedido o nombre del cliente"
          aria-label="Buscar pedido"
          className="min-h-12 flex-1 rounded-lg border border-slate-300 px-3 text-base"
        />
        <button type="button" onClick={() => void search()} className="min-h-12 rounded-lg bg-slate-800 px-3 text-sm font-medium text-white">Buscar</button>
      </div>
      {results.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {results.map((r) => (
            <li key={r.order_id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-900">{r.order_name} · {r.customer_name ?? "Sin nombre"}</p>
                <p className="truncate text-xs text-slate-500">{r.district ?? "—"} · {money(r.order_total)}</p>
              </div>
              <button type="button" disabled={pending} onClick={() => add(r.order_id)} className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Añadir</button>
            </li>
          ))}
        </ul>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-600">Punto sin pedido de Kapta (Kast, encargo)</summary>
        <div className="mt-2 flex gap-2">
          <input value={kastName} onChange={(e) => setKastName(e.target.value)} placeholder="Nombre del cliente" aria-label="Cliente del punto sin pedido" className="min-h-12 flex-1 rounded-lg border border-slate-300 px-3 text-base" />
          <button type="button" disabled={pending || !kastName.trim()} onClick={addKast} className="min-h-12 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 disabled:opacity-50">Añadir</button>
        </div>
        <p className="mt-1 text-xs text-slate-500">Queda solo en tu cuaderno: sin pedido no hay parada que cobrar en Kapta.</p>
      </details>
      {msg && <p role="status" className={cn("text-sm", msg.ok ? "text-emerald-700" : "text-red-600")}>{msg.text}</p>}
    </section>
  );
}
