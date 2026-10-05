"use client";

// Piezas del mundo de operación (29-09-2026): el lenguaje del panel de Stripe
// con el azul Kapta. Estrena en Despacho del día; los tokens viven en
// app/globals.css (`ink-*`, `line`, `wash`, `ok|info|warn|crit-*`, sombras).
// Botones de 6 px, chapas de 4 px, píldoras de filtro discontinuas que se
// vuelven sólidas con su valor, y tarjetas de estado con borde azul al elegir.

import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode, type SVGProps } from "react";
import { cn } from "@/components/ui";
import { opsButtonClass, type ButtonSize, type ButtonVariant } from "@/components/ops-styles";
import { IconAlert, IconCheck, IconCheckCircle, IconInfo, IconPlusCircle, IconXCircle } from "@/components/icons";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * El campo sin alto, ancho ni relleno lateral. `cn` solo junta clases: no
 * resuelve conflictos, y en el CSS de Tailwind `h-9` va detrás de `h-8` y
 * `w-full` detrás de `w-44`, así que `cn(FIELD, "h-8 w-44")` se quedaba en
 * 36 px a todo el ancho sin avisar. Quien necesite otro tamaño parte de aquí y
 * pone los tres.
 */
export const FIELD_BOX =
  "block min-w-0 rounded-md border-0 bg-white text-sm text-ink-900 shadow-control ring-1 ring-inset ring-line-strong placeholder:text-ink-500 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:bg-wash disabled:text-ink-500";

/** Campo de texto o selector: 36 px, anillo fino, foco azul. */
export const FIELD = `${FIELD_BOX} h-9 w-full px-3`;

/** Casilla nativa con el azul de la marca. */
export const CHECKBOX = "size-4 shrink-0 cursor-pointer rounded accent-brand-600";

export { opsButtonClass };

export const OpsButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }>(
  function OpsButton({ variant = "secondary", size = "md", className, type = "button", ...rest }, ref) {
    return <button ref={ref} type={type} className={opsButtonClass(variant, size, className)} {...rest} />;
  },
);

export type BadgeTone = "neutral" | "info" | "ok" | "warn" | "crit" | "urgent" | "brand";

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "bg-line text-ink-600",
  info: "bg-info-bg text-info-fg",
  ok: "bg-ok-bg text-ok-fg",
  warn: "bg-warn-bg text-warn-fg",
  crit: "bg-crit-bg text-crit-fg",
  urgent: "bg-urgent text-white",
  brand: "bg-brand-50 text-brand-700",
};

/** Chapa de estado: 20 px de alto, 4 px de radio, texto de 12 px. */
export function Badge({ tone = "neutral", title, className, wrap = false, children }: { tone?: BadgeTone; title?: string; className?: string; /** Texto largo: parte en líneas en vez de cortarse. */ wrap?: boolean; children: ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex max-w-full items-center gap-1 rounded px-1.5 text-xs font-medium", wrap ? "min-h-5 py-0.5 leading-tight" : "h-5 truncate whitespace-nowrap leading-none", BADGE_TONE[tone], className)}>
      {children}
    </span>
  );
}

/**
 * Píldora de filtro: discontinua con «+» cuando no filtra; sólida, con su
 * valor en azul y una «x» para quitarlo, cuando filtra. Un filtro de sí/no
 * (`toggle`) se enciende y apaga con el mismo toque.
 */
