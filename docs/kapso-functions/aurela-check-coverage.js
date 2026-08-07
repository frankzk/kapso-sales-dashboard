async function handler(request, env) {
  return handleRequest(request, env || globalThis);
}

const CASH_ON_DELIVERY = {
  lima: ["lima metropolitana", "lima", "*"],
  callao: ["callao", "*"],
  ica: ["ica", "parcona", "la tinguina", "los aquijes", "subanjalla", "subtanjalla", "pisco", "chincha alta"],
  moquegua: ["moquegua", "samegua", "ilo"],
  tacna: ["tacna", "alto de la alianza", "ciudad nueva", "coronel gregorio albarracin lanchipa", "pocollay"],
  ayacucho: ["ayacucho", "san juan bautista", "carmen alto", "jesus nazareno", "andres avelino caceres dorregaray"],
  junin: ["huancayo", "el tambo", "chilca"],
  ancash: ["chimbote", "nuevo chimbote", "coishco", "huaraz"],
  arequipa: [
    "arequipa",
    "alto selva alegre",
    "cayma",
    "cerro colorado",
    "characato",
    "jacobo hunter",
    "mariano melgar",
    "miraflores",
    "paucarpata",
    "socabaya",
    "yanahuara",
    "jose luis bustamante y rivero",
  ],
  "la libertad": ["trujillo", "el porvenir", "la esperanza", "huanchaco", "moche", "victor larco herrera"],
  lambayeque: ["chiclayo", "jose leonardo ortiz", "la victoria", "lambayeque", "pimentel"],
  piura: ["piura", "castilla", "catacaos", "26 de octubre", "sullana", "talara"],
  puno: ["juliaca"],
  cajamarca: ["cajamarca", "banos del inca", "los banos del inca"],
  cusco: ["cusco"],
};

const SAFE_DISTRICT_LOCATION_INFERENCE = {
  chimbote: { province: "santa", region: "ancash" },
  "nuevo chimbote": { province: "santa", region: "ancash" },
  coishco: { province: "santa", region: "ancash" },
  santa: { province: "santa", region: "ancash" },
  huaraz: { province: "huaraz", region: "ancash" },
  casma: { province: "casma", region: "ancash" },
  huarmey: { province: "huarmey", region: "ancash" },
  caraz: { province: "huaylas", region: "ancash" },
  yungay: { province: "yungay", region: "ancash" },
  carhuaz: { province: "carhuaz", region: "ancash" },
  ica: { province: "ica", region: "ica" },
  parcona: { province: "ica", region: "ica" },
  "la tinguina": { province: "ica", region: "ica" },
  "los aquijes": { province: "ica", region: "ica" },
  subanjalla: { province: "ica", region: "ica" },
  subtanjalla: { province: "ica", region: "ica" },
  pisco: { province: "pisco", region: "ica" },
  "chincha alta": { province: "chincha", region: "ica" },
  moquegua: { province: "mariscal nieto", region: "moquegua" },
  samegua: { province: "mariscal nieto", region: "moquegua" },
  ilo: { province: "ilo", region: "moquegua" },
  tacna: { province: "tacna", region: "tacna" },
  "alto de la alianza": { province: "tacna", region: "tacna" },
  "ciudad nueva": { province: "tacna", region: "tacna" },
  "coronel gregorio albarracin lanchipa": { province: "tacna", region: "tacna" },
  pocollay: { province: "tacna", region: "tacna" },
  ayacucho: { province: "huamanga", region: "ayacucho" },
  "san juan bautista": { province: "huamanga", region: "ayacucho" },
  "carmen alto": { province: "huamanga", region: "ayacucho" },
  "jesus nazareno": { province: "huamanga", region: "ayacucho" },
  "andres avelino caceres dorregaray": { province: "huamanga", region: "ayacucho" },
  huancayo: { province: "huancayo", region: "junin" },
  "el tambo": { province: "huancayo", region: "junin" },
  chilca: { province: "huancayo", region: "junin" },
  chiclayo: { province: "chiclayo", region: "lambayeque" },
  "jose leonardo ortiz": { province: "chiclayo", region: "lambayeque" },
  lambayeque: { province: "lambayeque", region: "lambayeque" },
  pimentel: { province: "chiclayo", region: "lambayeque" },
  juliaca: { province: "san roman", region: "puno" },
  piura: { province: "piura", region: "piura" },
  castilla: { province: "piura", region: "piura" },
  catacaos: { province: "piura", region: "piura" },
  "26 de octubre": { province: "piura", region: "piura" },
  sullana: { province: "sullana", region: "piura" },
  talara: { province: "talara", region: "piura" },
  trujillo: { province: "trujillo", region: "la libertad" },
  "el porvenir": { province: "trujillo", region: "la libertad" },
  "la esperanza": { province: "trujillo", region: "la libertad" },
  huanchaco: { province: "trujillo", region: "la libertad" },
  moche: { province: "trujillo", region: "la libertad" },
  "victor larco herrera": { province: "trujillo", region: "la libertad" },
  arequipa: { province: "arequipa", region: "arequipa" },
  "alto selva alegre": { province: "arequipa", region: "arequipa" },
  cayma: { province: "arequipa", region: "arequipa" },
  "cerro colorado": { province: "arequipa", region: "arequipa" },
  characato: { province: "arequipa", region: "arequipa" },
  "jacobo hunter": { province: "arequipa", region: "arequipa" },
  "mariano melgar": { province: "arequipa", region: "arequipa" },
  paucarpata: { province: "arequipa", region: "arequipa" },
  socabaya: { province: "arequipa", region: "arequipa" },
  yanahuara: { province: "arequipa", region: "arequipa" },
  "jose luis bustamante y rivero": { province: "arequipa", region: "arequipa" },
  cajamarca: { province: "cajamarca", region: "cajamarca" },
  "banos del inca": { province: "cajamarca", region: "cajamarca" },
  "los banos del inca": { province: "cajamarca", region: "cajamarca" },
  cusco: { province: "cusco", region: "cusco" },
};

