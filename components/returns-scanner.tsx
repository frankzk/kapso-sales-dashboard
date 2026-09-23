"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { DispatchScanner } from "@/components/dispatch-scanner";
import { DispatchCamera } from "@/components/dispatch-camera";
import { returnUndeliveredByCode, returnUndeliveredToOffice } from "@/app/dashboard/courier/actions";
import type { PendingReturn } from "@/lib/courier-route-ledger";

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
