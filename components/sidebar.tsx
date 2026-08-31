"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import { cn } from "@/components/ui";
import {
  IconChat,
  IconClipboard,
  IconMoney,
  IconGrid,
  IconHeadset,
  IconPlug,
  IconStore,
  IconTruck,
  IconUsers,
} from "@/components/icons";
import {
  canBackgroundPrefetch,
  panelPrefetchOrder,
  registerPanelPrefetch,
  startPanelNavigation,
} from "@/lib/client-performance";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
interface NavItem {
  href: string;
  label: string;
  icon: Icon;
}

function navItems(
  isVendedoraOnly: boolean,
  canValidatePayments: boolean,
  canManageLogistics: boolean,
): NavItem[] {
  if (isVendedoraOnly) {
    const items: NavItem[] = [
      { href: "/dashboard/leads", label: "Leads", icon: IconChat },
      { href: "/dashboard/pedidos", label: "Master de Pedidos", icon: IconClipboard },
      { href: "/dashboard/envios", label: "Repro Provincia", icon: IconTruck },
      { href: "/dashboard/envios/recuperacion", label: "Recuperar devueltos", icon: IconChat },
      { href: "/dashboard/rutas", label: "Rutas", icon: IconTruck },
      { href: "/dashboard/liquidaciones", label: "Liquidaciones", icon: IconMoney },
      // Modo solo: la página filtra server-side a la fila propia — una
      // vendedora nunca ve los resultados del resto del equipo.
      { href: "/dashboard/productividad", label: "Mi productividad", icon: IconHeadset },
    ];
    if (canValidatePayments) {
      items.splice(2, 0, { href: "/dashboard/pagos", label: "Validar pagos", icon: IconMoney });
    }
    if (canManageLogistics) {
      items.push({ href: "/dashboard/courier", label: "Grupo GF Courier", icon: IconTruck });
    }
    return items;
  }
  const items: NavItem[] = [
    { href: "/dashboard", label: "Consolidado", icon: IconGrid },
    { href: "/dashboard/leads", label: "Leads", icon: IconChat },
    { href: "/dashboard/pedidos", label: "Master de Pedidos", icon: IconClipboard },
    { href: "/dashboard/envios", label: "Repro Provincia", icon: IconTruck },
    // Primer contacto con la clienta cuya guía volvió (MOM §11.1). Va acá y no
    // dentro de Envíos porque es una COLA que se drena, no una vista de guías.
    { href: "/dashboard/envios/recuperacion", label: "Recuperar devueltos", icon: IconChat },
    { href: "/dashboard/rutas", label: "Rutas", icon: IconTruck },
    // Dato maestro de la integración con Aliclik: se configura una vez por
    // tienda, no pedido a pedido. Sin el mapeo SKU→EAN no se crea ninguna guía.
    { href: "/dashboard/envios/aliclik", label: "Catálogo Aliclik", icon: IconPlug },
    { href: "/dashboard/productividad", label: "Productividad", icon: IconHeadset },
    { href: "/dashboard/stores", label: "Tiendas", icon: IconStore },
    { href: "/dashboard/liquidaciones", label: "Liquidaciones", icon: IconMoney },
    { href: "/dashboard/costos", label: "Costos", icon: IconMoney },
    ...(canManageLogistics
      ? [{ href: "/dashboard/courier", label: "Grupo GF Courier", icon: IconTruck }]
      : []),
    { href: "/dashboard/team", label: "Equipo", icon: IconUsers },
    { href: "/dashboard/stores/new", label: "Conectar tienda", icon: IconPlug },
  ];
  if (canValidatePayments) {
    items.splice(3, 0, { href: "/dashboard/pagos", label: "Validar pagos", icon: IconMoney });
  }
  return items;
}

const SIDEBAR_COLLAPSED_KEY = "kapta.sidebar.collapsed";

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className={cn("flex items-center", collapsed ? "justify-center" : "gap-2.5")}>
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
        <IconChat className="h-4 w-4" />
      </div>
      {!collapsed && <span className="text-sm font-semibold text-slate-900">Kapso Sales</span>}
    </div>
  );
}

