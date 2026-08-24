"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Copiar un dato al portapapeles, con acuse.
 *
 * POR QUÉ EXISTE. Copiar al portapapeles estaba escrito a mano en tres sitios
 * —`store-settings.tsx` (dos veces) y `leads-drawer.tsx` (dos veces)— y las
 * cuatro copias ya habían divergido en el acuse: unas dicen «Copiado», otra
 * «¡Copiado!», otra «copiado» en minúscula, y los tiempos de espera no
 * coinciden. Ninguna anuncia el cambio a un lector de pantalla. Añadir una
 * quinta para el teléfono habría sido plantar el mismo problema una vez más.
 *
 * Las cuatro que ya existen NO se tocan aquí: cambiarlas es un cambio aparte,
 * con su propia revisión. Lo que este componente garantiza es que a partir de
 * ahora no haga falta escribirlo otra vez.
 *
 * EL PORTAPAPELES FALLA MÁS DE LO QUE PARECE. `navigator.clipboard` no existe
 * en contextos no seguros y el navegador puede denegar el permiso; en ese caso
 * `writeText` RECHAZA. Sin capturarlo, la promesa rota sube como error no
 * manejado y el acuse se queda puesto diciendo que se copió algo que no se
 * copió — peor que no ofrecer el botón. Aquí un fallo deja el botón como
 * estaba y lo dice.
 */
export function CopyButton({
  value,
  label,
  className = "",
}: {
  /** Lo que se copia. Si viene vacío, no se pinta nada. */
  value: string | null | undefined;
  /** Qué se está copiando, para el título y el lector de pantalla. */
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  // El temporizador se cancela al desmontar: sin esto, cerrar el panel justo
  // después de copiar deja un setState apuntando a un componente que ya no está.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!value) return null;

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value as string);
      setState("ok");
    } catch {
      setState("fail");
    }
    timer.current = setTimeout(() => setState("idle"), 1600);
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={state === "fail" ? `No se pudo copiar ${label}` : `Copiar ${label}`}
      aria-label={`Copiar ${label}`}
      className={`inline-flex shrink-0 items-center rounded p-0.5 align-middle transition-colors ${
        state === "ok"
          ? "text-emerald-600"
          : state === "fail"
            ? "text-rose-600"
            : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"
      } ${className}`}
    >
      {/* El acuse no puede ser SOLO el color: quien no distingue verde de gris
          no se enteraría de si funcionó. Por eso también cambia el dibujo, y
          `role="status"` lo anuncia en voz alta. */}
      <span role="status" className="sr-only">
        {state === "ok" ? `${label} copiado` : state === "fail" ? `No se pudo copiar ${label}` : ""}
      </span>
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none">
        {state === "ok" ? (
          <path
            d="M3.5 8.5l3 3 6-6.5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : state === "fail" ? (
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        ) : (
          <>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M10.5 3.5A1.5 1.5 0 0 0 9 2H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 10"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
    </button>
  );
}
