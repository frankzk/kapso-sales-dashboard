// MOM §38.13 (pedidos del bot de Kapso por Kapta) atado a lo que de verdad
// corre: los códigos y sus HTTP, los plazos del candado, el tope por minuto, el
// canal, la ruta y su maxDuration, la migración, el contrato para Kapso
// (docs/kapso-pedidos-kapta.md) y la entrada de DEPLOY. Las reglas, a fondo, en
// test/bot-orders.test.ts y scripts/sql/bot_orders_smoke.sql.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOT_ORDER_CHANNEL,
  BOT_ORDER_CLAIM_TTL_MS,
  BOT_ORDER_CODES,
  BOT_ORDER_DB_TIMEOUT_MS,
  BOT_ORDER_FIELDS,
  BOT_ORDER_HTTP,
  BOT_ORDER_MAX_BODY_BYTES,
  BOT_ORDER_RATE_PER_MINUTE,
  BOT_ORDER_REQUEST_PREFIX,
  BOT_ORDER_RETAKE_MAX_AGE_MS,
  BOT_ORDER_RETRYABLE,
  BOT_ORDER_RETRY_AFTER_MAX_S,
  BOT_ORDER_RETRY_AFTER_MIN_S,
  BOT_ORDER_RETRY_WINDOW_S,
  BOT_ORDER_SALE_DEADLINE_MS,
  BOT_ORDER_SAME_BODY_WINDOW_MS,
  BOT_ORDER_SHIPPING_MODES,
  BOT_ORDER_TAGS,
  BOT_ORDERS_PATH,
  botOrdersEndpointUrl,
} from "@/lib/bot-orders";
import { WOO_BOT_SALE_CHANNEL, WOO_SALE_BUDGET_MS, WOO_SALE_LOOKBACK_MS } from "@/lib/woocommerce-orders";
import { WOO_CHANNEL_TAGS } from "@/lib/woocommerce";
import { salesChannel } from "@/lib/sales-channel";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");
const DEPLOY = read("DEPLOY.md");
const CONTRATO = flat(read("docs/kapso-pedidos-kapta.md"));
// Sin las marcas de cita («> ») del aviso de arriba.
const CARRITOS = flat(read("docs/kapso-workflow-carritos.md").replace(/\n>\s?/g, "\n"));
const ROUTE = read("app/api/internal/orders/[storeId]/route.ts");
const MIGRATION = read("db/migrations/0277_bot_orders.sql");

