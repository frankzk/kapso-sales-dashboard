"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { approveRiderAdjustment, approveRiderDailyPay, getRiderPayDetail, saveRiderPayRate } from "@/app/dashboard/rutas/pay-actions";
import { riderPayBlockers, type RiderPayDetail } from "@/lib/rider-pay";

const money = (value: number | null) => value === null ? "Pendiente de tarifa" : `S/ ${value.toFixed(2)}`;

/** Qué significa el saldo neto: quién le debe efectivo a quién. */
export function riderPayBalanceLabel(netCash: number | null): string {
  return netCash === null ? "Saldo por calcular" : netCash > 0 ? "El motorizado debe entregar" : netCash < 0 ? "Grupo GF debe pagarle" : "Sin efectivo pendiente";
}
export const RIDER_PAY_BALANCE_HINT = "Efectivo menos ganancia base y adicionales. No incluye Yape/POS como efectivo del motorizado. Aprobar este cálculo no valida ingresos bancarios ni registra un pago o depósito.";
const field = "mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-base disabled:opacity-50";
const button = "inline-flex min-h-12 items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white disabled:opacity-50";

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

  if (loading) return <section aria-busy="true" aria-label="Cargando liquidación diaria" className={compact ? "text-sm text-slate-500" : "rounded-xl border border-slate-200 p-4"}><p>Cargando ganancia y saldo del motorizado…</p></section>;
  if (!detail) return <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4"><h3 className="font-semibold">Liquidación diaria del motorizado</h3><p role="alert">{error}</p><button className={button} disabled={busy} onClick={() => run(async () => { await load(); return {}; })}>Reintentar</button></section>;
  const s = detail.snapshot;
  const blockers = riderPayBlockers(s);
  const reversed = new Set(s.adjustments.map((a) => a.reverses_id).filter(Boolean));

  const approvedNote = detail.approved ? `Cálculo aprobado el ${new Date(detail.approved.at).toLocaleString("es-PE", { timeZone: "America/Lima" })}` : "Borrador: revisa antes de aprobar";

  return <section aria-label="Liquidación diaria del motorizado" className={compact ? "space-y-4" : "space-y-5 rounded-xl border border-slate-200 bg-white p-4 sm:p-5"}>
    {compact ? (
      <p className="text-sm font-medium text-slate-700">{approvedNote}</p>
    ) : (
    <header className="space-y-1">
      <h3 className="text-lg font-semibold">Ganancia y saldo de {s.rider_name}</h3>
      <p className="text-sm text-slate-600">Ruta del {s.day}. Este es el pago del motorizado, no la tarifa que Grupo GF cobra a la tienda.</p>
      <p className="text-sm font-medium">{approvedNote}</p>
    </header>
    )}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {message && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p>}

    {!compact && <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {[['Efectivo reportado en sus manos',money(s.cash)],['Yape / POS reportado a la empresa',money(s.direct)],
        ['Ganancia base por puntos',s.missing ? 'Pendiente de tarifa' : money(s.base)],['Adicionales aprobados',money(s.extra)]].map(([label,value]) =>
        <div key={label} className="flex justify-between gap-3 border-b border-slate-100 pb-2"><dt>{label}</dt><dd className="whitespace-nowrap font-semibold tabular-nums">{value}</dd></div>)}
    </dl>}
    {!compact && <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-slate-50 p-4">
      <p className="font-semibold">{riderPayBalanceLabel(s.net_cash)}</p>
      <p className="text-xl font-semibold tabular-nums">{money(s.net_cash === null ? null : Math.abs(s.net_cash))}</p>
      <p className="w-full text-xs text-slate-600">{RIDER_PAY_BALANCE_HINT}</p>
    </div>}

    {!compact && <div className="divide-y divide-slate-200">
      {s.rows.map((row) => <article key={row.stop_id} className="space-y-2 py-3 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><h4 className="font-semibold">{row.order_name ?? `Punto ${row.seq}`} · {row.district ?? "Distrito sin identificar"}</h4>
          <span>{row.status === "entregado" ? "Entregado" : row.outcome_reason === "rechazado" ? "Rechazado por el cliente" : row.status === "pendiente" ? "Sin reportar" : "No entregado"}</span></div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-slate-600"><span>Tarifa personal: <strong>{money(row.base)}</strong></span><span>Adicional: <strong>{money(row.extra)}</strong></span><span>Ganancia: <strong>{money(row.base === null ? null : row.base + row.extra)}</strong></span></div>
        {row.rate_id && <p className="text-xs text-slate-500">Vigencia desde {row.effective_from} · Versión {row.rate_id.slice(0,8)}</p>}
        {s.adjustments.filter((a) => a.stop_id === row.stop_id).map((a) => <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <p>{money(a.amount)} · {a.reason} · Aprobó {a.approved_label} · {new Date(a.approved_at).toLocaleString("es-PE", { timeZone: "America/Lima" })}{reversed.has(a.id) ? " · Anulado" : ""}</p>
          {!detail.approved && detail.canApprove && !a.reverses_id && !reversed.has(a.id) && <button type="button" disabled={busy} className="min-h-11 px-2 text-red-700 underline" onClick={() => {
            const why = prompt("Motivo de anulación del adicional (se conservará el historial):");
            if (why) void run(() => approveRiderAdjustment({ routeId, stopId: a.stop_id, amount: a.amount, reason: why, reverseId: a.id, requestId: requestId(`reverse:${a.id}:${why}`) }));
          }}>Anular adicional</button>}
        </div>)}
      </article>)}
    </div>}

    {compact && s.adjustments.length > 0 && <ul className="space-y-1 text-xs text-slate-600">
      {s.adjustments.map((a) => { const row = s.rows.find((r) => r.stop_id === a.stop_id); return <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
        <span>{row?.order_name ?? `Punto ${row?.seq ?? "?"}`} · {money(a.amount)} · {a.reason} · {a.approved_label}{reversed.has(a.id) ? " · Anulado" : ""}</span>
        {!detail.approved && detail.canApprove && !a.reverses_id && !reversed.has(a.id) && <button type="button" disabled={busy} className="min-h-0 p-0 text-red-700 underline" onClick={() => {
          const why = prompt("Motivo de anulación del adicional (se conservará el historial):");
          if (why) void run(() => approveRiderAdjustment({ routeId, stopId: a.stop_id, amount: a.amount, reason: why, reverseId: a.id, requestId: requestId(`reverse:${a.id}:${why}`) }));
        }}>Anular</button>}
      </li>; })}
    </ul>}

    {detail.canConfigure && <details className="border-t border-slate-200 pt-3"><summary className="min-h-12 cursor-pointer font-medium">{compact ? `Tarifa de ${s.rider_name}` : `Configurar tarifa de ${s.rider_name}`}</summary>
      <p className="mb-3 text-sm text-slate-600">Mismo importe por entrega o rechazo. Una excepción de distrito gana a la tarifa general. Los cierres aprobados no cambian.</p>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => saveRiderPayRate({ routeId, district: district || null, amount: Number(amount.replace(',','.')), from, reason })); }}>
        <label className="text-sm">Distrito<select className={field} value={district} onChange={(e) => setDistrict(e.target.value)} disabled={busy}><option value="">General del motorizado</option>{detail.districts.map((d) => <option key={d.district_key} value={d.district_key}>{d.name}</option>)}</select></label>
        <label className="text-sm">Soles por punto entregado o rechazado<input required inputMode="decimal" placeholder="Ej. 8,50" className={field} value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} /></label>
        <label className="text-sm">Vigente desde<input required type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} disabled={busy} /></label>
        <label className="text-sm">Motivo / acuerdo<input required minLength={3} className={field} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} /></label>
        <button className={button} disabled={busy || !amount.trim()}>Guardar nueva tarifa</button>
      </form>
      <details className="mt-3 text-sm"><summary className="min-h-11 cursor-pointer">Historial de tarifas personales ({detail.rates.length})</summary><ul className="space-y-2">{detail.rates.map((r) => <li key={r.id}>{r.district_key ?? 'General'} · {money(r.amount)} · Desde {r.effective_from} · {r.reason}</li>)}</ul></details>
    </details>}

    {!detail.approved && detail.canApprove && <>
      <details className="border-t border-slate-200 pt-3" open={compact ? extraOpen : undefined} onToggle={compact ? (e) => setExtraOpen((e.target as HTMLDetailsElement).open) : undefined}><summary className="min-h-12 cursor-pointer font-medium">{compact ? "Aprobar adicional" : "Aprobar adicional por espera, retorno u otra excepción"}</summary>
        {compact && <p className="mb-3 text-sm text-slate-600">Por espera, retorno u otra excepción de un punto.</p>}
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => approveRiderAdjustment({ routeId, stopId, amount: Number(extra.replace(',','.')), reason: extraReason, requestId: requestId(`${stopId}:${extra}:${extraReason}`) })); }}>
          <label className="text-sm">Punto<select required className={field} value={stopId} onChange={(e) => setStopId(e.target.value)} disabled={busy}><option value="">Selecciona un pedido</option>{s.rows.map((r) => <option key={r.stop_id} value={r.stop_id}>{r.order_name ?? `Punto ${r.seq}`}</option>)}</select></label>
          <label className="text-sm">Importe adicional en soles<input required className={field} inputMode="decimal" value={extra} onChange={(e) => setExtra(e.target.value)} disabled={busy} /></label>
          <label className="text-sm sm:col-span-2">Motivo de aprobación<input required minLength={3} className={field} value={extraReason} onChange={(e) => setExtraReason(e.target.value)} disabled={busy} /></label>
          <button className={button} disabled={busy || !extra.trim()}>Aprobar adicional con mi usuario</button>
        </form>
      </details>
      {blockers.length > 0 && <ul className="list-inside list-disc rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      <label className="flex min-h-12 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={busy || blockers.length > 0} />Revisé medios de pago, tarifas y adicionales. Entiendo quién entrega efectivo y quién recibe el pago.</label>
      <button className={`${button} w-full sm:w-auto`} disabled={busy || !reviewed || blockers.length > 0} onClick={() => run(() => approveRiderDailyPay(routeId, s))}>Aprobar cálculo diario del motorizado</button>
    </>}
    {detail.approved && <p className="text-sm text-slate-600">Desglose congelado. Conserva los importes aunque cambien las tarifas. Pendiente de registrar y conciliar el movimiento real de dinero.</p>}
  </section>;
}
