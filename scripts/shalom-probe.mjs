// Sonda de la API de Shalom — se corre EN TU MÁQUINA, no en el servidor.
//
// Sirve para dos cosas: validar que la API key funciona antes de pedir la
// definitiva, y dejar un volcado de la forma REAL de las respuestas para
// contrastarlo con lo que asume lib/shalom/.
//
// Uso — solo lectura, no crea nada:
//
//   SHALOM_API_KEY='sk_…' node scripts/shalom-probe.mjs
//
//   # buscando TU agencia (imprime los id que van a Ajustes de la tienda)
//   SHALOM_API_KEY='sk_…' SHALOM_AGENCY_Q='breña' node scripts/shalom-probe.mjs
//
//   # con la cuenta del cliente, para además listar productos, tarifas y órdenes
//   SHALOM_API_KEY='sk_…' \
//   SHALOM_PRO_EMAIL='cliente@empresa.com' \
//   SHALOM_PRO_PASSWORD='…' \
//   node scripts/shalom-probe.mjs
//
// Uso — CREAR UNA GUÍA DE VERDAD (última prueba, antes de dar por buena la
// integración). Requiere el flag explícito y todos los datos del envío:
//
//   SHALOM_API_KEY='sk_…' SHALOM_PRO_EMAIL='…' SHALOM_PRO_PASSWORD='…' \
//   SHALOM_ORIGIN=404 SHALOM_DESTINY=7 SHALOM_PRODUCT=3 \
//   SHALOM_DOC=87654321 SHALOM_NAME=MARIA SHALOM_LAST=GOMEZ SHALOM_SUR=TORRES \
//   SHALOM_PHONE=998765432 \
//   node scripts/shalom-probe.mjs --create
//
// La guía que crea es REAL y COBRABLE en la cuenta del cliente. La sonda
// imprime el comando de borrado al terminar; hay que ejecutarlo antes de que la
// guía sea recibida en agencia o ya no se puede borrar.
//
// Escribe scripts/.shalom-probe.json (ignorado por git), con los secretos
// enmascarados y los datos personales reducidos a su tipo.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.SHALOM_API_BASE ?? "https://api.shalom-api-peru.com";
const API_KEY = process.env.SHALOM_API_KEY?.trim();
const EMAIL = process.env.SHALOM_PRO_EMAIL?.trim();
const PASSWORD = process.env.SHALOM_PRO_PASSWORD?.trim();
const CREATE = process.argv.includes("--create");
/** Qué buscar en el directorio de agencias. Es como se consigue el id de la
 *  agencia de ORIGEN, que después va en Ajustes de la tienda. */
const AGENCY_Q = process.env.SHALOM_AGENCY_Q?.trim() || "arequipa";

if (!API_KEY) {
  console.error("Falta SHALOM_API_KEY. Uso:\n  SHALOM_API_KEY='sk_…' node scripts/shalom-probe.mjs");
  process.exit(1);
}

/** El login real contra pro.shalom.pe tarda ~90 s. Con menos margen se corta. */
const SLOW_MS = 170_000;
const FAST_MS = 45_000;

const SECRET_KEY = /token|secret|password|authorization|apikey|api_key|pickup_code/i;
const PERSONAL_KEY = /name|phone|email|address|direccion|telefono|nombre|document/i;

function redact(value, depth = 0) {
  if (depth > 6) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && typeof v === "string") out[k] = `[redacted ${v.length} chars]`;
      // De las órdenes interesa la FORMA, no el cliente: se conserva el tipo del
      // dato personal en vez del valor.
      else if (PERSONAL_KEY.test(k) && (typeof v === "string" || typeof v === "number")) {
        out[k] = `[${typeof v}:${String(v).length}]`;
      } else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

async function call(path, { method = "GET", body, session, timeoutMs = FAST_MS, auth = false } = {}) {
  const headers = { accept: "application/json", "X-API-Key": API_KEY };
  if (auth) {
    if (session) headers["X-Shalom-Session"] = session;
    else if (EMAIL && PASSWORD) {
      headers["X-Shalom-Email"] = EMAIL;
      headers["X-Shalom-Password"] = PASSWORD;
    }
  }
  if (body) headers["content-type"] = "application/json";

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { path, method, error: String(err), ms: Date.now() - started };
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 400);
  }
  return {
    path,
    method,
    status: res.status,
    ms: Date.now() - started,
    rateLimit: {
      limit: res.headers.get("x-ratelimit-limit"),
      remaining: res.headers.get("x-ratelimit-remaining"),
    },
    body: parsed,
  };
}

