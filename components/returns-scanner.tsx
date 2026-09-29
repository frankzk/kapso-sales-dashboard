"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DispatchScanner } from "@/components/dispatch-scanner";
import { DispatchCamera } from "@/components/dispatch-camera";
import { returnUndeliveredByCode, returnUndeliveredToOffice } from "@/app/dashboard/courier/actions";
import type { PendingReturn } from "@/lib/courier-route-ledger";
import { nonDeliveryReasonLabel } from "@/lib/gf-delivery";
import { Badge, OpsButton } from "@/components/ops-ui";

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
      <DispatchScanner busy={busy} disabled={false} compact look="ops" buttonLabel="Escanear" onScan={(code) => void run(code)} onCamera={() => setCameraOpen(true)} />
      <p className="mt-3 text-[13px] text-ink-500">Confirma que la devolución llegó a la oficina: <b className="font-semibold tabular-nums text-ink-900">{total - left.length} de {total}</b> recibidas{left.length ? `, faltan ${left.length}` : ""}. Un no entregado vuelve a «por asignar»; un rechazo queda devuelto.</p>
      {lines.length > 0 && (
        <ul className="mt-3 max-h-40 divide-y divide-line overflow-auto rounded-lg text-sm ring-1 ring-line" aria-live="polite">
          {lines.map((l, i) => (
            <li key={`${l.code}:${i}`} className="flex items-center gap-2 px-3 py-2">
              <span className="font-semibold text-ink-900">{l.code}</span>
              <Badge tone={l.ok ? "ok" : "crit"} className="min-w-0">{l.text}</Badge>
            </li>
          ))}
        </ul>
      )}
      {/* Cuáles son: lo que falta devolver, del más antiguo al más reciente. */}
      <div className="mt-4 max-h-[55vh] overflow-auto rounded-lg ring-1 ring-line">
        <table className="w-full min-w-[720px] table-fixed text-sm">
          <colgroup>
            <col className="w-[8.5rem]" />
            <col />
            <col className="w-[7rem]" />
            <col className="w-[5.5rem]" />
            <col className="w-[11rem]" />
            <col className="w-[6rem]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-white text-left text-xs font-semibold text-ink-600 shadow-[inset_0_-1px_0_var(--color-line)]">
            <tr>
              <th className="px-3 py-2.5">Pedido</th>
              <th className="px-3 py-2.5">Cliente</th>
              <th className="px-3 py-2.5">Motorizado</th>
              <th className="px-3 py-2.5">Caja del</th>
              <th className="px-3 py-2.5">Motivo</th>
              <th className="px-3 py-2.5"><span className="sr-only">Recibir</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {left.map((p) => (
              <tr key={p.orderId} className="align-top transition-colors hover:bg-wash">
                <td className="px-3 py-2.5">
                  <p className="truncate font-semibold text-ink-900" title={p.orderName}>{p.orderName}</p>
                  {p.code && <p className="truncate font-mono text-[11px] text-ink-500" title={p.code}>{p.code}</p>}
                </td>
                <td className="px-3 py-2.5"><p className="truncate text-ink-900" title={`${p.customerName} · ${p.district}`}>{p.customerName}</p><p className="truncate text-xs text-ink-500" title={p.district}>{p.district}</p></td>
                <td className="truncate px-3 py-2.5 text-ink-700" title={p.riderName}>{p.riderName}</td>
                <td className="px-3 py-2.5 tabular-nums text-ink-700">{p.routeDate ? `${p.routeDate.slice(8, 10)}/${p.routeDate.slice(5, 7)}` : "—"}</td>
                <td className="px-3 py-2.5"><Badge tone={p.reason === "rechazado" ? "urgent" : "crit"} title={nonDeliveryReasonLabel(p.reason)}>{nonDeliveryReasonLabel(p.reason)}</Badge></td>
                <td className="px-3 py-2 text-right"><OpsButton size="sm" disabled={busy} onClick={() => void run(p.orderName, p.orderId)}>Recibir</OpsButton></td>
              </tr>
            ))}
            {!left.length && <tr><td colSpan={6} className="px-3 py-10 text-center text-sm font-medium text-ok-fg">Todas las devoluciones están en la oficina.</td></tr>}
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