export const FilterPill = forwardRef<HTMLButtonElement, {
  label: string;
  /** Lo que filtra ahora; vacío = sin filtrar. */
  value?: string | null;
  /** Filtro de sí/no encendido (sin valor que mostrar). */
  active?: boolean;
  count?: number;
  onClick: () => void;
  onClear?: () => void;
  expanded?: boolean;
  /** Filtro de sí/no: el estado que anuncia el lector de pantalla. */
  pressed?: boolean;
  /** Id del texto que explica la regla del filtro. */
  describedBy?: string;
  title?: string;
}>(function FilterPill({ label, value, active, count, onClick, onClear, expanded, pressed, describedBy, title }, ref) {
  const countNode = count != null && <span className="tabular-nums text-ink-500">{count.toLocaleString("es-PE")}</span>;
  if (!value && !active) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-expanded={expanded}
        aria-pressed={pressed}
        aria-describedby={describedBy}
        title={title}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-line-strong bg-white pl-2 pr-3 text-[13px] font-medium text-ink-600 transition-colors hover:border-ink-300 hover:text-ink-900 pointer-coarse:h-11"
      >
        <IconPlusCircle className="size-3.5 text-ink-500" />
        {label}
        {countNode}
      </button>
    );
  }
  return (
    <span className="inline-flex h-8 shrink-0 items-center rounded-full bg-white text-[13px] font-medium shadow-control ring-1 ring-inset ring-line-strong pointer-coarse:h-11">
      {onClear && (
        <button type="button" onClick={onClear} aria-label={`Quitar el filtro ${label}`} className="grid h-8 w-7 place-items-center rounded-l-full pl-1 text-ink-500 hover:text-ink-900 pointer-coarse:h-11 pointer-coarse:w-10">
          <IconXCircle className="size-3.5" />
        </button>
      )}
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-expanded={expanded}
        aria-pressed={pressed}
        aria-describedby={describedBy}
        title={title}
        className={cn("inline-flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-r-full pr-3 text-ink-700 hover:text-ink-900 pointer-coarse:h-11", !onClear && "rounded-l-full pl-3")}
      >
        {value ? (
          <>
            {label}
            <span aria-hidden className="h-3.5 w-px bg-line-strong" />
            <span className="max-w-[14rem] truncate text-brand-700">{value}</span>
          </>
        ) : (
          <span className="text-brand-700">{label}</span>
        )}
        {countNode}
      </button>
    </span>
  );
});

/**
 * Tarjeta de estado: etiqueta y cifra; elegida lleva el borde azul de 2 px.
 * Es un filtro, no un adorno: tocarla abre esa parte de la lista.
 */
export function StatusCard({ label, value, active, onClick, hint, marker }: {
  label: string;
  value: number;
  active: boolean;
  onClick: () => void;
  hint?: string;
  /** Marca de color antes de la etiqueta (p. ej. el tono de la macroetapa del MOM). */
  marker?: ReactNode;
}) {
  const labelTone = active ? "text-brand-700" : "text-ink-600";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={hint}
      className={cn(
        "flex min-w-0 flex-col items-start gap-0.5 rounded-lg bg-white px-3.5 py-2.5 text-left transition-shadow",
        active ? "shadow-control ring-2 ring-inset ring-brand-600" : "shadow-control ring-1 ring-inset ring-line hover:ring-line-strong",
      )}
    >
      {marker ? (
        <span className={cn("flex w-full min-w-0 items-center gap-1.5 text-[13px] font-medium", labelTone)}>
          {marker}
          <span className="truncate">{label}</span>
        </span>
      ) : (
        <span className={cn("w-full truncate text-[13px] font-medium", labelTone)}>{label}</span>
      )}
      <span className={cn("text-xl font-semibold leading-7 tabular-nums", active ? "text-brand-700" : "text-ink-900")}>{value.toLocaleString("es-PE")}</span>
    </button>
  );
}

/** Chip de elección con cantidad (subetapas, plazos, motivos, filtro de cajas). */
export function ChoiceChip({ label, count, active, onClick, title }: { label: string; count?: number; active: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={count === 0 && !active}
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium transition-shadow pointer-coarse:h-11",
        active ? "bg-brand-50 text-brand-700 ring-2 ring-inset ring-brand-600" : "bg-white text-ink-700 ring-1 ring-inset ring-line-strong hover:ring-ink-300",
        count === 0 && !active && "cursor-not-allowed opacity-40",
      )}
    >
      {label}
      {count != null && <span className={cn("tabular-nums", active ? "text-brand-700" : "text-ink-500")}>{count.toLocaleString("es-PE")}</span>}
    </button>
  );
}

/** Píldora de excepción («Devoluciones 4»): lo que espera al borde de la tarea. */
export function AttentionPill({ icon: Glyph, label, count, active, onClick, hint }: { icon: Icon; label: string; count: number; active: boolean; onClick: () => void; hint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={hint}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white pl-2.5 pr-1.5 text-[13px] font-medium shadow-control transition-shadow pointer-coarse:h-11",
        active ? "text-brand-700 ring-2 ring-inset ring-brand-600" : "text-ink-700 ring-1 ring-inset ring-line-strong hover:ring-ink-300",
      )}
    >
      <Glyph className={cn("size-4", active ? "text-brand-600" : "text-ink-500")} />
      {label}
      <Badge tone={count > 0 ? "warn" : "neutral"} className="tabular-nums">{count.toLocaleString("es-PE")}</Badge>
    </button>
  );
}