const report = { base: BASE, probedAt: new Date().toISOString(), steps: [] };

function record(step, { keepBody = false } = {}) {
  report.steps.push({ ...step, body: keepBody ? step.body : redact(step.body) });
  const tag = step.error ? "ERR" : String(step.status);
  console.log(
    `${tag.padEnd(4)} ${String(step.ms).padStart(6)}ms  ${step.method} ${step.path}` +
      (step.rateLimit?.remaining ? `   (quedan ${step.rateLimit.remaining} req)` : ""),
  );
  if (step.error) console.log(`      ${step.error}`);
}

// ── 1. Salud y rutas que solo piden la API key ───────────────────────────────
console.log("\n── Sin credenciales de Shalom Pro ──");
record(await call("/healthz"));
record(await call("/readyz"));

const agencies = await call(`/v1/agencies/search?q=${encodeURIComponent(AGENCY_Q)}`);
record(agencies, { keepBody: true });

// Se imprimen id + nombre en claro a propósito: es un directorio público, y el
// id es justo lo que hay que copiar a Ajustes → Tienda → agencia de origen.
{
  const items = Array.isArray(agencies.body) ? agencies.body : (agencies.body?.items ?? []);
  if (items.length) {
    console.log(`\n  Agencias que coinciden con "${AGENCY_Q}":`);
    for (const a of items.slice(0, 15)) {
      const donde = [a.departamento, a.provincia, a.distrito].filter(Boolean).join(" · ");
      console.log(`    id=${String(a.id).padEnd(6)} ${a.nombre}${donde ? `   (${donde})` : ""}`);
    }
    console.log("");
  } else if (!agencies.error && agencies.status === 200) {
    console.log(`\n  Ninguna agencia coincide con "${AGENCY_Q}". Prueba otro texto con SHALOM_AGENCY_Q.\n`);
  }
}

if (agencies.status === 401 || agencies.status === 403) {
  console.error("\nLa API key fue rechazada. Revisa que sea la vigente y que no haya expirado.");
}

record(await call("/v1/locations/departments"));

// ── 2. Con la cuenta del cliente ─────────────────────────────────────────────
let session = null;

if (EMAIL && PASSWORD) {
  console.log("\n── Con credenciales de Shalom Pro ──");
  console.log("Pidiendo el token de sesión. Esta llamada tarda ~90 s (hasta 2 min): es un login real.");

  const sess = await call("/v1/shalom/sessions", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
    timeoutMs: SLOW_MS,
  });
  record(sess);
  session = sess.body?.session_token ?? null;
  report.sessionAcquired = Boolean(session);
  report.sessionExpiresAt = sess.body?.expires_at ?? null;

  if (!session) {
    console.error("\nNo se obtuvo token de sesión: el resto de pruebas necesita credenciales válidas.");
  } else {
    const products = await call("/v1/products", { session, auth: true, timeoutMs: SLOW_MS });
    record(products, { keepBody: true });

    // El catálogo es POR CUENTA: estos ids son los que sirven en tu tienda, y no
    // tienen por qué coincidir con los de la documentación.
    for (const prod of products.body?.products ?? []) {
      console.log(`    id=${String(prod.id).padEnd(6)} ${prod.title}${prod.content ? `   (${prod.content})` : ""}`);
    }

    record(await call("/v1/orders?page=1&per_page=3", { session, auth: true, timeoutMs: SLOW_MS }));

    const origin = Number(process.env.SHALOM_ORIGIN ?? 0);
    const destiny = Number(process.env.SHALOM_DESTINY ?? 0);
    if (origin && destiny) {
      record(
        await call("/v1/tariff/calculate", {
          method: "POST",
          body: { origin_terminal_id: origin, destiny_terminal_id: destiny },
          session,
          auth: true,
        }),
        { keepBody: true },
      );
    } else {
      console.log("     (sin SHALOM_ORIGIN / SHALOM_DESTINY no se cotiza)");
    }
  }
} else {
  console.log("\n(sin SHALOM_PRO_EMAIL / SHALOM_PRO_PASSWORD: solo se probaron las rutas públicas)");
}