const LIMA_METRO_DISTRICTS = new Set([
  "barranco", "brena", "cercado de lima", "jesus maria", "la victoria", "lima",
  "lince", "magdalena del mar", "miraflores", "pueblo libre", "rimac",
  "san borja", "san isidro", "san luis", "san miguel", "santiago de surco", "surco", "surquillo",
  "ancon", "carabayllo", "comas", "independencia", "los olivos", "puente piedra",
  "san martin de porres", "smp", "santa rosa",
  "ate", "ate vitarte", "vitarte", "chaclacayo", "cieneguilla", "el agustino",
  "lurigancho-chosica", "lurigancho", "chosica", "san juan de lurigancho", "sjl", "santa anita",
  "chorrillos", "lurin", "pachacamac", "pucusana", "punta hermosa", "punta negra",
  "san bartolo", "san juan de miraflores", "sjm", "santa maria del mar",
  "villa el salvador", "ves", "villa maria del triunfo", "vmt"
]);

const LIMA_METRO_PHRASES = [
  "san juan de lurigancho", "san juan de miraflores", "san martin de porres",
  "villa maria del triunfo", "villa el salvador", "santiago de surco",
  "lurigancho chosica", "magdalena del mar", "santa maria del mar", "san felipe",
  "pueblo libre", "cercado de lima", "centro de lima", "san isidro", "san borja",
  "san luis", "san miguel", "la molina", "la victoria", "los olivos",
  "el agustino", "jesus maria", "santa anita", "santa rosa", "puente piedra",
  "punta hermosa", "punta negra", "san bartolo", "canto grande", "pte piedra",
  "villa maria"
];

const LIMA_METRO_TOKENS = new Set([
  "barranco", "brena", "chorrillos", "surquillo", "lince", "miraflores", "surco",
  "rimac", "ancon", "carabayllo", "comas", "independencia", "ate", "chaclacayo",
  "cieneguilla", "lurin", "pachacamac", "pucusana", "chosica", "lurigancho",
  "vitarte", "huaycan", "campoy", "zarate", "huascar", "bayovar", "chacarilla",
  "higuereta", "monterrico", "collique", "salamanca", "ceres", "huachipa",
  "manchay", "maranga", "magdalena", "molina", "olivos", "agustino", "cercado",
  "victoria", "porres", "porras", "sjl", "smp", "vmt", "ves", "sjm",
  "corpac", "orrantia", "caminos", "salaverry", "cavenecia", "huallamarca"
]);

const LIMA_FUZZY_WORDS = [
  "chorrillos", "surquillo", "miraflores", "carabayllo", "independencia",
  "chaclacayo", "cieneguilla", "pachacamac", "pucusana", "lurigancho",
  "chosica", "vitarte", "magdalena", "molina", "olivos", "agustino",
  "cercado", "santiago", "comas", "rimac", "ancon", "brena",
  "san isidro", "san borja", "san miguel", "jesus maria", "chacarilla", "monterrico",
  "higuereta", "salamanca", "huachipa", "manchay", "maranga", "orrantia", "cavenecia",
  "huallamarca", "salaverry", "caminos", "corpac"
];

const CALLAO_TOKENS = new Set(["callao", "ventanilla", "bellavista", "pachacutec", "oquendo"]);
const CALLAO_PHRASES = ["la perla", "la punta", "carmen de la legua", "carmen de la lengua", "mi peru"];
const CALLAO_FUZZY_WORDS = ["callao", "ventanilla", "bellavista"];

const DISTRICT_LOCATION_HINTS = {
  ...SAFE_DISTRICT_LOCATION_INFERENCE,
  miraflores: { province: "lima", region: "lima" },
  "santiago de surco": { province: "lima", region: "lima" },
  "san isidro": { province: "lima", region: "lima" },
  "san borja": { province: "lima", region: "lima" },
  "san miguel": { province: "lima", region: "lima" },
  "los olivos": { province: "lima", region: "lima" },
  callao: { province: "callao", region: "callao" }
};

const LIMA_ZONE_TO_DISTRICT = {
  corpac: "san isidro",
  orrantia: "san isidro",
  cavenecia: "san isidro",
  huallamarca: "san isidro",
  caminos: "san isidro",
  salaverry: "san isidro",
  chacarilla: "santiago de surco",
  monterrico: "santiago de surco",
  higuereta: "santiago de surco",
  maranga: "san miguel",
  salamanca: "ate",
  ceres: "ate",
  huaycan: "ate",
  huachipa: "lurigancho",
  manchay: "pachacamac",
  zarate: "san juan de lurigancho",
  campoy: "san juan de lurigancho",
  bayovar: "san juan de lurigancho",
  huascar: "san juan de lurigancho",
  collique: "comas",
  "san felipe": "jesus maria"
};

const LIMA_ZONE_ALIASES = {
  chacarrilla: "chacarilla",
  chacarila: "chacarilla",
  chacarillaa: "chacarilla",
  monterico: "monterrico",
  monterrico: "monterrico",
  monterriko: "monterrico",
  higareta: "higuereta",
  higuereyta: "higuereta",
  higuiereta: "higuereta",
  corpac: "corpac",
  corpak: "corpac",
  corpack: "corpac",
  orrantia: "orrantia",
  orrantya: "orrantia",
  orrantiah: "orrantia",
  cavenecia: "cavenecia",
  cavenesia: "cavenecia",
  cavenecya: "cavenecia",
  huallamarca: "huallamarca",
  wallamarca: "huallamarca",
  huayamarka: "huallamarca",
  salaberry: "salaverry",
  salavery: "salaverry",
  salavery: "salaverry",
  camimos: "caminos",
  caminos: "caminos",
  sanisidro: "san isidro",
  "san izidro": "san isidro",
  "san isidoro": "san isidro",
  monterricoo: "monterrico",
  huachipa: "huachipa",
  huachhipa: "huachipa",
  manchai: "manchay",
  salamnca: "salamanca",
  maranca: "maranga",
  jesusmaria: "jesus maria"
};

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => event.respondWith(handleRequest(event.request, globalThis)));
}

