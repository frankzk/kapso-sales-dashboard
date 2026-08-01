"use client";

import { cn } from "@/components/ui";
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
              <p className={cn(
                "mt-2 flex-1 text-xs leading-5",
                route.availability === "blocked" ? "text-slate-500" : "text-slate-600",
              )}>
                {route.reason}
              </p>
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
