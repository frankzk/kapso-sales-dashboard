import { beforeEach,describe,expect,it,vi } from "vitest";
import { FakeDb } from "./woocommerce-fake-db";
const m=vi.hoisted(()=>({db:null as any,apply:vi.fn()}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("next/navigation",()=>({redirect:vi.fn()}));
vi.mock("@/lib/db",()=>({createAdminSupabase:()=>m.db.client(),createServerSupabase:async()=>Object.assign(m.db.client(),{auth:{getUser:async()=>({data:{user:{id:"validator"}}})}})}));
vi.mock("@/lib/permissions-access",()=>({hasOrgPermission:async()=>true,getMasterPermissions:async()=>({can:()=>true})}));
vi.mock("@/lib/payment-validation",()=>({applyPaymentValidation:m.apply,adjustCourierLiquidation:vi.fn()}));
import { validatePayment } from "@/app/dashboard/pedidos/payment-actions";
beforeEach(()=>{
  vi.clearAllMocks();m.db=new FakeDb({order_payments:[{id:"pay",order_id:"order",store_id:"store",kind:"adelanto",amount:null,operation_number:"145266",operation_completed_by:null,validation_status:"info_incompleta"}],order_master:[{order_id:"order",store_id:"store"}],stores:[{id:"store",org_id:"org"}]});
});
describe("KP200188 y la validación manual",()=>{
  it.each([null,0,-1,NaN,Infinity])("monto %s se rechaza incluso con excepción administrativa de receptor",async amount=>{
    m.db.tables.order_payments[0].amount=amount;
    const result=await validatePayment("pay",{recipientExceptionReason:"El dinero llegó a nuestra cuenta"});
    expect(result.error).toContain("monto válido");expect(m.apply).not.toHaveBeenCalled();
    expect(m.db.opsOn("order_payments","update")).toHaveLength(0);
    const load=m.db.opsOn("order_payments","select")[0];
    expect(load.cols.split(",")).toContain("amount");
  });
});
