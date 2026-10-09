"use client";

// La mesa de ruta de la ficha del pedido, en el mundo de operación (DESIGN.md):
// una sección con su título, los bloqueos y avisos como avisos de página, y una
// tarjeta por modalidad. La sugerida lleva el anillo azul y el botón principal.

import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton, SectionHead } from "@/components/ops-ui";
import { AliclikOutlookLadder } from "@/components/aliclik-outlook";
import type { AliclikOutlook } from "@/lib/aliclik-outlook";
import { shipmentIsReturning, shipmentStateLabel } from "@/lib/order-status";
import type {
  OrderRoutePlan,
  RouteCandidate,
  RouteAction,
  RouteDeskBlocker,
  RouteDeskGate,
} from "@/lib/order-route-plan";

// Fondo y anillo por disponibilidad. La sugerida cambia el anillo por el azul
// de 2 px EN LUGAR de este: `cn` no resuelve conflictos y `ring-line` va
// detrás de `ring-brand-600` en el CSS, así que sumarlos dejaba el gris.
const STATUS_TONE = {
  available: { bg: "bg-white", ring: "ring-1 ring-inset ring-line" },
  warning: { bg: "bg-warn-wash", ring: "ring-1 ring-inset ring-warn-bg" },
  blocked: { bg: "bg-wash", ring: "ring-1 ring-inset ring-line" },
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
  gate,
  onJump,
  actionEnabled,
  onSelect,
  aliclikOutlook,
  storeName,
}: {
  plan: OrderRoutePlan;
  /**
   * Qué impide crear una salida y a cuáles de las modalidades. Lo calcula
   * `routeDeskGate`.
   *
   * Antes era un `closed` booleano que solo miraba la macroetapa, así que un
   * pedido `anulado` con el expediente reabierto pintaba el botón recomendado en
   * negro y la negativa salía recién dentro del modal.
   */
  gate?: RouteDeskGate;
  /** Lleva a la sección del drawer que levanta el bloqueo. */
  onJump?: (target: RouteDeskBlocker["target"]) => void;
  actionEnabled: (route: RouteCandidate) => boolean;
  onSelect: (route: RouteCandidate) => void;
  /** Cuántas guías de Aliclik se entregan según los días del pedido (09-10-2026). */
  aliclikOutlook?: AliclikOutlook | null;
  storeName?: string | null;
}) {
  const blockers = gate?.blockers ?? [];
  const blockedActions = new Set(gate?.blockedActions ?? []);
  return (
    <section className="space-y-4">
      <SectionHead
        title="Mesa de ruta"
        badge={<Badge>{plan.operationLabel}</Badge>}
        help="Decide la siguiente salida sin mezclar el pedido con sus cajas físicas."
        aside={
          <p className="text-[13px] leading-5 text-ink-500">
            <span className="text-lg font-semibold tabular-nums text-ink-900">{plan.outputCount}</span>
            <span className="tabular-nums">/{plan.maxOutputs}</span> salidas ·{" "}
            <span className="tabular-nums">{plan.activeOutputCount}</span> activas
          </p>
        }
      />

      {/* El motivo va ARRIBA y con el sitio donde se arregla. Un botón apagado
          que dice «Reabrir primero» no basta: hay dos «reabrir» en este drawer
          —el del expediente, en la Mesa de cierre, y el del estado, en Gestión
          manual— y solo uno sirve para cada caso. Sin decir cuál, la operadora
          prueba el que tiene más cerca y vuelve a chocar con el modal. */}
      {blockers.length > 0 && (
        <Banner tone="crit" role="alert">
          <div className="space-y-3">
            {blockers.map((blocker) => (
              <div key={blocker.text}>
                <p>{blocker.text}</p>
                {/* El atajo, no solo el nombre del panel. Los dos viven al fondo
                    de la pestaña, detrás de «Salidas y guías», y quien lee esto
                    está arriba del todo. */}
                {onJump && (
                  <OpsButton size="sm" onClick={() => onJump(blocker.target)} className="mt-2 pointer-coarse:h-11">
                    {blocker.cta}
                  </OpsButton>
                )}
              </div>
            ))}
          </div>
        </Banner>
      )}

      {plan.warnings.length > 0 && (
        <Banner tone="warn">
          <ul className="space-y-1">
            {plan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {plan.candidates.map((route) => {
          // Por MODALIDAD, no por pedido: con el pedido cerrado, Tanders y
          // Shalom se niegan siempre, la salida manual solo si no se cerró por
          // una entrega fallida, y Aliclik y Swayp ni miran el estado. Ver
          // `routeDeskGate`.
          const closed = blockedActions.has(route.action);
          const enabled = !closed && route.availability !== "blocked" && actionEnabled(route);
          // «Sugerido» solo cuando se puede tomar: con el pedido cerrado la
          // tarjeta dice «Reabrir primero» y una recomendación ahí confunde.
          const suggested = route.recommended && enabled;
          return (
            <article
              key={route.key}
              className={cn(
                "flex min-h-36 flex-col rounded-lg p-4",
                STATUS_TONE[route.availability].bg,
                suggested ? "ring-2 ring-inset ring-brand-600" : STATUS_TONE[route.availability].ring,
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className={cn("text-sm font-semibold", route.availability === "blocked" ? "text-ink-600" : "text-ink-900")}>
                    {route.label}
                  </p>
                  <p className="mt-0.5 text-[13px] text-ink-500">{route.timing}</p>
                </div>
                {suggested && <Badge tone="brand">Sugerido</Badge>}
                {route.availability === "warning" && !suggested && <Badge tone="warn">Con aviso</Badge>}
              </div>
              {/* Nombrar la salida que bloquea, no solo decir que existe.
                  «No disponible» a secas obliga a bajar hasta «Salidas y guías»
                  para saber de cuál se habla, y en el panel del courier hay que
                  buscarla por su número. Con el número, el código corto y el
                  estado que el courier reporta, la tarjeta ya contesta las tres
                  preguntas que uno se hace ahí mismo. */}
              {route.blockingOutput && (
                // Un recuadro sin anillo: la tarjeta de la modalidad ya es el
                // marco, y otro anillo dentro sería un marco dentro de otro.
                <div
                  className={cn(
                    "mt-3 rounded-md px-3 py-2",
                    route.availability === "warning" ? "bg-white" : "bg-wash",
                  )}
                >
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-600">
                    <span className="font-semibold text-ink-700">
                      {shipmentIsReturning(route.blockingOutput) ? "Salida en devolución" : "Salida activa"}
                    </span>
                    {route.blockingOutput.guideCode && (
                      // `select-all`: el número se copia de un clic para pegarlo
                      // en el buscador del panel del courier, que es lo que se
                      // hace con él justo después de leerlo.
                      <span className="select-all font-mono font-semibold text-ink-900">
                        N° {route.blockingOutput.guideCode}
                      </span>
                    )}
                    {route.blockingOutput.shortCode && (
                      <span className="rounded bg-wash px-1.5 py-0.5 font-mono font-medium text-ink-700 ring-1 ring-inset ring-line">
                        {route.blockingOutput.shortCode}
                      </span>
                    )}
                  </p>
                  <p
                    className={cn(
                      "mt-0.5 text-xs",
                      shipmentIsReturning(route.blockingOutput) ? "font-medium text-warn-fg" : "text-ink-500",
                    )}
                  >
                    {shipmentStateLabel(route.blockingOutput)}
                  </p>
                </div>
              )}
              <p className={cn("mt-3 text-[13px] leading-5", route.availability === "blocked" ? "text-ink-500" : "text-ink-700")}>
                {route.reason}
              </p>
              {/* Antes de abrir Aliclik, lo que suele pasar con un pedido de
                  estos días. Solo si la tarjeta se puede tomar: en una
                  bloqueada o con salida activa la pregunta no está abierta. */}
              {route.action === "aliclik" && aliclikOutlook && enabled && !route.blockingOutput && (
                <AliclikOutlookLadder
                  outlook={aliclikOutlook}
                  storeName={storeName}
                  onWash={route.availability === "warning"}
                  className="mt-3"
                />
              )}
              <div className="flex-1" />
              <OpsButton
                size="sm"
                variant={suggested ? "primary" : "secondary"}
                disabled={!enabled}
                onClick={() => onSelect(route)}
                className="mt-4 self-start pointer-coarse:h-11"
              >
                {closed
                  ? "Reabrir primero"
                  : route.blockingOutput
                  ? "Ya tiene salida activa"
                  : route.availability === "blocked"
                  ? "No disponible"
                  : actionEnabled(route)
                    ? route.key === "propio"
                      ? "Ver en Grupo GF"
                      : ACTION_LABEL[route.action]
                    : "Sin permiso"}
              </OpsButton>
            </article>
          );
        })}
      </div>
    </section>
  );
}