export function Sidebar({
  isVendedoraOnly,
  signOut,
  userEmail,
  roleLabel,
  canValidatePayments,
  canManageLogistics,
  pendingHref,
  onNavigate,
}: {
  isVendedoraOnly: boolean;
  signOut: () => void | Promise<void>;
  userEmail?: string | null;
  roleLabel: string;
  canValidatePayments: boolean;
  canManageLogistics: boolean;
  pendingHref?: string | null;
  onNavigate?: (href: string) => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const items = navItems(isVendedoraOnly, canValidatePayments, canManageLogistics);
  const pendingPath = pendingHref?.split("?", 1)[0] ?? null;
  const displayPath = pendingPath ?? pathname;

  // Se restaura antes de que el navegador pinte para evitar que el contenido
  // salte de 240 px a 64 px al recargar.
  useLayoutEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
    } catch {
      // localStorage puede estar bloqueado; el menú simplemente queda abierto.
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        // La preferencia no persiste, pero el control sigue funcionando.
      }
      return next;
    });
  }

  // Longest-prefix match so /dashboard/stores/new highlights "Conectar tienda"
  // (not "Tiendas") and bare /dashboard highlights only "Consolidado".
  const activeHref = items
    .filter((it) => displayPath === it.href || displayPath.startsWith(it.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const prepare = useCallback((href: string) => {
    if (href === pathname || !registerPanelPrefetch(href)) return;
    router.prefetch(href);
  }, [pathname, router]);

  // Warm the likely next operational panels. Requests are staggered and only
  // start while the browser is idle, never on data-saver or a 2G connection.
  // Intent (hover/focus/touch) still prefetches immediately.
  useEffect(() => {
    if (!canBackgroundPrefetch()) return;
    const timers: number[] = [];
    const idleHandles: number[] = [];
    panelPrefetchOrder(pathname, isVendedoraOnly).forEach((href, index) => {
      timers.push(window.setTimeout(() => {
        if (document.visibilityState !== "visible") return;
        const run = () => prepare(href);
        if (typeof window.requestIdleCallback === "function") {
          idleHandles.push(window.requestIdleCallback(run, { timeout: 2_000 }));
        } else {
          run();
        }
      }, 800 + index * 1_400));
    });
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      if (typeof window.cancelIdleCallback === "function") {
        idleHandles.forEach((handle) => window.cancelIdleCallback(handle));
      }
    };
  }, [isVendedoraOnly, pathname, prepare]);

  function beginNavigation(
    event: React.MouseEvent<HTMLAnchorElement>,
    href: string,
  ) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      href === pathname
    ) {
      return;
    }
    startPanelNavigation(pathname, href);
    onNavigate?.(href);
  }

  return (
    <>
      {/* Desktop rail */}
      <aside
        className={cn(
          "hidden md:sticky md:top-0 md:flex md:h-screen md:shrink-0 md:flex-col md:border-r md:border-slate-200 md:bg-white md:transition-[width] md:duration-200 md:ease-out",
          collapsed ? "md:w-16" : "md:w-60",
        )}
      >
        <div className={cn("py-4", collapsed ? "px-2" : "px-5")}>
          <Brand collapsed={collapsed} />
        </div>
        <nav
          aria-label="Navegación principal"
          className={cn("flex-1 space-y-1 overflow-y-auto py-2", collapsed ? "px-2" : "px-3")}
        >
          {items.map((it) => {
            const active = it.href === activeHref;
            const Ico = it.icon;
            return (
              <Link
                key={it.href}
                href={it.href}
                prefetch={false}
                onPointerEnter={() => prepare(it.href)}
                onFocus={() => prepare(it.href)}
                onTouchStart={() => prepare(it.href)}
                onClick={(event) => beginNavigation(event, it.href)}
                aria-current={active ? "page" : undefined}
                aria-label={collapsed ? it.label : undefined}
                title={collapsed ? it.label : undefined}
                className={cn(
                  "flex h-9 items-center rounded-lg text-sm font-medium transition",
                  collapsed ? "justify-center px-2" : "gap-3 px-3",
                  active
                    ? "bg-brand-50 text-brand-700"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                )}
              >
                <Ico className="h-[18px] w-[18px] shrink-0" />
                {!collapsed && <span className="truncate">{it.label}</span>}
              </Link>
            );
          })}
        </nav>

        <div className={cn("border-t border-slate-200 py-2", collapsed ? "px-2" : "px-3")}>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Desplegar menú lateral" : "Colapsar menú lateral"}
            title={collapsed ? "Desplegar menú" : "Colapsar menú"}
            className={cn(
              "flex h-9 w-full items-center rounded-lg text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              collapsed ? "justify-center" : "justify-between px-3",
            )}
          >
            {!collapsed && <span>Colapsar menú</span>}
            <svg
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
              className={cn("h-4 w-4 transition-transform duration-200", collapsed && "rotate-180")}
            >
              <path
                d="m12.5 4.75-5 5.25 5 5.25"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className={cn("border-t border-slate-200 py-3", collapsed ? "px-2" : "px-3")}>
          <div
            className={cn(
              "flex items-center rounded-lg py-1.5",
              collapsed ? "justify-center" : "gap-2.5 px-2",
            )}
            title={collapsed ? `${userEmail ?? "Cuenta"} · ${roleLabel}` : undefined}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
              {(userEmail ?? "?").slice(0, 1).toUpperCase()}
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{userEmail ?? "Cuenta"}</p>
                <p className="text-xs text-slate-400">{roleLabel}</p>
              </div>
            )}
          </div>
          <form action={signOut}>
            <button
              aria-label="Salir"
              title={collapsed ? "Salir" : undefined}
              className={cn(
                "mt-1 flex h-9 w-full items-center rounded-lg text-sm text-slate-500 transition hover:bg-slate-50 hover:text-slate-900",
                collapsed ? "justify-center" : "px-3 text-left",
              )}
            >
              {collapsed ? (
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                  <path
                    d="M8.25 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16h2.75M11 6.5l3.5 3.5-3.5 3.5M7.5 10h7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                "Salir"
              )}
            </button>
          </form>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <Brand />
          <form action={signOut}>
            <button className="text-sm text-slate-500 hover:text-slate-900">Salir</button>
          </form>
        </div>
        <nav className="flex items-center gap-1 overflow-x-auto px-3 pb-2 text-sm">
          {items.map((it) => {
            const active = it.href === activeHref;
            return (
              <Link
                key={it.href}
                href={it.href}
                prefetch={false}
                onPointerEnter={() => prepare(it.href)}
                onFocus={() => prepare(it.href)}
                onTouchStart={() => prepare(it.href)}
                onClick={(event) => beginNavigation(event, it.href)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-lg px-3 py-1.5 font-medium transition",
                  active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50",
                )}
              >
                {it.label}
              </Link>
            );
          })}
        </nav>
      </header>
    </>
  );
}
