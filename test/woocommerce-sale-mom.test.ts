// MOM §38.12 («Generar pedido» y los buscadores en WooCommerce, y el cambio de
// plataforma) atado a lo que de verdad corre: los topes, los nombres y lo que
// el MOM promete que existe. Las reglas, a fondo, en
// test/woocommerce-orders.test.ts, test/woocommerce-generate-order.test.ts y
// test/woocommerce-platform-switch.test.ts.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WOO_CART_SALE_CHANNEL,
  WOO_COD_TITLE,
  WOO_FREE_SHIPPING,
  WOO_SALE_BUDGET_MS,
  WOO_SALE_CHANNEL,
  WOO_SALE_LOOKBACK_MS,
  WOO_SALE_TIMEOUTS,
  WOO_SEARCH_BUDGET_MS,
  WOO_SEARCH_CONCURRENCY,
  WOO_SEARCH_MAX_PRODUCTS,
  WOO_SEARCH_MAX_VARIATIONS,
} from "@/lib/woocommerce-orders";
import { WOO_CHANNEL_TAGS, WOO_META } from "@/lib/woocommerce";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");
const DEPLOY = read("DEPLOY.md");

function section(title: string): string {
  const start = MOM.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = MOM.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

const S38_1 = section("### 38.1 La plataforma de la tienda y la del pedido");
const S38_11 = section("### 38.11 La entrada de pedidos de WooCommerce");
const S38_12 = section("### 38.12 Lo que decide la plataforma del pedido");
const VENTA = section("#### «Generar pedido» y los buscadores en WooCommerce (23-10-2026)");

describe("MOM §38.1 · quién lee y quién cambia stores.platform", () => {
  it("lo leen «Generar pedido» y los buscadores; lo cambia el owner en Ajustes; la entrada no lo mira", () => {
    expect(S38_1).toContain("**Quién lo lee (23-10-2026, 38.12):** «Generar pedido» (y «Venta telefónica», que abre el mismo formulario)");
    expect(S38_1).toContain("La entrada de pedidos no lo mira (38.11)");
    expect(S38_1).toContain("Ajustes → WooCommerce → «Crear los pedidos nuevos en»");
    expect(S38_1).toContain("cuándo la tienda pasó a WooCommerce por primera vez (no se mueve después, 38.12)");
    // Las fotos de WhatsApp después del cierre también lo miran (§39.5).
    expect(S38_1).toContain("las fotos de producto de WhatsApp (`shopifyGoneForStore`, §39.5");
    expect(read("lib/product-photos.ts")).toContain('row.platform === "woocommerce"');
  });

  it("la tabla de permisos ya no dice «crear pedidos en Shopify»", () => {
    expect(MOM).not.toContain("crear pedidos en Shopify,");
    expect(MOM).toContain("crear pedidos en la tienda (Shopify o WooCommerce según `stores.platform`, §38.12)");
  });

  it("38.11 sigue diciendo que guardar las claves no cambia la plataforma, y quién la cambia", () => {
    expect(S38_11).toContain("**No cambia `stores.platform`**");
    expect(S38_11).toContain("guardar o probar las claves nunca lo toca");
  });
});

describe("MOM §38.12 · el pedido en WooCommerce", () => {
  it("pending → comparación → processing; si no cuadra, DELETE force", () => {
    expect(VENTA).toContain("crea el pedido `pending`, que la entrada no toma (38.3)");
    expect(VENTA).toContain("`DELETE /orders/<id>?force=true`");
    expect(VENTA).toContain('`PUT {status: "processing"}`');
    expect(VENTA).toContain("**`processing`, no «Por confirmar».**");
  });

  it("el cuerpo: contraentrega, por SKU, regalo a S/ 0, envío a S/ 0 y los metadatos del código", () => {
    expect(VENTA).toContain(`(«${WOO_COD_TITLE}»`);
    expect(VENTA).toContain(`(\`${WOO_FREE_SHIPPING.method_id}\`)`);
    expect(VENTA).toContain(`\`${WOO_META.channel} = ${WOO_SALE_CHANNEL}\``);
    expect(VENTA).toContain(`\`${WOO_META.leadId}\`, \`${WOO_META.requestId}\` y \`${WOO_META.requestHash}\``);
    expect(VENTA).toContain("Un regalo a S/ 0 va a S/ 0.");
    expect(VENTA).toContain("**No lleva `kapso_conversation_id`**");
    // `venta_manual` es la etiqueta de la asesora (38.5), la misma de Shopify.
    expect(WOO_CHANNEL_TAGS[WOO_SALE_CHANNEL]).toEqual(["venta_manual"]);
    // El carrito completado: «Web · carrito completado», como en Shopify (owner, 23-10-2026).
    expect(WOO_CHANNEL_TAGS[WOO_CART_SALE_CHANNEL]).toEqual(["easysell-abandoned-checkout"]);
    expect(VENTA).toContain("**El canal del carrito completado, como en Shopify (decisión del owner, 23-10-2026):**");
    expect(VENTA).toContain(`\`kapta_channel = ${WOO_CART_SALE_CHANNEL}\` en vez de \`venta_manual\``);
    expect(VENTA).not.toContain("a decidir por el owner:** allí el carrito");
  });

  it("lo que se frena antes de llamar: ítems manuales (el formulario no los ofrece), variaciones sin SKU, sin precio, negativos", () => {
    expect(VENTA).toContain("**Ítems manuales.**");
    expect(VENTA).toContain("WooCommerce no crea productos sin SKU.");
    expect(read("components/leads-drawer.tsx")).toContain('platform === "woocommerce" ? (');
    expect(read("components/leads-drawer.tsx")).toContain('platform !== "shopify" ? null : (');
    expect(VENTA).toContain("**Una variación sin SKU propio**");
    expect(VENTA).toContain("**Un producto sin precio.**");
    expect(VENTA).toContain("Un regalo es un precio de 0, no la falta de precio.");
    expect(VENTA).toContain("**Un precio negativo**");
    expect(VENTA).not.toContain("Una línea sin precio pactado va a precio de catálogo");
  });

  it("nunca se borra a ciegas: solo lo que se vio pending después de un «no» de WooCommerce", () => {
    expect(VENTA).toContain("**Solo se borra lo que se VIO `pending` después de que WooCommerce contestara que no**");
    expect(VENTA).toContain("**Si un plugin ya dejó el pedido vivo al crearlo**");
    expect(VENTA).toContain('(`PUT {status: "cancelled"}`)');
    expect(VENTA).not.toContain("si no, se borra y la venta no se da por hecha");
  });

  it("el reintento: adoptar solo con la misma huella; si cambió, no se registra; pending se retoma", () => {
    expect(VENTA).toContain("**vivo, con la misma huella y los precios en regla**");
    expect(VENTA).toContain("**no se registra con lo de ahora ni se crea otro**");
    expect(VENTA).toContain("se **retoma** (paso 5), sin borrar");
    expect(VENTA).toContain("si no se puede borrar, no se crea otro");
    expect(VENTA).toContain("**Dos llamadas a la vez con el mismo id**");
  });

  it("el carrito abierto del lead queda recuperado, con el canal de Shopify (owner, 23-10-2026)", () => {
    expect(VENTA).toContain("es un **carrito recuperado**, como en Shopify");
    expect(VENTA).not.toContain("**Una diferencia con Shopify, a decidir por el owner:**");
  });

  it("el reintento: el id del intento y la ventana de 2 horas del código", () => {
    expect(WOO_SALE_LOOKBACK_MS).toBe(2 * 60 * 60_000);
    expect(VENTA).toContain("**Un doble clic o un reintento no crea dos pedidos.**");
    expect(VENTA).toContain("en las últimas 2 horas");
  });

  it("los topes de cada llamada y el reloj de la venta son los del código, bajo el maxDuration de Leads", () => {
    const t = WOO_SALE_TIMEOUTS;
    expect(VENTA).toContain(
      `buscar el intento ${t.lookup / 1000} s, crear ${t.create / 1000} s, comprobar un producto ${t.verify / 1000} s, pasar a \`processing\` ${t.update / 1000} s, releer, borrar o anular ${t.cleanup / 1000} s`,
    );
    expect(VENTA).toContain(`un reloj de ${WOO_SALE_BUDGET_MS / 1000} s (\`WOO_SALE_BUDGET_MS\`)`);
    // Cada llamada cabe en el reloj, y el reloj (más la base) en la función de la página.
    for (const ms of Object.values(t)) expect(ms).toBeLessThanOrEqual(WOO_SALE_BUDGET_MS);
    const page = read("app/dashboard/leads/page.tsx");
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(page)?.[1]);
    expect(maxDuration).toBe(300);
    expect(WOO_SALE_BUDGET_MS + 15_000).toBeLessThan(maxDuration * 1000);
    expect(VENTA).toContain("La página de Leads da 300 s a su función (`maxDuration`");
  });

  it("el buscador: los topes del código, y la variación por su SKU", () => {
    expect(VENTA).toContain("pegar el SKU de una talla la encuentra, como en Shopify");
    expect(VENTA).toContain(`per_page=${WOO_SEARCH_MAX_PRODUCTS}`);
    expect(VENTA).toContain(`de a ${WOO_SEARCH_CONCURRENCY}`);
    expect(VENTA).toContain(
      `${WOO_SEARCH_MAX_PRODUCTS} productos, ${WOO_SEARCH_MAX_VARIATIONS} variaciones cada uno y ${WOO_SEARCH_BUDGET_MS / 1000} s en total`,
    );
  });

  it("el cambio de plataforma y su vuelta atrás", () => {
    expect(VENTA).toContain("**El cambio de plataforma**");
    expect(VENTA).toContain("`platform_switched_at` se fija la primera vez y no se mueve");
    expect(VENTA).toContain("Volver a Shopify solo cambia `platform` y no prueba nada: es la marcha atrás.");
    expect(VENTA).toContain("**lee y deja escribir**");
    expect(VENTA).toContain("(`POST /orders/batch` con `{}`");
    expect(VENTA).toContain("Nunca toca `woo_intake_from`, las claves de WooCommerce ni el token de Shopify.");
  });

  it("lo que falta: los carritos y la boleta; el bot ya está (38.13); ya no dice que nadie lee stores.platform", () => {
    expect(S38_12).toContain("**El endpoint del bot** (`POST /api/internal/orders/[storeId]`): **hecho (23-10-2026, 38.13)**");
    expect(S38_12).toContain("el candado en la base por (tienda, id del intento)");
    expect(S38_12).not.toContain("necesita un candado en la base por (tienda, id del intento)");
    expect(S38_12).toContain("**Los carritos.**");
    expect(S38_12).toContain("**La boleta de un pedido de WooCommerce** espera su lector");
    expect(S38_12).not.toContain("`stores.platform` todavía no lo lee nadie");
  });

  it("§17.3: «Generar pedido» crea en la tienda según stores.platform", () => {
    expect(flat(MOM)).toContain("«Generar pedido» crea el pedido en la tienda (Shopify o WooCommerce según `stores.platform`, §38.12)");
  });

  it("los archivos que nombra existen", () => {
    for (const f of [
      "lib/woocommerce-orders.ts",
      "lib/woocommerce-platform.ts",
      "app/dashboard/[storeId]/settings/woo-platform-actions.ts",
      "test/woocommerce-orders.test.ts",
      "test/woocommerce-generate-order.test.ts",
      "test/woocommerce-platform-switch.test.ts",
      "test/woocommerce-sale-mom.test.ts",
    ]) {
      expect(S38_12, f).toContain(`\`${f}\``);
      expect(existsSync(resolve(process.cwd(), f)), f).toBe(true);
    }
  });
});

