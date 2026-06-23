import Link from "next/link";
import { redirect } from "next/navigation";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { Card, EmptyState, SimpleTable } from "@/components/ui";
import type { StoreSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function StoresPage() {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
  const stores = await getAccessibleStores();
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Tiendas</h1>
        <Link
          href="/dashboard/stores/new"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Conectar tienda
        </Link>
      </div>

      {stores.length ? (
        <Card>
          <SimpleTable<StoreSummary>
            rows={stores}
            columns={[
              {
                key: "name",
                header: "Tienda",
                render: (s) => (
                  <Link href={`/dashboard/${s.id}`} className="font-medium text-brand-700 hover:underline">
                    {s.name}
                  </Link>
                ),
              },
              { key: "domain", header: "Dominio", render: (s) => s.shopify_domain },
              { key: "currency", header: "Moneda", render: (s) => s.currency },
              { key: "tz", header: "Zona horaria", render: (s) => s.timezone },
              { key: "status", header: "Estado", render: (s) => s.status },
            ]}
          />
        </Card>
      ) : (
        <EmptyState title="No hay tiendas conectadas">
          <Link href="/dashboard/stores/new" className="text-brand-700 hover:underline">
            Conectar la primera
          </Link>
        </EmptyState>
      )}
    </div>
  );
}
