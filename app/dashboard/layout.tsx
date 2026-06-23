import { getCurrentUser, getUserRoleSummary } from "@/lib/access";
import { signOut } from "./actions";
import { Sidebar } from "@/components/sidebar";

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
    <div className="min-h-screen bg-slate-50 md:flex">
      <Sidebar
        isVendedoraOnly={isVendedoraOnly}
        signOut={signOut}
        userEmail={user?.email ?? null}
        roleLabel={roleLabel}
      />
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-5 lg:px-8">{children}</main>
    </div>
  );
}
