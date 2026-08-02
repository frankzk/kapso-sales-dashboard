// COPIA DE RESPALDO — no se ejecuta desde este repo. Ver ./README.md
// Origen: app.kapso.ai → proyecto Kenku Perú (cf65efcf-38ab-475c-85b3-c2b89f304652)
//         → Functions → Notify Team → Code
// Esta versión SÍ tiene el gate de `reason` (el flujo de voucher no postea).

// notify-team: alerta interna al equipo por Telegram + aviso de handoff al dashboard.
// Se invoca cuando un cliente envia el voucher/adelanto (flujo Shalom/Olva) y el
// bot deriva a validacion logistica, o cuando el bot deriva a un humano (reclamo,
// mayorista, "quiero un asesor"). NUNCA escribe al cliente.
//
// Hace dos cosas, ambas best-effort e independientes entre si:
//   1) Telegram: push al chat del equipo via la Bot API.
//   2) Dashboard: si el evento trae `reason` (handoff real), POST al webhook de la
//      tienda para que el lead caiga en la cola "Atender ahora". El flujo de
//      voucher (sin `reason`) NO toca el dashboard, para no resetear el estado del
//      lead.

const TELEGRAM_API_BASE = "https://api.telegram.org";

// Destinatarios adicionales fijos del equipo (ademas del TELEGRAM_CHAT_ID
// principal y del secret TELEGRAM_CHAT_IDS). Se dejan embebidos porque la
// inyeccion del secret TELEGRAM_CHAT_IDS resulto poco confiable en el runtime.
// Cada persona debe haber iniciado el bot (Start) para poder recibir.
//   8844863582 = Daphne Zuniga
const EXTRA_TEAM_CHAT_IDS = ["8844863582"];

async function handler(request, env = globalThis) {
  return handleRequest(request, env);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request, env = globalThis) {
  const payload = enrichPayload(await readJson(request));
  const config = getConfig(env);

  // 1) Aviso al dashboard (handoff). Independiente de Telegram: corre aunque
  //    falte la config de Telegram. Solo dispara si hay `reason` (handoff real).
  await postStoreHandoff(config, payload);

  // 2) Telegram.
  if (!config.token || !config.chatIds.length) {
    // Falta credencial: no rompas el flujo, solo reporta ok=false (sin filtrar el token).
    return json({ ok: false, reason: "missing_telegram_config" });
  }

  const text = buildMessage(payload);

  // Difunde la alerta a todos los chats configurados (chat principal + extras).
  // El ok se decide por el chat PRINCIPAL: que un extra falle (ej. no inicio el
  // bot con /start) no rompe el flujo ni oculta el exito del chat principal.
  const results = [];
  for (const chatId of config.chatIds) {
    results.push(await sendToChat(config.token, chatId, text));
  }
  const primary = results[0];
  return json({ ok: primary.ok, results });
}

// --- Aviso de handoff al dashboard de la tienda -----------------------------

// Firma HMAC-SHA256 (hex) del cuerpo con el secret, para que el dashboard pueda
// validar el POST igual que valida los webhooks de Kapso. Best-effort.
async function hmacHex(secret, body) {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

// POST al webhook del dashboard cuando el bot deriva a un humano. Best-effort: no
// afecta el retorno ni el envio a Telegram. Solo dispara con `reason` (handoff
// real: reclamo / mayorista / "quiero un asesor"); el flujo de voucher (sin
// reason) NO postea, para no pisar el estado del lead en el dashboard.
async function postStoreHandoff(config, payload) {
  const url = config.storeWebhookUrl;
  if (!url) return;
  const reason = cleanValue(payload.reason);
  if (!reason) return;
  const phone = String(payload.phone || "").replace(/[^\d]/g, "");
  const body = JSON.stringify({
    event: "workflow.execution.handoff",
    phone_number: phone,
    conversation_id: deriveConversationId(payload),
    reason,
    context_summary: cleanValue(payload.note || payload.context_summary),
  });
  const headers = { "Content-Type": "application/json" };
  if (config.storeWebhookSecret) {
    headers["X-Webhook-Secret"] = config.storeWebhookSecret;
    const sig = await hmacHex(config.storeWebhookSecret, body);
    if (sig) headers["X-Kapso-Signature"] = sig;
  }
  try {
    await fetch(url, { method: "POST", headers, body });
  } catch {}
}

// Id de conversacion desde el contexto de ejecucion (para enlazar el lead con la
// conversacion de Kapso). Best-effort: "" si no se encuentra.
function deriveConversationId(payload) {
  const o = payload || {};
  const ec = (o.execution_context && typeof o.execution_context === "object") ? o.execution_context : {};
  const ecCtx = (ec.context && typeof ec.context === "object") ? ec.context : {};
  const ecSys = (ec.system && typeof ec.system === "object") ? ec.system : {};
  const cands = [
    o.conversationId, o.conversation_id, o.whatsapp_conversation_id,
    ecCtx.conversation_id, ecCtx.whatsapp_conversation_id,
    ecSys.conversation_id, ec.conversation_id,
    o.whatsapp_context && o.whatsapp_context.conversation && o.whatsapp_context.conversation.id,
  ];
  for (const c of cands) {
    if (c && typeof c === "string") return c;
  }
  const msgs = o.whatsapp_context && o.whatsapp_context.messages;
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i] || {};
      const id = (m.kapso && m.kapso.whatsapp_conversation_id) || m.whatsapp_conversation_id;
      if (id) return String(id);
    }
  }
  return "";
}

// --- Telegram ---------------------------------------------------------------

