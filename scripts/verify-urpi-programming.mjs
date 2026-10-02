// Run against a newly created, isolated local PostgreSQL cluster only.
// node scripts/verify-urpi-programming.mjs <path-to-local-postgres-runtime.mjs>
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.argv[2]) throw new Error("Supply the isolated local PostgreSQL runtime module, never a database URL.");
const { startLocalPostgres } = await import(pathToFileURL(resolve(process.argv[2])).href);
const runtime = await startLocalPostgres();
let checks = 0;
try {
  const db = await runtime.connect("postgres", { application_name: "urpi-programming-verification" });
  await db.query(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table public.stores(id uuid primary key);
    create table public.orders(id uuid primary key, store_id uuid not null references stores);
    create function public.auth_store_ids() returns setof uuid language sql stable as $$
      select nullif(current_setting('test.store_id',true),'')::uuid
    $$;
    insert into stores values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
    insert into auth.users values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    insert into orders values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111'),
      ('cccccccc-cccc-cccc-cccc-cccccccccccc','22222222-2222-2222-2222-222222222222');
    grant usage on schema public,auth to authenticated,service_role;
    grant select on orders to service_role;
  `);
  const migration = await readFile(new URL("../db/migrations/0212_urpi_programming.sql", import.meta.url), "utf8");
  await db.query(migration);
  await db.query(migration); // Migration is rerunnable.
  const { rows: sources } = await db.query(`insert into urpi_programming_sources(store_id,spreadsheet_id,month,order_prefix,name)
    values ('11111111-1111-1111-1111-111111111111','12345678901234567890123','2026-10','KP','Kenku'),
    ('22222222-2222-2222-2222-222222222222','12345678901234567890123','2026-10','AUR','Aurela') returning id`);
  const source = sources[0].id;
  const payload = { rows: [{ orderCode: "KP123", orderId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }], tabs: [{title:"01/10/26"}] };
  async function save(time, digest, body = payload) {
    return (await db.query("select save_urpi_programming_snapshot($1,$2,$3,$4,$5,$6,$7) as changed", [source, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", time, digest.repeat(64), body, "excel", "test.xlsx"])).rows[0].changed;
  }
  await db.query("set role service_role");
  assert.equal(await save("2026-10-01T10:00:00Z", "a"), true); checks++;
  assert.equal(await save("2026-10-01T11:00:00Z", "a"), false); checks++;
  assert.equal(await save("2026-10-01T12:00:00Z", "b"), true); checks++;
  await assert.rejects(save("2026-10-01T11:30:00Z", "c"), /newer_import/); checks++;
  await assert.rejects(save("2026-10-01T13:00:00Z", "c", { rows: [{ orderCode: "KP123", orderId: "cccccccc-cccc-cccc-cccc-cccccccccccc" }], tabs: [] }), /invalid_order_scope/); checks++;
  await assert.rejects(save("2026-10-01T13:00:00Z", "c", { rows: [{ orderCode: "AUR123", orderId: null }], tabs: [] }), /invalid_order_scope/); checks++;
  await assert.rejects(save("2026-10-01T13:00:00Z", "c", { rows: null, tabs: [] }), /invalid_payload/); checks++;
  await assert.rejects(save("2026-10-01T13:00:00Z", "c", { rows: payload.rows, tabs: [] }), /missing_tabs/); checks++;
  const stored = await db.query("select count(*)::int as n from urpi_programming_snapshots");
  assert.equal(stored.rows[0].n, 2); checks++;
  assert.equal((await db.query("select digest from urpi_programming_snapshots where id=(select current_snapshot_id from urpi_programming_sources where id=$1)", [source])).rows[0].digest, "b".repeat(64)); checks++;
  await db.query("reset role; set role authenticated; select set_config('test.store_id','11111111-1111-1111-1111-111111111111',false)");
  assert.equal((await db.query("select count(*)::int as n from urpi_programming_sources")).rows[0].n, 1); checks++;
  assert.equal((await db.query("select count(*)::int as n from urpi_programming_snapshots")).rows[0].n, 2); checks++;
  await assert.rejects(save("2026-10-01T14:00:00Z", "d"), /permission denied/); checks++;
  await assert.rejects(db.query("update urpi_programming_sources set name='not allowed'"), /permission denied/); checks++;
  await db.query("select set_config('test.store_id','22222222-2222-2222-2222-222222222222',false)");
  assert.equal((await db.query("select count(*)::int as n from urpi_programming_snapshots")).rows[0].n, 0); checks++;
  await db.query("reset role; set role anon");
  await assert.rejects(db.query("select * from urpi_programming_sources"), /permission denied/); checks++;
  await db.query("reset role");
  assert.equal((await db.query("select count(*)::int as n from orders")).rows[0].n, 2); checks++;
  console.log(JSON.stringify({ ok: true, checks, localOnly: true, scenario: "RLS, immutable history, idempotency, stale import and cross-store protection" }));
} finally { await runtime.stop(); }
