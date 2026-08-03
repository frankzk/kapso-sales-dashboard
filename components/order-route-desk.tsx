"use client";

import { cn } from "@/components/ui";
import { operationalLabel } from "@/lib/order-status";
import type { OrderRoutePlan, RouteCandidate, RouteAction } from "@/lib/order-route-plan";

const STATUS_TONE = {
  available: "border-slate-200 bg-white",
  warning: "border-amber-200 bg-amber-50/60",
  blocked: "border-slate-200 bg-slate-50 opacity-60",
} as const;

const ACTION_LABEL: Record<RouteAction, string> = {
  aliclik: "Abrir Aliclik",
  swayp: "Gestionar Swayp",
  shalom: "Abrir Shalom",
  tanders: "Crear en Tanders",
  manual: "Crear salida",
};

export function OrderRouteDesk({
  plan,
  closed = false,
  actionEnabled,
  onSelect,
}: {
  plan: OrderRoutePlan;
  closed?: boolean;
  actionEnabled: (route: RouteCandidate) => boolean;
  onSelect: (route: RouteCandidate) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50/70">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Mesa de ruta</h3>
            <span className="rounded-full bg-slate-950 px-2 py-0.5 text-[11px] font-semibold text-white">
              {plan.operationLabel}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Decide la siguiente salida sin mezclar el pedido con sus cajas físicas.
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums text-slate-900">
            {plan.outputCount}<span className="text-sm font-normal text-slate-400">/{plan.maxOutputs}</span>
          </p>
          <p className="text-[11px] text-slate-500">salidas · {plan.activeOutputCount} activas</p>
        </div>
      </div>

      {plan.warnings.length > 0 && (
        <div className="space-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
          {plan.warnings.map((warning) => (
            <p key={warning} className="text-xs leading-5 text-amber-900">⚠ {warning}</p>
          ))}
        </div>
      )}

      <div className="grid gap-2 p-3 sm:grid-cols-2">
        {plan.candidates.map((route) => {
          const enabled = !closed && route.availability !== "blocked" && actionEnabled(route);
          return (
            <article
              key={route.key}
              className={cn(
                "relative flex min-h-36 flex-col rounded-lg border p-3",
                STATUS_TONE[route.availability],
                route.recommended && route.availability !== "blocked" && "ring-2 ring-slate-900/10",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{route.label}</p>
                  <p className="mt-0.5 text-[11px] font-medium text-slate-500">{route.timing}</p>
                </div>
                {route.recommended && route.availability !== "blocked" && (
                  <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                    Sugerido
                  </span>
                )}
              </div>
              {/* Nombrar la salida que bloquea, no solo decir que existe.
                  «No disponible» a secas obliga a bajar hasta «Salidas y guías»
                  para saber de cuál se habla, y en el panel del courier hay que
                  buscarla por su número. Con el número, el código corto y el
                  estado que el courier reporta, la tarjeta ya contesta las tres
                  preguntas que uno se hace ahí mismo. */}
              {route.blockingOutput && (
                <div className="mt-2 rounded-md border border-slate-200 bg-white px-2 py-1.5">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-600">
                    <span className="font-semibold uppercase tracking-wide text-slate-500">
                      Salida activa
                    </span>
                    {route.blockingOutput.guideCode && (
                      // `select-all`: el número se copia de un clic para pegarlo
                      // en el buscador del panel del courier, que es lo que se
                      // hace con él justo después de leerlo.
                      <span className="select-all font-mono font-semibold text-slate-800">
                        N° {route.blockingOutput.guideCode}
                      </span>
                    )}
                    {route.blockingOutput.shortCode && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono font-medium text-slate-700">
                        {route.blockingOutput.shortCode}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {operationalLabel(
                      route.blockingOutput.pickupState ?? route.blockingOutput.deliveryStatus,
                    )}
                  </p>
                </div>
              )}
              <p className={cn(
                "mt-2 text-xs leading-5",
                route.availability === "blocked" ? "text-slate-500" : "text-slate-600",
              )}>
                {route.reason}
              </p>
              <div className="flex-1" />
              <button
                type="button"
                disabled={!enabled}
                onClick={() => onSelect(route)}
                className={cn(
                  "mt-3 min-h-8 rounded-md px-2.5 text-xs font-semibold transition",
                  enabled
                    ? route.recommended
                      ? "bg-slate-950 text-white hover:bg-slate-800"
                      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    : "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400",
                )}
              >
                {closed
                  ? "Reabrir primero"
                  : route.blockingOutput
                  ? "Ya tiene salida activa"
                  : route.availability === "blocked"
                  ? "No disponible"
                  : actionEnabled(route)
                    ? ACTION_LABEL[route.action]
                    : "Sin permiso"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