function section(title: string): string {
  const start = MOM.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = MOM.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

const S38_13 = section("### 38.13 Pedidos del bot de Kapso por Kapta (23-10-2026)");
const S38_12 = section("### 38.12 Lo que decide la plataforma del pedido");
const S38_5 = section("### 38.5 Etiquetas y canal de venta");
const S17_3 = section("### 17.3 Canal de cierre de todas las ventas (14-10-2026)");

describe("MOM §38.13", () => {
  it("la decisión del owner (D5): el bot pide a Kapta, con el núcleo de «Generar pedido»", () => {
    expect(S38_13).toContain("**Decisión del owner (plan D5, 23-10-2026):** el bot no habla con WooCommerce");
    expect(S38_13).toContain("`buildWooSaleOrder` y `createWooSaleOrder` (38.12)");
    expect(S38_13).toContain(`(\`POST ${BOT_ORDERS_PATH}/<storeId>\``);
  });

  it("el secreto: sha256, tiempo constante, 401 sin detalles, nunca CRON_SECRET", () => {
    expect(S38_13).toContain("Kapta guarda solo su sha256 (`bot_order_secrets.secret_hash`, 0277)");
    expect(S38_13).toContain("en tiempo constante");
    expect(S38_13).toContain("401 «No autorizado.», sin decir cuál");
    expect(S38_13).toContain("`CRON_SECRET` y el secreto de los webhooks de Kapso no sirven");
  });

  it("la tienda: 409 sin llamar a WooCommerce ni a Shopify; nunca crea en Shopify", () => {
    expect(S38_13).toContain("**sin ninguna llamada a WooCommerce ni a Shopify**: este endpoint nunca crea un pedido en Shopify");
  });

  it("los campos del cuerpo del MOM son los que acepta el código, y los del contrato también", () => {
    for (const f of BOT_ORDER_FIELDS) {
      expect(S38_13, f).toContain(`\`${f}\``);
      expect(CONTRATO, f).toContain(`| \`${f}\` |`);
    }
    for (const f of ["items[].sku", "items[].quantity", "items[].unit_price", "items[].name"]) expect(CONTRATO).toContain(`| \`${f}\` |`);
  });

  it("cada código, con su HTTP y si se reintenta, en el MOM y en el contrato", () => {
    expect(BOT_ORDER_CODES).toHaveLength(16);
    for (const code of BOT_ORDER_CODES) {
      const http = BOT_ORDER_HTTP[code];
      const retry = BOT_ORDER_RETRYABLE.has(code);
      expect(S38_13, code).toContain(`| \`${code}\` | ${http} | ${retry ? "sí" : "no"} |`);
      expect(CONTRATO, code).toContain(`| \`${code}\` | ${http} | ${retry ? "sí" : "no"} |`);
    }
  });

  it("el candado: 120 s, más que la función y mucho menos que la ventana de 2 horas", () => {
    expect(BOT_ORDER_CLAIM_TTL_MS).toBe(120_000);
    expect(S38_13).toContain(`\`processing\` de hace menos de ${BOT_ORDER_CLAIM_TTL_MS / 1000} s (\`BOT_ORDER_CLAIM_TTL_MS\`)`);
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(ROUTE)?.[1]);
    expect(maxDuration).toBe(60);
    expect(S38_13).toContain(
      `(\`maxDuration\` ${maxDuration} s, con la venta terminada a los ${BOT_ORDER_SALE_DEADLINE_MS / 1000} s, \`BOT_ORDER_SALE_DEADLINE_MS\`)`,
    );
    // La venta, el candado y la fila local (con su tope cada uno) caben en la
    // función, y la función en el plazo del candado.
    expect(BOT_ORDER_SALE_DEADLINE_MS).toBeLessThanOrEqual(WOO_SALE_BUDGET_MS);
    expect(BOT_ORDER_SALE_DEADLINE_MS + 2 * BOT_ORDER_DB_TIMEOUT_MS + 5_000).toBeLessThan(maxDuration * 1000);
    expect(maxDuration * 1000).toBeLessThan(BOT_ORDER_CLAIM_TTL_MS);
    expect(BOT_ORDER_CLAIM_TTL_MS * 10).toBeLessThan(WOO_SALE_LOOKBACK_MS);
    expect(S38_13).toContain(
      `409 \`duplicate_in_progress\`, con \`retry_after_seconds\` = lo que le falta al candado, entre ${BOT_ORDER_RETRY_AFTER_MIN_S} y ${BOT_ORDER_RETRY_AFTER_MAX_S} s`,
    );
    expect(S38_13).toContain("solo si el `claim_token` sigue siendo el que leyó");
    expect(MIGRATION).toContain("constraint bot_order_requests_store_request_uniq unique (store_id, request_id)");
  });

  it("retomar: el pedido por su id, y nunca a ciegas pasada la ventana de la búsqueda", () => {
    expect(BOT_ORDER_RETAKE_MAX_AGE_MS).toBe(90 * 60_000);
    expect(BOT_ORDER_RETAKE_MAX_AGE_MS + 30 * 60_000).toBeLessThanOrEqual(WOO_SALE_LOOKBACK_MS);
    expect(S38_13).toContain(`de hace más de ${BOT_ORDER_RETAKE_MAX_AGE_MS / 60_000} min (\`BOT_ORDER_RETAKE_MAX_AGE_MS\`) | 409 \`expired\``);
    expect(S38_13).toContain("lee el pedido de ese intento por su `woo_order_id` (a cualquier edad)");
    expect(MIGRATION).toContain("woo_order_id bigint check (woo_order_id is null or woo_order_id > 0)");
    expect(S38_13).toContain("**Un POST sin respuesta no suelta el candado**");
    expect(S38_12).toContain("`createWooSaleOrder` lo dice (`postUnanswered`)");
  });

  it("el mismo pedido con otro request_id, y el plazo de los reintentos del bot", () => {
    expect(BOT_ORDER_SAME_BODY_WINDOW_MS).toBe(10 * 60_000);
    expect(S38_13).toContain(`**la misma huella** en los últimos ${BOT_ORDER_SAME_BODY_WINDOW_MS / 60_000} min (\`BOT_ORDER_SAME_BODY_WINDOW_MS\`)`);
    expect(CONTRATO).toContain(`dentro de **${BOT_ORDER_SAME_BODY_WINDOW_MS / 60_000} minutos** es el mismo pedido pedido dos veces`);
    // El bot sigue reintentando más que lo que vive un candado.
    expect(BOT_ORDER_RETRY_WINDOW_S * 1000).toBeGreaterThan(BOT_ORDER_CLAIM_TTL_MS + 30_000);
    expect(S38_13).toContain(`**durante ${BOT_ORDER_RETRY_WINDOW_S / 60} minutos** (\`BOT_ORDER_RETRY_WINDOW_S\`)`);
    expect(CONTRATO).toContain(`**durante ${BOT_ORDER_RETRY_WINDOW_S / 60} minutos desde el primer intento**`);
    expect(CONTRATO).toContain("Mientras la respuesta sea `duplicate_in_progress`, **no derivar**");
    expect(CONTRATO).toContain("`pedido no creado: <code> · request_id <request_id>`");
  });

  it("el tamaño del cuerpo y lo que quedó a medias", () => {
    expect(BOT_ORDER_MAX_BODY_BYTES).toBe(16_384);
    expect(S38_13).toContain("**Recién con el secreto bueno se lee el cuerpo**");
    expect(S38_13).toContain("va en la respuesta como `order_left_open`");
    expect(CONTRATO).toContain("`order_left_open` (solo a veces)");
  });

  it("el modo de entrega y las etiquetas, como hoy en Shopify; y el precio, un riesgo aceptado pendiente del owner", () => {
    expect(Object.values(BOT_ORDER_SHIPPING_MODES).sort()).toEqual(["agency", "agency", "cod", "cod"]);
    expect([...BOT_ORDER_TAGS]).toEqual(["promo-whatsapp", "stock-por-validar"]);
    expect(S38_13).toContain("**El modo de entrega y las etiquetas, como hoy.**");
    expect(S38_5).toContain("el meta visible `shipping_mode` (`cod` o `agency`");
    expect(S38_13).toContain("**Los precios los decide el bot (riesgo aceptado, pendiente del owner).**");
    expect(CONTRATO).toContain("## 8. Los precios los decide el bot (riesgo aceptado, pendiente del owner)");
    expect(CONTRATO).toContain("## 9. Pendiente del owner");
  });

  it("el tope por minuto", () => {
    expect(S38_13).toContain(`**${BOT_ORDER_RATE_PER_MINUTE} pedidos nuevos por tienda y minuto** (\`BOT_ORDER_RATE_PER_MINUTE\``);
    expect(CONTRATO).toContain(`Más de ${BOT_ORDER_RATE_PER_MINUTE} pedidos nuevos del bot en un minuto`);
  });

  it("el canal: siempre kapso (Chatbot WhatsApp / Bot de Kapso), también al cerrar un carrito; nunca el bot externo", () => {
    expect(BOT_ORDER_CHANNEL).toBe("kapso");
    expect(WOO_BOT_SALE_CHANNEL).toBe("kapso");
    expect(WOO_CHANNEL_TAGS[BOT_ORDER_CHANNEL]).toEqual(["kapso", "whatsapp"]);
    expect(salesChannel(WOO_CHANNEL_TAGS[BOT_ORDER_CHANNEL]!, "conv-1")).toBe("chatbot");
    expect(S38_13).toContain("**El canal (decisión, 23-10-2026): siempre `kapso`**, también cuando el bot cierra un carrito");
    expect(S38_13).toContain("`bot_carritos` («BOT + CARRITO RECUPERADO») es el bot de carritos **externo**");
    expect(S38_5).toContain("lleva `kapta_channel = kapso` y su `kapso_conversation_id`, también cuando cierra un carrito");
    expect(S17_3).toContain("**Desde el cierre de Shopify sí se distingue**");
    expect(S17_3).toContain("en WooCommerce, la que pone la entrada por `kapta_channel = kapso` o `kapso_conversation_id` (§38.5, §38.13)");
  });

  it("el id del intento en WooCommerce lleva su prefijo", () => {
    expect(BOT_ORDER_REQUEST_PREFIX).toBe("kapso-");
    expect(S38_13).toContain(`\`kapta_request_id = ${BOT_ORDER_REQUEST_PREFIX}<request_id>\``);
    expect(CONTRATO).toContain(`\`kapta_request_id = ${BOT_ORDER_REQUEST_PREFIX}<request_id>\``);
  });

  it("los pasos de la entrada por el mismo código, sin order_sales", () => {
    expect(S38_13).toContain("(`applyWooOrderEffects`, lib/ingest.ts)");
    expect(read("lib/ingest.ts")).toContain("export async function applyWooOrderEffects(");
    expect(S38_13).toContain("**Sin `order_sales`**");
  });

  it("el registro, sin datos de la clienta; y sin la 0277, 503 claro", () => {
    expect(S38_13).toContain("Nunca el teléfono, el nombre, la dirección, el request_id entero ni el secreto");
    expect(S38_13).toContain("503 `migration_missing` («Falta aplicar la migración 0277…») sin crear nada");
  });

  it("38.12 ya no dice que el endpoint falta, y apunta al candado de 38.13", () => {
    expect(S38_12).toContain("**hecho (23-10-2026, 38.13)**");
    expect(S38_12).toContain("pero el bot sí: su endpoint tiene el candado en la base, por (tienda, id del intento) (38.13)");
  });

  it("los archivos que nombra existen", () => {
    for (const f of [
      "db/migrations/0277_bot_orders.sql",
      "lib/bot-orders.ts",
      "app/api/internal/orders/[storeId]/route.ts",
      "app/dashboard/[storeId]/settings/bot-orders-actions.ts",
      "components/bot-orders-settings-section.tsx",
      "test/bot-orders.test.ts",
      "test/bot-orders-settings.test.ts",
      "test/bot-orders-mom.test.ts",
      "scripts/sql/bot_orders_smoke.sql",
      "docs/kapso-pedidos-kapta.md",
    ]) {
      expect(S38_13, f).toContain(`\`${f}\``);
      expect(existsSync(resolve(process.cwd(), f)), f).toBe(true);
    }
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/bot_orders_smoke.sql");
  });
});

