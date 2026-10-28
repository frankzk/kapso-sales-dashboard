import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseWooOrderId } from "@/lib/order-admin-url";
import { fetchWooOrder, wooRequest, type WooOrder } from "@/lib/woocommerce";
import { hasWooApiCredentials, loadWooStoreCreds, withWooAuthFallback, wooClientOpts } from "@/lib/woocommerce-intake";
import { applyWooOrderResponse } from "@/lib/ingest";
import { customerNameLabel, customerNameSnapshot, customerNameToEdit, sameCustomerNames, validateCustomerName,
  CUSTOMER_NAME_REQUESTED, CUSTOMER_NAME_UPDATED, type CustomerNameSnapshot, type UpdateCustomerNameInput } from "@/lib/order-customer-name";

export function customerNameOperation(orderId:string,requestId:string):string {
  const h=createHash("sha256").update(`customer-name|${orderId}|${requestId}`).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

/** El llamador ya autorizó sesión, RLS y orders.create en la organización del pedido. */
export async function updateWooCustomerName({admin,orderId,userId,input,fetchImpl}:{
  admin:SupabaseClient;orderId:string;userId:string;input:UpdateCustomerNameInput;fetchImpl?:typeof fetch;
}):Promise<{error?:string;notice?:string}> {
  const valid=validateCustomerName(input?.firstName,input?.lastName);
  if(!valid.ok)return {error:valid.error};
  if(!/^[a-zA-Z0-9-]{10,80}$/.test(input?.requestId ?? ""))return {error:"Vuelve a abrir la edición para generar un intento válido."};
  const {name}=valid;
  const desired:CustomerNameSnapshot={billing:name,shipping:name};
  const operationId=customerNameOperation(orderId,input.requestId);
  try {
    const {data:order,error:orderError}=await admin.from("orders").select("id,store_id,platform,shopify_order_id").eq("id",orderId).maybeSingle();
    if(orderError || !order)return {error:"No se pudo comprobar el pedido. No se cambió el nombre."};
    if(order.platform!=="woocommerce")return {error:"La edición de nombre está disponible para pedidos de WooCommerce."};
    const {creds,error:credsError}=await loadWooStoreCreds(admin,order.store_id);
    const parsed=parseWooOrderId(order.shopify_order_id);
    if(credsError || !hasWooApiCredentials(creds) || !parsed || parsed.siteKey!==creds.siteKey)
      return {error:"No se pudo comprobar la conexión de WooCommerce de este pedido."};
    const {data:attempts,error:attemptError}=await admin.from("order_events").select("kind,actor,payload").eq("order_id",orderId).eq("operation_id",operationId)
      .in("kind",[CUSTOMER_NAME_REQUESTED,CUSTOMER_NAME_UPDATED]);
    if(attemptError)return {error:"No se pudo comprobar el historial. No se cambió el nombre."};
    const prior=attempts?.find(e=>e.kind===CUSTOMER_NAME_REQUESTED);
    if(prior && (prior.actor!==userId || !sameCustomerNames(prior.payload?.after ?? customerNameSnapshot(null),desired)))
      return {error:"Este intento corresponde a otra edición. Cierra y vuelve a abrir el formulario."};
    const client=wooClientOpts(creds,{...(fetchImpl?{fetchImpl}:{}),timeoutMs:5000});
    const {value:remote}=await withWooAuthFallback(client,o=>fetchWooOrder(o,Number(parsed.wooId)));
    if(remote.id!==Number(parsed.wooId) || remote.status==="trash")return {error:"WooCommerce no devolvió un pedido válido para editar."};
    const current=customerNameSnapshot(remote);
    if(attempts?.some(e=>e.kind===CUSTOMER_NAME_UPDATED) && !sameCustomerNames(current,desired))
      return {error:"Esta edición ya se registró y el nombre cambió después. Actualiza la ficha para hacer otra corrección."};
    let before=current;
    if(prior)before=prior.payload.before as CustomerNameSnapshot;
    else {
      // Comparar ambas partes protege una ficha antigua; la fuente se relee antes del PUT.
      if(!input.expected || !sameCustomerNames(current,input.expected))return {error:"El nombre cambió desde que abriste la ficha. Actualízala antes de guardar."};
      if(sameCustomerNames(current,desired))return {notice:"El pedido ya tiene ese nombre y apellido."};
      const {error}=await admin.from("order_events").insert({store_id:order.store_id,order_id:orderId,kind:CUSTOMER_NAME_REQUESTED,source:"kapta",actor:userId,operation_id:operationId,
        note:"Corrección de nombres y apellidos solicitada a WooCommerce.",payload:{before,after:desired}});
      if(error)return {error:"No se pudo registrar este intento o ya está en curso. Reintenta para comprobarlo."};
    }
    if(prior && !sameCustomerNames(current,before) && !sameCustomerNames(current,desired))
      return {error:"Hay una edición más reciente en WooCommerce. Actualiza la ficha antes de continuar."};
    let confirmed:WooOrder=remote;
    if(!sameCustomerNames(current,desired)) {
      const address={first_name:name.firstName,last_name:name.lastName};
      try {
        const {value}=await withWooAuthFallback({...client,timeoutMs:10000},o=>wooRequest<WooOrder>(o,{method:"PUT",path:`/orders/${parsed.wooId}`,body:{billing:address,shipping:address}}));
        confirmed=value.data;
      } catch {
        // El servidor puede haber guardado aunque se perdiera la respuesta. Nunca se repite el PUT a ciegas.
        try {confirmed=(await withWooAuthFallback(client,o=>fetchWooOrder(o,Number(parsed.wooId)))).value;}
        catch{return {error:"WooCommerce no confirmó el cambio. Se conserva lo escrito; vuelve a intentar para comprobarlo."};}
      }
    }
    if(confirmed?.id!==Number(parsed.wooId) || !sameCustomerNames(customerNameSnapshot(confirmed),desired))
      return {error:"WooCommerce no confirmó los nombres y apellidos. No se marcó la edición como completada."};
    // El hecho se guarda antes del espejo. Reintentar conserva el antes original y no duplica historial.
    const {error:auditError}=await admin.from("order_events").insert({store_id:order.store_id,order_id:orderId,kind:CUSTOMER_NAME_UPDATED,source:"kapta",actor:userId,operation_id:operationId,
      note:`Nombre del cliente: ${customerNameLabel(customerNameToEdit(before)) || "Sin nombre"} → ${customerNameLabel(name)}.`,payload:{before,after:desired}});
    if(auditError && auditError.code!=="23505")return {error:"WooCommerce confirmó el nombre; falta guardar su historial. Reintenta para completar el registro."};
    const applied=await applyWooOrderResponse(admin,creds,confirmed,fetchImpl);
    if(!applied.applied)return {error:"WooCommerce confirmó el nombre; falta actualizar el Master. Reintenta para sincronizarlo."};
    return {notice:"Nombres y apellidos actualizados en el pedido y registrados en Actividad."};
  } catch {
    return {error:"No se pudo completar la edición del nombre. Se conserva lo escrito; actualiza o reintenta."};
  }
}
