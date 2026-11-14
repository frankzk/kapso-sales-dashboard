// Piezas de Compras en el mundo de operación (DESIGN.md) que también usan las
// páginas de servidor: el título de la página, el estado vacío, el tono de la
// chapa de cada estado de una importación y el marco de cifras. Sin
// "use client": una función exportada desde un módulo de cliente llega al
// servidor como referencia y llamarla falla (ver components/ops-styles.ts).

import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import type { ImportStatus } from "@/lib/compras";

// ---------------------------------------------------------------------------
// La lista: sus filtros viven en la URL
// ---------------------------------------------------------------------------

export type ImportAlertFilter = "avisar" | "atrasadas" | "sin_novedades";

export const IMPORT_ALERT_FILTERS: { id: ImportAlertFilter; label: string; hint: string }[] = [
  { id: "avisar", label: "Sin avisar a la bodega", hint: "La llegada estimada está a 3 días o menos y la bodega de Lima no está avisada" },
  { id: "atrasadas", label: "Atrasadas", hint: "La llegada estimada ya pasó y todavía no llega" },
  { id: "sin_novedades", label: "Sin novedades", hint: "Viajan y llevan 7 días o más sin un cambio de estado ni una nota" },
];

/** La URL de la lista con lo que cambia; lo demás se conserva. */
export function comprasListHref(q: { tab: string; org?: string | null; proveedor?: string | null; alerta?: string | null }): string {
  const p = new URLSearchParams({ v: q.tab });
  if (q.org) p.set("org", q.org);
  if (q.proveedor) p.set("proveedor", q.proveedor);
  if (q.alerta) p.set("alerta", q.alerta);
  return `/dashboard/compras?${p.toString()}`;
}

/**
 * El tono de la chapa de un estado (MOM §45): no cambia el estado, solo cómo
 * se lee. En curso en `info`; ya en la bodega en `ok`; la cotización, lo
 * cerrado y lo cancelado en neutro (no piden a nadie que actúe).
 */
export function importStatusTone(status: ImportStatus): "neutral" | "info" | "ok" {
  if (status === "recibido" || status === "ingresado") return "ok";
  if (status === "cotizacion" || status === "cerrado" || status === "cancelado") return "neutral";
  return "info";
}

/** Título de 28 px y su contexto en 14 px `ink-500` (The Título Solo Rule); a la derecha, la acción. */
export function ComprasHeader({ title, children, actions }: { title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">{title}</h1>
        {children && <div className="mt-1 max-w-[68ch] text-pretty text-sm text-ink-500">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** El estado vacío: dice qué significa estar vacío y, si se puede, el primer paso. */
export function ComprasEmpty({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-1.5 px-4 py-12 text-center", className)}>
      <p className="text-sm font-semibold text-ink-900">{title}</p>
      {children && <div className="max-w-[52ch] text-pretty text-[13px] leading-5 text-ink-500">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** La página sin acceso: una tarjeta blanca sobre el lienzo con el porqué. */
export function ComprasGate({ title, emptyTitle = "Sin acceso", action, children }: { title: string; emptyTitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <ComprasHeader title={title} />
      <div className="rounded-lg bg-white shadow-control ring-1 ring-line">
        <ComprasEmpty title={emptyTitle} action={action}>
          {children}
        </ComprasEmpty>
      </div>
    </div>
  );
}

/**
 * Marco de cifras: un dato con celdas separadas por hairlines, no una caja de
 * contenido (DESIGN.md › Cards). Dos columnas en el teléfono, `cols` desde `lg`.
 */
export function FigureFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        // Las hairlines salen del hueco de 1 px sobre el fondo `line`: con
        // cualquier número de celdas, ninguna línea queda doble ni suelta.
        "grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line shadow-control ring-1 ring-line",
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function FigureCell({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** El tono de la línea de abajo: lo que pide atención. */
  tone?: "warn" | "crit" | "ok";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 bg-white px-4 py-3", className)}>
      <dt className="truncate text-[13px] font-medium leading-5 text-ink-600">{label}</dt>
      <dd className="mt-0.5 truncate text-xl font-semibold leading-7 tabular-nums text-ink-900">{value}</dd>
      {sub && (
        <dd
          className={cn(
            "mt-0.5 text-[13px] leading-5 tabular-nums",
            tone === "crit" ? "font-medium text-crit-fg" : tone === "warn" ? "font-medium text-warn-fg" : tone === "ok" ? "text-ok-fg" : "text-ink-500",
          )}
        >
          {sub}
        </dd>
      )}
    </div>
  );
}
