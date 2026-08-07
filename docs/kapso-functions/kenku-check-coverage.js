async function handler(request, env) {
  return handleRequest(request, env || globalThis);
}

const CASH_ON_DELIVERY = {
  lima: ["lima metropolitana", "lima", "*"],
  callao: ["callao", "*"],
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
  // Solo Cusco ciudad (distrito cusco / provincia cusco). Otros distritos de la
  // region (Wanchaq, San Sebastian, etc.) requieren validacion antes de agregarse.
  cusco: ["cusco"],
  apurimac: ["abancay"],
};

// Distritos no ambiguos donde podemos inferir provincia/region si el agente
// solo envia district. No incluimos "la victoria" porque tambien existe en Lima.
// Los distritos de Ancash listados como sin contraentrega tambien se infieren
// para que el fallback a agencia quede normalizado correctamente.
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
  chiclayo: { province: "chiclayo", region: "lambayeque" },
  "jose leonardo ortiz": { province: "chiclayo", region: "lambayeque" },
  lambayeque: { province: "lambayeque", region: "lambayeque" },
  pimentel: { province: "chiclayo", region: "lambayeque" },
  juliaca: { province: "san roman", region: "puno" },
  tarapoto: { province: "san martin", region: "san martin" },
  huancayo: { province: "huancayo", region: "junin" },
  ayacucho: { province: "huamanga", region: "ayacucho" },
  "jesus nazareno": { province: "huamanga", region: "ayacucho" },
  iquitos: { province: "maynas", region: "loreto" },
  viru: { province: "viru", region: "la libertad" },
  chao: { province: "viru", region: "la libertad" },
  tacna: { province: "tacna", region: "tacna" },
  pucallpa: { province: "coronel portillo", region: "ucayali" },
  abancay: { province: "abancay", region: "apurimac" },
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

// Los 43 distritos de Lima Metropolitana tienen contraentrega. El cliente
// suele dar solo el distrito (ej. "San Juan de Lurigancho", "Breña") sin la
// provincia/region, asi que reconocemos el distrito por nombre para no caer al
// fallback de agencia. Nombres normalizados (sin acentos, minusculas).
const LIMA_METRO_DISTRICTS = new Set([
  // Lima Centro
  "barranco", "brena", "cercado de lima", "jesus maria", "la victoria", "lima",
  "lince", "magdalena del mar", "miraflores", "pueblo libre", "rimac",
  "san borja", "san isidro", "san luis", "san miguel", "santiago de surco", "surco", "surquillo",
  // Lima Norte
  "ancon", "carabayllo", "comas", "independencia", "los olivos", "puente piedra",
  "san martin de porres", "smp", "santa rosa",
  // Lima Este
  "ate", "ate vitarte", "vitarte", "chaclacayo", "cieneguilla", "el agustino",
  "lurigancho-chosica", "lurigancho", "chosica", "san juan de lurigancho", "sjl", "santa anita",
  // Lima Sur
  "chorrillos", "lurin", "pachacamac", "pucusana", "punta hermosa", "punta negra",
  "san bartolo", "san juan de miraflores", "sjm", "santa maria del mar",
  "villa el salvador", "ves", "villa maria del triunfo", "vmt",
]);

// Nombres de distrito de >=2 palabras (y referencias frecuentes) que el cliente
// suele escribir DENTRO de una frase mas larga, p.ej. "av pezet 131 san isidro"
// o "lima/lima/santiago de surco". Se buscan por contencion de substring; todos
// son lo bastante especificos como para no producir falsos positivos.
const LIMA_METRO_PHRASES = [
  "san juan de lurigancho", "san juan de miraflores", "san martin de porres",
  "villa maria del triunfo", "villa el salvador", "santiago de surco",
  "lurigancho chosica", "magdalena del mar", "santa maria del mar",
  "pueblo libre", "cercado de lima", "centro de lima", "san isidro", "san borja",
  "san luis", "san miguel", "la molina", "la victoria", "los olivos",
  "el agustino", "jesus maria", "santa anita", "santa rosa", "puente piedra",
  "punta hermosa", "punta negra", "san bartolo", "canto grande", "pte piedra",
  "villa maria",
];

// Tokens de una sola palabra que identifican un distrito de Lima Metropolitana,
// incluyendo abreviaturas y anexos/urbanizaciones conocidas (campoy/zarate=SJL,
// huaycan/salamanca/ceres/santa clara/vitarte/huachipa=Ate, collique=Comas,
// chacarilla/higuereta/monterrico=Surco, maranga=San Miguel). Se evaluan como
// palabra completa, nunca como substring, para no matchear dentro de otra palabra.
const LIMA_METRO_TOKENS = new Set([
  "barranco", "brena", "chorrillos", "surquillo", "lince", "miraflores", "surco",
  "rimac", "ancon", "carabayllo", "comas", "independencia", "ate", "chaclacayo",
  "cieneguilla", "lurin", "pachacamac", "pucusana", "chosica", "lurigancho",
  "vitarte", "huaycan", "campoy", "zarate", "huascar", "bayovar", "chacarilla",
  "higuereta", "monterrico", "collique", "salamanca", "ceres", "huachipa",
  "manchay", "maranga", "magdalena", "molina", "olivos", "agustino", "cercado",
  "victoria", "porres", "porras",
  "sjl", "smp", "vmt", "ves", "sjm",
]);

