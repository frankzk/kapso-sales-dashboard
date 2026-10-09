// Entrega estimada de Aliclik según los días del pedido (09-10-2026), en el
// mundo de operación (DESIGN.md).
//
//   - `AliclikOutlookLadder`: dentro de la tarjeta de Aliclik de la mesa de
//     ruta. La cifra del pedido y la escalera de los cuatro tramos (hoy, 1 d,
//     2 d, 3+ d) con el suyo marcado: se ve el número y que esperar lo baja.
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

/** Alto de la barra más alta, en px. Las demás, en proporción desde cero. */
const BAR_MAX = 32;

export function AliclikOutlookLadder({
  outlook,
  storeName,
  onWash = false,
  className,
}: {
  outlook: AliclikOutlook;
  storeName?: string | null;
  /** La tarjeta ya está en un lavado (aviso): el recuadro va en blanco. */
  onWash?: boolean;
  className?: string;
}) {
  const tone = TONE[outlook.level];
  const tallest = Math.max(...outlook.steps.map((s) => s.rate ?? 0), 0.01);
  const badge = LEVEL_BADGE[outlook.level];
  return (
    // Un recuadro sin anillo, como el de la salida que bloquea: la tarjeta de
    // la modalidad ya es el marco.
    <div className={cn("rounded-md px-3 py-2.5", onWash ? "bg-white" : "bg-wash", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-ink-700">
            Entrega estimada
            {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
          </p>
          <p className="mt-0.5 text-xs text-ink-600">{outlookAgeLabel(outlook.ageDays)}</p>
        </div>
        <p className={cn("shrink-0 text-xl font-semibold leading-7 tabular-nums", tone.text)}>
          <span className="sr-only">Aliclik entrega cerca del </span>
          {outlookPercent(outlook.rate)}
        </p>
      </div>

      <ol aria-label="Entrega de Aliclik según los días del pedido" className="mt-2 grid grid-cols-4 gap-2">
        {outlook.steps.map((step) => {
          const current = step.bucket === outlook.bucket;
          const height = step.rate == null ? 0 : Math.max(3, Math.round((step.rate / tallest) * BAR_MAX));
          return (
            <li key={step.bucket} aria-current={current ? "true" : undefined} className="min-w-0 text-center">
              <div aria-hidden className="flex items-end justify-center border-b border-line-strong" style={{ height: BAR_MAX }}>
                <span
                  className={cn("block w-full max-w-9 rounded-t", current ? tone.bar : "bg-line-strong")}
                  style={{ height }}
                />
              </div>
              <p className={cn("mt-1 text-xs leading-4 tabular-nums", current ? cn("font-semibold", tone.text) : "text-ink-600")}>
                {step.rate == null ? "—" : outlookPercent(step.rate)}
              </p>
              <p className={cn("text-xs leading-4", current ? "font-semibold text-ink-900" : "text-ink-600")}>
                {outlookStepLabel(step.bucket)}
                {current && <span className="sr-only"> (este pedido)</span>}
              </p>
            </li>
          );
        })}
      </ol>

      <p className="mt-2 text-[13px] leading-5 text-ink-700">{outlookAdvice(outlook)}</p>
      {/* Sobre `wash`, el texto de apoyo va en `ink-600` (DESIGN.md, Cobro). */}
      <p className="mt-1 text-xs leading-4 text-ink-600">{outlookSource(outlook, storeName)}</p>
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
