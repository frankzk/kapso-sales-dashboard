import Link from "next/link";
import { getUserRoleSummary } from "@/lib/access";
import { signOut } from "./actions";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { isVendedoraOnly } = await getUserRoleSummary();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-sm font-semibold text-slate-900">
              Kapso Sales
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-600">
              {isVendedoraOnly ? (
                <Link href="/dashboard/leads" className="hover:text-slate-900">
                  Leads
                </Link>
              ) : (
                <>
                  <Link href="/dashboard" className="hover:text-slate-900">
                    Consolidado
                  </Link>
                  <Link href="/dashboard/leads" className="hover:text-slate-900">
                    Leads
                  </Link>
                  <Link href="/dashboard/stores" className="hover:text-slate-900">
                    Tiendas
                  </Link>
                  <Link href="/dashboard/team" className="hover:text-slate-900">
                    Equipo
                  </Link>
                  <Link href="/dashboard/stores/new" className="hover:text-slate-900">
                    Conectar tienda
                  </Link>
                </>
              )}
            </nav>
          </div>
          <form action={signOut}>
            <button className="text-sm text-slate-500 hover:text-slate-900">Salir</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
