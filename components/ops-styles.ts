// Clases del mundo de operación que también necesita el servidor.
//
// Viven fuera de components/ops-ui.tsx porque ese módulo es "use client": una
// función exportada desde ahí llega a un componente de servidor como
// referencia de cliente, y llamarla falla. Un enlace con aspecto de botón en
// una página de servidor (p. ej. «Conectar tienda» en /dashboard/stores) saca
// sus clases de aquí.

import { cn } from "@/components/ui";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

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

/** Las clases de `OpsButton`, para un enlace que tiene que verse como botón. */
export function opsButtonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string): string {
  return cn(
    "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-semibold transition-[background-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    BUTTON_VARIANT[variant],
    BUTTON_SIZE[size],
    className,
  );
}
