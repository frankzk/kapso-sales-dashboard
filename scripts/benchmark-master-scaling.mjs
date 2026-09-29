#!/usr/bin/env node
// Synthetic PostgreSQL/WASM benchmark. No .env, network, or production access.
// Install the isolated runtime as documented by verify-master-scaling.mjs.
//   node scripts/benchmark-master-scaling.mjs
//   node scripts/benchmark-master-scaling.mjs --sizes=50000 --samples=3
//   node scripts/benchmark-master-scaling.mjs --page-size=100
// Default page size 20 retains the original report path; 100 writes a separate
// master-scaling-page100 report, without overwriting the original benchmark.
// Separate child processes release the in-memory database between scales.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { applySqlFile } from "./verify-master-scaling.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = resolve(ROOT, "..", ".performance-tools");
const outputFor = (pageSize) => resolve(ROOT, pageSize === 20
  ? "docs/performance/master-scaling-benchmark-0198-2026-09-28.json"
  : `docs/performance/master-scaling-page${pageSize}-0198-2026-09-28.json`);
const workerOutputFor = (size, pageSize) => join(TOOLS,
  `master-scaling-${size}${pageSize === 20 ? "" : `-page${pageSize}`}.json`);
const SCRIPT = fileURLToPath(import.meta.url);
const STORE_A = "01570000-0000-4000-8000-000000000011";
const STORE_B = "01570000-0000-4000-8000-000000000012";
const STORES = [STORE_A, STORE_B];
const STORES_SQL = `array['${STORE_A}'::uuid,'${STORE_B}'::uuid]`;
const COLUMNS = "id,store_id,order_id,shopify_order_id,order_name,order_created_at,customer_name,customer_phone,region,province,district,coverage,general_status,operational_status,macro_stage,macro_substage,current_courier,last_courier,order_total,pickup_state";
const ORDER = "order_created_at desc nulls last, id asc";
const serialize = (value) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? String(v) : v);
const bytes = (value) => Buffer.byteLength(serialize(value));
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const uuid = (n) => `01570000-0000-4000-9000-${String(n).padStart(12, "0")}`;

function functionSource(file, name) {
  const source = read(file);
  const start = source.search(new RegExp(`create or replace function (?:public\\.)?${name}\\(`, "i"));
  if (start < 0) throw new Error(`Missing function ${name} in ${file}`);
  const declaration = source.slice(start);
  const match = declaration.match(/as\s+(\$[a-zA-Z0-9_]*\$)([\s\S]*?)\1;/i);
  if (!match) throw new Error(`Cannot extract SQL body of ${name}`);
  let sql = match[2].trim();
  if (/language\s+plpgsql/i.test(declaration.slice(0,match.index))) {
    // Extract only these two known read queries for EXPLAIN. The RPC itself is
    // measured separately, including its PL/pgSQL and RLS execution overhead.
    const block=sql.match(/\bbegin\s+([\s\S]*?)\bend;\s*$/i);
    if(!block) throw new Error(`Unsupported PL/pgSQL body for ${name}`);
    sql=block[1].trim();
    if(name==='order_master_mom_counts') sql=sql.replace(/\breturn query\b/i,'');
    else if(name==='master_facets') sql=sql.replace(/\binto result\b/i,'').replace(/\s*return result;\s*$/i,'');
    else throw new Error(`No read-query extractor for ${name}`);
  }
  return {
    file, name,
    sql: sql.trim().replace(/;\s*$/, "").replaceAll("p_store_ids", STORES_SQL),
    sha256: createHash("sha256").update(match[2]).digest("hex"),
  };
}

function physicalScan(node) {
  return ["Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan", "Sample Scan"].includes(node["Node Type"]);
}

