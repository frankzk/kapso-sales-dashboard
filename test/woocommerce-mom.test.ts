// WooCommerce (MOM §37, 23-10-2026) y la regla de §3 «Pedido», que dejó de
// decir solo Shopify. La regla vive repartida entre la 0273 (lo que la base
// acepta), lib/woocommerce.ts (cómo se traduce un pedido), DEPLOY.md y
// verify-db.sh, y ninguno falla solo si se separa del MOM. Estas pruebas atan
// cada nombre y cada valor del MOM a lo que de verdad corre. Las reglas, a
// fondo, en test/woocommerce.test.ts y scripts/sql/woocommerce_base_smoke.sql.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WOO_CANCELLED_STATUSES,
  WOO_CHANNEL_TAGS,
  WOO_ORDER_TOPICS,
  WOO_PE_STATE_NAMES,
  WOO_SITE_KEY_RE,
  WOO_SKIPPED_STATUSES,
  WOO_TIMEOUT_MS,
  mapWooOrder,
  toWooPeruState,
  wooOrderId,
  type WooOrder,
} from "@/lib/woocommerce";
import { ORDER_PLATFORMS } from "@/lib/types";
import { SALES_CHANNEL_OPTIONS, salesChannel } from "@/lib/sales-channel";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");
const MIGRATION = read("db/migrations/0273_woocommerce_base.sql");
/** La migración sin comentarios: lo que de verdad corre. */
const MIGRATION_SQL = flat(MIGRATION.replace(/--.*$/gm, ""));
const DEPLOY = flat(read("DEPLOY.md"));

