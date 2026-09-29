import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { stagingContext, checked, loadFixture } from './staging-master-context';
import { recomputeOrderMaster, clearTariffCache } from '../lib/order-master';
import { loadMasterCursorPage, compareMasterRows, type MasterCursor } from '../lib/master-pagination';
const variant=process.argv[2] ?? '';
assert.ok(['before','after','0202-read'].includes(variant),'Specify before, after or 0202-read');
const ctx=stagingContext(), fixture=loadFixture();
const report:any={project:'zuloxsrfcwhefedgfcnb',variant,startedAt:new Date().toISOString(),roles:[],phases:[],errors:[]};
const clients=new Map<string,ReturnType<typeof ctx.user>>();
const stats=(a:number[])=>{const s=[...a].sort((a,b)=>a-b);return {samples:s.length,p50Ms:s[Math.ceil(s.length*.5)-1],p95Ms:s[Math.ceil(s.length*.95)-1],maxMs:s.at(-1)}};
async function login(name:string) {
  if(clients.has(name)) return clients.get(name)!;
  const user=fixture.users.find((u:any)=>u.name===name),client=ctx.user();
  checked(await client.auth.signInWithPassword({email:user.email,password:user.password}),'login');
  clients.set(name,client);return client;
}
async function page(client:any,stores:string[],cursor:MasterCursor|null) {
  return loadMasterCursorPage<any>(stores,100,cursor,async(storeId,segment,limit)=>{
    let q=client.from('order_master').select('id,order_id,order_created_at,store_id').eq('store_id',storeId);
    const backwards=cursor?.direction==='previous';
    if(segment==='undated') {q=q.is('order_created_at',null);if(cursor?.createdAt===null) q=backwards?q.lt('id',cursor.id):q.gt('id',cursor.id);}
    else if(segment==='dated') {q=q.not('order_created_at','is',null);if(cursor?.createdAt){const at=cursor.createdAt;q=backwards?q.gte('order_created_at',at):q.lte('order_created_at',at);q=q.or(backwards?`order_created_at.gt.${at},and(order_created_at.eq.${at},id.lt.${cursor.id})`:`order_created_at.lt.${at},and(order_created_at.eq.${at},id.gt.${cursor.id})`);}}
    return checked(await q.order('order_created_at',{ascending:!!backwards,nullsFirst:!!backwards}).order('id',{ascending:!backwards}).limit(limit),'page');
  });
}
async function parity(client:any,name:string) {
  const rows:any[]=checked(await client.from('order_master').select('*').in('store_id',fixture.storeIds),'all rows');
  const counts:any[]=checked(await client.rpc('order_master_mom_counts',{p_store_ids:fixture.storeIds}),'counts');
  const expectedCounts=new Map<string,number>();for(const r of rows){const key=`${r.macro_stage}:${r.macro_substage}`;expectedCounts.set(key,(expectedCounts.get(key)??0)+1);}
  assert.deepEqual(Object.fromEntries(counts.filter(r=>Number(r.total)!==0).map(r=>[`${r.macro_stage}:${r.macro_substage}`,Number(r.total)])),Object.fromEntries(expectedCounts),`${name} counts`);
  const facets=checked(await client.rpc('master_facets',{p_store_ids:fixture.storeIds}),'facets');
  for(const [dim,columns] of Object.entries({operational:['operational_status'],courier:['current_courier','last_courier'],region:['region'],province:['province'],district:['district'],coverage:['coverage'],pickup:['pickup_state']})) {
    assert.deepEqual([...facets[dim]].sort(),[...new Set(rows.flatMap(r=>columns.map(c=>r[c])).filter(v=>v!==null))].sort(),`${name} ${dim}`);
  }
  return rows;
}
try {
  for(const name of ['admin','viewer1','blocked','rider']) {
    const client=await login(name),rows=await parity(client,name);
    const expected=name==='admin'?420:name==='viewer1'?210:name==='rider'?1:0;
    assert.equal(rows.length,expected,`${name} row isolation`);
    if(name==='rider') assert.equal(rows[0].order_id,fixture.riderOrderId);
    const pages:any[][]=[],all:any[]=[];let cursor:MasterCursor|null=null;
    for(let i=0;i<10;i++) {const batch=await page(client,fixture.storeIds,cursor);if(!batch.length)break;pages.push(batch);all.push(...batch);const last=batch.at(-1);cursor={id:last.id,createdAt:last.order_created_at,direction:'next'};}
    assert.deepEqual(all.map(r=>r.id),[...rows].sort(compareMasterRows).map(r=>r.id),'Complete ordered traversal');
    for(let i=pages.length-1;i>0;i--){const first=pages[i]![0];const prev=await page(client,fixture.storeIds,{id:first.id,createdAt:first.order_created_at,direction:'previous'});assert.deepEqual(prev.map(r=>r.id),pages[i-1]!.map(r=>r.id),'Previous page');}
    report.roles.push({name,visible:rows.length,pages:pages.map(p=>p.length),forwardBackwardExact:true,countsExact:true,facetsExact:true});
  }
  // Actual Supabase Auth sessions and application projection over PostgREST.
  // Each writer owns one order, matching independent Shopify synchronizations.
  for(let trial=0;trial<(variant==='0202-read'?0:2);trial++) for(const workers of [1,5,20]) {
    const sessions=await Promise.all(Array.from({length:workers},(_,i)=>login(`viewer${i+1}`)));
    const samples:number[]=[],readSamples:number[]=[],eventIds:string[]=[];
    clearTariffCache();
    await Promise.all(sessions.map(async(client,i)=>{
      const order=fixture.orders[i*2], phase=(variant==='before'?1:2)*10000+trial*1000+workers*10;
      for(let iteration=0;iteration<4;iteration++) {
        const start=performance.now();
        checked(await ctx.admin.from('orders').upsert({...order,total_amount:120+iteration}),'ingestion');
        const projected=await recomputeOrderMaster(ctx.admin,[order.id]);assert.equal(projected.written,1);
        samples.push(performance.now()-start);
        const eventId=`01980000-0000-4000-0007-${String(phase*1000+i*10+iteration).padStart(12,'0')}`;
        checked(await ctx.admin.from('order_events').insert({id:eventId,store_id:order.store_id,order_id:order.id,kind:'comment',actor:fixture.users.find((u:any)=>u.name===`viewer${i+1}`).id,note:'VALIDACION FICTICIA CONCURRENTE'}),'audit event');eventIds.push(eventId);
        const readStart=performance.now();const batch=await page(client,[fixture.storeIds[0]],null);assert.equal(batch.length,100);assert.ok(batch.every(r=>r.store_id===fixture.storeIds[0]));readSamples.push(performance.now()-readStart);
      }
    }));
    const events=checked(await ctx.admin.from('order_events').select('id').in('id',eventIds),'audit parity');assert.equal(events.length,eventIds.length);
    await parity(await login('admin'),'admin after concurrent writes');
    const phase={trial,workers,ingestionAndProjection:stats(samples),authenticatedPage:stats(readSamples),eventsExpected:eventIds.length,eventsFound:events.length};
    report.phases.push(phase);console.log(JSON.stringify(phase));
  }
  // A source retry keeps the source order and its projection unique.
  const order=fixture.orders[0];for(let i=0;i<(variant==='0202-read'?0:3);i++){checked(await ctx.admin.from('orders').upsert(order),'retry');await recomputeOrderMaster(ctx.admin,[order.id]);}
  assert.equal(checked(await ctx.admin.from('orders').select('id').eq('shopify_order_id',order.shopify_order_id).eq('store_id',order.store_id),'unique source').length,1);
  assert.equal(checked(await ctx.admin.from('order_master').select('id').eq('order_id',order.id),'unique projection').length,1);
  report.idempotency=true;report.passed=true;
} catch(error:any) {report.errors.push({name:error.name,message:error.message});process.exitCode=1;console.error(error.message);}
finally {report.finishedAt=new Date().toISOString();writeFileSync(`docs/performance/master-staging-${variant}-2026-09-28.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({variant,passed:report.passed??false,roles:report.roles,phases:report.phases.length}));}
