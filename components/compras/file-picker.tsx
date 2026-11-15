"use client";

// Elegir archivos en castellano (MOM §45.1): el `<input type="file">` del
// navegador escribe «Choose Files / No file chosen» en el idioma del navegador,
// no en el de Kapta. Aquí se ve un botón «Elegir archivos» (o «Elegir archivo»)
// y, al lado, los nombres elegidos o «Ningún archivo».
//
// El input nativo SIGUE siendo el control: visualmente oculto (`sr-only`, no
// `display: none`), en el orden del tabulador, con su nombre accesible (la
// etiqueta del campo y el texto del botón, `aria-labelledby`) y con los nombres
// elegidos como descripción. Enter o Espacio sobre él abren el selector del
// sistema; el botón es su `<label>`, así que un clic también lo abre, y lleva
// el anillo de foco del input (`peer-focus-visible`).
//
// Controlado: quien lo usa guarda los archivos (`files`) y, al vaciarlos
// (después de subir), el input se limpia solo para poder volver a elegir el
// mismo archivo.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { IconPlus } from "@/components/icons";
import { opsButtonClass } from "@/components/ops-styles";

// Los mismos `BTN_SECONDARY_SM` y `LABEL` de header-form.tsx, sin importar ese
// módulo (trae las acciones del servidor).
const BTN_SECONDARY_SM = opsButtonClass("secondary", "sm", "pointer-coarse:h-11");
const LABEL = "grid min-w-0 content-start gap-1.5 text-[13px] font-medium leading-5 text-ink-700";

/** «Ningún archivo», el nombre del único, o «3 archivos: a.pdf, b.pdf, c.pdf». */
export function chosenFilesText(names: readonly string[]): string {
  if (!names.length) return "Ningún archivo";
  if (names.length === 1) return names[0]!;
  return `${names.length} archivos: ${names.join(", ")}`;
}

export function FilePicker({
  label,
  hint,
  files,
  onFiles,
  multiple = false,
  accept,
  max,
  disabled = false,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** Lo elegido (controlado). */
  files: readonly File[];
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  accept?: string;
  /** Tope de archivos por vez: los demás no se toman (la ayuda del campo lo dice: «Hasta 10 por vez»). */
  max?: number;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const ids = { input: `${id}-in`, label: `${id}-l`, button: `${id}-b`, status: `${id}-s`, hint: `${id}-h` };

  // Vaciado desde afuera (se subió o se canceló): el input también, para que
  // elegir el mismo archivo otra vez vuelva a avisar.
  useEffect(() => {
    if (!files.length && input.current) input.current.value = "";
  }, [files.length]);

  const names = files.map((f) => f.name);
  const status = chosenFilesText(names);
  const capped = typeof max === "number" && max > 0;

  return (
    <div className={cn(LABEL, className)}>
      <span id={ids.label}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <input
          ref={input}
          id={ids.input}
          type="file"
          className="peer sr-only"
          multiple={multiple}
          accept={accept}
          disabled={disabled}
          aria-labelledby={`${ids.label} ${ids.button}`}
          aria-describedby={hint ? `${ids.status} ${ids.hint}` : ids.status}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            onFiles(capped ? picked.slice(0, max) : picked);
          }}
        />
        <label
          htmlFor={ids.input}
          className={cn(
            BTN_SECONDARY_SM,
            "cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500",
            "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
          )}
        >
          <IconPlus aria-hidden />
          <span id={ids.button}>{multiple ? "Elegir archivos" : "Elegir archivo"}</span>
        </label>
        <span
          id={ids.status}
          title={names.length > 1 ? names.join("\n") : undefined}
          className={cn("min-w-0 flex-1 basis-32 truncate text-[13px] font-normal leading-5", names.length ? "text-ink-900" : "text-ink-500")}
        >
          {status}
        </span>
      </div>
      {hint && (
        <span id={ids.hint} className="text-xs font-normal text-ink-500">
          {hint}
        </span>
      )}
    </div>
  );
}
