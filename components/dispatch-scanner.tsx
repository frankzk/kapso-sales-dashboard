"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";

/** Camera first on touch devices. Desktop readers keep the keyboard workflow. */
export function DispatchScanner({ busy, disabled, onScan, onCamera, compact = false, buttonLabel, hint }: {
  busy: boolean;
  disabled: boolean;
  onScan: (code: string) => void;
  onCamera: () => void;
  /**
   * Primera vista mínima (Despacho del día): botón «Escanear» y el campo de
   * código siempre visible, sin etiqueta aparte ni botón «Confirmar» (Enter o
   * el lector confirman). La explicación va en el `title` del botón.
   */
  compact?: boolean;
  buttonLabel?: string;
  hint?: string;
}) {
  const [manual, setManual] = useState(false);
  const [code, setCode] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!busy && !disabled && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      input.current?.focus({ preventScroll: true });
    }
  }, [busy, disabled]);
  if (compact) {
    return <div className="space-y-2" aria-busy={busy}>
      <button type="button" onClick={onCamera} disabled={busy || disabled} title={hint}
        className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-base font-semibold text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:border-brand-500 focus-visible:ring-4 focus-visible:ring-brand-500/15 focus-visible:ring-offset-2 disabled:opacity-50 sm:min-h-12 sm:w-auto sm:text-sm">
        <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 5 6 8H3v12h18V8h-3l-2-3Z"/><circle cx="12" cy="13" r="3"/></svg>
        {busy ? "Verificando…" : (buttonLabel ?? "Escanear")}
      </button>
      {/* En el teléfono no hay tecla Enter a la vista: el teclado muestra «Ir»
          (enterKeyHint) y además hay un botón visible al lado del campo. Con
          una pistola lectora, el lector escribe el código y manda el Enter. */}
      <form className="flex items-stretch gap-2" onSubmit={(event) => { event.preventDefault(); if (code.trim()) { onScan(code); setCode(""); } }}>
        <input ref={input} value={code} onChange={(event) => setCode(event.target.value)} disabled={busy || disabled}
          autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go" inputMode="text"
          aria-label="Código del paquete: QR, guía o número de pedido" placeholder="QR, guía o pedido"
          className="min-h-12 w-full min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus-visible:outline-none focus-visible:border-brand-500 focus-visible:ring-4 focus-visible:ring-brand-500/15 disabled:opacity-50 sm:min-h-10 sm:text-sm" />
        <button type="submit" disabled={busy || disabled || !code.trim()}
          className="min-h-12 shrink-0 rounded-xl border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 sm:min-h-10 sm:sr-only sm:focus:not-sr-only"
          title="También vale la tecla Ir del teclado o el Enter del lector">
          Añadir
        </button>
      </form>
    </div>;
  }
  return <div className="mt-4 space-y-2" aria-busy={busy}>
    <button type="button" onClick={onCamera} disabled={busy || disabled}
      className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-base font-semibold text-white hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50 sm:w-auto">
      <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 5 6 8H3v12h18V8h-3l-2-3Z"/><circle cx="12" cy="13" r="3"/></svg>
      {busy ? "Verificando paquete…" : "Escanear con cámara"}
    </button>
    <button type="button" aria-expanded={manual} aria-controls="dispatch-manual-code" disabled={busy || disabled}
      onClick={() => { setManual(!manual); }}
      className="min-h-12 w-full rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 sm:hidden">
      {manual ? "Ocultar ingreso manual" : "Escribir código o usar lector"}
    </button>
    <form id="dispatch-manual-code" onSubmit={(event) => { event.preventDefault(); if (code.trim()) { onScan(code); setCode(""); } }}
      className={cn("gap-2 sm:flex sm:items-end", manual ? "flex flex-col" : "hidden")}>
      <label className="min-w-0 flex-1 text-sm font-medium text-slate-700">
        Código del paquete
        <input ref={input} value={code} onChange={(event) => setCode(event.target.value)} disabled={busy || disabled}
          autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="go"
          placeholder="QR, guía o número de pedido"
          className="mt-1 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus-visible:outline-none focus-visible:border-brand-500 focus-visible:ring-4 focus-visible:ring-brand-500/15 disabled:opacity-50" />
      </label>
      <button disabled={busy || disabled || !code.trim()} className="min-h-12 rounded-xl border border-slate-300 px-5 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40">
        {busy ? "Verificando…" : "Confirmar código"}
      </button>
    </form>
  </div>;
}
