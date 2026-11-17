"use client";

// El campo «Distrito» del formulario de pedido en Leads (MOM §37.10): se busca
// en la lista oficial del INEI (sin tildes, por palabras, con una o dos letras
// mal) y se ELIGE. Lo tecleado no se guarda: se guarda el nombre de la lista,
// y la provincia y la región salen de él. Es un combobox ARIA, como el de
// productos de Compras: flechas, Enter y Escape.

import { useId, useMemo, useState } from "react";
import { cn } from "@/components/ui";
import { FIELD } from "@/components/ops-ui";
import { IconAlert, IconCheck, IconSearch } from "@/components/icons";
import {
  districtSearchKey,
  matchPeruDistrict,
  peruDistrictPlace,
  searchPeruDistricts,
  type PeruDistrict,
} from "@/lib/peru-districts";

const LABEL = "block text-[13px] font-medium leading-5 text-ink-700";

/** Qué decirle a la asesora cuando lo escrito todavía no es un distrito elegido. */
export function districtPendingHint(
  text: string,
  department: string | null,
): { message: string; suggestion: PeruDistrict | null } | null {
  if (!districtSearchKey(text)) return null;
  const m = matchPeruDistrict(text, department);
  if (m.kind === "ambiguous") {
    return { message: `Hay ${m.options.length} distritos «${m.name}»: elige el de la entrega.`, suggestion: null };
  }
  if (m.kind === "none" && m.suggestions[0]) {
    return { message: `«${text.trim()}» no está en la lista.`, suggestion: m.suggestions[0] };
  }
  if (m.kind === "none") {
    return { message: "Ningún distrito se llama así. Revisa cómo se escribe y elígelo de la lista.", suggestion: null };
  }
  return { message: "Elige el distrito de la lista.", suggestion: null };
}

export function DistrictPicker({
  text,
  picked,
  department,
  onType,
  onPick,
  disabled,
}: {
  /** Lo que se ve en el campo. */
  text: string;
  /** El distrito elegido de la lista, o null mientras no se elija. */
  picked: PeruDistrict | null;
  /** El departamento que vino con la dirección: ordena los homónimos. */
  department: string | null;
  onType: (text: string) => void;
  onPick: (district: PeruDistrict) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => (picked ? [] : searchPeruDistricts(text, { department })), [text, department, picked]);
  const hint = useMemo(() => (picked || open ? null : districtPendingHint(text, department)), [picked, open, text, department]);
  const listOpen = open && !picked && districtSearchKey(text).length > 0;

  const choose = (d: PeruDistrict | undefined) => {
    if (!d) return;
    onPick(d);
    setOpen(false);
  };

  return (
    <div className="relative min-w-0">
      <label htmlFor={`${id}-q`} className={LABEL}>
        Distrito *
      </label>
      <div className="relative mt-1">
        <IconSearch aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
        <input
          id={`${id}-q`}
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={listOpen && results[active] ? `${id}-o${active}` : undefined}
          aria-invalid={hint ? true : undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          autoComplete="off"
          spellCheck={false}
          className={cn(FIELD, "pl-9", picked ? "pr-9" : "")}
          placeholder="Escribe y elige de la lista"
          value={text}
          disabled={disabled}
          onChange={(e) => {
            onType(e.currentTarget.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            // Escrito entero y sin otro igual («Surquillo»): queda elegido al
            // salir del campo, sin tener que abrir la lista.
            if (!picked) {
              const m = matchPeruDistrict(text, department);
              if (m.kind === "exact") onPick(m.district);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && listOpen) {
              e.preventDefault();
              choose(results[active]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        {picked && (
          <IconCheck aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ok-fg" />
        )}
      </div>
      {listOpen && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label="Distritos del Perú"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg bg-white p-1 shadow-pop"
        >
          {results.length ? (
            results.map((d, i) => (
              <li
                key={d.ubigeo}
                id={`${id}-o${i}`}
                role="option"
                aria-selected={i === active}
                // `onMouseDown`: elegir antes de que el campo pierda el foco y cierre la lista.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(d);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn("cursor-pointer rounded-md px-2.5 py-1.5 pointer-coarse:min-h-11", i === active ? "bg-wash" : "")}
              >
                <span className="block truncate text-sm leading-5 text-ink-900">{d.name}</span>
                <span className="block truncate text-[13px] leading-5 text-ink-500">{peruDistrictPlace(d)}</span>
              </li>
            ))
          ) : (
            <li className="px-2.5 py-2 text-[13px] leading-5 text-ink-500">Ningún distrito se llama así. Revisa cómo se escribe.</li>
          )}
        </ul>
      )}
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 flex items-start gap-1.5 text-[13px] leading-5 text-warn-fg">
          <IconAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            {hint.message}
            {hint.suggestion && (
              <>
                {" "}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => choose(hint.suggestion!)}
                  className="font-medium text-brand-700 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-700 disabled:opacity-50"
                >
                  ¿Es {hint.suggestion.name} ({peruDistrictPlace(hint.suggestion)})?
                </button>
              </>
            )}
          </span>
        </p>
      )}
    </div>
  );
}
