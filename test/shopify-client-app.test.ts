import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { routeShopifyTopic, SHOPIFY_APP_SCOPES } from "@/lib/shopify";
import {
  asPrivacyTopic,
  decideClientInstall,
  LAUNCH_MAX_AGE_SECONDS,
  parsePrivacyPayload,
  pendingInstallUsable,
  storeNameFromShop,
  verifyShopifyLaunch,
} from "@/lib/shopify-client-app";

// App de Shopify para tiendas cliente (MOM §29.15.1, §29.15.9).

const SECRET = "client_app_secret";
const NOW = 1_760_000_000;

function launchParams(extra: Record<string, string> = {}, secret = SECRET): URLSearchParams {
  const base: Record<string, string> = {
    shop: "tienda-cliente.myshopify.com",
    timestamp: String(NOW),
    host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvdGllbmRh",
    ...extra,
  };
  const msg = Object.entries(base)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
  const hmac = createHmac("sha256", secret).update(msg).digest("hex");
  return new URLSearchParams({ ...base, hmac });
}

describe("verifyShopifyLaunch: la app la abre Shopify, nunca un dominio escrito a mano", () => {
  it("acepta una apertura firmada y reciente", () => {
    expect(verifyShopifyLaunch(launchParams(), SECRET, NOW + 5)).toEqual({
      ok: true,
      shop: "tienda-cliente.myshopify.com",
    });
  });

  it("rechaza una firma hecha con otro secreto (la app interna, por ejemplo)", () => {
    expect(verifyShopifyLaunch(launchParams({}, "otro_secreto"), SECRET, NOW)).toEqual({
      ok: false,
      reason: "hmac-invalido",
    });
  });

  it("rechaza un parámetro alterado después de firmar", () => {
    const p = launchParams();
    p.set("shop", "otra-tienda.myshopify.com");
    expect(verifyShopifyLaunch(p, SECRET, NOW)).toEqual({ ok: false, reason: "hmac-invalido" });
  });

  it("rechaza un dominio que no es *.myshopify.com", () => {
    expect(verifyShopifyLaunch(launchParams({ shop: "evil.com" }), SECRET, NOW)).toEqual({
      ok: false,
      reason: "shop-invalido",
    });
  });

  it("rechaza una apertura vieja", () => {
    expect(verifyShopifyLaunch(launchParams(), SECRET, NOW + LAUNCH_MAX_AGE_SECONDS + 1)).toEqual({
      ok: false,
      reason: "vencido",
    });
  });

  it("sin secreto configurado no acepta nada", () => {
    expect(verifyShopifyLaunch(launchParams(), "", NOW)).toEqual({ ok: false, reason: "sin-config" });
  });
});

describe("avisos de privacidad", () => {
  it("reconoce solo los tres temas obligatorios", () => {
    expect(asPrivacyTopic("customers/data_request")).toBe("customers/data_request");
    expect(asPrivacyTopic("CUSTOMERS/REDACT")).toBe("customers/redact");
    expect(asPrivacyTopic("shop/redact")).toBe("shop/redact");
    expect(asPrivacyTopic("orders/create")).toBeNull();
    expect(asPrivacyTopic(null)).toBeNull();
  });

  it("lee la tienda del cuerpo del aviso", () => {
    const parsed = parsePrivacyPayload(
      JSON.stringify({ shop_id: 954889, shop_domain: "Tienda-Cliente.myshopify.com", customer: { id: 191167 } }),
    );
    expect(parsed?.shopDomain).toBe("tienda-cliente.myshopify.com");
    expect(parsed?.shopId).toBe("954889");
    expect(parsed?.payload.customer).toEqual({ id: 191167 });
  });

  it("descarta un cuerpo sin tienda válida o que no es JSON", () => {
    expect(parsePrivacyPayload("no-json")).toBeNull();
    expect(parsePrivacyPayload(JSON.stringify({ shop_domain: "evil.com" }))).toBeNull();
    expect(parsePrivacyPayload(JSON.stringify([1, 2]))).toBeNull();
  });
});

describe("instalación pendiente", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  it("sirve mientras no venza ni se reclame", () => {
    expect(pendingInstallUsable({ expires_at: "2026-10-10T12:20:00Z", claimed_at: null }, now)).toBe(true);
  });
  it("vencida o reclamada ya no sirve", () => {
    expect(pendingInstallUsable({ expires_at: "2026-10-10T11:59:59Z", claimed_at: null }, now)).toBe(false);
    expect(
      pendingInstallUsable({ expires_at: "2026-10-10T12:20:00Z", claimed_at: "2026-10-10T11:58:00Z" }, now),
    ).toBe(false);
  });
});

describe("decideClientInstall", () => {
  it("sin tienda en Kapta → instalación pendiente", () => {
    expect(decideClientInstall([])).toEqual({ kind: "pending" });
  });
  it("tienda ya conectada con la app de clientes → reconexión", () => {
    expect(decideClientInstall([{ id: "s1", org_id: "o1", shopify_app: "clientes" }])).toEqual({
      kind: "reconnect",
      storeId: "s1",
    });
  });
  it("tienda con la app interna (Aurela, Kenku) → no se mezcla", () => {
    expect(decideClientInstall([{ id: "s1", org_id: "o1", shopify_app: "interna" }])).toEqual({
      kind: "conflict",
    });
  });
});

describe("routeShopifyTopic: un tema que no es pedido ya no entra como pedido", () => {
  it("rutea pedidos, borradores y la desinstalación", () => {
    expect(routeShopifyTopic("orders/create")).toBe("order");
    expect(routeShopifyTopic("orders/unknown")).toBe("order");
    expect(routeShopifyTopic("draft_orders/update")).toBe("draft");
    expect(routeShopifyTopic("app/uninstalled")).toBe("uninstalled");
  });
  it("ignora lo demás", () => {
    expect(routeShopifyTopic("shop/update")).toBe("ignore");
    expect(routeShopifyTopic("")).toBe("ignore");
  });
});

describe("detalles", () => {
  it("las dos apps piden los mismos permisos", () => {
    expect(SHOPIFY_APP_SCOPES.split(",")).toEqual([
      "read_orders",
      "read_draft_orders",
      "write_draft_orders",
      "read_products",
      "read_customers",
    ]);
  });
  it("propone un nombre de tienda desde el dominio", () => {
    expect(storeNameFromShop("tienda-cliente-peru.myshopify.com")).toBe("Tienda Cliente Peru");
  });
});
