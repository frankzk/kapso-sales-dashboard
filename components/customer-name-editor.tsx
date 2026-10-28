"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Banner, FIELD, OpsButton, SectionHead } from "@/components/ops-ui";
import { customerNameToEdit, validateCustomerName, type CustomerNameSnapshot, type UpdateCustomerNameInput } from "@/lib/order-customer-name";

export function CustomerNameEditor({value,canEdit,help,actions,hasGuides,onSave,onUpdated}:{
  value:CustomerNameSnapshot;canEdit:boolean;help:string;actions?:ReactNode;hasGuides:boolean;
  onSave:(input:UpdateCustomerNameInput)=>Promise<{error?:string;notice?:string}>;
  onUpdated:()=>Promise<void>;
}) {
  const id=useId();
  const [open,setOpen]=useState(false);
  const [first,setFirst]=useState("");const [last,setLast]=useState("");
  const [expected,setExpected]=useState(value);const [requestId,setRequestId]=useState("");
  const [pending,setPending]=useState(false);const working=useRef(false);
  const [error,setError]=useState<string|null>(null);const [notice,setNotice]=useState<string|null>(null);
  const inputRef=useRef<HTMLInputElement>(null);const buttonRef=useRef<HTMLButtonElement>(null);
  const wasOpen=useRef(false);
  useEffect(()=>{if(open)inputRef.current?.focus();else if(wasOpen.current)buttonRef.current?.focus();wasOpen.current=open;},[open]);
  const close=()=>{if(working.current)return;setOpen(false);setError(null);buttonRef.current?.focus();};
  const begin=()=>{
    const name=customerNameToEdit(value);setFirst(name.firstName);setLast(name.lastName);
    setExpected(value);setRequestId(crypto.randomUUID());setError(null);setNotice(null);setOpen(true);
  };
  return <>
    <SectionHead title="Pedido y cliente" help={help} aside={<div className="flex flex-wrap items-center gap-2">
      {canEdit && <OpsButton ref={buttonRef} size="sm" className="pointer-coarse:h-11" aria-expanded={open} aria-controls={`${id}-form`} disabled={pending} onClick={()=>open?close():begin()}>Editar nombre</OpsButton>}
      {actions}
    </div>}/>
    {notice && <div className="mb-4" role="status"><Banner tone="ok">{notice}</Banner></div>}
    {open && canEdit && <form id={`${id}-form`} aria-busy={pending} className="mb-4 space-y-3 border-b border-line pb-4"
      onKeyDown={e=>{if(e.key==="Escape"){e.stopPropagation();e.preventDefault();close();}}}
      onSubmit={async e=>{
        e.preventDefault();if(working.current)return;
        const checked=validateCustomerName(first,last);if(!checked.ok){setError(checked.error);return;}
        working.current=true;setPending(true);setError(null);
        try {
          const result=await onSave({...checked.name,expected,requestId});
          if(result.error){setError(result.error);return;}
          await onUpdated();setNotice(result.notice ?? "Nombre actualizado.");setOpen(false);
        } catch {setError("No se pudo completar la edición. Se conserva lo escrito; vuelve a intentar.");}
        finally {working.current=false;setPending(false);}
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label htmlFor={`${id}-first`} className="block space-y-1 text-sm font-medium text-ink-900">Nombres
          <input ref={inputRef} id={`${id}-first`} className={`${FIELD} mt-1 h-10 w-full px-3 pointer-coarse:h-11`} autoComplete="given-name" maxLength={100} required disabled={pending} value={first}
            onChange={e=>{setFirst(e.target.value);setRequestId(crypto.randomUUID());setError(null);}}/>
        </label>
        <label htmlFor={`${id}-last`} className="block space-y-1 text-sm font-medium text-ink-900">Apellidos <span className="font-normal text-ink-500">(opcional)</span>
          <input id={`${id}-last`} className={`${FIELD} mt-1 h-10 w-full px-3 pointer-coarse:h-11`} autoComplete="family-name" maxLength={100} disabled={pending} value={last}
            onChange={e=>{setLast(e.target.value);setRequestId(crypto.randomUUID());setError(null);}}/>
        </label>
      </div>
      <p className="text-xs text-ink-500">Se guarda en este pedido de WooCommerce.{hasGuides && " Las guías ya emitidas conservan sus datos."}</p>
      {error && <Banner tone="crit" role="alert">{error}</Banner>}
      <div className="flex flex-wrap gap-2"><OpsButton type="submit" variant="primary" disabled={pending} className="pointer-coarse:h-11">{pending?"Guardando…":"Guardar nombre"}</OpsButton><OpsButton disabled={pending} onClick={close} className="pointer-coarse:h-11">Cancelar</OpsButton></div>
    </form>}
  </>;
}
