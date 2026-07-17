"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/components/ui";
import { IconChat, IconGrid, IconHeadset, IconPlug, IconStore, IconTruck, IconUsers } from "@/components/icons";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
interface NavItem {
  href: string;
  label: string;
  icon: Icon;
}

function navItems(isVendedoraOnly: boolean): NavItem[] {
  if (isVendedoraOnly)
    return [
      { href: "/dashboard/leads", label: "Leads", icon: IconChat },
      { href: "/dashboard/envios", label: "Envíos", icon: IconTruck },
    ];
  return [
    { href: "/dashboard", label: "Consolidado", icon: IconGrid },
    { href: "/dashboard/leads", label: "Leads", icon: IconChat },
    { href: "/dashboard/envios", label: "Envíos", icon: IconTruck },
    { href: "/dashboard/productividad", label: "Productividad", icon: IconHeadset },
    { href: "/dashboard/stores", label: "Tiendas", icon: IconStore },
    { href: "/dashboard/team", label: "Equipo", icon: IconUsers },
    { href: "/dashboard/stores/new", label: "Conectar tienda", icon: IconPlug },
  ];
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
        <IconChat className="h-4 w-4" />
      </div>
      <span className="text-sm font-semibold text-slate-900">Kapso Sales</span>
    </div>
  );
}

export function Sidebar({
  isVendedoraOnly,
  signOut,
  userEmail,
  roleLabel,
  pendingHref,
  onNavigate,
}: {
  isVendedoraOnly: boolean;
  signOut: () => void | Promise<void>;
  userEmail?: string | null;
  roleLabel: string;
  pendingHref?: string | null;
  onNavigate?: (href: string) => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const items = navItems(isVendedoraOnly);
  const pendingPath = pendingHref?.split("?", 1)[0] ?? null;
  const displayPath = pendingPath ?? pathname;

  // Longest-prefix match so /dashboard/stores/new highlights "Conectar tienda"
  // (not "Tiendas") and bare /dashboard highlights only "Consolidado".
  const activeHref = items
    .filter((it) => displayPath === it.href || displayPath.startsWith(it.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  function prepare(href: string) {
    if (href !== pathname) router.prefetch(href);
  }

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
    onNavigate?.(href);
  }

  return (
    <>
      {/* Desktop rail */}
      <aside className="hidden md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col md:border-r md:border-slate-200 md:bg-white">
        <div className="px-5 py-4">
          <Brand />
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
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
                onClick={(event) => beginNavigation(event, it.href)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  active
                    ? "bg-brand-50 text-brand-700"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                )}
              >
                <Ico className="h-[18px] w-[18px]" />
                {it.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-200 px-3 py-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
              {(userEmail ?? "?").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-800">{userEmail ?? "Cuenta"}</p>
              <p className="text-xs text-slate-400">{roleLabel}</p>
            </div>
          </div>
          <form action={signOut}>
            <button className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm text-slate-500 transition hover:bg-slate-50 hover:text-slate-900">
              Salir
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