// Nombres largos de una palabra usados solo para tolerancia a typos (Levenshtein
// por token). No incluye palabras cortas (<5) para evitar falsos positivos.
// "barranco" se omite a proposito: su unico typo plausible ("barranca") es una
// provincia distinta al norte de Lima, asi que solo se acepta exacto (via tokens).
const LIMA_FUZZY_WORDS = [
  "chorrillos", "surquillo", "miraflores", "carabayllo",
  "independencia", "chaclacayo", "cieneguilla", "pachacamac", "pucusana",
  "lurigancho", "chosica", "vitarte", "magdalena", "molina", "olivos",
  "agustino", "cercado", "santiago", "comas", "rimac", "ancon", "brena",
];

// Callao es provincia aparte de Lima, pero tiene contraentrega a todo el Callao.
// Si el cliente da solo el distrito del Callao (sin provincia) lo reconocemos aca.
const CALLAO_TOKENS = new Set(["callao", "ventanilla", "bellavista", "pachacutec", "oquendo"]);
const CALLAO_PHRASES = ["la perla", "la punta", "carmen de la legua", "carmen de la lengua", "mi peru"];
const CALLAO_FUZZY_WORDS = ["callao", "ventanilla", "bellavista"];

const DISTRICT_LOCATION_HINTS = {
  chimbote: { province: "santa", region: "ancash" },
  "nuevo chimbote": { province: "santa", region: "ancash" },
  coishco: { province: "santa", region: "ancash" },
  santa: { province: "santa", region: "ancash" },
  casma: { province: "casma", region: "ancash" },
  huarmey: { province: "huarmey", region: "ancash" },
  caraz: { province: "huaylas", region: "ancash" },
  yungay: { province: "yungay", region: "ancash" },
  carhuaz: { province: "carhuaz", region: "ancash" },
  huaraz: { province: "huaraz", region: "ancash" },
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
  "jacobo hunter": { province: "arequipa", region: "arequipa" },
  miraflores: { province: "lima", region: "lima" },
  "santiago de surco": { province: "lima", region: "lima" },
  "san isidro": { province: "lima", region: "lima" },
  "san borja": { province: "lima", region: "lima" },
  "san miguel": { province: "lima", region: "lima" },
  "los olivos": { province: "lima", region: "lima" },
  callao: { province: "callao", region: "callao" },
  chiclayo: { province: "chiclayo", region: "lambayeque" },
  "jose leonardo ortiz": { province: "chiclayo", region: "lambayeque" },
  lambayeque: { province: "lambayeque", region: "lambayeque" },
  pimentel: { province: "chiclayo", region: "lambayeque" },
  juliaca: { province: "san roman", region: "puno" },
  abancay: { province: "abancay", region: "apurimac" },
  piura: { province: "piura", region: "piura" },
  castilla: { province: "piura", region: "piura" },
  catacaos: { province: "piura", region: "piura" },
  "26 de octubre": { province: "piura", region: "piura" },
  sullana: { province: "sullana", region: "piura" },
  talara: { province: "talara", region: "piura" },
};

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}

