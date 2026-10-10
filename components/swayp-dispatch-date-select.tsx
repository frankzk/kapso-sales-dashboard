"use client";

import { limaTodayKey } from "@/lib/shipments";
import { swaypDispatchDayOptions } from "@/lib/swayp-dispatch-days";

/**
 * La fecha de despacho de una guía Swayp, solo de lunes a sábado (10-10-2026).
 * Reemplaza al `<input type="date">`: el nativo no deja apagar los domingos.
 */
export function SwaypDispatchDateSelect({
  value,
  onChange,
  className,
  invalid,
  placeholder = "Elige la fecha",
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  invalid?: boolean;
  /** Se muestra mientras no hay fecha elegida. */
  placeholder?: string;
}) {
  const options = swaypDispatchDayOptions(limaTodayKey());
  const known = options.some((o) => o.value === value);
  return (
    <select
      value={known ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      className={className}
    >
      {!known && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