async function sendToChat(token, chatId, text) {
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      let description = "";
      try {
        const data = await res.json();
        description = data && data.description ? String(data.description) : "";
      } catch {
        // ignore parse errors
      }
      return { chatId, ok: false, reason: "telegram_error", status: res.status, description };
    }

    return { chatId, ok: true };
  } catch (err) {
    return { chatId, ok: false, reason: "request_failed", error: String(err && err.message ? err.message : err) };
  }
}

// Rellena telefono/cliente/producto desde el contexto de la ejecucion cuando el
// agente no los pasa explicitamente. Sin esto la alerta salia como una sola
// linea ("Voucher recibido") y el equipo no sabia a QUIEN validar/enviar.
function enrichPayload(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  // el agente puede mandar sus args bajo `input`; los fusionamos con el resto.
  const p = (r.input && typeof r.input === "object" && !Array.isArray(r.input)) ? { ...r, ...r.input } : { ...r };
  const ctx = r.execution_context?.context || p.execution_context?.context || {};
  const wa = r.whatsapp_context || p.whatsapp_context || {};
  const vars = r.execution_context?.vars || p.execution_context?.vars || {};
  const contact = ctx.contact || {};

  if (!cleanValue(p.phone)) {
    p.phone = ctx.phone_number || wa.conversation?.phone_number || vars.known_phone || "";
  }
  if (!cleanValue(p.customerName)) {
    p.customerName = contact.name || contact.profile_name || contact.display_name
      || wa.conversation?.contact_name || vars.known_customer_name || "";
  }
  if (!cleanValue(p.product)) {
    p.product = vars.last_product_title || vars.last_product_handle || "";
  }
  return p;
}

// Encabezado segun el motivo. Sin `reason` = flujo de voucher (identico a antes).
// Con `reason` = handoff a humano, con encabezado acorde.
function headerFor(reason) {
  const r = cleanValue(reason).toLowerCase();
  if (r.includes("reclamo") || r.includes("queja")) return "🔴 <b>RECLAMO — atender URGENTE</b>";
  if (r.includes("mayorista")) return "📦 <b>Pedido mayorista — coordinar</b>";
  if (r) return `🔔 <b>${escapeHtml(cleanValue(reason))}</b>`;
  return "🟢 <b>Voucher recibido — validar y enviar</b>";
}

function buildMessage(payload) {
  const p = payload || {};
  const reason = cleanValue(p.reason);
  const lines = [];
  lines.push(headerFor(reason));

  const advance = cleanValue(p.advance ?? p.adelanto);
  const rows = [
    ["Cliente", p.customerName],
    ["Telefono", p.phone],
    ["Producto", p.product],
    ["Total", formatTotal(p.total)],
    // El adelanto por defecto (S/30) es del flujo de voucher; en un handoff no aplica.
    ["Adelanto", formatTotal(advance || (reason ? "" : "30"))],
    ["Courier", p.courier],
    ["Agencia/Direccion", p.destination],
    ["DNI", p.dni],
    ["Pago reportado", p.paymentReported],
    ["Nota", p.note],
  ];

  for (const [label, value] of rows) {
    const clean = cleanValue(value);
    if (clean) lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(clean)}`);
  }

  return lines.join("\n");
}

function formatTotal(total) {
  if (total === undefined || total === null || total === "") return "";
  if (typeof total === "number") return `S/ ${total}`;
  const str = String(total).trim();
  if (!str) return "";
  return /^s\/?/i.test(str) ? str : `S/ ${str}`;
}

function cleanValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getConfig(env = globalThis) {
  const token =
    env.TELEGRAM_BOT_TOKEN ||
    env.tELEGRAMBOTTOKEN ||
    globalThis.TELEGRAM_BOT_TOKEN ||
    globalThis.tELEGRAMBOTTOKEN;
  const primary =
    env.TELEGRAM_CHAT_ID ||
    env.tELEGRAMCHATID ||
    globalThis.TELEGRAM_CHAT_ID ||
    globalThis.tELEGRAMCHATID;
  // Destinatarios adicionales (coma/espacio/;): asi se agregan mas chats sin
  // tocar el TELEGRAM_CHAT_ID principal. Se envia a todos, deduplicando.
  const extra =
    env.TELEGRAM_CHAT_IDS ||
    env.tELEGRAMCHATIDS ||
    globalThis.TELEGRAM_CHAT_IDS ||
    globalThis.tELEGRAMCHATIDS;
  const chatIds = parseChatIds(primary, extra, EXTRA_TEAM_CHAT_IDS.join(","));
  // URL + secret del dashboard de la tienda (runtime_config en Kapso). Kapso
  // expone las claves con la primera letra en minuscula (sTOREWEBHOOKURL).
  const storeWebhookUrl =
    env.STORE_WEBHOOK_URL || env.sTOREWEBHOOKURL ||
    globalThis.STORE_WEBHOOK_URL || globalThis.sTOREWEBHOOKURL || "";
  const storeWebhookSecret =
    env.STORE_WEBHOOK_SECRET || env.sTOREWEBHOOKSECRET ||
    globalThis.STORE_WEBHOOK_SECRET || globalThis.sTOREWEBHOOKSECRET || "";
  return { token, chatIds, chatId: chatIds[0] || "", storeWebhookUrl, storeWebhookSecret };
}

function parseChatIds(...values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value) continue;
    for (const part of String(value).split(/[\s,;]+/)) {
      const id = part.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

async function readJson(request) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    return Object.fromEntries(url.searchParams.entries());
  }

  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { note: text };
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

globalThis.__kenkuNotifyTeam = {
  buildMessage,
  getConfig,
  handleRequest,
  handler,
  postStoreHandoff,
};
