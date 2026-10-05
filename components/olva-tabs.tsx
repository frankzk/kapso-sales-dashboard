// «Cotejar Olva» (MOM §12): título y pestañas. El cotejo del portal y los
// rótulos que llegan por correo son dos caminos al mismo tracking; cada uno en
// su pestaña, con el contexto de la que está abierta bajo el título.

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/ui";

export type OlvaView = "cotejo" | "correos";

const TABS: { id: OlvaView; label: string; href: string }[] = [
  { id: "cotejo", label: "Cotejo del portal", href: "/dashboard/olva" },
  // Cada rótulo que llegó del buzón y si encontró su pedido.
  { id: "correos", label: "Correos de Olva", href: "/dashboard/olva?vista=correos" },
];

export function OlvaPage({ active, description, children }: { active: OlvaView; description: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Cotejar Olva</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-500">{description}</p>
      </header>
      <nav aria-label="Vistas de Cotejar Olva" className="grid grid-cols-2 gap-1 border-b border-line sm:flex sm:gap-6">
        {TABS.map((tab) => {
          const on = tab.id === active;
          return (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={on ? "page" : undefined}
              className={cn(
                "relative flex min-h-12 min-w-0 items-center justify-center px-1 text-[13px] font-semibold transition-colors duration-150 sm:px-0 lg:text-sm",
                on ? "text-brand-700" : "text-ink-500 hover:text-ink-900",
              )}
            >
              <span className="truncate">{tab.label}</span>
              {on && <span aria-hidden className="absolute inset-x-1 bottom-[-1px] h-0.5 bg-brand-600 sm:inset-x-0" />}
            </Link>
          );
        })}
      </nav>
      <div className="pt-2">{children}</div>
    </div>
  );
}