/**
 * Panel lateral del mundo de operación (la caja y el reparto de una ruta):
 * velo de tinta sin desenfoque, hoja blanca con sombra de popover y una
 * cabecera pegajosa con título, chapa de estado, contexto y cierre. El ancho
 * lo decide quien lo abre (`width`, p. ej. `max-w-[960px]`).
 */
export function SidePanel({ label, title, badge, meta, width, onClose, children }: {
  /** Nombre accesible del diálogo. */
  label: string;
  title: ReactNode;
  badge?: ReactNode;
  meta?: ReactNode;
  width: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Diálogo modal: el foco entra al abrir (sin saltar el scroll) y vuelve a
  // donde estaba al cerrar, p. ej. al enlace de la fila de Rutas.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => { if (before?.isConnected) before.focus({ preventScroll: true }); };
  }, []);
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-ink-900/30" onClick={onClose}>
      <aside
        ref={panel}
        tabIndex={-1}
        // La hoja recibe el foco solo para que el lector y Tab empiecen dentro;
        // no es un control, así que sin anillo (el global de globals.css va
        // fuera de capa y ganaría a una clase `outline-none`).
        style={{ outline: "none" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cn("flex h-full w-full flex-col overflow-y-auto overscroll-contain bg-white shadow-pop", width)}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 bg-white px-4 pb-3 pt-4 shadow-[inset_0_-1px_0_var(--color-line)] sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h2 className="min-w-0 truncate text-lg font-semibold leading-7 text-ink-900">{title}</h2>
              {badge}
            </div>
            {meta && <p className="mt-0.5 text-[13px] tabular-nums text-ink-500">{meta}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900">
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div className="flex-1 px-4 py-5 sm:px-6">{children}</div>
      </aside>
    </div>
  );
}

/**
 * Tarjeta de sección (la ficha del pedido): blanca sobre el lienzo, con anillo
 * `line` y sombra de control. Arriba lleva su `SectionHead`; lo de dentro se
 * reparte en zonas sobre hairlines de borde a borde (`CARD_ZONE`), nunca en
 * otra tarjeta. Una sección que se notaba poco era una hairline gris clara
 * más débil que los marcos de dentro: al entornar los ojos se veían marcos,
 * no secciones.
 */
export const SECTION_CARD = "rounded-lg bg-white p-4 shadow-control ring-1 ring-line sm:p-5";

/**
 * Una zona dentro de la tarjeta de sección, sobre una hairline que la cruza
 * entera. Los márgenes negativos son el relleno de `SECTION_CARD`: si cambia
 * uno, cambia el otro.
 */
export const CARD_ZONE = "-mx-4 border-t border-line px-4 pt-4 sm:-mx-5 sm:px-5 sm:pt-5";

/**
 * Cabecera de una tarjeta de sección: título de 16 px con su chapa, la ayuda
 * debajo y, a la derecha, lo que no guarda nada (un enlace, un contador). La
 * hairline de debajo cruza la tarjeta entera, como la de `CARD_ZONE`.
 */
export function SectionHead({ title, badge, help, aside, id }: {
  title: ReactNode;
  badge?: ReactNode;
  help?: ReactNode;
  aside?: ReactNode;
  /** Para `aria-labelledby` de la sección. */
  id?: string;
}) {
  return (
    <div className="-mx-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 pb-4 sm:-mx-5 sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 id={id} className="text-base font-semibold leading-6 text-ink-900">{title}</h3>
          {badge}
        </div>
        {help && <div className="mt-0.5 max-w-[68ch] text-[13px] leading-5 text-ink-500">{help}</div>}
      </div>
      {aside && <div className="flex flex-wrap items-center gap-x-3 gap-y-2">{aside}</div>}
    </div>
  );
}

/**
 * Tarjeta-opción: una elección a la vista (el resultado de una llamada, una
 * ruta, qué hacer con una novedad), con título de 14 px y su consecuencia en
 * 13 px; elegida, el anillo azul de 2 px. La que no se deshace lleva el título
 * en `crit-fg`. Es la de la mesa de cierre de la ficha, hecha pieza.
 */
