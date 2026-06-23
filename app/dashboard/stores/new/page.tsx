import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/db";
import { getUserRoleSummary } from "@/lib/access";
import { CreateOrgForm, CreateStoreForm } from "@/components/forms";

export const dynamic = "force-dynamic";

export default async function NewStorePage() {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
  // Orgs where the current user is owner/admin (can create stores).
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("memberships")
    .select("org_id, role, organizations(name)")
    .in("role", ["owner", "admin"]);

  const orgs = (data ?? []).map((m: any) => ({
    id: m.org_id as string,
    name: (m.organizations?.name as string) ?? m.org_id,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Conectar tienda</h1>
        <p className="mt-1 text-sm text-slate-500">
          Las credenciales se cifran (AES-GCM) y se guardan en la base. No se exponen al navegador
          ni se incluyen en el repositorio.
        </p>
      </div>

      {orgs.length ? (
        <CreateStoreForm orgs={orgs} />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Primero crea una organización; serás su <strong>owner</strong>.
          </p>
          <CreateOrgForm />
        </div>
      )}
    </div>
  );
}
