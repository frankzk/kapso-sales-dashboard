// Cómo se hacen las acciones del agente de IA (MOM §42.9, parte 3; 0323): la
// nota, la vista previa y la confirmación del WhatsApp y de la guía de
// Aliclik, con todos los frenos. Las reglas puras viven en lib/agent-actions.ts;
// la red y Aliclik entran por `AgentActionsExternal`, que en producción arma
// lib/agent-actions-server.ts y en las pruebas, un doble.
//
// EL ORDEN DE CADA ACCIÓN.
//   1. Permiso de quien conectó el agente, en la organización del token (el
//      mismo que necesita esa persona en la pantalla): notas y WhatsApp,
//      «Gestionar pedidos»; la guía, «Crear guías de Aliclik».
//   2. El interruptor de la organización (Apagado no deja ni pedir la vista
//      previa) y los frenos: tope del día de Lima, una vez y no más.
//   3. WhatsApp: la ventana de 24 h, leída en Kapso. Guía: las compuertas de
//      Kapta y la cotización, por el mismo camino que el botón.
//   4. La vista previa queda en `agent_actions` con un código de un solo uso.
//   5. Al confirmar se toma la fila (prevista → en curso, una sola vez), se
//      vuelve a comprobar TODO y se hace, se simula o se rechaza.
//
// Lo que no se sabe no autoriza: un permiso, un tope o una ventana que no se
// pudo leer frenan la acción.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentContext } from "@/lib/agent-auth";
import type { AgentToolOutcome } from "@/lib/agent-tools";
import { PERMISSION_LABEL, type Permission } from "@/lib/permissions";
import { normalizePhone } from "@/lib/phone";
import type { KapsoClientOpts, KapsoConversation, WhatsappSendResult } from "@/lib/kapso";
import {
  AGENT_ACTIONS_MIGRATION_MISSING,
  AGENT_CODE_TTL_MS,
  AGENT_COMMENT_TYPE,
  AGENT_COUNTED_STATUSES,
  AGENT_EVENT_SOURCE,
  AGENT_MODE_LABEL,
  AGENT_NOTE_MAX,
  AGENT_NOTE_MIN,
  AGENT_WHATSAPP_EVENT,
  AGENT_WHATSAPP_MAX,
  agentExecution,
  agentExecutionNote,
  agentGuideReason,
  cleanAgentText,
  dailyCapBlock,
  guideOrderBlock,
  isAgentActionsMigrationMissing,
  limaDayStartIso,
  maskPhone,
  parseAgentSettings,
  whatsappOrderBlock,
  whatsappWindow,
  type AgentActionKind,
  type AgentActionSettings,
  type AgentActionStatus,
  type AgentOrigin,
  type PriorAgentAction,
} from "@/lib/agent-actions";
import { bodyKey, generateConfirmationCode, hashConfirmationCode } from "@/lib/agent-action-codes";

/** El pedido sobre el que actúa el agente, ya buscado en las tiendas del token. */
export interface AgentOrderRef {
  orderId: string;
  storeId: string;
  storeName: string;
  orderName: string;
  customerPhone: string | null;
}

/** La guía cotizada para el agente: el courier que elegiría el automático y lo que se cobra. */
export type AgentGuideQuote =
  | {
      ok: true;
      transportId: number;
      transportName: string | null;
      deliveryCost: number;
      collectTotal: number | null;
      orderTotal: number | null;
      warnings: string[];
      pickupDate: string | null;
    }
  | { ok: false; code: string; message: string };

export interface AgentGuideCreated {
  /** hecha: creada y guardada. incierta: pudo crearse (Aliclik no respondió, o no se guardó en Kapta). */
  status: "hecha" | "incierta" | "rechazada" | "error";
  code: string | null;
  orderNumber: string | null;
  message: string | null;
}

