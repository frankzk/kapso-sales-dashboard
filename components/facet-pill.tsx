"use client";

// Los filtros en píldora del mundo de operación (DESIGN.md), compartidos por el
// Master de Pedidos y Repro Provincia: una píldora discontinua que se vuelve
// sólida con su valor y abre una hoja anclada. Tres formas, según lo que se
// elige: varias opciones (`FacetPill`), una sola (`ChoicePill`) o un día
// (`DatePill`).

import { useCallback, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { CHECKBOX, FIELD_BOX, FilterPill, OpsButton } from "@/components/ops-ui";
import { Sheet } from "@/components/filter-sheet";
import { IconSearch } from "@/components/icons";

export type FacetOption = { value: string; label: string; count?: number };

const ROW =
  "flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm text-ink-700 hover:bg-wash pointer-coarse:min-h-11";
const ALL_ROW =
  "flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm font-medium text-ink-900 hover:bg-wash pointer-coarse:min-h-11";

/**
 * La hoja vive en un portal: al cerrarla con Escape o con su «x» el foco vuelve
 * a la píldora, no al principio del documento. Si se cerró tocando otra cosa,
 * el foco se queda donde la persona lo puso.
 */
function usePillSheet(onClosed?: () => void) {
  const [open, setOpen] = useState(false);
  const pill = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  const close = useCallback(() => {
    const active = document.activeElement;
    if (active === document.body || (active && sheet.current?.contains(active))) pill.current?.focus();
    setOpen(false);
    closedRef.current?.();
  }, []);
  return { open, setOpen, pill, sheet, close };
}

/**
 * Filtro de varias opciones: píldora que abre una lista con casillas. Cada
 * casilla filtra al momento.
 */
export function FacetPill({
  label,
  allLabel,
  options,
  selected,
  onChange,
  summarize,
}: {
  label: string;
  /**
   * La casilla de arriba, la que dice que no hay filtro: «Todas las tiendas»,
   * «Todos los couriers». Se escribe por filtro porque el género cambia.
   */
  allLabel: string;
  options: FacetOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /**
   * Lo que dice la píldora cuando la selección tiene nombre propio: la
   * cobertura de Repro Provincia abre con «todo menos Lima», y «Provincia COD
   * +3» no dice eso. Devuelve null para el resumen de siempre.
   */
  summarize?: (selected: Set<string>) => string | null;
}) {
  const [query, setQuery] = useState("");
  const { open, setOpen, pill, sheet, close } = usePillSheet(() => setQuery(""));

  // Un facet vacío o transitoriamente ausente nunca debe tumbar el panel: la
  // base y la interfaz se despliegan por separado.
  const safe = (Array.isArray(options) ? options : []).filter(
    (o) => typeof o.value === "string" && o.value.length > 0,
  );
  const labelOf = new Map(safe.map((o) => [o.value, o.label]));
  const picked = Array.from(selected);
  const first = picked[0];
  const value =
    summarize?.(selected) ??
    (first === undefined
      ? null
      : picked.length === 1
        ? (labelOf.get(first) ?? first)
        : `${labelOf.get(first) ?? first} +${picked.length - 1}`);
  const term = query.trim().toLocaleLowerCase("es");
  const shown = term ? safe.filter((o) => o.label.toLocaleLowerCase("es").includes(term)) : safe;

  const toggle = (option: string) => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(next);
  };

  return (
    <>
      <FilterPill
        ref={pill}
        label={label}
        value={value}
        expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        onClear={() => onChange(new Set())}
        title={picked.length > 1 ? picked.map((v) => labelOf.get(v) ?? v).join(", ") : undefined}
      />
      {open && (
        <Sheet look="ops" title={label} onClose={close} anchored anchorRef={pill}>
          <div ref={sheet}>
            {safe.length > 8 && (
              <label className="relative mb-2 block">
                <span className="sr-only">Buscar en {label.toLocaleLowerCase("es")}</span>
                <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Buscar ${label.toLocaleLowerCase("es")}`}
                  className={cn(FIELD_BOX, "h-8 w-full pl-8 pr-3")}
                />
              </label>
            )}
            {/* «TODAS» ARRIBA Y MARCADA MIENTRAS NO HAYA FILTRO. Sin nada marcado
                ya se enseña todo, pero la hoja con las casillas vacías no lo
                decía, y la reacción natural era marcarlas todas: eso es un filtro
                puesto («Aurela +1») que además deja fuera la tienda que se cree
                mañana. Marcarla quita el filtro; elegir una opción la desmarca.
                Mientras se busca no sale: la lista es la de lo que se busca. */}
            {!term && (
              <div className="-mx-1 mb-1 border-b border-line pb-1">
                <label className={ALL_ROW}>
                  <input
                    type="checkbox"
                    // Sin buscador, el foco entra por la primera casilla.
                    autoFocus={safe.length <= 8}
                    className={CHECKBOX}
                    checked={selected.size === 0}
                    onChange={() => onChange(new Set())}
                  />
                  <span className="min-w-0 flex-1 truncate">{allLabel}</span>
                </label>
              </div>
            )}
            <ul className="-mx-1 grid max-h-72 gap-0.5 overflow-y-auto">
              {shown.map((o) => (
                <li key={o.value}>
                  <label className={ROW}>
                    <input
                      type="checkbox"
                      className={CHECKBOX}
                      checked={selected.has(o.value)}
                      onChange={() => toggle(o.value)}
                    />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.count != null && (
                      <span className="shrink-0 text-xs tabular-nums text-ink-500">
                        {o.count.toLocaleString("es-PE")}
                      </span>
                    )}
                  </label>
                </li>
              ))}
              {shown.length === 0 && (
                <li className="px-2 py-2 text-[13px] text-ink-500">
                  {safe.length ? "Sin coincidencias." : "Todavía no hay opciones."}
                </li>
              )}
            </ul>
            {/* «Quitar selección» vivía aquí; ahora lo hace «Todas», arriba. */}
            {selected.size > 0 && (
              <p className="mt-3 border-t border-line pt-3 text-[13px] tabular-nums text-ink-500">
                {selected.size} {selected.size === 1 ? "elegido" : "elegidos"}
              </p>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}

/**
 * Filtro de UNA opción («Swayp: sin stock»): la misma píldora, con una lista de
 * opciones redondas y la de «todo» arriba. Elegir cierra la hoja: no hay nada
 * más que marcar.
 */
export function ChoicePill<T extends string>({
  label,
  allLabel,
  allValue,
  options,
  value,
  onChange,
}: {
  label: string;
  allLabel: string;
  /** El valor que significa «sin filtro». */
  allValue: T;
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (next: T) => void;
}) {
  const { open, setOpen, pill, sheet, close } = usePillSheet();
  const current = options.find((o) => o.value === value);
  const choose = (next: T) => {
    onChange(next);
    close();
  };
  const name = `${label}-opcion`;
  return (
    <>
      <FilterPill
        ref={pill}
        label={label}
        value={value === allValue ? null : (current?.label ?? value)}
        expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        onClear={() => onChange(allValue)}
      />
      {open && (
        <Sheet look="ops" title={label} onClose={close} anchored anchorRef={pill}>
          <div ref={sheet} role="radiogroup" aria-label={label}>
            <div className="-mx-1 mb-1 border-b border-line pb-1">
              <label className={ALL_ROW}>
                <input
                  type="radio"
                  name={name}
                  autoFocus={value === allValue}
                  className={CHECKBOX}
                  checked={value === allValue}
                  onChange={() => choose(allValue)}
                />
                <span className="min-w-0 flex-1 truncate">{allLabel}</span>
              </label>
            </div>
            <ul className="-mx-1 grid gap-0.5">
              {options.map((o) => (
                <li key={o.value}>
                  <label className={ROW}>
                    <input
                      type="radio"
                      name={name}
                      autoFocus={value === o.value}
                      className={CHECKBOX}
                      checked={value === o.value}
                      onChange={() => choose(o.value)}
                    />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.count != null && (
                      <span className="shrink-0 text-xs tabular-nums text-ink-500">
                        {o.count.toLocaleString("es-PE")}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </Sheet>
      )}
    </>
  );
}

/** «05 oct» de un `YYYY-MM-DD`, leído como día de calendario (sin zona). */
function shortDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "short", timeZone: "UTC" });
}

/**
 * Filtro de UN día («Programación: 05 oct»). La hoja trae el selector de fecha
 * y los dos días que más se piden, hoy y mañana, a un toque.
 */
export function DatePill({
  label,
  value,
  onChange,
  today,
  tomorrow,
}: {
  label: string;
  /** `YYYY-MM-DD`, o vacío sin filtro. */
  value: string;
  onChange: (next: string) => void;
  today: string;
  tomorrow: string;
}) {
  const { open, setOpen, pill, sheet, close } = usePillSheet();
  const valueLabel = !value ? null : value === today ? "Hoy" : value === tomorrow ? "Mañana" : shortDay(value);
  return (
    <>
      <FilterPill
        ref={pill}
        label={label}
        value={valueLabel}
        expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        onClear={() => onChange("")}
      />
      {open && (
        <Sheet look="ops" title={label} onClose={close} anchored anchorRef={pill}>
          <div ref={sheet} className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <OpsButton
                size="sm"
                onClick={() => {
                  onChange(today);
                  close();
                }}
                className="pointer-coarse:h-11"
              >
                Hoy
              </OpsButton>
              <OpsButton
                size="sm"
                onClick={() => {
                  onChange(tomorrow);
                  close();
                }}
                className="pointer-coarse:h-11"
              >
                Mañana
              </OpsButton>
            </div>
            <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
              Otro día
              <input
                type="date"
                autoFocus
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className={cn(FIELD_BOX, "h-9 w-full px-3 font-normal tabular-nums pointer-coarse:h-11")}
              />
            </label>
            {value && (
              <div className="border-t border-line pt-3">
                <OpsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onChange("");
                    close();
                  }}
                  className="pointer-coarse:h-11"
                >
                  Quitar la fecha
                </OpsButton>
              </div>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
