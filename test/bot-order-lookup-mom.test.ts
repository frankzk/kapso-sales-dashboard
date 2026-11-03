// MOM §38.13, «Consultar un pedido que ya existe» (25-10-2026), atado a lo que
// de verdad corre: la ruta y su maxDuration, los códigos con su HTTP y si se
// reintentan, los campos del cuerpo y de la respuesta, la decisión de
// privacidad y la regla del workflow de Kapso en el contrato
// (docs/kapso-pedidos-kapta.md, sección 10). Las reglas, a fondo, en
// test/bot-order-lookup.test.ts.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BOT_ORDER_DB_TIMEOUT_MS, BOT_ORDERS_PATH } from "@/lib/bot-orders";
import {
  BOT_ORDER_LOOKUP_CODES,
  BOT_ORDER_LOOKUP_FIELDS,
  BOT_ORDER_LOOKUP_HTTP,
  BOT_ORDER_LOOKUP_MAX_BODY_BYTES,
  BOT_ORDER_LOOKUP_MAX_RETRIES,
  BOT_ORDER_LOOKUP_RETRYABLE,
  BOT_ORDER_LOOKUP_RETRY_AFTER_S,
  BOT_ORDER_LOOKUP_SUFFIX,
  botLookupOrder,
} from "@/lib/bot-order-lookup";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");
const CONTRATO_RAW = read("docs/kapso-pedidos-kapta.md");
const ROUTE = read("app/api/internal/orders/[storeId]/lookup/route.ts");

function section(text: string, title: string): string {
  const start = text.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = text.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

const S38_13 = section(MOM, "### 38.13 Pedidos del bot de Kapso por Kapta (23-10-2026)");
const S10 = section(CONTRATO_RAW, "## 10. Consultar un pedido que ya existe (25-10-2026)");

/** Las claves de un objeto, aplanadas como las nombra el contrato (`delivery.mode`, `items[].title`). */
function flatKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.length ? flatKeys(value[0], `${prefix}[]`) : [];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      return v && typeof v === "object" ? [key, ...flatKeys(v, key)].filter((x) => !(Array.isArray(v) && x === key)) : [key];
    });
  }
  return [];
}

