"use client";

// «Quitar» en dos pasos y en la misma fila (MOM §45.1): el primer clic abre,
// debajo de la fila, «¿Quitar «AFORO FÍSICO»? Sí, quitar · No»; solo «Sí,
// quitar» hace la acción. Sin `window.confirm` ni otro diálogo del navegador:
// el texto va en castellano, con el mismo aspecto que el resto y sin tapar la
// página.
//
// Teclado y foco: al abrir, el foco va a «No» (la opción que no borra: dos
// Enter seguidos no quitan nada); «No» y Escape cierran y lo devuelven al botón
// «Quitar» de la fila; «Sí, quitar» lo deja en la tarjeta de la sección (la
// fila va a desaparecer y el foco no se pierde en la página). El botón de la
// fila lleva `aria-expanded` y `aria-controls` (`removeTriggerProps`).
//
// Quien lo usa guarda QUÉ fila está preguntando (una a la vez por tarjeta) y
// pinta la barra dentro de esa fila, a todo el ancho: así cabe en el teléfono
// sin empujar los montos ni crear scroll horizontal.

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { opsButtonClass } from "@/components/ops-styles";

// Los mismos botones que `BTN_DANGER` y `BTN_GHOST` de header-form.tsx, sin
// importar ese módulo (trae las acciones del servidor).
const BTN_DANGER = opsButtonClass("danger", "sm", "pointer-coarse:h-11");
const BTN_GHOST = opsButtonClass("ghost", "sm", "pointer-coarse:h-11");

const triggerId = (id: string) => `${id}-quitar`;
const barId = (id: string) => `${id}-confirmar`;

/** Lo que lleva el botón «Quitar» de la fila: su id (para devolverle el foco) y si su pregunta está abierta. */
export function removeTriggerProps(id: string, open: boolean): { id: string; "aria-expanded": boolean; "aria-controls": string | undefined } {
  return { id: triggerId(id), "aria-expanded": open, "aria-controls": open ? barId(id) : undefined };
}

export function ConfirmRemove({
  id,
  question,
  detail,
  confirmLabel = "Sí, quitar",
  confirmAriaLabel,
  onConfirm,
  onCancel,
  pending = false,
  className,
}: {
  /** El mismo `id` que se pasó a `removeTriggerProps` en el botón de la fila. */
  id: string;
  /** «¿Quitar «AFORO FÍSICO»?» */
  question: ReactNode;
  /** Lo que pasa al quitar, si hace falta decirlo («Sus fotos se quedan en Documentos»). */
  detail?: ReactNode;
  confirmLabel?: string;
  /** El nombre para el lector de pantalla si el texto visible no basta («Sí, quitar AFORO FÍSICO»). */
  confirmAriaLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Una acción en curso: «Sí, quitar» espera. */
  pending?: boolean;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const no = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    no.current?.focus();
  }, []);

  const backToTrigger = () => {
    const trigger = document.getElementById(triggerId(id));
    onCancel();
    // El botón de la fila sigue ahí: el foco vuelve a él.
    requestAnimationFrame(() => trigger?.focus());
  };

  const confirm = () => {
    // La fila va a desaparecer: el foco pasa a la tarjeta de su sección (las
    // del detalle tienen `tabIndex={-1}`), o al botón de la fila si no hay.
    const holder = root.current?.closest<HTMLElement>("[tabindex='-1']") ?? document.getElementById(triggerId(id));
    holder?.focus({ preventScroll: true });
    onConfirm();
  };

  const questionId = `${barId(id)}-p`;
  return (
    <div
      ref={root}
      id={barId(id)}
      role="group"
      aria-labelledby={questionId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          backToTrigger();
        }
      }}
      className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-crit-wash px-3 py-2 ring-1 ring-inset ring-crit-bg", className)}
    >
      <div className="min-w-0 flex-1 basis-48">
        <p id={questionId} className="break-words text-[13px] font-semibold leading-5 text-ink-900">
          {question}
        </p>
        {detail && <p className="text-[13px] leading-5 text-ink-600">{detail}</p>}
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button type="button" className={BTN_DANGER} disabled={pending} onClick={confirm} aria-label={confirmAriaLabel}>
          {confirmLabel}
        </button>
        <button ref={no} type="button" className={BTN_GHOST} onClick={backToTrigger}>
          No
        </button>
      </div>
    </div>
  );
}
