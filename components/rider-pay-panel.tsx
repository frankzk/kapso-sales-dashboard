"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { approveRiderAdjustment, approveRiderDailyPay, getRiderPayDetail, saveRiderPayRate } from "@/app/dashboard/rutas/pay-actions";
import { riderPayBlockers, type RiderPayDetail } from "@/lib/rider-pay";
import { Badge, Banner, CHECKBOX, FIELD } from "@/components/ops-ui";
import { IconChevronDown } from "@/components/icons";
import { cn } from "@/components/ui";

const money = (value: number | null) => value === null ? "Pendiente de tarifa" : `S/ ${value.toFixed(2)}`;

/** Qué significa el saldo neto: quién le debe efectivo a quién. */
export function riderPayBalanceLabel(netCash: number | null): string {
  return netCash === null ? "Saldo por calcular" : netCash > 0 ? "El motorizado debe entregar" : netCash < 0 ? "Grupo GF debe pagarle" : "Sin efectivo pendiente";
}
export const RIDER_PAY_BALANCE_HINT = "Efectivo menos ganancia base y adicionales. No incluye Yape/POS como efectivo del motorizado. Aprobar este cálculo no valida ingresos bancarios ni registra un pago o depósito.";
/** Ancla de «Tarifa de …»: «Configurar tarifa» del panel de cierre la abre. */
export const RIDER_RATE_FORM_ID = "tarifa-motorizado";
const field = cn(FIELD, "mt-1");
// El botón principal del mundo de operación (`OpsButton variant="primary"`), en clases: aquí va en <button> de formulario.
const button = "inline-flex h-9 items-center justify-center rounded-md bg-brand-600 px-3 text-sm font-semibold text-white shadow-primary transition-colors duration-150 hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-brand-600";
const label = "text-[13px] font-medium text-ink-700";
const summary = "flex min-h-10 cursor-pointer list-none items-center gap-1.5 px-3 text-sm font-semibold text-ink-700 hover:text-ink-900 [&::-webkit-details-marker]:hidden";
// Tarifa y adicional: filas de un mismo marco con hairline entre ellas, no etiquetas sueltas.
const disclosure = "group [&+&]:shadow-[inset_0_1px_0_var(--color-line)] [&>:not(summary)]:px-3 open:pb-3";
const chevron = <IconChevronDown aria-hidden className="size-4 -rotate-90 text-ink-500 transition-transform group-open:rotate-0" />;

/**
 * One daily rider balance, not a second courier selling-price calculator.
 *
 * `compact` (panel «Reparto y liquidación», MOM §29.14): los importes y el
 * desglose por parada ya los enseña la tabla única de `RouteDetail` (recibe
 * este cálculo por `onDetail`), así que aquí quedan solo las acciones: tarifa,
 * adicional (con `presetStopId` desde el «+ adicional» de la fila), aprobar.
 */