describe("MOM §38.13: consultar un pedido que ya existe", () => {
  it("el caso, la ruta, la misma puerta y el mismo tope de la base", () => {
    expect(S38_13).toContain("**Consultar un pedido que ya existe (25-10-2026).**");
    expect(S38_13).toContain("deseo confirmar mi pedido KP200001 y pagaré S/ 599.60 en casa");
    expect(S38_13).toContain(`\`POST ${BOT_ORDERS_PATH}/<storeId>${BOT_ORDER_LOOKUP_SUFFIX}\``);
    expect(S38_13).toContain("**el mismo secreto y la misma puerta** que para crear (`authenticateBotCall`");
    expect(S38_13).toContain("(`withTimeout`, `BOT_ORDER_DB_TIMEOUT_MS`)");
    expect(read("lib/bot-orders.ts")).toContain("export async function authenticateBotCall(");
  });

  it("solo lectura: no crea, no escribe, no llama a la tienda ni mira su plataforma", () => {
    expect(S38_13).toContain(
      "**Solo lectura**: no crea, no escribe nada (tampoco el último uso de Ajustes), no llama a WooCommerce ni a Shopify y no mira la plataforma de la tienda",
    );
    // Ni la ruta ni la consulta importan los clientes de la tienda, la entrada
    // de pedidos ni `after` (lo que corre después de responder, para escribir).
    const imports = (path: string) => [...read(path).matchAll(/^import\b[^;]*? from "([^"]+)";$/gm)].map((m) => m[1]!);
    const lookupImports = [...imports("app/api/internal/orders/[storeId]/lookup/route.ts"), ...imports("lib/bot-order-lookup.ts")];
    expect(lookupImports.length).toBeGreaterThan(5);
    for (const banned of ["@/lib/woocommerce", "@/lib/woocommerce-orders", "@/lib/shopify", "@/lib/ingest", "@/lib/order-sale", "@/lib/leads-ingest"]) {
      expect(lookupImports, banned).not.toContain(banned);
    }
    expect(ROUTE).not.toMatch(/\bafter\b[,(]/);
  });

  it("la privacidad: número y celular en la misma consulta; otro celular es exactamente un número que no existe", () => {
    expect(S38_13).toContain("**La privacidad (decisión de diseño, 25-10-2026):**");
    expect(S38_13).toContain("**exactamente** la de un número que no existe, 404 `not_found`");
    expect(S38_13).toContain("Kapta nunca lee el pedido de otro celular");
    expect(S38_13).toContain("nunca el de la guía");
    expect(S38_13).toContain(`reintentable una vez a los ${BOT_ORDER_LOOKUP_RETRY_AFTER_S} s`);
  });

  it("la regla del workflow, y apunta al contrato", () => {
    expect(S38_13).toContain("**La regla del workflow** (la edita el owner en Kapso)");
    expect(S38_13).toContain("(nunca el monto escrito en el mensaje)");
    expect(S38_13).toContain("`docs/kapso-pedidos-kapta.md`, sección 10");
  });

  it("los archivos que nombra existen", () => {
    for (const f of [
      "lib/bot-order-lookup.ts",
      "app/api/internal/orders/[storeId]/lookup/route.ts",
      "test/bot-order-lookup.test.ts",
      "test/bot-order-lookup-mom.test.ts",
    ]) {
      expect(S38_13, f).toContain(`\`${f}\``);
      expect(existsSync(resolve(process.cwd(), f)), f).toBe(true);
    }
  });
});

describe("el contrato, sección 10", () => {
  it("la regla: la expresión, no cotizar ni crear, el total de Kapta, «pedido ya creado» y una asesora", () => {
    expect(S10).toContain("/deseo confirmar mi pedido\\s*#?\\s*((?:KP|AUR)\\d+)/i");
    // La expresión del contrato reconoce el texto de la página de gracias.
    const re = /deseo confirmar mi pedido\s*#?\s*((?:KP|AUR)\d+)/i;
    expect(re.exec("¡Felicidades! … deseo confirmar mi pedido KP200001 y pagaré S/ 599.60 en casa")?.[1]).toBe("KP200001");
    expect(re.exec("Deseo confirmar mi pedido #aur900001")?.[1]).toBe("aur900001");
    expect(S10).toContain("**No cotiza, no muestra un resumen con sus precios y no crea ningún pedido**");
    expect(S10).toContain("el `phone_number` de **la conversación**, nunca un celular escrito en el mensaje");
    expect(S10).toContain("**Nunca el monto, los productos ni la dirección que vienen en el mensaje**");
    expect(S10).toContain("**marca la conversación como «pedido ya creado»**");
    expect(S10).toContain("consulta **una sola vez más**");
    expect(S10).toContain("**deriva a una asesora**");
  });

  it("la llamada: la misma dirección + /lookup, el mismo secreto, POST, 20 s, 2 KB", () => {
    expect(S10).toContain(`POST https://<Kapta>${BOT_ORDERS_PATH}/<storeId>${BOT_ORDER_LOOKUP_SUFFIX}`);
    expect(S10).toContain("**La dirección es la de crear más `/lookup`** y **el secreto es el mismo**");
    expect(S10).toContain("Tiempo de espera de la acción: **20 s**");
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(ROUTE)?.[1]);
    expect(maxDuration).toBe(20);
    // Los tres pasos de la base (secreto, pedido, Master), con su tope, caben.
    expect(3 * BOT_ORDER_DB_TIMEOUT_MS).toBeLessThan(maxDuration * 1000);
    expect(BOT_ORDER_LOOKUP_MAX_BODY_BYTES).toBe(2_048);
    expect(S10).toContain("El cuerpo, como mucho 2 KB");
  });

  it("los campos del cuerpo son los que acepta el código", () => {
    expect([...BOT_ORDER_LOOKUP_FIELDS]).toEqual(["order_name", "phone"]);
    for (const f of BOT_ORDER_LOOKUP_FIELDS) expect(S10, f).toContain(`| \`${f}\` | texto | sí |`);
  });

  it("cada campo de la respuesta está en la tabla, y la tabla no nombra campos que no existen", () => {
    const order = botLookupOrder(
      {
        id: "o1",
        name: "#KP200001",
        platform: "woocommerce",
        created_at: "2026-10-24T21:14:03Z",
        total_amount: 599.6,
        currency: "PEN",
        financial_status: "pending",
        payment_gateway: "cod",
        total_refunded: 0,
        cancelled_at: null,
        customer_phone: "51999000111",
        shipping_mode: null,
        line_items: [{ title: "Zapatilla", variant_title: "38", quantity: 1 }],
        raw: null,
      },
      { general_status: "pendiente", macro_stage: "por_confirmar", macro_substage: "sin_llamar", district: "Surco", address: "Av. 1", payment_state: null },
    );
    const keys = flatKeys(order);
    expect(keys.sort()).toEqual(
      [
        "name",
        "platform",
        "created_at",
        "total",
        "currency",
        "payment",
        "cancelled",
        "delivery",
        "delivery.mode",
        "delivery.district",
        "delivery.address1",
        "items[].title",
        "items[].variant",
        "items[].quantity",
        "master",
        "master.stage",
        "master.stage_label",
        "master.substage",
        "master.substage_label",
      ].sort(),
    );
    for (const k of keys.filter((k) => k !== "delivery")) expect(S10, k).toContain(`| \`${k}\` |`);
    const documented = [...S10.matchAll(/\| `([a-z_.[\]]+)` \| (?:texto|número|sí\/no|entero|objeto)/g)].map((m) => m[1]!);
    for (const d of documented.filter((d) => !(BOT_ORDER_LOOKUP_FIELDS as readonly string[]).includes(d))) {
      expect(keys, d).toContain(d);
    }
  });

  it("cada código, con su HTTP y si se reintenta; una sola consulta más, a los 10 s", () => {
    expect(BOT_ORDER_LOOKUP_CODES).toHaveLength(7);
    for (const code of BOT_ORDER_LOOKUP_CODES) {
      const http = BOT_ORDER_LOOKUP_HTTP[code];
      const retry = BOT_ORDER_LOOKUP_RETRYABLE.has(code);
      expect(S10, code).toContain(`| \`${code}\` | ${http} | ${retry ? "sí" : "no"} |`);
    }
    expect(BOT_ORDER_LOOKUP_HTTP.not_found).toBe(404);
    expect(BOT_ORDER_LOOKUP_RETRY_AFTER_S).toBe(10);
    expect(BOT_ORDER_LOOKUP_MAX_RETRIES).toBe(1);
    expect(S10).toContain("**una sola** consulta más, a los `retry_after_seconds` (10 s; también en la cabecera `Retry-After`)");
  });

  it("la privacidad: la misma respuesta para «no existe» y «es de otro celular», y por qué", () => {
    expect(S10).toContain("**Con otro celular la respuesta es exactamente la de un número que no existe**");
    expect(S10).toContain("Kapta nunca lee el pedido de otro celular, así que tampoco sabe cuál de las dos es");
    expect(S10).toContain("El celular de la **guía** del courier no cuenta");
    expect(S10).toContain("**Nunca** «ese pedido no existe» ni «ese pedido no es tuyo»");
  });

  it("la introducción del contrato apunta a la sección 10", () => {
    expect(flat(CONTRATO_RAW)).toContain("**Un pedido que ya existe no se vuelve a crear.**");
  });
});
