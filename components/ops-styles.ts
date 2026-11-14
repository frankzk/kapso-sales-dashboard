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

/**
 * El aspecto de la tarjeta de estado (`StatusCard`), para quien la dibuja con
 * otro elemento: un enlace en una página de servidor (la lista de Compras,
 * cuyas pestañas viven en la URL).
 */
export function statusCardClass(active: boolean): string {
  return cn(
    "flex min-w-0 flex-col items-start gap-0.5 rounded-lg bg-white px-3.5 py-2.5 text-left transition-shadow",
    active ? "shadow-control ring-2 ring-inset ring-brand-600" : "shadow-control ring-1 ring-inset ring-line hover:ring-line-strong",
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
