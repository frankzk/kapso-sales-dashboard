"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { VentaTelefonica } from "@/components/venta-telefonica";
import { Banner, SidePanel, Skeleton } from "@/components/ops-ui";
import { openLeadDrawer, releaseLead, renewLeadClaim } from "@/app/dashboard/leads/actions";
import { CLAIM_HEARTBEAT_MS, shouldRenewClaim } from "@/lib/leads";
import type { LeadRow } from "@/lib/types";
import type { PhoneSaleRequest } from "@/lib/master-phone-sale";

// El formulario real de Leads, con su catálogo, avisos y acción de creación.
// Se descarga solo al abrir una venta, no con cada página del Master.
const OrderFormPanel=dynamic(()=>import("@/components/leads-drawer").then(m=>m.OrderFormPanel),{
  ssr:false,loading:()=> <div role="status" className="space-y-3"><span className="sr-only">Cargando formulario de pedido…</span><Skeleton className="h-12"/><Skeleton className="h-24"/></div>,
});

export function MasterPhoneSale({stores,defaultStoreId,request,onActiveChange}:{
  stores: {id:string;name:string;currency:string}[];
  defaultStoreId?: string | null;
  request: PhoneSaleRequest | null;
  onActiveChange: (active:boolean)=>void;
}) {
  const router=useRouter();
  const root=useRef<HTMLDivElement>(null);
  const [entryOpen,setEntryOpen]=useState(false);
  const [lead,setLead]=useState<LeadRow|null>(null);
  const [error,setError]=useState<string|null>(null);
  const held=useRef<string|null>(null);
  const version=useRef(0);
  const active=entryOpen || Boolean(lead);

  useEffect(()=>{onActiveChange(active);},[active,onActiveChange]);
  useEffect(()=>()=>{
    ++version.current;
    if(held.current) void releaseLead(held.current);
    onActiveChange(false);
  },[onActiveChange]);

  const close=useCallback(()=>{
    ++version.current;
    const id=held.current; held.current=null;
    setLead(null);setError(null);
    if(id) void releaseLead(id);
  },[]);

  const open=async(leadId:string):Promise<boolean>=>{
    const token=++version.current;
    setError(null);
    try {
      const detail=await openLeadDrawer(leadId);
      if(token!==version.current){if(!("error" in detail)) void releaseLead(leadId);return false;}
      if("error" in detail){setError(detail.error);void releaseLead(leadId);return false;}
      if(!stores.some(s=>s.id===detail.lead.store_id)){setError("La tienda del cliente ya no está disponible. Actualiza la página.");void releaseLead(leadId);return false;}
      held.current=leadId;setLead(detail.lead);
      return true;
    } catch {if(token===version.current)setError("No se pudo abrir la ficha del cliente. Intenta nuevamente.");return false;}
  };

  // La misma reserva de Leads; una ficha abandonada no retiene al cliente.
  useEffect(()=>{
    if(!lead)return;
    let lastActivity=Date.now();
    const mark=()=>{lastActivity=Date.now();};
    const timer=setInterval(()=>{
      if(held.current===lead.id && shouldRenewClaim(lastActivity,Date.now()))void renewLeadClaim(lead.id).then(r=>{if(r.error && held.current===lead.id)setError(r.error);}).catch(()=>undefined);
    },CLAIM_HEARTBEAT_MS);
    window.addEventListener("pointerdown",mark,{passive:true});window.addEventListener("keydown",mark,{passive:true});
    return()=>{clearInterval(timer);window.removeEventListener("pointerdown",mark);window.removeEventListener("keydown",mark);};
  },[lead]);

  useEffect(()=>{
    if(!active)return;
    const previous=document.body.style.overflow;document.body.style.overflow="hidden";
    const key=(e:KeyboardEvent)=>{
      if(e.defaultPrevented)return;
      if(e.key==="Escape" && lead){e.preventDefault();close();return;}
      if(e.key!=="Tab")return;
      const panels=root.current?.querySelectorAll<HTMLElement>('[role="dialog"]');
      const panel=panels?.[panels.length-1];
      const controls=panel?Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(el=>el.getClientRects().length):[];
      const first=controls[0],last=controls.at(-1);
      if(!first){e.preventDefault();panel?.focus();return;}
      if(e.shiftKey && (document.activeElement===first || document.activeElement===panel)){e.preventDefault();last?.focus();}
      else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}
    };
    document.addEventListener("keydown",key);
    return()=>{document.body.style.overflow=previous;document.removeEventListener("keydown",key);};
  },[active,lead,close]);

  const entryChanged=useCallback((value:boolean)=>{setEntryOpen(value);if(value)setError(null);},[]);
  const store=lead?stores.find(s=>s.id===lead.store_id):null;
  return <div ref={root}>
    <VentaTelefonica stores={stores} defaultStoreId={defaultStoreId} request={request} onOpenChange={entryChanged} openingError={error} onAbrir={open}/>
    {lead && store && <SidePanel label="Crear pedido para el cliente" title="Nuevo pedido" meta={`${lead.name || lead.phone} · ${store.name}`} width="max-w-[720px]" onClose={close}>
      {error && <Banner tone="warn" role="alert">{error}</Banner>}
      <OrderFormPanel key={lead.id} leadId={lead.id} currency={store.currency} hasCart={Boolean(lead.draft_order_gid) && lead.draft_order_status!=="completed"} noReutilizarBorrador={lead.has_order || Boolean(request)} onClose={close} onRegistered={()=>router.refresh()}/>
    </SidePanel>}
  </div>;
}
