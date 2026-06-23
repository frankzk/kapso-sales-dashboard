// Emits demo seed SQL + the TS-computed expected rollups so verify-db.sh can
// prove the SQL recompute_daily_rollups() matches lib/metrics.computeDailyRollups().
//   tsx scripts/parity-gen.ts <outDir>
import { writeFileSync } from "node:fs";
import { generateDemoData } from "@/lib/demo";
import { computeDailyRollups } from "@/lib/metrics";

const outDir = process.argv[2] ?? "/tmp";
const STORE = "11111111-1111-1111-1111-111111111111";
const ORG = "22222222-2222-2222-2222-222222222222";
const tz = "America/Lima";

const { orders, conversations } = generateDemoData({
  storeId: STORE,
  days: 20,
  seed: 123,
  endDate: new Date("2026-06-22T00:00:00Z"),
});
const rollups = computeDailyRollups(STORE, orders, conversations, tz);

const expected = rollups
  .map((r) =>
    [
      r.date,
      r.orders_count,
      r.revenue.toFixed(2),
      r.aov.toFixed(2),
      r.conversations_count,
      r.conversion_rate.toFixed(4),
      r.promo_orders,
      r.stock_validar_orders,
      r.cod_orders,
      r.agency_orders,
      r.cancelled_orders,
      r.refunded_amount.toFixed(2),
      r.inbound_messages,
      r.response_seconds_sum,
      r.response_samples,
    ].join(","),
  )
  .join("\n");
writeFileSync(`${outDir}/expected_rollups.csv`, expected + "\n");

const esc = (s: string) => s.replace(/'/g, "''");
const sql: string[] = [
  `insert into organizations(id,name) values ('${ORG}','Parity Org');`,
  `insert into stores(id,org_id,name,shopify_domain,currency,timezone,status) values ('${STORE}','${ORG}','Parity','parity.myshopify.com','PEN','${tz}','active');`,
];
for (const c of conversations) {
  sql.push(
    `insert into conversations(store_id,kapso_conversation_id,phone_number_id,started_at,status,message_count,last_message_at,inbound_count,first_response_seconds) values ('${STORE}','${esc(c.kapso_conversation_id)}','${c.phone_number_id}','${c.started_at}','${c.status}',${c.message_count},'${c.last_message_at}',${c.inbound_count ?? "null"},${c.first_response_seconds ?? "null"});`,
  );
}
for (const o of orders) {
  const tags = `ARRAY[${o.tags.map((t) => `'${esc(t)}'`).join(",")}]::text[]`;
  const li = esc(JSON.stringify(o.line_items));
  sql.push(
    `insert into orders(store_id,shopify_order_id,name,created_at,processed_at,updated_at,total_amount,currency,financial_status,cancelled_at,total_refunded,tags,promo_applied,stock_por_validar,shipping_mode,kapso_conversation_id,line_items) values ('${STORE}','${o.shopify_order_id}','${o.name}','${o.created_at}','${o.processed_at}','${o.updated_at}',${o.total_amount},'${o.currency}','${o.financial_status}',${o.cancelled_at ? `'${o.cancelled_at}'` : "null"},${o.total_refunded},${tags},${o.promo_applied},${o.stock_por_validar},${o.shipping_mode ? `'${o.shipping_mode}'` : "null"},'${esc(o.kapso_conversation_id ?? "")}','${li}'::jsonb);`,
  );
}
sql.push(`select recompute_daily_rollups('${STORE}','${rollups[0]!.date}','${rollups[rollups.length - 1]!.date}');`);
writeFileSync(`${outDir}/seed_demo.sql`, sql.join("\n") + "\n");

console.log(
  `parity-gen: orders=${orders.length} conversations=${conversations.length} days=${rollups.length}`,
);
