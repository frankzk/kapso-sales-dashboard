// Las herramientas del conector de Kapta para agentes de IA (MOM §42,
// 08-11-2026). Cada una declara qué permiso del token necesita (`scope`), qué
// recibe (un esquema zod, que también se publica como JSON Schema en
// `tools/list`) y qué hace. Las cinco de lectura no escriben en la base, no
// marcan mensajes como leídos ni llaman a un courier. Las tres de escritura
// (parte 3, MOM §42.9, 0323) —nota, WhatsApp y guía de Aliclik— hacen lo suyo
// por lib/agent-actions-flow.ts, con sus frenos; aquí solo buscan el pedido.
//
// LO QUE VALE PARA TODAS.
//   · Ven solo las tiendas del token (`ctx.stores`, lib/agent-auth.ts). Un
//     pedido de otra tienda contesta lo mismo que uno que no existe.
//   · Lo que no se sabe vuelve como null («desconocido»), nunca inventado.
//   · Las respuestas son datos para el agente, en español y con los nombres de
//     pantalla de Kapta (etapa, subetapa) junto al código.
//   · Ningún dato se escribe en el registro (`agent_tool_calls` guarda solo la
//     herramienta, la tienda, el pedido y el resultado).

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentContext, AgentScope, AgentStore } from "@/lib/agent-auth";
import { AGENT_SCOPES, pickAgentStore } from "@/lib/agent-auth";
import { botLookupItems, botLookupPayment, normalizeBotOrderName } from "@/lib/bot-order-lookup";
import { MACRO_SUBSTAGES_BY_STAGE, ORDER_MACRO_STAGES, macroStageLabel, macroSubstageLabel, type OrderMacroStage } from "@/lib/order-macro-stage";
import { CHATBY_HOLD_REASONS, type ChatbyHoldReason } from "@/lib/chatby-autoconfirm";
import { orderTotals } from "@/lib/order-totals";
import { shopifyShippingAddress } from "@/lib/shopify-address";
import { normalizePhone } from "@/lib/phone";
import { PAYMENT_STATE_LABEL, type PaymentState } from "@/lib/pickup-key";
import { courierLabel } from "@/lib/couriers/registry";
import { ADELANTO_MINIMO, ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";
import { coberturaParaAgente } from "@/lib/voice-leads";
import type { ConversationMessage, KapsoClientOpts } from "@/lib/kapso";
import type { ChatbyConversation, ChatbyMessage } from "@/lib/chatby-conversation";
import type { AgentActions, AgentOrderRef } from "@/lib/agent-actions-flow";
import { POLICIES_FOR_AGENT_MAX, agentWrittenPolicy, policiesInForce, type StorePolicyRow } from "@/lib/store-policies";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type AgentToolOutcome =
  | { ok: true; data: unknown; storeId?: string | null; orderId?: string | null }
  | { ok: false; code: string; message: string; storeId?: string | null; orderId?: string | null };

/** Lo que una herramienta usa de afuera; las pruebas lo reemplazan. */
export interface AgentToolDeps {
  admin: SupabaseClient;
  now: Date;
  /** La clave de Kapso de la tienda (`getStoreCreds`), o null si no tiene. */
  kapsoKey: (storeId: string) => Promise<string | null>;
  /** El historial de una conversación de Kapso (`fetchConversationTranscript`). */
  transcript: (opts: KapsoClientOpts, conversationId: string, maxPages: number) => Promise<ConversationMessage[]>;
  /** La conversación más reciente de un teléfono en Kapso (`findConversationIdByPhone`). */
  conversationByPhone: (opts: KapsoClientOpts, phone: string) => Promise<string | null>;
  /** La conversación con el bot de confirmación Chatby (`fetchChatbyConversation`). Sin ella, no se lee. */
  chatby?: (phone: string) => Promise<ChatbyConversation>;
  /** Las acciones de escritura (lib/agent-actions-server.ts). Sin ellas, las herramientas de escritura no responden. */
  actions?: AgentActions;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  scope: AgentScope;
  input: S;
  run: (ctx: AgentContext, args: z.infer<S>, deps: AgentToolDeps) => Promise<AgentToolOutcome>;
}

function fail(code: string, message: string, extra: { storeId?: string | null; orderId?: string | null } = {}): AgentToolOutcome {
  return { ok: false, code, message, ...extra };
}

// ---------------------------------------------------------------------------
// Ayudas puras
// ---------------------------------------------------------------------------

/**
 * Lo que se busca, sin lo que podría romper el filtro de PostgREST: solo
 * letras, dígitos, espacios y `# + - . @ _`. Las comas, paréntesis, asteriscos
 * y comillas se quitan porque en `or=(…)` separan o anidan condiciones. PURA.
 */
export function sanitizeAgentQuery(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} #+\-.@_]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#+/, "")
    .slice(0, 60);
}

/** Si lo buscado parece un teléfono, sus últimos 9 dígitos (como se guardan en Perú). PURA. */
export function phoneSearchFragment(query: string): string | null {
  const digits = query.replace(/\D+/g, "");
  if (digits.length < 6 || digits.length !== query.replace(/[\s+\-.]/g, "").length) return null;
  return digits.length > 9 ? digits.slice(-9) : digits;
}

function textOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t || null;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function paymentStateLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return PAYMENT_STATE_LABEL[code as PaymentState] ?? code;
}

