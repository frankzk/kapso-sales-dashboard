"use client";

/** Botón de imprimir: `window.print()` es del navegador y la página del rótulo
 *  es un server component, así que vive en su propia isla de cliente. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
    >
      Imprimir
    </button>
  );
}
