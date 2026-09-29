import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { stagingContext, checked, loadFixture } from './staging-master-context';
import { recomputeOrderMaster } from '../lib/order-master';
const phase=process.argv[2];assert.ok(phase==='rollback'||phase==='reinstalled');
const {admin}=stagingContext(),f=loadFixture();
const reportFile='docs/performance/master-staging-rollback-2026-09-28.json';
const report:any=phase==='rollback'?{project:'zuloxsrfcwhefedgfcnb',startedAt:new Date().toISOString()}:JSON.parse(readFileSync(reportFile,'utf8'));
const source=checked(await admin.from('orders').select('id').in('store_id',f.storeIds).order('id'),'source').map((r:any)=>r.id);
const events=checked(await admin.from('order_events').select('id').in('store_id',f.storeIds).order('id'),'events').map((r:any)=>r.id);
if(phase==='rollback') {
  assert.equal(source.length,420);assert.equal(events.length,417);
  report.sourceIds=source;report.eventIds=events;
  checked(await admin.from('orders').update({total_amount:199}).eq('id',f.orders[0].id),'write while reverted');
  const projected=await recomputeOrderMaster(admin,[f.orders[0].id]);assert.equal(projected.written,1);
}else {assert.deepEqual(source,report.sourceIds);assert.deepEqual(events,report.eventIds);}
const rows=checked(await admin.from('order_master').select('id,order_id,macro_stage,macro_substage,order_total').in('store_id',f.storeIds),'master');
assert.equal(rows.length,420);assert.equal(Number(rows.find((r:any)=>r.order_id===f.orders[0].id)?.order_total),199);
const expected:any={};for(const r of rows){const k=`${r.macro_stage}:${r.macro_substage}`;expected[k]=(expected[k]??0)+1;}
const counts=checked(await admin.rpc('order_master_mom_counts',{p_store_ids:f.storeIds}),'counts');
assert.deepEqual(Object.fromEntries(counts.map((r:any)=>[`${r.macro_stage}:${r.macro_substage}`,Number(r.total)])),expected);
report[phase]={passed:true,sourceRows:source.length,events:events.length,projectionWritePreserved:true,countsExact:true,at:new Date().toISOString()};
writeFileSync(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report[phase]));
