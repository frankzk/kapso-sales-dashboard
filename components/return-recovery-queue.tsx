"use client";

// Cola de recuperación de pedidos devueltos (MOM §11).
//
// Lo que se ve acá es una decisión, no una lista: a cada clienta cuya guía
// volvió se le escribe o no se le escribe. Por eso la fila NO elegible también
// se muestra, con su motivo al lado — "¿y a esta por qué no?" es la pregunta que
// más se hace frente a esta pantalla, y la respuesta tiene que estar en ella.
//
// El botón manda una plantilla aprobada por Meta que propone reenviar por
// agencia con adelanto. Es dinero pedido por adelantado y sale del WhatsApp de
// la tienda, así que el envío exige confirmación y no se puede deshacer.

import { useMemo, useState, useTransition } from "react";
import { Card, EmptyState } from "@/components/ui";
import {
  dismissRecoveryAction,
  sendRecoveryAction,
  type RecoveryView,
} from "@/app/dashboard/envios/recuperacion/actions";
import type { RecoveryQueueRow } from "@/lib/return-recovery";

type Tab = "pendientes" | "enviadas" | "descartadas";

/** "hace 3 días" — la antigüedad es el dato que decide: una devolución fresca se
 *  recupera; una de tres semanas casi nunca. */
function daysAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const d = Math.floor(ms / 86_400_000);
  if (d <= 0) return "hoy";
  if (d === 1) return "ayer";
  return `hace ${d} días`;
}

function money(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : `S/ ${Number(v).toFixed(2)}`;
}

export function ReturnRecoveryQueue({
  view,
  storeId,
  storeName,
  canContact,
}: {
  view: RecoveryView;
  storeId: string;
  storeName: string;
  canContact: boolean;
}) {
  const [tab, setTab] = useState<Tab>("pendientes");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const groups = useMemo(() => {
    const pendientes: RecoveryQueueRow[] = [];
    const enviadas: RecoveryQueueRow[] = [];
    const descartadas: RecoveryQueueRow[] = [];
    for (const r of view.rows) {
      if (r.recovery_state === "enviado") enviadas.push(r);
      else if (r.recovery_state === "descartado") descartadas.push(r);
      else pendientes.push(r);
    }
    return { pendientes, enviadas, descartadas };
  }, [view.rows]);

  const rows = groups[tab];
  const elegibles = groups.pendientes.filter((r) => r.skip === null).length;

  const send = (row: RecoveryQueueRow) => {
    const quien = row.customer_name?.trim() || row.customer_phone || "esta clienta";
    if (!confirm(`Enviar la plantilla de recuperación a ${quien}?\n\nSale del WhatsApp de ${storeName} y no se puede deshacer.`)) {
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await sendRecoveryAction(storeId, row.id);
      setMsg(
        res.ok
          ? { kind: "ok", text: `Mensaje enviado a ${quien}.` }
          : { kind: "error", text: res.error ?? "No se pudo enviar." },
      );
    });
  };

  const dismiss = (row: RecoveryQueueRow) => {
    const motivo = prompt("¿Por qué no se le escribe a esta clienta?");
    if (motivo == null) return;
    setMsg(null);
    startTransition(async () => {
      const res = await dismissRecoveryAction(storeId, row.id, motivo);
      setMsg(
        res.ok
          ? { kind: "ok", text: "Guía descartada." }
          : { kind: "error", text: res.error ?? "No se pudo descartar." },
      );
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Recuperar devoluciones · {storeName}
          </h1>
          <p className="text-sm text-slate-600">
            Guías de provincia que volvieron al almacén. El mensaje propone reenviar por agencia
            con adelanto — quien rechazó el producto en la puerta queda fuera por regla del MOM
            §11.
          </p>
        </div>
        {view.templateName && (
          <span className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
            Plantilla: <code className="font-mono">{view.templateName}</code>
            {view.auto ? " · envío automático encendido" : " · envío a mano"}
          </span>
        )}
      </div>

      {view.blocker && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {view.blocker}
        </div>
      )}
      {msg && (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            msg.kind === "ok"
              ? "border border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border border-rose-300 bg-rose-50 text-rose-900"
          }`}
        >
          {msg.text}
        </div>
      )}

      <nav className="flex flex-wrap gap-2">
        {(
          [
            ["pendientes", `Por decidir (${groups.pendientes.length})`],
            ["enviadas", `Enviadas (${groups.enviadas.length})`],
            ["descartadas", `Descartadas (${groups.descartadas.length})`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === key
                ? "bg-slate-900 text-white"
                : "border border-slate-300 text-slate-700 hover:bg-slate-50"
            }`}
          >
            {label}
          </button>
        ))}
        {tab === "pendientes" && (
          <span className="self-center text-xs text-slate-500">
            {elegibles} elegible{elegibles === 1 ? "" : "s"} de {groups.pendientes.length}
          </span>
        )}
      </nav>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title="Nada por acá">
            {tab === "pendientes"
              ? `Ninguna guía devuelta en los últimos ${view.maxDays * 2} días.`
              : "Todavía no hay guías en este estado."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Clienta</th>
                  <th className="px-3 py-2">Producto</th>
                  <th className="px-3 py-2">Monto</th>
                  <th className="px-3 py-2">Devuelta</th>
                  <th className="px-3 py-2">Motivo del courier</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className={r.skip && tab === "pendientes" ? "bg-slate-50/60" : ""}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{r.customer_name || "—"}</div>
                      <div className="text-xs text-slate-500">
                        {r.customer_phone || "sin número"}
                        {r.district ? ` · ${r.district}` : ""}
                      </div>
                      <div className="text-xs text-slate-400">
                        {r.order_name || r.guide_code || "—"}
                      </div>
                    </td>
                    <td className="max-w-xs px-3 py-2 text-slate-700">{r.product || "—"}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-700">
                      {money(r.reported_collect_amount)}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{daysAgo(r.returned_at)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {r.reported_status || r.non_delivery_reason || "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {tab === "pendientes" && r.skip === null && (
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            disabled={pending || !canContact || !!view.blocker}
                            onClick={() => send(r)}
                            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                          >
                            Enviar
                          </button>
                          <button
                            type="button"
                            disabled={pending || !canContact}
                            onClick={() => dismiss(r)}
                            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 disabled:opacity-40"
                          >
                            Descartar
                          </button>
                        </div>
                      )}
                      {tab === "pendientes" && r.skip !== null && (
                        <span className="text-xs text-slate-500">{r.skip}</span>
                      )}
                      {tab === "enviadas" && (
                        <span className="text-xs text-slate-500">
                          {daysAgo(r.recovery_sent_at)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-slate-500">
        La respuesta de la clienta la atiende el bot de WhatsApp, que es quien manda el número de
        cuenta cuando acepta. Desde acá solo sale el primer mensaje.
      </p>
    </div>
  );
}
