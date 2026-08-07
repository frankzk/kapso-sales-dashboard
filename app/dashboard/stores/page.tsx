import Link from "next/link";
import { redirect } from "next/navigation";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { getAnomalyReport } from "@/lib/leads-access";
import { Card, EmptyState, SimpleTable } from "@/components/ui";
import type { AnomalyReportRow } from "@/lib/ingest-anomalies";
import type { StoreSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function StoresPage() {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
  const stores = await getAccessibleStores();
  // Diagnóstico, no operación: vive acá y no en la cabecera de Leads porque las
  // asesoras leen esa línea todo el día buscando trabajo accionable. Esta página
  // ya redirige a las vendedoras, así que queda fuera de su vista por
  // construcción y no hace falta un permiso aparte.
  const anomalias = await getAnomalyReport(
    stores.map((s) => s.id),
    stores[0]?.timezone ?? "America/Lima",
  );
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
              {
                key: "actions",
                header: "",
                render: (s) => (
                  <Link
                    href={`/dashboard/${s.id}/settings`}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    ⚙️ Ajustes
                  </Link>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      {anomalias.filas.length > 0 ? (
        <Card>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">
              Anomalías de ingesta{" "}
              <span className="font-normal text-slate-400">· últimos 7 días</span>
            </h2>
            <p className="text-xs text-slate-500">
              <span className="font-semibold text-slate-700">{anomalias.hoy}</span> hoy ·{" "}
              {anomalias.ayer} ayer
            </p>
          </div>
          <p className="mb-3 text-xs text-slate-500">
            Trabajo que la ingesta descartó: conversaciones, handoffs o pasos que no
            llegaron a convertirse en nada. <strong>Lo que importa es el salto</strong>,
            no el nivel — un motivo con el mismo número todos los días es rutina
            conocida; uno que aparece de golpe es algo que empezó a fallar.
          </p>
          <SimpleTable<AnomalyReportRow>
            rows={anomalias.filas}
            columns={[
              { key: "source", header: "Camino", render: (r) => r.source },
              { key: "reason", header: "Motivo", render: (r) => r.reason },
              {
                key: "hoy",
                header: "Hoy",
                render: (r) => (
                  <span className={r.hoy > 0 && r.ayer === 0 ? "font-semibold text-amber-700" : ""}>
                    {r.hoy}
                  </span>
                ),
              },
              { key: "ayer", header: "Ayer", render: (r) => r.ayer },
              { key: "total", header: "7 días", render: (r) => r.total },
              {
                key: "sample",
                header: "Ejemplo",
                render: (r) => (
                  <code className="text-[11px] text-slate-500">
                    {r.sample ? JSON.stringify(r.sample).slice(0, 90) : "—"}
                  </code>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      {!stores.length ? (
        <EmptyState title="No hay tiendas conectadas">
          <Link href="/dashboard/stores/new" className="text-brand-700 hover:underline">
            Conectar la primera
          </Link>
        </EmptyState>
      ) : null}
    </div>
  );
}
