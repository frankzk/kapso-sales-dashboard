#!/usr/bin/env node
// Directed concurrency regression, not a throughput/latency benchmark.
// A test-only AFTER UPDATE statement trigger pauses BOTH sessions after their
// normal UPDATE-maintenance trigger but before INSERT-maintenance. Advisory
// locks controlled by a third backend make that interleaving deterministic;
// no sleeps are inserted in the production function and 0198 is never changed.
// Every writer executes one mixed Master UPSERT on disjoint source rows.
// A new loopback-only PostgreSQL cluster is created and stopped by the runtime;
// no .env, connection URL, existing database, or production data is accessed.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalPostgres } from "./local-postgres-runtime.mjs";
import { readTestSql } from "./verify-master-scaling.mjs";
import { seed, verify } from "./master-concurrency-workload.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "docs/performance/master-mixed-upsert-current-pg16-2026-09-28.json");
const KEY = 157001;
const PREFIX = "0157c000-0000-4000";
const id = (n) => `${PREFIX}-9000-${String(n).padStart(12, "0")}`;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const errorInfo = (error) => ({ code: error?.code ?? "TEST_ERROR",
  message: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 400),
  ...(error?.detail ? { detail: String(error.detail).slice(0, 1800) } : {}),
  ...(error?.where ? { context: String(error.where).slice(0, 2500) } : {}) });

