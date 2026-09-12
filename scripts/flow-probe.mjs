// Sonda de la API de Flow.cl — se corre EN TU MÁQUINA, no en el servidor.
//
// PARA QUÉ. Antes de construir el cobro del adelanto por link hay UNA pregunta
// que ninguna documentación responde: cuando el pagador abre el checkout de
// Flow con Yape como medio, ¿Flow lo manda a la app por deeplink —un tap y
// aprobar— o le pide el código de aprobación de 6 dígitos? De esa respuesta
// depende que el flujo valga la pena. Esto crea los links para averiguarlo
// abriéndolos en un celular con Yape instalado.
//
// Y DE PASO. El panel de Flow lista TRES medios Yape y dos son indistinguibles
// por nombre: el 170 (billetera, 0.00 de costo fijo) y el 152 (billetera, 0.80).
// Cuál es «One Shot» no se deduce del panel, y la diferencia cuesta el doble
// sobre un adelanto pequeño. La sonda crea un link por medio candidato: abriendo
// los tres se ve cuál es cuál. Con `9` (todos los medios) Flow enseña su página
// de selección, que es donde aparecen los nombres reales de cada uno.
//
// Uso:
//   FLOWCL_API_KEY='...' FLOWCL_SECRET_KEY='...' node scripts/flow-probe.mjs
//
// Opcionales:
//   FLOWCL_METHODS='9,170,152,169'  medios a probar (por defecto, ésos)
//   FLOWCL_AMOUNT='20'             monto del cobro de prueba
//   FLOWCL_EMAIL='tu@correo.com'   email del pagador de prueba
//   FLOWCL_RETURN_URL='https://…'  urlReturn y urlConfirmation de prueba
//
// Escribe scripts/.flow-probe.json (ignorado por git) con el volcado de las
// respuestas, enmascarando la apiKey. El secretKey no se escribe ni se imprime
// nunca, en ningún caso.
//
// NO ES SOLO LECTURA: crea órdenes de pago. Por eso está clavado al SANDBOX y
// se niega a correr contra producción. Una orden de sandbox no mueve plata; una
// de producción sí.

import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SANDBOX = "https://sandbox.flow.cl/api";
const BASE = (process.env.FLOWCL_API_BASE ?? SANDBOX).replace(/\/$/, "");

const API_KEY = process.env.FLOWCL_API_KEY?.trim();
const SECRET_KEY = process.env.FLOWCL_SECRET_KEY?.trim();

if (!API_KEY || !SECRET_KEY) {
  console.error(
    "Faltan credenciales. Uso:\n" +
      "  FLOWCL_API_KEY='...' FLOWCL_SECRET_KEY='...' node scripts/flow-probe.mjs\n\n" +
      "Son las de SANDBOX (sandbox.flow.cl/app/web/misDatos.php), no las de producción.",
  );
  process.exit(1);
}

// El freno de mano. Esta sonda CREA órdenes: contra producción serían cobros
// reales con el nombre «SONDA» delante. No hay motivo para correrla ahí, así
// que no se puede sin decirlo a gritos.
if (!BASE.includes("sandbox") && process.env.FLOWCL_ALLOW_PROD !== "1") {
  console.error(
    `Rechazado: ${BASE} no es el sandbox y esta sonda crea órdenes de pago.\n` +
      "Si de verdad quieres correrla contra producción: FLOWCL_ALLOW_PROD=1",
  );
  process.exit(1);
}

/** Medios candidatos. `9` = todos (enseña la página de selección de Flow, que
 *  es donde se leen los nombres reales); el resto son los IDs del panel. */
const METHODS = (process.env.FLOWCL_METHODS ?? "9,170,152,169")
  .split(",")
  .map((m) => Number(m.trim()))
  .filter((m) => Number.isInteger(m) && m > 0);

// Monto de PRUEBA. El cobro de verdad no lleva el número escrito: lo lee de
// `lib/adelanto-minimo.ts`, que es el único sitio donde vive (ver #KP133181).
// Aquí es un parámetro de la sonda, no una regla de negocio.
const AMOUNT = Number(process.env.FLOWCL_AMOUNT ?? 20);
const EMAIL = process.env.FLOWCL_EMAIL ?? "sonda@example.com";
// Flow exige ambas URLs. Para la sonda da igual dónde apunten —no vamos a
// cobrar de verdad— pero si Flow valida que respondan, el error lo dirá.
const RETURN_URL = process.env.FLOWCL_RETURN_URL ?? "https://example.com/flow/retorno";

