import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { stagingContext, checked, loadFixture } from './staging-master-context';
import { reconcileOrderMaster } from '../lib/order-master';
const {admin}=stagingContext(), fixture=loadFixture();
const orderId=fixture.orders[0].id;
const original=checked(await admin.from('orders').select('id,total_amount').eq('id',orderId).single(),'source');
const eventIds=checked(await admin.from('order_events').select('id').in('store_id',fixture.storeIds).order('id'),'events').map((r:any)=>r.id);
const shipmentIds=checked(await admin.from('shipments').select('id,order_id,output_code,qr_token').in('store_id',fixture.storeIds).order('id'),'outputs');
const runs=[];
try {
  for(const amount of [211.11,Number(original.total_amount)]) {
    checked(await admin.from('orders').update({total_amount:amount}).eq('id',orderId),'synthetic source change');
    const result=await reconcileOrderMaster(admin,fixture.storeIds,{limit:1000,staleBefore:new Date().toISOString(),deadline:Date.now()+90000});
    assert.equal(result.failed??0,0);assert.equal(result.deferred??0,0);assert.equal(result.written,420);
    const row=checked(await admin.from('order_master').select('order_id,order_total').eq('order_id',orderId),'reconciled');
    assert.equal(row.length,1);assert.equal(Number(row[0]!.order_total),amount);runs.push(result);
  }
  assert.deepEqual(checked(await admin.from('order_events').select('id').in('store_id',fixture.storeIds).order('id'),'events after').map((r:any)=>r.id),eventIds);
  assert.deepEqual(checked(await admin.from('shipments').select('id,order_id,output_code,qr_token').in('store_id',fixture.storeIds).order('id'),'outputs after'),shipmentIds);
  const report={project:'zuloxsrfcwhefedgfcnb',passed:true,runs,eventsPreserved:eventIds.length,outputsPreserved:shipmentIds.length,providersContacted:false,at:new Date().toISOString()};
  writeFileSync('docs/performance/master-staging-reconcile-2026-09-29.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error) {console.error('Staging reconciliation failed; inspect the synthetic fixture before repeating.');throw error;}