async function handleRequest(request, env = globalThis) {
  const payload = await readJson(request);

  if (payload.watchdogDebug || payload.watchdogSeed || payload.forceSweep) {
    return watchdogAdmin(payload, env);
  }

  // Admin: disparar el digest diario manualmente (force ignora compuerta/hora).
  if (payload.forceDigest || payload.digestDebug) {
    return json(await maybeRunDailyDigest(env, { force: Boolean(payload.forceDigest) }));
  }

  if (Array.isArray(payload.available_edges)) {
    const routed = await routeFollowup(payload, env);
    try { await maybeRunWatchdog(env); } catch {}
    try { await maybeRunDailyDigest(env); } catch {}
    return routed;
  }

  const input = unwrapInput(payload);
  let region = normalizePlace(input.region || input.departamento || input.department);
  let province = normalizePlace(input.province || input.provincia || input.city);
  let district = normalizePlace(input.district || input.distrito || input.zone);
  const address = normalizePlace(input.address || input.direccion || "");
  const shalomAgency = String(input.shalomAgency || input.agenciaShalom || input.shalom_agency || "").trim();

  district = canonicalizeLimaPlace(district);
  province = canonicalizeLimaPlace(province);
  region = canonicalizeLimaPlace(region);

  const normalizedLimaLocation = normalizeLimaLocation({ region, province, district });
  region = normalizedLimaLocation.region;
  province = normalizedLimaLocation.province;
  district = normalizedLimaLocation.district;

  const inferredLocation = inferLocationFromDistrict({ region, province, district });
  if (inferredLocation) {
    region = region || inferredLocation.region;
    province = province || inferredLocation.province;
  }

  const shippingText = [address, input.shippingMethod, input.metodoEnvio, input.courier, input.agency, shalomAgency].join(" ");
  const selectedCourier = detectCourier(shippingText);
  const locationIssue = detectLocationInconsistency({ region, province, district });
  if (locationIssue) {
    return json({
      cashOnDelivery: false,
      shippingMode: "needs_location_confirmation",
      locationInconsistent: true,
      shouldAskLocationConfirmation: true,
      normalized: { district, province, region },
      suggested: locationIssue.suggested,
      message: locationIssue.message,
    });
  }

  const cod = hasCashOnDelivery({ region, province, district });
  if (cod && !selectedCourier) {
    const isLimaMetro = region === "lima" || province === "lima" || region === "callao"
      || province === "callao" || isLimaMetroDistrict(district) || isCallaoDistrict(district);
    return json({
      cashOnDelivery: true,
      shippingMode: "contraentrega",
      requiresDni: false,
      requiresAdvance: false,
      advanceAmount: 0,
      couriers: [],
      normalized: { district, province, region },
      sameDayUrgent: isLimaMetro ? sameDayUrgentInfo() : null,
      message: "Zona con pago contraentrega. Puede pagar al recibir en efectivo o Yape.",
    });
  }

  if (selectedCourier === "shalom") {
    return json({
      cashOnDelivery: false,
      shippingMode: "agencia",
      courier: "Shalom",
      requiresDni: true,
      requiresAdvance: true,
      advanceAmount: 30,
      paymentRecipient: "Grupo GF SAC",
      yapePhone: "930 555 309",
      requiresFullPrepayment: false,
      balancePayment: "pickup",
      requiresShalomAgency: true,
      shalomAgency: shalomAgency || "",
      requiresVoucherBeforeConfirmation: true,
      shouldCreateOrder: false,
      normalized: { district, province, region },
      message: shalomAgency
        ? `Listo, lo enviamos a la agencia Shalom: ${shalomAgency}.\nPara separar tu pedido solo se hace un adelanto de S/30 que *va a cuenta del total* (el saldo lo pagas al recoger).\nYape: Grupo GF SAC (razón social de Aurela)\n📱 930 555 309\nTambién necesito el DNI del titular que recogerá.\nApenas me envíes el voucher, te confirmo el despacho con tu código de seguimiento Shalom ✅`
        : "Perfecto 🙌\nSí podemos enviarlo por Shalom. Para dejarlo encaminado, dime a qué agencia/oficina de Shalom deseas que llegue.\nSolo se separa con un adelanto de S/30 que *va a cuenta del total* (el saldo lo pagas al recoger) y con el voucher te confirmo el despacho ✅"
    });
  }

  if (selectedCourier === "olva") {
    return json({
      cashOnDelivery: false,
      shippingMode: "agencia",
      courier: "Olva Courier",
      requiresDni: false,
      requiresAdvance: false,
      advanceAmount: 0,
      requiresFullPrepayment: true,
      requiresExactAddress: true,
      requiresVoucherBeforeConfirmation: true,
      shouldCreateOrder: false,
      paymentRecipient: "Grupo GF SAC",
      yapePhone: "930 555 309",
      normalized: { district, province, region },
      message: "Perfecto 😊\nPor Olva Courier el pago es anticipado completo.\nPuedes realizarlo al Yape:\nGrupo GF SAC\n📱 930 555 309\nCuando lo realices, envíame el voucher o captura para continuar con la confirmación ✅"
    });
  }

  return json({
    cashOnDelivery: false,
    shippingMode: "agencia",
    requiresDni: true,
    requiresAdvance: true,
    advanceAmount: 30,
    courier: "Shalom",
    couriers: ["Shalom", "Olva"],
    paymentRecipient: "Grupo GF SAC",
    yapePhone: "930 555 309",
    requiresVoucherBeforeConfirmation: true,
    shouldCreateOrder: false,
    requiresShalomAgency: true,
    nextAction: "ask_shalom_agency",
    normalized: { district, province, region },
    message: "Sí, podemos enviarlo por Shalom 🙌\nPara dejarlo encaminado, dime a qué agencia/oficina de Shalom deseas que llegue.\nSolo se separa con un adelanto de S/30 que *va a cuenta del total* (el saldo lo pagas al recoger) y con el voucher te confirmo el despacho ✅"
  });
}

