import { beforeEach,describe,expect,it,vi } from "vitest";
import { FakeDb } from "./woocommerce-fake-db";
import { hasPositivePaymentAmount } from "@/lib/payment-amount";
const m=vi.hoisted(()=>({confirm:vi.fn(),close:vi.fn(),recompute:vi.fn(),guide:vi.fn()}));
vi.mock("@/lib/collection-alerts-access",()=>({closeAlertsResolvedBy:m.close}));
vi.mock("@/lib/confirmacion-agencia-access",()=>({registrarConfirmacionExpresaDeAgencia:m.confirm}));
vi.mock("@/lib/order-master",()=>({recomputeOrderMasterSafe:m.recompute}));
vi.mock("@/lib/tanders/collection-payment",()=>({COURIER_COLLECTION_KIND:"cobro_courier",applyHumanRulingToGuide:m.guide}));
import { applyPaymentValidation } from "@/lib/payment-validation";
let db:FakeDb;
const payment={id:"pay",order_id:"order",kind:"adelanto",validation_status:"info_incompleta",amount:20};
const validate=(amount:unknown,source="manual")=>applyPaymentValidation(db.client(),{payment:{...payment,amount:amount as number|null},who:{storeId:"store",actor:"reviewer",source},note:"Validado",liquidationNote:"Validado"});
beforeEach(()=>{vi.clearAllMocks();m.confirm.mockResolvedValue(false);db=new FakeDb({order_payments:[{...payment,store_id:"store"}],order_events:[]});});
describe("no existe validación financiera sin importe positivo",()=>{
  it.each([null,undefined,"",0,-1,NaN,Infinity,-Infinity,"NaN","Infinity",false,true])("bloquea %s antes de cualquier escritura o efecto",async amount=>{
    expect(hasPositivePaymentAmount(amount)).toBe(false);
    const result=await validate(amount);expect(result.ok).toBe(false);
    expect(db.ops).toHaveLength(0);expect(m.confirm).not.toHaveBeenCalled();expect(m.guide).not.toHaveBeenCalled();expect(m.close).not.toHaveBeenCalled();
  });
  it.each([20,"20.00",0.01])("admite importe positivo %s",async amount=>{
    db.tables.order_payments![0]!.amount=Number(amount);
    expect(hasPositivePaymentAmount(amount)).toBe(true);expect((await validate(amount)).ok).toBe(true);
    expect(db.tables.order_payments![0]!.validation_status).toBe("validado");expect(m.confirm).toHaveBeenCalledTimes(1);
  });
  it("no valida si otra persona retira o cambia el monto después de leerlo",async()=>{
    for(const amount of [null,0,30]) {
      db.tables.order_payments![0]!.amount=amount;
      expect(await validate(20)).toMatchObject({ok:false,stale:true});
    }
    expect(db.tables.order_events).toHaveLength(0);expect(m.close).not.toHaveBeenCalled();
  });
  it.each(["manual","flow","estado_yape"])("la guarda común también cubre %s",async source=>{
    expect((await validate(null,source)).ok).toBe(false);expect(db.ops).toHaveLength(0);
  });
});
