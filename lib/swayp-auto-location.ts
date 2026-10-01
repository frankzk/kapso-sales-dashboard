import type { SupabaseClient } from "@supabase/supabase-js";
import { quoteShippingCost, type AliclikShippingCost } from "@/lib/aliclik";
import { decryptOrNull } from "@/lib/crypto";
import { toAliclikCoord } from "@/lib/aliclik-geo";
import { deriveFenixCoverageCity } from "@/lib/shipments";
import { resolveUbigeo } from "@/lib/ubigeo";

export function pilotLocationMatches(city:string,district:string,quote:AliclikShippingCost):boolean {
  const geo=quote.ubigeo;
  if (!geo?.district?.name || !geo.province?.name) return false;
  const quotedCity=deriveFenixCoverageCity(geo.district.name,geo.province.name);
  const wanted=resolveUbigeo(city,district), observed=resolveUbigeo(quotedCity,geo.district.name);
  return !!wanted?.exact && !!observed?.exact && wanted.code===observed.code;
}

/** Read-only geolocation, using the existing Aliclik account and source pin. */
export async function corroboratePilotLocation(admin:SupabaseClient,orgId:string,city:string,district:string,lat:number,lng:number) {
  const stores=await admin.from("stores").select("id,aliclik_api_token_enc").eq("org_id",orgId).eq("aliclik_enabled",true).eq("status","active").order("id");
  if(stores.error) throw new Error("No se pudo consultar la conexión de ubicación");
  const ids=(stores.data??[]).map(s=>s.id);
  const token=(stores.data??[]).map(s=>decryptOrNull(s.aliclik_api_token_enc)).find(Boolean);
  if(!token || !ids.length) return {ok:false as const,detail:"Sin conexión Aliclik para corroborar el pin"};
  const warehouse=await admin.from("aliclik_skus").select("warehouse_id").in("store_id",ids).gt("warehouse_id",0).order("warehouse_id").limit(1).maybeSingle();
  if(warehouse.error || !warehouse.data) return {ok:false as const,detail:"Sin almacén Aliclik para consultar la ubicación"};
  const result=await quoteShippingCost({apiToken:token,timeoutMs:10000},{warehouseId:warehouse.data.warehouse_id,lat:toAliclikCoord(lat),lng:toAliclikCoord(lng)},{retry:false});
  if(!result.ok) return {ok:false as const,detail:"No se pudo corroborar la ubicación con Aliclik"};
  return {ok:pilotLocationMatches(city,district,result.data),detail:"El pin debe resolver al mismo ubigeo que la dirección",geo:result.data.ubigeo};
}