const FOLLOWUP_TERMINAL_MARKERS = [
  "orden creada", "orden_creada", "lead_perdido", "lead perdido", "handoff",
  "derivad", "no_interes", "no interes", "reclamo", "molesto", "cancel"
];

// Freno de recordatorios por NUMERO (cross-conversacion): si un cliente tiene
// varias conversaciones abiertas, cada una corre su propia escalera y lo
// "revienta" con recordatorios paralelos. Modelo de titularidad: una sola
// conversacion "duena" manda los recordatorios de ese numero; las demas se
// suprimen (ruta "esperar") mientras la duena siga activa. La titularidad se
// renueva con cada envio y caduca tras FU_OWNER_WINDOW_MS de silencio (cubre el
// gap maximo del ladder, 16h->23h = 7h), asi la duena la conserva toda su
// escalera. Si no viene id de conversacion, cae a un anti-rafaga corto por
// numero (evita textos simultaneos sin alterar la cadencia de una sola).
const FU_OWNER_WINDOW_MS = 8 * 60 * 60 * 1000; // 8 h
const FU_BURST_MS = 10 * 60 * 1000;            // 10 min (respaldo sin id)
const FU_OWNER_TTL_S = 30 * 60 * 60;           // 30 h

function extractCustomerPhone(payload, ctx) {
  const c = isPlainObject(ctx.context) ? ctx.context : {};
  let phone = c.phone_number || c.phone || "";
  if (!phone) {
    const msgs = (payload.whatsapp_context && Array.isArray(payload.whatsapp_context.messages)) ? payload.whatsapp_context.messages : [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i] || {};
      const dir = m.direction || (m.kapso && m.kapso.direction);
      if (dir === "inbound" && (m.from || m.phone_number)) { phone = m.from || m.phone_number; break; }
    }
  }
  return String(phone || "").replace(/[^\d]/g, "");
}

function extractConversationId(payload, ctx) {
  const c = isPlainObject(ctx.context) ? ctx.context : {};
  const sys = isPlainObject(ctx.system) ? ctx.system : {};
  const cands = [
    c.conversation_id, c.whatsapp_conversation_id, c.conversationId,
    sys.conversation_id, sys.execution_id, sys.flow_execution_id, sys.executionId,
    ctx.conversation_id, ctx.execution_id,
    payload.conversation_id, payload.execution_id,
  ];
  for (const v of cands) { if (v && typeof v === "string") return v; }
  const msgs = (payload.whatsapp_context && Array.isArray(payload.whatsapp_context.messages)) ? payload.whatsapp_context.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i] || {};
    const id = (m.kapso && m.kapso.whatsapp_conversation_id) || m.whatsapp_conversation_id;
    if (id) return String(id);
  }
  return "";
}

async function followupThrottleAllows(env, phone, convId, nowMs) {
  if (!env || !env.KV || !phone) return true; // sin KV/telefono: no frenar (comportamiento previo)
  const key = `fu_owner:${phone}`;
  try {
    const raw = await env.KV.get(key);
    let owner = null;
    if (raw) { try { owner = JSON.parse(raw); } catch { owner = null; } }
    const fresh = Boolean(owner && owner.ts && (nowMs - Number(owner.ts)) <= FU_OWNER_WINDOW_MS);
    if (convId) {
      // Otra conversacion es la duena y sigue activa -> suprimir esta.
      if (fresh && owner.cid && owner.cid !== convId) return false;
      await env.KV.put(key, JSON.stringify({ cid: convId, ts: nowMs }), { expirationTtl: FU_OWNER_TTL_S });
      return true;
    }
    // Sin id de conversacion: anti-rafaga (no manda dos recordatorios al mismo
    // numero en <10 min, aunque vengan de hilos distintos).
    if (fresh && (nowMs - Number(owner.ts)) < FU_BURST_MS) return false;
    await env.KV.put(key, JSON.stringify({ cid: (owner && owner.cid) || "", ts: nowMs }), { expirationTtl: FU_OWNER_TTL_S });
    return true;
  } catch {
    return true; // ante error, no frenar
  }
}

