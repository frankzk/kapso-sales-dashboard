import "server-only";

// Lo de afuera de las acciones del agente de IA (MOM §42.9; 0323): los permisos
// de quien lo conectó, Kapso y Aliclik. La orquestación y los frenos viven en
// lib/agent-actions-flow.ts; aquí solo se enchufan las funciones de siempre:
//
//   · permisos: los mismos tres orígenes que la pantalla (`memberships`,
//     `user_permissions` y `membership_roles` de ESA organización), leídos con
//     service_role filtrando por la persona y la organización del token;
//   · WhatsApp: `sendWhatsappText`, el mismo envío que Leads;
//   · guía: `aliclikContextFor` + `previewAliclikGuideFor` +
//     `aliclikCreateGates` + `createAliclikGuideFor`, el camino del botón y del
//     envío programado, sin persona (`userId` null: el agente no puede
//     justificar otra salida ni levantar excepciones) y con origen `agente_ia`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStoreCreds } from "@/lib/ingest";
import { permissionsFor, type Permission } from "@/lib/permissions";
import { fetchLastInboundAt, listConversationsByPhone, sendWhatsappText } from "@/lib/kapso";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import {
  aliclikContextFor,
  aliclikCreateGates,
  aliclikReadScopeFor,
  createAliclikGuideFor,
  previewAliclikGuideFor,
  type AliclikGuideOrigin,
} from "@/lib/aliclik-guide";
import { autoTransport } from "@/lib/aliclik-scheduled";
import { AGENT_GUIDE_ORIGIN_KIND } from "@/lib/agent-actions";
import { createAgentActions, type AgentActions, type AgentGuideCreated, type AgentGuideQuote, type AgentOrderRef } from "@/lib/agent-actions-flow";
import type { OrderMasterRow } from "@/lib/types";

/** Los permisos efectivos de una persona en una organización, leídos con service_role. */
export async function agentCreatorPermissions(admin: SupabaseClient, orgId: string, userId: string): Promise<Set<Permission> | null> {
  const [membership, grants, functions] = await Promise.all([
    admin.from("memberships").select("role").eq("org_id", orgId).eq("user_id", userId).maybeSingle(),
    admin.from("user_permissions").select("permission,granted").eq("org_id", orgId).eq("user_id", userId),
    admin.from("membership_roles").select("role").eq("org_id", orgId).eq("user_id", userId),
  ]);
  if (membership.error) return null;
  const role = (membership.data as { role?: string } | null)?.role;
  if (!role) return new Set<Permission>();
  // Como la pantalla (lib/permissions-access.ts): sin esas tablas, los permisos salen solo del rol.
  return permissionsFor(
    [role],
    grants.error ? [] : ((grants.data ?? []) as { permission: string; granted: boolean | null }[]).map((g) => ({ permission: g.permission, granted: g.granted ?? true })),
    functions.error ? [] : ((functions.data ?? []) as { role: string }[]).map((r) => r.role),
  );
}

type GuideSetup =
  | { ok: true; ctx: NonNullable<Awaited<ReturnType<typeof aliclikContextFor>>["ctx"]>; scope: NonNullable<Awaited<ReturnType<typeof aliclikReadScopeFor>>["scope"]> }
  | { ok: false; code: string; message: string };

/** El pedido leído de nuevo, la organización de Aliclik y su cliente. */
async function guideSetup(admin: SupabaseClient, order: AgentOrderRef): Promise<GuideSetup> {
  const { data, error } = await admin.from("order_master").select("*").eq("order_id", order.orderId).eq("store_id", order.storeId).maybeSingle();
  if (error || !data) return { ok: false, code: "base_no_disponible", message: "No se pudo leer el pedido ahora. Reintenta en unos segundos." };
  const resolved = await aliclikReadScopeFor(admin, order.storeId);
  if (!resolved.scope) return { ok: false, code: "base_no_disponible", message: resolved.error ?? "No se pudo leer la organización de la tienda." };
  const { ctx, error: ctxError } = await aliclikContextFor(data as OrderMasterRow, null, { blockAgencia: true });
  if (!ctx) return { ok: false, code: "regla_kapta", message: ctxError ?? "No se pudo preparar la conexión con Aliclik." };
  return { ok: true, ctx, scope: resolved.scope };
}

function origin(reason: string, scheduledOn: string): AliclikGuideOrigin {
  return { kind: AGENT_GUIDE_ORIGIN_KIND, scheduledOn, reason };
}

