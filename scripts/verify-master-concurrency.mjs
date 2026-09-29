#!/usr/bin/env node
// Real multi-backend PostgreSQL test. Only a newly created loopback cluster is
// accepted; no URL, .env or production credential is read. Synthetic data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalPostgres } from './local-postgres-runtime.mjs';
import { readTestSql } from './verify-master-scaling.mjs';
import { seed, runWorker, verify, summarize } from './master-concurrency-workload.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const shortError = (error) => ({ code: error?.code ?? 'TEST_ERROR', message: String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 350) });
const percentile = (values, q) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length*q)-1] : null;
function distribution(values) { return { samples: values.length, p50Ms: percentile(values,.5), p95Ms: percentile(values,.95), maxMs: values.length ? Math.max(...values) : null }; }
function config() {
  const result = { size: 50000, iterations: 200, trials: 2, stressIterations: 20, output: 'docs/performance/master-concurrency-2026-09-28.json' };
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(size|iterations|trials|stress-iterations|output)=(.+)$/);
    if (!match) throw new Error('Options: --size=N --iterations=N --trials=N --stress-iterations=N --output=relative.json');
    const key = match[1] === 'stress-iterations' ? 'stressIterations' : match[1];
    result[key] = key === 'output' ? match[2] : Number(match[2]);
  }
  const operationCount = Object.keys(summarize([])).length;
  // Twenty workers each own the workload's 200-row projection batch.
  for (const [key,min,max] of [['size',4000,2000000],['iterations',operationCount,10000],['trials',1,5],['stressIterations',0,200]]) {
    assert.ok(Number.isInteger(result[key]) && result[key]>=min && result[key]<=max, `Invalid ${key}`);
  }
  assert.ok(result.stressIterations===0 || result.stressIterations>=operationCount,'stress-iterations must cover every operation or be 0');
  assert.match(result.output, /^docs\/performance\/[a-zA-Z0-9_.-]+\.json$/);
  return result;
}

async function migrate(client) {
  await client.query(readTestSql('scripts/sql/test_prelude.sql'));
  const migrations = readdirSync(join(ROOT,'db/migrations')).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const name of migrations) {
    if (Number(name.slice(0,4))>201) continue;
    try {
      await client.query(readTestSql(`db/migrations/${name}`));
      if (name.startsWith('0003_')) await client.query(readTestSql('supabase/policies.sql'));
    } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  }
}

async function readerLoop(client, { fixture, variant, viewer, running }) {
  const samples = { page: [], counts: [], facets: [] }, errors = [];
  await client.query("select set_config('statement_timeout','15000',false)");
  if (viewer) {
    await client.query("select set_config('request.test_uid',$1,false)", [fixture.viewerId]);
    await client.query('set role authenticated');
  } else await client.query('set role service_role');
  const page = variant === 'before'
    ? 'select id,store_id,order_created_at from order_master where store_id=any($1::uuid[]) order by order_created_at desc nulls last,id asc limit 100'
    : `select * from ((select id,store_id,order_created_at from order_master where store_id=$1::uuid order by order_created_at desc nulls last,id asc limit 101)
      union all (select id,store_id,order_created_at from order_master where store_id=$2::uuid order by order_created_at desc nulls last,id asc limit 101)) candidates
      order by order_created_at desc nulls last,id asc limit 101`;
  while (running.value) {
    for (const [name,sql,params] of [
      ['page',page,variant==='before' ? [fixture.storeIds] : fixture.storeIds],
      ['counts','select * from order_master_mom_counts($1::uuid[])',[fixture.storeIds]],
      ['facets','select master_facets($1::uuid[])',[fixture.storeIds]],
    ]) {
      const start = performance.now();
      try {
        const result = await client.query(sql,params);
        samples[name].push(performance.now()-start);
        if (name === 'page') {
          assert.equal(new Set(result.rows.map((row)=>row.id)).size,result.rows.length,'Duplicate ID in page');
          assert.ok(result.rows.every((row)=>fixture.storeIds.includes(row.store_id) && (!viewer || row.store_id===fixture.storeIds[0])),'Reader store isolation failed');
        }
      } catch (error) { errors.push({ operation:name, ...shortError(error) }); }
    }
    await pause(25);
  }
  await client.query('reset role');
  return { role: viewer ? 'authenticated-store-a' : 'service-both-stores', summary: Object.fromEntries(Object.entries(samples).map(([key,values])=>[key,distribution(values)])), errors };
}

