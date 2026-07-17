import { getCurrentUser, getUserRoleSummary } from "@/lib/access";
import { signOut } from "./actions";
import { DashboardShell } from "@/components/dashboard-shell";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [{ isVendedoraOnly, roles }, user] = await Promise.all([
    getUserRoleSummary(),
    getCurrentUser(),
  ]);
  const roleLabel = isVendedoraOnly
    ? "Vendedora"
    : roles.includes("owner") || roles.includes("admin")
      ? "Administrador"
      : "Equipo";

  return (
    <DashboardShell
      isVendedoraOnly={isVendedoraOnly}
      signOut={signOut}
      userEmail={user?.email ?? null}
      roleLabel={roleLabel}
      yapeAlertsEnabled={roles.includes("vendedora")}
    >
      {children}
    </DashboardShell>
  );
}