export function OptionTile({
  label,
  description,
  active,
  danger,
  disabled,
  badge,
  aside,
  onClick,
}: {
  label: string;
  description?: string;
  active: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Chapa junto al título («Más barata», «Express»). */
  badge?: ReactNode;
  /** Lo que se compara entre opciones (un precio), a la derecha del título. */
  aside?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // `flex-col`: en una rejilla la fila estira el botón, y un botón centra
        // su contenido; así empieza arriba como sus vecinas.
        "flex flex-col rounded-lg px-3 py-2.5 text-left transition-shadow disabled:cursor-not-allowed pointer-coarse:min-h-11",
        active
          ? "bg-brand-50 ring-2 ring-inset ring-brand-600"
          : "bg-white ring-1 ring-inset ring-line-strong hover:ring-ink-300",
      )}
    >
      {/* Apagada, se atenúa el título y no la explicación: el porqué de que no
          se pueda elegir es justo lo que hay que leer. */}
      <span className={cn("flex items-start justify-between gap-3", disabled && "opacity-50")}>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              "text-sm font-semibold leading-5",
              danger ? "text-crit-fg" : active ? "text-brand-700" : "text-ink-900",
            )}
          >
            {label}
          </span>
          {badge}
        </span>
        {aside && <span className="shrink-0 text-sm font-semibold leading-5 tabular-nums text-ink-900">{aside}</span>}
      </span>
      {description && <span className="mt-0.5 block text-[13px] leading-5 text-ink-600">{description}</span>}
    </button>
  );
}

/**
 * Un paso de un registro en varios pasos (el cobro, la guía de Aliclik): el
 * disco con su número —o el visto cuando está hecho, como el recorrido de la
 * ficha—, el título con su estado en chapa, la ayuda y lo suyo debajo. La línea
 * que baja al siguiente paso se pinta en tinta cuando este ya está hecho. Va
 * dentro de un `<ol>`.
 */
export function Step({
  n,
  title,
  done,
  badge,
  help,
  last = false,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  badge?: ReactNode;
  help?: ReactNode;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={cn("relative pl-9", !last && "pb-6")}>
      {!last && (
        <span
          aria-hidden="true"
          className={cn("absolute bottom-0 left-[11px] top-7 w-px", done ? "bg-ink-500" : "bg-line-strong")}
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-0 grid size-6 place-items-center rounded-full text-xs font-semibold tabular-nums",
          done ? "bg-ink-900 text-white" : "bg-white text-ink-600 ring-1 ring-inset ring-line-strong",
        )}
      >
        {done ? <IconCheck className="size-3.5" strokeWidth={2.6} /> : n}
      </span>
      <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
        <h5 className="text-sm font-semibold text-ink-900">
          <span className="sr-only">Paso {n}: </span>
          {title}
          {done && <span className="sr-only"> (hecho)</span>}
        </h5>
        {badge}
      </div>
      {help && <p className="mt-0.5 max-w-[68ch] text-[13px] leading-5 text-ink-500">{help}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </li>
  );
}

/** Esqueleto de carga: bloques en el lavado, sin brillo que se mueva. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-lg bg-wash", className)} />;
}

const BANNER: Record<"ok" | "info" | "warn" | "crit", { wash: string; fg: string; icon: Icon }> = {
  ok: { wash: "bg-ok-wash", fg: "text-ok-fg", icon: IconCheckCircle },
  info: { wash: "bg-info-wash", fg: "text-info-fg", icon: IconInfo },
  warn: { wash: "bg-warn-wash", fg: "text-warn-fg", icon: IconAlert },
  crit: { wash: "bg-crit-wash", fg: "text-crit-fg", icon: IconAlert },
};

/** Aviso en la página: fondo tenue del tono, icono del tono y texto en tinta. */
export function Banner({ tone, title, children, role, className }: { tone: keyof typeof BANNER; title?: ReactNode; children?: ReactNode; role?: "alert" | "status"; className?: string }) {
  const t = BANNER[tone];
  const Glyph = t.icon;
  return (
    <div role={role} className={cn("flex gap-3 rounded-lg px-4 py-3 text-sm text-ink-700", t.wash, className)}>
      <Glyph className={cn("mt-px size-4 shrink-0", t.fg)} />
      <div className="min-w-0 flex-1">
        {title && <p className={cn("font-semibold", t.fg)}>{title}</p>}
        {children}
      </div>
    </div>
  );
}