async function observeLocks(client,running) {
  const report = { observations:0, samplesWithWaitingWriters:0, maxWaitingWriters:0, maxUnGrantedLocks:0, errors:[] };
  while(running.value) {
    try {
      const { rows:[row] } = await client.query(`select
        (select count(*)::int from pg_stat_activity where datname=current_database() and application_name like 'master_concurrency_%' and wait_event_type='Lock') as writers,
        (select count(*)::int from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.datname=current_database() and not l.granted) as locks`);
      report.observations++;
      if(row.writers) report.samplesWithWaitingWriters++;
      report.maxWaitingWriters=Math.max(report.maxWaitingWriters,row.writers);
      report.maxUnGrantedLocks=Math.max(report.maxUnGrantedLocks,row.locks);
    } catch(error) { report.errors.push(shortError(error)); }
    await pause(25);
  }
  return report;
}

async function phase(runtime, database, fixture, variant, {writers,iterations,phaseIndex,label,mode}, cumulative) {
  const connections = [];
  const connect = async (name) => { const client=await runtime.connect(database,{application_name:name}); connections.push(client); return client; };
  const running = {value:true};
  let background=[];
  let backgroundSettled=Promise.resolve([]);
  try {
    const admin=await connect('concurrency-admin');
    const clients=await Promise.all(Array.from({length:writers},(_,i)=>connect(`concurrency-worker-${i}`)));
    const readers=await Promise.all([connect('concurrency-reader-service'),connect('concurrency-reader-user')]);
    const observer=await connect('concurrency-lock-observer');
    const statsBefore=(await admin.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0];
    // A callback barrier releases every writer only after every independent
    // backend has completed setup. The timeout turns setup errors into failures.
    let release, reject, arrived=0, start;
    const barrier=new Promise((done,fail)=>{release=done;reject=fail;});
    // Setup may fail before any worker awaits the barrier. Observe rejection
    // immediately; workers still receive the same rejection when they arrive.
    void barrier.catch(()=>{});
    const timer=setTimeout(()=>reject(new Error('Writer readiness timeout')),20000);
    const pids=[];
    const startBarrier=async ({backendPid})=>{
      pids.push(backendPid);
      if(++arrived===writers){ clearTimeout(timer); start=performance.now(); release(); }
      await barrier;
    };
    background=[
      readerLoop(readers[0],{fixture,variant,viewer:false,running}),
      readerLoop(readers[1],{fixture,variant,viewer:true,running}),
      observeLocks(observer,running),
    ];
    // Readers perform asynchronous role/setup calls before their query loops.
    // Attach handlers now, not after writers finish, to avoid an unhandled
    // rejection terminating Node and bypassing cluster shutdown.
    backgroundSettled=Promise.allSettled(background);
    let results;
    try {
      const workers=clients.map((client,workerId)=>runWorker(client,{fixture,workerId,iterations,phase:label,phaseIndex,mode,startBarrier})
        .catch((error)=>{reject(error);throw error;}));
      // On an early setup failure, rejecting the barrier lets every ready
      // worker leave its wait and reset its role before connections are closed.
      const settled=await Promise.allSettled(workers);
      const failure=settled.find((result)=>result.status==='rejected');
      if(failure) throw failure.reason;
      results=settled.map((result)=>result.value);
    } finally {clearTimeout(timer);running.value=false;}
    const durationMs=performance.now()-start;
    const completedBackground=await backgroundSettled;
    const backgroundFailure=completedBackground.find((result)=>result.status==='rejected');
    if(backgroundFailure) throw backgroundFailure.reason;
    const [serviceReader,userReader,locks]=completedBackground.map((result)=>result.value);
    assert.equal(new Set(pids).size,writers,'Every writer must use a separate PostgreSQL backend');
    cumulative.push(...results);
    const parity=await verify(admin,{fixture,expectSummaries:variant==='after',workerResults:cumulative});
    // Stats collectors can lag; operation SQLSTATEs are the primary error record.
    await admin.query('select pg_stat_clear_snapshot()');
    const statsAfter=(await admin.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0];
    const samples=results.flatMap((result)=>result.samples);
    const failed=samples.filter((sample)=>sample.outcome==='failed');
    const committed=samples.filter((sample)=>sample.outcome==='committed');
    const successful=samples.filter((sample)=>sample.outcome!=='failed');
    const summary=summarize(samples);
    const row={variant,label,mode,writers,iterations,phaseIndex,durationMs,
      attempts:samples.length,committed:committed.length,intentionalRollbacks:samples.filter((s)=>s.outcome==='intentional_rollback').length,
      failed:failed.length,committedPerSecond:committed.length*1000/durationMs,
      latency:distribution(successful.map((s)=>s.durationMs)),committedLatency:distribution(committed.map((s)=>s.durationMs)),
      summary,operationsCovered:Object.values(summary).every((operation)=>operation.attempts>0),backendPids:pids,
      failures:failed.slice(0,30),failuresTruncated:failed.length>30,
      stoppedWorkers:results.filter((r)=>r.stoppedEarly).map((r)=>({workerId:r.workerId,cleanupError:r.cleanupError})),
      deadlocksStatsDelta:Number(statsAfter.deadlocks)-Number(statsBefore.deadlocks),
      readers:[serviceReader,userReader],locks,verification:parity};
    console.log(JSON.stringify({phase:label,variant,mode,writers,attempts:row.attempts,failed:row.failed,p95Ms:row.committedLatency.p95Ms,committedPerSecond:Math.round(row.committedPerSecond),parity:parity.ok}));
    return row;
  } finally {
    running.value=false;
    await backgroundSettled;
    await Promise.allSettled(connections.map((client)=>client.end()));
  }
}