async function quoteGuide(admin: SupabaseClient, order: AgentOrderRef, today: string): Promise<AgentGuideQuote> {
  const setup = await guideSetup(admin, order);
  if (!setup.ok) return setup;
  const preview = await previewAliclikGuideFor(setup.ctx, { modality: "cod" }, setup.scope);
  if (!preview.ok) {
    if (preview.notReady) return { ok: false, code: "sin_direccion_todavia", message: preview.error ?? "Shopify todavía no manda la dirección. Reintenta en unos minutos." };
    if (preview.needsCoordinate) {
      return { ok: false, code: "sin_ubicacion", message: "El pedido no tiene la ubicación (coordenada) que Aliclik exige: que una persona la complete en la ficha." };
    }
    if (preview.pinSinCorroborar) return { ok: false, code: "pin_sin_respaldo", message: preview.pinSinCorroborar };
    return { ok: false, code: "no_cotiza", message: preview.error ?? "Aliclik no cotizó este envío." };
  }
  if (preview.writeBlocked) return { ok: false, code: "escritura_cerrada", message: preview.writeBlocked };
  if (preview.additionalOutput && (preview.additionalOutput.blocked || preview.additionalOutput.requiresReason)) {
    return { ok: false, code: "otra_salida", message: `${preview.additionalOutput.message} El agente no escribe motivos: lo decide una persona.` };
  }
  // Las compuertas de la creación (venta anulada, pago adelantado, rechazos,
  // duplicados, riesgo, salidas), sin crear nada: lo que dice la vista previa
  // es lo que hará la creación.
  const gates = await aliclikCreateGates(setup.ctx, {}, setup.scope, origin("", today));
  if (!gates.ok) return { ok: false, code: gates.kaptaBlock ? "regla_kapta" : "base_no_disponible", message: gates.error };
  const transport = autoTransport(preview.couriers);
  if (!transport) return { ok: false, code: "sin_courier", message: "Ninguna transportadora de Aliclik se puede agendar ahora para este destino." };
  const warnings = [...(preview.warnings ?? [])];
  if (preview.dispatch?.fallsOnSunday) warnings.push("El recojo calculado cae en domingo.");
  return {
    ok: true,
    transportId: transport.transportId,
    transportName: transport.transportName ?? null,
    deliveryCost: transport.deliveryCost,
    collectTotal: preview.collectTotal ?? null,
    orderTotal: preview.orderTotal ?? null,
    warnings,
    pickupDate: preview.dispatch?.date ?? null,
  };
}

async function createGuide(
  admin: SupabaseClient,
  order: AgentOrderRef,
  quote: { transportId: number; collectTotal: number | null },
  how: { reason: string; scheduledOn: string },
): Promise<AgentGuideCreated> {
  const setup = await guideSetup(admin, order);
  if (!setup.ok) return { status: setup.code === "regla_kapta" ? "rechazada" : "error", code: setup.code, orderNumber: null, message: setup.message };
  const result = await createAliclikGuideFor(
    setup.ctx,
    { transportId: quote.transportId, expectedCollectTotal: quote.collectTotal, note: null },
    setup.scope,
    origin(how.reason, how.scheduledOn),
  );
  if (result.locked) {
    return { status: "rechazada", code: "otra_creacion_en_curso", orderNumber: null, message: result.error ?? "Otra creación de la guía de este pedido está en curso." };
  }
  if (result.timedOut) {
    return { status: "incierta", code: "sin_respuesta_aliclik", orderNumber: result.orderNumber ?? null, message: `Aliclik no respondió a tiempo y pudo haberla creado. ${result.error ?? ""}`.trim() };
  }
  if (result.error && result.orderNumber) {
    return {
      status: "incierta",
      code: "no_guardada",
      orderNumber: result.orderNumber,
      message: `Se creó en Aliclik (${result.orderNumber}) pero no se guardó en Kapta: que una persona la vincule.`,
    };
  }
  if (result.error) return { status: result.kaptaBlock ? "rechazada" : "error", code: result.kaptaBlock ? "regla_kapta" : "guia_no_creada", orderNumber: null, message: result.error };
  return { status: "hecha", code: null, orderNumber: result.orderNumber ?? null, message: result.notice ?? null };
}

/** Las acciones del agente con lo de verdad. Una por llamada a `/api/mcp`. */
export function agentActionsFor(admin: SupabaseClient, now: () => Date = () => new Date()): AgentActions {
  return createAgentActions({
    admin,
    now,
    permissions: (orgId, userId) => agentCreatorPermissions(admin, orgId, userId),
    kapso: {
      creds: async (storeId) => {
        const creds = await getStoreCreds(storeId, admin);
        return creds?.kapso_api_key ? { apiKey: creds.kapso_api_key, phoneNumberId: creds.whatsapp_phone_number_id ?? null } : null;
      },
      conversations: (opts, phone) => listConversationsByPhone(opts, phone),
      lastInboundAt: fetchLastInboundAt,
      sendText: sendWhatsappText,
    },
    aliclik: {
      quote: (order) => quoteGuide(admin, order, new Date(now().getTime() - 5 * 3600_000).toISOString().slice(0, 10)),
      create: (order, quote, how) => createGuide(admin, order, quote, how),
    },
    recompute: async (orderIds) => {
      await recomputeOrderMasterSafe(admin, orderIds);
    },
  });
}
