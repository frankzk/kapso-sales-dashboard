"use client";

// El popover de filtros y sus chips, compartidos por Despacho del día y por
// la lista de Rutas de Grupo GF Courier: un mismo picker en las dos pantallas.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui";

const SHEET_BREAKPOINT = 640;
const ANCHORED_WIDTH = 360;
const MARGIN = 12;

export function Sheet({ title, onClose, children, anchored = false, wide = false, anchorRef }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pegado bajo el botón que lo abre (`anchorRef`, o el padre del popover). */
  anchored?: boolean;
  wide?: boolean;
  /** El botón que abre el popover: manda la posición y sus clics no lo cierran. */
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const root = useRef<HTMLDivElement>(null);
  // Anclado en escritorio: el popover vive en document.body (portal) con
  // `position: fixed` calculado desde el botón y acotado a la pantalla. Antes
  // era `absolute` dentro de la tarjeta de Asignar, que recorta con
  // `overflow-hidden`: el picker se cortaba por abajo y no había forma de
  // desplazarse hasta «Quitar filtros». En pantallas estrechas sigue siendo
  // una hoja inferior.
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!anchored) return;
    const place = () => {
      const anchor = anchorRef?.current ?? root.current?.parentElement;
      if (window.innerWidth < SHEET_BREAKPOINT || !anchor) { setStyle(null); return; }
      const r = anchor.getBoundingClientRect();
      const width = Math.min(ANCHORED_WIDTH, window.innerWidth - MARGIN * 2);
      const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN));
      const below = r.bottom + 4;
      const spaceBelow = window.innerHeight - below - MARGIN;
      const spaceAbove = r.top - 4 - MARGIN;
      // Cabe debajo salvo que quede muy poco sitio y arriba haya más.
      const fitsBelow = spaceBelow >= 280 || spaceBelow >= spaceAbove;
      setStyle(
        fitsBelow
          ? { position: "fixed", left, top: below, right: "auto", bottom: "auto", width, maxHeight: Math.max(160, spaceBelow) }
          : { position: "fixed", left, bottom: window.innerHeight - r.top + 4, top: "auto", right: "auto", width, maxHeight: Math.max(160, spaceAbove) },
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchored, anchorRef]);

  useEffect(() => {
    const close = (e: Event) => {
      const t = e.target as Node;
      if (root.current && root.current.contains(t)) return;
      // El clic en el propio botón lo gestiona su `onClick` (alterna): si aquí
      // también cerráramos, el botón lo volvería a abrir en el mismo gesto.
      if (anchorRef?.current && anchorRef.current.contains(t)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [onClose, anchorRef]);

  const panel = (
    <div
      ref={root}
      role="dialog"
      aria-label={title}
      style={style ?? undefined}
      className={cn(
        "fixed inset-x-3 bottom-3 z-50 max-h-[80vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-xl",
        // El popover tiene ancho fijo; sin `overflow-x-hidden` y sin `min-w-0`
        // en los campos, un <select> con una opción larga se salía por la derecha.
        "overflow-x-hidden sm:max-w-[calc(100vw-2rem)]",
        !anchored && cn("sm:left-1/2 sm:top-24 sm:bottom-auto sm:right-auto sm:-translate-x-1/2", wide ? "sm:w-[42rem]" : "sm:w-96"),
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <button type="button" onClick={onClose} aria-label="Cerrar" className="min-h-8 rounded-lg px-2 text-sm text-slate-500 hover:bg-slate-100">×</button>
      </div>
      {children}
    </div>
  );
  // Anclado: fuera de cualquier tarjeta que recorte o cabecera pegajosa que
  // se le ponga encima. El centrado (sin anclar) ya era `fixed` y no lo necesita.
  if (anchored && typeof document !== "undefined") return createPortal(panel, document.body);
  return panel;
}

export function Chip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <li className="flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-800">
      {children}
      <button type="button" onClick={onRemove} aria-label="Quitar filtro" className="min-h-0 p-0 text-brand-500 hover:text-brand-900">×</button>
    </li>
  );
}

/**
 * Chip de subetapa o plazo con su cantidad, al estilo del Master de Pedidos.
 * Un solo lenguaje visual: apagado en gris, encendido en brand, en cero
 * deshabilitado. Los grupos se distinguen por su etiqueta, no por el color.
 */
export function CountChip({ label, count, active, onClick, title }: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={count === 0 && !active}
      onClick={onClick}
      title={title}
      className={cn(
        "min-h-7 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium transition",
        active ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
        count === 0 && !active && "cursor-not-allowed opacity-40",
      )}
    >
      {label} · <span className="tabular-nums">{count.toLocaleString("es-PE")}</span>
    </button>
  );
}
