"use client";

// El popover de filtros y sus chips, compartidos por Despacho del día y por
// la lista de Rutas de Grupo GF Courier: un mismo picker en las dos pantallas.

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/components/ui";

export function Sheet({ title, onClose, children, anchored = false, wide = false }: { title: string; onClose: () => void; children: ReactNode; anchored?: boolean; wide?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => { if (root.current && !root.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [onClose]);
  return (
    <div
      ref={root}
      role="dialog"
      aria-label={title}
      className={cn(
        "fixed inset-x-3 bottom-3 z-50 max-h-[80vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-xl",
        // El popover tiene ancho fijo; sin `overflow-x-hidden` y sin `min-w-0`
        // en los campos, un <select> con una opción larga se salía por la derecha.
        "overflow-x-hidden sm:max-w-[calc(100vw-2rem)]",
        anchored ? "sm:absolute sm:inset-auto sm:left-0 sm:top-full sm:mt-1 sm:w-80" : cn("sm:left-1/2 sm:top-24 sm:bottom-auto sm:right-auto sm:-translate-x-1/2", wide ? "sm:w-[42rem]" : "sm:w-96"),
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <button type="button" onClick={onClose} aria-label="Cerrar" className="min-h-8 rounded-lg px-2 text-sm text-slate-500 hover:bg-slate-100">×</button>
      </div>
      {children}
    </div>
  );
}

export function Chip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <li className="flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-800">
      {children}
      <button type="button" onClick={onRemove} aria-label="Quitar filtro" className="min-h-0 p-0 text-brand-500 hover:text-brand-900">×</button>
    </li>
  );
}

