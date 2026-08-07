// COPIA DE RESPALDO — no se ejecuta desde este repo. Ver ./README.md
// Origen: app.kapso.ai → proyecto Aurela (387343ab-aa79-4641-b56b-fe9cf93e274e)
//         → Functions → Notify Team → Code
// PENDIENTE en esta versión: le falta el gate de `reason` (ver README).

// notify-team: alerta interna al equipo por Telegram.
// Se invoca cuando un cliente envia el voucher/adelanto (flujo Shalom/Olva) y el
// bot deriva a validacion logistica. NUNCA escribe al cliente: solo manda un push
// al chat de Telegram del dueno via la Bot API.

const TELEGRAM_API_BASE = "https://api.telegram.org";

// Destinatarios adicionales de Telegram, ademas del TELEGRAM_CHAT_ID configurado
// en la plataforma. Best-effort: se envia a cada uno sin afectar el retorno del
// envio principal. Cada usuario debe haber iniciado el bot (Start) para recibir.
const EXTRA_TELEGRAM_CHAT_IDS = ["8844863582"];
async function sendTelegramExtras(token, text, opts = {}) {
  if (!token) return;
  for (const chatId of EXTRA_TELEGRAM_CHAT_IDS) {
    try {
      await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, ...opts }),
      });
    } catch {}
  }
}

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

// Aviso al dashboard de la tienda cuando el bot deriva a un humano (handoff).
// Best-effort: no afecta el retorno de notify-team ni el envio a Telegram. La URL
// y el secret se leen del entorno (runtime_config en Kapso), nunca hardcodeados.
async function postStoreHandoff(config, ctx, payload) {
  const url = config.storeWebhookUrl;
  if (!url) return;
  // El flujo de voucher no manda `reason`: no es un handoff, no va al dashboard.
  const reason = String(payload.reason || "").trim();
  if (!reason) return;
  const body = JSON.stringify({
    event: "workflow.execution.handoff",
    phone_number: ctx.phone || "",
    conversation_id: ctx.convId || "",
    reason,
    context_summary: String(payload.note || payload.context_summary || "").replace(/\s+/g, " ").trim(),
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

async function handler(request, env = globalThis) {
  return handleRequest(request, env);
}

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request, env = globalThis) {
  const payload = await readJson(request);
  const config = getConfig(env);
  const ctx = deriveContext(payload);

  // Aviso al dashboard de la tienda (handoff). Independiente de Telegram: se
  // dispara aunque falte la config de Telegram.
  await postStoreHandoff(config, ctx, payload);

  if (!config.token || !config.chatId) {
    // Falta credencial: no rompas el flujo, solo reporta ok=false (sin filtrar el token).
    return json({ ok: false, reason: "missing_telegram_config" });
  }

  const text = buildMessage(payload, ctx);

  await sendTelegramExtras(config.token, text, { parse_mode: "HTML", disable_web_page_preview: true });

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
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
      return json({ ok: false, reason: "telegram_error", status: res.status, description });
    }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, reason: "request_failed", error: String(err && err.message ? err.message : err) });
  }
}

function headerFor(reason) {
  const r = String(reason || "").trim().toLowerCase();
  if (r.includes("reclamo") || r.includes("queja")) return "🔴 <b>RECLAMO — atender URGENTE</b>";
  if (r.includes("mayorista")) return "📦 <b>Pedido mayorista — coordinar</b>";
  if (r) return `🔔 <b>${escapeHtml(String(reason).trim())}</b>`;
  // Sin reason: comportamiento previo (flujo de voucher Shalom/Olva).
  return "🟢 <b>Voucher recibido — validar y enviar</b>";
}

const DEFAULT_PROJECT_ID = "387343ab-aa79-4641-b56b-fe9cf93e274e";

// Deriva el telefono del cliente y el id de conversacion del contexto de
// ejecucion (siempre disponibles), sin depender de que el agente los pase.
function deriveContext(payload) {
  const p = payload || {};
  const ec = isPlainObject(p.execution_context) ? p.execution_context : {};
  const ecCtx = isPlainObject(ec.context) ? ec.context : {};
  const ecSys = isPlainObject(ec.system) ? ec.system : {};

  let phone = p.phone || ecCtx.phone_number || ecCtx.phone || "";
  if (!phone) {
    const msgs = p.whatsapp_context && Array.isArray(p.whatsapp_context.messages) ? p.whatsapp_context.messages : [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i] || {};
      const dir = m.direction || (m.kapso && m.kapso.direction);
      if (dir === "inbound" && (m.from || m.phone_number)) { phone = m.from || m.phone_number; break; }
    }
  }
  phone = String(phone || "").replace(/[^\d]/g, "");

  let convId = "";
  const cands = [p.conversationId, p.conversation_id, ecCtx.conversation_id, ecCtx.whatsapp_conversation_id, ecSys.conversation_id, ec.conversation_id, p.whatsapp_conversation_id];
  for (const c of cands) { if (c && typeof c === "string") { convId = c; break; } }
  if (!convId) {
    const msgs = p.whatsapp_context && Array.isArray(p.whatsapp_context.messages) ? p.whatsapp_context.messages : [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i] || {};
      const id = (m.kapso && m.kapso.whatsapp_conversation_id) || m.whatsapp_conversation_id;
      if (id) { convId = String(id); break; }
    }
  }

  const projectId = p.projectId || (typeof globalThis !== "undefined" && (globalThis.KAPSO_PROJECT_ID || globalThis.kAPSOPROJECTID)) || DEFAULT_PROJECT_ID;
  return { phone, convId, projectId };
}

function buildMessage(payload, ctx = {}) {
  const p = payload || {};
  const lines = [];
  lines.push(headerFor(p.reason));

  // Telefono del cliente PRIMERO (para saber a quien atender), con enlaces.
  const phone = ctx.phone || String(p.phone || "").replace(/[^\d]/g, "");
  if (phone) {
    lines.push(`📱 <b>Cliente:</b> +${escapeHtml(phone)}  (<a href="https://wa.me/${escapeHtml(phone)}">abrir WhatsApp</a>)`);
  }
  if (ctx.convId) {
    lines.push(`👉 <a href="https://app.kapso.ai/projects/${escapeHtml(ctx.projectId)}/inbox?conversation_id=${escapeHtml(ctx.convId)}">Ir a atender en Kapso</a>`);
  }

  const rows = [
    ["Nombre", p.customerName],
    ["Producto", p.product],
    ["Total", formatTotal(p.total)],
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  const chatId =
    env.TELEGRAM_CHAT_ID ||
    env.tELEGRAMCHATID ||
    globalThis.TELEGRAM_CHAT_ID ||
    globalThis.tELEGRAMCHATID;
  // URL + secret del dashboard de la tienda (runtime_config en Kapso). Kapso
  // expone las claves con la primera letra en minuscula (sTOREWEBHOOKURL).
  const storeWebhookUrl =
    env.STORE_WEBHOOK_URL || env.sTOREWEBHOOKURL ||
    globalThis.STORE_WEBHOOK_URL || globalThis.sTOREWEBHOOKURL || "";
  const storeWebhookSecret =
    env.STORE_WEBHOOK_SECRET || env.sTOREWEBHOOKSECRET ||
    globalThis.STORE_WEBHOOK_SECRET || globalThis.sTOREWEBHOOKSECRET || "";
  return { token, chatId, storeWebhookUrl, storeWebhookSecret };
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

globalThis.__aurelaNotifyTeam = {
  buildMessage,
  getConfig,
  handleRequest,
  handler,
};
