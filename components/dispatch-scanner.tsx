"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";

/** Camera first on touch devices. Desktop readers keep the keyboard workflow. */
export function DispatchScanner({ busy, disabled, onScan, onCamera, compact = false, buttonLabel, hint, look = "default" }: {
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
  /** «ops»: el mundo de operación (Despacho del día y la caja del panel de Rutas). */
  look?: "default" | "ops";
}) {
  const ops = look === "ops";
  const [manual, setManual] = useState(false);
  const [code, setCode] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // Sin autoenfoque al cargar: el halo de foco nada más abrir la página
  // molesta. Una pistola lectora sigue funcionando sola: si empieza a
  // escribir sin que haya un campo enfocado, el primer carácter enfoca este
  // campo y no se pierde. Tras un escaneo (busy → libre) el foco vuelve aquí
  // para encadenar lecturas.
  // Solo vuelve el foco al campo cuando la lectura salió DEL campo (pistola o
  // teclado) y no hay pantalla táctil: tras un escaneo con la cámara del
  // teléfono, enfocar el campo abría el teclado encima de la cámara.
  const hadBusy = useRef(false);
  const fromField = useRef(false);
  useEffect(() => {
    if (busy) hadBusy.current = true;
    else if (hadBusy.current && !disabled) {
      hadBusy.current = false;
      const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
      if (fromField.current && !touch) input.current?.focus({ preventScroll: true });
      fromField.current = false;
    }
  }, [busy, disabled]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (disabled || busy || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      const active = document.activeElement;
      if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
      if (active && (active as HTMLElement).isContentEditable) return;
      input.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, disabled]);
  if (compact) {
    return <div className={ops ? "flex flex-col gap-2 sm:flex-row sm:items-center" : "space-y-2"} aria-busy={busy}>
      <button type="button" onClick={onCamera} disabled={busy || disabled} title={hint}
        className={ops
          ? "flex h-12 w-full shrink-0 items-center justify-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white shadow-primary transition-colors hover:bg-brand-700 disabled:opacity-50 sm:h-10 sm:w-auto"
          : "flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-base font-semibold text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:border-brand-500 focus-visible:ring-4 focus-visible:ring-brand-500/15 focus-visible:ring-offset-2 disabled:opacity-50 sm:min-h-12 sm:w-auto sm:text-sm"}>
        <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 5 6 8H3v12h18V8h-3l-2-3Z"/><circle cx="12" cy="13" r="3"/></svg>
        {busy ? "Verificando…" : (buttonLabel ?? "Escanear")}
      </button>
      {/* En el teléfono no hay tecla Enter a la vista: el teclado muestra «Ir»
          (enterKeyHint) y además hay un botón visible al lado del campo. Con
          una pistola lectora, el lector escribe el código y manda el Enter. */}
      <form className={cn("flex items-stretch gap-2", ops && "min-w-0 flex-1")} onSubmit={(event) => { event.preventDefault(); if (code.trim()) { fromField.current = true; onScan(code); setCode(""); } }}>
        <input ref={input} value={code} onChange={(event) => setCode(event.target.value)} disabled={busy || disabled}
          autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go" inputMode="text"
          aria-label="Código del paquete: QR, guía o número de pedido" placeholder="QR, guía o pedido"
          className={ops
            ? "h-12 w-full min-w-0 flex-1 rounded-md border-0 bg-white px-3 text-base text-ink-900 shadow-control ring-1 ring-inset ring-line-strong placeholder:text-ink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50 sm:h-10 sm:text-sm"
            : "min-h-12 w-full min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus-visible:outline-none focus-visible:border-brand-500 focus-visible:ring-4 focus-visible:ring-brand-500/15 disabled:opacity-50 sm:min-h-10 sm:text-sm"} />
        <button type="submit" disabled={busy || disabled || !code.trim()}
          className={ops
            ? "h-12 shrink-0 rounded-md bg-white px-4 text-sm font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong hover:bg-wash disabled:opacity-40 sm:h-10 sm:sr-only sm:focus:not-sr-only"
            : "min-h-12 shrink-0 rounded-xl border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 sm:min-h-10 sm:sr-only sm:focus:not-sr-only"}
          title="También vale la tecla Ir del teclado o el Enter del lector">
          Añadir
        </button>
      </form>
    </div>;
  }
  return <div className={ops ? "mt-4 space-y-3" : "mt-4 space-y-2"} aria-busy={busy}>
    <button type="button" onClick={onCamera} disabled={busy || disabled}
      className={ops
        ? "flex h-12 w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white shadow-primary transition-colors hover:bg-brand-700 disabled:opacity-50 sm:h-10 sm:w-auto"
        : "flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-base font-semibold text-white hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50 sm:w-auto"}>
      <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 5 6 8H3v12h18V8h-3l-2-3Z"/><circle cx="12" cy="13" r="3"/></svg>
      {busy ? "Verificando paquete…" : "Escanear con cámara"}
    </button>
    <button type="button" aria-expanded={manual} aria-controls="dispatch-manual-code" disabled={busy || disabled}
      onClick={() => { setManual(!manual); }}
      className={ops
        ? "h-11 w-full rounded-md px-3 text-sm font-semibold text-ink-600 hover:bg-wash hover:text-ink-900 disabled:opacity-50 sm:hidden"
        : "min-h-12 w-full rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 sm:hidden"}>
      {manual ? "Ocultar ingreso manual" : "Escribir código o usar lector"}
    </button>
    <form id="dispatch-manual-code" onSubmit={(event) => { event.preventDefault(); if (code.trim()) { fromField.current = true; onScan(code); setCode(""); } }}
      className={cn("gap-2 sm:flex sm:items-end", manual ? "flex flex-col" : "hidden")}>
      <label className={ops ? "min-w-0 flex-1 text-[13px] font-medium text-ink-700" : "min-w-0 flex-1 text-sm font-medium text-slate-700"}>
        Código del paquete
        <input ref={input} value={code} onChange={(event) => setCode(event.target.value)} disabled={busy || disabled}
          autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="go"
          placeholder="QR, guía o número de pedido"
          className={ops
            ? "mt-1 h-12 w-full rounded-md border-0 bg-white px-3 text-base text-ink-900 shadow-control ring-1 ring-inset ring-line-strong placeholder:text-ink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:bg-wash disabled:text-ink-500 sm:h-9 sm:text-sm"
            : "mt-1 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus-visible:outline-none focus-visible:border-brand-500 focus-visible:ring-4 focus-visible:ring-brand-500/15 disabled:opacity-50"} />
      </label>
      <button disabled={busy || disabled || !code.trim()} className={ops
        ? "h-12 shrink-0 rounded-md bg-white px-3 text-sm font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong hover:bg-wash hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50 sm:h-9"
        : "min-h-12 rounded-xl border border-slate-300 px-5 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40"}>
        {busy ? "Verificando…" : "Confirmar código"}
      </button>
    </form>
  </div>;
}
