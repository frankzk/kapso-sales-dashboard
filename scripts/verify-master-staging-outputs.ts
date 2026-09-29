import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { stagingContext, checked, loadFixture } from './staging-master-context';
import { recomputeOrderMaster } from '../lib/order-master';
const {admin}=stagingContext(),f=loadFixture(),o=f.orders[355];
const existing=checked(await admin.from('shipments').select('id').eq('order_id',o.id),'existing outputs');
if(!existing.length) checked(await admin.from('shipments').insert([1,2].map(n=>({
  id:`01980000-0000-4000-0008-00000000000${n}`,store_id:o.store_id,order_id:o.id,order_name:o.name,
  courier:n===1?'aliclik':'fenix',guide_code:`STAGING-ONLY-0356-${n}`,matched:true,match_method:'manual',
  delivery_status:n===1?'devuelto':'en_ruta',status_category:n===1?'failure':'in_transit',
  created_at:`2026-09-${18+n}T12:00:00Z`,dispatched_at:`2026-09-${18+n}T15:00:00Z`,
  returned_at:n===1?'2026-09-20T12:00:00Z':null,preparation_state:'listo_despacho',custody_state:n===1?'devuelto':'courier',
  district:'Miraflores',region:'Lima',city:'lima'
}))), 'two synthetic outputs');
const before=checked(await admin.from('shipments').select('id,output_number,output_code,qr_token').eq('order_id',o.id).order('output_number'),'identities');
assert.equal(before.length,2);assert.equal(new Set(before.map((s:any)=>s.qr_token)).size,2);
for(let n=0;n<2;n++){const result=await recomputeOrderMaster(admin,[o.id]);assert.equal(result.written,1);}
const after=checked(await admin.from('shipments').select('id,output_number,output_code,qr_token').eq('order_id',o.id).order('output_number'),'identities after');assert.deepEqual(after,before);
const master=checked(await admin.from('order_master').select('order_id,courier_count').eq('order_id',o.id),'master');assert.equal(master.length,1);assert.equal(master[0]!.courier_count,2);
const report={project:'zuloxsrfcwhefedgfcnb',passed:true,orderId:o.id,oneMasterRow:true,twoPhysicalOutputs:true,identitiesPreserved:true,outputs:after,at:new Date().toISOString()};
writeFileSync('docs/performance/master-staging-outputs-2026-09-28.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