function planSummary(document) {
  const nodes = [];
  const walk = (node) => {
    const loops = node["Actual Loops"] ?? 0;
    nodes.push({
      node: node["Node Type"], relation: node["Relation Name"] ?? null,
      index: node["Index Name"] ?? null,
      actualRows: node["Actual Rows"] ?? 0, actualLoops: loops,
      rowsRemovedByFilter: node["Rows Removed by Filter"] ?? 0,
      rowsRemovedByIndexRecheck: node["Rows Removed by Index Recheck"] ?? 0,
      scanTupleVisits: physicalScan(node)
        ? ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)
          + (node["Rows Removed by Index Recheck"] ?? 0)) * loops : 0,
      sharedHitBlocks: node["Shared Hit Blocks"] ?? 0,
      sharedReadBlocks: node["Shared Read Blocks"] ?? 0,
      tempReadBlocks: node["Temp Read Blocks"] ?? 0,
      tempWrittenBlocks: node["Temp Written Blocks"] ?? 0,
      sortMethod: node["Sort Method"] ?? null,
      indexCondition: node["Index Cond"] ?? null,
      filter: node.Filter ?? null,
    });
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(document.Plan);
  const top = document.Plan;
  return {
    executionMs: document["Execution Time"], planningMs: document["Planning Time"],
    returnedRows: (top["Actual Rows"] ?? 0) * (top["Actual Loops"] ?? 0),
    scanTupleVisits: nodes.reduce((sum, n) => sum + n.scanTupleVisits, 0),
    // Parent buffers include children: sum neither these nor per-node buffers.
    sharedHitBlocks: top["Shared Hit Blocks"] ?? 0,
    sharedReadBlocks: top["Shared Read Blocks"] ?? 0,
    sharedDirtiedBlocks: top["Shared Dirtied Blocks"] ?? 0,
    sharedWrittenBlocks: top["Shared Written Blocks"] ?? 0,
    tempReadBlocks: top["Temp Read Blocks"] ?? 0,
    tempWrittenBlocks: top["Temp Written Blocks"] ?? 0,
    triggers: (document.Triggers ?? []).map((t) => ({ name: t["Trigger Name"], calls: t.Calls, timeMs: t.Time })),
    nodes,
  };
}

function sortedPage(rows, pageSize) {
  return [...rows].sort((a, b) => {
    if (a.order_created_at === null && b.order_created_at !== null) return 1;
    if (a.order_created_at !== null && b.order_created_at === null) return -1;
    const dates = (b.order_created_at ? new Date(b.order_created_at).getTime() : 0)
      - (a.order_created_at ? new Date(a.order_created_at).getTime() : 0);
    return dates || a.id.localeCompare(b.id);
  }).slice(0, pageSize);
}

async function measure(pg, name, sql, samples, { write = false, merge = false, expected = null, params = [], pageSize = 20 } = {}) {
  const one = async () => {
    if (write) await pg.exec("begin");
    try {
      const { rows } = await pg.query(`explain (analyze, buffers, format json) ${sql}`, params);
      return rows[0]["QUERY PLAN"][0];
    } finally {
      if (write) await pg.exec("rollback");
    }
  };
  await one(); // Explicit warm-up; measurements are warm/mixed buffer-cache runs.
  const observed = [];
  for (let i = 0; i < samples; i++) observed.push(await one());
  observed.sort((a, b) => a["Execution Time"] - b["Execution Time"]);
  const median = observed[Math.floor(observed.length / 2)];
  let payload = {};
  if (!write) {
    const { rows } = await pg.query(sql, params);
    const displayed = merge ? sortedPage(rows, pageSize) : rows;
    if (expected && serialize(displayed.map((r) => r.id)) !== serialize(expected.map((r) => r.id))) {
      throw new Error(`${name}: page result differs from the original global order`);
    }
    payload = {
      databaseRowsReturned: rows.length, databaseResultBytes: bytes(rows),
      displayedRows: displayed.length, displayedResultBytes: bytes(displayed),
      ...(merge ? { mergeParity: true } : {}),
    };
  }
  const result = {
    name, sql, parameters: params, sampleCount: samples,
    samplesExecutionMs: observed.map((p) => p["Execution Time"]),
    p50: planSummary(median), ...payload,
    // EXPLAIN of a SQL function with SET search_path is opaque. Body scenarios
    // retain actual base-table plans; rpc_* scenarios record endpoint overhead.
    plan: median,
  };
  console.log(`[master-benchmark] ${name}: ${result.p50.executionMs.toFixed(3)} ms; scan tuples ${result.p50.scanTupleVisits}`);
  return result;
}

