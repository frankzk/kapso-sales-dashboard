"use client";

// La mesa de ruta de la ficha del pedido, en el mundo de operación (DESIGN.md):
// una sección con su título, los bloqueos y avisos como avisos de página, la
// modalidad sugerida destacada sola (anillo azul, chapa y botón principal) y,
// debajo, «Otras opciones» en una lista de filas (13-11-2026, owner eligió «B»).

import { useId, useState } from "react";
import { cn } from "@/components/ui";
import { GuideNumber } from "@/components/guide-number";
import { IconChevronDown } from "@/components/icons";
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

// El fondo de la fila por disponibilidad. La sugerida no es una fila: va sola,
// arriba, con su anillo, su chapa «Sugerido» y el botón principal.
const ROW_TONE = {
  available: "",
  warning: "bg-warn-wash",
  blocked: "bg-wash",
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
  onRegisterShalom,
  aliclikOutlook,
  storeName,
  groupGf,
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
  /** Opens registration of an existing guide, independently of creation. */
  onRegisterShalom?: () => void;
  /** Cuántas guías de Aliclik se entregan según los días del pedido (09-10-2026). */
  aliclikOutlook?: AliclikOutlook | null;
  storeName?: string | null;
  /**
   * Grupo GF en un no entregado de Lima (MOM §28, 06-11-2026, owner con
   * #KP200684: «¿por qué no estaría dentro de Grupo GF Courier?»). Grupo GF no
   * tiene guía propia: imprimir el rótulo de la salida nueva ES preparar su
   * salida, así que la acción vive en su tarjeta y no solo en «Salidas y
   * guías». Antes «Ver en Grupo GF» llevaba a Despacho del día, donde el pedido
   * no aparecía hasta tener esa salida.
   *
   * `printNew`: todavía no hay salida nueva; imprimir su rótulo la crea.
   * `ready`: la «por definir» ya rotulada, que Grupo GF toma con su mismo QR.
   */
  groupGf?: {
    printNew?: { onPrint: () => void; pending: boolean } | null;
    ready?: { outputCode: string | null; labelHref: string } | null;
  };
}) {
  const blockers = gate?.blockers ?? [];
  const blockedActions = new Set(gate?.blockedActions ?? []);
  const [showRare, setShowRare] = useState(false);
  const uid = useId();
  // Lo que decide cada modalidad, para la destacada y para las filas.
  const stateOf = (route: RouteCandidate) => {
    // Por MODALIDAD, no por pedido: con el pedido cerrado, Tanders y
    // Shalom se niegan siempre, la salida manual solo si no se cerró por
    // una entrega fallida, y Aliclik y Swayp ni miran el estado. Ver
    // `routeDeskGate`.
    const closed = blockedActions.has(route.action);
    const enabled = !closed && route.availability !== "blocked" && actionEnabled(route);
    // «Sugerido» solo cuando se puede tomar: con el pedido cerrado la
    // tarjeta dice «Reabrir primero» y una recomendación ahí confunde.
    const suggested = route.recommended && enabled;
    // Grupo GF en un no entregado de Lima: primero el rótulo de la salida
    // nueva, que es lo que Almacén pega en la caja. Lo permite editar el
    // pedido, no el permiso de Despacho GF, así que no depende de `enabled`.
    const gfPrint = route.key === "propio" && !closed && route.availability !== "blocked" ? groupGf?.printNew ?? null : null;
    const gfReady = route.key === "propio" && !gfPrint ? groupGf?.ready ?? null : null;
    return { closed, enabled, suggested, gfPrint, gfReady };
  };

  // El cuerpo de una modalidad: cuándo sale, la salida que la bloquea, el
  // motivo, lo de Grupo GF y la escalera de Aliclik. Igual en la destacada y en
  // las filas: «más acotado sin ocultar la información» (owner, 13-11-2026).
  const renderDetails = (route: RouteCandidate) => {
    const { enabled, suggested, gfPrint, gfReady } = stateOf(route);
    return (
      <>
        {/* Nombrar la salida que bloquea, no solo decir que existe: número,
            código corto y el estado que reporta el courier, en una línea. */}
        {route.blockingOutput && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-600">
            <span className="font-semibold text-ink-700">
              {shipmentIsReturning(route.blockingOutput) ? "Salida en devolución" : "Salida activa"}
            </span>
            {route.blockingOutput.guideCode && <GuideNumber value={route.blockingOutput.guideCode} />}
            {route.blockingOutput.shortCode && (
              <span className="rounded bg-white px-1.5 py-0.5 font-mono font-medium text-ink-700 ring-1 ring-inset ring-line">
                {route.blockingOutput.shortCode}
              </span>
            )}
            <span className={shipmentIsReturning(route.blockingOutput) ? "font-medium text-warn-fg" : "text-ink-500"}>
              · {shipmentStateLabel(route.blockingOutput)}
            </span>
          </p>
        )}
        <p className={cn("mt-1 text-[13px] leading-5", route.availability === "blocked" ? "text-ink-600" : "text-ink-700")}>
          {route.reason}
        </p>
        {gfPrint && (
          <p className="mt-1 text-[13px] leading-5 text-ink-600">
            Primero el rótulo: crea la salida nueva, Almacén la arma desde stock y en Despacho del día se asigna al
            motorizado.
          </p>
        )}
        {gfReady && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-600">
            <span className="font-semibold text-ink-700">Salida lista</span>
            {gfReady.outputCode && (
              <span className="rounded bg-white px-1.5 py-0.5 font-mono font-medium text-ink-700 ring-1 ring-inset ring-line">
                {gfReady.outputCode}
              </span>
            )}
            <a href={gfReady.labelHref} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
              Reimprimir rótulo
            </a>
            <span className="text-ink-600">· Almacén la arma; en Despacho del día se asigna al motorizado con su mismo QR.</span>
          </p>
        )}
        {/* Antes de abrir Aliclik, lo que suele pasar con un pedido de
            estos días. Solo si la modalidad se puede tomar: en una
            bloqueada o con salida activa la pregunta no está abierta. */}
        {route.action === "aliclik" && aliclikOutlook && enabled && !route.blockingOutput && (
          <AliclikOutlookLadder
            outlook={aliclikOutlook}
            storeName={storeName}
            onWash={route.availability === "warning" && !suggested}
            bare={route.availability !== "warning" || suggested}
            className="mt-2.5"
          />
        )}
      </>
    );
  };

  // Los botones, a la derecha en escritorio y debajo en el teléfono.
  const renderActions = (route: RouteCandidate) => {
    const { closed, enabled, suggested, gfPrint } = stateOf(route);
    return (
      <div className="flex shrink-0 flex-wrap gap-2 sm:max-w-[16rem] sm:flex-col sm:items-end">
        {gfPrint ? (
          <OpsButton
            size="sm"
            variant={route.recommended ? "primary" : "secondary"}
            disabled={gfPrint.pending}
            onClick={gfPrint.onPrint}
            className="pointer-coarse:h-11"
          >
            Imprimir rótulo de la salida nueva
          </OpsButton>
        ) : (
          <OpsButton
            size="sm"
            variant={suggested ? "primary" : "secondary"}
            disabled={!enabled}
            onClick={() => onSelect(route)}
            className="pointer-coarse:h-11"
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
        )}
        {route.action === "shalom" && route.canRegisterShalomReplacement && onRegisterShalom && (
          <OpsButton
            size="sm"
            variant="ghost"
            disabled={closed || !actionEnabled(route)}
            onClick={onRegisterShalom}
            className="pointer-coarse:h-11"
          >
            Ya la creé en Shalom Pro
          </OpsButton>
        )}
      </div>
    );
  };

  // La sugerida, sola y arriba: lo único con anillo azul en la mesa.
  const renderFeatured = (route: RouteCandidate) => (
    <article aria-label={`Sugerido: ${route.label}`} className="rounded-lg bg-white p-4 ring-2 ring-brand-600">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* Azul sólido = lo que toca, igual que «Ahora» en Situación. */}
            <span className="inline-flex h-5 items-center rounded bg-brand-600 px-1.5 text-xs font-semibold leading-none text-white">
              Sugerido
            </span>
            <h3 className="text-base font-semibold leading-6 text-ink-900">{route.label}</h3>
            <span className="text-[13px] text-ink-600">{route.timing}</span>
          </div>
          {renderDetails(route)}
        </div>
        {renderActions(route)}
      </div>
    </article>
  );

  // Las demás, una fila cada una: nombre, cuándo sale, chapas y motivo.
  const renderRow = (route: RouteCandidate) => (
    <li key={route.key} className={cn("px-4 py-3", ROW_TONE[route.availability])}>
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className={cn("text-sm font-semibold", route.availability === "blocked" ? "text-ink-700" : "text-ink-900")}>
              {route.label}
            </p>
            <span className="text-[13px] text-ink-600">{route.timing}</span>
            {route.availability === "warning" && <Badge tone="warn">Con aviso</Badge>}
          </div>
          {renderDetails(route)}
        </div>
        {renderActions(route)}
      </div>
    </li>
  );

  // Lo que casi no se usa (Axel, Urpi) va plegado al pie y nunca se sugiere
  // (09-10-2026). Se abre solo si una de esas tarjetas tiene algo que decir:
  // una salida viva suya, para que no quede escondida.
  const main = plan.candidates.filter((route) => !route.rarelyUsed);
  const rare = plan.candidates.filter((route) => route.rarelyUsed);
  const rareOpen = showRare || rare.some((route) => Boolean(route.blockingOutput) || route.recommended);
  // La destacada es la sugerida que se puede tomar; sin ella, todas en la lista.
  const featured = main.find((route) => stateOf(route).suggested) ?? null;
  const others = main.filter((route) => route !== featured);

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

      {featured && renderFeatured(featured)}

      {(others.length > 0 || rare.length > 0) && (
        <div className="space-y-2">
          {featured && <h3 className="pt-1 text-[13px] font-semibold leading-5 text-ink-700">Otras opciones</h3>}
          <ul className="divide-y divide-line overflow-hidden rounded-lg ring-1 ring-inset ring-line">
            {others.map(renderRow)}
            {/* Lo que casi no se usa, plegado como la última fila. */}
            {rare.length > 0 && (
              <li>
                <button
                  type="button"
                  onClick={() => setShowRare((open) => !open)}
                  aria-expanded={rareOpen}
                  aria-controls={`${uid}-otros`}
                  className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors hover:bg-wash pointer-coarse:min-h-11"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold leading-5 text-ink-900">Otros couriers</span>
                    <span className="mt-0.5 block text-[13px] leading-5 text-ink-600">
                      {rare.map((route) => route.label).join(", ")} · casi no se usan; no se sugieren.
                    </span>
                  </span>
                  <IconChevronDown
                    aria-hidden
                    className={cn("size-4 shrink-0 text-ink-500 transition-transform motion-reduce:transition-none", rareOpen && "rotate-180")}
                  />
                </button>
                {rareOpen && (
                  <ul id={`${uid}-otros`} className="divide-y divide-line border-t border-line">
                    {rare.map(renderRow)}
                  </ul>
                )}
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
