#!/usr/bin/env node
// A fresh loopback-only PostgreSQL cluster; no .env, remote URL or real data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { startLocalPostgres } from './local-postgres-runtime.mjs';
import { readTestSql } from './verify-master-scaling.mjs';
import { seed } from './master-concurrency-workload.mjs';

const candidate = 'db/migrations/0203_master_read_scaling.sql';
const report = { localOnly: true, productionTouched: false, candidate,
  sha256: createHash('sha256').update(readFileSync(candidate)).digest('hex'),
  startedAt: new Date().toISOString(), checks: [] };
const qi = value => '"' + value.replaceAll('"','""') + '"';
let runtime;
try {
  runtime = await startLocalPostgres({major:17});
  let db = await runtime.connect();
  report.version=runtime.version;
  await db.query(readTestSql('scripts/sql/test_prelude.sql'));
  for (const file of readdirSync('db/migrations').filter(f => /^\d{4}_.*\.sql$/.test(f) && +f.slice(0,4) <= 202).sort()) {
    await db.query(readTestSql('db/migrations/'+file));
    if (file.startsWith('0003_')) await db.query(readTestSql('supabase/policies.sql'));
  }
  const f = await seed(db,{size:4000,workerCount:20});
  await db.query(`insert into order_events(store_id,order_id,kind,source,note)
    select store_id,id,'comment','manual','Synthetic preserved audit' from orders limit 20`);
  await db.query(`insert into shipments(store_id,order_id,courier,guide_code,order_name,matched,match_method)
    select store_id,id,courier,'PRESERVE-'||courier,name,true,'manual'
    from orders cross join (values ('aliclik'),('fenix')) c(courier)
    where shopify_order_id='concurrency-1'`);
  // Opaque fake credentials verify byte preservation without contacting providers.
  await db.query(`insert into swayp_inventory_sessions(org_id,token_enc,email,ruc,id_company,expires_at,source)
    values($1,'synthetic-ciphertext','test@test.invalid','synthetic','synthetic',now()+interval '1 day','manual');`,[f.orgId]);
  await db.query(`insert into swayp_extension_keys(org_id,key_hash) values($1,'synthetic-hash')`,[f.orgId]);
  await db.query(`insert into swayp_inventory_sync_runs(org_id,source,ok,resumen)
    values($1,'cron',true,'{"synthetic":true}')`,[f.orgId]);

  const tables = (await db.query(`select n.nspname as schema,c.relname as name
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','auth') and c.relkind='r'
    order by 1,2`)).rows;
  async function capture() {
    const result = {tables:[], functions:[], triggers:[], policies:[], relations:[]};
    for(const t of tables) {
      const q = `${qi(t.schema)}.${qi(t.name)}`;
      const r = (await db.query(`select count(*)::int as rows,
        md5(coalesce(string_agg(row_hash,'' order by row_hash),'')) as digest
        from (select md5(to_jsonb(t)::text) row_hash from ${q} t) hashes`)).rows[0];
      result.tables.push({table:t.schema+'.'+t.name,...r});
    }
    result.functions = (await db.query(`select p.oid::regprocedure::text signature,
      md5(pg_get_functiondef(p.oid)) definition,p.proacl::text acl
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','auth') and p.prokind='f'
      and p.proname not in ('order_master_mom_counts','master_facets',
        'maintain_order_master_read_totals','master_visible_rider_order_ids')
      order by 1`)).rows;
    result.triggers = (await db.query(`select t.tgrelid::regclass::text relation,t.tgname,
      md5(pg_get_triggerdef(t.oid)) definition,t.tgenabled
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','auth') and not t.tgisinternal
      and t.tgname not in ('order_master_read_insert','order_master_read_update','order_master_read_delete')
      order by 1,2`)).rows;
    result.policies = (await db.query(`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
      from pg_policies where schemaname in ('public','auth')
      and tablename not in ('order_master_stage_parts','order_master_facet_parts') order by 1,2,3`)).rows;
    result.relations = (await db.query(`select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','auth') and c.relkind='r'
      and c.relname not in ('order_master_stage_parts','order_master_facet_parts') order by 1,2`)).rows;
    return result;
  }
  const before = await capture();
  const sql = readTestSql(candidate);
  await db.query(sql.slice(sql.indexOf('create index if not exists order_master_store_created_page_idx')));
  const install = readTestSql('scripts/sql/master_read_scaling_install.sql');
  // Inject an error after all migration statements but before COMMIT.
  await assert.rejects(db.query(install.replace(/commit;\s*$/i,
    "do $fail$ begin raise exception 'injected precommit failure'; end $fail$; commit;")), /injected precommit failure/);
  await db.query('rollback');
  assert.deepEqual(await capture(),before);
  assert.equal((await db.query("select to_regclass('public.order_master_stage_parts') name")).rows[0].name,null);
  report.checks.push('failure immediately before commit leaves original data and behavior unchanged');

  // A busy writer makes installation abort; its valid update still commits.
  const writer = await runtime.connect();
  await writer.query('begin');
  await writer.query("update orders set total_amount=101.23 where shopify_order_id='concurrency-2'");
  await writer.query("update order_master set order_total=101.23 where shopify_order_id='concurrency-2'");
  await assert.rejects(db.query(install.replace("lock_timeout = '5s'","lock_timeout = '200ms'")), /lock timeout/);
  await db.query('rollback');
  await writer.query('commit');
  await writer.end();
  const afterWriter = await capture();
  assert.equal((await db.query("select order_total::text amount from order_master where shopify_order_id='concurrency-2'")).rows[0].amount,'101.23');
  assert.equal((await db.query("select to_regclass('public.order_master_stage_parts') name")).rows[0].name,null);
  report.checks.push('installation refuses a blocked source; concurrent committed update is retained');
  for(const [label,file] of [
    ['install','scripts/sql/master_read_scaling_install.sql'],
    ['rollback','scripts/sql/master_read_scaling_rollback.sql'],
    ['reinstall','scripts/sql/master_read_scaling_install.sql'],
  ]) {
    await db.query(readTestSql(file));
    assert.deepEqual(await capture(),afterWriter,`${label}: pre-existing data or behavior changed`);
    if(label!=='rollback') await db.query(readTestSql('scripts/sql/master_read_scaling_preflight.sql'));
    report.checks.push(`${label}: all pre-existing table contents, non-target functions, triggers, policies and grants preserved`);
  }
  report.tables = afterWriter.tables;
  report.protectedFunctions = afterWriter.functions.length;
  report.protectedTriggers = afterWriter.triggers.length;
  report.protectedPolicies = afterWriter.policies.length;
  const bin=resolve('../.performance-tools/postgresql-17.11/pgsql/bin');
  const backup=join(runtime.directory,'synthetic-roundtrip.dump');
  const childEnv={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG/i.test(key))),
    PGHOST:'127.0.0.1',PGPORT:String(runtime.port),PGUSER:'postgres',PGDATABASE:'postgres',PGSSLMODE:'disable'};
  execFileSync(join(bin,'pg_dump.exe'),['--format=custom','--file',backup],
    {env:childEnv,windowsHide:true,timeout:60000,stdio:'pipe'});
  await db.query('create database backup_roundtrip');
  execFileSync(join(bin,'pg_restore.exe'),['--exit-on-error','--single-transaction','--dbname','backup_roundtrip',backup],
    {env:childEnv,windowsHide:true,timeout:60000,stdio:'pipe'});
  await db.end();db=await runtime.connect('backup_roundtrip');
  assert.deepEqual(await capture(),afterWriter,'actual dump/restore changed data or protected behavior');
  await db.query(readTestSql('scripts/sql/master_read_scaling_preflight.sql'));
  report.backupRoundtrip={synthetic:true,passed:true,sha256:createHash('sha256').update(readFileSync(backup)).digest('hex')};
  report.checks.push('actual PostgreSQL 17 dump restored into a separate empty database with identical source data and passing parity');
  report.ok = true;
} catch(error) {
  report.ok=false;report.error={code:error.code,message:String(error.message).slice(0,1200)};
  process.exitCode=1;
} finally {
  if(runtime) await runtime.stop();
  report.completedAt=new Date().toISOString();
  writeFileSync('docs/performance/master-preservation-2026-09-29.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,tables:report.tables?.length}));
}
