import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { stagingContext, checked, saveFixture, loadFixture, FIXTURE_FILE } from './staging-master-context';
import { recomputeOrderMaster } from '../lib/order-master';
const {admin}=stagingContext();
const id=(group:number,n:number)=>`01980000-0000-4000-${String(group).padStart(4,'0')}-${String(n).padStart(12,'0')}`;
const fixture=existsSync(FIXTURE_FILE)?loadFixture():{orgId:id(1,1),storeIds:[id(2,1),id(2,2)],users:[],orders:[]};
saveFixture(fixture);
const names=['admin',...Array.from({length:20},(_,i)=>`viewer${i+1}`),'blocked','rider'];
for(const name of names) {
  if(fixture.users.some((u:any)=>u.name===name)) continue;
  const email=`master-${name}@kapso-staging.example.test`,password=randomBytes(24).toString('base64url');
  const data=checked(await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{full_name:`Prueba ${name}`}}),`create ${name}`);
  if(!data.user) throw new Error('Auth did not create a user');
  fixture.users.push({name,email,password,id:data.user.id}); saveFixture(fixture);
}
checked(await admin.from('organizations').upsert({id:fixture.orgId,name:'VALIDACION FICTICIA MASTER'}),'org');
checked(await admin.from('stores').upsert(fixture.storeIds.map((storeId:string,i:number)=>({id:storeId,org_id:fixture.orgId,name:`PRUEBA ${i?'B':'A'}`,shopify_domain:`master-staging-${i}.example.test`,status:'active'}))),'stores');
checked(await admin.from('memberships').upsert(fixture.users.filter((u:any)=>u.name!=='blocked').map((u:any)=>({user_id:u.id,org_id:fixture.orgId,role:u.name==='admin'?'owner':u.name==='rider'?'motorizado':'viewer'}))),'memberships');
checked(await admin.from('user_store_access').upsert(fixture.users.filter((u:any)=>u.name.startsWith('viewer')).map((u:any)=>({user_id:u.id,store_id:fixture.storeIds[0]}))),'store grants');
const orders=Array.from({length:420},(_,i)=>({id:id(3,i+1),store_id:fixture.storeIds[i%2],shopify_order_id:`staging-${i+1}`,name:`#PRUEBA${String(i+1).padStart(4,'0')}`,
  created_at:i>=400?null:`2026-09-${String(10+Math.floor(i/100)).padStart(2,'0')}T12:00:00.${String(i%4).padStart(6,'0')}Z`,
  total_amount:100+i%25,currency:'PEN',financial_status:'pending',shipping_mode:i%3===0?'agency':'cod',tags:[],
  raw:{id:`staging-${i+1}`,name:`#PRUEBA${String(i+1).padStart(4,'0')}`,shipping_address:{first_name:'Cliente',last_name:`Ficticio ${i+1}`,province:i%3===0?'Arequipa':'Lima',city:i%3===0?'Arequipa':'Miraflores',address1:'DIRECCION FICTICIA'},line_items:[]}}));
for(let i=0;i<orders.length;i+=100) checked(await admin.from('orders').upsert(orders.slice(i,i+100)),'orders');
for(let i=0;i<orders.length;i+=100) {
  const result=await recomputeOrderMaster(admin,orders.slice(i,i+100).map(o=>o.id));
  if(result.written!==Math.min(100,orders.length-i)) throw new Error('Projection incomplete');
}
fixture.orders=orders.map(({raw,...o})=>o); saveFixture(fixture);
const rider=fixture.users.find((u:any)=>u.name==='rider');
checked(await admin.from('riders').upsert({id:id(4,1),org_id:fixture.orgId,user_id:rider.id,full_name:'Motorizado Ficticio'}),'rider');
checked(await admin.from('delivery_routes').upsert([1,2].map(n=>({id:id(5,n),org_id:fixture.orgId,store_id:fixture.storeIds[1],rider_id:id(4,1),route_date:`2026-09-${20+n}`,status:'cerrada'}))),'routes');
checked(await admin.from('delivery_stops').upsert([1,2].map(n=>({id:id(6,n),route_id:id(5,n),order_id:orders[1]!.id,seq:1}))), 'stops');
fixture.riderOrderId=orders[1]!.id; saveFixture(fixture);
console.log(JSON.stringify({project:'kapso-sales-staging',users:fixture.users.length,orders:orders.length,stores:2,credentials:'local ignored file only'}));
