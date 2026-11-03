export interface CustomerName { firstName: string; lastName: string }
export interface CustomerNameSnapshot { billing: CustomerName; shipping: CustomerName }
export const CUSTOMER_NAME_PERMISSION = "orders.create";
export const CUSTOMER_NAME_UPDATED = "customer_name_updated";
export const CUSTOMER_NAME_REQUESTED = "customer_name_update_requested";

const text = (v: unknown) => typeof v === "string" ? v.replace(/\s+/gu, " ").trim() : "";
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const addressName = (v: unknown): CustomerName => ({firstName:text(record(v).first_name),lastName:text(record(v).last_name)});
export function customerNameSnapshot(order: unknown): CustomerNameSnapshot {
  const o=record(order);
  return {billing:addressName(o.billing),shipping:addressName(o.shipping)};
}
export function customerNameFromRaw(raw: unknown, fallback: string | null): CustomerNameSnapshot {
  const r=record(raw);
  if(r.woo) return customerNameSnapshot(r.woo);
  return {billing:{firstName:fallback ?? "",lastName:""},shipping:{firstName:fallback ?? "",lastName:""}};
}
export function sameCustomerNames(a: CustomerNameSnapshot,b: CustomerNameSnapshot): boolean {
  return a.billing.firstName===b.billing.firstName && a.billing.lastName===b.billing.lastName
    && a.shipping.firstName===b.shipping.firstName && a.shipping.lastName===b.shipping.lastName;
}
export function customerNameLabel(n: CustomerName): string { return [n.firstName,n.lastName].filter(Boolean).join(" "); }
export function customerNameToEdit(n: CustomerNameSnapshot): CustomerName {
  return customerNameLabel(n.shipping) ? n.shipping : n.billing;
}
export function validateCustomerName(first: unknown,last: unknown): {ok:true;name:CustomerName}|{ok:false;error:string} {
  if(typeof first!=="string" || typeof last!=="string" || first.length>300 || last.length>300)
    return {ok:false,error:"Revisa los nombres y apellidos del cliente."};
  const firstName=text(first),lastName=text(last);
  if(!firstName) return {ok:false,error:"Ingresa al menos el nombre del cliente."};
  if(firstName.length>100 || lastName.length>100) return {ok:false,error:"Nombres y apellidos admiten hasta 100 caracteres por campo."};
  if(/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(first+last))
    return {ok:false,error:"Usa texto para los nombres y apellidos, sin etiquetas ni caracteres de control."};
  return {ok:true,name:{firstName,lastName}};
}
export interface UpdateCustomerNameInput {
  firstName: string;
  lastName: string;
  expected: CustomerNameSnapshot;
  requestId: string;
}
