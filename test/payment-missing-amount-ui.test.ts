import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe,expect,it,vi } from "vitest";
vi.mock("@/app/dashboard/pedidos/payment-actions",()=>({}));
import { PaymentList } from "@/components/pickup-key-panel";
import type { PaymentRow } from "@/app/dashboard/pedidos/payment-actions";
const base={id:"pay",kind:"adelanto",amount:null,operation_number:"145266",validation_status:"validado",vision:null,paid_at:"2026-10-26T23:17:00Z",file_path:null,notes:null} as PaymentRow;
const html=(payment:PaymentRow,canValidate=true)=>renderToStaticMarkup(createElement(PaymentList,{payments:[payment],accounts:[],customerName:"Cliente",canValidate,canRegister:true,pending:false,onValidate:vi.fn(),onReject:vi.fn(),onObserve:vi.fn(),onComplete:vi.fn(),canOverride:false,onReassign:vi.fn()}));
describe("el monto faltante se explica en el comprobante",()=>{
  it("KP200188: un validado antiguo sin monto exige revisión y no parece aprobación completa",()=>{
    const output=html(base);expect(output).toContain("Validado sin monto");expect(output).toContain("Enviar a Observados");expect(output).toContain("no uses el total del pedido");
    expect(html(base,false)).not.toContain("Enviar a Observados");
  });
  it("con operación ya leída ofrece completar solo el monto",()=>{
    const output=html({...base,validation_status:"info_incompleta"});
    expect(output).toContain('aria-label="Monto"');expect(output).not.toContain('aria-label="Nº de operación"');
    expect(output).not.toContain('aria-label="Fecha y hora del pago"');
    expect(output).toMatch(/disabled=""[^>]*>Completar datos/);
  });
  it("un comprobante con importe positivo mantiene la validación disponible",()=>{
    const output=html({...base,validation_status:"pendiente_revision",amount:20});
    expect(output).not.toContain("Validado sin monto");expect(output).toContain("Validar comprobante");
  });
});