function perStorePage(cursor = null, nullOnly = false, pageSize = 20) {
  const params = [];
  let cursorClause = "";
  if (cursor) {
    params.push(new Date(cursor.order_created_at).toISOString(), cursor.id);
    cursorClause = "and order_created_at <= $1::timestamptz and (order_created_at < $1::timestamptz or (order_created_at = $1::timestamptz and id > $2::uuid))";
  }
  return {
    sql: STORES.map((id) => `(select ${COLUMNS} from public.order_master
      where store_id = '${id}'::uuid and order_created_at is ${nullOnly ? "null" : "not null"}
      ${cursorClause} order by ${ORDER} limit ${pageSize})`).join(" union all "),
    params,
  };
}

async function runWorker(size, samples, pageSize) {
  const started = performance.now();
  const module = pathToFileURL(join(TOOLS, "node_modules/@electric-sql/pglite/dist/index.js"));
  const { PGlite } = await import(module.href);
  const pg = new PGlite({ debug: 0 });
  const result = { size, pageSize, ok: false, samples, phases: {}, metadata: {} };
  try {
    await pg.waitReady;
    result.metadata.postgresVersion = (await pg.query("select version() as version")).rows[0].version;
    result.metadata.nodeVersion = process.version;
    result.metadata.platform = `${process.platform}/${process.arch}`;
    result.metadata.pgliteVersion = JSON.parse(readFileSync(join(TOOLS, "node_modules/@electric-sql/pglite/package.json"), "utf8")).version;
    await applySqlFile(pg, "scripts/sql/test_prelude.sql");
    await pg.exec(`
      set work_mem = '64MB'; set maintenance_work_mem = '128MB';
      create table public.stores(id uuid primary key);
      create table public.benchmark_store_access(user_id uuid, store_id uuid);
      create function public.auth_store_ids() returns setof uuid language sql stable security definer set search_path = public
      as $$ select store_id from public.benchmark_store_access where user_id = auth.uid() $$;
      create function public.auth_rider_order_ids() returns setof uuid language sql stable
      as $$ select null::uuid where false $$;
      create table public.order_master (
        id uuid primary key, store_id uuid not null references public.stores(id),
        order_id uuid not null unique, shopify_order_id text not null,
        order_name text, order_created_at timestamptz, customer_name text,
        customer_phone text, region text, province text, district text, coverage text,
        general_status text not null default 'pendiente', operational_status text not null default 'sin_confirmar',
        macro_stage text not null default 'por_confirmar', macro_substage text not null default 'sin_llamar',
        macro_since timestamptz, current_courier text, last_courier text,
        order_total numeric(14,2), shipping_mode text, pickup_state text,
        agency_expires_at timestamptz, guide_code text, courier_count int not null default 0,
        attempt_count int not null default 0, comment_count int not null default 0,
        last_movement_at timestamptz, recomputed_at timestamptz not null default '2026-09-25 12:00:00+00'
      );
      create table public.leads(id uuid primary key default gen_random_uuid(), order_id uuid);
      alter table public.order_master enable row level security;
      create policy order_master_select on public.order_master for select to authenticated
        using(store_id in (select public.auth_store_ids()));
      grant usage on schema public to authenticated, service_role;
      grant select on public.order_master to authenticated;
      insert into public.stores values ('${STORE_A}'),('${STORE_B}');
      insert into public.benchmark_store_access values
        ('01570000-0000-4000-8000-000000000021','${STORE_A}'),
        ('01570000-0000-4000-8000-000000000021','${STORE_B}');
      set request.test_uid = '01570000-0000-4000-8000-000000000021';
    `);
    console.log(`[master-benchmark] ${size}: seeding isolated minimal schema`);
    const seedStart = performance.now();
    for (let from = 1; from <= size; from += 20_000) {
      const to = Math.min(size, from + 19_999);
      await pg.query(`insert into public.order_master (
        id,order_id,store_id,shopify_order_id,order_name,order_created_at,customer_name,
        customer_phone,region,province,district,coverage,general_status,operational_status,
        macro_stage,macro_substage,current_courier,last_courier,order_total,shipping_mode,pickup_state)
      select
        ('01570000-0000-4000-9000-' || lpad(i::text,12,'0'))::uuid,
        ('01570000-0000-4000-9000-' || lpad(i::text,12,'0'))::uuid,
        case when i % 2 = 0 then '${STORE_A}'::uuid else '${STORE_B}'::uuid end,
        i::text,'#BENCH' || i,
        case when i % 100 = 0 then null else timestamptz '2026-09-25 12:00:00+00' - ((i - 1) / 5) * interval '1 minute' end,
        'Synthetic customer ' || (i % 200),'000000000',
        'Region ' || (i % 4),'Province ' || (i % 8),'District ' || (i % 16),
        (array['lima','provincia_cod','agencia','por_revisar'])[1 + (i % 4)],
        case when i % 20 < 15 then 'entregado' else 'pendiente' end,
        case when i % 20 < 15 then 'entregado' else 'sin_confirmar' end,
        case when i % 20 < 15 then 'finalizado' else (array['por_confirmar','preparacion','por_despachar','en_curso','por_cerrar'])[1 + (i % 20) - 15] end,
        case when i % 20 < 15 then 'entregado' else (array['sin_llamar','por_armar','listo_despacho','en_transito','pendiente_liquidacion'])[1 + (i % 20) - 15] end,
        (array['aliclik','fenix','shalom'])[1 + (i % 3)],
        case when i % 5 = 0 then null else (array['aliclik','fenix','shalom'])[1 + ((i + 1) % 3)] end,
        99.90,
        case when i % 3 = 2 then 'agency' else 'cod' end,
        case when i % 3 = 2 then 'en_transito' else null end
      from generate_series($1::integer,$2::integer) i`, [from, to]);
      if (to % 200_000 === 0 || to === size) console.log(`[master-benchmark] ${size}: seeded ${to}`);
    }
    result.metadata.seedMs = Math.round(performance.now() - seedStart);

    // Original B-tree indexes relevant to the tested queries. Search GIN,
    // shipment/finance tables, real operational triggers and JSON payloads are
    // intentionally absent from this minimal SQL scaling experiment.
    const wanted = new Set([
      "order_master_store_general_idx", "order_master_store_oper_idx", "order_master_store_created_idx",
      "order_master_store_movement_idx", "order_master_store_district_idx", "order_master_store_province_idx",
      "order_master_store_region_idx", "order_master_store_courier_idx", "order_master_phone_idx",
      "order_master_pickup_idx", "order_master_expiry_idx", "order_master_store_coverage_idx",
      "order_master_macro_stage_idx", "order_master_macro_substage_idx",
      "order_master_mom_stage_movement_idx", "order_master_mom_substage_movement_idx",
    ]);
    const indexSources = ["0045_order_master", "0047_shipment_gestion", "0078_order_coverage", "0086_mom_phase1", "0089_order_master_mom_counts"];
    const indexes = [];
    for (const name of indexSources) {
      for (const match of read(`db/migrations/${name}.sql`).matchAll(/create index if not exists\s+(\w+)\s+[\s\S]*?;/g)) {
        if (wanted.has(match[1])) {
          indexes.push(match[1]);
          await pg.exec(match[0]);
        }
      }
    }
    if (indexes.length !== wanted.size) throw new Error("Baseline index extraction missed a definition");
    await pg.exec("vacuum (analyze) public.order_master");
    result.metadata.baselineIndexes = indexes;
    const legacyCounts = functionSource("db/migrations/0089_order_master_mom_counts.sql", "order_master_mom_counts");
    const legacyFacets = functionSource("db/migrations/0078_order_coverage.sql", "master_facets");
    result.metadata.sqlSources = { legacyCounts, legacyFacets };

    const deepOffset = Math.floor((size * 0.8) / pageSize) * pageSize;
    const globalFirst = `select ${COLUMNS} from public.order_master where store_id = any(${STORES_SQL}) order by ${ORDER} limit ${pageSize}`;
    const globalDeep = `${globalFirst} offset ${deepOffset}`;
    const exactCount = `select count(*) from public.order_master where store_id = any(${STORES_SQL})`;
    const filteredCount = `${exactCount} and coverage = 'agencia' and macro_stage = 'finalizado'`;
    await pg.exec("set role authenticated");
    const firstRows = (await pg.query(globalFirst)).rows;
    const deepRows = (await pg.query(globalDeep)).rows;
    const cursor = (await pg.query(`select id,order_created_at from public.order_master
      where store_id = any(${STORES_SQL}) order by ${ORDER} offset ${deepOffset - 1} limit 1`)).rows[0];
    const nullRows = (await pg.query(`select ${COLUMNS} from public.order_master
      where store_id = any(${STORES_SQL}) and order_created_at is null order by ${ORDER} limit ${pageSize}`)).rows;
    result.metadata.deepOffset = deepOffset;
    result.metadata.deepCursor = cursor;
    result.metadata[`first${pageSize}Ids`] = firstRows.map((r) => r.id);

    const before = [];
    for (const [name, sql] of [
      ["mom_counts_legacy_body", legacyCounts.sql], ["facets_legacy_body", legacyFacets.sql],
      ["exact_count_all_legacy", exactCount], ["exact_count_filtered_legacy", filteredCount],
      [`first_page${pageSize}_global_legacy`, globalFirst], [`deep_page${pageSize}_offset_legacy`, globalDeep],
    ]) before.push(await measure(pg, name, sql, samples));
    await pg.exec("reset role");
    const insertedId = uuid(size + 100);
    const writes = [
      ["insert_one", `insert into public.order_master(id,order_id,store_id,shopify_order_id,region,current_courier)
        values ('${insertedId}','${insertedId}','${STORE_A}','bench-write','Write region','aliclik')`],
      ["update_one_counted", `update public.order_master set macro_stage='preparacion',macro_substage='por_armar',region='Write region',current_courier='fenix' where id='${uuid(1)}'`],
      ["update_one_unrelated", `update public.order_master set comment_count=comment_count+1 where id='${uuid(1)}'`],
      ["update_batch100_counted", `update public.order_master set macro_stage='preparacion',macro_substage='por_armar',region='Write region' where id >= '${uuid(1)}' and id <= '${uuid(100)}'`],
    ];
    for (const [name, sql] of writes) before.push(await measure(pg, `${name}_legacy`, sql, samples, { write: true }));
    result.phases.before = before;

    console.log(`[master-benchmark] ${size}: applying exact migration 0198 (includes atomic backfill and indexes)`);
    const migrationStarted = performance.now();
    await applySqlFile(pg, "db/migrations/0198_master_read_scaling.sql");
    result.metadata.migrationBackfillAndIndexMs = Math.round(performance.now() - migrationStarted);
    await pg.exec("vacuum (analyze) public.order_master");
    await pg.exec("vacuum (analyze) public.order_master_stage_parts");
    await pg.exec("vacuum (analyze) public.order_master_facet_parts");
    result.metadata.relationSizes = (await pg.query(`select relname,
      pg_relation_size(oid)::bigint as table_bytes,pg_indexes_size(oid)::bigint as index_bytes
      from pg_class where relname in ('order_master','order_master_stage_parts','order_master_facet_parts') order by relname`)).rows;
    result.metadata.aggregateRows = (await pg.query(`select
      (select count(*) from public.order_master_stage_totals)::integer as stage_rows,
      (select count(*) from public.order_master_facet_totals)::integer as facet_rows`)).rows[0];
    result.metadata.sourceDistribution = (await pg.query(`select macro_stage,count(*)::bigint as total
      from public.order_master group by macro_stage order by macro_stage`)).rows;
    const newCounts = functionSource("db/migrations/0198_master_read_scaling.sql", "order_master_mom_counts");
    const newFacets = functionSource("db/migrations/0198_master_read_scaling.sql", "master_facets");
    result.metadata.sqlSources.newCounts = newCounts;
    result.metadata.sqlSources.newFacets = newFacets;
    await pg.exec("set role authenticated");
    const originalCounts = (await pg.query(legacyCounts.sql)).rows.sort((a, b) => serialize(a).localeCompare(serialize(b)));
    const incrementalCounts = (await pg.query(newCounts.sql)).rows.sort((a, b) => serialize(a).localeCompare(serialize(b)));
    // SQL output column labels differ (COUNT vs SUM), so compare positional fields.
    const countValues = (rows) => rows.map((r) => [r.macro_stage, r.macro_substage, String(r.total ?? r.sum ?? r.count)]);
    if (serialize(countValues(originalCounts)) !== serialize(countValues(incrementalCounts))) throw new Error("Counts differ after backfill");
    const originalFacets = Object.values((await pg.query(legacyFacets.sql)).rows[0])[0];
    const incrementalFacets = Object.values((await pg.query(newFacets.sql)).rows[0])[0];
    if (serialize(originalFacets) !== serialize(incrementalFacets)) throw new Error("Facets differ after backfill");
    result.metadata.aggregateParity = true;
    const after = [];
    for (const [name, sql] of [
      ["mom_counts_incremental_body", newCounts.sql], ["facets_incremental_body", newFacets.sql],
      ["rpc_mom_counts_incremental", `select * from public.order_master_mom_counts(${STORES_SQL})`],
      ["rpc_facets_incremental", `select public.master_facets(${STORES_SQL})`],
      ["exact_count_all_after", exactCount], ["exact_count_filtered_after", filteredCount],
      [`first_page${pageSize}_global_after_indexes`, globalFirst], [`deep_page${pageSize}_offset_after_indexes`, globalDeep],
    ]) after.push(await measure(pg, name, sql, samples));
    for (const [name, query, expected] of [
      [`first_page${pageSize}_per_store`, perStorePage(null, false, pageSize), firstRows],
      [`deep_page${pageSize}_per_store_cursor`, perStorePage(cursor, false, pageSize), deepRows],
      [`null_page${pageSize}_per_store`, perStorePage(null, true, pageSize), nullRows],
    ]) after.push(await measure(pg, name, query.sql, samples, { merge: true, params: query.params, expected, pageSize }));
    await pg.exec("reset role");
    for (const [name, sql] of writes) after.push(await measure(pg, `${name}_incremental`, sql, samples, { write: true }));
    result.phases.after = after;
    result.ok = true;
  } finally {
    result.metadata.durationMs = Math.round(performance.now() - started);
    result.metadata.maxResidentSetKiB = process.resourceUsage().maxRSS;
    result.metadata.finalNodeMemory = process.memoryUsage();
    await pg.close();
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const sampleArg = args.find((arg) => arg.startsWith("--samples="));
  const samples = sampleArg ? Number(sampleArg.split("=")[1]) : 3;
  if (!Number.isInteger(samples) || samples < 3 || samples > 5) throw new Error("Use 3 to 5 samples");
  const pageSizeArg = args.find((arg) => arg.startsWith("--page-size="));
  const pageSize = pageSizeArg ? Number(pageSizeArg.split("=")[1]) : 20;
  if (![20, 100].includes(pageSize)) throw new Error("Page size must be 20 or 100");
  const output = outputFor(pageSize);
  const workerArg = args.find((arg) => arg.startsWith("--worker="));
  if (workerArg) {
    const size = Number(workerArg.split("=")[1]);
    const destination = workerOutputFor(size, pageSize);
    try {
      writeFileSync(destination, JSON.stringify(await runWorker(size, samples, pageSize), null, 2));
    } catch (error) {
      writeFileSync(destination, JSON.stringify({ size, ok: false, error: { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 500) } }, null, 2));
      throw error;
    }
    return;
  }
  const sizesArg = args.find((arg) => arg.startsWith("--sizes="));
  const sizes = sizesArg ? sizesArg.split("=")[1].split(",").map(Number) : [50_000, 200_000, 1_000_000];
  if (sizes.some((n) => !Number.isInteger(n) || n < 1000 || n > 1_000_000)) throw new Error("Sizes must be integers from 1000 to 1000000");
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(TOOLS, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(), runtime: "PGlite / PostgreSQL WASM, isolated in-memory database per child process",
    productionAccess: false, synthetic: true, pageSize, samplesPerScenario: samples,
    interpretation: [
      "These are local synthetic PostgreSQL measurements, NOT predictions of Supabase/Vercel latency or p95 under concurrent traffic.",
      "Minimal source schema preserves tested SQL columns, B-tree indexes, store RLS, and exact migration 0198; it omits real JSON payloads, search GIN indexes, orders/shipments and existing operational write triggers.",
      `Two accessible stores; size grows only by adding older rows. The same latest ${pageSize} IDs, tied timestamps, dimensions and periodic status distribution are retained; 1% of timestamps are null.`,
      "Baseline is measured before migration 0198; after phase retains all baseline indexes and adds the migration's indexes and transactional summaries.",
      "Counts/facet body plans expose internal scans hidden by EXPLAIN of SET-search_path SQL RPC functions. Exact SQL bodies are extracted from repository migrations with SHA-256 provenance.",
      "One unrecorded EXPLAIN warm-up precedes 3-5 measured runs. p50 includes server execution, not network latency. Buffer cache is not flushed, and large relations can exceed cache.",
      "VACUUM ANALYZE precedes both read phases, permitting index-only scans on historical rows in the baseline and updated schema.",
      "scanTupleVisits sums Actual Rows + Rows Removed by Filter/Recheck times loops at physical table scan nodes; it is diagnostic work, not unique rows. Root buffer counts include descendants and are not summed twice.",
      `Per-store candidate SQL uses UNION ALL of two independently limited queries (${pageSize} each); JavaScript merges candidates into ${pageSize} displayed rows. Result parity with the old global order is asserted, including a deep cursor and null dates.`,
      "Result bytes are uncompressed JSON serialization of benchmark SQL rows; they are not HTTP/RSC transfer measurements of the full application projection.",
      "Write samples use EXPLAIN ANALYZE inside rolled-back transactions to preserve the fixture. Trigger times and original write costs are both reported; no concurrent-writer throughput claim is made.",
    ],
    scales: [],
  };
  for (const size of sizes) {
    console.log(`[master-benchmark] Starting isolated ${size}-row process, page size ${pageSize}`);
    // Never mistake a previous successful worker's output for this run after
    // an abrupt WASM/OS memory failure.
    writeFileSync(workerOutputFor(size, pageSize), JSON.stringify({
      size, ok: false, error: { message: "Worker started but did not finish its report" },
    }));
    const exitCode = await new Promise((done, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=8192", SCRIPT, `--worker=${size}`, `--samples=${samples}`, `--page-size=${pageSize}`], { stdio: "inherit", windowsHide: true });
      child.once("error", reject);
      child.once("exit", (code) => done(code));
    });
    let scale;
    try { scale = JSON.parse(readFileSync(workerOutputFor(size, pageSize), "utf8")); }
    catch { scale = { size, ok: false, error: { message: "Worker exited without report (possible memory/runtime failure)", exitCode } }; }
    const prior = report.scales.find((item) => item.ok);
    if (scale.ok && prior && serialize(scale.metadata[`first${pageSize}Ids`]) !== serialize(prior.metadata[`first${pageSize}Ids`])) {
      scale.ok = false;
      scale.error = { message: `Latest ${pageSize} orders changed between fixture scales` };
      process.exitCode = 1;
    }
    report.scales.push(scale);
    writeFileSync(output, JSON.stringify(report, null, 2));
    if (exitCode !== 0) process.exitCode = 1;
  }
  console.log(`[master-benchmark] Report: ${output}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 500) }));
  process.exitCode = 1;
});
