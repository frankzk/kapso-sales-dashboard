"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copiar un dato al portapapeles, con acuse.
 *
 * POR QUÉ EXISTE. Copiar al portapapeles estaba escrito a mano en cuatro sitios
 * —`store-settings.tsx` (dos veces) y `leads-drawer.tsx` (dos veces)— y las
 * cuatro copias ya habían divergido en el acuse: unas decían «Copiado», otra
 * «¡Copiado!», otra «copiado» en minúscula, y los tiempos de espera no
 * coincidían. Ninguna anunciaba el cambio a un lector de pantalla. Añadir una
 * quinta para el teléfono habría sido plantar el mismo problema una vez más.
 *
 * Las cuatro llaman ya a `useCopyToClipboard`; el detalle de lo que cada una
 * hacía mal está en la documentación del hook, más abajo.
 *
 * EL PORTAPAPELES FALLA MÁS DE LO QUE PARECE. `navigator.clipboard` no existe
 * en contextos no seguros y el navegador puede denegar el permiso; en ese caso
 * `writeText` RECHAZA. Sin capturarlo, la promesa rota sube como error no
 * manejado y el acuse se queda puesto diciendo que se copió algo que no se
 * copió — peor que no ofrecer el botón. Aquí un fallo deja el botón como
 * estaba y lo dice.
 */

export type CopyState = "idle" | "ok" | "fail";

/**
 * Copiar al portapapeles, con acuse y sin sorpresas.
 *
 * ESTABA ESCRITO A MANO EN CUATRO SITIOS y las cuatro copias eran distintas,
 * en la forma y en lo que hacían mal:
 *
 *   store-settings, webhook de Aliclik → `void writeText(url)` y a continuación
 *     `setCopied(true)` SIN esperar nada. Si el portapapeles falla, el botón
 *     dice «Copiado» igual y la promesa rechazada sube sin manejar. Decir que se
 *     copió algo que no se copió es peor que no ofrecer el botón: quien lo lee
 *     se va a pegar un secreto que no tiene.
 *   store-settings, webhook de Kapso  → `.then(ok, () => {})`. El fallo se
 *     traga en silencio y el botón simplemente no reacciona.
 *   leads-drawer, copiar teléfono    → try/catch con el catch vacío. Igual.
 *   leads-drawer, copiar pedido      → try/catch con el catch vacío. Igual.
 *
 * Y ninguna cancelaba su temporizador al desmontar, que en un DRAWER es el caso
 * normal: copias y cierras.
 *
 * El hook —y no un componente— porque los cuatro sitios son botones de TEXTO
 * con etiquetas propias («Copiar», «copiar», `Copiar ${handle}`, «Copiar
 * pedido»). Meterlos todos en `CopyButton` les habría cambiado el aspecto; lo
 * que tenían que compartir es la conducta, no la forma.
 */
export function useCopyToClipboard(resetMs = 1600): {
  state: CopyState;
  copy: (value: string) => void;
  reset: () => void;
} {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(
    (value: string) => {
      if (timer.current) clearTimeout(timer.current);
      // `navigator.clipboard` no existe en contextos no seguros y el navegador
      // puede denegar el permiso: ahí `writeText` RECHAZA. Se captura para que
      // el acuse diga la verdad, y porque una promesa rota sin manejar sube
      // como error no capturado.
      const done = (next: CopyState) => {
        if (!alive.current) return;
        setState(next);
        timer.current = setTimeout(() => {
          if (alive.current) setState("idle");
        }, resetMs);
      };
      try {
        const write = navigator.clipboard?.writeText(value);
        if (!write) return done("fail");
        void write.then(
          () => done("ok"),
          () => done("fail"),
        );
      } catch {
        done("fail");
      }
    },
    [resetMs],
  );

  // Bajar el acuse a mano. Hace falta cuando lo COPIADO deja de existir: el
  // panel de pedido generado se vacía al cambiar de lead y al volver a generar,
  // y un «Copiado» heredado se leería como que el pedido NUEVO ya está copiado.
  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setState("idle");
  }, []);

  return { state, copy, reset };
}

/**
 * El texto del botón según cómo fue.
 *
 * Vive acá para que las cuatro pantallas digan lo MISMO. Antes cada una tenía
 * su acuse —«Copiado», «¡Copiado!», «copiado» en minúscula— y ninguna decía
 * nada cuando fallaba: quien lo usaba no distinguía «ya está» de «no se pudo».
 */
export function copyLabel(state: CopyState, idle = "Copiar"): string {
  if (state === "ok") return "Copiado";
  if (state === "fail") return "No se pudo copiar";
  return idle;
}

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
  const { state, copy } = useCopyToClipboard();

  if (!value) return null;

  return (
    <button
      type="button"
      onClick={() => copy(value)}
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
