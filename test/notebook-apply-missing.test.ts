import {beforeEach,describe,expect,it,vi} from "vitest";
const h=vi.hoisted(()=>({plan:[] as unknown[],carry:[] as unknown[],orgs:[{org_id:"org"}],rpc:vi.fn(),report:vi.fn()}));
vi.mock("@/lib/db",()=>({createAdminSupabase:()=>({
 from:(table:string)=>{
  const q:any={select:()=>q,eq:()=>q,in:()=>q,update:()=>q,
   maybeSingle:async()=>({data:table==="rider_notebook_imports"?{id:"imp",org_id:"org",rider_id:"rider",route_date:"2026-10-29",status:"leida",plan:h.plan}:table==="riders"?{full_name:"Alexis"}:{id:"route",status:"en_curso"},error:null}),
   then:(resolve:any)=>resolve({data:table==="rider_notebook_imports"?[{id:"imp"}]:table==="delivery_stops"?[{id:"new-stop",order_id:"order",route_id:"route",photo_path:null,voucher_path:null,status:"pendiente"}]:[],error:null})};
  return q;
 },rpc:h.rpc
})}));
vi.mock("@/lib/access",()=>({getAdminOrgs:async()=>h.orgs}));
vi.mock("@/lib/agent-names",()=>({resolveAgentName:async()=>"Frankz"}));
vi.mock("@/lib/order-master",()=>({recomputeOrderMasterSafe:vi.fn()}));
vi.mock("@/lib/stop-report",()=>({writeStopReport:h.report}));
vi.mock("@/lib/notebook-import-access",()=>({loadNotebookContext:async()=>({ctx:{carry:h.carry},stops:new Map()})}));
import {applyNotebookImport} from "@/lib/notebook-apply";
import {buildNotebookPlan} from "@/lib/notebook-import";

beforeEach(()=>{
 vi.clearAllMocks();
 h.orgs=[{org_id:"org"}];
 const carry={shipmentId:"shipment",orderId:"order",orderName:"#AUR900067",customerName:"Cliente",fromDate:"2026-10-28",total:89,remaining:89,unreported:true};
 h.carry=[carry];
 h.plan=buildNotebookPlan([{item:17,order:"#AUR900067",written:"EFECTIVO",amount:89,fee:10,store:"AURELA",customer:"Cliente",district:"Lima",notes:null}],{routeDate:"2026-10-29",riderName:"Alexis",stops:[],carry:[carry],elsewhere:new Map()}).rows;
 h.rpc.mockResolvedValue({data:"new-box",error:null});
 h.report.mockResolvedValue({ok:true,orderId:"order",routeId:"route"});
});
const decisions=()=>[{index:0,action:"pasar_y_reportar" as const,outcome:{status:"entregado" as const,method:"efectivo" as const,amount:89}}];

describe("aplicar inclusión desde la misma hoja",()=>{
 it("ata el traslado a la hoja y reporta solo la parada nueva",async()=>{
  const result=await applyNotebookImport("imp",decisions(),"actor");
  expect(result).toMatchObject({ok:true,result:{reported:1,carried:1,failed:0}});
  expect(h.rpc).toHaveBeenCalledWith("gf_notebook_carry_over",{p_rider_id:"rider",p_to_date:"2026-10-29",p_shipment_ids:["shipment"],p_actor:"actor",p_import_id:"imp"});
  expect(h.report).toHaveBeenCalledTimes(1);
  expect(h.report.mock.calls[0]![1]).toMatchObject({stopId:"new-stop",status:"entregado",notebook:{riderName:"Alexis",importId:"imp"}});
 });
 it("revalida la custodia y no mueve lo que ya no conserva",async()=>{
  h.carry=[];
  const result=await applyNotebookImport("imp",decisions(),"actor");
  expect(result).toMatchObject({ok:true,result:{reported:0,carried:0,failed:1}});
  expect(h.rpc).not.toHaveBeenCalled();
  expect(h.report).not.toHaveBeenCalled();
 });
 it("no convierte un cruce antiguo por nombre en permiso para mover un pendiente",async()=>{
  (h.plan[0] as any).match.via="nombre";
  const result=await applyNotebookImport("imp",decisions(),"actor");
  expect(result).toMatchObject({ok:true,result:{reported:0,failed:1}});
  expect(h.rpc).not.toHaveBeenCalled();
 });
 it("no aplica la hoja de otra organización",async()=>{
  h.orgs=[{org_id:"other"}];
  expect(await applyNotebookImport("imp",decisions(),"actor")).toMatchObject({ok:false,status:404});
  expect(h.rpc).not.toHaveBeenCalled();
  expect(h.report).not.toHaveBeenCalled();
 });
});

