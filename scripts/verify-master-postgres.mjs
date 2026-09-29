#!/usr/bin/env node
// All SQL smoke fixtures from CI, on a new local PostgreSQL 16 cluster only.
// Includes bundle installation and Master rollback/reinstall. This does not
// replace verify-db.sh's separate TypeScript/SQL daily-rollup comparison.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalPostgres } from './local-postgres-runtime.mjs';
import { readTestSql } from './verify-master-scaling.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = { localOnly:true, productionTouched:false, startedAt:new Date().toISOString(), checks:[] };
// psql sends each statement separately. Sending the whole fixture as one query
// creates an implicit transaction, changing now()/updated_at test semantics.
function statements(sql) {
  const result=[];
  let start=0, quote=null, dollar=null, block=0, line=false, escaped=false;
  for(let i=0;i<sql.length;i++) {
    const c=sql[i], next=sql[i+1];
    if(line) { if(c==='\n') line=false; continue; }
    if(block) {
      if(c==='/' && next==='*') { block++; i++; }
      else if(c==='*' && next==='/') { block--; i++; }
      continue;
    }
    if(dollar) { if(sql.startsWith(dollar,i)) { i+=dollar.length-1; dollar=null; } continue; }
    if(quote) {
      if(escaped && c==='\\') { i++; continue; }
      if(c===quote) { if(next===quote) i++; else quote=null; }
      continue;
    }
    if(c==='-' && next==='-') { line=true; i++; }
    else if(c==='/' && next==='*') { block=1; i++; }
    else if(c==="'" || c==='"') { quote=c; escaped=c==="'" && /[eE]/.test(sql[i-1] ?? ''); }
    else if(c==='$') {
      const tag=sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/)?.[0];
      if(tag) { dollar=tag; i+=tag.length-1; }
    } else if(c===';') { result.push(sql.slice(start,i+1)); start=i+1; }
  }
  if(quote || dollar || block) throw new Error('Unterminated SQL fixture token');
  if(sql.slice(start).trim()) result.push(sql.slice(start));
  return result;
}
async function execute(client, sql) {
  for(const statement of statements(sql)) await client.query(statement);
}
let runtime;
try {
  runtime = await startLocalPostgres();
  report.version = runtime.version;
  const db = await runtime.connect();
  const run = async file => {
    try { await execute(db,readTestSql(file)); }
    catch(error) { error.message = `${file}: ${error.message}`; throw error; }
  };
  await run('scripts/sql/test_prelude.sql');
  for (const file of readdirSync(join(root,'db/migrations')).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort()) {
    await run(`db/migrations/${file}`);
    if (file.startsWith('0003_')) await run('supabase/policies.sql');
    if (file.startsWith('0006_')) await run('scripts/sql/rls_smoke.sql');
  }
  report.checks.push('full migration chain and initial RLS fixture');
  // A single protocol message must also remain safe when the same backend
  // switches between administrator, viewer, owner and rider roles.
  await db.query(readTestSql('scripts/sql/master_read_scaling_smoke.sql'));
  report.checks.push('Master role-switch regression in one protocol message');
  const script = readFileSync(join(root,'scripts/verify-db.sh'),'utf8');
  const files = [...script.matchAll(/\$PSQL -f "\$ROOT\/(scripts\/sql\/[^"\n]+_smoke\.sql)"/g)].map(m => m[1]);
  for (const file of files.filter(f => !f.endsWith('/rls_smoke.sql'))) {
    await run(file);
    report.checks.push(file);
    console.log(`PASS ${file}`);
  }
  await run('scripts/sql/master_read_scaling_preflight.sql');
  report.checks.push('Master parity release gate after operational fixtures');
  await db.query('create database rollback_check');
  const rollback = await runtime.connect('rollback_check');
  await execute(rollback,readTestSql('scripts/sql/test_prelude.sql'));
  for(const file of readdirSync(join(root,'db/migrations')).filter(f => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0,4))<=202).sort()) {
    await execute(rollback,readTestSql(`db/migrations/${file}`));
    if(file.startsWith('0003_')) await execute(rollback,readTestSql('supabase/policies.sql'));
  }
  await execute(rollback,readTestSql('scripts/sql/master_read_scaling_rollback_smoke.sql'));
  await rollback.end();
  report.checks.push('Master rollback/reinstall from schema 0202');
  await db.query('create database bundle_check');
  const bundle = await runtime.connect('bundle_check');
  await execute(bundle,readTestSql('scripts/sql/test_prelude.sql'));
  await execute(bundle,readFileSync(join(root,'db/apply_bundled.sql'),'utf8'));
  await bundle.end();
  report.checks.push('fresh generated bundle');
  report.ok = true;
} catch(error) {
  report.ok = false;
  report.error = { code:error.code, message:String(error.message).slice(0,1800), context:String(error.where ?? '').slice(0,500) };
  process.exitCode = 1;
} finally {
  if(runtime) await runtime.stop();
  report.completedAt = new Date().toISOString();
  writeFileSync(join(root,'docs/performance/master-postgres-smoke-2026-09-29.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}
