"use server";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { CUSTOMER_NAME_PERMISSION, type UpdateCustomerNameInput } from "@/lib/order-customer-name";
import { updateWooCustomerName } from "@/lib/order-customer-name-server";

export async function updateOrderCustomerName(orderId:string,input:UpdateCustomerNameInput):Promise<{error?:string;notice?:string}> {
  const sb=await createServerSupabase();
  const {data:{user}}=await sb.auth.getUser();
  if(!user)return {error:"Inicia sesión antes de editar el nombre."};
  const {data:order,error}=await sb.from("order_master").select("store_id").eq("order_id",orderId).maybeSingle();
  if(error || !order)return {error:"Sin acceso al pedido."};
  const {data:store,error:storeError}=await sb.from("stores").select("org_id").eq("id",order.store_id).maybeSingle();
  if(storeError || !store?.org_id || !(await hasOrgPermission(store.org_id,CUSTOMER_NAME_PERMISSION)))
    return {error:"No tienes permiso para editar el nombre del cliente en esta tienda."};
  const result=await updateWooCustomerName({admin:createAdminSupabase(),orderId,userId:user.id,input:{
    firstName:input?.firstName,lastName:input?.lastName,expected:input?.expected,requestId:input?.requestId,
  }});
  revalidatePath("/dashboard/pedidos");
  return result;
}