const settings=config();
const report={startedAt:new Date().toISOString(),settings,localOnly:true,productionTouched:false,
  baselineMigration:201, candidateMigration:202,
  migrationSha256:createHash('sha256').update(readFileSync(join(ROOT,'db/migrations/0202_master_read_scaling.sql'))).digest('hex'),
  methodology:'Real PostgreSQL independent backends; identical synthetic clones, alternating before/after order; normal=one Master statement/transaction; stress=multiple Master statements/transaction. Client SQL roundtrip, not HTTP/UI or Supabase Auth. Auth role model uses test_prelude.sql.',phases:[]};
const output=join(ROOT,settings.output);
mkdirSync(dirname(output),{recursive:true});
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n');
let runtime;
try {
  runtime=await startLocalPostgres();
  report.runtime={version:runtime.version,packageVersion:runtime.packageVersion,directory:runtime.directory,port:runtime.port};
  console.log('Preparing real migrations 0001..0201 and identical synthetic database clones.');
  const control=await runtime.connect();
  await control.query('create database concurrency_template');
  const template=await runtime.connect('concurrency_template');
  await migrate(template);
  const fixture=await seed(template,{size:settings.size,workerCount:20});
  await template.query('vacuum analyze');
  await template.end();
  report.fixture=fixture;
  await control.query('create database concurrency_before template concurrency_template');
  await control.query('create database concurrency_after template concurrency_template');
  await control.end();
  const after=await runtime.connect('concurrency_after');
  await after.query(readTestSql('db/migrations/0202_master_read_scaling.sql'));
  await after.query('vacuum analyze');
  await after.end();
  console.log(`Seeded ${fixture.size} fictitious orders per clone; starting simultaneous writes and reads.`);
  const cumulative={before:[],after:[]};
  let phaseIndex=0;
  for(let trial=1;trial<=settings.trials;trial++) {
    for(const writers of [1,5,20]) {
      const descriptor={writers,iterations:settings.iterations,phaseIndex:phaseIndex++,label:`t${trial}-c${writers}`,mode:'normal'};
      for(const variant of trial%2 ? ['before','after'] : ['after','before']) {
        report.phases.push(await phase(runtime,`concurrency_${variant}`,fixture,variant,descriptor,cumulative[variant]));save();
      }
    }
  }
  if(settings.stressIterations) {
    const descriptor={writers:5,iterations:settings.stressIterations,phaseIndex:phaseIndex++,label:'adverse-c5',mode:'multi_statement_stress'};
    for(const variant of ['before','after']) {
      report.phases.push(await phase(runtime,`concurrency_${variant}`,fixture,variant,descriptor,cumulative[variant]));save();
    }
  }
  const fullyObservedAndCorrect=(p)=>p.failed===0 && p.stoppedWorkers.length===0
    && p.attempts===p.writers*p.iterations && p.operationsCovered && p.verification.ok
    && p.readers.every((r)=>r.errors.length===0 && Object.values(r.summary).every((metric)=>metric.samples>0))
    && p.locks.errors.length===0 && p.locks.observations>0;
  report.normalCorrectnessPassed=report.phases.filter((p)=>p.mode==='normal').every(fullyObservedAndCorrect);
  report.adverseCorrectnessPassed=report.phases.filter((p)=>p.mode==='multi_statement_stress').every(fullyObservedAndCorrect);
  report.completedAt=new Date().toISOString();
  console.log(JSON.stringify({output:settings.output,normalCorrectnessPassed:report.normalCorrectnessPassed,adverseCorrectnessPassed:report.adverseCorrectnessPassed}));
  if(!report.normalCorrectnessPassed || !report.adverseCorrectnessPassed) process.exitCode=2;
} catch(error) {
  report.error=shortError(error);process.exitCode=1;console.error(JSON.stringify(report.error));
} finally {
  if(runtime) {
    try {await runtime.stop();report.stoppedAt=new Date().toISOString();}
    catch(error){report.shutdownError=shortError(error);process.exitCode=1;}
  }
  save();
}
