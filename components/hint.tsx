"use client";

// Un ⓘ accesible con texto al pasar el ratón, al enfocar con el teclado y al
// tocar en el móvil. Sirve para que la primera vista de una pantalla no lleve
// párrafos de instrucciones: la explicación existe, pero se pide.
//
// Sin dependencias. El icono es un SVG inline (no un glifo: en iOS la «i»
// tipográfica no se pintaba y quedaba una píldora vacía). El panel va en
// `position: fixed` calculado desde el botón y acotado a la pantalla; en
// pantallas estrechas es una hoja inferior con botón «Cerrar».

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/components/ui";

const SHEET_BREAKPOINT = 640;
const PANEL_WIDTH = 320;
const MARGIN = 16;

export function Hint({
  text,
  label = "Más información",
  className,
  children,
}: {
  /** Lo que se explica. */
  text: ReactNode;
  /** Nombre accesible del icono. */
  label?: string;
  className?: string;
  /** Sustituye el ⓘ por otro disparador (p. ej. un icono de estado). */
  children?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const isSheet = window.innerWidth < SHEET_BREAKPOINT;
      setSheet(isSheet);
      if (isSheet) return;
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - MARGIN * 2);
      const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN));
      const below = r.bottom + 6;
      const fitsBelow = below + 160 <= window.innerHeight;
      setStyle(
        fitsBelow
          ? { position: "fixed", left, top: below, width }
          : { position: "fixed", left, bottom: window.innerHeight - r.top + 6, width },
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <span ref={root} className={cn("relative inline-flex", className)}>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => { if (!sheet) setOpen(false); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (!sheet) setOpen(false); }}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full leading-none text-slate-400 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
          children ? "" : "h-5 w-5 border border-slate-300",
        )}
      >
        {children ?? (
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="8" cy="8" r="6.25" />
            <path d="M8 7.2v4" />
            <circle cx="8" cy="4.9" r="0.6" fill="currentColor" stroke="none" />
          </svg>
        )}
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          style={sheet ? undefined : style}
          className={cn(
            "z-50 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-xs font-normal leading-5 text-slate-700 shadow-lg",
            sheet && "fixed inset-x-4 bottom-4 flex flex-col gap-2 rounded-2xl px-4 py-3 text-sm",
          )}
        >
          <span>{text}</span>
          {sheet && (
            <button type="button" onClick={() => setOpen(false)} className="min-h-10 self-end rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700">
              Cerrar
            </button>
          )}
        </span>
      )}
    </span>
  );
}
