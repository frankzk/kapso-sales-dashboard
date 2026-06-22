/**
 * Seed demo data into Supabase via the service role.
 *
 *   pnpm seed
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read from
 * .env.local automatically). Optionally set SEED_USER_ID to your auth user id
 * to grant yourself owner access so the data shows up in the dashboard.
 *
 * Idempotent: re-running upserts the same deterministic rows and rebuilds
 * rollups. Creates no real tokens — the demo store has none, so it is never
 * touched by the live Shopify/Kapso sync.
 */
import { existsSync, readFileSync } from "node:fs";

function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (process.env[key!]) continue;
    let v = (rawVal ?? "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[key!] = v;
  }
}
loadEnvLocal();

const DEMO_DOMAIN = "demo-aurela.myshopify.com";
const DEMO_TZ = "America/Lima";

async function main() {
  const { createAdminSupabase } = await import("@/lib/db");
  const { generateDemoData } = await import("@/lib/demo");

  const admin = createAdminSupabase();

  // Reuse the demo store if it already exists, else create org + store.
  const { data: existing } = await admin
    .from("stores")
    .select("id, org_id")
    .eq("shopify_domain", DEMO_DOMAIN)
    .maybeSingle();

  let storeId: string;
  let orgId: string;
  if (existing) {
    storeId = existing.id;
    orgId = existing.org_id;
    console.log(`Reusing demo store ${storeId}`);
  } else {
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .insert({ name: "Demo Org (Kapso)" })
      .select("id")
      .single();
    if (orgErr || !org) throw new Error(`create org: ${orgErr?.message}`);
    orgId = org.id;

    const { data: store, error: storeErr } = await admin
      .from("stores")
      .insert({
        org_id: orgId,
        name: "Aurela (demo)",
        shopify_domain: DEMO_DOMAIN,
        currency: "PEN",
        timezone: DEMO_TZ,
        status: "active",
      })
      .select("id")
      .single();
    if (storeErr || !store) throw new Error(`create store: ${storeErr?.message}`);
    storeId = store.id;
    console.log(`Created demo store ${storeId}`);
  }

  const { orders, conversations } = generateDemoData({ storeId, days: 45, seed: 7 });
  console.log(`Generated ${orders.length} orders, ${conversations.length} conversations`);

  await chunked(conversations, 500, (batch) =>
    admin.from("conversations").upsert(batch, { onConflict: "store_id,kapso_conversation_id" }),
  );
  await chunked(orders, 500, (batch) =>
    admin.from("orders").upsert(batch, { onConflict: "store_id,shopify_order_id" }),
  );

  // Rebuild rollups across the generated window.
  const dates = orders
    .map((o) => o.created_at!.slice(0, 10))
    .concat(conversations.map((c) => c.started_at!.slice(0, 10)))
    .sort();
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  const { error: rErr } = await admin.rpc("recompute_daily_rollups", {
    p_store_id: storeId,
    p_from: from,
    p_to: to,
  });
  if (rErr) throw new Error(`recompute_daily_rollups: ${rErr.message}`);
  console.log(`Rebuilt rollups ${from} → ${to}`);

  const userId = process.env.SEED_USER_ID;
  if (userId) {
    await admin.from("memberships").upsert(
      { user_id: userId, org_id: orgId, role: "owner" },
      { onConflict: "user_id,org_id" },
    );
    await admin.from("user_store_access").upsert(
      { user_id: userId, store_id: storeId },
      { onConflict: "user_id,store_id" },
    );
    console.log(`Granted owner access to user ${userId}`);
  } else {
    console.log("Tip: set SEED_USER_ID=<your auth uid> to grant yourself access.");
  }

  console.log("Done.");
}

async function chunked<T>(
  items: T[],
  size: number,
  fn: (batch: T[]) => PromiseLike<{ error: unknown }>,
) {
  for (let i = 0; i < items.length; i += size) {
    const { error } = await fn(items.slice(i, i + size));
    if (error) throw new Error(String((error as { message?: string }).message ?? error));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
