import { redirect } from "next/navigation";
import { getCurrentUser, getUserRoleSummary } from "@/lib/access";
import { signOut } from "./actions";
import { DashboardShell } from "@/components/dashboard-shell";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [{ isVendedoraOnly, isRiderOnly, roles }, user] = await Promise.all([
    getUserRoleSummary(),
    getCurrentUser(),
  ]);
  // El motorizado entra al panel por costumbre o por un enlace viejo: se le
  // manda a su ruta en vez de enseñarle un panel al que RLS le vaciaría entero.
  if (isRiderOnly) redirect("/reparto");
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