async function handleRequest(request, env = globalThis) {
  const payload = await readJson(request);

  // Debug/mantenimiento del watchdog (invocacion directa con X-API-Key).
  if (payload.watchdogDebug || payload.watchdogSeed || payload.forceSweep) {
    return watchdogAdmin(payload, env);
  }

  // Follow-up ladder routing: when invoked by a Decide node, the payload carries
  // `available_edges`. Coverage tool calls never include it, so this branch is
  // inert for the normal coverage flow.
  if (Array.isArray(payload.available_edges)) {
    // El ladder invoca esto constantemente: aprovechamos para correr el watchdog
    // de clientes sin respuesta (compuerta KV: max 1 barrido cada 10 min).
    const routed = await routeFollowup(payload, env);
    try { await maybeRunWatchdog(env); } catch { /* nunca romper el ruteo */ }
    return routed;
  }

  const input = unwrapInput(payload);
  let region = normalizePlace(input.region || input.departamento || input.department);
  let province = normalizePlace(input.province || input.provincia);
  let district = normalizePlace(input.district || input.distrito || input.zone);
  // En conversacion el cliente suele dar una "ciudad" aunque logisticamente
  // corresponda a un distrito (Juliaca, Tarapoto, Huancayo, etc.). La tratamos
  // primero como localidad/distrito para aprovechar la inferencia segura. Si el
  // agente ya envio district, ese valor siempre tiene prioridad.
  const singlePlace = normalizePlace(input.city || input.ciudad || input.place || input.ubicacion);
  if (!district && singlePlace) district = singlePlace;
  const address = normalizePlace(input.address || input.direccion || "");
  const shalomAgencyRaw = String(input.shalomAgency || input.agenciaShalom || input.shalom_agency || "").trim();

  const inferredLocation = inferLocationFromDistrict({ region, province, district });
  if (inferredLocation) {
    region = region || inferredLocation.region;
    province = province || inferredLocation.province;
  }
  const shalomAgency = isSpecificShalomAgency(shalomAgencyRaw, { district, province, region })
    ? shalomAgencyRaw
    : "";

  const shippingText = [address, input.shippingMethod, input.metodoEnvio, input.courier, input.agency, shalomAgency].join(" ");
  const selectedCourier = detectCourier(shippingText);
  // Solo un courier EXPLICITO (Shalom/Olva) desvia a agencia. Mencionar
  // "agencia"/"oficina" NO bloquea la contraentrega: un cliente preguntando
  // "¿tienes oficina en Trujillo?" debe recibir contraentrega si su zona la tiene.
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

  // Nunca asumir envio por agencia solo porque la ubicacion esta incompleta.
  // Devolvemos exactamente los campos faltantes para que el agente pregunte
  // una sola vez y conserve todo lo que ya normalizo la herramienta.
  const missingLocationFields = [];
  if (!district) missingLocationFields.push("district");
  if (district && !province && !region) missingLocationFields.push("province");
  if (missingLocationFields.length > 0) {
    const districtLabel = district ? titleCasePlace(district) : "";
    const message = !district
      ? "Para confirmar la entrega, solo falta el distrito o ciudad de destino."
      : `Ya registre ${districtLabel}. Solo falta la provincia o departamento para confirmar la entrega.`;
    return json({
      cashOnDelivery: false,
      shippingMode: "needs_location",
      locationComplete: false,
      missingLocationFields,
      normalized: { district, province, region },
      message,
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
      paymentMethods: ["efectivo", "tarjeta de credito/debito", "Yape", "Plin", "transferencia bancaria"],
      message: "Zona con pago contraentrega. Puede pagar al recibir en efectivo, tarjeta (credito/debito), Yape, Plin o transferencia bancaria (lo mas comun: efectivo y Yape).",
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
      agencySpecific: Boolean(shalomAgency),
      requiresVoucherBeforeConfirmation: true,
      shouldCreateOrder: false,
      normalized: { district, province, region },
      message: shalomAgency
        ? `Listo, lo enviamos a la agencia Shalom: ${shalomAgency}.\nPara separar tu pedido solo se hace un adelanto de S/30 que *va a cuenta del total* (el saldo lo pagas al recoger).\nYape: Grupo GF SAC (razón social de Kenku)\n📱 930 555 309\nEnvíame el voucher o captura y te confirmo la recepción ✅`
        : "Perfecto 🙌\nSí podemos enviarlo por Shalom. Para dejarlo encaminado, dime a qué agencia/oficina de Shalom deseas que llegue.\nSolo se separa con un adelanto de S/30 que *va a cuenta del total* (el saldo lo pagas al recoger) y con el voucher te confirmo el despacho ✅",
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
      message: "Perfecto 😊\nPor Olva Courier el pago es anticipado completo.\nPuedes realizarlo al Yape:\nGrupo GF SAC\n📱 930 555 309\nCuando lo realices, envíame el voucher o captura para continuar con la confirmación ✅",
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
    message: "Sí, podemos enviarlo por Shalom 🙌\nPara dejarlo encaminado, dime a qué agencia/oficina de Shalom deseas que llegue.\nSolo se separa con un adelanto de S/30 que *va a cuenta del total* (el saldo lo pagas al recoger) y con el voucher te confirmo el despacho ✅",
  });
}

// ----- Follow-up ladder decide routing -----
// Serves three decide types, detected by available_edges:
//   resume reason  -> ["respondio", "timeout"]
//   terminal check -> ["seguir", "terminar"]
//   quiet hours    -> ["enviar", "esperar"]  (Peru UTC-5, quiet 00:00-06:59)
const FOLLOWUP_TERMINAL_MARKERS = [
  "orden creada",
  "orden_creada",
  "lead_perdido",
  "lead perdido",
  "handoff",
  "derivad",
  "no_interes",
  "no interes",
  "reclamo",
  "molesto",
  "cancel",
];

async function routeFollowup(payload, env) {
  try {
    const edges = payload.available_edges;
    const ctx = isPlainObject(payload.execution_context) ? payload.execution_context : {};
    const vars = isPlainObject(ctx.vars) ? ctx.vars : {};
    const system = isPlainObject(ctx.system) ? ctx.system : {};
    const messages = (payload.whatsapp_context && Array.isArray(payload.whatsapp_context.messages))
      ? payload.whatsapp_context.messages
      : [];

    // Una ejecucion vieja de seguimiento no debe seguir enviando mensajes si
    // otra ejecucion ya atendio un inbound mas reciente. La mandamos por la
    // ruta respondio; loop-guard compara la generacion y la termina en silencio.
    if (edges.includes("respondio") && await hasNewerFollowupGeneration(payload, vars, env)) {
      // fu-terminal (respondio+seguir+terminar): termina la ejecucion stale por
      // "terminar" (-> fu-end) en vez de "respondio", que en fu-terminal vuelve
      // al agente y hace loop hasta el tope de pasos por tick (email "Failed").
      // Los decides de resume (respondio+timeout, sin "terminar") no cambian.
      if (edges.includes("terminar")) {
        return json({ next_edge: "terminar", reason: "stale_followup_generation" });
      }
      return json({ next_edge: "respondio", reason: "stale_followup_generation" });
    }

    if (edges.includes("timeout") && edges.includes("respondio")) {
      // El motivo de reanudacion incluido por Kapso puede llegar desfasado si
      // el cliente escribe durante la transicion al wait. El historial vivo es
      // la fuente de verdad: si el inbound es mas reciente, siempre se atiende.
      if (await hasLiveUnansweredInbound(payload, env)) {
        return json({ next_edge: "respondio", reason: "live_unanswered_inbound_before_timeout" });
      }
      return json({ next_edge: resolveResume(system, messages) });
    }

    if (edges.includes("terminar")) {
      const stage = String(vars.stage || "").toLowerCase();
      const isTerminal = FOLLOWUP_TERMINAL_MARKERS.some((marker) => stage.includes(marker));
      if (isTerminal) return json({ next_edge: "terminar" });
      if (edges.includes("respondio") && await hasLiveUnansweredInbound(payload, env)) {
        return json({ next_edge: "respondio", reason: "live_unanswered_inbound" });
      }
      return json({ next_edge: "seguir" });
    }

    if (edges.includes("esperar")) {
      return json({ next_edge: isQuietHourPeru() ? "esperar" : "enviar" });
    }

    return json({ next_edge: edges[0] || "" });
  } catch (error) {
    return json({ next_edge: "respondio", error: error instanceof Error ? error.message : String(error) });
  }
}

async function hasNewerFollowupGeneration(payload, vars, env) {
  if (!env?.KV) return false;
  const { conversationId } = conversationContext(payload);
  const executionGeneration = String(vars.followup_generation || "");
  if (!conversationId) return false;
  try {
    const latest = String(await env.KV.get(`followup_generation:${conversationId}`) || "");
    if (!latest) return false;
    // Compatibilidad con ejecuciones creadas antes del versionado: si no traen
    // generacion pero ya existe una nueva en KV, son heredadas y deben morir.
    // Las ejecuciones nuevas siempre reciben followup_generation desde loop-guard.
    if (!executionGeneration) return true;
    return latest !== executionGeneration;
  } catch {
    return false;
  }
}

async function hasLiveUnansweredInbound(payload, env) {
  const { conversationId, phoneNumberId } = conversationContext(payload);
  const cfg = await watchdogConfig(env);
  if (!conversationId || !phoneNumberId || !cfg.kapsoApiKey) return false;
  try {
    const url = `${cfg.kapsoApiBase}/meta/whatsapp/v24.0/${encodeURIComponent(phoneNumberId)}/messages`
      + `?conversation_id=${encodeURIComponent(conversationId)}&limit=20`;
    const response = await fetch(url, { headers: { "X-API-Key": cfg.kapsoApiKey } });
    if (!response.ok) return false;
    const body = await response.json();
    let lastInbound = 0;
    let lastOutbound = 0;
    for (const message of body?.data || []) {
      const timestamp = Number(message?.timestamp || 0);
      if (message?.kapso?.direction === "inbound") lastInbound = Math.max(lastInbound, timestamp);
      if (message?.kapso?.direction === "outbound") lastOutbound = Math.max(lastOutbound, timestamp);
    }
    return lastInbound > lastOutbound;
  } catch {
    return false;
  }
}

function conversationContext(payload) {
  const conversation = payload.whatsapp_context?.conversation || {};
  return {
    conversationId: conversation.id || payload.execution_context?.context?.conversation_id || "",
    phoneNumberId: conversation.phone_number_id
      || payload.execution_context?.system?.whatsapp_config?.phone_number_id
      || payload.execution_context?.context?.phone_number_id
      || "",
  };
}

function resolveResume(system, messages) {
  const reason = system && system.last_resume && system.last_resume.reason;
  if (typeof reason === "string" && reason.length > 0) {
    return reason === "timeout" ? "timeout" : "respondio";
  }
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  if (last && last.direction === "inbound") return "respondio";
  return "timeout";
}

function isQuietHourPeru() {
  const limaHour = (new Date().getUTCHours() + 24 - 5) % 24;
  return limaHour < 7; // 00:00-06:59 -> quiet
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
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

// Ventana de entrega urgente HOY (solo Lima Metropolitana, contraentrega).
// Peru = UTC-5. Corte exacto en horas enteras: 10:00 y 12:00.
function sameDayUrgentInfo() {
  const limaHour = (new Date().getUTCHours() + 24 - 5) % 24;
  if (limaHour < 10) {
    return { limaHour, window: "antes_10", canDeliverToday: true, deliveryWindowText: "hoy", alertTeam: false };
  }
  if (limaHour < 12) {
    return { limaHour, window: "ventana_10_12", canDeliverToday: true, deliveryWindowText: "hoy entre las 3pm y 8pm", alertTeam: true };
  }
  return { limaHour, window: "cerrado", canDeliverToday: false, deliveryWindowText: null, alertTeam: false };
}

function hasCashOnDelivery({ region, province, district }) {
  const candidates = [region, province].filter(Boolean);
  const placeCandidates = [district, province, region].filter(Boolean);

  if (candidates.some((item) => item === "callao")) return true;
  if (candidates.some((item) => item === "lima")) return true;

  // El cliente dio solo el distrito (sin provincia/region): si es un distrito de
  // Lima Metropolitana o del Callao, igual tiene contraentrega.
  if (district && isLimaMetroDistrict(district)) return true;
  if (district && isCallaoDistrict(district)) return true;

  for (const place of candidates) {
    const coveredDistricts = CASH_ON_DELIVERY[place];
    if (!coveredDistricts) continue;
    if (coveredDistricts.includes("*")) return true;
    if (district && coveredDistricts.includes(district)) return true;
    if (!district && coveredDistricts.includes(place)) return true;
  }

  // Si el agente mapea una ciudad/distrito como province o region (ej. "Piura",
  // "Sullana", "Talara") sin enviar district, igual validamos contra la matriz.
  if (!district) {
    for (const coveredDistricts of Object.values(CASH_ON_DELIVERY)) {
      if (placeCandidates.some((item) => coveredDistricts.includes(item))) return true;
    }
  }

  return false;
}

function inferLocationFromDistrict({ region, province, district }) {
  if (!district || (region && province)) return null;
  if (isLimaMetroDistrict(district)) {
    return { region: region || "lima", province: province || "lima" };
  }
  if (isCallaoDistrict(district)) {
    return { region: region || "callao", province: province || "callao" };
  }
  const hint = SAFE_DISTRICT_LOCATION_INFERENCE[district];
  if (!hint) return null;
  return {
    region: region || hint.region,
    province: province || hint.province,
  };
}

// Reconoce un distrito de Lima Metropolitana tolerando errores de tipeo del
// cliente (ej. "San juam de lurigancho" -> "san juan de lurigancho"). Usa
// distancia de edicion solo en nombres largos para evitar falsos positivos en
// abreviaturas cortas ("sjl", "ate", "ves", "vmt", "sjm").
function isLimaMetroDistrict(district) {
  if (!district) return false;
  const text = cleanDistrictText(district);
  if (!text) return false;

  // 1) match exacto del string completo o de una abreviatura conocida.
  if (LIMA_METRO_DISTRICTS.has(text) || LIMA_METRO_TOKENS.has(text)) return true;

  // 2) frase multi-palabra contenida en el texto (cliente pega direccion +
  //    distrito, "lima/lima/X", referencias, etc.).
  for (const phrase of LIMA_METRO_PHRASES) {
    if (text.includes(phrase)) return true;
  }

  // 3) por token: palabra completa exacta, alias/anexo, o typo (Levenshtein).
  const tokens = text.split(" ").filter(Boolean);
  for (const tok of tokens) {
    if (LIMA_METRO_TOKENS.has(tok) || LIMA_METRO_DISTRICTS.has(tok)) return true;
    if (tok.length >= 5) {
      for (const word of LIMA_FUZZY_WORDS) {
        const maxDist = word.length >= 10 ? 2 : 1;
        if (Math.abs(word.length - tok.length) > maxDist) continue;
        if (levenshtein(tok, word) <= maxDist) return true;
      }
    }
  }

  // 4) fuzzy del string completo contra nombres largos de >=2 palabras (typos en
  //    "santiago de surc", "villa maria del trinfo"). Se limita a nombres de >=10
  //    letras: los cortos ya los cubre el match por token y abrirlos a fuzzy
  //    genera falsos positivos (p.ej. "barranca", provincia distinta, vs barranco).
  for (const known of LIMA_METRO_DISTRICTS) {
    if (known.length < 10) continue;
    const maxDist = known.length >= 12 ? 3 : 2;
    if (Math.abs(known.length - text.length) > maxDist) continue;
    if (levenshtein(text, known) <= maxDist) return true;
  }

  return false;
}

// Reconoce un distrito del Callao (provincia aparte de Lima) cuando el cliente
// da solo el distrito sin la provincia. Todo el Callao tiene contraentrega.
function isCallaoDistrict(district) {
  if (!district) return false;
  const text = cleanDistrictText(district);
  if (!text) return false;
  if (CALLAO_TOKENS.has(text)) return true;
  for (const phrase of CALLAO_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  for (const tok of text.split(" ").filter(Boolean)) {
    if (CALLAO_TOKENS.has(tok)) return true;
    if (tok.length >= 5) {
      for (const word of CALLAO_FUZZY_WORDS) {
        const maxDist = word.length >= 10 ? 2 : 1;
        if (Math.abs(word.length - tok.length) > maxDist) continue;
        if (levenshtein(tok, word) <= maxDist) return true;
      }
    }
  }
  return false;
}

// Limpia el texto del distrito que escribe el cliente antes de compararlo:
// elimina separadores tipo "Lima/Lima/X", viñetas y prefijos basura, numeros
// sueltos, y colapsa abreviaturas deletreadas ("s j l" / "s.j.l" -> "sjl").
// Asume entrada ya normalizada (minusculas, sin acentos) por normalizePlace.
function cleanDistrictText(value) {
  let text = stripAccents(String(value || "").toLowerCase());
  text = text.replace(/[^a-z0-9 ]+/g, " ");
  text = text.replace(/\b\d+\b/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  // Colapsar abreviaturas deletreadas DESPUES de unificar espacios, para que
  // "s. j. l." (que deja doble espacio al quitar los puntos) tambien funcione.
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

function isSpecificShalomAgency(value, location = {}) {
  const text = normalizePlace(value);
  if (!text) return false;
  const generic = new Set([
    "shalom", "agencia", "agencia shalom", "oficina", "oficina shalom",
    "si", "esa", "esa agencia", "la agencia", "terminal", "por shalom",
  ]);
  if (generic.has(text)) return false;
  const knownPlace = SAFE_DISTRICT_LOCATION_INFERENCE[text]
    || text === normalizePlace(location.district)
    || text === normalizePlace(location.province)
    || text === normalizePlace(location.region);
  if (knownPlace) return false;
  // Una oficina concreta suele incluir sede, avenida, terminal, distrito o un
  // nombre propio adicional. Exigimos al menos dos tokens informativos.
  const tokens = text.split(/\s+/).filter((token) => !["shalom", "agencia", "oficina", "de", "la", "el"].includes(token));
  return tokens.length >= 2 || (tokens.length === 1 && tokens[0].length >= 5);
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
      `¿Lo registramos como ${expectedProvinceLabel}, ${expectedRegionLabel}?`,
    ].join("\n"),
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
  if (payload?.input && typeof payload.input === "object" && !Array.isArray(payload.input)) {
    return payload.input;
  }
  return payload || {};
}

function stripAccents(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ============================================================================
// Watchdog de clientes sin respuesta
// Detecta conversaciones donde el CLIENTE hablo ultimo y el bot lleva >3 min
// en silencio (agente colgado, error, etc.) y alerta al equipo por Telegram.
// Se dispara aprovechando que el ladder de seguimientos invoca esta funcion
// constantemente; una compuerta en KV limita el barrido a 1 vez cada 2 min.
// Credenciales: env/globalThis (runtime_config) con fallback a KV del proyecto.
// ============================================================================

const WATCHDOG_SWEEP_INTERVAL_MS = 2 * 60 * 1000;    // max un barrido cada 2 min
const WATCHDOG_MIN_SILENCE_MS = 3 * 60 * 1000;       // cliente esperando >3 min
const WATCHDOG_MAX_SILENCE_MS = 6 * 60 * 60 * 1000;  // ignorar silencios >6h (viejos)
const WATCHDOG_ALERT_TTL_S = 6 * 60 * 60;            // no re-alertar la misma conversacion por 6h
const WATCHDOG_PHONE_IDS = ["1239315459260256", "951608524703564", "597907523413541"];
const WATCHDOG_MAX_ALERTS = 10;

// Mensajes de cierre triviales del cliente que NO requieren respuesta del bot:
// si TODAS las palabras del mensaje estan en esta lista, no se alerta
// ("ok gracias", "no srta gracias", "ya listo", "buenas noches", etc.).
const WATCHDOG_TRIVIAL_WORDS = new Set([
  "ok", "okey", "oki", "okis", "ya", "listo", "lista", "gracias", "gracias",
  "muchas", "mil", "si", "no", "buenas", "buenos", "noches", "dias", "dia",
  "buen", "buena", "tardes", "de", "nada", "senorita", "srta", "joven", "esta",
  "bien", "vale", "perfecto", "entendido", "amable", "muy",
]);

function watchdogIsTrivial(text) {
  const clean = String(text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .trim();
  if (!clean) return true; // solo emojis/signos: no necesita rescate
  const words = clean.split(/\s+/);
  return words.every((w) => WATCHDOG_TRIVIAL_WORDS.has(w));
}

async function watchdogConfig(env) {
  const g = (a, b) => env?.[a] || env?.[b] || globalThis[a] || globalThis[b];
  const cfg = {
    kapsoApiKey: g("KAPSO_API_KEY", "kAPSOAPIKEY"),
    kapsoApiBase: g("KAPSO_API_BASE", "kAPSOAPIBASE") || "https://api.kapso.ai",
    telegramToken: g("TELEGRAM_BOT_TOKEN", "tELEGRAMBOTTOKEN"),
    telegramChatId: g("TELEGRAM_CHAT_ID", "tELEGRAMCHATID"),
    // Destinatarios extra (coma/espacio/;) para difundir la alerta a mas chats.
    telegramChatIdsExtra: g("TELEGRAM_CHAT_IDS", "tELEGRAMCHATIDS"),
    // Webhook del dashboard externo (cola "Atender ahora"). Mismo contrato que
    // el postStoreHandoff de notify-team. Requiere estos secrets en ESTA funcion.
    storeWebhookUrl: g("STORE_WEBHOOK_URL", "sTOREWEBHOOKURL"),
    storeWebhookSecret: g("STORE_WEBHOOK_SECRET", "sTOREWEBHOOKSECRET"),
  };
  // Fallback a KV del proyecto (mismo patron que create-shopify-order).
  if (env?.KV && (!cfg.kapsoApiKey || !cfg.telegramToken || !cfg.telegramChatId)) {
    try {
      const [k, t, c] = await Promise.all([
        cfg.kapsoApiKey ? null : env.KV.get("KAPSO_API_KEY"),
        cfg.telegramToken ? null : env.KV.get("TELEGRAM_BOT_TOKEN"),
        cfg.telegramChatId ? null : env.KV.get("TELEGRAM_CHAT_ID"),
      ]);
      cfg.kapsoApiKey = cfg.kapsoApiKey || k;
      cfg.telegramToken = cfg.telegramToken || t;
      cfg.telegramChatId = cfg.telegramChatId || c;
    } catch { /* sin KV: seguimos con lo que haya */ }
  }
  // Lista final de chats (principal + extras del secret + fijos), deduplicada.
  // Los IDs fijos se embeben porque la inyeccion del secret TELEGRAM_CHAT_IDS
  // resulto poco confiable en el runtime. 8844863582 = Daphne Zuniga.
  cfg.telegramChatIds = parseChatIds(cfg.telegramChatId, cfg.telegramChatIdsExtra, "8844863582");
  return cfg;
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

async function maybeRunWatchdog(env, { force = false } = {}) {
  if (!env?.KV) return { ran: false, reason: "no_kv" };
  if (!force && isQuietHourPeru()) return { ran: false, reason: "quiet_hours" };

  const now = Date.now();
  if (!force) {
    const last = Number(await env.KV.get("watchdog:last_sweep") || 0);
    if (now - last < WATCHDOG_SWEEP_INTERVAL_MS) return { ran: false, reason: "gated" };
  }
  // Cerrar la compuerta ANTES de barrer para evitar dobles barridos concurrentes.
  await env.KV.put("watchdog:last_sweep", String(now), { expirationTtl: 3600 });

  const cfg = await watchdogConfig(env);
  if (!cfg.kapsoApiKey || !cfg.telegramToken || !cfg.telegramChatId) {
    return { ran: false, reason: "missing_credentials" };
  }
  return watchdogSweep(cfg, env, now);
}

async function watchdogSweep(cfg, env, now) {
  const sinceIso = new Date(now - WATCHDOG_MAX_SILENCE_MS).toISOString();
  const candidates = [];

  for (const phoneId of WATCHDOG_PHONE_IDS) {
    let cursor = null;
    for (let page = 0; page < 3; page += 1) {
      let url = `${cfg.kapsoApiBase}/platform/v1/whatsapp/conversations`
        + `?phone_number_id=${encodeURIComponent(phoneId)}&status=active`
        + `&last_active_after=${encodeURIComponent(sinceIso)}&limit=100`;
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
        if (Number.isFinite(lastOut) && lastOut >= lastIn) continue; // el bot ya respondio
        const silence = now - lastIn;
        if (silence < WATCHDOG_MIN_SILENCE_MS || silence > WATCHDOG_MAX_SILENCE_MS) continue;

        const text = String(k.last_message_text || "").trim();
        if (/^Reacted with /i.test(text)) continue;          // reaccion de emoji
        if (watchdogIsTrivial(text)) continue;               // "ok gracias" no necesita rescate

        candidates.push({
          id: convo.id,
          name: k.contact_name || convo.phone_number || "?",
          phone: convo.phone_number || "",
          minutes: Math.round(silence / 60000),
          text: text.slice(0, 80),
        });
      }
      cursor = payload?.paging?.cursors?.after || null;
      if (!cursor || !(payload?.data || []).length) break;
    }
  }

  // Dedupe: alertar cada conversacion una sola vez por ventana de 6h.
  const fresh = [];
  for (const c of candidates) {
    const key = `watchdog:alerted:${c.id}`;
    if (await env.KV.get(key)) continue;
    fresh.push(c);
    await env.KV.put(key, "1", { expirationTtl: WATCHDOG_ALERT_TTL_S });
    if (fresh.length >= WATCHDOG_MAX_ALERTS) break;
  }

  if (fresh.length === 0) return { ran: true, candidates: candidates.length, alerted: 0 };

  // Aviso al dashboard: un POST best-effort por cada cliente esperando, para que
  // caiga en la cola "Atender ahora". Independiente del envio a Telegram.
  try { await postWaitingToStore(cfg, fresh); } catch { /* nunca romper el watchdog */ }

  const lines = fresh.map((c) => `• *${c.name}* (+${c.phone}) — ${c.minutes} min esperando\n  _"${c.text}"_`);
  const text = `⚠️ *Clientes esperando respuesta* (bot en silencio >3 min)\n\n${lines.join("\n")}\n\nEntra a Kapso para atenderlos.`;
  // Difunde a todos los chats (principal + extras). Un chat que falle (ej. no
  // inicio el bot con /start) no corta el envio a los demas; el dedupe TTL ya
  // marco a los clientes como alertados.
  const chats = cfg.telegramChatIds && cfg.telegramChatIds.length ? cfg.telegramChatIds : [cfg.telegramChatId];
  for (const chatId of chats) {
    if (!chatId) continue;
    try {
      await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      });
    } catch { /* Telegram caido para este chat: seguimos con los demas */ }
  }

  return { ran: true, candidates: candidates.length, alerted: fresh.length };
}

// POST best-effort al webhook del dashboard: uno por cada cliente esperando.
// Mismo contrato que postStoreHandoff de notify-team (event workflow.execution.handoff).
// El dashboard deduplica por telefono, asi que reportar el mismo cliente en
// barridos consecutivos es inocuo. Nunca rompe el watchdog ni el envio a Telegram.
async function postWaitingToStore(cfg, fresh) {
  if (!cfg.storeWebhookUrl) return;
  for (const c of fresh) {
    try {
      const body = JSON.stringify({
        event: "workflow.execution.handoff",
        phone_number: String(c.phone || "").replace(/[^\d]/g, ""),
        conversation_id: c.id || "",
        reason: "esperando respuesta",
        context_summary: String(c.text || "").replace(/\s+/g, " ").trim(),
      });
      const headers = { "Content-Type": "application/json" };
      if (cfg.storeWebhookSecret) {
        headers["X-Webhook-Secret"] = cfg.storeWebhookSecret;
        const sig = await hmacHex(cfg.storeWebhookSecret, body);
        if (sig) headers["X-Kapso-Signature"] = sig;
      }
      await fetch(cfg.storeWebhookUrl, { method: "POST", headers, body });
    } catch { /* best-effort por cliente: seguimos con los demas */ }
  }
}

// Firma HMAC-SHA256 (hex) del cuerpo con el secret. Best-effort ("" si falla).
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

// Administracion por invocacion directa (privada, requiere X-API-Key de Kapso):
// - watchdogSeed: {watchdogSeed:{KAPSO_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID}} guarda en KV.
// - watchdogDebug: reporta que credenciales estan visibles (booleans, sin valores).
// - forceSweep: corre un barrido ignorando compuerta y horario (para probar).
async function watchdogAdmin(payload, env) {
  if (payload.watchdogSeed && typeof payload.watchdogSeed === "object") {
    if (!env?.KV) return json({ ok: false, reason: "no_kv" });
    const allowed = ["KAPSO_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
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
  return json({
    ok: true,
    kv: Boolean(env?.KV),
    kapsoApiKey: Boolean(cfg.kapsoApiKey),
    telegramToken: Boolean(cfg.telegramToken),
    telegramChatId: Boolean(cfg.telegramChatId),
    quietHours: isQuietHourPeru(),
  });
}

globalThis.__kenkuCheckCoverage = {
  maybeRunWatchdog,
  watchdogSweep,
  watchdogConfig,
  cleanDistrictText,
  detectCourier,
  isSpecificShalomAgency,
  detectLocationInconsistency,
  handleRequest,
  handler,
  hasCashOnDelivery,
  inferLocationFromDistrict,
  isCallaoDistrict,
  isLimaMetroDistrict,
  levenshtein,
  normalizePlace,
  routeFollowup,
  hasLiveUnansweredInbound,
};
