// Synthetic PostgreSQL concurrency workload. The caller supplies node-postgres
// clients connected to a THROWAWAY database with the real schema through 0201
// (before) or 0202 (after), test_prelude.sql and the real RLS policies.
// No dependency imports, connection creation, .env access or production access.
//
// seed(admin, { size: 50_000, workerCount: 8 }) -> fixture
// runWorker(dedicatedClient, { fixture, workerId, iterations: 200, phase, phaseIndex,
//   mode?: 'normal' | 'multi_statement_stress', startBarrier?: Promise<void> | callback,
//   lockTimeoutMs?: 5000, statementTimeoutMs?: 15000 })
// verify(admin, { fixture, expectSummaries, workerResults? })
//
// Use a DIFFERENT physical PostgreSQL connection for each worker and a fresh
// fixture/database per comparison. Promise.all on one client is NOT concurrency.
// phaseIndex must be unique per round/level/mode in a database to avoid reusing
// ingestion IDs, and identical across before/after for a comparable workload.
// Normal mode makes exactly one Master mutation per transaction (other writes
// represent ingestion/audit). multirow_upsert updates all 200 worker-owned hot
// rows in ONE statement; smaller explicitly configured hotsets are supported.
// Both batch upserts and stage changes toggle from the actual stored values.
// multi_statement_stress deliberately holds counter
// locks across multiple Master statements and reverses store order by worker;
// this is an adverse stress scenario, NOT a claim about usual HTTP boundaries.

