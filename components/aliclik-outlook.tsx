// Entrega estimada de Aliclik según los días del pedido (09-10-2026), en el
// mundo de operación (DESIGN.md).
//
//   - `AliclikOutlookLadder`: dentro de la fila de Aliclik de la mesa de
//     ruta. La cifra del pedido y la escalera de los cuatro tramos (hoy, 1 d,
//     2 d, 3+ d) con el suyo marcado, en una franja: se ve el número y que
//     esperar lo baja.
//   - `AliclikOutlookBanner`: en «Crear guía en Aliclik», solo si la entrega
//     es baja. Es el último momento antes de una escritura que no se deshace.
//
// Es un aviso: no bloquea ni cambia la ruta sugerida.

import { Badge, Banner } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import {
  outlookAdvice,
  outlookAgeLabel,
  outlookFact,
  outlookPercent,
  outlookSource,
  outlookStepLabel,
  outlookTitle,
  type AliclikOutlook,
  type OutlookLevel,
} from "@/lib/aliclik-outlook";

/** La cifra y la barra del pedido en el tono de su nivel; el resto de la escalera en gris. */
const TONE: Record<OutlookLevel, { text: string; bar: string }> = {
  normal: { text: "text-ink-900", bar: "bg-ink-900" },
  baja: { text: "text-warn-fg", bar: "bg-warn-fg" },
  muy_baja: { text: "text-crit-fg", bar: "bg-crit-fg" },
};

/** La palabra junto a la cifra, en el mismo tono (DESIGN.md, Tono Emparejado). */
const LEVEL_BADGE: Partial<Record<OutlookLevel, { tone: "warn" | "crit"; label: string }>> = {
  baja: { tone: "warn", label: "Baja" },
  muy_baja: { tone: "crit", label: "Muy baja" },
};

/** Alto de la barra más alta, en px: una línea de texto. Las demás, en proporción desde cero. */
const BAR_MAX = 16;

/**
 * La escalera en UNA franja (13-11-2026, owner: «ocupan demasiado espacio»):
 * la cifra del pedido y su edad a la izquierda; los cuatro tramos (hoy, 1 d,
 * 2 d, 3+ d) en barras de una línea con su porcentaje, el del pedido en su
 * tono; debajo, el consejo y la fuente. Los mismos datos que el gráfico de
 * antes, en un tercio del alto.
 */
export function AliclikOutlookLadder({
  outlook,
  storeName,
  onWash = false,
  bare = false,
  className,
}: {
  outlook: AliclikOutlook;
  storeName?: string | null;
  /** La fila ya está en un lavado (aviso o sugerida): el recuadro va en blanco. */
  onWash?: boolean;
  /**
   * Sin recuadro: la fila blanca ya es el marco y una caja gris dentro de una
   * lista dentro de una tarjeta era una caja de más (owner, 13-11-2026: «me
   * pierdo un poco visualmente»).
   */
  bare?: boolean;
  className?: string;
}) {
  const tone = TONE[outlook.level];
  const tallest = Math.max(...outlook.steps.map((s) => s.rate ?? 0), 0.01);
  const badge = LEVEL_BADGE[outlook.level];
  return (
    // Un recuadro sin anillo, como la salida que bloquea: la fila ya es el marco.
    <div className={cn(bare ? "" : cn("rounded-md px-3 py-2", onWash ? "bg-white" : "bg-wash"), className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs text-ink-600">
          <span className="font-semibold text-ink-700">Entrega estimada</span>
          <span className={cn("text-base font-semibold leading-5 tabular-nums", tone.text)}>
            <span className="sr-only">Aliclik entrega cerca del </span>
            {outlookPercent(outlook.rate)}
          </span>
          <span>· {outlookAgeLabel(outlook.ageDays)}</span>
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        </p>
        <ol aria-label="Entrega de Aliclik según los días del pedido" className="flex flex-wrap items-end gap-x-3 gap-y-1">
          {outlook.steps.map((step) => {
            const current = step.bucket === outlook.bucket;
            const height = step.rate == null ? 0 : Math.max(2, Math.round((step.rate / tallest) * BAR_MAX));
            return (
              <li key={step.bucket} aria-current={current ? "true" : undefined} className="flex items-end gap-1 whitespace-nowrap">
                <span aria-hidden className="flex items-end" style={{ height: BAR_MAX }}>
                  <span className={cn("block w-1.5 rounded-sm", current ? tone.bar : "bg-line-strong")} style={{ height }} />
                </span>
                <span className={cn("text-xs leading-4 tabular-nums", current ? cn("font-semibold", tone.text) : "text-ink-600")}>
                  {step.rate == null ? "—" : outlookPercent(step.rate)}{" "}
                  <span className={current ? "text-ink-900" : "text-ink-500"}>{outlookStepLabel(step.bucket)}</span>
                  {current && <span className="sr-only"> (este pedido)</span>}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {/* Sobre `wash`, el texto de apoyo va en `ink-600` (DESIGN.md, Cobro). */}
      <p className="mt-1.5 text-xs leading-4 text-ink-700">
        {outlookAdvice(outlook)} <span className="text-ink-600">{outlookSource(outlook, storeName)}</span>
      </p>
    </div>
  );
}

/** Solo con entrega baja: el aviso antes de crear la guía. */
export function AliclikOutlookBanner({
  outlook,
  storeName,
  className,
}: {
  outlook: AliclikOutlook | null | undefined;
  storeName?: string | null;
  className?: string;
}) {
  if (!outlook || outlook.level === "normal") return null;
  return (
    <Banner tone="warn" title={outlookTitle(outlook)} className={className}>
      <p>
        {outlookFact(outlook)} {outlookAdvice(outlook)}
      </p>
      <p className="mt-1 text-xs text-ink-600">{outlookSource(outlook, storeName)}</p>
    </Banner>
  );
}
