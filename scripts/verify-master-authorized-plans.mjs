// Read-only follow-up against the retained, synthetic local PG16 clusters.
// No environment file, remote host, arbitrary database URL or production data.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const tools=resolve('..','.performance-tools'),runs=join(tools,'pg-runs');
const bin=join(tools,'node_modules','kapso-postgres-16','native','bin');
const {Client}=await import(pathToFileURL(join(tools,'node_modules','pg','esm','index.mjs')));
const env={SystemRoot:process.env.SystemRoot,PATH:`${bin};${process.env.SystemRoot}\\System32`,TEMP:process.env.TEMP,TMP:process.env.TMP};
const result={localOnly:true,readOnly:true,checks:[]};
for(const scale of ['50k','200k','1m']) {
  const evidence=JSON.parse(readFileSync(`docs/performance/master-concurrency-current-${scale}-pg16.json`,'utf8'));
  const directory=resolve(evidence.runtime?.directory ?? evidence.postgres?.directory ?? evidence.environment?.directory ?? '');
  assert.ok(relative(runs,directory).startsWith('concurrency-')&&!relative(runs,directory).includes('..'),'Synthetic cluster only');
  const stopped=JSON.parse(readFileSync(join(directory,'stopped.json'),'utf8')),data=join(directory,'data');
  const port=stopped.port;
  let client;
  try {
    execFileSync(join(bin,'pg_ctl.exe'),['-D',data,'-l',join(directory,'authorized-plan.log'),'-o',`-p ${port} -c listen_addresses=127.0.0.1`,'-w','start'],{env,windowsHide:true,stdio:'ignore',timeout:30000});
    client=new Client({host:'127.0.0.1',port,user:'postgres',password:()=> 'local-test',database:'concurrency_after',ssl:false,options:'-c default_transaction_read_only=on -c statement_timeout=30000'});
    await client.connect();assert.equal(resolve((await client.query("select current_setting('data_directory') as d")).rows[0].d),data);
    await client.query("select set_config('request.test_uid',$1,false)",[evidence.fixture.viewerId]);await client.query('set role authenticated');
    const store=evidence.fixture.storeIds[0];
    const anchor=(await client.query('select id,order_created_at::text from order_master where store_id=$1 order by order_created_at desc nulls last,id asc offset $2 limit 1',[store,Math.floor(evidence.settings.size*.4)])).rows[0];
    const queries=[
      ['first','select * from order_master where store_id=$1 order by order_created_at desc nulls last,id asc limit 101',[store]],
      ['deep',`select * from order_master where store_id=$1 and order_created_at <= $2 and (order_created_at < $2 or (order_created_at=$2 and id>$3)) order by order_created_at desc nulls last,id asc limit 101`,[store,anchor.order_created_at,anchor.id]],
      ['counts','select * from order_master_mom_counts($1::uuid[])',[[store]]],
      ['facets','select master_facets($1::uuid[])',[[store]]],
    ];
    for(const [name,sql,params] of queries) {
      const plans=[];for(let n=0;n<4;n++)plans.push((await client.query(`explain (analyze,buffers,format json) ${sql}`,params)).rows[0]['QUERY PLAN'][0]);
      result.checks.push({scale,name,migrationSha256:evidence.migrationSha256,authorizedStores:1,executionMs:plans.map(p=>p['Execution Time']),plan:plans.at(-1)});
    }
  }finally {if(client)await client.end();execFileSync(join(bin,'pg_ctl.exe'),['-D',data,'-m','fast','-w','stop'],{env,windowsHide:true,stdio:'ignore',timeout:30000});writeFileSync(join(directory,'stopped.json'),JSON.stringify({stoppedAt:new Date().toISOString(),port},null,2));}
}
writeFileSync('docs/performance/master-authorized-plans-2026-09-28.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result.checks.map(({plan,...r})=>r)));
