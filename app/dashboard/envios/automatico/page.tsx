import Link from "next/link";
import { createServerSupabase } from "@/lib/db";
import { getAdminOrgs } from "@/lib/access";
import { AUTO_REASONS, type AutoSettings } from "@/lib/swayp-auto-policy";
import { toggleAutomatic, runAutomatic, togglePilot } from "./actions";

export const dynamic="force-dynamic";
export const maxDuration=300;
const when=(value:string)=>new Date(value).toLocaleString("es-PE",{timeZone:"America/Lima"});
export default async function AutomaticPage() {
  const sb=await createServerSupabase();
  const [config,decisions,runs,emissions,memberships,metrics]=await Promise.all([
    sb.from("swayp_auto_settings").select("*"),
    sb.from("swayp_auto_decisions").select("shipment_id,reason,evidence,checked_at").order("checked_at",{ascending:false}).limit(100),
    sb.from("swayp_auto_runs").select("id,summary,created_at").order("created_at",{ascending:false}).limit(10),
    sb.from("swayp_guide_emissions").select("id,state,guide_code,child_id,created_at,error").eq("automatic",true).order("created_at",{ascending:false}).limit(30),
    getAdminOrgs(),
    sb.from("swayp_auto_metrics").select("*"),
  ]);
  const error=[config,decisions,runs,emissions,metrics].find(r=>r.error)?.error;
  if(error) return <p>No se pudo cargar el automático: {error.message}</p>;
  return <main className="space-y-6 p-6">
    <Link className="text-blue-700" href="/dashboard/envios">← Repro Provincia</Link>
    <h1 className="text-2xl font-semibold">Aliclik → Swayp automático</h1>
    <p>Evalúa cada 30 minutos. Emite sin llamada ni nueva confirmación, para el siguiente día operativo.</p>
    {(config.data as AutoSettings[]??[]).map(c=><section key={c.org_id} className="rounded border bg-white p-4 space-y-3">
      <p className="font-semibold">{c.enabled?"Activo":"Pausado"} · máximo {c.daily_cap} intentos por día entre las tiendas de la organización</p>
      <p>Vía con historial: pedidos de hasta {c.max_order_days} días. Entrega anterior en los últimos {c.history_days} días, mismo domicilio y producto distinto. Sin rechazo ni otra salida activa. Stock completo consultado en Swayp.</p>
      <p className="font-semibold">Piloto sin historial: {c.pilot_enabled?"activo":"pausado"} · máximo {c.pilot_daily_cap??3} intentos diarios, incluidos en el límite general.</p>
      <p>Hasta 14 días, de 1 a 2 intentos Aliclik informados con el paquete en reparto o de vuelta, y máximo S/500. Referencia y ubicación corroborada, sin pagos registrados por descontar. Conserva las comprobaciones de rechazo, duplicados, cobertura y stock completo.</p>
      {memberships.some(m=>m.org_id===c.org_id&&["owner","admin"].includes(m.role))&&<div className="flex gap-4">
        <form action={toggleAutomatic}><input type="hidden" name="orgId" value={c.org_id}/><input type="hidden" name="enabled" value={String(!c.enabled)}/><button className="rounded border px-3 py-2">{c.enabled?"Pausar":"Activar"}</button></form>
        {c.enabled&&<form action={runAutomatic}><input type="hidden" name="orgId" value={c.org_id}/><button className="rounded border px-3 py-2">Evaluar y despachar ahora</button></form>}
        <form action={togglePilot}><input type="hidden" name="orgId" value={c.org_id}/><input type="hidden" name="enabled" value={String(!c.pilot_enabled)}/><button className="rounded border px-3 py-2">{c.pilot_enabled?"Pausar piloto":"Activar piloto"}</button></form>
      </div>}
    </section>)}
    {!config.data?.length&&<p>No hay organizaciones configuradas.</p>}
    <section className="space-y-2"><h2 className="text-lg font-semibold">Resultado acumulado por vía</h2>
      {metrics.data?.map(m=><div key={`${m.org_id}-${m.cohort}`} className="rounded border p-3">
        <p className="font-semibold">{m.cohort==="recent_no_history"?"Piloto sin historial":"Con entrega previa"}</p>
        <p>{m.issued} guías · {m.delivered} entregadas · {m.returned} devueltas · {m.cancelled} anuladas · {m.pending} pendientes · {m.review} por revisar</p>
        <p>Costo logístico estimado por entrega recuperada: {m.delivered>0&&m.missing_cost===0&&m.quoted_cost!==null?`S/ ${(Number(m.quoted_cost)/m.delivered).toFixed(2)}`:"pendiente de entregas o costos completos"}.</p>
      </div>)}
      {!metrics.data?.length&&<p>Aún no hay intentos automáticos registrados.</p>}
      <p className="text-sm text-gray-600">Estimación con el flete cotizado por Swayp y la devolución registrada; incluye envíos fallidos. No equivale a una liquidación final. Los costos faltantes no se cuentan como cero.</p>
    </section>
    <section className="space-y-2"><h2 className="text-lg font-semibold">Últimas ejecuciones</h2>
      {runs.data?.map(r=><p key={r.id}>{when(r.created_at)} · {r.summary.state==="running"?"En ejecución":`${r.summary.checked??0} evaluados · ${r.summary.created??0} guías creadas · ${r.summary.review??0} por revisar`}{r.summary.error&&` · Error: ${r.summary.error}`}</p>)}
      {!runs.data?.length&&<p>Aún no hay ejecuciones registradas.</p>}
    </section>
    <section className="space-y-2"><h2 className="text-lg font-semibold">Emisiones automáticas</h2>
      {emissions.data?.map(e=><p key={e.id}>{when(e.created_at)} · {e.child_id?<Link className="text-blue-700" href={`/dashboard/envios?open=${e.child_id}`}>Guía {e.guide_code}</Link>:<>Pendiente de revisión · {e.guide_code??e.id}</>}{e.error&&` · ${e.error}`}</p>)}
      {!emissions.data?.length&&<p>Aún no se han emitido guías por esta regla.</p>}
    </section>
    <section><h2 className="text-lg font-semibold mb-3">Última evaluación de cada pedido</h2>
      <table className="w-full text-sm text-left"><thead><tr><th>Pedido</th><th>Resultado</th><th>Evaluado</th></tr></thead>
        <tbody>{decisions.data?.map(d=><tr key={d.shipment_id} className="border-t"><td className="py-2"><Link className="text-blue-700" href={`/dashboard/envios?open=${d.shipment_id}`}>{d.evidence.orderName??d.shipment_id}</Link></td><td>{AUTO_REASONS[d.reason]??d.reason}{d.evidence.detail&&<p>{d.evidence.detail}</p>}</td><td>{when(d.checked_at)}</td></tr>)}</tbody>
      </table>
    </section>
  </main>;
}