export function RiderPayPanel({ routeId, initialDetail, compact = false, onDetail, presetStopId = null }: {
  routeId: string;
  initialDetail?: RiderPayDetail;
  compact?: boolean;
  onDetail?: (detail: RiderPayDetail | null) => void;
  presetStopId?: string | null;
}) {
  const [detail, setDetail] = useState<RiderPayDetail | null>(initialDetail ?? null);
  const [extraOpen, setExtraOpen] = useState(false);
  useEffect(() => { onDetail?.(detail); }, [detail, onDetail]);
  useEffect(() => {
    if (!presetStopId) return;
    setStopId(presetStopId);
    setExtraOpen(true);
  }, [presetStopId]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!initialDetail);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [amount, setAmount] = useState("");
  const [district, setDistrict] = useState("");
  const [from, setFrom] = useState("");
  const [reason, setReason] = useState("");
  const [stopId, setStopId] = useState("");
  const [extra, setExtra] = useState("");
  const [extraReason, setExtraReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const actionLock = useRef(false);
  const extraRequest = useRef<{ signature: string; id: string } | null>(null);
  function requestId(signature: string) {
    if (extraRequest.current?.signature !== signature) extraRequest.current = { signature, id: crypto.randomUUID() };
    return extraRequest.current.id;
  }

  const load = useCallback(async () => {
    const result = await getRiderPayDetail(routeId);
    if (!result.detail) throw new Error(result.error ?? "No se pudo cargar el cálculo.");
    setDetail(result.detail);
    setReviewed(false);
    setFrom((previous) => previous || result.detail!.snapshot.day);
  }, [routeId]);
  useEffect(() => {
    if (initialDetail) { setFrom(initialDetail.snapshot.day); return; }
    let active = true;
    getRiderPayDetail(routeId).then((result) => {
      if (!active) return;
      if (result.detail) { setDetail(result.detail); setFrom(result.detail.snapshot.day); }
      else setError(result.error ?? "No se pudo cargar el cálculo.");
    }).catch(() => { if (active) setError("No se pudo conectar. Vuelve a cargar el cálculo."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [routeId, initialDetail]);
  async function run(action: () => Promise<{ error?: string; notice?: string }>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await action();
      if (result.error) { setError(result.error); setReviewed(false); return; }
      setMessage(result.notice ?? "Guardado.");
      await load();
      setExtra(""); setExtraReason("");
      extraRequest.current = null;
    } catch { setError("No se pudo confirmar el resultado. Recarga y revisa el historial antes de reintentar."); }
    finally { setBusy(false); actionLock.current = false; }
  }

  if (loading) return <section aria-busy="true" aria-label="Cargando liquidación diaria" className="text-sm text-ink-500"><p>Cargando ganancia y saldo del motorizado…</p></section>;
  if (!detail) return <Banner tone="warn" title="Liquidación diaria del motorizado"><p role="alert">{error}</p><button className={cn(button, "mt-3")} disabled={busy} onClick={() => run(async () => { await load(); return {}; })}>Reintentar</button></Banner>;
  const s = detail.snapshot;
  const blockers = riderPayBlockers(s);
  const reversed = new Set(s.adjustments.map((a) => a.reverses_id).filter(Boolean));

  const approvedNote = detail.approved ? `Cálculo aprobado el ${new Date(detail.approved.at).toLocaleString("es-PE", { timeZone: "America/Lima" })}` : "Borrador: revisa antes de aprobar";

  return <section aria-label="Liquidación diaria del motorizado" className={compact ? "space-y-3 pt-5 shadow-[inset_0_1px_0_var(--color-line)]" : "space-y-5 rounded-lg bg-white p-4 shadow-control ring-1 ring-line sm:p-5"}>
    {compact ? (
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink-900">Pago del motorizado</h3>
          <Badge tone={detail.approved ? "ok" : "neutral"}>{detail.approved ? "Aprobado" : "Borrador"}</Badge>
        </div>
        <p className="mt-0.5 text-[13px] text-ink-500">{detail.approved ? approvedNote : "Revisa tarifas, adicionales y medios de pago antes de aprobar."}</p>
      </header>
    ) : (
    <header className="space-y-1">
      <h3 className="text-lg font-semibold">Ganancia y saldo de {s.rider_name}</h3>
      <p className="text-sm text-ink-600">Ruta del {s.day}. Este es el pago del motorizado, no la tarifa que Grupo GF cobra a la tienda.</p>
      <p className="text-sm font-medium">{approvedNote}</p>
    </header>
    )}
    {error && <Banner tone="crit" role="alert">{error}</Banner>}
    {message && <Banner tone="ok" role="status">{message}</Banner>}

    {!compact && <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {[['Efectivo reportado en sus manos',money(s.cash)],['Yape / POS reportado a la empresa',money(s.direct)],
        ['Ganancia base por puntos',s.missing ? 'Pendiente de tarifa' : money(s.base)],['Adicionales aprobados',money(s.extra)]].map(([label,value]) =>
        <div key={label} className="flex justify-between gap-3 border-b border-line pb-2"><dt>{label}</dt><dd className="whitespace-nowrap font-semibold tabular-nums">{value}</dd></div>)}
    </dl>}
    {!compact && <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-wash p-4">
      <p className="font-semibold">{riderPayBalanceLabel(s.net_cash)}</p>
      <p className="text-xl font-semibold tabular-nums">{money(s.net_cash === null ? null : Math.abs(s.net_cash))}</p>
      <p className="w-full text-xs text-ink-600">{RIDER_PAY_BALANCE_HINT}</p>
    </div>}

    {!compact && <div className="divide-y divide-line">
      {s.rows.map((row) => <article key={row.stop_id} className="space-y-2 py-3 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><h4 className="font-semibold">{row.order_name ?? `Punto ${row.seq}`} · {row.district ?? "Distrito sin identificar"}</h4>
          <span>{row.status === "entregado" ? "Entregado" : row.outcome_reason === "rechazado" ? "Rechazado por el cliente" : row.status === "pendiente" ? "Sin reportar" : "No entregado"}</span></div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-ink-600"><span>Tarifa personal: <strong>{money(row.base)}</strong></span><span>Adicional: <strong>{money(row.extra)}</strong></span><span>Ganancia: <strong>{money(row.base === null ? null : row.base + row.extra)}</strong></span></div>
        {row.rate_id && <p className="text-xs text-ink-500">Vigencia desde {row.effective_from} · Versión {row.rate_id.slice(0,8)}</p>}
        {s.adjustments.filter((a) => a.stop_id === row.stop_id).map((a) => <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <p>{money(a.amount)} · {a.reason} · Aprobó {a.approved_label} · {new Date(a.approved_at).toLocaleString("es-PE", { timeZone: "America/Lima" })}{reversed.has(a.id) ? " · Anulado" : ""}</p>
          {!detail.approved && detail.canApprove && !a.reverses_id && !reversed.has(a.id) && <button type="button" disabled={busy} className="min-h-11 px-2 font-medium text-crit-fg hover:underline" onClick={() => {
            const why = prompt("Motivo de anulación del adicional (se conservará el historial):");
            if (why) void run(() => approveRiderAdjustment({ routeId, stopId: a.stop_id, amount: a.amount, reason: why, reverseId: a.id, requestId: requestId(`reverse:${a.id}:${why}`) }));
          }}>Anular adicional</button>}
        </div>)}
      </article>)}
    </div>}

    {compact && s.adjustments.length > 0 && <ul className="divide-y divide-line rounded-lg text-[13px] text-ink-700 ring-1 ring-line">
      {s.adjustments.map((a) => { const row = s.rows.find((r) => r.stop_id === a.stop_id); return <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="tabular-nums">{row?.order_name ?? `Punto ${row?.seq ?? "?"}`} · {money(a.amount)} · {a.reason} · {a.approved_label}{reversed.has(a.id) ? " · Anulado" : ""}</span>
        {!detail.approved && detail.canApprove && !a.reverses_id && !reversed.has(a.id) && <button type="button" disabled={busy} className="min-h-0 p-0 text-[13px] font-medium text-crit-fg hover:underline disabled:opacity-50" onClick={() => {
          const why = prompt("Motivo de anulación del adicional (se conservará el historial):");
          if (why) void run(() => approveRiderAdjustment({ routeId, stopId: a.stop_id, amount: a.amount, reason: why, reverseId: a.id, requestId: requestId(`reverse:${a.id}:${why}`) }));
        }}>Anular</button>}
      </li>; })}
    </ul>}

    {(detail.canConfigure || (!detail.approved && detail.canApprove)) && <div className="rounded-lg ring-1 ring-line">
    {detail.canConfigure && <details id={RIDER_RATE_FORM_ID} className={cn(disclosure, "scroll-mt-24")}><summary className={summary}>{chevron}{compact ? `Tarifa de ${s.rider_name}` : `Configurar tarifa de ${s.rider_name}`}</summary>
      <p className="mb-3 text-[13px] text-ink-600">Mismo importe por entrega o rechazo. Una excepción de distrito gana a la tarifa general. Los cierres aprobados no cambian.</p>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => saveRiderPayRate({ routeId, district: district || null, amount: Number(amount.replace(',','.')), from, reason })); }}>
        <label className={label}>Distrito<select className={field} value={district} onChange={(e) => setDistrict(e.target.value)} disabled={busy}><option value="">General del motorizado</option>{detail.districts.map((d) => <option key={d.district_key} value={d.district_key}>{d.name}</option>)}</select></label>
        <label className={label}>Soles por punto entregado o rechazado<input required inputMode="decimal" placeholder="Ej. 8,50" className={field} value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></label>
        <label className={label}>Vigente desde<input required type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} disabled={busy} /></label>
        <label className={label}>Motivo / acuerdo<input required minLength={3} className={field} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} /></label>
        <button className={cn(button, "self-end justify-self-start")} disabled={busy || !amount.trim()}>Guardar nueva tarifa</button>
      </form>
      <details className="group/h mt-3 text-sm"><summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-ink-600 hover:text-ink-900 [&::-webkit-details-marker]:hidden"><IconChevronDown aria-hidden className="size-4 -rotate-90 text-ink-500 transition-transform group-open/h:rotate-0" />Historial de tarifas personales <span className="tabular-nums text-ink-500">{detail.rates.length}</span></summary><ul className="space-y-1.5 pl-5.5 text-[13px] tabular-nums text-ink-600">{detail.rates.map((r) => <li key={r.id}>{r.district_key ?? 'General'} · {money(r.amount)} · Desde {r.effective_from} · {r.reason}</li>)}</ul></details>
    </details>}

    {!detail.approved && detail.canApprove && <details className={disclosure} open={compact ? extraOpen : undefined} onToggle={compact ? (e) => setExtraOpen((e.target as HTMLDetailsElement).open) : undefined}><summary className={summary}>{chevron}{compact ? "Aprobar adicional" : "Aprobar adicional por espera, retorno u otra excepción"}</summary>
        {compact && <p className="mb-3 text-[13px] text-ink-600">Por espera, retorno u otra excepción de un punto.</p>}
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => approveRiderAdjustment({ routeId, stopId, amount: Number(extra.replace(',','.')), reason: extraReason, requestId: requestId(`${stopId}:${extra}:${extraReason}`) })); }}>
          <label className={label}>Punto<select required className={field} value={stopId} onChange={(e) => setStopId(e.target.value)} disabled={busy}><option value="">Selecciona un pedido</option>{s.rows.map((r) => <option key={r.stop_id} value={r.stop_id}>{r.order_name ?? `Punto ${r.seq}`}</option>)}</select></label>
          <label className={label}>Importe adicional en soles<input required className={field} inputMode="decimal" value={extra} onChange={(e) => setExtra(e.target.value)} disabled={busy} /></label>
          <label className={cn(label, "sm:col-span-2")}>Motivo de aprobación<input required minLength={3} className={field} value={extraReason} onChange={(e) => setExtraReason(e.target.value)} disabled={busy} /></label>
          <button className={cn(button, "justify-self-start")} disabled={busy || !extra.trim()}>Aprobar adicional con mi usuario</button>
        </form>
      </details>}
    </div>}
    {!detail.approved && detail.canApprove && <>
      {blockers.length > 0 && <Banner tone="warn" title="Todavía no se puede aprobar"><ul className="mt-1 list-inside list-disc space-y-0.5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul></Banner>}
      <label className="flex items-start gap-2.5 pt-1 text-sm text-ink-700"><input type="checkbox" className={cn(CHECKBOX, "mt-0.5 disabled:cursor-not-allowed")} checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={busy || blockers.length > 0} />Revisé medios de pago, tarifas y adicionales. Entiendo quién entrega efectivo y quién recibe el pago.</label>
      <button className={`${button} w-full sm:w-auto`} disabled={busy || !reviewed || blockers.length > 0} onClick={() => run(() => approveRiderDailyPay(routeId, s))}>Aprobar cálculo diario del motorizado</button>
    </>}
    {detail.approved && <p className="text-[13px] text-ink-600">Desglose congelado. Conserva los importes aunque cambien las tarifas. Pendiente de registrar y conciliar el movimiento real de dinero.</p>}
  </section>;
}
