import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./woocommerce-fake-db";
import { customerNameFromRaw, customerNameSnapshot, customerNameToEdit, validateCustomerName, CUSTOMER_NAME_UPDATED, CUSTOMER_NAME_REQUESTED } from "@/lib/order-customer-name";
const m=vi.hoisted(()=>({get:vi.fn(),put:vi.fn(),apply:vi.fn(),creds:vi.fn()}));
vi.mock("@/lib/woocommerce",()=>({fetchWooOrder:m.get,wooRequest:m.put}));
vi.mock("@/lib/woocommerce-intake",()=>({loadWooStoreCreds:m.creds,hasWooApiCredentials:(c:unknown)=>Boolean(c),wooClientOpts:(c:unknown)=>c,
  withWooAuthFallback:async(c:unknown,fn:(o:unknown)=>unknown)=>({value:await fn(c)})}));
vi.mock("@/lib/ingest",()=>({applyWooOrderResponse:m.apply}));
import { updateWooCustomerName } from "@/lib/order-customer-name-server";

const initial={id:461,status:"processing",billing:{first_name:"Cliente WhatsApp",last_name:"",phone:"51999999999",email:"client@example.test"},shipping:{first_name:"Cliente WhatsApp",last_name:"",address_1:"Calle prueba 1"},line_items:[{id:1,quantity:1}],total:"149.00"};
let remote=structuredClone(initial),db:FakeDb;
const input=()=>({firstName:"María del Carmen",lastName:"Pérez de la Cruz",expected:customerNameSnapshot(initial),requestId:"name-request-123456"});
const save=(value=input())=>updateWooCustomerName({admin:db.client(),orderId:"o1",userId:"diana",input:value});
beforeEach(()=>{
  vi.clearAllMocks();remote=structuredClone(initial);
  db=new FakeDb({orders:[{id:"o1",store_id:"store",platform:"woocommerce",shopify_order_id:"wc-kp-461"}],order_events:[]});
  m.creds.mockResolvedValue({creds:{id:"store",siteKey:"kp",siteUrl:"https://kenku.test",consumerKey:"fake",consumerSecret:"fake"}});
  m.get.mockImplementation(async()=>structuredClone(remote));
  m.put.mockImplementation(async(_o:unknown,r:{body:{billing:{first_name:string;last_name:string};shipping:{first_name:string;last_name:string}}})=>{
    remote={...remote,billing:{...remote.billing,...r.body.billing},shipping:{...remote.shipping,...r.body.shipping}};
    return {data:structuredClone(remote)};
  });
  m.apply.mockResolvedValue({applied:true});
});

