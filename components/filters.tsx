"use client";

// Controles de filtro compartidos por los paneles operativos (Repro Provincia y
// Master de Pedidos). Vivían dentro de components/shipments.tsx; se extrajeron
// al necesitarlos en dos sitios, sin cambiar su comportamiento.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";

/**
 * Desplegable de selección múltiple con buscador. Un conjunto VACÍO significa
 * "todas las opciones", nunca "ninguna" — el filtro solo restringe cuando el
 * usuario elige algo explícitamente.
 */
export function ChecklistFilter({
  label,
  options,
  selected,
  onChange,
  capitalize = true,
  optionLabel,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Las etiquetas de código (estados) se muestran tal cual, no capitalizadas. */
  capitalize?: boolean;
  optionLabel?: (option: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const term = q.trim().toLowerCase();
  const shown = term ? options.filter((o) => o.toLowerCase().includes(term)) : options;

  function toggle(option: string) {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(next);
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "rounded-lg border px-2.5 py-1 text-xs font-medium",
          selected.size > 0
            ? "border-brand-200 bg-brand-50 text-brand-700"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
        )}
      >
        {label}
        {selected.size > 0 ? ` (${selected.size})` : ""} ▾
      </button>
      {open && (
        <div className="absolute left-0 z-10 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Buscar ${label.toLowerCase()}…`}
            className="mb-2 w-full rounded border border-slate-200 px-2 py-1 text-xs"
          />
          {selected.size > 0 && (
            <button
              onClick={() => onChange(new Set())}
              className="mb-1 text-xs text-slate-500 hover:underline"
            >
              Limpiar selección
            </button>
          )}
          <ul className="max-h-60 overflow-y-auto">
            {shown.map((option) => (
              <li key={option}>
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-slate-50",
                    capitalize && "capitalize",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(option)}
                    onChange={() => toggle(option)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-slate-700">{optionLabel?.(option) ?? option}</span>
                </label>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-1.5 py-1 text-xs text-slate-400">Sin coincidencias.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