async function routeFollowup(payload, env) {
  try {
    const edges = payload.available_edges;
    const ctx = isPlainObject(payload.execution_context) ? payload.execution_context : {};
    const vars = isPlainObject(ctx.vars) ? ctx.vars : {};
    const system = isPlainObject(ctx.system) ? ctx.system : {};
    const messages = (payload.whatsapp_context && Array.isArray(payload.whatsapp_context.messages))
      ? payload.whatsapp_context.messages
      : [];
    // Auto-retry del lookup: si el agente quedo con un reintento pendiente
    // (pending_retry truthy), rutea a "reintentar" (espera corta + reintento);
    // si no, sigue el flujo normal. Default seguro = la otra rama.
    if (edges.includes("reintentar")) {
      const pending = String((vars.pending_retry != null ? vars.pending_retry : "")).trim().toLowerCase();
      const other = edges.find((e) => e !== "reintentar") || edges[0] || "";
      const on = pending && pending !== "0" && pending !== "false" && pending !== "no";
      return json({ next_edge: on ? "reintentar" : other });
    }
    if (edges.includes("timeout") && edges.includes("respondio")) return json({ next_edge: resolveResume(system, messages) });
    if (edges.includes("terminar")) {
      const stage = String(vars.stage || "").toLowerCase();
      const isTerminal = FOLLOWUP_TERMINAL_MARKERS.some((marker) => stage.includes(marker));
      return json({ next_edge: isTerminal ? "terminar" : "seguir" });
    }
    if (edges.includes("esperar")) {
      // Decision de "Horario": silencio nocturno Peru primero; luego el freno
      // por numero (una sola conversacion manda recordatorios por ventana).
      if (isQuietHourPeru()) return json({ next_edge: "esperar" });
      const phone = extractCustomerPhone(payload, ctx);
      const convId = extractConversationId(payload, ctx);
      const allowed = await followupThrottleAllows(env, phone, convId, Date.now());
      return json({ next_edge: allowed ? "enviar" : "esperar" });
    }
    return json({ next_edge: edges[0] || "" });
  } catch (error) {
    return json({ next_edge: "respondio", error: error instanceof Error ? error.message : String(error) });
  }
}

function resolveResume(system, messages) {
  const reason = system && system.last_resume && system.last_resume.reason;
  if (typeof reason === "string" && reason.length > 0) return reason === "timeout" ? "timeout" : "respondio";
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  return last && last.direction === "inbound" ? "respondio" : "timeout";
}

function isQuietHourPeru() {
  const limaHour = (new Date().getUTCHours() + 24 - 5) % 24;
  return limaHour < 7;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(request) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    return Object.fromEntries(url.searchParams.entries());
  }
  const text = await request.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { return { message: text }; }
}

function sameDayUrgentInfo() {
  const limaHour = (new Date().getUTCHours() + 24 - 5) % 24;
  if (limaHour < 10) return { limaHour, window: "antes_10", canDeliverToday: true, deliveryWindowText: "hoy", alertTeam: false };
  if (limaHour < 12) return { limaHour, window: "ventana_10_12", canDeliverToday: true, deliveryWindowText: "hoy entre las 3pm y 8pm", alertTeam: true };
  return { limaHour, window: "cerrado", canDeliverToday: false, deliveryWindowText: null, alertTeam: false };
}

function hasCashOnDelivery({ region, province, district }) {
  const candidates = [region, province].filter(Boolean);
  const placeCandidates = [district, province, region].filter(Boolean);
  if (candidates.some((item) => item === "callao")) return true;
  if (candidates.some((item) => item === "lima")) return true;
  if (district && isLimaMetroDistrict(district)) return true;
  if (district && isCallaoDistrict(district)) return true;

  for (const place of candidates) {
    const coveredDistricts = CASH_ON_DELIVERY[place];
    if (!coveredDistricts) continue;
    if (coveredDistricts.includes("*")) return true;
    if (district && coveredDistricts.includes(district)) return true;
    if (!district && coveredDistricts.includes(place)) return true;
  }

  if (!district) {
    for (const coveredDistricts of Object.values(CASH_ON_DELIVERY)) {
      if (placeCandidates.some((item) => coveredDistricts.includes(item))) return true;
    }
  }
  return false;
}

function inferLocationFromDistrict({ region, province, district }) {
  if (!district || (region && province)) return null;
  const hint = SAFE_DISTRICT_LOCATION_INFERENCE[district];
  if (!hint) return null;
  return { region: region || hint.region, province: province || hint.province };
}

function canonicalizeLimaPlace(value) {
  if (!value) return value;
  if (LIMA_ZONE_ALIASES[value]) return LIMA_ZONE_ALIASES[value];
  const text = cleanDistrictText(value);
  if (LIMA_ZONE_ALIASES[text]) return LIMA_ZONE_ALIASES[text];
  for (const [alias, canonical] of Object.entries(LIMA_ZONE_ALIASES)) {
    const maxDist = alias.length >= 10 ? 2 : 1;
    if (Math.abs(alias.length - text.length) <= maxDist && levenshtein(text, alias) <= maxDist) return canonical;
  }
  return value;
}

function normalizeLimaLocation({ region, province, district }) {
  let nextRegion = region;
  let nextProvince = province;
  let nextDistrict = district;

  if (LIMA_ZONE_TO_DISTRICT[nextDistrict]) {
    nextDistrict = LIMA_ZONE_TO_DISTRICT[nextDistrict];
    if (!nextProvince || isLimaMetroDistrict(nextProvince) || nextProvince === nextDistrict) nextProvince = "lima";
    if (!nextRegion) nextRegion = "lima";
  }

  if (isLimaMetroDistrict(nextProvince) && (!nextDistrict || !isLimaMetroDistrict(nextDistrict) || LIMA_ZONE_TO_DISTRICT[nextDistrict])) {
    if (LIMA_ZONE_TO_DISTRICT[nextDistrict]) {
      nextDistrict = LIMA_ZONE_TO_DISTRICT[nextDistrict];
    } else {
      nextDistrict = nextProvince;
    }
    nextProvince = "lima";
    if (!nextRegion) nextRegion = "lima";
  }

  if ((nextProvince === "lima" || nextRegion === "lima") && LIMA_ZONE_TO_DISTRICT[nextDistrict]) {
    nextDistrict = LIMA_ZONE_TO_DISTRICT[nextDistrict];
    nextProvince = "lima";
    if (!nextRegion) nextRegion = "lima";
  }

  return { region: nextRegion, province: nextProvince, district: nextDistrict };
}