describe("DEPLOY.md", () => {
  it("la entrada existe, sin migración, después de la de la entrada de pedidos", () => {
    const title = "### 23-10-2026 · «Generar pedido» y los buscadores en WooCommerce, y el cambio de plataforma (sin migración, MOM §38.12)";
    const entry = DEPLOY.indexOf(title);
    expect(entry).toBeGreaterThan(DEPLOY.indexOf("### 25-10-2026 · Entrada de pedidos de WooCommerce"));
    const body = flat(DEPLOY.slice(entry, DEPLOY.indexOf("\n### ", entry + 10) === -1 ? undefined : DEPLOY.indexOf("\n### ", entry + 10)));
    expect(body).toContain("**Sin migración**");
    expect(body).toContain("**Marcha atrás.**");
    expect(body).toContain("«Crear los pedidos nuevos en» → **Shopify**");
    expect(body).toContain("**La clave de la API tiene que ser de «Lectura/Escritura»**");
    expect(body).toContain("**El 26-10, en el sitio de staging**");
    expect(body).toContain("`maxDuration = 300`");
    for (const ev of ["woo.sale.conflict", "woo.sale.kept_pending", "woo.sale.unknown", "woo.sale.cancelled", "woo.sale.resumed"]) {
      expect(body).toContain(`\`${ev}\``);
    }
  });

  it("y de verdad no trajo migración: la siguiente a la 0276 es la del bot (0277, MOM §38.13), con su propia entrada", () => {
    const files = readdirSync(resolve(process.cwd(), "db/migrations")).filter((f) => /^\d{4}_/.test(f)).sort();
    // La que sigue a la 0276 es la del bot; las posteriores (0278, historial de
    // Shopify, MOM §37.6) no son de esta venta.
    expect(files.filter((f) => f > "0276_shopify_history_imports.sql")[0]).toBe("0277_bot_orders.sql");
    expect(DEPLOY).toContain("### 23-10-2026 · Pedidos del bot de Kapso por Kapta (0277, MOM §38.13)");
  });
});
