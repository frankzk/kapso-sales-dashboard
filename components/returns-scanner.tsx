"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { DispatchScanner } from "@/components/dispatch-scanner";
import { DispatchCamera } from "@/components/dispatch-camera";
import { returnUndeliveredByCode, returnUndeliveredToOffice } from "@/app/dashboard/courier/actions";
import type { PendingReturn } from "@/lib/courier-route-ledger";
import { nonDeliveryReasonLabel } from "@/lib/gf-delivery";

/**
 * Devoluciones (Despacho del día): el supervisor escanea (o teclea) cada paquete «No
 * entregado» que vuelve con el motorizado. Cámara en serie, como al asignar,
 * con «Devueltos X de N». Cada lectura lo saca de la caja (0188/0189): un no
 * entregado vuelve a «por asignar»; un rechazo queda devuelto.
 */
export function ReturnsScanner({ orgId, pending }: { orgId: string; pending: PendingReturn[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [lines, setLines] = useState<{ code: string; ok: boolean; text: string }[]>([]);
  const [returned, setReturned] = useState<Set<string>>(new Set());
  // El total se fija al abrir: la lista se refresca y no debe cambiar la meta.
  const [total] = useState(pending.length);
  const left = pending.filter((p) => !returned.has(p.orderId));

  async function run(code: string, orderId?: string) {
    if (busy || !code.trim()) return;
    setBusy(true);
    try {
      const res = orderId ? await returnUndeliveredToOffice(orgId, [orderId]) : await returnUndeliveredByCode(orgId, code);
      const byCodeName = "orderName" in res && typeof res.orderName === "string" ? res.orderName : null;
      const name: string = orderId ? pending.find((p) => p.orderId === orderId)?.orderName ?? code : byCodeName ?? code;
      setLines((cur) => [{ code: name, ok: !res.error, text: res.error ?? "Devuelto a la oficina" }, ...cur].slice(0, 50));
      if (!res.error) {
        const hit = orderId ? orderId : pending.find((p) => p.orderName === name)?.orderId;
        if (hit) setReturned((cur) => new Set(cur).add(hit));
        router.refresh();
      }
    } catch {
      setLines((cur) => [{ code, ok: false, text: "No se pudo registrar. Reintenta el mismo código; no se duplicará." }, ...cur]);
    } finally {
      setBusy(false);
    }
  }

  const last = lines[0] ?? null;
  return (
    <div>
      <DispatchScanner busy={busy} disabled={false} compact buttonLabel="Escanear" onScan={(code) => void run(code)} onCamera={() => setCameraOpen(true)} />
      <p className="mt-2 text-xs text-slate-500">Confirma que la devolución llegó a la oficina: <b className="tabular-nums text-slate-800">{total - left.length} de {total}</b> recibidas{left.length ? `, faltan ${left.length}` : ""}. Un no entregado vuelve a «por asignar»; un rechazo queda devuelto.</p>
      {lines.length > 0 && (
        <ul className="mt-3 max-h-40 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200 text-sm" aria-live="polite">
          {lines.map((l, i) => (
            <li key={`${l.code}:${i}`} className={cn("flex items-center gap-2 px-3 py-1.5", l.ok ? "bg-emerald-50/60" : "bg-red-50/60")}>
              <span className="font-semibold text-slate-900">{l.code}</span>
              <span className={cn("text-xs", l.ok ? "text-emerald-700" : "text-red-700")}>{l.text}</span>
            </li>
          ))}
        </ul>
      )}
      {/* Cuáles son: lo que falta devolver, del más antiguo al más reciente. */}
      <div className="mt-4 max-h-[55vh] overflow-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[720px] table-fixed text-sm">
          <colgroup>
            <col className="w-[8.5rem]" />
            <col />
            <col className="w-[7rem]" />
            <col className="w-[5.5rem]" />
            <col className="w-[11rem]" />
            <col className="w-[6rem]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Pedido</th>
              <th className="px-3 py-2">Cliente</th>
              <th className="px-3 py-2">Motorizado</th>
              <th className="px-3 py-2">Caja del</th>
              <th className="px-3 py-2">Motivo</th>
              <th className="px-3 py-2"><span className="sr-only">Recibir</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {left.map((p) => (
              <tr key={p.orderId} className="align-top hover:bg-slate-50">
                <td className="px-3 py-2">
                  <p className="truncate font-semibold text-slate-900" title={p.orderName}>{p.orderName}</p>
                  {p.code && <p className="truncate font-mono text-[11px] text-slate-500" title={p.code}>{p.code}</p>}
                </td>
                <td className="px-3 py-2"><p className="truncate text-slate-800" title={`${p.customerName} · ${p.district}`}>{p.customerName}</p><p className="truncate text-xs text-slate-500" title={p.district}>{p.district}</p></td>
                <td className="truncate px-3 py-2 text-slate-700" title={p.riderName}>{p.riderName}</td>
                <td className="px-3 py-2 tabular-nums text-slate-700">{p.routeDate ? `${p.routeDate.slice(8, 10)}/${p.routeDate.slice(5, 7)}` : "—"}</td>
                <td className="px-3 py-2"><span className={cn("inline-block max-w-full truncate rounded-full px-2 py-0.5 text-[11px] font-medium", p.reason === "rechazado" ? "bg-red-600 text-white" : "bg-red-50 text-red-800")} title={nonDeliveryReasonLabel(p.reason)}>{nonDeliveryReasonLabel(p.reason)}</span></td>
                <td className="px-3 py-2 text-right"><button type="button" disabled={busy} onClick={() => void run(p.orderName, p.orderId)} className="min-h-8 rounded-lg border border-slate-300 px-2.5 text-xs font-medium text-slate-700 hover:bg-white disabled:opacity-50">Recibir</button></td>
              </tr>
            ))}
            {!left.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-emerald-700">Todas las devoluciones están en la oficina.</td></tr>}
          </tbody>
        </table>
      </div>
      <DispatchCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onScan={(value) => void run(value)}
        continuous
        progress={{ done: total - left.length, total, verb: "Devueltos" }}
        status={last ? { ok: last.ok, text: `${last.code}: ${last.text}` } : null}
      />
    </div>
  );
}