function isLimaMetroDistrict(district) {
  if (!district) return false;
  const text = cleanDistrictText(district);
  if (!text) return false;
  if (LIMA_METRO_DISTRICTS.has(text) || LIMA_METRO_TOKENS.has(text)) return true;
  for (const phrase of LIMA_METRO_PHRASES) if (text.includes(phrase)) return true;
  const tokens = text.split(" ").filter(Boolean);
  for (const tok of tokens) {
    if (LIMA_METRO_TOKENS.has(tok) || LIMA_METRO_DISTRICTS.has(tok)) return true;
    if (tok.length >= 5) {
      for (const word of LIMA_FUZZY_WORDS) {
        const maxDist = word.length >= 10 ? 2 : 1;
        if (Math.abs(word.length - tok.length) <= maxDist && levenshtein(tok, word) <= maxDist) return true;
      }
    }
  }
  for (const known of LIMA_METRO_DISTRICTS) {
    if (known.length < 10) continue;
    const maxDist = known.length >= 12 ? 3 : 2;
    if (Math.abs(known.length - text.length) <= maxDist && levenshtein(text, known) <= maxDist) return true;
  }
  return false;
}

function isCallaoDistrict(district) {
  if (!district) return false;
  const text = cleanDistrictText(district);
  if (!text) return false;
  if (CALLAO_TOKENS.has(text)) return true;
  for (const phrase of CALLAO_PHRASES) if (text.includes(phrase)) return true;
  for (const tok of text.split(" ").filter(Boolean)) {
    if (CALLAO_TOKENS.has(tok)) return true;
    if (tok.length >= 5) {
      for (const word of CALLAO_FUZZY_WORDS) {
        const maxDist = word.length >= 10 ? 2 : 1;
        if (Math.abs(word.length - tok.length) <= maxDist && levenshtein(tok, word) <= maxDist) return true;
      }
    }
  }
  return false;
}

function cleanDistrictText(value) {
  let text = stripAccents(String(value || "").toLowerCase());
  text = text.replace(/[^a-z0-9 ]+/g, " ").replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/\b([a-z]) ([a-z]) ([a-z])\b/g, "$1$2$3");
  text = text.replace(/\b([a-z]) ([a-z])\b/g, "$1$2");
  return text.replace(/\s+/g, " ").trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

function normalizePlace(value) {
  return stripAccents(String(value || ""))
    .toLowerCase()
    .replace(/\bprovincia constitucional del callao\b/g, "callao")
    .replace(/\blima metropolitana\b/g, "lima")
    .replace(/\blim\b|\blma\b/g, "lima")
    .replace(/\bareq\b/g, "arequipa")
    .replace(/\btruj\b/g, "trujillo")
    .replace(/\bcuz\b/g, "cusco")
    .replace(/\bcuzco\b/g, "cusco")
    .replace(/\s+/g, " ")
    .trim();
}

function detectCourier(value) {
  const text = stripAccents(String(value || "")).toLowerCase();
  if (/\b(shalom|shalon|shaloom)\b/.test(text)) return "shalom";
  if (/\bolva\b/.test(text) || /\bolva\s+curier\b/.test(text) || /\bolva\s+courier\b/.test(text)) return "olva";
  return "";
}

function detectLocationInconsistency({ region, province, district }) {
  if (!district || !province) return null;
  const expected = DISTRICT_LOCATION_HINTS[district];
  if (!expected) return null;
  const provinceMismatch = province !== expected.province && province !== expected.region;
  const regionMismatch = region && region !== expected.region && region !== expected.province;
  if (!provinceMismatch && !regionMismatch) return null;
  const districtLabel = titleCasePlace(district);
  const provinceLabel = titleCasePlace(province);
  const expectedProvinceLabel = titleCasePlace(expected.province);
  const expectedRegionLabel = titleCasePlace(expected.region);
  return {
    suggested: expected,
    message: [
      "Solo para validar 😊",
      `Me indicaste distrito ${districtLabel} y provincia ${provinceLabel}, pero ${districtLabel} corresponde a ${expectedRegionLabel}.`,
      `¿Lo registramos como ${expectedProvinceLabel}, ${expectedRegionLabel}?`
    ].join("\n")
  };
}

