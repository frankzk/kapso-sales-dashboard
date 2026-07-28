// Sonda de la API de Tanders — se corre EN TU MÁQUINA, no en el servidor.
//
// Tanders no publica documentación, así que el adaptador se construye a partir
// de la forma real de sus respuestas. Este script canjea el refresh token por un
// access token y luego lee los endpoints de catálogo (tipos de caja, perfil,
// capacidad, pedidos existentes) para dejar un volcado que sirva de contrato.
//
// Uso:
//   TANDERS_REFRESH_TOKEN='eyJ...' node scripts/tanders-probe.mjs
//
// Escribe scripts/.tanders-probe.json (ignorado por git). El volcado se redacta:
// se enmascaran tokens y se recortan los datos personales de los pedidos, para
// que se pueda compartir sin filtrar clientes ni credenciales.
//
// SOLO LECTURA: no crea ni modifica pedidos.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.TANDERS_API_BASE ?? "https://tander-bakend-aa1aef07466e.herokuapp.com";
const REFRESH = process.env.TANDERS_REFRESH_TOKEN?.trim();

if (!REFRESH) {
  console.error("Falta TANDERS_REFRESH_TOKEN. Uso:\n  TANDERS_REFRESH_TOKEN='eyJ...' node scripts/tanders-probe.mjs");
  process.exit(1);
}

/** Endpoints candidatos. Los 404 son información igual de útil que los 200:
 *  descartan rutas y acotan cómo se llama de verdad cada recurso. */
const READ_ENDPOINTS = [
  "/auth/me",
  "/profile",
  "/packages",
  "/capacity",
  "/orders?limit=3",
  "/orders",
  "/wallet",
  "/districts",
  "/zones",
  "/pricing",
];

/** Un JWT lleva el sujeto y la expiración en claro: sirve para saber cuánto dura
 *  el access token sin tener que adivinarlo con reintentos. */
function decodeJwt(token) {
  try {
    const [, payload] = token.split(".");
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return {
      sub: json.sub,
      role: json.role,
      iat: json.iat ? new Date(json.iat * 1000).toISOString() : null,
      exp: json.exp ? new Date(json.exp * 1000).toISOString() : null,
      lifetimeSeconds: json.exp && json.iat ? json.exp - json.iat : null,
    };
  } catch {
    return null;
  }
}

/** Enmascara cualquier cosa con pinta de credencial antes de escribir a disco. */
const SECRET_KEY = /token|secret|password|authorization|apikey|api_key/i;

function redact(value, depth = 0) {
  if (depth > 6) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && typeof v === "string") out[k] = `[redacted ${v.length} chars]`;
      // De los pedidos interesa la FORMA, no el cliente: se conserva el tipo del
      // dato personal en vez del valor.
      else if (/name|phone|email|address|direccion|telefono|nombre/i.test(k) && typeof v === "string") {
        out[k] = `[${typeof v}:${v.length}]`;
      } else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

async function call(path, { method = "GET", token, body } = {}) {
  const url = `${BASE}${path}`;
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    return { path, method, error: String(err) };
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 400);
  }
  return {
    path,
    method,
    status: res.status,
    ms: Date.now() - started,
    contentType: res.headers.get("content-type"),
    body: parsed,
  };
}

const report = {
  base: BASE,
  probedAt: new Date().toISOString(),
  refreshTokenClaims: decodeJwt(REFRESH),
  steps: [],
};

// ── 1. Canje del refresh token ──────────────────────────────────────────────
const refreshRes = await call("/auth/refresh", { method: "POST", body: { refreshToken: REFRESH } });
report.steps.push({ ...refreshRes, body: redact(refreshRes.body) });

if (refreshRes.status !== 200 && refreshRes.status !== 201) {
  console.error(`\n/auth/refresh devolvió ${refreshRes.status}. El refresh token probablemente expiró.`);
  console.error("Vuelve a entrar a tanders.app, copia el refreshToken nuevo y reintenta.\n");
  console.error(JSON.stringify(refreshRes.body, null, 2).slice(0, 800));
  process.exit(1);
}

// El campo del access token varía según el backend: se prueban los nombres
// habituales en vez de asumir uno.
const payload = refreshRes.body ?? {};
const accessToken =
  payload.accessToken ?? payload.access_token ?? payload.token ?? payload.data?.accessToken ?? null;

// Se registran las CLAVES de la respuesta (no los valores): así queda claro cómo
// se llama cada campo sin exponer el token.
report.refreshResponseKeys = Object.keys(payload);
report.accessTokenClaims = accessToken ? decodeJwt(accessToken) : null;

if (!accessToken) {
  console.error("No se encontró el access token en la respuesta. Claves recibidas:", report.refreshResponseKeys);
  process.exit(1);
}

// ── 2. Catálogos y perfil ───────────────────────────────────────────────────
for (const path of READ_ENDPOINTS) {
  const res = await call(path, { token: accessToken });
  report.steps.push({ ...res, body: redact(res.body) });
  console.log(`${String(res.status ?? "ERR").padEnd(4)} ${path}`);
}

const out = join(dirname(fileURLToPath(import.meta.url)), ".tanders-probe.json");
writeFileSync(out, JSON.stringify(report, null, 2));

console.log(`\nVolcado escrito en ${out}`);
console.log("Revísalo antes de compartirlo y pásamelo junto con el POST de creación de pedido.");
