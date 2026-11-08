// Las herramientas del conector de Kapta para agentes de IA (MOM §42,
// 08-11-2026). Cada una declara qué permiso del token necesita (`scope`), qué
// recibe (un esquema zod, que también se publica como JSON Schema en
// `tools/list`) y qué hace. Todas son de SOLO LECTURA en esta parte: ninguna
// escribe en la base, marca mensajes como leídos ni llama a un courier.
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
import { pickAgentStore } from "@/lib/agent-auth";
import { botLookupItems, botLookupPayment, normalizeBotOrderName } from "@/lib/bot-order-lookup";
import { macroStageLabel, macroSubstageLabel } from "@/lib/order-macro-stage";
import { orderTotals } from "@/lib/order-totals";
import { shopifyShippingAddress } from "@/lib/shopify-address";
import { normalizePhone } from "@/lib/phone";
import { PAYMENT_STATE_LABEL, type PaymentState } from "@/lib/pickup-key";
import { courierLabel } from "@/lib/couriers/registry";
import { ADELANTO_MINIMO, ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";
import { coberturaParaAgente } from "@/lib/voice-leads";
import type { ConversationMessage, KapsoClientOpts } from "@/lib/kapso";

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

const leerConversacion: AgentTool<typeof conversationInput> = {
  name: "leer_conversacion",
  title: "Leer la conversación de WhatsApp",
  description:
    "Lee los mensajes de WhatsApp (Kapso) entre la tienda y el cliente de un pedido o de un teléfono, del más antiguo al más reciente, con fecha y autor (cliente o tienda). No marca nada como leído ni envía mensajes.",
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
    const key = await deps.kapsoKey(store.id);
    if (!key) return fail("sin_kapso", `${store.name} no tiene Kapso configurado.`, { storeId: store.id, orderId });
    const opts: KapsoClientOpts = { apiKey: key };
    try {
      if (!conversationId && phone) conversationId = await deps.conversationByPhone(opts, phone);
      if (!conversationId) {
        return { ok: true, storeId: store.id, orderId, data: { tienda: store.name, telefono: phone, mensajes: [], nota: "No hay conversación de WhatsApp con este cliente." } };
      }
      const messages = await deps.transcript(opts, conversationId, 2);
      const mensajes = agentTranscript(messages, args.limite ?? 40);
      return {
        ok: true,
        storeId: store.id,
        orderId,
        data: {
          tienda: store.name,
          telefono: phone,
          mensajes,
          ...(mensajes.length ? {} : { nota: "La conversación no tiene mensajes." }),
        },
      };
    } catch {
      return fail("kapso_no_disponible", "No se pudo leer la conversación en Kapso ahora. Reintenta en unos segundos.", { storeId: store.id, orderId });
    }
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
  title: "Consultar políticas de entrega y pago",
  description:
    "Devuelve las condiciones de entrega y pago de una tienda que Kapta calcula: el adelanto mínimo para envíos por agencia y, si se indica el distrito, si ese destino tiene contraentrega o va por agencia. Solo lectura.",
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
    return {
      ok: true,
      storeId: store.id,
      data: { tienda: store.name, calculadas: agentCalculatedPolicies(coverage, place) },
    };
  },
};

// ---------------------------------------------------------------------------
// El catálogo
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: readonly AgentTool[] = [
  buscarPedidos as unknown as AgentTool,
  obtenerPedido as unknown as AgentTool,
  leerConversacion as unknown as AgentTool,
  consultarPoliticas as unknown as AgentTool,
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
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
}
