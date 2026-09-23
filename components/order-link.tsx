"use client";

// Enlaces que abren la ficha del pedido SOBRE la pantalla actual (MOM §25).
//
// Antes cada «Ver actividad» mandaba al Master de Pedidos con `?q=…&abrir=…`:
// la persona perdía la cola de despacho, la ruta o la hoja en la que estaba.
// Ahora el enlace solo cambia la query (`?ficha=<pedido>`), la ficha global
// (order-drawer-host.tsx) la ve y se abre encima; al cerrar se vuelve a la
// misma pantalla con los mismos filtros.
//
// Se usa `history.pushState`, que Next sincroniza con `useSearchParams`, y no
// `router.push`: cambiar la query con el router vuelve a pedir la página al
// servidor, y en Liquidaciones 2 o Despacho eso son segundos por cada clic.
// El `href` sigue siendo real: botón central, «abrir en pestaña nueva» y
// copiar el enlace funcionan, y esa URL abre la ficha al cargar.

import { useCallback, type MouseEvent, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { orderDrawerHref, type OrderDrawerSection } from "@/lib/order-drawer-href";

function isPlainLeftClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** URL de la ficha de un pedido en la pantalla actual. */
export function useOrderDrawerHref(): (orderId: string, section?: OrderDrawerSection | null) => string {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return useCallback(
    (orderId: string, section?: OrderDrawerSection | null) => orderDrawerHref(orderId, section, { pathname, search }),
    [pathname, search],
  );
}

/** Abre la ficha de un pedido sin salir de la pantalla. */
export function useOpenOrderDrawer(): (orderId: string, section?: OrderDrawerSection | null) => void {
  const hrefOf = useOrderDrawerHref();
  return useCallback(
    (orderId: string, section?: OrderDrawerSection | null) => {
      window.history.pushState(null, "", hrefOf(orderId, section));
    },
    [hrefOf],
  );
}

/**
 * `<a>` que abre la ficha en el sitio. Sustituye a los
 * `<Link href="/dashboard/pedidos?q=…">` que había en despacho, rutas,
 * courier, validación de pagos y Liquidaciones 2.
 */
export function OrderLink({
  orderId,
  section,
  className,
  title,
  children,
}: {
  orderId: string;
  section?: OrderDrawerSection | null;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const hrefOf = useOrderDrawerHref();
  const href = hrefOf(orderId, section);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    window.history.pushState(null, "", href);
  };
  return (
    <a href={href} onClick={onClick} className={className} title={title ?? "Abrir la ficha del pedido"}>
      {children}
    </a>
  );
}
