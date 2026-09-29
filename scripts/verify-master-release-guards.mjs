#!/usr/bin/env node
// Isolated release-gate fault injection. Never reads .env or a remote database.
import assert from "node:assert/strict";
import { createMigratedDatabase, applySqlFile, readTestSql } from "./verify-master-scaling.mjs";

const gate = "scripts/sql/master_read_scaling_preflight.sql";
const pg = await createMigratedDatabase(197);
const passed = [];
try {
  // Missing prebuilt indexes must stop before any 0198 DDL is committed.
  let installError;
  try { await applySqlFile(pg, "scripts/sql/master_read_scaling_install.sql"); }
  catch (error) { installError = error; await pg.exec("rollback"); }
  assert.match(installError?.message ?? "", /Prebuild valid index concurrently/);
  assert.equal((await pg.query("select to_regclass('public.order_master_stage_totals') as name")).rows[0].name, null);
  passed.push("installation without prebuilt indexes rejected atomically");
  // In this isolated empty DB ordinary index builds suffice; production uses
  // the separately documented CONCURRENTLY commands outside a transaction.
  const migration = readTestSql("db/migrations/0198_master_read_scaling.sql");
  const start = migration.indexOf("create index if not exists order_master_store_created_page_idx");
  assert.ok(start >= 0);
  await pg.exec(migration.slice(start));
  await applySqlFile(pg, "scripts/sql/master_read_scaling_install.sql");
  passed.push("controlled installation succeeds with prepared indexes");
  await pg.exec(`
    insert into organizations(id,name) values
      ('01570000-0000-4000-8000-000000000001','Isolated release guard');
    insert into stores(id,org_id,name,shopify_domain) values
      ('01570000-0000-4000-8000-000000000011','01570000-0000-4000-8000-000000000001','Guard','guard.test.invalid');
    insert into orders(id,store_id,shopify_order_id,created_at)
      select ('01570000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
        '01570000-0000-4000-8000-000000000011', 'guard-' || n, now()
      from generate_series(101,103) n;
    insert into order_master(order_id,store_id,shopify_order_id,macro_stage,macro_substage,current_courier,last_courier,region)
      select id,store_id,shopify_order_id,'por_confirmar','sin_llamar','test-courier','test-courier','Test region'
      from orders;
  `);
  const original = (await pg.query("select * from order_master order by id")).rows;
  await applySqlFile(pg, gate);
  passed.push("valid summaries and metadata");

  async function rejected(name, damage, repair, message) {
    await pg.exec(damage);
    let actualError;
    try { await applySqlFile(pg, gate); }
    catch (error) { actualError = error; await pg.exec("rollback"); }
    assert.ok(actualError, `${name}: gate unexpectedly accepted damaged state`);
    assert.match(actualError.message, message, `${name}: wrong rejection`);
    await pg.exec(repair);
    await applySqlFile(pg, gate);
    passed.push(name);
  }

  await rejected("stage drift rejected",
    "update order_master_stage_parts set total = total + 1",
    "update order_master_stage_parts set total = total - 1", /stage totals differ/);
  await rejected("facet drift rejected",
    "update order_master_facet_parts set total = total + 1 where dimension = 'courier'",
    "update order_master_facet_parts set total = total - 1 where dimension = 'courier'", /facet totals differ/);

  await rejected("unsafe summary view rejected",
    "alter view order_master_stage_totals set (security_invoker=false)",
    "alter view order_master_stage_totals set (security_invoker=true)", /invoker view missing or unsafe/);
  await rejected("missing partition RLS rejected",
    "alter table order_master_stage_parts disable row level security",
    "alter table order_master_stage_parts enable row level security", /RLS disabled/);
  await rejected("disabled maintenance rejected",
    "alter table order_master disable trigger order_master_read_update",
    "alter table order_master enable trigger order_master_read_update", /maintenance trigger missing or disabled/);
  await rejected("missing page index rejected",
    "drop index order_master_store_created_page_idx",
    "create index order_master_store_created_page_idx on order_master(store_id,order_created_at desc nulls last,id asc)", /index missing or invalid/);
  await rejected("missing read grant rejected",
    "revoke select on order_master_stage_totals from authenticated",
    "grant select on order_master_stage_totals to authenticated", /read grant or policy missing/);
  await rejected("direct summary write grant rejected",
    "grant update on order_master_stage_totals to service_role",
    "revoke update on order_master_stage_totals from service_role", /Unexpected direct permissions/);

  assert.deepEqual((await pg.query("select * from order_master order by id")).rows, original);
  passed.push("source orders unchanged by all checks");
} finally {
  await pg.close();
}

const rollbackDb = await createMigratedDatabase(197);
try {
  await applySqlFile(rollbackDb, "scripts/sql/master_read_scaling_rollback_smoke.sql");
  passed.push("rollback preserves data and RLS, supports subsequent writes and reinstalls correctly");
} finally {
  await rollbackDb.close();
}
console.log(JSON.stringify({ ok: true, isolated: true, checks: passed }));
