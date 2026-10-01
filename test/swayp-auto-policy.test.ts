import { describe,expect,it } from "vitest";
import { evaluateAutoDispatch,nextAutoDelivery,productsOverlap,type AutoSnapshot,type AutoSettings } from "@/lib/swayp-auto-policy";
import type { OrderLineItem } from "@/lib/types";
const now=new Date("2026-10-01T20:00:00Z");
const config:AutoSettings={org_id:"org",enabled:true,daily_cap:10,max_order_days:14,history_days:180};
const item=(sku:string,title=sku):OrderLineItem=>({sku,title,quantity:1,price:99,product_id:null,variant_id:null});
function snapshot():AutoSnapshot {
  return {order:{id:"o",store_id:"s",name:"#KP1",created_at:"2026-09-25T10:00:00Z",customer_phone:"51999999999",
    cancelled_at:null,total_amount:99,total_refunded:0,currency:"PEN",financial_status:"pending",line_items:[item("NEW")],shopify_note:null,raw:null},
    source:{id:"g",order_id:"o",store_id:"s",courier:"aliclik",guide_code:"A1",delivery_status:"anulado",reported_status:"CANCEL · RETURNED · CONFIRMED",
      fenix_shipment_id:null,returned_at:"2026-09-29T10:00:00Z",closed_at:null,claimed_by:null,next_followup_at:null,non_delivery_reason:null,recovery_state:null,
      customer_name:"Cliente",customer_phone:"999999999",delivery_address:"Calle Misti 123",district:"Cayma",province:"Arequipa"},
    guides:[],notes:[],calls:[],voice:[],history:[{id:"prior",created_at:"2026-09-01T10:00:00Z",cancelled_at:null,line_items:[item("OLD")],
      delivered_at:"2026-09-05T10:00:00Z",address:"CALLE MISTI 123",district:"Cayma",province:"Arequipa",region:"Arequipa"}]};
}
describe("reintento sin contacto",()=>{
  it("permite CANCEL devuelto, sin inventar aceptación",()=>expect(evaluateAutoDispatch(snapshot(),config,now)).toMatchObject({eligible:true,priorOrderId:"prior",dispatchDate:"2026-10-02"}));
  it("permite NOT_RESPOND solo después de terminar el intento",()=>{
    const s=snapshot();s.source.reported_status="NOT_RESPOND · RETURNED";
    expect(evaluateAutoDispatch(s,config,now).eligible).toBe(true);
    s.source.delivery_status="pendiente";
    expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"source_active"});
  });
  it.each(["Se niega dice que no confirmo q no recibirá","no desea el producto","cliente rechazó el pedido","pide cancelar su pedido"])("excluye rechazo: %s",note=>{
    const s=snapshot();s.calls=[{note,new_status:null}];expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"rejection"});
  });
  it("no interpreta el CANCEL del courier como rechazo del cliente",()=>{
    const s=snapshot();s.calls=[{note:"Aliclik: CANCEL · RETURNED",new_status:"anulado"}];expect(evaluateAutoDispatch(s,config,now).eligible).toBe(true);
  });
  it("un CANCEL cerrado puede salir de stock Swayp sin esperar el retorno físico",()=>{
    const s=snapshot();s.source.returned_at=null;s.source.reported_status="CANCEL · TO_RETURN · CONFIRMED";s.source.closed_at="2026-09-30T12:00:00Z";
    expect(evaluateAutoDispatch(s,config,now).eligible).toBe(true);
    s.source.closed_at=null;expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"source_active"});
  });
  it("no incluye excepciones manuales de julio",()=>{const s=snapshot();s.order.created_at="2026-07-17T12:10:33Z";expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"old_order"});});
  it("no cobra nuevamente un pedido pagado",()=>{const s=snapshot();s.order.financial_status="paid";expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"invalid_order"});});
  it("exige la misma dirección, no solo la misma ciudad",()=>{const s=snapshot();s.source.delivery_address="Calle Misti 124";expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"no_history"});});
  it("no convierte Talara en Piura por una ciudad genérica",()=>{const s=snapshot();s.source.city="piura";s.source.district="Pariñas";s.source.province="Talara";expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"address"});});
  it("excluye Lima",()=>{const s=snapshot();s.source.district="Lima";s.source.province="Lima";expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"address"});});
  it("una variante diferente no es un producto distinto",()=>{expect(productsOverlap([item("SIZE1","Pantalón")],[item("SIZE2","Pantalón")])).toBe(true);});
  it("excluye productos ya entregados en cualquier entrega reciente",()=>{const s=snapshot();s.history.push({...s.history[0]!,id:"prior2",line_items:[item("NEW")]});expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"same_product"});});
  it("excluye una compra posterior que podría reemplazar este pedido",()=>{const s=snapshot();s.history.push({...s.history[0]!,id:"next",created_at:"2026-09-29T00:00:00Z",delivered_at:null,line_items:[item("NEW")]});expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"duplicate"});});
  it("no usa una entrega posterior como antecedente",()=>{const s=snapshot();s.history[0]!.delivered_at="2026-09-30T00:00:00Z";expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"no_history"});});
  it("respeta una programación futura",()=>{const s=snapshot();s.source.next_followup_at="2026-10-03T00:00:00Z";expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"human_management"});});
  it("excluye otro intento Swayp aunque haya terminado",()=>{const s=snapshot();s.guides=[{id:"other",courier:"fenix",delivery_status:"anulado",reported_status:null,fenix_shipment_id:null}];expect(evaluateAutoDispatch(s,config,now)).toMatchObject({reason:"live_guide"});});
  it("respeta domingo y la limitación de sábado en Arequipa",()=>{
    expect(nextAutoDelivery(new Date("2026-10-02T17:00:00Z"),"arequipa")).toBe("2026-10-05");
    expect(nextAutoDelivery(new Date("2026-10-03T17:00:00Z"),"trujillo")).toBe("2026-10-05");
  });
});

