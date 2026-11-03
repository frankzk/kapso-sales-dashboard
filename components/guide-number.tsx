"use client";

import { CopyButton } from "@/components/copy-button";

/** El prefijo es una etiqueta: seleccionar o copiar toma solo el código. */
export function GuideNumber({ value }: { value: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-mono font-semibold text-ink-900">
      <span className="select-none">N°</span>
      <span className="min-w-0 select-all break-all">{value}</span>
      <CopyButton
        value={value}
        label="la guía"
        className="select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      />
    </span>
  );
}