const PREFIX = "0157c000-0000-4000";
const STORE_A = `${PREFIX}-8000-000000000011`;
const STORE_B = `${PREFIX}-8000-000000000012`;
const ORG = `${PREFIX}-8000-000000000001`;
const VIEWER = `${PREFIX}-8000-000000000021`;
const OUTSIDER = `${PREFIX}-8000-000000000022`;
const ANCHOR = "2026-09-25T12:00:00.000Z";
const WRITE_STRIDE = 1_000_000;
const OPERATIONS = ["projection_update", "projection_upsert", "multirow_upsert", "ingestion", "stage_change", "intentional_rollback"];
const MOM = [
  ["por_confirmar", "sin_llamar"], ["preparacion", "por_armar"],
  ["por_despachar", "listo_despacho"], ["en_curso", "en_transito"],
  ["por_cerrar", "pendiente_liquidacion"], ["finalizado", "entregado"],
];

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer ${min}..${max}`);
  return value;
}
const uuid = (n, variant = "9000") => `${PREFIX}-${variant}-${String(n).padStart(12, "0")}`;
const orderCode = (n) => `concurrency-${n}`;
const sourceStore = (n) => n % 2 === 0 ? STORE_A : STORE_B;
const millis = (started) => Math.round((performance.now() - started) * 1000) / 1000;
const errorInfo = (error) => ({
  code: typeof error?.code === "string" ? error.code : "CLIENT_ERROR",
  message: String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 240),
});

function checkFixture(fixture) {
  if (fixture?.version !== 1 || fixture.orgId !== ORG) throw new Error("Expected fixture returned by seed()");
  integer(fixture.size, "fixture.size", 1, 2_000_000);
  integer(fixture.workerCount, "fixture.workerCount", 1, 64);
  integer(fixture.hotRowsPerWorker, "fixture.hotRowsPerWorker", 4, 200);
  if (fixture.hotRowsPerWorker % 2 || fixture.size < fixture.workerCount * fixture.hotRowsPerWorker) {
    throw new Error("Fixture requires an even hotRowsPerWorker and enough seeded orders");
  }
}

/** Populate deterministic history without disabling any real trigger/index. */
export async function seed(client, { size = 50_000, workerCount = 8, hotRowsPerWorker = 200, batchSize = 5000 } = {}) {
  const fixture = { version: 1, size, workerCount, hotRowsPerWorker, orgId: ORG,
    storeIds: [STORE_A, STORE_B], viewerId: VIEWER, outsiderId: OUTSIDER, anchor: ANCHOR };
  checkFixture(fixture);
  integer(batchSize, "batchSize", 1, 20_000);
  const started = performance.now();
  const existing = await client.query("select exists(select 1 from public.organizations where id=$1::uuid) as found", [ORG]);
  if (existing.rows[0].found) throw new Error("Synthetic namespace already exists: use a fresh isolated database per phase; seed never deletes data");
  await client.query("begin");
  try {
    await client.query("insert into auth.users(id,email) values ($1::uuid,'concurrency-viewer@test.invalid'),($2::uuid,'concurrency-outsider@test.invalid')", [VIEWER, OUTSIDER]);
    await client.query("insert into public.organizations(id,name) values ($1::uuid,'Synthetic Master concurrency')", [ORG]);
    await client.query(`insert into public.stores(id,org_id,name,shopify_domain) values
      ($1::uuid,$3::uuid,'Concurrency A','concurrency-a.test.invalid'),
      ($2::uuid,$3::uuid,'Concurrency B','concurrency-b.test.invalid')`, [STORE_A, STORE_B, ORG]);
    await client.query("insert into public.user_store_access(user_id,store_id) values ($1::uuid,$2::uuid)", [VIEWER, STORE_A]);
    await client.query("commit");
  } catch (error) { await client.query("rollback"); throw error; }

  for (let from = 1; from <= size; from += batchSize) {
    const to = Math.min(size, from + batchSize - 1);
    await client.query("begin");
    try {
      await client.query(`insert into public.orders(id,store_id,shopify_order_id,name,created_at,
        total_amount,currency,financial_status,tags,shipping_mode,line_items,raw)
      select ('${PREFIX}-9000-' || lpad(n::text,12,'0'))::uuid,
        case when n%2=0 then $3::uuid else $4::uuid end,'concurrency-'||n,'#CONCUR-'||n,
        case when n%100=0 then null else $5::timestamptz - ((n-1)/5)*interval '1 minute' end,
        99.90,'PEN',case when n%20<15 then 'paid' else 'pending' end,array['synthetic'],
        case when n%3=2 then 'agency' else 'cod' end,
        '[{"title":"Synthetic product","quantity":1,"price":99.90}]'::jsonb,
        '{"synthetic":true}'::jsonb
      from generate_series($1::int,$2::int) n`, [from, to, STORE_A, STORE_B, ANCHOR]);
      await client.query(`insert into public.order_master(id,order_id,store_id,shopify_order_id,
        order_name,order_created_at,customer_name,customer_phone,region,province,district,
        general_status,operational_status,macro_stage,macro_substage,current_courier,last_courier,
        order_total,shipping_mode,pickup_state,recomputed_at)
      select ('${PREFIX}-a000-' || lpad(n::text,12,'0'))::uuid,o.id,o.store_id,o.shopify_order_id,
        o.name,o.created_at,'Synthetic customer '||(n%200),'000000000',
        case when n%4=0 then 'Lima' else 'Piura' end,
        case when n%4=0 then 'Lima' else 'Piura' end,
        case when n%4=0 then 'Miraflores' else 'Piura' end,
        case when n%20<15 then 'entregado' else 'pendiente' end,
        case when n%20<15 then 'entregado' else 'sin_confirmar' end,
        case when n%20<15 then 'finalizado' else (array['por_confirmar','preparacion','por_despachar','en_curso','por_cerrar'])[n%20-14] end,
        case when n%20<15 then 'entregado' else (array['sin_llamar','por_armar','listo_despacho','en_transito','pendiente_liquidacion'])[n%20-14] end,
        (array['aliclik','fenix','shalom'])[1+n%3],
        case when n%5=0 then null else (array['aliclik','fenix','shalom'])[1+(n+1)%3] end,
        o.total_amount,o.shipping_mode,case when n%3=2 then 'en_transito' else null end,$3::timestamptz
      from generate_series($1::int,$2::int) n
      join public.orders o on o.id=('${PREFIX}-9000-' || lpad(n::text,12,'0'))::uuid`, [from, to, ANCHOR]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
  }
  // Ensure every worker's hotset shares the same small stage/facet buckets.
  await client.query(`update public.order_master set macro_stage='por_confirmar',macro_substage='sin_llamar',
    general_status='pendiente',operational_status='sin_confirmar',current_courier='aliclik',last_courier=null,
    region='Piura',province='Piura',district='Piura'
    where order_id between $1::uuid and $2::uuid`, [uuid(1), uuid(workerCount * hotRowsPerWorker)]);
  await client.query("analyze public.orders");
  await client.query("analyze public.order_master");
  const { rows } = await client.query(`select count(*)::int as orders from public.order_master where store_id=any($1::uuid[])`, [fixture.storeIds]);
  if (rows[0].orders !== size) throw new Error("Incomplete concurrency fixture");
  return { ...fixture, seedMs: millis(started), hotRows: workerCount * hotRowsPerWorker };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Aggregate only successful samples into latency percentiles; failures remain
 * explicit, with their own latency distribution and SQLSTATE counts. */
export function summarize(samples) {
  return Object.fromEntries(OPERATIONS.map((operation) => {
    const rows = samples.filter((sample) => sample.operation === operation);
    const ok = rows.filter((sample) => sample.outcome === "committed" || sample.outcome === "intentional_rollback");
    const failed = rows.filter((sample) => sample.outcome === "failed");
    const codes = {};
    for (const row of failed) codes[row.error.code] = (codes[row.error.code] ?? 0) + 1;
    return [operation, { attempts: rows.length, succeeded: ok.length, failed: failed.length,
      p50Ms: percentile(ok.map((row) => row.durationMs), 0.5), p95Ms: percentile(ok.map((row) => row.durationMs), 0.95),
      maxMs: ok.length ? Math.max(...ok.map((row) => row.durationMs)) : null,
      failureP50Ms: percentile(failed.map((row) => row.durationMs), 0.5), sqlstates: codes }];
  }));
}

export async function runWorker(client, { fixture, workerId, iterations = 200, phase, phaseIndex = 0,
  mode = "normal", startBarrier, lockTimeoutMs = 5000, statementTimeoutMs = 15000 } = {}) {
  checkFixture(fixture);
  integer(workerId, "workerId", 0, fixture.workerCount - 1);
  integer(iterations, "iterations", 1, WRITE_STRIDE - 1);
  integer(phaseIndex, "phaseIndex", 0, 9999);
  integer(lockTimeoutMs, "lockTimeoutMs", 1, 60_000);
  integer(statementTimeoutMs, "statementTimeoutMs", lockTimeoutMs, 120_000);
  if (typeof phase !== "string" || !/^[a-z0-9_-]{1,30}$/i.test(phase)) throw new Error("phase must be a short label");
  if (!["normal", "multi_statement_stress"].includes(mode)) throw new Error("Unknown workload mode");
  const stress = mode === "multi_statement_stress";
  const { rows: [backend] } = await client.query("select pg_backend_pid() as pid");
  await client.query("select set_config('application_name',$1,false)", [`master_concurrency_${phase}_${workerId}`]);
  await client.query("set role service_role");
  const samples = [];
  let started = performance.now();
  let stoppedEarly = false;
  let cleanupError;
  try {
    if (typeof startBarrier === "function") await startBarrier({ workerId, backendPid: backend.pid });
    else if (startBarrier) await startBarrier;
    started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      const operation = OPERATIONS[iteration % OPERATIONS.length];
      const first = 1 + workerId * fixture.hotRowsPerWorker + (iteration * 2 + workerId % 2) % fixture.hotRowsPerWorker;
      const second = 1 + workerId * fixture.hotRowsPerWorker + (first - 1 - workerId * fixture.hotRowsPerWorker + 1) % fixture.hotRowsPerWorker;
      const serial = fixture.size + phaseIndex * 64 * WRITE_STRIDE + workerId * WRITE_STRIDE + iteration + 1;
      const timestamp = new Date(Date.parse(ANCHOR) + iteration * 1000).toISOString();
      const sample = { workerId, iteration, operation, mode, outcome: "pending", statements: [],
        expectedNewOrders: operation === "ingestion" ? 1 : 0,
        expectedAuditEvents: operation === "stage_change" ? (stress ? 2 : 1) : 0 };
      const began = performance.now();
      let step = "begin";
      const query = async (label, sql, values = [], expectedRows) => {
        step = label;
        const tick = performance.now();
        try {
          const result = await client.query(sql, values);
          const rows = result.rowCount ?? result.affectedRows;
          sample.statements.push({ label, ms: millis(tick), rows, ...(expectedRows === undefined ? {} : { expectedRows }) });
          if (expectedRows !== undefined && rows !== expectedRows) {
            const error = new Error(`${label}: expected ${expectedRows} affected rows, received ${rows}`);
            error.code = "ROW_COUNT_MISMATCH";
            throw error;
          }
          return result;
        }
        catch (error) { sample.statements.push({ label, ms: millis(tick), error: errorInfo(error).code }); throw error; }
      };
      const projection = async (n, region) => query("projection_upsert", `insert into public.order_master(
        id,order_id,store_id,shopify_order_id,order_name,order_created_at,macro_stage,macro_substage,
        operational_status,region,province,district,current_courier,last_courier,recomputed_at)
        select $2::uuid,o.id,o.store_id,o.shopify_order_id,o.name,o.created_at,$3,$4,'sin_confirmar',
          $5,'Piura','Piura',$6,null,$7::timestamptz from public.orders o where o.id=$1::uuid
        on conflict(order_id) do update set macro_stage=excluded.macro_stage,macro_substage=excluded.macro_substage,
          region=excluded.region,current_courier=excluded.current_courier,recomputed_at=excluded.recomputed_at`,
        [uuid(n), uuid(n, "a000"), ...MOM[(iteration + workerId) % 2], region,
          (iteration + workerId) % 2 ? "shalom" : "aliclik", timestamp], 1);
      try {
        await query("begin", "begin");
        await query("timeouts", "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)", [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`]);
        if (operation === "projection_update") {
          for (const n of stress ? [first, second] : [first]) await query("projection_update", `update public.order_master
            set current_courier=$2,region=$3,recomputed_at=$4::timestamptz,comment_count=comment_count+1
            where order_id=$1::uuid`, [uuid(n), (iteration + workerId) % 2 ? "shalom" : "aliclik",
              (iteration + workerId) % 2 ? "Lima" : "Piura", timestamp], 1);
        } else if (operation === "projection_upsert") {
          await projection(first, "Piura");
          if (stress) await projection(second, "Lima");
        } else if (operation === "multirow_upsert") {
          const low = 1 + workerId * fixture.hotRowsPerWorker;
          const high = low + fixture.hotRowsPerWorker - 1;
          await query("multirow_upsert", `insert into public.order_master(
            id,order_id,store_id,shopify_order_id,order_name,order_created_at,
            macro_stage,macro_substage,region,province,district,current_courier,recomputed_at)
            select m.id,m.order_id,m.store_id,m.shopify_order_id,m.order_name,m.order_created_at,
              case when m.macro_stage='preparacion' then 'por_confirmar' else 'preparacion' end,
              case when m.macro_stage='preparacion' then 'sin_llamar' else 'por_armar' end,
              case when m.region='Piura' then 'Lima' else 'Piura' end,
              case when m.region='Piura' then 'Lima' else 'Piura' end,
              case when m.region='Piura' then 'Miraflores' else 'Piura' end,
              case when m.current_courier='aliclik' then 'shalom' else 'aliclik' end,$3::timestamptz
            from public.order_master m where m.order_id between $1::uuid and $2::uuid
            order by m.order_id
            on conflict(order_id) do update set macro_stage=excluded.macro_stage,
              macro_substage=excluded.macro_substage,region=excluded.region,province=excluded.province,
              district=excluded.district,current_courier=excluded.current_courier,recomputed_at=excluded.recomputed_at`,
            [uuid(low), uuid(high), timestamp], fixture.hotRowsPerWorker);
        } else if (operation === "ingestion" || operation === "intentional_rollback") {
          await query("ingest_order", `insert into public.orders(id,store_id,shopify_order_id,name,created_at,
            total_amount,currency,tags,raw) values($1::uuid,$2::uuid,$3,$4,$5::timestamptz,99.90,'PEN',array['synthetic'],'{"synthetic":true}'::jsonb)`,
            [uuid(serial), sourceStore(serial + workerId + Math.floor(iteration / OPERATIONS.length)), orderCode(serial), operation === "intentional_rollback" ? `#ROLLBACK-${serial}` : `#INGEST-${serial}`, timestamp], 1);
          await projection(serial, operation === "intentional_rollback" ? "ROLLBACK PROBE" : "Piura");
          if (operation === "intentional_rollback" && stress) await query("rollback_hot_update", `update public.order_master
            set region='ROLLBACK PROBE' where order_id=$1::uuid`, [uuid(first)], 1);
        } else if (operation === "stage_change") {
          await query("append_events", `insert into public.order_events(store_id,order_id,kind,source,note,payload)
            select store_id,order_id,'comment','manual','Synthetic concurrency stage change',
              jsonb_build_object('workload','master_concurrency','worker',$2::int,'iteration',$3::int)
            from public.order_master where order_id=any($1::uuid[])`, [stress ? [uuid(first), uuid(second)] : [uuid(first)], workerId, iteration], stress ? 2 : 1);
          for (const n of stress ? [first, second] : [first]) {
            await query("stage_change", `update public.order_master
              set macro_stage=case when macro_stage='preparacion' then 'por_confirmar' else 'preparacion' end,
                macro_substage=case when macro_stage='preparacion' then 'sin_llamar' else 'por_armar' end,
                recomputed_at=$2::timestamptz where order_id=$1::uuid`, [uuid(n), timestamp], 1);
          }
        }
        await query(operation === "intentional_rollback" ? "rollback" : "commit", operation === "intentional_rollback" ? "rollback" : "commit");
        sample.outcome = operation === "intentional_rollback" ? "intentional_rollback" : "committed";
      } catch (error) {
        sample.outcome = "failed";
        sample.failedAt = step;
        sample.error = errorInfo(error);
        // Roll back the failed transaction exactly once. Do not retry its work:
        // the caller needs to see contention/deadlocks and ambiguous commits.
        try { await client.query("rollback"); }
        catch (rollbackError) { sample.rollbackError = errorInfo(rollbackError); stoppedEarly = true; }
        if (step === "commit" && (!/^[0-9A-Z]{5}$/.test(error?.code ?? "") || /^(08|57P0)/.test(error.code))) sample.commitOutcomeUnknown = true;
      }
      sample.durationMs = millis(began);
      samples.push(sample);
      if (stoppedEarly) break;
    }
  } finally {
    try { await client.query("reset role"); }
    catch (error) { cleanupError = errorInfo(error); stoppedEarly = true; }
  }
  return { workerId, phase, phaseIndex, mode, backendPid: backend.pid, iterationsRequested: iterations,
    iterationsCompleted: samples.length, stoppedEarly, durationMs: millis(started),
    ...(cleanupError ? { cleanupError } : {}), samples, summary: summarize(samples) };
}

