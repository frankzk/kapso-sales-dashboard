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

  // Una entrada por organización: por RLS, un admin ve las membresías de TODOS
  // los owner/admin de su org, así que aquí pueden venir varias filas con el
  // mismo org_id (una por cada admin). Deduplicamos para no repetir la org.
  const byOrg = new Map<string, { id: string; name: string }>();
  for (const m of (data ?? []) as any[]) {
    if (!byOrg.has(m.org_id)) {
      byOrg.set(m.org_id, { id: m.org_id as string, name: (m.organizations?.name as string) ?? m.org_id });
    }
  }
  const orgs = [...byOrg.values()];

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
