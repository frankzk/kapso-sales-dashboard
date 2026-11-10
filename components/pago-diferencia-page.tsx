// «Pago de diferencia» (MOM §44): título y vistas. La bandeja de cobro y,
// desde el 10-11-2026 (owner: «mudarla entera»), «Cotejar Olva» con sus dos
// caminos al tracking: sin tracking, un pedido de Olva no llega a la bandeja.
//
// Las vistas son pestañas subrayadas con enlace (DESIGN.md › Navigation); los
// grupos de la bandeja van debajo en control segmentado, para que no se lean
// como una segunda fila de pestañas.

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ops-ui";
import { cn } from "@/components/ui";

export type PagoDiferenciaView = "bandeja" | "olva" | "correos";

export const PAGO_DIFERENCIA_PATH = "/dashboard/pedidos/pago-diferencia";

/** La vista pedida en la URL; la bandeja si no se entiende. */
export function pagoDiferenciaView(raw: string | undefined): PagoDiferenciaView {
  return raw === "olva" || raw === "correos" ? raw : "bandeja";
}

/** `short`: la etiqueta del teléfono, donde las tres van en una fila. */
const VIEWS: { id: PagoDiferenciaView; label: string; short: string; href: string }[] = [
  { id: "bandeja", label: "Bandeja", short: "Bandeja", href: PAGO_DIFERENCIA_PATH },
  { id: "olva", label: "Cotejar Olva", short: "Cotejar Olva", href: `${PAGO_DIFERENCIA_PATH}?vista=olva` },
  { id: "correos", label: "Correos de Olva", short: "Correos", href: `${PAGO_DIFERENCIA_PATH}?vista=correos` },
];

export function PagoDiferenciaPage({
  active,
  description,
  counts,
  children,
}: {
  active: PagoDiferenciaView;
  description: ReactNode;
  /** El número de cada pestaña, si lo tiene: pedidos en la bandeja, envíos de Olva sin vincular. */
  counts: Partial<Record<PagoDiferenciaView, number>>;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Pago de diferencia</h1>
        <p className="mt-1 max-w-[72ch] text-sm leading-6 text-ink-600">{description}</p>
      </header>
      <nav aria-label="Vistas de Pago de diferencia" className="grid grid-cols-3 gap-1 border-b border-line sm:flex sm:gap-6">
        {VIEWS.map((view) => {
          const on = view.id === active;
          const count = counts[view.id];
          // Olva sin vincular espera a una persona: su número va en ámbar.
          const tone = on ? "brand" : view.id === "olva" && count ? "warn" : "neutral";
          return (
            <Link
              key={view.id}
              href={view.href}
              aria-current={on ? "page" : undefined}
              className={cn(
                "relative flex min-h-12 min-w-0 items-center justify-center gap-2 px-1 text-[13px] font-semibold transition-colors duration-150 sm:px-0 lg:text-sm",
                on ? "text-brand-700" : "text-ink-500 hover:text-ink-900",
              )}
            >
              <span className="truncate sm:hidden">{view.short}</span>
              <span className="hidden truncate sm:inline">{view.label}</span>
              {count !== undefined && count > 0 && (
                <>
                  {/* En el teléfono solo la activa dice su número, como texto (DESIGN.md). */}
                  <span className="hidden sm:inline-flex">
                    <Badge tone={tone}>{count.toLocaleString("es-PE")}</Badge>
                  </span>
                  {on && <span className="tabular-nums sm:hidden">{count.toLocaleString("es-PE")}</span>}
                  {!on && view.id === "olva" && (
                    <>
                      <span aria-hidden className="size-1.5 rounded-full bg-warn-fg sm:hidden" />
                      <span className="sr-only sm:hidden">{`, ${count} sin vincular`}</span>
                    </>
                  )}
                </>
              )}
              {on && <span aria-hidden className="absolute inset-x-1 bottom-[-1px] h-0.5 bg-brand-600 sm:inset-x-0" />}
            </Link>
          );
        })}
      </nav>
      <div className="pt-2">{children}</div>
    </div>
  );
}