/** Lo de afuera que usan las acciones. Producción: lib/agent-actions-server.ts. */
export interface AgentActionsExternal {
  admin: SupabaseClient;
  now: () => Date;
  /** Los permisos efectivos de una persona en una organización; null si no se pudieron leer. */
  permissions: (orgId: string, userId: string) => Promise<ReadonlySet<Permission> | null>;
  kapso: {
    /** La clave de Kapso de la tienda y su número de WhatsApp; null sin Kapso. */
    creds: (storeId: string) => Promise<{ apiKey: string; phoneNumberId: string | null } | null>;
    conversations: (opts: KapsoClientOpts, phone: string) => Promise<KapsoConversation[]>;
    lastInboundAt: (opts: KapsoClientOpts, conversationId: string) => Promise<number | null>;
    sendText: (opts: KapsoClientOpts, params: { phoneNumberId: string; to: string; body: string }) => Promise<WhatsappSendResult>;
  };
  aliclik: {
    /** Cotiza y pasa las compuertas de Kapta, sin crear nada. */
    quote: (order: AgentOrderRef) => Promise<AgentGuideQuote>;
    /** Crea la guía por el camino del botón, con origen «agente_ia». */
    create: (
      order: AgentOrderRef,
      quote: { transportId: number; collectTotal: number | null },
      origin: { reason: string; scheduledOn: string },
    ) => Promise<AgentGuideCreated>;
  };
  /** Recalcula el Master del pedido; nunca falla hacia el agente. */
  recompute: (orderIds: string[]) => Promise<void>;
}

export interface AgentActions {
  note: (ctx: AgentContext, order: AgentOrderRef, input: { text: string; origin: AgentOrigin }) => Promise<AgentToolOutcome>;
  previewWhatsapp: (ctx: AgentContext, order: AgentOrderRef, input: { text: string; origin: AgentOrigin }) => Promise<AgentToolOutcome>;
  previewGuide: (ctx: AgentContext, order: AgentOrderRef, input: { origin: AgentOrigin }) => Promise<AgentToolOutcome>;
  confirm: (ctx: AgentContext, order: AgentOrderRef, action: "whatsapp" | "guia_aliclik", code: string) => Promise<AgentToolOutcome>;
}

interface ActionRow {
  id: string;
  token_id: string;
  org_id: string;
  store_id: string;
  order_id: string;
  action: AgentActionKind;
  origin: AgentOrigin;
  status: AgentActionStatus;
  body: string | null;
  body_key: string | null;
  details: Record<string, unknown> | null;
  code_expires_at: string | null;
  created_at: string;
}

const ACTION_COLUMNS = "id,token_id,org_id,store_id,order_id,action,origin,status,body,body_key,details,code_expires_at,created_at";

/** Un «no» para el agente, con la tienda y el pedido para el registro. */
function no(order: AgentOrderRef, code: string, message: string): AgentToolOutcome {
  return { ok: false, code, message, storeId: order.storeId, orderId: order.orderId };
}

function yes(order: AgentOrderRef, data: Record<string, unknown>): AgentToolOutcome {
  return { ok: true, storeId: order.storeId, orderId: order.orderId, data };
}

const CANT_READ = "No se pudo leer el registro de acciones del agente ahora. Reintenta en unos segundos.";

/** La organización entera, porque el tope es de la organización. */
const ACTION_LABEL_PLURAL: Record<"whatsapp" | "guia_aliclik", string> = { whatsapp: "WhatsApp", guia_aliclik: "guías" };

