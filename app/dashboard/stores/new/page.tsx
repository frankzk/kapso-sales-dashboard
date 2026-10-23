import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/db";
import { orgsWithPermission } from "@/lib/permissions-access";
import { getUserRoleSummary } from "@/lib/access";
import { ConnectOwnAppStoreForm, CreateOrgForm, CreateStoreForm } from "@/components/forms";
import { OWN_APP_REQUIRED_SCOPES } from "@/lib/shopify-own-app";

export const dynamic = "force-dynamic";

export default async function NewStorePage() {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
  // Orgs where the current user may create stores: «Administrar tiendas» (MOM §16).
  const allowed = new Set((await orgsWithPermission("stores.manage")).map((m) => m.org_id));
  const sb = await createServerSupabase();
  const { data: rows } = await sb.from("memberships").select("org_id, role, organizations(name)");
  const data = ((rows ?? []) as any[]).filter((m) => allowed.has(m.org_id));

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
        <>
          {/* Primero la app propia (MOM §36.2): con Client ID y Client secret del
              Dev Dashboard. Pegarlos en el formulario del token de Admin API
              crearía una tienda de la app interna que después bloquea este
              camino. Cada camino lleva su título. */}
          <section className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Conectar con app propia de Shopify</h2>
              <p className="mt-1 text-sm text-slate-500">
                Dev Dashboard: Client ID + Client secret. Es el camino para una tienda nueva.
              </p>
            </div>
            <ConnectOwnAppStoreForm orgs={orgs} scopes={OWN_APP_REQUIRED_SCOPES} />
          </section>
          <section className="space-y-4 border-t border-slate-200 pt-6">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Crear tienda con token de Admin API</h2>
              <p className="mt-1 text-sm text-slate-500">
                Con un token de Admin API (shpat_…) o para instalar después con la app interna. Si tienes Client ID y
                Client secret del Dev Dashboard, usa «Conectar con app propia de Shopify», arriba.
              </p>
            </div>
            <CreateStoreForm orgs={orgs} />
          </section>
        </>
      ) : (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-5">
          <div>
            <p className="text-sm font-semibold text-slate-800">Paso 1 · Crea tu espacio de trabajo</p>
            <p className="mt-1 text-sm text-slate-500">
              Es tu organización: tú eres el <strong>dueño</strong> y solo tú (y a quien invites) verán
              su data. En el siguiente paso conectas tu tienda.
            </p>
          </div>
          <CreateOrgForm />
        </div>
      )}
    </div>
  );
}
