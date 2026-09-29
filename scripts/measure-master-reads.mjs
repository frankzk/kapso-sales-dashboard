// Read-only PostgREST probe. Never prints rows, store IDs, URLs or credentials.
// node --env-file=.env.local scripts/measure-master-reads.mjs
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

// Node preserves a UTF-8 BOM on the first key of some Windows .env files.
const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env["\uFEFFNEXT_PUBLIC_SUPABASE_URL"];
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !key) throw new Error("Supabase environment required");
const headers = { apikey: key, Authorization: `Bearer ${key}` };
const storesResponse = await fetch(`${base}/rest/v1/stores?select=id&order=id`, {
  headers, signal: AbortSignal.timeout(15000),
});
if (!storesResponse.ok) throw new Error(`Stores HTTP ${storesResponse.status}`);
const stores = await storesResponse.json();
const ids = stores.map(s => s.id);
const scope = `store_id=in.(${ids.join(",")})`;
const fields = "id,store_id,order_id,order_name,order_created_at,customer_name,customer_phone,region,province,district,coverage,shipping_mode,order_total,general_status,operational_status,macro_stage,macro_substage,macro_reasons,macro_operation,macro_version,macro_since,confirmation_active,confirmation_day_count,confirmation_last_contact_at,confirmation_next_contact_on,confirmation_cycle_due_on,confirmation_reminder_due_at,confirmation_last_actor,status_since,status_locked,current_courier,last_courier,courier_count,attempt_count,guide_code,dispatched_at,delivered_at,delivered_courier,returned_at,last_movement_at,comment_count,logistics_cost,pickup_state,payment_state,latitude,longitude,key_state,agency_branch,agency_arrived_at,agency_expires_at";
const queries = [
  ["page20", `order_master?${scope}&select=${fields}&order=order_created_at.desc.nullslast,id.asc&limit=20`],
  ["page100", `order_master?${scope}&select=${fields}&order=order_created_at.desc.nullslast,id.asc&limit=100`],
  ["exact_count", `order_master?${scope}&select=id`, { method: "HEAD", headers: { Prefer: "count=exact" } }],
  ["mom_counts", "rpc/order_master_mom_counts", { method: "POST", body: JSON.stringify({ p_store_ids: ids }), headers: { "Content-Type": "application/json" } }],
  ["facets", "rpc/master_facets", { method: "POST", body: JSON.stringify({ p_store_ids: ids }), headers: { "Content-Type": "application/json" } }],
  ["page20_offset20000", `order_master?${scope}&select=${fields}&order=order_created_at.desc.nullslast,id.asc&limit=20&offset=20000`],
  ["agency_available", `order_master?${scope}&select=id&pickup_state=in.(disponible_para_recojo,pendiente_de_recojo)`, { method: "HEAD", headers: { Prefer: "count=exact" } }],
  ["change_token", `order_master?${scope}&select=updated_at&order=updated_at.desc&limit=1`],
];
const results = [];
for (let round = 1; round <= 3; round++) {
  for (const [name, path, options = {}] of queries) {
    const start = performance.now();
    try {
      const res = await fetch(`${base}/rest/v1/${path}`, {
        ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(15000),
      });
      const ttfbMs = performance.now() - start;
      const body = await res.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch { /* HEAD */ }
      const result = { round, name, status: res.status, ttfbMs: Math.round(ttfbMs), totalMs: Math.round(performance.now() - start), bytes: Buffer.byteLength(body), rows: Array.isArray(parsed) ? parsed.length : null, count: res.headers.get("content-range")?.split("/")[1] ?? null, errorCode: res.ok ? null : parsed?.code ?? null };
      results.push(result);
      console.log(JSON.stringify(result));
    } catch (error) {
      const result = { round, name, error: error.name, totalMs: Math.round(performance.now() - start) };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
}
const report = { measuredAt: new Date().toISOString(), source: "PostgREST service role from local workstation; includes network; excludes browser/RLS", storeCount: ids.length, results };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
