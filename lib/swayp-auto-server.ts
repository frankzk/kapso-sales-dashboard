import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { evaluateAutoDispatch, type AutoSettings, type AutoSnapshot } from "@/lib/swayp-auto-policy";
import { parseSenders } from "@/lib/swayp-guide";
import { createFenixGuideViaApi, spinOffFenixGuide } from "@/lib/swayp-reenvio";
import { filasDelMapaSwayp, unVinculoPorSku, conflictosDeCodbar } from "@/lib/swayp-sku-map";
import { normalizeSku } from "@/lib/swayp-productos";
import { leerInventarioSwayp } from "@/lib/swayp-inventory-sync";
import { swaypOptsFromEnv } from "@/lib/swayp";
import { fenixWarehouseKey } from "@/lib/shipments";
import { corroboratePilotLocation } from "@/lib/swayp-auto-location";
import { limaDateKey } from "@/lib/aliclik-geo";

export async function inspectAuto(admin: SupabaseClient, shipmentId: string) {
  const { data, error } = await admin.rpc("swayp_auto_inspect", { p_source: shipmentId });
  if (error || !data?.snapshot) throw new Error(error?.message ?? "No se encontró el pedido");
  return data as { snapshot: AutoSnapshot; fingerprint: string };
}

export async function runAutoDispatch(admin: SupabaseClient, settings: AutoSettings, dry = false) {
  const started = Date.now();
  const report = { checked: 0, eligible: 0, created: 0, review: 0, excluded: {} as Record<string,number>, error: null as string | null };
  let runId: string | undefined;
  if (!dry) {
    if (!settings.enabled) return report;
    const run = await admin.from("swayp_auto_runs").insert({org_id:settings.org_id,summary:{state:"running"}}).select("id").single();
    if (run.error) throw new Error(run.error.message);
    runId=run.data.id;
  }
  try {
    const used=await admin.from("swayp_guide_emissions").select("evidence").eq("org_id",settings.org_id).eq("automatic",true).gte("created_at",`${limaDateKey()}T00:00:00-05:00`);
    if(used.error) throw new Error(used.error.message);
    let pilotUsed=(used.data??[]).filter(e=>e.evidence?.cohort==="recent_no_history").length;
    const {data:rows,error} = await admin.rpc("swayp_auto_candidates",{p_org:settings.org_id});
    if (error) throw new Error(error.message);
    for (const row of (rows ?? []) as {id:string}[]) {
      if (Date.now()-started>220000 || report.created>=settings.daily_cap) break;
      const {snapshot:s,fingerprint} = await inspectAuto(admin,row.id);
      const verdict = evaluateAutoDispatch(s,settings,new Date());
      report.checked++;
      let reason=verdict.reason;
      const evidence: Record<string,unknown> = {fingerprint,policy:"aliclik-swayp-v2",orderName:s.order.name};
      if (verdict.eligible) {
        evidence.cohort=verdict.cohort;
        evidence.priorOrderId=verdict.priorOrderId;
        evidence.dispatchDate=verdict.dispatchDate;
        let locationOk=true;
        const pilotFull=verdict.cohort==="recent_no_history"&&pilotUsed>=(settings.pilot_daily_cap??3);
        if(verdict.cohort==="recent_no_history"&&!pilotFull) {
          const located=await corroboratePilotLocation(admin,settings.org_id,verdict.city,verdict.address.city!,s.source.latitude!,s.source.longitude!);
          locationOk=located.ok;
          evidence.location=located;
        }
        const senders=parseSenders(env.swaypSenders());
        if (pilotFull) reason="pilot_cap";
        else if (!locationOk) reason="pilot_location";
        else if (!env.swaypEnabled() || !senders[verdict.city]
          || process.env.SWAYP_INVENTORY_ORG_ID !== settings.org_id) reason="api_disabled";
        else {
          const mappingRows=await filasDelMapaSwayp(admin,s.order.store_id);
          const mapping=unVinculoPorSku(mappingRows,s.order.store_id), conflicts=conflictosDeCodbar(mappingRows);
          const currentCodes=new Set(verdict.items.map(i=>mapping.get(normalizeSku(i.sku))?.codbar));
          if (verdict.items.some(item=>!mapping.get(normalizeSku(item.sku))?.codbar || conflicts.has(normalizeSku(item.sku)))) reason="no_mapping";
          else if(s.history.some(h=>h.delivered_at && (h.line_items??[]).some(i=>{
            const code=mapping.get(normalizeSku(i.sku))?.codbar; return code && currentCodes.has(code);
          }))) reason="same_product";
          else {
            const readAt=new Date().toISOString();
            const inventory=await leerInventarioSwayp({tipo:"integracion",opts:swaypOptsFromEnv()});
            if ("error" in inventory) throw new Error(inventory.error);
            const stock=inventory.porCiudad.get(fenixWarehouseKey(verdict.city)) ?? [];
            const needed=new Map<string,number>();
            for (const item of verdict.items) {
              const code=mapping.get(normalizeSku(item.sku))!.codbar;
              needed.set(code,(needed.get(code)??0)+item.quantity);
            }
            if ([...needed].some(([code,qty])=>stock.filter(x=>x.codbar===code).reduce((n,x)=>n+x.disponible,0)<qty)) reason="no_stock";
            else {
              report.eligible++;
              if (!dry) {
                const note=verdict.cohort==="recent_no_history"
                  ? "Reintento automático Aliclik → Swayp, piloto sin historial: hasta 7 días, un intento, máximo S/500, ubicación corroborada y stock completo. Sin llamada ni nueva confirmación del cliente."
                  : "Reintento automático Aliclik → Swayp: entrega previa en el mismo domicilio, producto distinto y stock completo. Sin llamada ni nueva confirmación del cliente.";
                const issued=await createFenixGuideViaApi({
                  admin,storeId:s.order.store_id,orderId:s.order.id,sourceKey:s.source.id,city:verdict.city,
                  district:verdict.address.city,customerName:verdict.address.name,customerPhone:verdict.phone,
                  address1:verdict.address.address1,reference:verdict.address.address2,
                  lineItems:verdict.items,codAmount:Number(s.order.total_amount),dispatchDateIso:verdict.dispatchDate,
                  observaciones:"Reintento de entrega. Mantener productos, domicilio e importe del pedido original.",
                  automatic:{evidence,stock:stock.map(x=>({codbar:x.codbar,disponible:x.disponible})),readAt},
                });
                if (!issued.ok) {
                  const pending=await admin.from("swayp_guide_emissions").select("id").eq("source_key",s.source.id).maybeSingle();
                  reason=pending.data?"review":"emission_blocked"; evidence.detail=issued.reason;
                  if(pending.data) report.review++;
                }
                else {
                  evidence.guideCode=issued.guia;
                  const child=await spinOffFenixGuide(admin,{userId:null,storeId:s.order.store_id},s.source.id,issued.guia,{
                    expectedSourceStatus:"anulado",childNextFollowupAt:verdict.dispatchDate,
                    parentAuditNote:note,swaypGuide:issued.guia,swaypState:issued.idEstado,
                  });
                  if ("error" in child) {
                    reason="review"; evidence.detail=child.error; report.review++;
                    await admin.from("swayp_guide_emissions").update({state:"review",error:child.error}).eq("source_key",s.source.id);
                  }
                  else {
                    reason="created"; evidence.childId=child.childId; report.created++;
                    if(verdict.cohort==="recent_no_history") pilotUsed++;
                    const audit=await admin.from("shipment_calls").insert({shipment_id:child.childId,store_id:s.order.store_id,
                      agent:null,kind:"reroute",new_status:"en_ruta",note,next_followup_at:verdict.dispatchDate});
                    if (audit.error) throw new Error(`Guía ${issued.guia} creada; falta nota de auditoría: ${audit.error.message}`);
                  }
                }
              }
            }
          }
        }
      }
      if (!["created","eligible"].includes(reason)) report.excluded[reason]=(report.excluded[reason]??0)+1;
      if (!dry) {
        const saved=await admin.from("swayp_auto_decisions").upsert({shipment_id:s.source.id,order_id:s.order.id,
          store_id:s.order.store_id,org_id:settings.org_id,reason,evidence,checked_at:new Date().toISOString()});
        if (saved.error) throw new Error(saved.error.message);
      }
      // Stop the batch on an ambiguous issuance. Other orders remain for next pass.
      if (report.review) break;
    }
  } catch(err) { report.error=err instanceof Error?err.message:"Error del automático"; }
  if (runId) {
    const saved=await admin.from("swayp_auto_runs").update({summary:{...report,state:report.error?"error":"completed"}}).eq("id",runId);
    if (saved.error) throw new Error(saved.error.message);
  }
  return report;
}
