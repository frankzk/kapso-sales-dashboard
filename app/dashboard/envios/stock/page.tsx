import { createServerSupabase } from "@/lib/db";
import { getAdminOrgs } from "@/lib/access";
import { EmptyState } from "@/components/ui";
import { FenixStockEditor } from "@/components/fenix-stock";
import type { FenixStockRowDb } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function FenixStockPage() {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("fenix_stock")
    .select("id,org_id,city,product,sku,quantity,updated_by,updated_at,created_at")
    .order("city")
    .order("product");
  const rows = (data as FenixStockRowDb[]) ?? [];

  const adminOrgs = await getAdminOrgs();
  const canEdit = adminOrgs.some((m) => m.role === "owner" || m.role === "admin");

  if (!rows.length && !canEdit) {
    return <EmptyState title="Sin stock de Fenix registrado" />;
  }

  return <FenixStockEditor rows={rows} canEdit={canEdit} />;
}
