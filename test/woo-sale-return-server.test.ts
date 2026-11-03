import { beforeEach,describe,expect,it,vi } from "vitest";
import { FakeDb } from "./woocommerce-fake-db";
const m=vi.hoisted(()=>({get:vi.fn(),cancel:vi.fn(),apply:vi.fn(),recompute:vi.fn()}));
vi.mock("@/lib/woocommerce-intake",()=>({loadWooStoreCreds:async()=>({creds:{siteUrl:"https://kenku.test",siteKey:"kp",consumerKey:"test",consumerSecret:"test"},error:null}),hasWooApiCredentials:()=>true,wooClientOpts:(c:unknown)=>c,withWooAuthFallback:async(_c:unknown,fn:(v:unknown)=>unknown)=>({value:await fn({})})}));
vi.mock("@/lib/woocommerce",()=>({fetchWooOrder:m.get,mapWooOrder:(o:{status:string;payment_method?:string})=>({line_items:[{product_id:"1",sku:"SKU1",quantity:1}],financial_status:o.payment_method==="card"?"paid":"pending"})}));
vi.mock("@/lib/woo-cancel-server",()=>({cancelWooOrderInStore:m.cancel}));
vi.mock("@/lib/ingest",()=>({applyWooOrderResponse:m.apply}));
vi.mock("@/lib/order-master",()=>({recomputeOrderMasterSafe:m.recompute}));
import { processWooSaleReturn } from "@/lib/woo-sale-return-server";
let db:FakeDb; let remote:{id:number;status:string;payment_method:string};
const at="2026-10-28T12:00:00Z";
beforeEach(()=>{
  vi.clearAllMocks(); remote={id:1,status:"processing",payment_method:"cod"};
  db=new FakeDb({orders:[{id:"o1",store_id:"store",platform:"woocommerce",shopify_order_id:"wc-kp-1",financial_status:"pending"}],
    shipments:[{id:"s1",order_id:"o1",courier:"propio",delivery_status:"anulado",custody_state:"devuelto",dispatched_at:at}],
    order_events:[{order_id:"o1",kind:"woo_sale_ended_pending_return",occurred_at:at},{order_id:"o1",shipment_id:"s1",kind:"return_received",occurred_at:at,actor:"almacen",source:"dispatch"},{order_id:"o1",shipment_id:"s1",kind:"inventory_reconciled",occurred_at:at,actor:"almacen",source:"manual"}],
    order_payments:[],delivery_stops:[],woo_sale_returns:[{order_id:"o1",store_id:"store",actor:"diana",shipment_ids:["s1"],stock_items:[{product_id:"1",sku:"SKU1",quantity:1}],lease_token:"lease",state:"pending",last_error:null}]});
  Object.assign(db,{rpc:vi.fn(async()=>({data:db.rows("woo_sale_returns")[0]!.state==="synced"?[]:[{...db.rows("woo_sale_returns")[0]!}],error:null}))});
  m.get.mockImplementation(async()=>({...remote}));
  m.cancel.mockImplementation(async()=>{remote.status="cancelled";return {kind:"cancelled",order:{...remote}};});
  m.apply.mockResolvedValue({applied:true});
});
describe("reposición Woo después del retorno",()=>{
  it("cancela en la tienda solo tras recepción e inventario; no suma stock manualmente",async()=>{
    expect((await processWooSaleReturn(db.client())).state).toBe("synced");
    expect(m.cancel).toHaveBeenCalledTimes(1);expect(db.rows("woo_sale_returns")[0]!.state).toBe("synced");
    expect(db.rows("order_events").some(e=>e.kind==="woo_sale_return_synced")).toBe(true);
    expect((await processWooSaleReturn(db.client())).state).toBe("skipped");expect(m.cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["receipt","inventory","second_box","payment","delivery","read_error"])("frena antes de llamar a Woo si falta %s",async(kind)=>{
    if(kind==="receipt")db.tables.order_events=db.rows("order_events").filter(e=>e.kind!=="return_received");
    if(kind==="inventory")db.tables.order_events=db.rows("order_events").filter(e=>e.kind!=="inventory_reconciled");
    if(kind==="second_box")db.rows("woo_sale_returns")[0]!.shipment_ids.push("s2");
    if(kind==="payment")db.rows("order_payments").push({order_id:"o1",validation_status:"validado"});
    if(kind==="delivery")db.rows("delivery_stops").push({order_id:"o1",status:"entregado"});
    if(kind==="read_error")db.failOn=(table,op)=>table==="shipments"&&op==="select"?{message:"failure"}:null;
    expect((await processWooSaleReturn(db.client())).state).toBe("pending"); expect(m.cancel).not.toHaveBeenCalled();expect(m.get).not.toHaveBeenCalled();
  });
  it("un pago o entrega nuevos en Woo exigen revisión, aunque el Master esté pendiente",async()=>{
    remote.payment_method="card";expect((await processWooSaleReturn(db.client())).state).toBe("pending");expect(m.cancel).not.toHaveBeenCalled();
  });
  it("no repone stock si cambiaron las cantidades de la venta original",async()=>{
    db.rows("woo_sale_returns")[0]!.stock_items[0].quantity=3;
    expect((await processWooSaleReturn(db.client())).state).toBe("pending");expect(m.cancel).not.toHaveBeenCalled();
  });
  it("recupera una cancelación aplicada seguida de fallo local sin volver a pedir reposición",async()=>{
    m.apply.mockRejectedValueOnce(new Error("secret URL"));
    expect((await processWooSaleReturn(db.client())).state).toBe("pending");
    expect(JSON.stringify(db.rows("order_events"))).not.toContain("secret URL");
    expect((await processWooSaleReturn(db.client())).state).toBe("synced");expect(m.cancel).toHaveBeenCalledTimes(1);
  });
  it("reintenta un fallo antes de confirmar la cancelación y no anuncia stock confirmado",async()=>{
    m.cancel.mockResolvedValueOnce({kind:"error",unknown:true});
    expect((await processWooSaleReturn(db.client())).state).toBe("pending");expect(db.rows("order_events").some(e=>e.kind==="woo_sale_return_synced")).toBe(false);
    expect((await processWooSaleReturn(db.client())).state).toBe("synced");
  });
});