export function createAgentActions(ext: AgentActionsExternal): AgentActions {
  const { admin } = ext;

  async function permissionBlock(ctx: AgentContext, order: AgentOrderRef, permission: Permission): Promise<AgentToolOutcome | null> {
    const perms = await ext.permissions(ctx.orgId, ctx.userId).catch(() => null);
    if (!perms) return no(order, "permisos_no_disponibles", "No se pudieron leer los permisos de quien conectó el agente. Reintenta en unos segundos.");
    if (!perms.has(permission)) {
      return no(
        order,
        "sin_permiso",
        `Quien conectó este agente no tiene el permiso «${PERMISSION_LABEL[permission]}» en Kapta, así que el agente tampoco. Lo concede el dueño en Equipo.`,
      );
    }
    return null;
  }

  async function loadSettings(orgId: string): Promise<{ settings?: AgentActionSettings; error?: { code: string; message: string } }> {
    const { data, error } = await admin.from("agent_action_settings").select("*").eq("org_id", orgId).maybeSingle();
    if (error) {
      return isAgentActionsMigrationMissing(error)
        ? { error: { code: "migracion_pendiente", message: AGENT_ACTIONS_MIGRATION_MISSING } }
        : { error: { code: "base_no_disponible", message: CANT_READ } };
    }
    return { settings: parseAgentSettings(data as Record<string, unknown> | null) };
  }

  /** Lo que el agente ya hizo (o está haciendo) en este pedido, sin la fila `exceptId`. */
  async function priorOnOrder(orderId: string, action: AgentActionKind, exceptId: string | null): Promise<PriorAgentAction[] | null> {
    let query = admin
      .from("agent_actions")
      .select("action,status,body_key,resolved_at,created_at")
      .eq("order_id", orderId)
      .eq("action", action)
      .in("status", [...AGENT_COUNTED_STATUSES]);
    if (exceptId) query = query.neq("id", exceptId);
    const { data, error } = await query.limit(200);
    return error ? null : ((data ?? []) as PriorAgentAction[]);
  }

  /** Cuántas cuentan hoy (día de Lima) en la organización, sin la fila `exceptId`. */
  async function countedToday(orgId: string, action: AgentActionKind, exceptId: string | null): Promise<number | null> {
    let query = admin
      .from("agent_actions")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("action", action)
      .in("status", [...AGENT_COUNTED_STATUSES])
      .gte("created_at", limaDayStartIso(ext.now()));
    if (exceptId) query = query.neq("id", exceptId);
    const { count, error } = await query;
    return error ? null : count ?? 0;
  }

  /** Tope del día y «una vez y no más». null: se puede. */
  async function brakes(
    ctx: AgentContext,
    order: AgentOrderRef,
    action: "whatsapp" | "guia_aliclik",
    settings: AgentActionSettings,
    key: string | null,
    exceptId: string | null,
  ): Promise<{ code: string; message: string } | null> {
    const [prior, today] = await Promise.all([priorOnOrder(order.orderId, action, exceptId), countedToday(ctx.orgId, action, exceptId)]);
    if (prior === null || today === null) return { code: "base_no_disponible", message: CANT_READ };
    const once = action === "whatsapp" ? whatsappOrderBlock(prior, key ?? "", ext.now().getTime()) : guideOrderBlock(prior);
    if (once) return { code: "una_vez", message: once };
    const cap = action === "whatsapp" ? settings.whatsappDailyCap : settings.guideDailyCap;
    const capBlock = dailyCapBlock(today, cap, ACTION_LABEL_PLURAL[action]);
    return capBlock ? { code: "tope_diario", message: capBlock } : null;
  }

  /** La conversación de Kapso de la clienta, el número desde el que se le escribe y su ventana de 24 h. */
  async function whatsappTarget(
    order: AgentOrderRef,
  ): Promise<
    | { ok: true; opts: KapsoClientOpts; phone: string; phoneNumberId: string; conversationId: string; windowUntil: string | null; open: boolean }
    | { ok: false; code: string; message: string }
  > {
    const phone = normalizePhone(order.customerPhone);
    if (!phone || !/^[0-9]{8,15}$/.test(phone)) return { ok: false, code: "sin_celular", message: "El pedido no trae un celular válido para escribirle." };
    const creds = await ext.kapso.creds(order.storeId).catch(() => null);
    if (!creds?.apiKey) return { ok: false, code: "sin_kapso", message: `${order.storeName} no tiene Kapso configurado: no se le puede escribir desde Kapta.` };
    const opts: KapsoClientOpts = { apiKey: creds.apiKey };
    try {
      // La conversación más reciente de ese celular: la ventana de 24 h es por
      // número de la tienda, así que se responde desde el número donde ella escribió.
      const conversations = await ext.kapso.conversations(opts, phone);
      const conversation = conversations[0];
      if (!conversation?.id) {
        return { ok: false, code: "sin_conversacion", message: "Esta clienta no tiene conversación de WhatsApp con la tienda: no hay ventana de 24 h abierta." };
      }
      const phoneNumberId = (typeof conversation.phone_number_id === "string" && conversation.phone_number_id.trim()) || creds.phoneNumberId;
      if (!phoneNumberId) return { ok: false, code: "sin_kapso", message: `${order.storeName} no tiene el número de WhatsApp configurado en Kapso.` };
      const lastInbound = await ext.kapso.lastInboundAt(opts, String(conversation.id));
      const window = whatsappWindow(lastInbound, ext.now().getTime());
      return { ok: true, opts, phone, phoneNumberId, conversationId: String(conversation.id), windowUntil: window.until, open: window.open };
    } catch {
      return { ok: false, code: "kapso_no_disponible", message: "No se pudo leer la conversación en Kapso ahora. Reintenta en unos segundos." };
    }
  }

  const WINDOW_CLOSED =
    "La clienta no escribió en las últimas 24 horas: WhatsApp no deja mandarle texto libre. Que le escriba una persona con una plantilla, o esperar a que ella escriba.";

  /** Cierra la fila con su resultado. Nunca falla hacia el agente. */
  async function finish(
    id: string,
    status: AgentActionStatus,
    extra: { mode?: string | null; errorCode?: string | null; details?: Record<string, unknown> } = {},
  ): Promise<void> {
    const patch: Record<string, unknown> = { status, resolved_at: ext.now().toISOString() };
    if (extra.mode !== undefined) patch.mode = extra.mode;
    if (extra.errorCode) patch.error_code = /^[a-z_]{2,40}$/.test(extra.errorCode) ? extra.errorCode : "error";
    if (extra.details) patch.details = extra.details;
    try {
      await admin.from("agent_actions").update(patch).eq("id", id);
    } catch {
      // El registro es de ayuda; la acción ya pasó o no pasó.
    }
  }

  async function insertAction(row: Record<string, unknown>): Promise<{ id?: string; error?: { code: string; message: string } }> {
    const { data, error } = await admin.from("agent_actions").insert(row).select("id").single();
    if (error || !data) {
      return {
        error: isAgentActionsMigrationMissing(error)
          ? { code: "migracion_pendiente", message: AGENT_ACTIONS_MIGRATION_MISSING }
          : { code: "base_no_disponible", message: CANT_READ },
      };
    }
    return { id: (data as { id: string }).id };
  }

  function baseRow(ctx: AgentContext, order: AgentOrderRef, action: AgentActionKind, origin: AgentOrigin) {
    return {
      token_id: ctx.tokenId,
      org_id: ctx.orgId,
      store_id: order.storeId,
      order_id: order.orderId,
      acting_user: ctx.userId,
      action,
      origin,
    };
  }

  async function orderEvent(order: AgentOrderRef, event: { kind: string; note: string; commentType?: string | null; reason?: string | null; payload: Record<string, unknown> }) {
    const { error } = await admin.from("order_events").insert({
      store_id: order.storeId,
      order_id: order.orderId,
      kind: event.kind,
      occurred_at: ext.now().toISOString(),
      // Sin persona: lo hizo el agente. Quién lo conectó queda en `agent_actions`.
      actor: null,
      source: AGENT_EVENT_SOURCE,
      note: event.note,
      comment_type: event.commentType ?? null,
      reason: event.reason ?? null,
      payload: event.payload,
    });
    return error ? error.message : null;
  }

  // -------------------------------------------------------------------------
  // Nota
  // -------------------------------------------------------------------------

  async function note(ctx: AgentContext, order: AgentOrderRef, input: { text: string; origin: AgentOrigin }): Promise<AgentToolOutcome> {
    const body = cleanAgentText(input.text);
    if (body.length < AGENT_NOTE_MIN) return no(order, "texto_corto", "La nota está vacía o es demasiado corta.");
    if (body.length > AGENT_NOTE_MAX) return no(order, "texto_largo", `La nota es demasiado larga (máximo ${AGENT_NOTE_MAX} caracteres).`);
    const denied = await permissionBlock(ctx, order, "master.edit");
    if (denied) return denied;
    const key = bodyKey(body);
    const { data: same, error: sameError } = await admin
      .from("agent_actions")
      .select("id")
      .eq("order_id", order.orderId)
      .eq("action", "nota")
      .eq("status", "hecha")
      .eq("body_key", key)
      .limit(1);
    if (sameError) {
      return isAgentActionsMigrationMissing(sameError) ? no(order, "migracion_pendiente", AGENT_ACTIONS_MIGRATION_MISSING) : no(order, "base_no_disponible", CANT_READ);
    }
    if ((same ?? []).length) return no(order, "repetida", "Esa misma nota ya está en la Actividad de este pedido: no se repite.");

    const inserted = await insertAction({ ...baseRow(ctx, order, "nota", input.origin), status: "en_curso", body, body_key: key });
    if (!inserted.id) return no(order, inserted.error!.code, inserted.error!.message);
    const eventError = await orderEvent(order, {
      kind: "comment",
      note: body,
      commentType: AGENT_COMMENT_TYPE,
      payload: { agent_action_id: inserted.id, agente: ctx.label, origen: input.origin },
    });
    if (eventError) {
      await finish(inserted.id, "error", { errorCode: "evento_no_guardado" });
      return no(order, "base_no_disponible", "No se pudo guardar la nota en el pedido. Reintenta en unos segundos.");
    }
    await finish(inserted.id, "hecha");
    await ext.recompute([order.orderId]).catch(() => undefined);
    return yes(order, {
      accion: "nota",
      estado: "hecha",
      pedido: order.orderName,
      tienda: order.storeName,
      texto: body,
      nota: "Quedó en la Actividad del pedido como comentario «Agente de IA».",
    });
  }

  // -------------------------------------------------------------------------
  // WhatsApp
  // -------------------------------------------------------------------------

  async function previewWhatsapp(ctx: AgentContext, order: AgentOrderRef, input: { text: string; origin: AgentOrigin }): Promise<AgentToolOutcome> {
    const body = cleanAgentText(input.text);
    if (body.length < 2) return no(order, "texto_corto", "El mensaje está vacío.");
    if (body.length > AGENT_WHATSAPP_MAX) return no(order, "texto_largo", `El mensaje es demasiado largo (máximo ${AGENT_WHATSAPP_MAX} caracteres).`);
    const denied = await permissionBlock(ctx, order, "master.edit");
    if (denied) return denied;
    const loaded = await loadSettings(ctx.orgId);
    if (!loaded.settings) return no(order, loaded.error!.code, loaded.error!.message);
    const settings = loaded.settings;
    if (settings.whatsappMode === "apagado") {
      return no(order, "apagado", "El WhatsApp del agente está Apagado en Automatizaciones › Conector de IA. Lo enciende el dueño.");
    }
    const key = bodyKey(body);
    const brake = await brakes(ctx, order, "whatsapp", settings, key, null);
    if (brake) return no(order, brake.code, brake.message);
    const target = await whatsappTarget(order);
    if (!target.ok) return no(order, target.code, target.message);
    if (!target.open) return no(order, "ventana_cerrada", WINDOW_CLOSED);

    const code = generateConfirmationCode();
    const expires = new Date(ext.now().getTime() + AGENT_CODE_TTL_MS).toISOString();
    const inserted = await insertAction({
      ...baseRow(ctx, order, "whatsapp", input.origin),
      status: "prevista",
      mode: settings.whatsappMode,
      body,
      body_key: key,
      details: { ventana_hasta: target.windowUntil },
      code_hash: hashConfirmationCode(code),
      code_expires_at: expires,
    });
    if (!inserted.id) return no(order, inserted.error!.code, inserted.error!.message);
    return yes(order, {
      accion: "whatsapp",
      paso: "vista_previa",
      pedido: order.orderName,
      tienda: order.storeName,
      para: maskPhone(target.phone),
      texto: body,
      interruptor: AGENT_MODE_LABEL[settings.whatsappMode],
      origen: input.origin,
      al_confirmar: agentExecutionNote(settings.whatsappMode, input.origin),
      ventana_24h_hasta: target.windowUntil,
      codigo_confirmacion: code,
      vence: expires,
      siguiente_paso: "Para enviarlo, llama a enviar_whatsapp con el mismo pedido y este codigo. El código sirve una sola vez y por 10 minutos.",
    });
  }

  async function confirmWhatsapp(ctx: AgentContext, order: AgentOrderRef, row: ActionRow): Promise<AgentToolOutcome> {
    const denied = await permissionBlock(ctx, order, "master.edit");
    if (denied) {
      await finish(row.id, "rechazada", { errorCode: denied.ok ? null : denied.code });
      return denied;
    }
    const loaded = await loadSettings(ctx.orgId);
    if (!loaded.settings) {
      await finish(row.id, "error", { errorCode: loaded.error!.code });
      return no(order, loaded.error!.code, loaded.error!.message);
    }
    const mode = loaded.settings.whatsappMode;
    const what = agentExecution(mode, row.origin);
    if (what === "rechazar") {
      await finish(row.id, "rechazada", { mode, errorCode: "apagado" });
      return no(order, "apagado", "El WhatsApp del agente se apagó después de la vista previa: no se envió.");
    }
    const brake = await brakes(ctx, order, "whatsapp", loaded.settings, row.body_key, row.id);
    if (brake) {
      await finish(row.id, "rechazada", { mode, errorCode: brake.code });
      return no(order, brake.code, brake.message);
    }
    const target = await whatsappTarget(order);
    if (!target.ok) {
      await finish(row.id, "error", { mode, errorCode: target.code });
      return no(order, target.code, target.message);
    }
    if (!target.open) {
      await finish(row.id, "rechazada", { mode, errorCode: "ventana_cerrada" });
      return no(order, "ventana_cerrada", WINDOW_CLOSED);
    }
    const details = { ...(row.details ?? {}), ventana_hasta: target.windowUntil };
    if (what === "simular") {
      await finish(row.id, "simulada", { mode, details });
      return yes(order, {
        accion: "whatsapp",
        estado: "simulada",
        pedido: order.orderName,
        texto: row.body,
        nota: "Simulación: NO se envió. Queda registrado lo que habría mandado, para que el dueño lo revise en Kapta.",
      });
    }

    const res = await ext.kapso.sendText(target.opts, { phoneNumberId: target.phoneNumberId, to: target.phone, body: row.body ?? "" }).catch(
      (): WhatsappSendResult => ({ ok: false, error: "sin respuesta", ambiguous: true }),
    );
    if (res.ok) {
      await finish(row.id, "hecha", { mode, details: { ...details, message_id: res.id ?? null } });
      await orderEvent(order, {
        kind: AGENT_WHATSAPP_EVENT,
        note: row.body ?? "",
        payload: { agent_action_id: row.id, agente: ctx.label, origen: row.origin, message_id: res.id ?? null },
      });
      await ext.recompute([order.orderId]).catch(() => undefined);
      return yes(order, { accion: "whatsapp", estado: "hecha", pedido: order.orderName, texto: row.body, nota: "Enviado. Quedó en la Actividad del pedido." });
    }
    if (!res.ok && res.ambiguous) {
      await finish(row.id, "incierta", { mode, errorCode: "sin_confirmacion", details });
      await orderEvent(order, {
        kind: AGENT_WHATSAPP_EVENT,
        note: row.body ?? "",
        reason: "Kapso no confirmó el envío: puede haber salido.",
        payload: { agent_action_id: row.id, agente: ctx.label, origen: row.origin, incierto: true },
      });
      return no(order, "incierto", "Kapso no confirmó si salió. NO lo reintentes: puede haber llegado. Revisa la conversación con leer_conversacion.");
    }
    const closed = res.code === 131047 || /24\s*h|re-?engag|outside|window/i.test(res.error ?? "");
    await finish(row.id, "error", { mode, errorCode: closed ? "ventana_cerrada" : "kapso_rechazo", details: { ...details, kapso_code: res.code ?? null } });
    return closed ? no(order, "ventana_cerrada", WINDOW_CLOSED) : no(order, "kapso_rechazo", "Kapso no aceptó el mensaje: no se envió.");
  }

  // -------------------------------------------------------------------------
  // Guía de Aliclik
  // -------------------------------------------------------------------------

  async function previewGuide(ctx: AgentContext, order: AgentOrderRef, input: { origin: AgentOrigin }): Promise<AgentToolOutcome> {
    const denied = await permissionBlock(ctx, order, "aliclik.create_guide");
    if (denied) return denied;
    const loaded = await loadSettings(ctx.orgId);
    if (!loaded.settings) return no(order, loaded.error!.code, loaded.error!.message);
    const settings = loaded.settings;
    if (settings.guideMode === "apagado") {
      return no(order, "apagado", "Las guías del agente están Apagadas en Automatizaciones › Conector de IA. Las enciende el dueño.");
    }
    const brake = await brakes(ctx, order, "guia_aliclik", settings, null, null);
    if (brake) return no(order, brake.code, brake.message);
    const quote = await ext.aliclik.quote(order).catch((): AgentGuideQuote => ({ ok: false, code: "aliclik_no_disponible", message: "No se pudo cotizar en Aliclik ahora. Reintenta en unos minutos." }));
    if (!quote.ok) return no(order, quote.code, quote.message);

    const code = generateConfirmationCode();
    const expires = new Date(ext.now().getTime() + AGENT_CODE_TTL_MS).toISOString();
    const inserted = await insertAction({
      ...baseRow(ctx, order, "guia_aliclik", input.origin),
      status: "prevista",
      mode: settings.guideMode,
      details: {
        transport_id: quote.transportId,
        courier: quote.transportName,
        costo_envio: quote.deliveryCost,
        cobrar: quote.collectTotal,
      },
      code_hash: hashConfirmationCode(code),
      code_expires_at: expires,
    });
    if (!inserted.id) return no(order, inserted.error!.code, inserted.error!.message);
    return yes(order, {
      accion: "guia_aliclik",
      paso: "vista_previa",
      pedido: order.orderName,
      tienda: order.storeName,
      courier: quote.transportName,
      costo_envio: quote.deliveryCost,
      cobrar_en_la_puerta: quote.collectTotal,
      total_del_pedido: quote.orderTotal,
      recojo: quote.pickupDate,
      avisos: quote.warnings,
      interruptor: AGENT_MODE_LABEL[settings.guideMode],
      origen: input.origin,
      al_confirmar: agentExecutionNote(settings.guideMode, input.origin),
      codigo_confirmacion: code,
      vence: expires,
      siguiente_paso:
        "Para crearla, llama a crear_guia_aliclik con el mismo pedido y este codigo. Al confirmar, Kapta vuelve a cotizar y a pasar todas sus compuertas; si el monto cambió, no la crea.",
    });
  }

  async function confirmGuide(ctx: AgentContext, order: AgentOrderRef, row: ActionRow): Promise<AgentToolOutcome> {
    const denied = await permissionBlock(ctx, order, "aliclik.create_guide");
    if (denied) {
      await finish(row.id, "rechazada", { errorCode: denied.ok ? null : denied.code });
      return denied;
    }
    const loaded = await loadSettings(ctx.orgId);
    if (!loaded.settings) {
      await finish(row.id, "error", { errorCode: loaded.error!.code });
      return no(order, loaded.error!.code, loaded.error!.message);
    }
    const mode = loaded.settings.guideMode;
    const what = agentExecution(mode, row.origin);
    if (what === "rechazar") {
      await finish(row.id, "rechazada", { mode, errorCode: "apagado" });
      return no(order, "apagado", "Las guías del agente se apagaron después de la vista previa: no se creó.");
    }
    const brake = await brakes(ctx, order, "guia_aliclik", loaded.settings, null, row.id);
    if (brake) {
      await finish(row.id, "rechazada", { mode, errorCode: brake.code });
      return no(order, brake.code, brake.message);
    }
    const details = row.details ?? {};
    const transportId = typeof details.transport_id === "number" ? details.transport_id : null;
    const collectTotal = typeof details.cobrar === "number" ? details.cobrar : null;
    if (transportId == null) {
      await finish(row.id, "error", { mode, errorCode: "vista_previa_incompleta" });
      return no(order, "vista_previa_incompleta", "La vista previa no guardó el courier. Pide otra.");
    }
    if (what === "simular") {
      // Se vuelve a cotizar y a pasar las compuertas: lo simulado dice lo que la creación real haría hoy.
      const quote = await ext.aliclik.quote(order).catch((): AgentGuideQuote => ({ ok: false, code: "aliclik_no_disponible", message: "No se pudo cotizar en Aliclik ahora." }));
      if (!quote.ok) {
        await finish(row.id, "rechazada", { mode, errorCode: quote.code });
        return no(order, quote.code, `Simulación: tampoco se habría creado. ${quote.message}`);
      }
      await finish(row.id, "simulada", { mode, details: { ...details, courier_hoy: quote.transportName, cobrar_hoy: quote.collectTotal } });
      return yes(order, {
        accion: "guia_aliclik",
        estado: "simulada",
        pedido: order.orderName,
        courier: quote.transportName,
        cobrar_en_la_puerta: quote.collectTotal,
        nota: "Simulación: NO se creó la guía. Queda registrado lo que habría hecho, para que el dueño lo revise en Kapta.",
      });
    }

    // El día de Lima (el comienzo del día de Lima cae a las 05:00 UTC del mismo día).
    const origin = { reason: "", scheduledOn: limaDayStartIso(ext.now()).slice(0, 10) };
    const created = await ext.aliclik
      .create(order, { transportId, collectTotal }, { ...origin, reason: agentGuideReason(ctx.label, row.origin) })
      .catch((): AgentGuideCreated => ({ status: "incierta", code: "sin_respuesta", orderNumber: null, message: "Kapta no recibió la respuesta de la creación." }));
    const finalDetails = { ...details, ...(created.orderNumber ? { guia: created.orderNumber } : {}) };
    await finish(row.id, created.status, { mode, errorCode: created.code, details: finalDetails });
    if (created.status === "hecha") {
      return yes(order, {
        accion: "guia_aliclik",
        estado: "hecha",
        pedido: order.orderName,
        guia: created.orderNumber,
        nota: created.message ?? "Guía creada. Quedó en la Actividad del pedido.",
      });
    }
    if (created.status === "incierta") {
      return no(
        order,
        "incierto",
        `${created.message ?? "Aliclik pudo haberla creado."} NO la vuelvas a pedir: que una persona revise Aliclik antes de crear otra.`,
      );
    }
    return no(order, created.code ?? "guia_no_creada", created.message ?? "No se creó la guía.");
  }

  // -------------------------------------------------------------------------
  // Confirmar
  // -------------------------------------------------------------------------

  async function confirm(ctx: AgentContext, order: AgentOrderRef, action: "whatsapp" | "guia_aliclik", rawCode: string): Promise<AgentToolOutcome> {
    const code = rawCode.trim();
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(code)) return no(order, "codigo_invalido", "Ese código de confirmación no es válido.");
    const { data, error } = await admin
      .from("agent_actions")
      .select(ACTION_COLUMNS)
      .eq("code_hash", hashConfirmationCode(code))
      .eq("token_id", ctx.tokenId)
      .maybeSingle();
    if (error) {
      return isAgentActionsMigrationMissing(error) ? no(order, "migracion_pendiente", AGENT_ACTIONS_MIGRATION_MISSING) : no(order, "base_no_disponible", CANT_READ);
    }
    const row = data as ActionRow | null;
    if (!row || row.action !== action || row.order_id !== order.orderId) {
      return no(order, "codigo_invalido", "Ese código no es de esta acción ni de este pedido. Pide una vista previa nueva.");
    }
    if (row.status !== "prevista") return no(order, "codigo_usado", "Ese código ya se usó. Para otra acción, pide una vista previa nueva.");
    if (!row.code_expires_at || Date.parse(row.code_expires_at) <= ext.now().getTime()) {
      await admin.from("agent_actions").update({ status: "rechazada", error_code: "codigo_vencido", resolved_at: ext.now().toISOString() }).eq("id", row.id).eq("status", "prevista");
      return no(order, "codigo_vencido", "El código venció (dura 10 minutos). Pide una vista previa nueva.");
    }
    // Se toma la fila una sola vez: dos confirmaciones a la vez no hacen dos envíos.
    const { data: claimed, error: claimError } = await admin
      .from("agent_actions")
      .update({ status: "en_curso" })
      .eq("id", row.id)
      .eq("status", "prevista")
      .select("id");
    if (claimError) return no(order, "base_no_disponible", CANT_READ);
    if (!(claimed ?? []).length) return no(order, "codigo_usado", "Ese código ya se usó. Para otra acción, pide una vista previa nueva.");
    try {
      return await (action === "whatsapp" ? confirmWhatsapp(ctx, order, row) : confirmGuide(ctx, order, row));
    } catch {
      // Algo falló a mitad de camino: pudo haber salido. Incierta, y no se reintenta.
      await finish(row.id, "incierta", { errorCode: "error_interno" });
      return no(order, "incierto", "Algo falló en Kapta a mitad de la acción y pudo haberse hecho. NO la vuelvas a pedir: que una persona lo revise.");
    }
  }

  return { note, previewWhatsapp, previewGuide, confirm };
}
