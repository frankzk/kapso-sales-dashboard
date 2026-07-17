"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { YapeAlerts } from "@/components/yape-alerts";
import { DashboardRouteSkeleton } from "@/components/dashboard-route-skeleton";
import { finishPanelNavigation } from "@/lib/client-performance";

function pathOf(href: string | null): string | null {
  return href?.split("?", 1)[0] ?? null;
}

export function DashboardShell({
  children,
  isVendedoraOnly,
  signOut,
  userEmail,
  roleLabel,
  yapeAlertsEnabled,
}: {
  children: ReactNode;
  isVendedoraOnly: boolean;
  signOut: () => void | Promise<void>;
  userEmail: string | null;
  roleLabel: string;
  yapeAlertsEnabled: boolean;
}) {
  const pathname = usePathname();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const routePending = pathOf(pendingHref) !== null && pathOf(pendingHref) !== pathname;

  useEffect(() => {
    finishPanelNavigation(pathname);
    setPendingHref(null);
  }, [pathname]);

  useEffect(() => {
    if (!pendingHref) return;
    const timeout = window.setTimeout(() => setPendingHref(null), 15_000);
    return () => window.clearTimeout(timeout);
  }, [pendingHref]);

  return (
    <div className="min-h-screen bg-slate-50 md:flex">
      <Sidebar
        isVendedoraOnly={isVendedoraOnly}
        signOut={signOut}
        userEmail={userEmail}
        roleLabel={roleLabel}
        pendingHref={routePending ? pendingHref : null}
        onNavigate={setPendingHref}
      />
      <main
        className="relative min-w-0 flex-1 px-4 py-6 sm:px-5 lg:px-8"
        aria-busy={routePending || undefined}
      >
        {routePending ? <DashboardRouteSkeleton /> : children}
      </main>
      <YapeAlerts enabled={yapeAlertsEnabled} />
    </div>
  );
}