describe("nombres y apellidos del cliente",()=>{
  it("mantiene nombres compuestos y permite solo nombres, con espacios normalizados",()=>{
    expect(validateCustomerName("  María  del Carmen "," Pérez de la Cruz ")).toEqual({ok:true,name:{firstName:"María del Carmen",lastName:"Pérez de la Cruz"}});
    expect(validateCustomerName("D'Ángelo-Jun","")).toMatchObject({ok:true,name:{lastName:""}});
    for(const [first,last] of [[" ","Apellido"],["<b>Nombre</b>",""],["N".repeat(101),""],["Nombre","\u0000"]])expect(validateCustomerName(first,last).ok).toBe(false);
  });
  it("precarga los campos estructurados sin adivinar apellidos",()=>{
    expect(customerNameToEdit(customerNameFromRaw({woo:initial},null))).toEqual({firstName:"Cliente WhatsApp",lastName:""});
    expect(customerNameToEdit(customerNameFromRaw(null,"María del Carmen Pérez"))).toEqual({firstName:"María del Carmen Pérez",lastName:""});
  });
  it("envía solo los nombres de este pedido y registra antes/después con actor",async()=>{
    const result=await save();expect(result.error).toBeUndefined();
    expect(m.put).toHaveBeenCalledWith(expect.anything(),{method:"PUT",path:"/orders/461",body:{billing:{first_name:"María del Carmen",last_name:"Pérez de la Cruz"},shipping:{first_name:"María del Carmen",last_name:"Pérez de la Cruz"}}});
    expect(remote).toMatchObject({total:"149.00",status:"processing",shipping:{address_1:"Calle prueba 1"},billing:{phone:"51999999999",email:"client@example.test"},line_items:initial.line_items});
    const events=db.tables.order_events!;
    expect(events.map(e=>e.kind)).toEqual([CUSTOMER_NAME_REQUESTED,CUSTOMER_NAME_UPDATED]);
    expect(events[1]).toMatchObject({actor:"diana",source:"kapta",payload:{before:customerNameSnapshot(initial),after:customerNameSnapshot(remote)}});
    expect(m.apply).toHaveBeenCalledWith(db.client(),expect.anything(),remote,undefined);
  });
  it("un reintento no duplica eventos ni vuelve a enviar el PUT",async()=>{
    await save();await save();
    expect(db.tables.order_events).toHaveLength(2);expect(m.put).toHaveBeenCalledTimes(1);expect(m.apply).toHaveBeenCalledTimes(2);
  });
  it("una ficha desactualizada no pisa un nombre editado por otra persona",async()=>{
    remote.shipping.first_name="Otro nombre";
    expect((await save()).error).toContain("El nombre cambió");expect(m.put).not.toHaveBeenCalled();expect(db.tables.order_events).toHaveLength(0);
  });
  it("no reutiliza una edición completada para sobrescribir un cambio posterior",async()=>{
    await save();remote=structuredClone(initial);
    expect((await save()).error).toContain("cambió después");expect(m.put).toHaveBeenCalledTimes(1);
  });
  it("rechaza cambiar los datos de un intento existente o apropiarse del de otra asesora",async()=>{
    await save();expect((await save({...input(),lastName:"Otro apellido"})).error).toContain("otra edición");
    const result=await updateWooCustomerName({admin:db.client(),orderId:"o1",userId:"otra",input:input()});
    expect(result.error).toContain("otra edición");expect(m.put).toHaveBeenCalledTimes(1);
  });
  it("si se pierde la respuesta confirma por GET y conserva la evidencia anterior",async()=>{
    m.put.mockImplementationOnce(async()=>{remote.billing.first_name=remote.shipping.first_name=input().firstName;remote.billing.last_name=remote.shipping.last_name=input().lastName;throw new Error("timeout");});
    expect((await save()).error).toBeUndefined();expect(m.get).toHaveBeenCalledTimes(2);expect(m.put).toHaveBeenCalledTimes(1);
  });
  it("si WooCommerce no confirma no marca aplicado ni toca el espejo",async()=>{
    m.put.mockRejectedValueOnce(new Error("network"));
    expect((await save()).error).toContain("no confirmó");expect(db.tables.order_events!.map(e=>e.kind)).toEqual([CUSTOMER_NAME_REQUESTED]);expect(m.apply).not.toHaveBeenCalled();
  });
  it("no escribe en otra plataforma ni en otro sitio WooCommerce",async()=>{
    db.tables.orders![0]!.platform="shopify";expect((await save()).error).toContain("WooCommerce");
    db.tables.orders![0]!.platform="woocommerce";db.tables.orders![0]!.shopify_order_id="wc-aur-461";
    expect((await save()).error).toContain("conexión");expect(m.put).not.toHaveBeenCalled();
  });
  it("sin historial disponible no modifica WooCommerce",async()=>{
    db.failOn=(table)=>table==="order_events"?{message:"unavailable"}:null;
    expect((await save()).error).toContain("historial");expect(m.put).not.toHaveBeenCalled();
  });
  it("si falla el hecho aplicado, reintenta el historial sin repetir el cambio",async()=>{
    db.failOn=(table,op,payload)=>table==="order_events"&&op==="insert"&&payload.kind===CUSTOMER_NAME_UPDATED?{message:"unavailable"}:null;
    expect((await save()).error).toContain("falta guardar");db.failOn=null;
    expect((await save()).error).toBeUndefined();expect(m.put).toHaveBeenCalledTimes(1);expect(db.tables.order_events).toHaveLength(2);
  });
  it("si falla el espejo conserva la edición y la completa al reintentar",async()=>{
    m.apply.mockResolvedValueOnce({applied:false});expect((await save()).error).toContain("falta actualizar");
    expect((await save()).error).toBeUndefined();expect(m.put).toHaveBeenCalledTimes(1);expect(db.tables.order_events).toHaveLength(2);
  });
});
