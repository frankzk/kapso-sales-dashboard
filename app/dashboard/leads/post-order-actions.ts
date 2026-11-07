"use server";

// Después de «Generar pedido» en Leads: cómo sale y cómo se cobra el pedido
// recién creado (MOM §25.2, owner 07-11-2026). SOLO LECTURA: decide qué
// opciones se ofrecen —«Guía Aliclik», «Swayp hoy», «Agencia Shalom + adelanto»—
// con las mismas lecturas y reglas que la ficha del pedido. Las acciones
// (crear la guía, emitir Swayp, registrar el pago, guardar el DNI y la
// agencia) son las de siempre y vuelven a comprobar todo en el servidor; esto
// es la puerta, no la cerradura.

import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/db";
import { getLeadRoutingScope } from "@/lib/lead-routing-access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { loadConfirmationBrief, loadOrderDetail } from "@/app/dashboard/pedidos/actions";
import { loadShalomOrderDraft } from "@/app/dashboard/pedidos/shalom-actions";
import { needsConfirmationBrief } from "@/lib/order-confirmation-brief";
import { aliclikGuideOffered } from "@/lib/order-route-plan";
import { swaypAvailabilityFor } from "@/lib/master-swayp-availability";
import type { FenixStockRow } from "@/lib/fenix";
import type { OrderMasterRow } from "@/lib/types";
import { leadPostOrderChoices, type LeadPostOrderChoices } from "@/lib/lead-post-order";
import type { SwaypAvailabilityValue } from "@/lib/swayp-desde-confirmacion-offer";

/**
 * La columna `swayp_availability` la llena una pasada horaria (y el sync de
 * inventario), no el recálculo del pedido: un pedido que acaba de nacer en
 * «Generar pedido» la tiene vacía, y «Swayp hoy» no se ofrecería nunca justo
 * cuando la asesora lo necesita. Si está vacía y el pedido podría tomarla, se
 * evalúa AHORA con la misma regla que la pasada (`swaypAvailabilityFor`), sin
 * escribir nada. Si la lectura del stock falla, queda sin evaluar y la pantalla
 * lo dice.
 */
async function swaypAvailabilityNow(
  row: OrderMasterRow,
  lineItems: { title?: string | null; sku?: string | null }[],
): Promise<SwaypAvailabilityValue | null> {
  if (row.swayp_availability || row.macro_stage !== "por_confirmar" || row.coverage !== "provincia_cod") return null;
  try {
    const sb = await createServerSupabase();
    const { data: store } = await sb.from("stores").select("org_id").eq("id", row.store_id).maybeSingle();
    const orgId = (store as { org_id?: string | null } | null)?.org_id;
    if (!orgId) return null;
    const { data: stock, error } = await sb
      .from("fenix_stock")
      .select("city,product,sku,quantity,unlimited")
      .eq("org_id", orgId);
    if (error) return null;
    return swaypAvailabilityFor(
      { macro_stage: row.macro_stage ?? null, district: row.district, province: row.province, region: row.region },
      (stock as FenixStockRow[]) ?? [],
      lineItems,
    );
  } catch {
    return null;
  }
}

export async function loadLeadPostOrderChoices(
  leadId: string,
): Promise<{ choices: LeadPostOrderChoices | null } | { error: string }> {
  const sb = await createServerSupabase();
  const { data: claims } = await sb.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login");
  // El lead con los permisos de quien mira (RLS) y su reparto por bloques, como
  // el resto de la ficha del lead.
  const { data } = await sb.from("leads").select("store_id,order_id").eq("id", leadId).maybeSingle();
  const lead = data as { store_id: string; order_id: string | null } | null;
  if (!lead) return { error: "Sin acceso a este lead." };
  if (!(await getLeadRoutingScope([lead.store_id], leadId)).allowed) return { error: "Sin acceso a este lead." };
  if (!lead.order_id) return { choices: null };
  const orderId = lead.order_id;

  // La misma lectura que abre la ficha del pedido (RLS por tienda).
  const [res, perms] = await Promise.all([loadOrderDetail(orderId), getMasterPermissions()]);
  if ("error" in res) {
    return {
      error:
        res.error === "No encontrado."
          ? "El pedido todavía no aparece en el Master. Vuelve a intentarlo en unos segundos."
          : res.error,
    };
  }
  const detail = res.detail;
  const travelsInCompanion = Boolean(detail.companion.travelsIn);
  // La ficha del §8 solo donde la ficha del pedido la pide (Por confirmar, o
  // Aliclik ofrecido): de ella sale si una regla de riesgo exige adelanto.
  const aliclikOffered = aliclikGuideOffered({ travelsInCompanion, candidates: detail.routePlan.candidates });
  const [brief, draft, availabilityNow] = await Promise.all([
    needsConfirmationBrief(detail.row.macro_stage, aliclikOffered)
      ? loadConfirmationBrief(orderId).then((r) => ("brief" in r ? r.brief : null)).catch(() => null)
      : Promise.resolve(null),
    loadShalomOrderDraft(orderId).then((r) => ("draft" in r ? r.draft : null)).catch(() => null),
    swaypAvailabilityNow(detail.row, detail.lineItems),
  ]);

  return {
    choices: leadPostOrderChoices({
      orderId,
      orderName: detail.row.order_name ?? null,
      row: detail.row,
      routePlan: detail.routePlan,
      travelsInCompanion,
      guides: detail.guides,
      swaypAvailabilityNow: availabilityNow,
      brief,
      shalomDraft: draft ? { document: draft.document ?? null, terminalName: draft.destinyTerminalName ?? null } : null,
      perms: {
        // Lo que la ficha llama `canEdit`, y el permiso con que el servidor
        // emite la guía Swayp («Tu rol no permite gestionar envíos»).
        canEdit: !perms.readOnly && perms.can("master.edit"),
        canCreateGuide: perms.can("aliclik.create_guide"),
        canCreateShalomGuide: perms.can("shalom.create_guide"),
      },
    }),
  };
}
