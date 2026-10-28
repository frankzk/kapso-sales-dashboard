import { describe,expect,it } from "vitest";
import { phoneSaleCustomer } from "@/lib/master-phone-sale";
describe("cliente precargado desde un pedido del Master",()=>{
  it("precarga el celular normalizado, el nombre y la tienda exacta del pedido",()=>{
    expect(phoneSaleCustomer({store_id:"aurela",customer_phone:"+51 986 548 455",customer_name:"Elena"}))
      .toEqual({storeId:"aurela",phone:"51986548455",name:"Elena"});
    expect(phoneSaleCustomer({store_id:"kenku",customer_phone:"986548455",customer_name:null}))
      .toEqual({storeId:"kenku",phone:"51986548455",name:null});
  });
  it("no confunde datos comerciales del pedido anterior con el pedido nuevo",()=>{
    const old={store_id:"aurela",customer_phone:"51986548455",customer_name:"Elena",order_id:"old-order",order_total:89,line_items:[{sku:"anterior"}],financial_status:"paid"};
    expect(Object.keys(phoneSaleCustomer(old)!).sort()).toEqual(["name","phone","storeId"]);
    expect(phoneSaleCustomer({...old,store_id:"kenku",customer_phone:"51999988877"})).toMatchObject({storeId:"kenku",phone:"51999988877"});
  });
  it("no inventa un celular cuando falta o está incompleto",()=>{
    for(const phone of [null,undefined,"","123","sin número"])
      expect(phoneSaleCustomer({store_id:"aurela",customer_phone:phone})).toBeNull();
  });
});