async function migrate(client) {
  await client.query(readTestSql("scripts/sql/test_prelude.sql"));
  for (const name of readdirSync(join(ROOT, "db/migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    if (Number(name.slice(0, 4)) > 197) continue;
    await client.query(readTestSql(`db/migrations/${name}`));
    if (name.startsWith("0003_")) await client.query(readTestSql("supabase/policies.sql"));
  }
}

async function runWriter(client, fixture, workerId) {
  const { rows: [{ pid }] } = await client.query("select pg_backend_pid() as pid");
  // Set this while still the isolated cluster owner. This shortens detection,
  // not the race window or locking behavior. No production role needs it.
  await client.query("set deadlock_timeout='100ms'; set lock_timeout='8s'; set statement_timeout='15s'");
  await client.query("select set_config('test.master_mixed_worker',$1,false)", [String(workerId)]);
  await client.query("set role service_role");
  // T0 updates existing A then inserts B; T1 updates existing B then inserts A.
  // The old buckets retain other fixture rows, so the conflict is on real
  // existing counter tuples rather than on concurrent source row identities.
  const existing = workerId === 0 ? 2 : 1;
  const fresh = workerId === 0 ? 9 : 10;
  const oldStore = fixture.storeIds[workerId];
  const newStore = fixture.storeIds[1 - workerId];
  const started = performance.now();
  const result = { workerId, backendPid: pid, existingOrder: id(existing), insertedOrder: id(fresh),
    oldStore, newStore, masterStatements: 1, sourceIdsDisjoint: true };
  try {
    await client.query("begin");
    const inserted = await client.query(`insert into public.orders(id,store_id,shopify_order_id,name,created_at)
      values($1::uuid,$2::uuid,$3,$4,'2026-09-25T12:01:00Z'::timestamptz)`,
      [id(fresh), newStore, `mixed-${fresh}`, `#MIXED-${fresh}`]);
    assert.equal(inserted.rowCount, 1);
    const master = await client.query(`insert into public.order_master(order_id,store_id,shopify_order_id,macro_stage,macro_substage)
      values ($1::uuid,$2::uuid,$3,'preparacion','por_armar'),
             ($4::uuid,$5::uuid,$6,'por_confirmar','sin_llamar')
      on conflict(order_id) do update set macro_stage=excluded.macro_stage,macro_substage=excluded.macro_substage`,
      [id(existing), oldStore, `concurrency-${existing}`, id(fresh), newStore, `mixed-${fresh}`]);
    assert.equal(master.rowCount, 2);
    await client.query("commit");
    result.outcome = "committed";
    result.rowsAffected = master.rowCount;
  } catch (error) {
    result.outcome = "failed";
    result.error = errorInfo(error);
    try { await client.query("rollback"); }
    catch (rollbackError) { result.rollbackError = errorInfo(rollbackError); }
  } finally {
    result.durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    await client.query("reset role");
  }
  return result;
}

async function scenario(runtime, database, fixture, incremental) {
  const admin = await runtime.connect(database, { application_name: "mixed-upsert-coordinator" });
  const writers = await Promise.all([0, 1].map((n) => runtime.connect(database, { application_name: `mixed-upsert-writer-${n}` })));
  let pending;
  const record = { variant: incremental ? "after_0198" : "before_0198", controlledInterleaving: true };
  try {
    await admin.query(`create function public.master_mixed_test_barrier() returns trigger language plpgsql as $hook$
      begin
        perform pg_advisory_xact_lock(${KEY},current_setting('test.master_mixed_worker')::int);
        return null;
      end;
      $hook$;
      create trigger zzz_master_mixed_test_barrier after update on public.order_master
        for each statement execute function public.master_mixed_test_barrier()`);
    // Locks are scoped to this brand-new test database. The production
    // maintenance trigger's name sorts before this test-only zzz hook.
    await admin.query("select pg_advisory_lock($1,0),pg_advisory_lock($1,1)", [KEY]);
    pending = Promise.allSettled(writers.map((client, workerId) => runWriter(client, fixture, workerId)));
    const deadline = Date.now() + 5000;
    let blocked = [];
    while (Date.now() < deadline) {
      const result = await admin.query(`select l.pid,l.objid::int as gate,a.application_name,a.wait_event_type,a.wait_event
        from pg_locks l join pg_stat_activity a on a.pid=l.pid
        where a.datname=current_database() and l.locktype='advisory' and l.classid=$1::oid
          and not l.granted order by l.objid`, [KEY]);
      blocked = result.rows;
      if (blocked.length === 2) break;
      await pause(10);
    }
    record.barrierObserved = blocked;
    assert.equal(blocked.length, 2, "Both independent writers must reach the post-UPDATE/pre-INSERT barrier");
    assert.equal(new Set(blocked.map((row) => row.pid)).size, 2, "Distinct backends required");
    await admin.query("select pg_advisory_unlock($1,0),pg_advisory_unlock($1,1)", [KEY]);
    const completed = await pending;
    const rejected = completed.find((row) => row.status === "rejected");
    if (rejected) throw rejected.reason;
    record.writers = completed.map((row) => row.value);
    record.deadlocks = record.writers.filter((row) => row.error?.code === "40P01").length;
    record.committed = record.writers.filter((row) => row.outcome === "committed").length;
    assert.ok(record.writers.every((row) => !row.rollbackError), "Failed statements must roll back cleanly");
    await admin.query("drop trigger zzz_master_mixed_test_barrier on public.order_master; drop function public.master_mixed_test_barrier()");
    // Each committed mixed UPSERT adds one order and one projection; the failed
    // transaction must retain neither its new order nor its partial counter delta.
    record.verification = await verify(admin, { fixture, expectSummaries: incremental,
      workerResults: record.writers.map((row) => ({ samples: [{ outcome: row.outcome,
        expectedNewOrders: 1, expectedAuditEvents: 0, rollbackError: row.rollbackError }] })) });
    const { rows } = await admin.query(`select shopify_order_id,macro_stage,macro_substage from public.order_master
      where order_id=any($1::uuid[]) order by order_id`, [[id(1), id(2), id(9), id(10)]]);
    record.resultingRows = rows;
    if (!incremental) assert.equal(record.committed, 2, "Baseline should commit both disjoint mixed UPSERTs");
    return record;
  } finally {
    // Release a stalled gate even when an assertion fails. Statement timeouts
    // bound pending queries, then the local runtime shuts down the test cluster.
    await admin.query("select pg_advisory_unlock_all()").catch(() => {});
    if (pending) await pending;
    await Promise.allSettled([...writers, admin].map((client) => client.end()));
  }
}

const report = { startedAt: new Date().toISOString(), localOnly: true, productionTouched: false,
  experiment: "Two disjoint mixed UPSERTs: opposite existing/new stores, one Master statement per writer",
  limitation: "Test-only AFTER UPDATE hook forces a legal adverse interleaving using coordinator-held advisory locks. This establishes possibility, not natural frequency or production latency.",
  migrationSha256: createHash("sha256").update(readFileSync(join(ROOT, "db/migrations/0198_master_read_scaling.sql"))).digest("hex"),
  scenarios: [] };
let runtime;
try {
  runtime = await startLocalPostgres();
  report.runtime = { version: runtime.version, packageVersion: runtime.packageVersion, directory: runtime.directory, port: runtime.port };
  const control = await runtime.connect();
  await control.query("create database mixed_template");
  const template = await runtime.connect("mixed_template");
  await migrate(template);
  const fixture = await seed(template, { size: 8, workerCount: 2, hotRowsPerWorker: 4 });
  await template.end();
  await control.query("create database mixed_before template mixed_template");
  await control.query("create database mixed_after template mixed_template");
  await control.end();
  const after = await runtime.connect("mixed_after");
  await after.query(readTestSql("db/migrations/0198_master_read_scaling.sql"));
  await after.end();
  for (const incremental of [false, true]) {
    const row = await scenario(runtime, incremental ? "mixed_after" : "mixed_before", fixture, incremental);
    report.scenarios.push(row);
    console.log(JSON.stringify({ variant: row.variant, committed: row.committed, deadlocks: row.deadlocks, parity: row.verification.ok }));
  }
  report.riskReproduced = report.scenarios[0].committed === 2 && report.scenarios[1].deadlocks > 0;
  assert.ok(report.scenarios.every((row) => row.committed === 2 && row.deadlocks === 0 && row.verification.ok),
    "Both disjoint mixed UPSERTs must commit before and after the fix");
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.error = errorInfo(error);
  process.exitCode = 1;
  console.error(JSON.stringify(report.error));
} finally {
  if (runtime) {
    try { await runtime.stop(); report.stoppedAt = new Date().toISOString(); }
    catch (error) { report.shutdownError = errorInfo(error); process.exitCode = 1; }
  }
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
}
