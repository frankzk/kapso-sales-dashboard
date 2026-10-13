"use client";

// La rejilla de módulos de Consolidado (DESIGN.md › Consolidado): cada análisis
// reducido a su cifra y un gráfico de bolsillo, en celdas blancas sobre
// hairlines agrupadas por pregunta. Tocar una celda abre el módulo entero en
// un panel lateral; al cerrarlo, el tablero sigue ahí. Las celdas no cambian de
// sitio con el periodo: un módulo sin datos lo dice en su celda en vez de
// desaparecer, así la vista se aprende de memoria.

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { SidePanel } from "@/components/ops-ui";
import { IconChevronRight } from "@/components/icons";

export interface ModulePanel {
  title: string;
  meta?: ReactNode;
  /** Ancho máximo de la hoja (`max-w-[...]`), según lo que lleva dentro. */
  width?: string;
  body: ReactNode;
}

export interface ModuleCell {
  id: string;
  title: string;
  figure: ReactNode;
  /** El tono de la cifra cuando dice un estado (nunca para adornar). */
  tone?: "ok" | "warn" | "crit" | "muted";
  sub?: ReactNode;
  glyph?: ReactNode;
  /** Sin panel la celda se lee pero no abre nada: no hay datos que auditar. */
  panel?: ModulePanel | null;
}

export interface ModuleGroup {
  id: string;
  label: string;
  cells: ModuleCell[];
}

const TONE: Record<NonNullable<ModuleCell["tone"]>, string> = {
  ok: "text-ok-fg",
  warn: "text-warn-fg",
  crit: "text-crit-fg",
  muted: "text-ink-500",
};

/** Columnas desde 1280 px: tantas como celdas tenga el grupo (literales para Tailwind). */
const XL_COLS: Record<number, string> = {
  1: "xl:grid-cols-1",
  2: "xl:grid-cols-2",
  3: "xl:grid-cols-3",
  4: "xl:grid-cols-4",
  5: "xl:grid-cols-5",
};

const CELL = "group flex min-w-0 flex-col bg-white px-4 py-3 text-left";
/** Con gráfico, la celda reserva su alto; sin datos, se queda en lo que dice. */
const CELL_TALL = "md:min-h-[172px]";

function CellBody({ cell, interactive }: { cell: ModuleCell; interactive: boolean }) {
  return (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-[13px] font-medium leading-5 text-ink-600">{cell.title}</span>
        {interactive && (
          <IconChevronRight
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-ink-300 transition-[color,transform] group-hover:translate-x-0.5 group-hover:text-ink-600"
          />
        )}
      </span>
      <span className={cn("mt-0.5 block truncate text-xl font-semibold leading-7 tabular-nums", cell.tone ? TONE[cell.tone] : "text-ink-900")}>
        {cell.figure}
      </span>
      {cell.sub && <span className="mt-0.5 block text-pretty text-xs leading-4 text-ink-500">{cell.sub}</span>}
      {cell.glyph && <span className="mt-auto block w-full pt-3">{cell.glyph}</span>}
    </>
  );
}

export function ModuleBoard({ groups }: { groups: ModuleGroup[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? groups.flatMap((g) => g.cells).find((c) => c.id === openId) : null;

  // Escape cierra el panel, como en Productividad. Un campo que ya usó la
  // tecla (la búsqueda de producto de Anuncios cierra su lista) la marca.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => {
        const n = group.cells.length;
        return (
          <section key={group.id} aria-labelledby={`grupo-${group.id}`}>
            <h3 id={`grupo-${group.id}`} className="mb-2 text-xs font-semibold leading-4 text-ink-500">
              {group.label}
            </h3>
            <div
              className={cn(
                "grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-line shadow-control ring-1 ring-line md:grid-cols-2",
                XL_COLS[n] ?? "xl:grid-cols-4",
              )}
            >
              {group.cells.map((cell, i) => {
                // Con dos columnas, una celda impar al final ocupa la fila entera:
                // sin eso el marco dejaba un hueco gris.
                const fill = cn(i === n - 1 && n % 2 === 1 && "md:col-span-2 xl:col-span-1", cell.glyph ? CELL_TALL : null);
                return cell.panel ? (
                  <button
                    key={cell.id}
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => setOpenId(cell.id)}
                    // El anillo va por dentro: el marco recorta lo de fuera.
                    style={{ outline: "none" }}
                    className={cn(
                      CELL,
                      fill,
                      "cursor-pointer transition-colors hover:bg-wash focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
                    )}
                  >
                    <CellBody cell={cell} interactive />
                  </button>
                ) : (
                  <div key={cell.id} className={cn(CELL, fill)}>
                    <CellBody cell={cell} interactive={false} />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {open?.panel && (
        <SidePanel
          label={open.panel.title}
          title={open.panel.title}
          meta={open.panel.meta}
          width={open.panel.width ?? "max-w-[720px]"}
          onClose={() => setOpenId(null)}
        >
          {open.panel.body}
        </SidePanel>
      )}
    </div>
  );
}