function titleCasePlace(value) {
  return String(value || "")
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      if (part === "la") return "La";
      if (part === "de") return "de";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function unwrapInput(payload) {
  if (payload?.input && typeof payload.input === "object" && !Array.isArray(payload.input)) return payload.input;
  return payload || {};
}

function stripAccents(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

const WATCHDOG_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const WATCHDOG_MIN_SILENCE_MS = 3 * 60 * 1000;
const WATCHDOG_MAX_SILENCE_MS = 6 * 60 * 60 * 1000;
const WATCHDOG_ALERT_TTL_S = 6 * 60 * 60;
const WATCHDOG_PHONE_IDS = ["1241790819006805", "1022274334303691"];
const WATCHDOG_MAX_ALERTS = 6;
const WATCHDOG_TRIVIAL_WORDS = new Set([
  "ok", "okey", "oki", "okis", "ya", "listo", "lista", "gracias", "muchas",
  "mil", "si", "no", "buenas", "buenos", "noches", "dias", "dia", "buen",
  "buena", "tardes", "de", "nada", "senorita", "srta", "joven", "esta",
  "bien", "vale", "perfecto", "entendido", "amable", "muy"
]);

function watchdogIsTrivial(text) {
  const clean = String(text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .trim();
  if (!clean) return true;
  return clean.split(/\s+/).every((w) => WATCHDOG_TRIVIAL_WORDS.has(w));
}

async function watchdogConfig(env) {
  const g = (a, b) => env?.[a] || env?.[b] || globalThis[a] || globalThis[b];
  const cfg = {
    kapsoApiKey: g("KAPSO_API_KEY", "kAPSOAPIKEY"),
    kapsoApiBase: g("KAPSO_API_BASE", "kAPSOAPIBASE") || "https://api.kapso.ai",
    telegramToken: g("TELEGRAM_BOT_TOKEN", "tELEGRAMBOTTOKEN"),
    telegramChatId: g("TELEGRAM_CHAT_ID", "tELEGRAMCHATID"),
    // Webhook del dashboard de la tienda (POST por cada cliente esperando).
    storeWebhookUrl: g("STORE_WEBHOOK_URL", "sTOREWEBHOOKURL") || "",
    storeWebhookSecret: g("STORE_WEBHOOK_SECRET", "sTOREWEBHOOKSECRET") || "",
  };
  if (env?.KV && (!cfg.kapsoApiKey || !cfg.telegramToken || !cfg.telegramChatId)) {
    try {
      const [k, t, c] = await Promise.all([
        cfg.kapsoApiKey ? null : env.KV.get("KAPSO_API_KEY"),
        cfg.telegramToken ? null : env.KV.get("TELEGRAM_BOT_TOKEN"),
        cfg.telegramChatId ? null : env.KV.get("TELEGRAM_CHAT_ID")
      ]);
      cfg.kapsoApiKey = cfg.kapsoApiKey || k;
      cfg.telegramToken = cfg.telegramToken || t;
      cfg.telegramChatId = cfg.telegramChatId || c;
    } catch {}
  }
  return cfg;
}

// Digest diario de conversion (CTWA vs organico) al Telegram del equipo.
// Piggyback sobre el trafico de routeFollowup (como el watchdog): compuerta en KV
// una vez por dia, tras las 9:00 Lima (ayer ya suficientemente maduro). Dispara la
// funcion campaign-report (que tiene creds de Shopify) en modo digest y esa
// calcula + envia el Telegram. Aqui solo gatillamos.
async function maybeRunDailyDigest(env, { force = false } = {}) {
  if (!env?.KV) return { ran: false, reason: "no_kv" };
  const limaHour = (new Date().getUTCHours() + 24 - 5) % 24;
  if (!force && limaHour < 9) return { ran: false, reason: "too_early" };
  const limaNow = new Date(Date.now() - 5 * 3600 * 1000);
  const y = new Date(limaNow); y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);
  const key = `digest:sent:${yesterday}`;
  if (!force && await env.KV.get(key)) return { ran: false, reason: "already_sent", day: yesterday };

  // kapso + telegram desde watchdogConfig (env + fallback KV, ya probado por el
  // watchdog). dash + id de campaign-report: env o KV.
  const cfg = await watchdogConfig(env);
  const g = (a, b) => env?.[a] || env?.[b] || globalThis[a] || globalThis[b];
  let dash = g("DASHBOARD_ACCESS_KEY", "dASHBOARDACCESSKEY");
  let crId = g("CAMPAIGN_REPORT_FUNCTION_ID", "cAMPAIGNREPORTFUNCTIONID");
  try {
    if (!dash) dash = await env.KV.get("DASHBOARD_ACCESS_KEY");
    if (!crId) crId = await env.KV.get("CAMPAIGN_REPORT_FUNCTION_ID");
  } catch {}
  if (!cfg.kapsoApiKey || !dash || !crId) return { ran: false, reason: "missing_config", day: yesterday };

  // Marca ANTES de disparar: evita duplicados si hay reintentos concurrentes.
  await env.KV.put(key, String(Date.now()), { expirationTtl: 60 * 60 * 48 });
  try {
    // Pasa TODO como params (dash, kapso, telegram): asi campaign-report no depende
    // de que sus propias claves esten inyectadas en su env.
    const res = await fetch(`${cfg.kapsoApiBase}/platform/v1/functions/${crId}/invoke`, {
      method: "POST",
      headers: { "X-API-Key": cfg.kapsoApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        period: "yesterday", digest: true, key: dash, kapso_key: cfg.kapsoApiKey,
        telegram_token: cfg.telegramToken, telegram_chat_id: cfg.telegramChatId,
      }),
    });
    return { ran: true, day: yesterday, status: res.status };
  } catch (error) {
    return { ran: true, day: yesterday, error: error instanceof Error ? error.message : String(error) };
  }
}

async function maybeRunWatchdog(env, { force = false } = {}) {
  if (!env?.KV) return { ran: false, reason: "no_kv" };
  if (!force && isQuietHourPeru()) return { ran: false, reason: "quiet_hours" };
  const now = Date.now();
  if (!force) {
    const last = Number(await env.KV.get("watchdog:last_sweep") || 0);
    if (now - last < WATCHDOG_SWEEP_INTERVAL_MS) return { ran: false, reason: "gated" };
  }
  await env.KV.put("watchdog:last_sweep", String(now), { expirationTtl: 3600 });
  const cfg = await watchdogConfig(env);
  if (!cfg.kapsoApiKey || !cfg.telegramToken || !cfg.telegramChatId) return { ran: false, reason: "missing_credentials" };
  return watchdogSweep(cfg, env, now);
}

async function watchdogSweep(cfg, env, now) {
  const sinceIso = new Date(now - WATCHDOG_MAX_SILENCE_MS).toISOString();
  const candidates = [];
  for (const phoneId of WATCHDOG_PHONE_IDS) {
    let cursor = null;
    for (let page = 0; page < 3; page += 1) {
      let url = `${cfg.kapsoApiBase}/platform/v1/whatsapp/conversations?phone_number_id=${encodeURIComponent(phoneId)}&status=active&last_active_after=${encodeURIComponent(sinceIso)}&limit=100`;
      if (cursor) url += `&after=${encodeURIComponent(cursor)}`;
      let payload;
      try {
        const res = await fetch(url, { headers: { "X-API-Key": cfg.kapsoApiKey } });
        if (!res.ok) break;
        payload = await res.json();
      } catch { break; }

      for (const convo of payload?.data || []) {
        const k = convo.kapso || {};
        const lastIn = Date.parse(k.last_inbound_at || "");
        const lastOut = Date.parse(k.last_outbound_at || "");
        if (!Number.isFinite(lastIn)) continue;
        if (Number.isFinite(lastOut) && lastOut >= lastIn) continue;
        const silence = now - lastIn;
        if (silence < WATCHDOG_MIN_SILENCE_MS || silence > WATCHDOG_MAX_SILENCE_MS) continue;
        const text = String(k.last_message_text || "").trim();
        if (/^Reacted with /i.test(text)) continue;
        if (watchdogIsTrivial(text)) continue;
        candidates.push({ id: convo.id, name: k.contact_name || convo.phone_number || "?", phone: convo.phone_number || "", minutes: Math.round(silence / 60000), text: text.slice(0, 80) });
      }
      cursor = payload?.paging?.cursors?.after || null;
      if (!cursor || !(payload?.data || []).length) break;
    }
  }

  const fresh = [];
  for (const c of candidates) {
    const key = `watchdog:alerted:${c.id}`;
    if (await env.KV.get(key)) continue;
    fresh.push(c);
    await env.KV.put(key, "1", { expirationTtl: WATCHDOG_ALERT_TTL_S });
    if (fresh.length >= WATCHDOG_MAX_ALERTS) break;
  }
  if (fresh.length === 0) return { ran: true, candidates: candidates.length, alerted: 0 };

  // Aviso al dashboard de la tienda por cada cliente esperando (best-effort,
  // antes del envio a Telegram). No-op si no hay STORE_WEBHOOK_URL configurada.
  for (const c of fresh) {
    await postWaitingAlert(cfg, c);
  }

  const lines = fresh.map((c) => `• *${c.name}* (+${c.phone}) — ${c.minutes} min esperando\n  _"${c.text}"_`);
  const text = `⚠️ *Clientes esperando respuesta* (bot en silencio >3 min)\n\n${lines.join("\n")}\n\nEntra a Kapso para atenderlos.`;
  // Destinatario(s) principal(es) + adicionales fijos (cada uno debe haber iniciado el bot).
  const EXTRA_TELEGRAM_CHAT_IDS = ["8844863582"];
  const wdRecipients = [...new Set([cfg.telegramChatId, ...EXTRA_TELEGRAM_CHAT_IDS].filter(Boolean).map((s) => String(s)))];
  for (const chatId of wdRecipients) {
    try {
      await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
      });
    } catch {}
  }
  return { ran: true, candidates: candidates.length, alerted: fresh.length };
}