const facetValuesSql = `select distinct v.dimension,v.value from public.order_master m
  cross join lateral (values ('operational',m.operational_status),('courier',m.current_courier),
    ('courier',m.last_courier),('region',m.region),('province',m.province),('district',m.district),
    ('coverage',m.coverage),('pickup',m.pickup_state)) v(dimension,value)
  where m.store_id=any($1::uuid[]) and v.value is not null`;
const facetsExpectedSql = `with visible as (${facetValuesSql})
  select jsonb_object_agg(d.dimension,coalesce((select jsonb_agg(v.value order by v.value)
    from visible v where v.dimension=d.dimension),'[]'::jsonb)) as facets
  from (values ('operational'),('courier'),('region'),('province'),('district'),('coverage'),('pickup')) d(dimension)`;

/** Run after all writers stop. No source/aggregate repairs are performed. */
export async function verify(client, { fixture, expectSummaries = true, workerResults } = {}) {
  checkFixture(fixture);
  const checks = {};
  const assert = (name, passed) => { checks[name] = Boolean(passed); if (!passed) throw new Error(`Concurrency verification failed: ${name}`); };
  const rpcParity = async () => {
    const counts = await client.query(`with expected as (select macro_stage,macro_substage,count(*)::bigint as total
      from public.order_master where store_id=any($1::uuid[]) group by macro_stage,macro_substage),
      actual as (select * from public.order_master_mom_counts($1::uuid[]))
      select not exists((select * from expected except select * from actual)
        union all (select * from actual except select * from expected)) as ok`, [fixture.storeIds]);
    const facets = await client.query(`select public.master_facets($1::uuid[]) = expected.facets as ok
      from (${facetsExpectedSql}) expected`, [fixture.storeIds]);
    return counts.rows[0].ok && facets.rows[0].ok;
  };
  await client.query("begin isolation level repeatable read read only");
  try {
    const { rows: [source] } = await client.query(`select
      (select count(*)::int from public.orders where store_id=any($1::uuid[])) as orders,
      (select count(*)::int from public.order_master where store_id=any($1::uuid[])) as master,
      (select count(*)::int from public.order_events where store_id=any($1::uuid[]) and payload->>'workload'='master_concurrency') as events,
      not exists(select 1 from public.order_master m left join public.orders o on o.id=m.order_id
        where m.store_id=any($1::uuid[]) and (o.id is null or m.store_id<>o.store_id)) as identities_ok,
      not exists(select 1 from public.orders where store_id=any($1::uuid[]) and name like '#ROLLBACK-%')
        and not exists(select 1 from public.order_master where store_id=any($1::uuid[]) and region='ROLLBACK PROBE') as rollback_ok`, [fixture.storeIds]);
    assert("sourceIdentities", source.identities_ok);
    assert("intentionalRollbacks", source.rollback_ok);
    assert("allOrdersProjected", source.orders === source.master);
    if (workerResults) {
      const samples = workerResults.flatMap((worker) => worker.samples);
      assert("unambiguousOutcomes", !samples.some((sample) => sample.commitOutcomeUnknown || sample.rollbackError));
      const committed = samples.filter((sample) => sample.outcome === "committed");
      assert("committedIngestions", source.orders === fixture.size + committed.reduce((sum, sample) => sum + sample.expectedNewOrders, 0));
      assert("committedAuditEvents", source.events === committed.reduce((sum, sample) => sum + sample.expectedAuditEvents, 0));
    }
    assert("rpcParityAdmin", await rpcParity());
    if (expectSummaries) {
      const stages = await client.query(`with expected as (select store_id,macro_stage,macro_substage,count(*)::bigint as total
        from public.order_master where store_id=any($1::uuid[]) group by store_id,macro_stage,macro_substage),
        actual as (select * from public.order_master_stage_totals where store_id=any($1::uuid[]))
        select not exists((select * from expected except select * from actual)
          union all (select * from actual except select * from expected)) as ok`, [fixture.storeIds]);
      assert("stageReferenceCounts", stages.rows[0].ok);
      const facets = await client.query(`with expected as (
        select m.store_id,v.dimension,v.value,count(*)::bigint as total from public.order_master m
        cross join lateral (select distinct dimension,value from (values
          ('operational',m.operational_status),('courier',m.current_courier),('courier',m.last_courier),
          ('region',m.region),('province',m.province),('district',m.district),('coverage',m.coverage),
          ('pickup',m.pickup_state)) d(dimension,value) where value is not null) v
        where m.store_id=any($1::uuid[]) group by m.store_id,v.dimension,v.value),
        actual as (select * from public.order_master_facet_totals where store_id=any($1::uuid[]))
        select not exists((select * from expected except select * from actual)
          union all (select * from actual except select * from expected)) as ok`, [fixture.storeIds]);
      assert("facetReferenceCounts", facets.rows[0].ok);
    }
    await client.query("set local role service_role");
    assert("rpcParityService", await rpcParity());
    await client.query("reset role");
    for (const [label, user, accessible] of [["viewer", VIEWER, [STORE_A]], ["outsider", OUTSIDER, []]]) {
      await client.query("select set_config('request.test_uid',$1,true)", [user]);
      await client.query("set local role authenticated");
      assert(`rpcParity_${label}`, await rpcParity());
      const visible = await client.query("select distinct store_id from public.order_master where store_id=any($1::uuid[]) order by store_id", [fixture.storeIds]);
      assert(`sourceRls_${label}`, JSON.stringify(visible.rows.map((row) => row.store_id)) === JSON.stringify(accessible));
      if (expectSummaries) {
        for (const [table, key] of [["order_master_stage_totals", "stage"], ["order_master_facet_totals", "facet"]]) {
          const totals = await client.query(`select distinct store_id from public.${table} where store_id=any($1::uuid[]) order by store_id`, [fixture.storeIds]);
          assert(`${key}Rls_${label}`, JSON.stringify(totals.rows.map((row) => row.store_id)) === JSON.stringify(accessible));
        }
      }
      await client.query("reset role");
    }
    await client.query("commit");
    return { ok: true, checks, sourceRows: source.master, orderRows: source.orders, auditEvents: source.events };
  } catch (error) { await client.query("rollback"); throw error; }
}
