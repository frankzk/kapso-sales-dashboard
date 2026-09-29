import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServerClient } from '@supabase/ssr';
import ExcelJS from 'exceljs';
import { stagingContext, checked, loadFixture } from './staging-master-context';
const ctx=stagingContext(),fixture=loadFixture(),origin='http://127.0.0.1:3100';
const report:any={project:'zuloxsrfcwhefedgfcnb',origin,startedAt:new Date().toISOString(),checks:[],errors:[]};
const rows:any[]=checked(await ctx.admin.from('order_master').select('*').in('store_id',fixture.storeIds),'expected');
async function session(name:string) {
  const jar=new Map<string,string>();const u=fixture.users.find((u:any)=>u.name===name);
  const sb=createServerClient(ctx.url,ctx.anon,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:cs=>{for(const c of cs)jar.set(c.name,c.value)}}});
  checked(await sb.auth.signInWithPassword({email:u.email,password:u.password}),'session');
  return [...jar].map(([k,v])=>`${k}=${v}`).join('; ');
}
async function exportCheck(cookie:string,label:string,query:string,expected:any[],selected?:string[]) {
  const start=performance.now();const response=await fetch(`${origin}/api/export/pedidos${query}`,{method:selected?'POST':'GET',headers:{cookie,...(selected?{'Content-Type':'application/json'}:{})},body:selected?JSON.stringify({ids:selected}):undefined});
  assert.equal(response.status,200,`${label} status`);const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(await response.arrayBuffer()) as any);
  const sheet=book.worksheets[0]!;const actual:string[]=[];sheet.eachRow((row,n)=>{if(n>1)actual.push(String(row.getCell(2).value))});
  assert.deepEqual([...actual].sort(),expected.map(r=>r.order_name).sort(),`${label} contents`);assert.equal(new Set(actual).size,actual.length);
  report.checks.push({label,rows:actual.length,exact:true,durationMs:performance.now()-start});
}
try {
  const admin=await session('admin'),viewer=await session('viewer1'),blocked=await session('blocked');
  await exportCheck(admin,'all orders','',rows);
  await exportCheck(admin,'region and store',`?st=${fixture.storeIds[0]}&r=Lima`,rows.filter(r=>r.store_id===fixture.storeIds[0]&&r.region==='Lima'));
  await exportCheck(admin,'stage and substage','?view=por_confirmar&substage=sin_llamar',rows.filter(r=>r.macro_stage==='por_confirmar'&&r.macro_substage==='sin_llamar'));
  await exportCheck(admin,'empty search','?q=NEVERMATCH-STAGING-XYZ',[]);
  await exportCheck(viewer,'viewer requests both stores',`?st=${fixture.storeIds.join(',')}`,rows.filter(r=>r.store_id===fixture.storeIds[0]));
  const chosen=[...rows.filter(r=>r.store_id===fixture.storeIds[0]).slice(0,3),...rows.filter(r=>r.store_id===fixture.storeIds[1]).slice(0,3)];await exportCheck(admin,'selection','',chosen,chosen.map(r=>r.order_id));
  await exportCheck(viewer,'selection refuses other store','',chosen.filter(r=>r.store_id===fixture.storeIds[0]),chosen.map(r=>r.order_id));
  assert.equal((await fetch(`${origin}/api/export/pedidos`,{headers:{cookie:blocked}})).status,403);
  for(const [name,cookie,count] of [['admin',admin,100],['viewer',viewer,100],['blocked',blocked,0]] as const) {
    const started=performance.now(),res=await fetch(`${origin}/dashboard/pedidos`,{headers:{cookie}});const html=await res.text();assert.equal(res.status,200);assert.ok(!html.includes('digest":"'),'Server render error');
    const shown=[...html.matchAll(/aria-label="Seleccionar #PRUEBA\d+"/g)];assert.equal(shown.length,count,`${name} page size`);
    if(name==='blocked')assert.ok(html.includes('No tienes tiendas asignadas'));
    report.checks.push({label:`${name} server-rendered page`,rows:count,durationMs:performance.now()-started});
  }
  const uiEvent=checked(await ctx.admin.from('order_events').select('id,actor,note').eq('order_id',fixture.orders[355].id).eq('note','VALIDACION STAGING: comentario desde la interfaz durante sincronizaciones simultáneas.'),'UI audit');
  assert.equal(uiEvent.length,1);assert.equal(uiEvent[0]!.actor,fixture.users.find((u:any)=>u.name==='admin').id);
  report.checks.push({label:'UI comment persisted exactly once with actor',passed:true});report.passed=true;
}catch(error:any){report.errors.push({name:error.name,message:error.message});process.exitCode=1;console.error(error.message)}
finally{report.finishedAt=new Date().toISOString();writeFileSync('docs/performance/master-staging-http-2026-09-29.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
