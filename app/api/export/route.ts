import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/db";
import { getAccessibleStores, parseRange } from "@/lib/access";
import { toCsv, type CsvColumn } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CSV export, RLS-scoped to the caller's accessible stores.
//   /api/export?kind=orders|rollups&storeId=<id?>&from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind") === "rollups" ? "rollups" : "orders";
  const range = parseRange({ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined });

  const stores = await getAccessibleStores();
  if (!stores.length) return new NextResponse("forbidden", { status: 403 });
  const storeId = sp.get("storeId");
  const ids = storeId ? stores.filter((s) => s.id === storeId).map((s) => s.id) : stores.map((s) => s.id);
  if (!ids.length) return new NextResponse("forbidden", { status: 403 });

  const nameById: Record<string, string> = Object.fromEntries(stores.map((s) => [s.id, s.name]));
  const sb = await createServerSupabase();

  if (kind === "rollups") {
    const { data } = await sb
      .from("daily_rollups")
      .select("*")
      .in("store_id", ids)
      .gte("date", range.from)
      .lte("date", range.to)
      .order("store_id")
      .order("date");
    const cols: CsvColumn<any>[] = [
      { header: "tienda", value: (r) => nameById[r.store_id] ?? r.store_id },
      { header: "fecha", value: (r) => r.date },
      { header: "ordenes", value: (r) => r.orders_count },
      { header: "ingresos_neto", value: (r) => r.revenue },
      { header: "aov", value: (r) => r.aov },
      { header: "conversaciones", value: (r) => r.conversations_count },
      { header: "conversion", value: (r) => r.conversion_rate },
      { header: "promo", value: (r) => r.promo_orders },
      { header: "stock_por_validar", value: (r) => r.stock_validar_orders },
      { header: "contraentrega", value: (r) => r.cod_orders },
      { header: "agencia", value: (r) => r.agency_orders },
      { header: "canceladas", value: (r) => r.cancelled_orders },
      { header: "reembolsado", value: (r) => r.refunded_amount },
    ];
    return csvResponse(toCsv(data ?? [], cols, { bom: true }), `rollups_${range.from}_${range.to}.csv`);
  }

  // orders — paginate so large ranges aren't truncated
  const startIso = `${range.from}T00:00:00Z`;
  const endIso = `${range.to}T23:59:59Z`;
  const rows: any[] = [];
  const pageSize = 1000;
  for (let from = 0; from < 100_000; from += pageSize) {
    const { data, error } = await sb
      .from("orders")
      .select(
        "store_id,shopify_order_id,name,created_at,total_amount,total_refunded,currency,financial_status,cancelled_at,promo_applied,stock_por_validar,shipping_mode,kapso_conversation_id,tags",
      )
      .in("store_id", ids)
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error || !data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }

  const cols: CsvColumn<any>[] = [
    { header: "tienda", value: (r) => nameById[r.store_id] ?? r.store_id },
    { header: "orden", value: (r) => r.name },
    { header: "shopify_order_id", value: (r) => r.shopify_order_id },
    { header: "creada", value: (r) => r.created_at },
    { header: "total", value: (r) => r.total_amount },
    { header: "reembolsado", value: (r) => r.total_refunded },
    { header: "moneda", value: (r) => r.currency },
    { header: "estado_pago", value: (r) => r.financial_status },
    { header: "cancelada_en", value: (r) => r.cancelled_at },
    { header: "promo", value: (r) => r.promo_applied },
    { header: "stock_por_validar", value: (r) => r.stock_por_validar },
    { header: "envio", value: (r) => r.shipping_mode },
    { header: "kapso_conversation_id", value: (r) => r.kapso_conversation_id },
    { header: "tags", value: (r) => r.tags },
  ];
  return csvResponse(toCsv(rows, cols, { bom: true }), `ordenes_${range.from}_${range.to}.csv`);
}

function csvResponse(csv: string, filename: string) {
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
