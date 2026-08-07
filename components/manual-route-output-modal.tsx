"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  createManualRouteOutput,
  type ManualRouteCourier,
} from "@/app/dashboard/pedidos/actions";
import { limaTodayKey } from "@/lib/shipments";
import type { RouteCandidate } from "@/lib/order-route-plan";

export function ManualRouteOutputModal({
  orderId,
  route,
  activeOutputs,
  onClose,
  onCreated,
}: {
  orderId: string;
  route: RouteCandidate & { key: ManualRouteCourier };
  activeOutputs: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [dispatchDate, setDispatchDate] = useState(limaTodayKey());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    notice: string;
    outputCode: string;
    labelUrl: string;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    startTransition(async () => {
      const result = await createManualRouteOutput(orderId, {
        courier: route.key,
        dispatchDate,
        note,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setCreated({
        notice: result.notice ?? "Salida creada.",
        outputCode: result.outputCode ?? "Salida creada",
        labelUrl: result.labelUrl ?? "#",
      });
      onCreated();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-3">
          <div>
            <p className="text-sm font-semibold text-slate-950">Nueva salida · {route.label}</p>
            <p className="mt-0.5 text-xs text-slate-500">Kapta generará un rótulo interno y un QR único para esta caja.</p>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-slate-700">Cerrar</button>
        </div>

        {created ? (
          <div className="space-y-3 pt-4">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <p className="font-mono text-sm font-bold text-emerald-950">{created.outputCode}</p>
              <p className="mt-1 text-sm text-emerald-800">{created.notice}</p>
            </div>
            <a
              href={created.labelUrl}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-10 items-center justify-center rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Imprimir rótulo con QR
            </a>
            {/* Recién impreso el rótulo, lo que sigue es armar la caja y
                escanearla; la ruta se decide después, en la mesa. */}
            <Link
              href="/dashboard/pedidos/almacen"
              className="flex min-h-10 items-center justify-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Ir al Almacén a escanear
            </Link>
          </div>
        ) : (
          <div className="space-y-3 pt-4">
            {activeOutputs > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                Este pedido tiene {activeOutputs} salida{activeOutputs === 1 ? "" : "s"} activa{activeOutputs === 1 ? "" : "s"}. La nueva caja tendrá otro QR; debes escribir por qué sale en paralelo.
              </div>
            )}
            {route.key === "olva" && (
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-900">
                Antes de crear Olva Agencia, el adelanto validado acumulado debe llegar como mínimo a S/ 30.
              </div>
            )}
            <label className="block text-xs font-medium text-slate-600">
              Fecha prevista de salida
              <input
                type="date"
                value={dispatchDate}
                onChange={(event) => setDispatchDate(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </label>
            <label className="block text-xs font-medium text-slate-600">
              Motivo / coordinación {activeOutputs > 0 ? "(obligatorio)" : "(opcional)"}
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder={activeOutputs > 0 ? "Ej.: salida anterior en retorno; cliente reconfirmó…" : "Horario, coordinación o indicación para el equipo…"}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </label>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
              La salida quedará como <b>Rótulo generado</b> y en custodia de la empresa. No se considera despachada hasta completar el doble cotejo.
            </div>
            {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
            <button
              type="button"
              onClick={create}
              disabled={pending || !dispatchDate || (activeOutputs > 0 && !note.trim())}
              className="w-full rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Creando salida…" : "Crear salida y QR"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

