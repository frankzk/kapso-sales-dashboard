// Sonda temporal: ¿qué trae de verdad la API de Aliclik en cada pedido?
// (owner, 03-11-2026: «De Aliclik solo logras obtener que fue cancelado o
// anulado. ¿No logras obtener más detalle o comentarios?»)
//
// Kapta tipa solo lo que dice la documentación de `GET /integration/order`
// (`AliclikOrder`, lib/aliclik.ts): los tres estados, la nota, el cliente, el
// envío y los productos. El Excel del portal trae además «SUB ESTADO» y
// «ÚLTIMO COMENTARIO MOTORIZADO». Esta sonda mira si la API también los manda
// con otro nombre: junta las rutas de campos de todos los pedidos que lista el
// barrido y guarda unas pocas muestras de guías no entregadas, con los datos
// personales enmascarados, en el log del cron (`[aliclik-api-shape]`).
//
// Se apaga sola el `ALICLIK_API_SHAPE_PROBE_UNTIL`. Pura salvo `logApiShape`.

/** Último día (Lima) en que la sonda escribe. */
export const ALICLIK_API_SHAPE_PROBE_UNTIL = "2026-11-10";

/** Las rutas que Kapta ya lee (`AliclikOrder`). Lo demás es nuevo. */
export const KNOWN_ORDER_PATHS: ReadonlySet<string> = new Set([
  "orderNumber", "total", "callStatus", "status", "dispatchStatus", "channel", "productDetail", "note",
  "createdAt", "updatedAt",
  "customer", "customer.name", "customer.lastName", "customer.phone", "customer.email",
  "shipping", "products", "products[]", "products[].skuId", "products[].quantity", "products[].price", "products[].subtotal",
]);

/** Estados donde un comentario o subestado diría por qué no se entregó. */
const FAILED_STATUSES = new Set(["CANCEL", "ANNULLED", "NOT_RESPOND", "REFUSED", "RESCHEDULED"]);

/** Ramas con datos personales: se ve su forma, nunca su valor. */
const PII_ROOTS = ["customer", "shipping"];

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Las rutas de un valor JSON: `a.b`, y `a[]` para los elementos de una lista. Pura. */
export function keyPaths(value: unknown, prefix = ""): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    const path = `${prefix}[]`;
    out.push(path);
    for (const item of value) out.push(...keyPaths(item, path));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(path, ...keyPaths(v, path));
    }
  }
  return [...new Set(out)];
}

function isPiiPath(path: string): boolean {
  return PII_ROOTS.some((root) => path === root || path.startsWith(`${root}.`) || path.startsWith(`${root}[]`));
}

/** Enmascara: datos personales como `<texto 12>`; en lo demás, tapa los números largos (teléfonos). Pura. */
export function redactForProbe(value: unknown, path = ""): Json {
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => redactForProbe(v, `${path}[]`));
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactForProbe(v, path ? `${path}.${k}` : k);
    }
    return out;
  }
  if (typeof value === "string") {
    if (isPiiPath(path)) return `<texto ${value.length}>`;
    const masked = value.replace(/\d{6,}/g, (d) => `<${d.length} dígitos>`);
    return masked.length > 400 ? `${masked.slice(0, 400)}…` : masked;
  }
  if (typeof value === "number" && isPiiPath(path)) return "<número>";
  return (value ?? null) as Json;
}

export interface ApiShapeReport {
  scanned: number;
  /** Cuántos pedidos traen cada ruta. */
  paths: Record<string, number>;
  /** Las rutas que Kapta no lee. */
  unknownPaths: string[];
  /** Hasta `maxSamples` guías no entregadas, enmascaradas; primero las que traen rutas nuevas. */
  samples: Json[];
}

/** Junta la forma de los pedidos de una pasada. Pura. */
export function summarizeApiShape(orders: readonly unknown[], maxSamples = 6): ApiShapeReport {
  const paths: Record<string, number> = {};
  const failedWithNew: unknown[] = [];
  const failedPlain: unknown[] = [];
  for (const order of orders) {
    const own = keyPaths(order);
    for (const p of own) paths[p] = (paths[p] ?? 0) + 1;
    const status = String((order as { status?: unknown } | null)?.status ?? "").trim().toUpperCase();
    if (!FAILED_STATUSES.has(status)) continue;
    (own.some((p) => !KNOWN_ORDER_PATHS.has(p) && !isPiiPath(p)) ? failedWithNew : failedPlain).push(order);
  }
  const unknownPaths = Object.keys(paths).filter((p) => !KNOWN_ORDER_PATHS.has(p)).sort();
  const samples = [...failedWithNew, ...failedPlain].slice(0, maxSamples).map((o) => redactForProbe(o));
  return { scanned: orders.length, paths, unknownPaths, samples };
}

/** ¿La sonda sigue encendida hoy (día de Lima)? Pura. */
export function apiShapeProbeOn(todayLima: string): boolean {
  return todayLima <= ALICLIK_API_SHAPE_PROBE_UNTIL;
}

/** Escribe el informe en el log del cron, una línea por parte para no pasar el tope de Vercel. */
export function logApiShape(storeId: string, report: ApiShapeReport): void {
  console.info(`[aliclik-api-shape] ${JSON.stringify({ storeId, scanned: report.scanned, unknownPaths: report.unknownPaths, paths: report.paths })}`);
  report.samples.forEach((sample, i) => {
    console.info(`[aliclik-api-shape] sample ${i + 1}/${report.samples.length} ${JSON.stringify(sample)}`);
  });
}