describe("piloto sin historial",()=>{
  const pilot={...config,pilot_enabled:true,pilot_daily_cap:3};
  function fresh(){const s=snapshot();s.history=[];s.payments=[];Object.assign(s.source,{aliclik_attempts:1,latitude:-16.39,longitude:-71.54,delivery_reference:"Frente al colegio"});return s;}
  it("admite un pedido reciente de un intento sin inventar una entrega anterior",()=>{
    expect(evaluateAutoDispatch(fresh(),pilot,now)).toMatchObject({eligible:true,cohort:"recent_no_history",priorOrderId:null});
  });
  it("queda apagado por defecto",()=>expect(evaluateAutoDispatch(fresh(),config,now)).toMatchObject({reason:"no_history"}));
  it.each([null,0,2,3])("no asume un único intento para %s",attempts=>{
    const s=fresh();s.source.aliclik_attempts=attempts;expect(evaluateAutoDispatch(s,pilot,now)).toMatchObject({reason:"pilot_limits"});
  });
  it("rechaza más de 7 días o más de S/199",()=>{
    const s=fresh();s.order.total_amount=199;expect(evaluateAutoDispatch(s,pilot,now).eligible).toBe(true);
    s.order.total_amount=199.01;expect(evaluateAutoDispatch(s,pilot,now)).toMatchObject({reason:"pilot_limits"});
    s.order.total_amount=99;s.order.created_at="2026-09-24T19:59:59Z";expect(evaluateAutoDispatch(s,pilot,now)).toMatchObject({reason:"pilot_limits"});
  });
  it("exige pin y referencia",()=>{
    const s=fresh();s.source.latitude=null;expect(evaluateAutoDispatch(s,pilot,now)).toMatchObject({reason:"pilot_location"});
    s.source.latitude=-16.39;s.source.delivery_reference=null;expect(evaluateAutoDispatch(s,pilot,now)).toMatchObject({reason:"pilot_location"});
  });
  it("no cobra el total si hay adelanto o pago por revisar",()=>{
    const s=fresh();s.payments=[{validation_status:"validado"}];expect(evaluateAutoDispatch(s,pilot,now)).toMatchObject({reason:"payment_review"});
    s.payments=undefined;expect(evaluateAutoDispatch(s,pilot,now)).toMatchObject({reason:"payment_review"});
  });
  it("sigue detectando reemplazos aunque no tenga historial de entrega",()=>{
    const s=fresh();s.history=[{...snapshot().history[0]!,delivered_at:null,line_items:[item("NEW")]}];
    expect(evaluateAutoDispatch(s,pilot,now)).toMatchObject({reason:"duplicate"});
  });
  it("conserva la vía original y su plazo",()=>expect(evaluateAutoDispatch(snapshot(),pilot,now)).toMatchObject({eligible:true,cohort:"prior_delivery"}));
});
