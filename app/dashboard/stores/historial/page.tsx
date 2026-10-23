// Historial de Shopify (MOM §37): los pedidos y clientes de antes de Kapta,
// subidos desde las exportaciones del propio Shopify. Solo consulta: no son
// pedidos del Master.

import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerSupabase } from "@/lib/db";
import { getAccessibleStores, getUserRoleSummary } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { normalizePhone } from "@/lib/phone";
import { Card, Section } from "@/components/ui";
import { Badge } from "@/components/ops-ui";
import { ShopifyHistoryUpload } from "@/components/shopify-history-upload";
import { ShopifyHistoryApiProbe } from "@/components/shopify-history-api";

export const dynamic = "force-dynamic";

type HistoryOrderRow = {
  order_name: string;
  created_at: string | null;
  customer_name: string | null;
  phone: string | null;
  email: string | null;
  shipping_city: string | null;
  shipping_province: string | null;
  total: number | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  cancelled_at: string | null;
  line_items: { name: string; quantity: number }[] | null;
};

type HistoryCustomerRow = {
  customer_key: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  province: string | null;
  total_spent: number | null;
  total_orders: number | null;
  accepts_marketing: string | null;
  tags: string | null;
  note: string | null;
};

type FileRow = {
  id: string;
  kind: string;
  filename: string;
  status: string;
  records: number;
  rows_read: number;
  first_at: string | null;
  last_at: string | null;
  error: string | null;
  created_at: string;
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const fmtMoney = (n: number | null) => (n == null ? "—" : `S/ ${Number(n).toFixed(2)}`);

export default async function ShopifyHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ tienda?: string; q?: string }>;
}) {
  if ((await getUserRoleSummary()).isVendedoraOnly) redirect("/dashboard/leads");
  if (!(await getMasterPermissions()).can("data.export")) redirect("/dashboard");
  const params = await searchParams;
  const stores = await getAccessibleStores();
  if (!stores.length) redirect("/dashboard");
  const store = stores.find((s) => s.id === params.tienda) ?? stores.find((s) => /aurela/i.test(s.name)) ?? stores[0]!;
  const q = (params.q ?? "").trim();

  const sb = await createServerSupabase();
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear - 2019 + 1 }, (_, i) => 2019 + i);
  const [yearCounts, customersCount, filesRes] = await Promise.all([
    Promise.all(
      years.map(async (y) => {
        const { count } = await sb
          .from("shopify_history_orders")
          .select("order_name", { count: "exact", head: true })
          .eq("store_id", store.id)
          .gte("created_at", `${y}-01-01T05:00:00Z`)
          .lt("created_at", `${y + 1}-01-01T05:00:00Z`);
        return { year: y, count: count ?? 0 };
      }),
    ),
    sb.from("shopify_history_customers").select("customer_key", { count: "exact", head: true }).eq("store_id", store.id),
    sb
      .from("shopify_history_files")
      .select("id,kind,filename,status,records,rows_read,first_at,last_at,error,created_at")
      .eq("store_id", store.id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  const totalOrders = yearCounts.reduce((s, y) => s + y.count, 0);
  const files = (filesRes.data ?? []) as FileRow[];

  // Un celular (o un correo) es una clienta: se ven todas sus compras, su total
  // y su ficha del CSV de clientes si se cargó.
  const phone = normalizePhone(q);
  const byPhone = Boolean(q && phone && phone.length >= 9);
  const byEmail = Boolean(q && !byPhone && q.includes("@"));
  let results: HistoryOrderRow[] = [];
  let customers: HistoryCustomerRow[] = [];
  if (q) {
    let query = sb
      .from("shopify_history_orders")
      .select(
        "order_name,created_at,customer_name,phone,email,shipping_city,shipping_province,total,financial_status,fulfillment_status,cancelled_at,line_items",
      )
      .eq("store_id", store.id);
    if (byPhone) {
      query = query.eq("phone_norm", phone!);
    } else if (byEmail) {
      query = query.ilike("email", q);
    } else if (/^#?[A-Za-z]*\d{3,}$/.test(q)) {
      query = query.ilike("order_name", `%${q.replace(/^#/, "")}%`);
    } else {
      const safe = q.replace(/[%,()]/g, " ");
      query = query.or(`customer_name.ilike.%${safe}%,shipping_name.ilike.%${safe}%`);
    }
    const customerQuery =
      byPhone || byEmail
        ? sb
            .from("shopify_history_customers")
            .select("customer_key,first_name,last_name,email,phone,city,province,total_spent,total_orders,accepts_marketing,tags,note")
            .eq("store_id", store.id)
            .filter(byPhone ? "phone_norm" : "email", byPhone ? "eq" : "ilike", byPhone ? phone! : q)
            .limit(5)
        : null;
    const [{ data }, customerRes] = await Promise.all([
      query.order("created_at", { ascending: false }).limit(200),
      customerQuery ?? Promise.resolve({ data: [] }),
    ]);
    results = (data ?? []) as HistoryOrderRow[];
    customers = (customerRes.data ?? []) as HistoryCustomerRow[];
  }
  const boughtTotal = results.filter((r) => !r.cancelled_at).reduce((s, r) => s + Number(r.total ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Historial de Shopify</h1>
        <p className="text-sm text-ink-600">
          Pedidos y clientes de antes de Kapta, guardados desde las exportaciones de Shopify. Es solo consulta: no entran al
          Master ni mueven nada.
        </p>
      </div>

      {stores.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {stores.map((s) => (
            <Link
              key={s.id}
              href={`?tienda=${s.id}`}
              className={`rounded-full border px-3 py-1 text-[13px] ${s.id === store.id ? "border-brand-600 bg-brand-50 text-brand-700" : "border-line text-ink-700"}`}
            >
              {s.name}
            </Link>
          ))}
        </div>
      )}

      <Card>
        <Section title={`Cargar archivos · ${store.name}`}>
          <ShopifyHistoryUpload key={store.id} storeId={store.id} storeName={store.name} />
        </Section>
      </Card>

      <Card>
        <Section
          title="Traer desde Shopify por API"
          subtitle="Si Kapta ve los pedidos antiguos, el historial se puede traer completo sin exportar a mano."
        >
          <ShopifyHistoryApiProbe storeId={store.id} />
        </Section>
      </Card>

      <Card>
        <Section
          title="Lo que hay guardado"
          subtitle={`${totalOrders.toLocaleString("es-PE")} pedidos · ${(customersCount.count ?? 0).toLocaleString("es-PE")} clientes`}
        >
          <div className="flex flex-wrap gap-2">
            {yearCounts
              .filter((y) => y.count > 0)
              .map((y) => (
                <Badge key={y.year}>
                  {y.year}: {y.count.toLocaleString("es-PE")}
                </Badge>
              ))}
            {totalOrders === 0 && <p className="text-[13px] text-ink-500">Todavía no se cargó ningún pedido.</p>}
          </div>
          {files.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="text-left text-ink-500">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Archivo</th>
                    <th className="py-1 pr-3 font-medium">Tipo</th>
                    <th className="py-1 pr-3 font-medium">Estado</th>
                    <th className="py-1 pr-3 font-medium">Registros</th>
                    <th className="py-1 pr-3 font-medium">Desde</th>
                    <th className="py-1 pr-3 font-medium">Hasta</th>
                    <th className="py-1 font-medium">Subido</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => (
                    <tr key={f.id} className="border-t border-line">
                      <td className="py-1.5 pr-3">{f.filename}</td>
                      <td className="py-1.5 pr-3">{f.kind}</td>
                      <td className="py-1.5 pr-3">
                        <Badge tone={f.status === "listo" ? "ok" : f.status === "error" ? "crit" : "info"} title={f.error ?? undefined}>
                          {f.status}
                        </Badge>
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">{f.records.toLocaleString("es-PE")}</td>
                      <td className="py-1.5 pr-3">{fmtDate(f.first_at)}</td>
                      <td className="py-1.5 pr-3">{fmtDate(f.last_at)}</td>
                      <td className="py-1.5">{fmtDate(f.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </Card>

      <Card>
        <Section title="Buscar en el historial" subtitle="Por celular (ve todas las compras del cliente), correo, nombre o número de pedido.">
          <form className="flex flex-wrap gap-2">
            <input type="hidden" name="tienda" value={store.id} />
            <input
              name="q"
              defaultValue={q}
              placeholder="987654321, cliente@correo.com, María Pérez o #12345"
              className="h-9 min-w-64 flex-1 rounded-lg border border-line px-3 text-sm"
            />
            <button type="submit" className="h-9 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white">
              Buscar
            </button>
          </form>
          {q && (
            <div className="mt-4 overflow-x-auto">
              <p className="mb-2 text-[13px] text-ink-600">
                {results.length === 200 ? "Primeros 200 resultados" : `${results.length} pedido${results.length === 1 ? "" : "s"}`}
                {results.length > 0 && results.length < 200 && (byPhone || byEmail) && <> · total comprado {fmtMoney(boughtTotal)}</>}
              </p>
              {customers.map((c) => (
                <div key={c.customer_key} className="mb-3 rounded-lg border border-line px-3 py-2 text-[13px] text-ink-700">
                  <span className="font-medium text-ink-900">
                    {[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || c.phone}
                  </span>
                  {[c.city, c.province].filter(Boolean).length > 0 && <> · {[c.city, c.province].filter(Boolean).join(", ")}</>}
                  {c.total_orders != null && <> · {c.total_orders} pedido{c.total_orders === 1 ? "" : "s"} según Shopify</>}
                  {c.total_spent != null && <> · gastó {fmtMoney(c.total_spent)}</>}
                  {c.accepts_marketing && <> · acepta marketing: {c.accepts_marketing}</>}
                  {c.tags && <> · etiquetas: {c.tags}</>}
                  {c.note && <p className="mt-1 text-ink-600">Nota: {c.note}</p>}
                </div>
              ))}
              <table className="w-full text-[13px]">
                <thead className="text-left text-ink-500">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Pedido</th>
                    <th className="py-1 pr-3 font-medium">Fecha</th>
                    <th className="py-1 pr-3 font-medium">Cliente</th>
                    <th className="py-1 pr-3 font-medium">Celular</th>
                    <th className="py-1 pr-3 font-medium">Destino</th>
                    <th className="py-1 pr-3 font-medium">Productos</th>
                    <th className="py-1 pr-3 font-medium">Total</th>
                    <th className="py-1 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.order_name} className="border-t border-line align-top">
                      <td className="py-1.5 pr-3 font-medium">{r.order_name}</td>
                      <td className="py-1.5 pr-3">{fmtDate(r.created_at)}</td>
                      <td className="py-1.5 pr-3">{r.customer_name ?? r.email ?? "—"}</td>
                      <td className="py-1.5 pr-3">
                        {r.phone ? (
                          <Link href={`?tienda=${store.id}&q=${encodeURIComponent(r.phone)}`} className="text-brand-700 hover:underline">
                            {r.phone}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-1.5 pr-3">{[r.shipping_city, r.shipping_province].filter(Boolean).join(", ") || "—"}</td>
                      <td className="py-1.5 pr-3">
                        {(r.line_items ?? []).map((li) => `${li.quantity}× ${li.name}`).join(" · ") || "—"}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">{fmtMoney(r.total)}</td>
                      <td className="py-1.5">
                        {r.cancelled_at ? "Cancelado" : [r.financial_status, r.fulfillment_status].filter(Boolean).join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </Card>
    </div>
  );
}