// Firma HMAC-SHA256 (hex) del cuerpo con el secret, para que el dashboard valide
// el POST igual que valida los webhooks de Kapso. Best-effort.
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

// POST al dashboard por un cliente que quedo esperando (bot en silencio). URL y
// secret salen del entorno (STORE_WEBHOOK_URL / STORE_WEBHOOK_SECRET); si no hay
// URL es no-op. No afecta el envio a Telegram.
async function postWaitingAlert(cfg, c) {
  const url = cfg.storeWebhookUrl;
  if (!url) return;
  const body = JSON.stringify({
    event: "conversation.waiting",
    phone_number: c.phone || "",
    conversation_id: c.id || "",
    reason: "bot_silent",
    context_summary: String(c.text || "").replace(/\s+/g, " ").trim(),
    minutes_waiting: c.minutes,
  });
  const headers = { "Content-Type": "application/json" };
  if (cfg.storeWebhookSecret) {
    headers["X-Webhook-Secret"] = cfg.storeWebhookSecret;
    const sig = await hmacHex(cfg.storeWebhookSecret, body);
    if (sig) headers["X-Kapso-Signature"] = sig;
  }
  try {
    await fetch(url, { method: "POST", headers, body });
  } catch {}
}

async function watchdogAdmin(payload, env) {
  if (payload.watchdogSeed && typeof payload.watchdogSeed === "object") {
    if (!env?.KV) return json({ ok: false, reason: "no_kv" });
    const allowed = ["KAPSO_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "DASHBOARD_ACCESS_KEY", "CAMPAIGN_REPORT_FUNCTION_ID"];
    const saved = [];
    for (const key of allowed) {
      const value = payload.watchdogSeed[key];
      if (typeof value === "string" && value.trim()) {
        await env.KV.put(key, value.trim());
        saved.push(key);
      }
    }
    return json({ ok: true, seeded: saved });
  }
  if (payload.forceSweep) {
    const result = await maybeRunWatchdog(env, { force: true });
    return json({ ok: true, ...result });
  }
  const cfg = await watchdogConfig(env);
  return json({ ok: true, kv: Boolean(env?.KV), kapsoApiKey: Boolean(cfg.kapsoApiKey), telegramToken: Boolean(cfg.telegramToken), telegramChatId: Boolean(cfg.telegramChatId), quietHours: isQuietHourPeru() });
}

globalThis.__aurelaCheckCoverage = {
  maybeRunWatchdog,
  maybeRunDailyDigest,
  watchdogSweep,
  watchdogConfig,
  postWaitingAlert,
  hmacHex,
  followupThrottleAllows,
  extractConversationId,
  extractCustomerPhone,
  routeFollowup,
  canonicalizeLimaPlace,
  cleanDistrictText,
  detectCourier,
  detectLocationInconsistency,
  handleRequest,
  handler,
  hasCashOnDelivery,
  inferLocationFromDistrict,
  isCallaoDistrict,
  isLimaMetroDistrict,
  levenshtein,
  normalizeLimaLocation,
  normalizePlace
};