describe("el contrato y el workflow de carritos", () => {
  it("el contrato: método, ruta, cabeceras, el plan del corte y nunca Shopify después de un error", () => {
    expect(CONTRATO).toContain(`POST https://<Kapta>${BOT_ORDERS_PATH}/<storeId>`);
    expect(CONTRATO).toContain("Authorization: Bearer <secreto del bot de esa tienda>");
    expect(CONTRATO).toContain("**Tiempo de espera de la acción: 60 s o más.**");
    expect(CONTRATO).toContain("## 7. El plan del corte");
    expect(CONTRATO).toContain("**Nunca** crear el pedido en Shopify después de un error de Kapta");
    expect(CONTRATO).toContain("Reintentar con el **mismo** `request_id` (nunca uno nuevo)");
    expect(botOrdersEndpointUrl("https://kapta.app/", "abc")).toBe(`https://kapta.app${BOT_ORDERS_PATH}/abc`);
  });

  it("el workflow de carritos ya no dice que el bot crea en Shopify después del corte", () => {
    expect(CARRITOS).toContain("**Desde el cierre de Shopify (27-10-2026) esto cambia en una tienda que ya crea sus pedidos en WooCommerce**");
    expect(CARRITOS).toContain("`docs/kapso-pedidos-kapta.md`");
    expect(CARRITOS).not.toContain("El bot ya sabe generar pedidos en Shopify (lo hace hoy con ventas del chat).");
  });
});

describe("DEPLOY.md", () => {
  const title = "### 23-10-2026 · Pedidos del bot de Kapso por Kapta (0277, MOM §38.13)";
  it("la entrada existe: la 0277 antes del código, con sus consultas, el secreto el 27-10 y la marcha atrás", () => {
    const start = DEPLOY.indexOf(title);
    expect(start).toBeGreaterThan(-1);
    const next = DEPLOY.indexOf("\n### ", start + 10);
    const body = flat(DEPLOY.slice(start, next === -1 ? undefined : next));
    expect(body).toContain("**Migración `0277_bot_orders.sql`, a mano y ANTES del código.**");
    expect(body).toContain("**Antes** (solo lectura)");
    expect(body).toContain("**Después** (solo lectura)");
    expect(body).toContain("**El 27-10, después de pasar la tienda a WooCommerce**");
    expect(body).toContain("**«Generar secreto»**");
    expect(body).toContain("**Marcha atrás.**");
    expect(body).toContain("**«Desactivar»**");
    expect(body).toContain("`maxDuration = 60`");
  });
});
