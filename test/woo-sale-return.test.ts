import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { wooReturnStockBlock, wooSaleEndBlocks, wooSaleWasDispatched, WOO_SALE_ENDED } from "@/lib/woo-sale-return";
import { legacySaleCancelledAt } from "@/lib/legacy-sale-cancel";
import { WooCancelZone } from "@/components/woo-cancel-zone";
import { resolveMacroStage, type ResolveMacroStageInput } from "@/lib/order-macro-stage";
const at="2026-10-28T12:00:00Z";
const s={id:"s1",courier:"propio",delivery_status:"pendiente",custody_state:"courier",dispatched_at:at};
const facts={platform:"woocommerce",generalStatus:"en_proceso",financialStatus:"pending",shipments:[s],payments:[]};
const receipt={kind:"return_received",occurred_at:at,source:"dispatch",actor:"almacen",shipment_id:"s1"};
const inventory={...receipt,kind:"inventory_reconciled",source:"manual"};
describe("venta WooCommerce terminada con stock pendiente",()=>{
  it("KP200152: recibir para reprogramar conserva el acceso a Terminar venta",()=>{
    const returned={...s,custody_state:"empresa",dispatched_at:null,custody_transferred_at:null};
    const events=[{...receipt,kind:"returned_to_office"}];
    expect(wooSaleWasDispatched({shipments:[returned],events})).toBe(true);
    expect(wooSaleEndBlocks({...facts,shipments:[returned],events})).toEqual([]);
    for(const event of [{...events[0]!,shipment_id:"otra-salida"},{...events[0]!,actor:null},{...events[0]!,source:"courier_api"}])
      expect(wooSaleWasDispatched({shipments:[returned],events:[event]})).toBe(false);
  });
  it("termina la venta fuera de almacén sin aceptar entregas ni dinero pendiente",()=>{
    expect(wooSaleEndBlocks(facts)).toEqual([]);
    for(const change of [{platform:"shopify"},{financialStatus:"paid"},{generalStatus:"entregado"},{payments:[{validation_status:"pendiente"}]},{companion:{travelsIn:"otra",carries:[]}}])
      expect(wooSaleEndBlocks({...facts,...change})).not.toEqual([]);
    expect(wooSaleEndBlocks({...facts,shipments:[{...s,dispatched_at:undefined,custody_state:"empresa"}]})).not.toEqual([]);
  });
  it("un webhook, un reporte o un override logístico no reactiva una venta Woo terminada",()=>{
    const ended={kind:WOO_SALE_ENDED,occurred_at:at};
    expect(legacySaleCancelledAt([ended,{kind:"status_override",occurred_at:"2026-10-29",source:"manual",new_status:"entregado"}])).toBe(at);
  });
  it("no devuelve stock por un estado de courier, recepción sin actor o inventario sin recepción",()=>{
    const returned=[{...s,custody_state:"devuelto"}];
    expect(wooReturnStockBlock(["s1"],returned,[])).toContain("Retorno pendiente");
    expect(wooReturnStockBlock(["s1"],returned,[{...receipt,actor:null},inventory])).toContain("Retorno pendiente");
    expect(wooReturnStockBlock(["s1"],returned,[receipt])).toContain("reingreso apto");
    expect(wooReturnStockBlock(["s1"],returned,[receipt,{...inventory,kind:"merma_closed"}])).toContain("merma");
    expect(wooReturnStockBlock(["s1"],returned,[receipt,inventory])).toBeNull();
  });
  it("espera todas las cajas; no confunde la primera devolución con todo el pedido",()=>{
    const shipments=[s,{...s,id:"s2"}];
    expect(wooReturnStockBlock(["s1","s2"],shipments,[receipt,inventory])).toContain("Retorno pendiente");
    expect(wooReturnStockBlock(["s1"],shipments,[receipt,inventory])).toContain("otra salida");
    expect(wooReturnStockBlock(["s1"],[],[receipt,inventory])).toContain("Falta una salida");
  });
  it("muestra la opción con una caja afuera y explica que el stock espera recepción e inventario",()=>{
    const html=renderToStaticMarkup(createElement(WooCancelZone,{mode:"woocommerce_return",orderName:"#AUR1",facts,pending:false,onCancel:async()=>true}));
    expect(html).toContain("Terminar venta…"); expect(html).toContain("reingreso apto"); expect(html).not.toContain("Todavía no se puede anular");
  });
  it("no finaliza con stock Woo pendiente aunque los otros pendientes estén resueltos",()=>{
    const input={order:{created_at:at,cancelled_at:null,coverage:"agencia"},guides:[],events:[{kind:WOO_SALE_ENDED,occurred_at:at}],legacy:{general:"anulado",operational:"anulado",since:at},paymentState:null} as unknown as ResolveMacroStageInput;
    expect(resolveMacroStage(input)).toMatchObject({stage:"por_cerrar",reasons:["stock_woo_pendiente"]});
    expect(resolveMacroStage({...input,events:[...input.events,{kind:"woo_sale_return_synced",occurred_at:at}]}).stage).toBe("finalizado");
  });
});
