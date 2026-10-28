"use client";

import { IconPhone } from "@/components/icons";
import { OpsButton } from "@/components/ops-ui";
import type { PhoneSaleCustomer } from "@/lib/master-phone-sale";

export function CustomerOrderButton({customer,onCreate}:{customer:PhoneSaleCustomer|null;onCreate:(customer:PhoneSaleCustomer)=>void}) {
  return <OpsButton size="sm" className="pointer-coarse:h-11" aria-label="Crearle pedido a este cliente"
    disabled={!customer} title={!customer ? "El cliente no tiene un celular válido. Usa Venta por teléfono en la cabecera." : undefined}
    onClick={()=>{if(customer)onCreate(customer);}}>
    <IconPhone aria-hidden/>
    <span className="hidden sm:inline">Crearle pedido a este cliente</span><span className="sm:hidden">Crear pedido</span>
  </OpsButton>;
}