/**
 * La firma de Flow: se ordenan los parámetros alfabéticamente por nombre, se
 * concatenan `nombre` + `valor` sin separadores, y se firma con HMAC-SHA256
 * usando el secretKey. El parámetro `s` es el único que NO entra en la firma.
 *
 * El detalle que muerde: cualquier parámetro opcional que se envíe entra en la
 * firma. Mandar `timeout` y olvidarlo en el string produce un 401 que no dice
 * por qué.
 */
function sign(params) {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join("");
  return createHmac("sha256", SECRET_KEY).update(toSign).digest("hex");
}

async function post(path, params) {
  const body = { ...params, s: sign(params) };
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* Flow puede responder HTML ante un error de infraestructura */
  }
  return { status: res.status, json, raw: json ? null : text.slice(0, 500) };
}

async function get(path, params) {
  const qs = new URLSearchParams(
    Object.entries({ ...params, s: sign(params) }).map(([k, v]) => [k, String(v)]),
  );
  const res = await fetch(`${BASE}${path}?${qs}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ídem */
  }
  return { status: res.status, json, raw: json ? null : text.slice(0, 500) };
}

const stamp = Date.now();
const results = [];

console.log(`\nFlow probe → ${BASE}`);
console.log(`Monto S/ ${AMOUNT} · medios: ${METHODS.join(", ")}\n`);

for (const method of METHODS) {
  const commerceOrder = `SONDA-${stamp}-${method}`;
  const params = {
    apiKey: API_KEY,
    amount: AMOUNT,
    commerceOrder,
    currency: "PEN",
    email: EMAIL,
    paymentMethod: method,
    subject: `Sonda adelanto (medio ${method})`,
    urlConfirmation: RETURN_URL,
    urlReturn: RETURN_URL,
  };

  const created = await post("/payment/create", params);

  if (created.status !== 200 || !created.json?.token) {
    // Un medio no contratado en sandbox falla acá, y ese fallo es información:
    // dice que el ID no existe en este ambiente, no que la integración esté mal.
    const detail = created.json?.message ?? created.raw ?? "(sin cuerpo)";
    console.log(`  ✗ medio ${String(method).padEnd(4)} HTTP ${created.status} — ${detail}`);
    results.push({ method, commerceOrder, error: { status: created.status, detail } });
    continue;
  }

  const { url, token, flowOrder } = created.json;
  const link = `${url}?token=${token}`;
  console.log(`  ✓ medio ${String(method).padEnd(4)} ${link}`);

  // El estado inicial sirve de contrato: deja ver la forma real de la respuesta
  // (status, medio, montos) antes de que nadie pague.
  const status = await get("/payment/getStatus", { apiKey: API_KEY, token });

  results.push({
    method,
    commerceOrder,
    flowOrder,
    link,
    initialStatus: status.json ?? { httpStatus: status.status, raw: status.raw },
  });
}

const out = join(dirname(fileURLToPath(import.meta.url)), ".flow-probe.json");
writeFileSync(
  out,
  JSON.stringify(
    {
      base: BASE,
      // La apiKey identifica al comercio; no es tan sensible como el secretKey,
      // pero el volcado se comparte y no hay razón para que viaje entera.
      apiKey: `${API_KEY.slice(0, 8)}…`,
      amount: AMOUNT,
      currency: "PEN",
      probedAt: new Date().toISOString(),
      results,
    },
    null,
    2,
  ),
  "utf8",
);

console.log(`\nVolcado → ${out}`);
console.log(
  "\nAbre los links en un celular con Yape instalado y anota, para cada medio:\n" +
    "  · ¿abre la app Yape directamente, o pide un código de 6 dígitos?\n" +
    "  · ¿qué nombre le pone Flow al medio en su página?\n" +
    "Con el link de `9` se ven todos los nombres juntos, que es lo que el panel no aclara.\n",
);
