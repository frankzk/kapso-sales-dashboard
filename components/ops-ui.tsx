"use client";

// Piezas del mundo de operación (29-09-2026): el lenguaje del panel de Stripe
// con el azul Kapta. Estrena en Despacho del día; los tokens viven en
// app/globals.css (`ink-*`, `line`, `wash`, `ok|info|warn|crit-*`, sombras).
// Botones de 6 px, chapas de 4 px, píldoras de filtro discontinuas que se
// vuelven sólidas con su valor, y tarjetas de estado con borde azul al elegir.

import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode, type SVGProps } from "react";
import { cn } from "@/components/ui";
import { IconAlert, IconCheckCircle, IconInfo, IconPlusCircle, IconXCircle } from "@/components/icons";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** Campo de texto o selector: 36 px, anillo fino, foco azul. */
export const FIELD =
  "block h-9 w-full min-w-0 rounded-md border-0 bg-white px-3 text-sm text-ink-900 shadow-control ring-1 ring-inset ring-line-strong placeholder:text-ink-500 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:bg-wash disabled:text-ink-500";

/** Casilla nativa con el azul de la marca. */
export const CHECKBOX = "size-4 shrink-0 cursor-pointer rounded accent-brand-600";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white shadow-primary hover:bg-brand-700 disabled:hover:bg-brand-600",
  secondary: "bg-white text-ink-700 shadow-control ring-1 ring-inset ring-line-strong hover:bg-wash hover:text-ink-900 disabled:hover:bg-white",
  ghost: "text-ink-600 hover:bg-wash hover:text-ink-900 disabled:hover:bg-transparent",
  danger: "bg-white text-crit-fg shadow-control ring-1 ring-inset ring-line-strong hover:bg-crit-wash disabled:hover:bg-white",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-[13px]",
  md: "h-9 gap-1.5 px-3 text-sm",
  lg: "h-11 gap-2 px-4 text-sm",
};

export const OpsButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }>(
  function OpsButton({ variant = "secondary", size = "md", className, type = "button", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-semibold transition-[background-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
          BUTTON_VARIANT[variant],
          BUTTON_SIZE[size],
          className,
        )}
        {...rest}
      />
    );
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
export function Badge({ tone = "neutral", title, className, children }: { tone?: BadgeTone; title?: string; className?: string; children: ReactNode }) {
  return (
    <span title={title} className={cn("inline-flex h-5 max-w-full items-center gap-1 truncate whitespace-nowrap rounded px-1.5 text-xs font-medium leading-none", BADGE_TONE[tone], className)}>
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
  title?: string;
}>(function FilterPill({ label, value, active, count, onClick, onClear, expanded, title }, ref) {
  const countNode = count != null && <span className="tabular-nums text-ink-500">{count.toLocaleString("es-PE")}</span>;
  if (!value && !active) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-expanded={expanded}
        title={title}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-line-strong bg-white pl-2 pr-3 text-[13px] font-medium text-ink-600 transition-colors hover:border-ink-300 hover:text-ink-900"
      >
        <IconPlusCircle className="size-3.5 text-ink-500" />
        {label}
        {countNode}
      </button>
    );
  }
  return (
    <span className="inline-flex h-8 shrink-0 items-center rounded-full bg-white text-[13px] font-medium shadow-control ring-1 ring-inset ring-line-strong">
      {onClear && (
        <button type="button" onClick={onClear} aria-label={`Quitar el filtro ${label}`} className="grid h-8 w-7 place-items-center rounded-l-full pl-1 text-ink-500 hover:text-ink-900">
          <IconXCircle className="size-3.5" />
        </button>
      )}
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-expanded={expanded}
        title={title}
        className={cn("inline-flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-r-full pr-3 text-ink-700 hover:text-ink-900", !onClear && "rounded-l-full pl-3")}
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
export function StatusCard({ label, value, active, onClick, hint }: { label: string; value: number; active: boolean; onClick: () => void; hint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={hint}
      className={cn(
        "flex min-w-[8.75rem] shrink-0 snap-start flex-col items-start gap-0.5 rounded-lg bg-white px-3.5 py-2.5 text-left transition-shadow lg:min-w-0",
        active ? "shadow-control ring-2 ring-inset ring-brand-600" : "shadow-control ring-1 ring-inset ring-line hover:ring-line-strong",
      )}
    >
      <span className={cn("w-full truncate text-[13px] font-medium", active ? "text-brand-700" : "text-ink-600")}>{label}</span>
      <span className={cn("text-xl font-semibold leading-7 tabular-nums", active ? "text-brand-700" : "text-ink-900")}>{value.toLocaleString("es-PE")}</span>
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
        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white pl-2.5 pr-1.5 text-[13px] font-medium shadow-control transition-shadow",
        active ? "text-brand-700 ring-2 ring-inset ring-brand-600" : "text-ink-700 ring-1 ring-inset ring-line-strong hover:ring-ink-300",
      )}
    >
      <Glyph className={cn("size-4", active ? "text-brand-600" : "text-ink-500")} />
      {label}
      <Badge tone={count > 0 ? "warn" : "neutral"} className="tabular-nums">{count.toLocaleString("es-PE")}</Badge>
    </button>
  );
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