// ── 3. Crear una guía REAL ───────────────────────────────────────────────────
if (CREATE) {
  const required = {
    SHALOM_ORIGIN: process.env.SHALOM_ORIGIN,
    SHALOM_DESTINY: process.env.SHALOM_DESTINY,
    SHALOM_PRODUCT: process.env.SHALOM_PRODUCT,
    SHALOM_DOC: process.env.SHALOM_DOC,
    SHALOM_NAME: process.env.SHALOM_NAME,
    SHALOM_PHONE: process.env.SHALOM_PHONE,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);

  if (!session) {
    console.error("\n--create necesita una sesión válida. Aborta.");
  } else if (missing.length) {
    console.error(`\n--create necesita: ${missing.join(", ")}. Aborta.`);
  } else {
    // Clave de recojo: ni repetida ni consecutiva, igual que en lib/shalom/draft.
    const pickup = process.env.SHALOM_PICKUP ?? "2415";

    console.log("\n── CREANDO UNA GUÍA REAL ──");
    console.log("Esto emite una preguía cobrable en la cuenta del cliente. Ctrl-C ahora si no querías.");

    const payload = {
      origin_terminal_id: Number(required.SHALOM_ORIGIN),
      destiny_terminal_id: Number(required.SHALOM_DESTINY),
      product_id: Number(required.SHALOM_PRODUCT),
      quantity: 1,
      payer: process.env.SHALOM_PAYER ?? "sender",
      declaracion_jurada: process.env.SHALOM_DECLARACION ?? "docs",
      receiver: {
        document_type: process.env.SHALOM_DOC_TYPE ?? "DNI",
        document: required.SHALOM_DOC,
        name: required.SHALOM_NAME,
        ...(process.env.SHALOM_LAST ? { last_name: process.env.SHALOM_LAST } : {}),
        ...(process.env.SHALOM_SUR ? { sur_name: process.env.SHALOM_SUR } : {}),
        phone: Number(required.SHALOM_PHONE),
      },
      pickup_code: pickup,
    };
    report.createPayloadShape = redact(payload);

    const created = await call("/v1/orders", {
      method: "POST",
      body: payload,
      session,
      auth: true,
      timeoutMs: SLOW_MS,
    });
    record(created, { keepBody: true });

    if (created.error) {
      // El escenario que la documentación advierte: no se sabe si se creó.
      console.error(
        "\nLa llamada se cortó. NO reintentes: busca la guía en GET /v1/orders (clave de recojo " +
          `${pickup}, documento ${required.SHALOM_DOC}) antes de hacer nada más.`,
      );
    } else if (created.status === 200 || created.status === 201) {
      const { guia, codigo, ose_id } = created.body ?? {};
      console.log(`\n  guia=${guia}  codigo=${codigo}  ose_id=${ose_id}  pickup_code=${pickup}`);

      // El id que borra NO es el ose_id: hay que buscarlo en la lista.
      const list = await call("/v1/orders?page=1&per_page=10", { session, auth: true, timeoutMs: SLOW_MS });
      record(list);
      const mine = (list.body?.orders ?? []).find((o) => String(o.guia) === String(guia));
      console.log(
        mine
          ? `\n  Para borrarla:\n    curl -X DELETE ${BASE}/v1/orders/${mine.id} \\\n      -H "X-API-Key: $SHALOM_API_KEY" -H "X-Shalom-Session: <ssk_…>"\n`
          : "\n  No se encontró el `id` de la orden para borrarla: búscala en GET /v1/orders.\n",
      );
      report.createdGuide = { guia, codigo, ose_id, deletableId: mine?.id ?? null };

      // El rótulo cierra el ciclo: si baja el PDF, la guía existe de verdad.
      if (ose_id) {
        const label = await call(`/v1/orders/${ose_id}/label`, { session, auth: true });
        record({ ...label, body: "[pdf]" });
      }
    }
  }
} else {
  console.log("\n(sin --create no se creó ninguna guía)");
}

const out = join(dirname(fileURLToPath(import.meta.url)), ".shalom-probe.json");
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nVolcado escrito en ${out}`);
console.log("Revísalo antes de compartirlo.");