/** El día de Lima (YYYY-MM-DD): a las 20:00 de Lima en UTC ya es mañana. PURA. */
export function limaDayOf(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function storeName(stores: readonly AgentStore[], id: string | null | undefined): string | null {
  return stores.find((s) => s.id === id)?.name ?? null;
}

// ---------------------------------------------------------------------------
// buscar_pedidos
// ---------------------------------------------------------------------------

const SEARCH_COLUMNS =
  "order_id,store_id,order_name,order_created_at,customer_name,customer_phone,district,order_total," +
  "general_status,macro_stage,macro_substage,current_courier,guide_code,last_movement_at";

interface SearchRow {
  order_id: string;
  store_id: string;
  order_name: string | null;
  order_created_at: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  district: string | null;
  order_total: number | string | null;
  general_status: string | null;
  macro_stage: string | null;
  macro_substage: string | null;
  current_courier: string | null;
  guide_code: string | null;
  last_movement_at: string | null;
}

/** Una fila de la búsqueda, como la ve el agente. PURA. */
export function agentSearchResult(row: SearchRow, stores: readonly AgentStore[]) {
  return {
    pedido: row.order_name,
    tienda: storeName(stores, row.store_id),
    fecha: row.order_created_at,
    cliente: textOrNull(row.customer_name),
    telefono: textOrNull(row.customer_phone),
    distrito: textOrNull(row.district),
    total: numOrNull(row.order_total),
    estado: row.general_status,
    etapa: row.macro_stage ? macroStageLabel(row.macro_stage) : null,
    subetapa: row.macro_substage ? macroSubstageLabel(row.macro_substage) : null,
    courier: row.current_courier ? courierLabel(row.current_courier) : null,
    guia: row.guide_code,
    ultimo_movimiento: row.last_movement_at,
  };
}

const searchInput = z.object({
  consulta: z.string().min(2).max(80).describe("Número de pedido (#KP123…, #AUR123…), teléfono, nombre del cliente o número de guía."),
  tienda: z.string().max(60).optional().describe("Nombre de la tienda (por ejemplo «Kenku» o «Aurela»). Sin ella se busca en todas las del token."),
  limite: z.number().int().min(1).max(20).optional().describe("Cuántos resultados como máximo (1 a 20; 10 si no se dice)."),
}).strict();

const buscarPedidos: AgentTool<typeof searchInput> = {
  name: "buscar_pedidos",
  title: "Buscar pedidos",
  description:
    "Busca pedidos de Kenku y Aurela por número (#KP…/#AUR…), teléfono, nombre del cliente o guía. Devuelve hasta 20, del más reciente al más antiguo, con su tienda, total, estado y etapa. Solo lectura.",
  scope: "pedidos.leer",
  input: searchInput,
  async run(ctx, args, deps) {
    let stores = ctx.stores;
    if (args.tienda) {
      const pick = pickAgentStore(ctx.stores, args.tienda);
      if (!pick.ok) return fail("tienda_desconocida", pick.message);
      stores = [pick.store];
    }
    const q = sanitizeAgentQuery(args.consulta);
    if (q.length < 2) return fail("consulta_invalida", "Escribe al menos 2 letras o números para buscar.");
    const limit = args.limite ?? 10;
    const storeIds = stores.map((s) => s.id);
    const phone = phoneSearchFragment(q);
    const like = `%${phone ?? q}%`;
    const conditions = phone
      ? `customer_phone.ilike.${like}`
      : `order_name.ilike.${like},guide_code.ilike.${like},customer_phone.ilike.${like},customer_name.ilike.${like}`;
    const [direct, byGuide] = await Promise.all([
      deps.admin
        .from("order_master")
        .select(SEARCH_COLUMNS)
        .in("store_id", storeIds)
        .or(conditions)
        .order("last_movement_at", { ascending: false, nullsFirst: false })
        .limit(limit),
      phone
        ? Promise.resolve({ data: [] as { order_id: string | null }[], error: null })
        : deps.admin
            .from("shipments")
            .select("order_id")
            .in("store_id", storeIds)
            .or(`guide_code.ilike.${like},swayp_guide.ilike.${like}`)
            .not("order_id", "is", null)
            .limit(limit),
    ]);
    if (direct.error) return fail("base_no_disponible", "No se pudo buscar ahora. Reintenta en unos segundos.");
    const found = (direct.data ?? []) as unknown as SearchRow[];
    const seen = new Set(found.map((r) => r.order_id));
    const extraIds = [...new Set(((byGuide.data ?? []) as { order_id: string | null }[]).map((r) => r.order_id).filter((id): id is string => !!id && !seen.has(id)))];
    if (extraIds.length) {
      const { data } = await deps.admin
        .from("order_master")
        .select(SEARCH_COLUMNS)
        .in("store_id", storeIds)
        .in("order_id", extraIds)
        .limit(limit);
      found.push(...(((data ?? []) as unknown as SearchRow[])));
    }
    const resultados = found.slice(0, limit).map((r) => agentSearchResult(r, ctx.stores));
    return {
      ok: true,
      storeId: stores.length === 1 ? stores[0]!.id : null,
      data: {
        resultados,
        cantidad: resultados.length,
        ...(resultados.length ? {} : { nota: "Ningún pedido coincide en las tiendas que ve este conector." }),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// listar_pedidos (MOM §42.10, 08-11-2026)
// ---------------------------------------------------------------------------
//
// El owner le pidió a Grok «dame el listado de 50 pedidos con confirmación
// expresa» de los 257 de Por confirmar, y `buscar_pedidos` solo busca por
// texto, de a 20. Esta herramienta lista una etapa entera, por páginas, con lo
// que la confirmación automática por Chatby (§6.1) ya leyó de cada pedido
// (`chatby_auto_checks`): sin leer Chatby otra vez.

export const LIST_PAGE_MAX = 50;
/** Con filtro de Chatby se mira la etapa entera en memoria: hasta este tope. */
export const LIST_SCAN_MAX = 1500;

const LIST_COLUMNS =
  "order_id,store_id,order_name,order_created_at,customer_name,customer_phone,district,province,region,order_total," +
  "macro_stage,macro_substage,macro_operation,guide_code,last_movement_at";

const OPERATION_LABEL: Record<string, string> = {
  lima: "Lima",
  provincia_cod: "Provincia contra entrega",
  agencia: "Agencia (con adelanto)",
  desconocida: "Por revisar",
};

export type AgentChatbyState = "confirmo_con_mensaje" | "pulso_confirmar" | "rechazo" | "sin_respuesta" | "no_leido";

export interface AgentChatbyCheck {
  outcome: string | null;
  reason: string | null;
  evidence: Record<string, unknown> | null;
  checked_at: string | null;
}

/** Motivos que guarda la pasada y no son de `evaluateChatbyConfirmation`. */
const EXTRA_HOLD_LABEL: Record<string, string> = {
  sin_ubicacion_cerrado: "Confirmó, pero no mandó su ubicación a tiempo y Kapta dejó de mirar el chat: la guía la decide una persona.",
};

function holdLabel(reason: string | null): string | null {
  if (!reason) return null;
  return CHATBY_HOLD_REASONS[reason as ChatbyHoldReason] ?? EXTRA_HOLD_LABEL[reason] ?? reason.replace(/_/g, " ");
}

/**
 * Lo que dijo Chatby de un pedido, según la última lectura de la confirmación
 * automática. «Confirmó con mensaje» es el mensaje completo de §6.1 (pedido,
 * monto, pago en casa y dirección); «pulsó Confirmar» es solo el botón, que no
 * confirma. PURA.
 */
export function agentChatbyState(check: AgentChatbyCheck | null) {
  if (!check) {
    return {
      estado: "no_leido" as AgentChatbyState,
      que_dijo: "Kapta no lee el Chatby de este pedido (Lima, Agencia o fuera de las 72 h de la confirmación automática). Para verlo, leer_conversacion.",
      motivo: null,
      pulso_confirmar: null,
      leido: null,
    };
  }
  const button = typeof check.evidence?.boton_confirmar_at === "string" ? (check.evidence.boton_confirmar_at as string) : null;
  const base = { motivo: null as string | null, pulso_confirmar: button, leido: check.checked_at };
  const rejected = check.reason === "rechazo" || check.reason === "anulado_en_chat";
  switch (check.outcome) {
    case "confirmado":
      return { ...base, estado: "confirmo_con_mensaje" as AgentChatbyState, que_dijo: "Mandó su mensaje de confirmación y Kapta lo confirmó solo." };
    case "para_asesora":
      return rejected
        ? { ...base, estado: "rechazo" as AgentChatbyState, motivo: check.reason, que_dijo: holdLabel(check.reason)! }
        : {
            ...base,
            estado: "confirmo_con_mensaje" as AgentChatbyState,
            motivo: check.reason,
            que_dijo: `Mandó su mensaje de confirmación, pero quedó para una persona: ${holdLabel(check.reason) ?? "sin motivo guardado"}`,
          };
    case "sin_confirmacion":
      return button
        ? {
            ...base,
            estado: "pulso_confirmar" as AgentChatbyState,
            que_dijo: "Pulsó «Confirmar pedido», pero no mandó su mensaje con el monto y la dirección: el botón solo no confirma. Una llamada corta lo cierra.",
          }
        : { ...base, estado: "sin_respuesta" as AgentChatbyState, que_dijo: "Todavía no mandó su confirmación por Chatby." };
    case "sin_conversacion":
      return { ...base, estado: "sin_respuesta" as AgentChatbyState, que_dijo: "No tiene conversación en Chatby." };
    default:
      return { ...base, estado: "no_leido" as AgentChatbyState, que_dijo: "La última lectura de Chatby falló; para verlo, leer_conversacion." };
  }
}

interface ListRow extends SearchRow {
  province: string | null;
  region: string | null;
  macro_operation: string | null;
}

/** Una fila de la lista, como la ve el agente. PURA. */
export function agentListResult(row: ListRow, check: AgentChatbyCheck | null, stores: readonly AgentStore[]) {
  const destino = [row.district, row.province, row.region].map(textOrNull).filter((v, i, all) => v && all.indexOf(v) === i).join(", ");
  return {
    pedido: row.order_name,
    tienda: storeName(stores, row.store_id),
    fecha: row.order_created_at,
    cliente: textOrNull(row.customer_name),
    telefono: textOrNull(row.customer_phone),
    destino: destino || null,
    total: numOrNull(row.order_total),
    etapa: row.macro_stage ? macroStageLabel(row.macro_stage) : null,
    subetapa: row.macro_substage ? macroSubstageLabel(row.macro_substage) : null,
    cobertura: row.macro_operation ? OPERATION_LABEL[row.macro_operation] ?? row.macro_operation : null,
    guia: row.guide_code,
    ultimo_movimiento: row.last_movement_at,
    chatby: agentChatbyState(check),
  };
}

const STAGE_CODES = ORDER_MACRO_STAGES.map((st) => st.code) as [OrderMacroStage, ...OrderMacroStage[]];

const listInput = z.object({
  etapa: z.enum(STAGE_CODES).describe(`Etapa del Master: ${ORDER_MACRO_STAGES.map((st) => `${st.code} («${st.label}»)`).join(", ")}.`),
  subetapa: z.string().max(40).optional().describe("Código de la subetapa (por ejemplo «sin_llamar» o «por_confirmar»). Sin ella, todas las de la etapa."),
  cobertura: z.enum(["lima", "provincia_cod", "agencia"]).optional().describe("Lima, Provincia contra entrega o Agencia (con adelanto)."),
  tienda: z.string().max(60).optional().describe("Nombre de la tienda. Sin ella, todas las del token."),
  chatby: z
    .enum(["confirmo_con_mensaje", "pulso_confirmar", "rechazo", "sin_respuesta", "no_leido"])
    .optional()
    .describe(
      "Lo que dijo la clienta en Chatby: «confirmo_con_mensaje» (su mensaje con pedido, monto, pago en casa y dirección), «pulso_confirmar» " +
        "(solo el botón, que no confirma), «rechazo», «sin_respuesta» o «no_leido» (Kapta no lee su Chatby).",
    ),
  pagina: z.number().int().min(1).max(100).optional().describe("Página (1 si no se dice)."),
  por_pagina: z.number().int().min(1).max(LIST_PAGE_MAX).optional().describe(`Pedidos por página (1 a ${LIST_PAGE_MAX}; 25 si no se dice).`),
}).strict();

/** Los registros de la confirmación automática de esos pedidos, de a 150 por consulta. */
async function chatbyChecksFor(deps: AgentToolDeps, orderIds: readonly string[]): Promise<Map<string, AgentChatbyCheck> | null> {
  const out = new Map<string, AgentChatbyCheck>();
  for (let i = 0; i < orderIds.length; i += 150) {
    const { data, error } = await deps.admin
      .from("chatby_auto_checks")
      .select("order_id,outcome,reason,evidence,checked_at")
      .in("order_id", orderIds.slice(i, i + 150));
    if (error) return null;
    for (const r of (data ?? []) as (AgentChatbyCheck & { order_id: string })[]) out.set(r.order_id, r);
  }
  return out;
}

const listarPedidos: AgentTool<typeof listInput> = {
  name: "listar_pedidos",
  title: "Listar los pedidos de una etapa",
  description:
    "Lista los pedidos de una etapa del Master (por ejemplo «por_confirmar»), por páginas de hasta 50, con el total, del más reciente al más antiguo. " +
    "Filtra por subetapa, cobertura, tienda y por lo que dijo la clienta en Chatby según la última lectura de la confirmación automática " +
    "(«confirmo_con_mensaje», «pulso_confirmar», «rechazo», «sin_respuesta», «no_leido»). Cada pedido trae lo que dijo en Chatby y, si quedó " +
    "para una persona, el motivo. Para leer la conversación completa de uno, leer_conversacion. Solo lectura.",
  scope: "pedidos.leer",
  input: listInput,
  async run(ctx, args, deps) {
    let stores = ctx.stores;
    if (args.tienda) {
      const pick = pickAgentStore(ctx.stores, args.tienda);
      if (!pick.ok) return fail("tienda_desconocida", pick.message);
      stores = [pick.store];
    }
    const valid = MACRO_SUBSTAGES_BY_STAGE[args.etapa] as readonly string[];
    if (args.subetapa && !valid.includes(args.subetapa)) {
      return fail("subetapa_invalida", `«${args.subetapa}» no es una subetapa de ${macroStageLabel(args.etapa)}. Son: ${valid.join(", ")}.`);
    }
    const page = args.pagina ?? 1;
    const size = args.por_pagina ?? 25;
    const from = (page - 1) * size;
    const query = (select: string, count: boolean) => {
      let q = deps.admin
        .from("order_master")
        .select(select, count ? { count: "exact" } : undefined)
        .in("store_id", stores.map((st) => st.id))
        .eq("macro_stage", args.etapa);
      if (args.subetapa) q = q.eq("macro_substage", args.subetapa);
      if (args.cobertura) q = q.eq("macro_operation", args.cobertura);
      return q.order("order_created_at", { ascending: false, nullsFirst: false }).order("order_id", { ascending: true });
    };
    const storeId = stores.length === 1 ? stores[0]!.id : null;
    const unavailable = fail("base_no_disponible", "No se pudo leer la lista ahora. Reintenta en unos segundos.", { storeId });

    let rows: ListRow[];
    let total: number;
    let checks: Map<string, AgentChatbyCheck> | null;
    if (!args.chatby) {
      const { data, error, count } = await query(LIST_COLUMNS, true).range(from, from + size - 1);
      if (error) return unavailable;
      rows = (data ?? []) as unknown as ListRow[];
      total = count ?? rows.length;
      checks = await chatbyChecksFor(deps, rows.map((r) => r.order_id));
      if (!checks) return unavailable;
    } else {
      // Lo de Chatby está en otra tabla: se mira la etapa entera y se filtra aquí.
      const { data, error } = await query(LIST_COLUMNS, false).limit(LIST_SCAN_MAX + 1);
      if (error) return unavailable;
      const all = (data ?? []) as unknown as ListRow[];
      if (all.length > LIST_SCAN_MAX) {
        return fail("lista_muy_grande", `Hay más de ${LIST_SCAN_MAX} pedidos en ${macroStageLabel(args.etapa)}: acota con subetapa, cobertura o tienda para filtrar por Chatby.`, { storeId });
      }
      checks = await chatbyChecksFor(deps, all.map((r) => r.order_id));
      if (!checks) return unavailable;
      const matching = all.filter((r) => agentChatbyState(checks!.get(r.order_id) ?? null).estado === args.chatby);
      total = matching.length;
      rows = matching.slice(from, from + size);
    }
    const pedidos = rows.map((r) => agentListResult(r, checks!.get(r.order_id) ?? null, ctx.stores));
    return {
      ok: true,
      storeId,
      data: {
        total,
        pagina: page,
        por_pagina: size,
        paginas: Math.max(1, Math.ceil(total / size)),
        pedidos,
        ...(pedidos.length ? {} : { nota: total ? "Esa página está vacía: hay menos páginas." : "Ningún pedido cumple esos filtros en las tiendas que ve este conector." }),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// obtener_pedido
// ---------------------------------------------------------------------------

const MASTER_COLUMNS =
  "order_id,store_id,order_name,order_created_at,customer_name,customer_phone,region,province,district,address," +
  "coverage,shipping_mode,order_total,general_status,macro_stage,macro_substage,macro_reasons,macro_since," +
  "payment_state,current_courier,guide_code,dispatched_at,delivered_at,delivered_courier,returned_at,last_movement_at";
const ORDER_COLUMNS =
  "id,name,platform,created_at,total_amount,currency,financial_status,payment_gateway,total_refunded,cancelled_at," +
  "customer_phone,shipping_mode,line_items,raw";
const GUIDE_COLUMNS = "courier,guide_code,output_code,delivery_status,created_at,dispatched_at,closed_at,returned_at";
const EVENT_COLUMNS = "kind,occurred_at,source,courier,new_status,reason,note";

export interface AgentOrderSources {
  master: Record<string, unknown>;
  order: Record<string, unknown> | null;
  guides: Record<string, unknown>[];
  events: Record<string, unknown>[];
  stores: readonly AgentStore[];
}

/** El pedido completo, como lo ve el agente. PURA. */
export function agentOrderDetail({ master, order, guides, events, stores }: AgentOrderSources) {
  const raw = order?.raw ?? null;
  const ship = shopifyShippingAddress(raw);
  const totals = orderTotals(raw, numOrNull(order?.total_amount ?? master.order_total));
  const reasons = Array.isArray(master.macro_reasons) ? (master.macro_reasons as string[]) : [];
  return {
    pedido: master.order_name ?? order?.name ?? null,
    tienda: storeName(stores, master.store_id as string),
    plataforma: order?.platform ?? null,
    fecha: master.order_created_at ?? order?.created_at ?? null,
    anulado: Boolean(order?.cancelled_at) || master.general_status === "anulado",
    cliente: {
      nombre: textOrNull(master.customer_name),
      telefono: textOrNull(master.customer_phone) ?? textOrNull(order?.customer_phone),
    },
    productos: botLookupItems(order?.line_items).map((i) => ({ producto: i.title, variante: i.variant, cantidad: i.quantity })),
    importes: {
      moneda: order?.currency ?? null,
      subtotal: totals.subtotal,
      descuento: totals.discounts,
      envio: totals.shipping,
      total: totals.total,
    },
    pago: {
      forma: order
        ? botLookupPayment({
            financialStatus: order.financial_status as string | null,
            paymentGateway: order.payment_gateway as string | null,
            totalRefunded: numOrNull(order.total_refunded),
            paymentState: (master.payment_state as string | null) ?? null,
          })
        : null,
      estado: paymentStateLabel(master.payment_state as string | null),
    },
    entrega: {
      modalidad: master.shipping_mode ?? order?.shipping_mode ?? null,
      cobertura: master.coverage ?? null,
      departamento: textOrNull(master.region),
      provincia: textOrNull(master.province),
      distrito: textOrNull(master.district) ?? textOrNull(ship?.city),
      direccion: textOrNull(master.address) ?? textOrNull(ship?.address1),
      referencia: textOrNull(ship?.address2),
    },
    estado: {
      general: master.general_status ?? null,
      etapa: master.macro_stage ? macroStageLabel(master.macro_stage as string) : null,
      subetapa: master.macro_substage ? macroSubstageLabel(master.macro_substage as string) : null,
      motivos: reasons.map((r) => macroSubstageLabel(r)),
      desde: master.macro_since ?? null,
      courier_actual: master.current_courier ? courierLabel(master.current_courier as string) : null,
      despachado: master.dispatched_at ?? null,
      entregado: master.delivered_at ?? null,
      entregado_por: master.delivered_courier ? courierLabel(master.delivered_courier as string) : null,
      devuelto: master.returned_at ?? null,
      ultimo_movimiento: master.last_movement_at ?? null,
    },
    guias: guides.map((g) => ({
      courier: g.courier ? courierLabel(g.courier as string) : null,
      guia: g.guide_code ?? null,
      salida: g.output_code ?? null,
      estado: g.delivery_status ?? null,
      creada: g.created_at ?? null,
      despachada: g.dispatched_at ?? null,
      cerrada: g.closed_at ?? null,
      devuelta: g.returned_at ?? null,
    })),
    movimientos_recientes: events.map((e) => ({
      fecha: e.occurred_at ?? null,
      tipo: e.kind ?? null,
      origen: e.source ?? null,
      courier: e.courier ? courierLabel(e.courier as string) : null,
      nuevo_estado: e.new_status ?? null,
      detalle: textOrNull(e.reason) ?? textOrNull(e.note),
    })),
  };
}

const orderInput = z.object({
  pedido: z.string().min(2).max(40).describe("Número de pedido, con o sin «#» (por ejemplo «#KP140122» o «AUR176161»)."),
}).strict();

/** El pedido por su número, en las tiendas del token. */
async function findMasterRow(ctx: AgentContext, deps: AgentToolDeps, rawName: string, columns: string) {
  const name = normalizeBotOrderName(rawName);
  if (!name) return { error: fail("pedido_invalido", "Eso no parece un número de pedido (por ejemplo «#KP140122»).") };
  const { data, error } = await deps.admin
    .from("order_master")
    .select(columns)
    .in("store_id", ctx.stores.map((s) => s.id))
    .eq("order_name", name)
    .limit(2);
  if (error) return { error: fail("base_no_disponible", "No se pudo leer el pedido ahora. Reintenta en unos segundos.") };
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  if (!rows.length) return { error: fail("no_encontrado", `No encontré el pedido ${name} en las tiendas que ve este conector.`) };
  if (rows.length > 1) return { error: fail("ambiguo", `Hay más de un pedido ${name}; indica la tienda.`) };
  return { row: rows[0]! };
}

const obtenerPedido: AgentTool<typeof orderInput> = {
  name: "obtener_pedido",
  title: "Ver un pedido",
  description:
    "Devuelve el detalle de un pedido: productos y cantidades, importes y moneda, forma y estado de pago, datos de entrega, estado en el Master (etapa y subetapa), guías de courier y los últimos movimientos. Solo lectura.",
  scope: "pedidos.leer",
  input: orderInput,
  async run(ctx, args, deps) {
    const found = await findMasterRow(ctx, deps, args.pedido, MASTER_COLUMNS);
    if ("error" in found) return found.error!;
    const master = found.row;
    const orderId = master.order_id as string;
    const [order, guides, events] = await Promise.all([
      deps.admin.from("orders").select(ORDER_COLUMNS).eq("id", orderId).maybeSingle(),
      deps.admin.from("shipments").select(GUIDE_COLUMNS).eq("order_id", orderId).order("created_at", { ascending: true }).limit(20),
      deps.admin.from("order_events").select(EVENT_COLUMNS).eq("order_id", orderId).order("occurred_at", { ascending: false }).limit(10),
    ]);
    if (order.error || guides.error || events.error) {
      return fail("base_no_disponible", "No se pudo leer el pedido completo ahora. Reintenta en unos segundos.", { storeId: master.store_id as string, orderId });
    }
    return {
      ok: true,
      storeId: master.store_id as string,
      orderId,
      data: agentOrderDetail({
        master,
        order: (order.data ?? null) as Record<string, unknown> | null,
        guides: (guides.data ?? []) as Record<string, unknown>[],
        events: (events.data ?? []) as Record<string, unknown>[],
        stores: ctx.stores,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// leer_conversacion
// ---------------------------------------------------------------------------

/** Los mensajes, como los ve el agente: los últimos `limit`, en orden. Sin enlaces a archivos. PURA. */
export function agentTranscript(messages: readonly ConversationMessage[], limit: number) {
  return [...messages]
    .sort((a, b) => a.t - b.t)
    .slice(-limit)
    .map((m) => ({
      fecha: new Date(m.t).toISOString(),
      autor: m.dir === "inbound" ? "cliente" : "tienda",
      texto: m.text || null,
      ...(m.mediaKind ? { adjunto: m.mediaKind } : {}),
      ...(m.templateName ? { plantilla: m.templateName } : {}),
    }));
}

const conversationInput = z.object({
  pedido: z.string().max(40).optional().describe("Número de pedido; se lee la conversación de su cliente."),
  telefono: z.string().max(40).optional().describe("Teléfono del cliente, si no hay pedido."),
  tienda: z.string().max(60).optional().describe("Tienda, si se busca por teléfono y el token ve más de una."),
  limite: z.number().int().min(1).max(100).optional().describe("Cuántos mensajes, los más recientes (1 a 100; 40 si no se dice)."),
}).strict();

const CHATBY_AUTHOR: Record<ChatbyMessage["kind"], string> = {
  cliente: "cliente",
  bot: "bot",
  equipo: "equipo",
  nota: "nota_interna",
  otro: "otro",
};

/** Los mensajes de Chatby, como los ve el agente: en orden, sin enlaces a archivos ni coordenadas. PURA. */
export function agentChatbyTranscript(messages: readonly ChatbyMessage[]) {
  return [...messages]
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
    .map((m) => ({
      fecha: m.at,
      autor: CHATBY_AUTHOR[m.kind] ?? "otro",
      texto: m.text || null,
      ...(m.media ? { adjunto: m.media } : {}),
      ...(m.template ? { plantilla: m.template } : {}),
      ...(m.button ? { boton: true } : {}),
      ...(m.error ? { no_entregado: true } : {}),
      // Que mandó su ubicación, sin la coordenada: la guía la usa desde Kapta.
      ...(m.location ? { ubicacion_enviada: true } : {}),
    }));
}

/** La parte de Chatby de la respuesta, o por qué no está. */
async function chatbyPart(deps: AgentToolDeps, phone: string | null): Promise<{ ok: boolean; part: Record<string, unknown> }> {
  if (!deps.chatby) return { ok: false, part: { nota: "Chatby no está disponible en este conector." } };
  if (!phone) return { ok: false, part: { nota: "Sin celular para buscar en Chatby." } };
  try {
    const c = await deps.chatby(phone);
    if (c.status === "ok") {
      const mensajes = agentChatbyTranscript(c.messages);
      return { ok: true, part: { mensajes, ...(mensajes.length ? {} : { nota: "La conversación de Chatby no tiene mensajes." }) } };
    }
    if (c.status === "sin_conversacion") return { ok: true, part: { mensajes: [], nota: "Esta clienta no tiene conversación en Chatby." } };
    if (c.status === "sin_clave") return { ok: false, part: { nota: "Kapta no tiene la clave de Chatby." } };
    if (c.status === "sin_celular") return { ok: false, part: { nota: "Sin celular para buscar en Chatby." } };
    return { ok: false, part: { nota: "No se pudo leer Chatby ahora." } };
  } catch {
    return { ok: false, part: { nota: "No se pudo leer Chatby ahora." } };
  }
}

const leerConversacion: AgentTool<typeof conversationInput> = {
  name: "leer_conversacion",
  title: "Leer la conversación de WhatsApp",
  description:
    "Lee los mensajes de WhatsApp entre la tienda y el cliente de un pedido o de un teléfono, del más antiguo al más reciente, con fecha y autor. " +
    "`mensajes` son los de Kapso (bot de pedidos y asesoras); `chatby` son los del bot de confirmación Chatby (los últimos 20), donde muchas clientas " +
    "confirman su pedido. Mira los dos antes de decir si un pedido está confirmado. No marca nada como leído ni envía mensajes.",
  scope: "conversaciones.leer",
  input: conversationInput,
  async run(ctx, args, deps) {
    if (!args.pedido && !args.telefono) return fail("faltan_datos", "Indica el pedido o el teléfono.");
    let store: AgentStore;
    let phone: string | null;
    let conversationId: string | null = null;
    let orderId: string | null = null;
    if (args.pedido) {
      const found = await findMasterRow(ctx, deps, args.pedido, "order_id,store_id,customer_phone");
      if ("error" in found) return found.error!;
      store = ctx.stores.find((s) => s.id === found.row.store_id)!;
      orderId = found.row.order_id as string;
      const { data: order } = await deps.admin.from("orders").select("kapso_conversation_id,customer_phone").eq("id", orderId).maybeSingle();
      conversationId = textOrNull((order as { kapso_conversation_id?: string } | null)?.kapso_conversation_id);
      phone = normalizePhone((found.row.customer_phone as string | null) ?? (order as { customer_phone?: string } | null)?.customer_phone ?? null);
    } else {
      const pick = pickAgentStore(ctx.stores, args.tienda);
      if (!pick.ok) return fail("tienda_desconocida", pick.message);
      store = pick.store;
      phone = normalizePhone(args.telefono);
      if (!phone || !/^[0-9]{8,15}$/.test(phone)) return fail("telefono_invalido", "Ese teléfono no es válido.");
      const { data: lead } = await deps.admin
        .from("leads")
        .select("kapso_conversation_id")
        .eq("store_id", store.id)
        .eq("phone", phone)
        .maybeSingle();
      conversationId = textOrNull((lead as { kapso_conversation_id?: string } | null)?.kapso_conversation_id);
    }
    const chatbyRead = chatbyPart(deps, phone);

    // Kapso: los mensajes, o por qué no hay. Si Kapso falla y Chatby tampoco
    // contesta, es un error; si Chatby contesta, se devuelve lo de Chatby.
    let kapso: { ok: true; mensajes: ReturnType<typeof agentTranscript>; nota?: string } | { ok: false; code: string; message: string };
    const key = await deps.kapsoKey(store.id);
    if (!key) {
      kapso = { ok: false, code: "sin_kapso", message: `${store.name} no tiene Kapso configurado.` };
    } else {
      const opts: KapsoClientOpts = { apiKey: key };
      try {
        if (!conversationId && phone) conversationId = await deps.conversationByPhone(opts, phone);
        if (!conversationId) {
          kapso = { ok: true, mensajes: [], nota: "No hay conversación de WhatsApp en Kapso con este cliente." };
        } else {
          const mensajes = agentTranscript(await deps.transcript(opts, conversationId, 2), args.limite ?? 40);
          kapso = { ok: true, mensajes, ...(mensajes.length ? {} : { nota: "La conversación no tiene mensajes." }) };
        }
      } catch {
        kapso = { ok: false, code: "kapso_no_disponible", message: "No se pudo leer la conversación en Kapso ahora. Reintenta en unos segundos." };
      }
    }
    const chatby = await chatbyRead;
    if (!kapso.ok && !chatby.ok) return fail(kapso.code, kapso.message, { storeId: store.id, orderId });
    return {
      ok: true,
      storeId: store.id,
      orderId,
      data: {
        tienda: store.name,
        telefono: phone,
        mensajes: kapso.ok ? kapso.mensajes : [],
        ...(kapso.ok ? (kapso.nota ? { nota: kapso.nota } : {}) : { nota: kapso.message }),
        chatby: chatby.part,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// consultar_politicas
// ---------------------------------------------------------------------------

const policiesInput = z.object({
  tienda: z.string().max(60).optional().describe("Tienda (por ejemplo «Kenku» o «Aurela»)."),
  distrito: z.string().max(80).optional().describe("Distrito del cliente, para saber si hay contraentrega o va por agencia."),
  provincia: z.string().max(80).optional(),
  departamento: z.string().max(80).optional(),
}).strict();

/** Las reglas que Kapta calcula, para una tienda y (si se dice) un destino. PURA salvo por la cobertura que recibe. */
export function agentCalculatedPolicies(coverageKind: string | null | undefined, place: { distrito?: string; provincia?: string; departamento?: string } | null) {
  return {
    adelanto_minimo: { monto: ADELANTO_MINIMO, moneda: "PEN", texto: `Envíos por agencia: adelanto mínimo de ${ADELANTO_MINIMO_LABEL}; el saldo se paga antes de recoger.` },
    ...(place
      ? { destino: { ...place, ...coberturaParaAgente(coverageKind ?? null) } }
      : {}),
    fuente: "Calculado por Kapta: adelanto mínimo (lib/adelanto-minimo.ts) y cobertura por distrito (order_coverage_for).",
  };
}

const consultarPoliticas: AgentTool<typeof policiesInput> = {
  name: "consultar_politicas",
  title: "Consultar políticas de la tienda",
  description:
    "Devuelve las políticas de una tienda en dos partes. «calculadas»: lo que Kapta calcula, el adelanto mínimo para envíos por agencia y, si se indica el distrito, si ese destino tiene contraentrega o va por agencia. «escritas»: las que la tienda escribió (cambios, devoluciones, garantías…), solo las vigentes hoy, con su fecha. Si ninguna cubre lo que se pregunta, no la inventes. Solo lectura.",
  scope: "politicas.leer",
  input: policiesInput,
  async run(ctx, args, deps) {
    const pick = pickAgentStore(ctx.stores, args.tienda);
    if (!pick.ok) return fail("tienda_desconocida", pick.message);
    const store = pick.store;
    const place = args.distrito
      ? { distrito: args.distrito, ...(args.provincia ? { provincia: args.provincia } : {}), ...(args.departamento ? { departamento: args.departamento } : {}) }
      : null;
    let coverage: string | null = null;
    if (place) {
      const { data, error } = await deps.admin.rpc("order_coverage_for", {
        p_store_id: store.id,
        p_region: args.departamento ?? null,
        p_province: args.provincia ?? null,
        p_district: args.distrito,
        p_day: limaDayOf(deps.now),
      });
      // Sin respuesta, «por revisar»: no se afirma una cobertura que no se pudo calcular.
      coverage = !error && typeof data === "string" ? data : null;
    }
    const today = limaDayOf(deps.now);
    const written = await deps.admin
      .from("store_policies")
      .select("id,store_id,title,body,valid_from,valid_until,source,version,updated_at,retired_at")
      .eq("store_id", store.id)
      .is("retired_at", null)
      .lte("valid_from", today)
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .order("title", { ascending: true })
      .limit(POLICIES_FOR_AGENT_MAX);
    // Sin la 0315 o con la base caída, las calculadas igual; las escritas en null
    // («no se pudieron leer»), que no es lo mismo que «la tienda no escribió ninguna».
    const escritas = written.error
      ? null
      : policiesInForce((written.data ?? []) as StorePolicyRow[], today).map(agentWrittenPolicy);
    return {
      ok: true,
      storeId: store.id,
      data: {
        tienda: store.name,
        dia: today,
        calculadas: agentCalculatedPolicies(coverage, place),
        escritas,
        ...(escritas === null
          ? { nota: "No se pudieron leer las políticas escritas de la tienda ahora. No las supongas." }
          : escritas.length
            ? {}
            : { nota: "La tienda no tiene políticas escritas vigentes. Para lo que no cubren las calculadas, no inventes una." }),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Las de escritura (MOM §42.9, parte 3; 0323)
// ---------------------------------------------------------------------------

const origenField = z
  .enum(["chat", "rutina"])
  .describe(
    "«chat»: quien conversa contigo te lo pidió y aprobó lo que vas a hacer en esta conversación. «rutina»: lo decides tú por tu cuenta. " +
      "Di la verdad: en Simulación lo de «rutina» solo se registra, y todo queda en el registro que revisa el dueño.",
  );
const codigoField = z.string().max(60).describe("El código de confirmación que devolvió la vista previa. Con él se hace la acción; sin él, solo se pide la vista previa.");

const ACTIONS_UNAVAILABLE = fail("no_disponible", "Las acciones del agente no están disponibles en este conector.");

/** El pedido para una acción: el mismo que ve `obtener_pedido`, en las tiendas del token. */
async function actionOrder(ctx: AgentContext, deps: AgentToolDeps, raw: string): Promise<{ order?: AgentOrderRef; error?: AgentToolOutcome }> {
  const found = await findMasterRow(ctx, deps, raw, "order_id,store_id,order_name,customer_phone");
  if ("error" in found) return { error: found.error! };
  const store = ctx.stores.find((s) => s.id === found.row.store_id)!;
  return {
    order: {
      orderId: found.row.order_id as string,
      storeId: store.id,
      storeName: store.name,
      orderName: (found.row.order_name as string | null) ?? normalizeBotOrderName(raw) ?? raw,
      customerPhone: (found.row.customer_phone as string | null) ?? null,
    },
  };
}

const noteInput = z.object({
  pedido: orderInput.shape.pedido,
  texto: z.string().min(3).max(1000).describe("La nota, en español, para el equipo. Hechos y lo que falta hacer; sin datos que no estén en Kapta."),
  origen: origenField,
}).strict();

const agregarNota: AgentTool<typeof noteInput> = {
  name: "agregar_nota",
  title: "Dejar una nota en el pedido",
  description:
    "Deja una nota en la Actividad del pedido, marcada como «Agente de IA», para que el equipo la lea. Se hace al momento (no tiene vista previa). " +
    "No cambia el estado del pedido ni avisa a la clienta. La misma nota dos veces en el mismo pedido no se repite.",
  scope: "pedidos.nota",
  input: noteInput,
  async run(ctx, args, deps) {
    if (!deps.actions) return ACTIONS_UNAVAILABLE;
    const { order, error } = await actionOrder(ctx, deps, args.pedido);
    if (!order) return error!;
    return deps.actions.note(ctx, order, { text: args.texto, origin: args.origen });
  },
};

const whatsappInput = z.object({
  pedido: orderInput.shape.pedido,
  texto: z.string().max(1000).optional().describe("El mensaje para la clienta (solo en la vista previa)."),
  origen: origenField.optional(),
  codigo: codigoField.optional(),
}).strict();

const enviarWhatsapp: AgentTool<typeof whatsappInput> = {
  name: "enviar_whatsapp",
  title: "Enviar un WhatsApp a la clienta",
  description:
    "Le escribe a la clienta del pedido por WhatsApp (Kapso), en DOS pasos. 1) Con `texto` y `origen`: vista previa, no envía nada y devuelve un " +
    "`codigo_confirmacion` de 10 minutos. 2) Con el mismo `pedido` y `codigo`: lo envía (o, en Simulación y con origen «rutina», lo registra sin enviarlo). " +
    "Con origen «chat», enséñale la vista previa a quien te lo pidió y confirma solo si la aprueba. Solo dentro de las 24 h desde el último mensaje de la clienta; " +
    "un mensaje por pedido cada 4 horas, nunca el mismo texto dos veces y con un tope diario. No sirve para cambiar estados ni anular guías.",
  scope: "whatsapp.enviar",
  input: whatsappInput,
  async run(ctx, args, deps) {
    if (!deps.actions) return ACTIONS_UNAVAILABLE;
    const { order, error } = await actionOrder(ctx, deps, args.pedido);
    if (!order) return error!;
    if (args.codigo) return deps.actions.confirm(ctx, order, "whatsapp", args.codigo);
    if (!args.texto || !args.origen) return fail("faltan_datos", "Para la vista previa indica `texto` y `origen`; para enviarlo, el `codigo` de la vista previa.", { storeId: order.storeId, orderId: order.orderId });
    return deps.actions.previewWhatsapp(ctx, order, { text: args.texto, origin: args.origen });
  },
};

const guideInput = z.object({
  pedido: orderInput.shape.pedido,
  origen: origenField.optional(),
  codigo: codigoField.optional(),
}).strict();

const crearGuiaAliclik: AgentTool<typeof guideInput> = {
  name: "crear_guia_aliclik",
  title: "Crear la guía de Aliclik",
  description:
    "Crea la guía contra entrega de Aliclik del pedido, en DOS pasos y por el mismo camino que el botón de Kapta (las mismas compuertas: pago, " +
    "rechazos, duplicados, riesgo, salidas). 1) Con `origen`: cotiza y devuelve courier, costo, lo que se cobra en la puerta y un `codigo_confirmacion` " +
    "de 10 minutos; no crea nada. 2) Con el mismo `pedido` y `codigo`: la crea (o, en Simulación y con origen «rutina», la registra sin crearla). " +
    "Con origen «chat», enséñale la vista previa a quien te lo pidió y confirma solo si la aprueba. Una guía por pedido y un tope diario. " +
    "No anula guías ni cambia estados. Si dice «incierto», no la vuelvas a pedir.",
  scope: "aliclik.crear_guia",
  input: guideInput,
  async run(ctx, args, deps) {
    if (!deps.actions) return ACTIONS_UNAVAILABLE;
    const { order, error } = await actionOrder(ctx, deps, args.pedido);
    if (!order) return error!;
    if (args.codigo) return deps.actions.confirm(ctx, order, "guia_aliclik", args.codigo);
    if (!args.origen) return fail("faltan_datos", "Para la vista previa indica `origen`; para crearla, el `codigo` de la vista previa.", { storeId: order.storeId, orderId: order.orderId });
    return deps.actions.previewGuide(ctx, order, { origin: args.origen });
  },
};

// ---------------------------------------------------------------------------
// El catálogo
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: readonly AgentTool[] = [
  buscarPedidos as unknown as AgentTool,
  listarPedidos as unknown as AgentTool,
  obtenerPedido as unknown as AgentTool,
  leerConversacion as unknown as AgentTool,
  consultarPoliticas as unknown as AgentTool,
  agregarNota as unknown as AgentTool,
  enviarWhatsapp as unknown as AgentTool,
  crearGuiaAliclik as unknown as AgentTool,
];

/** Las herramientas que el token puede usar, en el orden del catálogo. PURA. */
export function agentToolsFor(scopes: ReadonlySet<AgentScope>): AgentTool[] {
  return AGENT_TOOLS.filter((t) => scopes.has(t.scope));
}

/** La herramienta como la publica `tools/list` (MCP). PURA. */
export function agentToolDescriptor(tool: AgentTool) {
  const schema = z.toJSONSchema(tool.input) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: schema,
    // Las de escritura lo dicen: el cliente MCP puede pedir confirmación. Ninguna
    // borra nada; WhatsApp y Aliclik salen de Kapta (`openWorldHint`).
    annotations: AGENT_SCOPES[tool.scope].write
      ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: tool.scope !== "pedidos.nota" }
      : { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
}