/** El texto de una sección del MOM, desde su título hasta el siguiente del mismo nivel o superior. */
function section(title: string): string {
  const start = MOM.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = MOM.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

describe("§3 Pedido: orden comercial creada en la tienda (Shopify o WooCommerce)", () => {
  const pedido = section("### Pedido");

  it("la definición nombra las dos plataformas y la columna que las distingue", () => {
    expect(pedido).toContain(
      "Orden comercial creada en la tienda (Shopify o WooCommerce). Tiene una identidad única y puede sobrevivir a múltiples intentos logísticos.",
    );
    expect(pedido).toContain("De qué plataforma vino cada pedido lo guarda `orders.platform` (§37, 23-10-2026)");
    expect(flat(MOM)).not.toContain("Orden comercial creada en Shopify.");
  });

  it("el canal de venta no cambia: WooCommerce escribe las mismas etiquetas", () => {
    expect(pedido).toContain("Todos los pedidos nacen en la tienda, pero no por el mismo camino");
    expect(pedido).toContain("Kapta le escribe las mismas palabras de esta tabla desde sus metadatos (§37.5), así que la regla no cambia.");
  });
});

describe("§37 WooCommerce (23-10-2026)", () => {
  const s37 = section("## 37. WooCommerce (23-10-2026)");

  it("fecha, migración a mano antes del código, el corte y la decisión pendiente del owner", () => {
    expect(s37).toContain("La migración 0273 se aplica a mano y antes del código (DEPLOY.md, entrada del 23-10-2026).");
    expect(s37).toContain("Shopify cierra Kenku Perú y Aurela el 28-10-2026 (UTC)");
    expect(s37).toContain("el lunes 27-10 a las 19:00 de Lima");
    expect(s37).toContain("Pendiente del owner: si WooCommerce va en la **misma fila** de la tienda");
  });

  it("37.1 dos plataformas y ninguna otra, en las tres tablas, como en la 0273", () => {
    expect(s37).toContain("**`orders.platform`** (y `draft_orders.platform`) dice de qué plataforma vino cada pedido: `shopify` o `woocommerce`. No hay otro valor.");
    expect(s37).toContain("**`stores.platform`** dice dónde se crean los pedidos **nuevos** que Kapta crea para esa tienda");
    expect([...ORDER_PLATFORMS]).toEqual(["shopify", "woocommerce"]);
    for (const table of ["stores", "orders", "draft_orders"]) {
      expect(MIGRATION_SQL).toContain(
        `alter table ${table} add column if not exists platform text not null default 'shopify' constraint ${table}_platform_check check (platform in ('shopify', 'woocommerce'))`,
      );
    }
    expect(s37).toContain("**todo lo que dependa de la plataforma se decide con `orders.platform`, nunca por la forma del id**");
  });

  it("37.1 las columnas de la tienda y los candados de la base existen en la 0273", () => {
    for (const col of [
      "woo_site_url",
      "woo_site_key",
      "woo_consumer_key_enc",
      "woo_consumer_secret_enc",
      "woo_webhook_secret_enc",
      "woo_last_error",
      "platform_switched_at",
    ]) {
      expect(s37).toContain(`\`${col}\``);
      expect(MIGRATION_SQL).toContain(`add column if not exists ${col}`);
    }
    for (const name of [
      "stores_woo_platform_check",
      "stores_woo_site_key_check",
      "stores_woo_site_url_check",
      "stores_woo_site_key_uniq",
      "stores_woo_site_url_uniq",
    ]) {
      expect(s37).toContain(`\`${name}\``);
      expect(MIGRATION_SQL).toContain(name);
    }
    expect(MIGRATION_SQL).toContain(
      "platform <> 'woocommerce' or (woo_site_url is not null and woo_site_key is not null and woo_consumer_key_enc is not null and woo_consumer_secret_enc is not null)",
    );
    // No toca filas ni shopify_domain.
    expect(MIGRATION_SQL).not.toMatch(/\bupdate\s+(stores|orders|draft_orders)\b/i);
    expect(MIGRATION_SQL).not.toContain("shopify_domain");
  });

  it("37.2 el id wc-<clave>-<id> y la forma de la clave, iguales en el MOM, el código y la base", () => {
    expect(s37).toContain('`orders.shopify_order_id = "wc-<clave del sitio>-<id de WooCommerce>"`');
    expect(s37).toContain("por ejemplo `wc-kp-1532` o `wc-aur-1532`");
    expect(wooOrderId("kp", 1532)).toBe("wc-kp-1532");
    expect(wooOrderId("aur", 1532)).toBe("wc-aur-1532");
    expect(s37).toContain("La clave son minúsculas y dígitos, de 2 a 12, empezando por letra (`stores_woo_site_key_check`)");
    expect(WOO_SITE_KEY_RE.source).toBe("^[a-z][a-z0-9]{1,11}$");
    expect(MIGRATION_SQL).toContain("woo_site_key ~ '^[a-z][a-z0-9]{1,11}$'");
    expect(s37).toContain('**Nombre:** `"#" + number`');
    expect(s37).toContain("las `*_gmt` de WooCommerce, que llegan sin zona, más «Z»");
  });

  it("37.3 los estados que no entran y los anulados son los del código", () => {
    expect(s37).toContain(
      "| `pending`, `failed`, `checkout-draft` (y los borradores internos `draft`, `auto-draft`) | No es un pedido: no entra a `orders` ni al Master. |",
    );
    expect([...WOO_SKIPPED_STATUSES]).toEqual(["pending", "failed", "checkout-draft", "draft", "auto-draft"]);
    expect(s37).toContain("| `cancelled`, `trash` | Anulado: `financial_status = voided` y `cancelled_at`. |");
    expect([...WOO_CANCELLED_STATUSES]).toEqual(["cancelled", "trash"]);
    expect(s37).toContain("la **primera vez**, y la conserva en los cambios siguientes.");
  });

  it("37.4 contraentrega siempre pending: date_paid nunca cuenta como pagado", () => {
    expect(s37).toContain("pasarela `cod` y `financial_status = pending` **siempre**");
    expect(s37).toContain("así que `date_paid` nunca cuenta como pagado.");
    const order = {
      id: 7,
      number: "KP200007",
      status: "processing",
      currency: "PEN",
      total: "99.00",
      payment_method: "cod",
      payment_method_title: "Pago contra entrega",
      date_created_gmt: "2026-10-28T02:00:00",
      date_modified_gmt: "2026-10-28T02:00:05",
      date_paid_gmt: "2026-10-28T02:00:05",
    } satisfies WooOrder;
    const row = mapWooOrder(order, { id: "s", woo_site_key: "kp" })!;
    expect(row.financial_status).toBe("pending");
    expect(row.payment_gateway).toBe("cod");
  });

  it("37.5 la tabla de kapta_channel es WOO_CHANNEL_TAGS, y cada fila da el canal que dice", () => {
    const labels = new Map(SALES_CHANNEL_OPTIONS.map((o) => [o.value, o.label]));
    const rows: [string[], string[], string][] = [
      [["venta_manual", "asesora"], ["venta_manual"], "asesora"],
      [["kapso", "chatbot"], ["kapso", "whatsapp"], "chatbot"],
      [["bot_carritos"], ["BOT", "CARRITO RECUPERADO"], "bot_carritos"],
      [["catalogo", "catalogo-wsp"], ["catalogo-wsp"], "catalogo"],
      [["web_carrito"], ["easysell-abandoned-checkout"], "web_carrito"],
      [["web_formulario"], ["easysell_cod_form"], "web_formulario"],
    ];
    const keys: string[] = [];
    for (const [values, tags, channel] of rows) {
      const first = values.map((v) => `\`${v}\``).join(" o ");
      expect(s37).toContain(`| ${first} | ${tags.map((t) => `\`${t}\``).join(", ")} | ${labels.get(channel as never)} |`);
      for (const v of values) {
        expect([...WOO_CHANNEL_TAGS[v]!]).toEqual(tags);
        expect(salesChannel(tags)).toBe(channel);
        keys.push(v);
      }
    }
    expect(Object.keys(WOO_CHANNEL_TAGS).sort()).toEqual(keys.sort());
    expect(s37).toContain("o ningún `kapta_channel`, no pone etiqueta: «Sin marca». No se adivina.");
    expect(s37).toContain("El pedido con `kapso_conversation_id`, o con el meta `kapso` verdadero, lleva la etiqueta `kapso`");
  });

  it("37.6 las dos Limas, en las dos direcciones", () => {
    expect(s37).toContain("WooCommerce distingue `LMA` (Municipalidad Metropolitana de Lima) de `LIM`");
    expect(s37).toContain("Kapta las guarda como Shopify: «Lima (provincia)» y «Lima (departamento)»");
    expect(WOO_PE_STATE_NAMES.LMA).toBe("Lima (provincia)");
    expect(WOO_PE_STATE_NAMES.LIM).toBe("Lima (departamento)");
    expect(s37).toContain("«Lima (departamento)» es `LIM` y «Lima» a secas es `LMA`");
    expect(toWooPeruState("Lima (departamento)")).toBe("LIM");
    expect(toWooPeruState("Lima")).toBe("LMA");
    expect(s37).toContain("el atributo «Provincia:» (`PE-LMA`, `PE-LIM`…)");
  });

  it("37.7 raw: el pedido entero en raw.woo y la copia con forma de Shopify REST", () => {
    expect(s37).toContain("`orders.raw` lleva el pedido de WooCommerce entero en `raw.woo`");
    const order = {
      id: 9,
      number: "AUR900001",
      status: "processing",
      currency: "PEN",
      total: "50.00",
      payment_method: "cod",
      date_created_gmt: "2026-10-28T02:00:00",
    } satisfies WooOrder;
    const raw = mapWooOrder(order, { id: "s", woo_site_key: "aur" })!.raw as Record<string, unknown>;
    for (const key of [
      "shipping_address",
      "billing_address",
      "note",
      "note_attributes",
      "payment_gateway_names",
      "subtotal_price",
      "total_discounts",
      "total_shipping_price_set",
      "total_price",
    ]) {
      expect(s37).toContain(`\`${key}\``);
      expect(raw).toHaveProperty(key);
    }
    expect(raw.woo).toEqual(order);
  });

  it("37.8 webhooks y API: temas, firma, duplicados por cuerpo y 15 s", () => {
    for (const topic of WOO_ORDER_TOPICS) expect(s37).toContain(`\`${topic}\``);
    expect(s37).toContain("`X-WC-Webhook-Signature` es el HMAC-SHA256 del cuerpo crudo con el secreto del webhook, en base64");
    expect(s37).toContain("**Duplicados:** por el sha256 del cuerpo, nunca por `X-WC-Webhook-Delivery-ID`");
    expect(s37).toContain("Cada llamada corta a los **15 segundos** y no sigue redirecciones.");
    expect(WOO_TIMEOUT_MS).toBe(15_000);
  });

  it("37.9 Kenku y Aurela no cambian, y lo que sigue pendiente se dice", () => {
    expect(s37).toContain("**Kenku Perú y Aurela siguen en Shopify** hasta el cierre");
    expect(s37).toContain("La 0273 no actualiza ninguna fila");
    expect(s37).toContain("Los mapeadores de Shopify no escriben la plataforma.");
    expect(s37).toContain("Los principios 1-3, 10 y 11 de §2 todavía dicen Shopify.");
  });

  it("DEPLOY.md tiene la entrada, a mano y antes del código; verify-db corre la prueba", () => {
    expect(DEPLOY).toContain("### 23-10-2026 · Base de WooCommerce (0273, MOM §37)");
    expect(DEPLOY).toContain("**Migración `0273_woocommerce_base.sql`, a mano y ANTES del código.**");
    expect(read("scripts/verify-db.sh")).toContain('$PSQL -f "$ROOT/scripts/sql/woocommerce_base_smoke.sql"');
    expect(read("db/apply.sql")).toContain("\\ir migrations/0273_woocommerce_base.sql");
  });
});
