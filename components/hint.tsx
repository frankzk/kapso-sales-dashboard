"use client";

// Un ⓘ accesible con texto al pasar el ratón, al enfocar con el teclado y al
// tocar en el móvil. Sirve para que la primera vista de una pantalla no lleve
// párrafos de instrucciones: la explicación existe, pero se pide.
//
// Sin dependencias: es un botón con `aria-describedby` y un panel absoluto.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";

export function Hint({
  text,
  label = "Más información",
  className,
  align = "left",
  children,
}: {
  /** Lo que se explica. */
  text: ReactNode;
  /** Nombre accesible del icono. */
  label?: string;
  className?: string;
  align?: "left" | "right";
  /** Sustituye el ⓘ por otro disparador (p. ej. un número). */
  children?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

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
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={cn(
          "inline-flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
          children ? "" : "size-5 border border-slate-300 text-[11px] font-semibold leading-none",
        )}
      >
        {children ?? "i"}
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            "absolute top-full z-30 mt-1 w-64 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-xs font-normal leading-5 text-slate-700 shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {text}
        </span>
      )}
    </span>
  );
}
