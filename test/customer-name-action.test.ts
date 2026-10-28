import { beforeEach,describe,expect,it,vi } from "vitest";
const m=vi.hoisted(()=>({user:true,visible:true,allowed:true,org:"org",permission:"",save:vi.fn()}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("@/lib/db",()=>({createAdminSupabase:()=>({admin:true}),createServerSupabase:async()=>({
  auth:{getUser:async()=>({data:{user:m.user?{id:"diana"}:null}})},
  from:(table:string)=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:table==="order_master"?(m.visible?{store_id:"store"}:null):{org_id:m.org},error:null})})})}),
})}));
vi.mock("@/lib/permissions-access",()=>({hasOrgPermission:async(org:string,permission:string)=>{m.permission=`${org}:${permission}`;return m.allowed;}}));
vi.mock("@/lib/order-customer-name-server",()=>({updateWooCustomerName:m.save}));
import { updateOrderCustomerName } from "@/app/dashboard/pedidos/customer-name-actions";
const input={firstName:"María",lastName:"Pérez",expected:{billing:{firstName:"Cliente",lastName:""},shipping:{firstName:"Cliente",lastName:""}},requestId:"request-123456"};
beforeEach(()=>{vi.clearAllMocks();m.user=true;m.visible=true;m.allowed=true;m.org="org";m.save.mockResolvedValue({notice:"Guardado"});});
describe("edición autorizada del nombre",()=>{
  it("verifica orders.create en la organización objetivo y conserva identidades del servidor",async()=>{
    await updateOrderCustomerName("o1",{...input,orderId:"otra",userId:"owner",admin:"falso"} as typeof input);
    expect(m.permission).toBe("org:orders.create");
    expect(m.save).toHaveBeenCalledWith({orderId:"o1",userId:"diana",admin:{admin:true},input});
  });
  it.each(["session","rls","permission"])("sin %s no llega al servidor de edición",async(kind)=>{
    if(kind==="session")m.user=false;if(kind==="rls")m.visible=false;if(kind==="permission")m.allowed=false;
    expect((await updateOrderCustomerName("o1",input)).error).toBeTruthy();expect(m.save).not.toHaveBeenCalled();
  });
});
