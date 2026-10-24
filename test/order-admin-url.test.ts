// MOM §38.12 (24-10-2026): el enlace al pedido en el admin de SU tienda.
//
// El caso que lo trajo: en la ficha del Master, la flechita junto al #AUR900004
// (de WooCommerce, `wc-aur-11076`) abrió
// `admin.shopify.com/store/aurela-peru/orders/11076`. Lo decide
// `orders.platform`, nunca la forma del id. Nada aquí llama a Shopify, a
// WooCommerce ni a una base de verdad.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({ createServerSupabaseMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ createServerSupabase: createServerSupabaseMock }));

import {
  CANCELLATION_TASK_STORED_NOTE,
  eventNoteLabel,
  mergePriorOrders,
  orderAdminLink,
  orderPlatform,
  orderPlatformName,
  parseWooOrderId,
  statusSourceLabel,
  wooOrderAdminUrl,
} from "@/lib/order-admin-url";
import { parseWooOrderId as parseWooOrderIdFromWoo } from "@/lib/woocommerce";
import { wooOrderAdminUrl as wooOrderAdminUrlFromOrders } from "@/lib/woocommerce-orders";
import { extractNumericId } from "@/lib/shopify-urls";
import { getCustomerHistory, type PriorOrder } from "@/lib/leads-access";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

const AURELA_SHOP = "aurela-peru.myshopify.com";
const AURELA_SITE = "https://aurela.pe";

describe("orderAdminLink: WooCommerce", () => {
  it("el #AUR900004 (wc-aur-11076) abre WooCommerce, no el pedido 11076 de Shopify", () => {
    const link = orderAdminLink({
      platform: "woocommerce",
      shopifyOrderId: "wc-aur-11076",
      shopDomain: AURELA_SHOP,
      wooSiteUrl: AURELA_SITE,
    });
    expect(link).toEqual({
      url: "https://aurela.pe/wp-admin/admin.php?page=wc-orders&action=edit&id=11076",
      label: "Abrir en WooCommerce",
      platform: "woocommerce",
      platformName: "WooCommerce",
    });
    expect(link!.url).not.toContain("admin.shopify.com");
    // Lo que hacía el bug: el número del id parece de Shopify.
    expect(extractNumericId("wc-aur-11076")).toBe("11076");
  });

  it("el sitio con barra final o con ruta (WordPress en una carpeta)", () => {
    expect(
      orderAdminLink({ platform: "woocommerce", shopifyOrderId: "wc-kp-1532", wooSiteUrl: "https://kenku.pe/" })?.url,
    ).toBe("https://kenku.pe/wp-admin/admin.php?page=wc-orders&action=edit&id=1532");
    expect(
      orderAdminLink({ platform: "woocommerce", shopifyOrderId: "wc-kp-1532", wooSiteUrl: "https://kenku.pe/tienda" })?.url,
    ).toBe("https://kenku.pe/tienda/wp-admin/admin.php?page=wc-orders&action=edit&id=1532");
  });

  it("sin el sitio guardado no hay enlace (ninguno antes que uno equivocado), ni cae a Shopify", () => {
    for (const wooSiteUrl of [null, undefined, "", "   "]) {
      expect(
        orderAdminLink({ platform: "woocommerce", shopifyOrderId: "wc-aur-11076", shopDomain: AURELA_SHOP, wooSiteUrl }),
      ).toBeNull();
    }
  });

  it("un sitio que no es https (lo que la base no deja guardar) tampoco arma enlace", () => {
    for (const wooSiteUrl of ["http://aurela.pe", "javascript:alert(1)", "aurela.pe", "https://user@aurela.pe"]) {
      expect(orderAdminLink({ platform: "woocommerce", shopifyOrderId: "wc-aur-11076", wooSiteUrl })).toBeNull();
    }
  });

  it("un pedido de WooCommerce con un id que no es wc-… no arma enlace, tampoco el de Shopify", () => {
    for (const shopifyOrderId of ["7549608558887", "gid://shopify/Order/7549608558887", "", null, "wc-AUR-11076", "wc-aur-0"]) {
      expect(
        orderAdminLink({ platform: "woocommerce", shopifyOrderId, shopDomain: AURELA_SHOP, wooSiteUrl: AURELA_SITE }),
      ).toBeNull();
    }
  });
});

describe("orderAdminLink: Shopify, como siempre", () => {
  it("un pedido de Shopify abre su admin con la etiqueta de siempre", () => {
    expect(orderAdminLink({ platform: "shopify", shopifyOrderId: "7549608558887", shopDomain: AURELA_SHOP, wooSiteUrl: AURELA_SITE })).toEqual({
      url: "https://admin.shopify.com/store/aurela-peru/orders/7549608558887",
      label: "Abrir en Shopify",
      platform: "shopify",
      platformName: "Shopify",
    });
  });

  it("el sitio de WooCommerce guardado no cambia el enlace de un pedido de Shopify", () => {
    const a = orderAdminLink({ platform: "shopify", shopifyOrderId: "123", shopDomain: AURELA_SHOP, wooSiteUrl: AURELA_SITE });
    const b = orderAdminLink({ platform: "shopify", shopifyOrderId: "123", shopDomain: AURELA_SHOP });
    expect(a).toEqual(b);
  });

  it("acepta el gid de Shopify (la lista en vivo de Leads lo trae así)", () => {
    expect(orderAdminLink({ shopifyOrderId: "gid://shopify/Order/456", shopDomain: "AURELA.MYSHOPIFY.COM" })?.url).toBe(
      "https://admin.shopify.com/store/aurela/orders/456",
    );
  });

  it("sin plataforma es Shopify (como orderPlatformOf): el pedido de antes de la 0274", () => {
    for (const platform of [undefined, null, "", "otra"]) {
      expect(orderAdminLink({ platform, shopifyOrderId: "123", shopDomain: AURELA_SHOP })).toMatchObject({
        label: "Abrir en Shopify",
        platform: "shopify",
      });
    }
  });

  it("la forma del id no elige WooCommerce: sin plataforma, un wc-… no tiene enlace (ni de Shopify)", () => {
    expect(orderAdminLink({ shopifyOrderId: "wc-aur-11076", shopDomain: AURELA_SHOP, wooSiteUrl: AURELA_SITE })).toBeNull();
    expect(
      orderAdminLink({ platform: "shopify", shopifyOrderId: "wc-aur-11076", shopDomain: AURELA_SHOP, wooSiteUrl: AURELA_SITE }),
    ).toBeNull();
  });

  it("el draft-<id> de un borrador no abre el pedido con el número del borrador", () => {
    expect(orderAdminLink({ platform: "shopify", shopifyOrderId: "draft-998877", shopDomain: AURELA_SHOP })).toBeNull();
  });

  it("sin dominio o sin id, nada", () => {
    expect(orderAdminLink({ platform: "shopify", shopifyOrderId: "123", shopDomain: null })).toBeNull();
    expect(orderAdminLink({ platform: "shopify", shopifyOrderId: null, shopDomain: AURELA_SHOP })).toBeNull();
    expect(orderAdminLink({ platform: "shopify", shopifyOrderId: 123, shopDomain: AURELA_SHOP })?.url).toBe(
      "https://admin.shopify.com/store/aurela-peru/orders/123",
    );
  });
});

describe("la plataforma y la fuente del estado, para leer", () => {
  it("orderPlatform: woocommerce solo si lo dice la columna", () => {
    expect(orderPlatform("woocommerce")).toBe("woocommerce");
    for (const v of ["shopify", undefined, null, "", "WooCommerce", 1]) expect(orderPlatform(v)).toBe("shopify");
    expect(orderPlatformName("woocommerce")).toBe("WooCommerce");
    expect(orderPlatformName(undefined)).toBe("Shopify");
  });

  it("status_source = shopify se lee «tienda (WooCommerce)» en un pedido de WooCommerce; lo guardado no cambia", () => {
    expect(statusSourceLabel("shopify", "woocommerce")).toBe("tienda (WooCommerce)");
    expect(statusSourceLabel("shopify", "shopify")).toBe("shopify");
    expect(statusSourceLabel("shopify", undefined)).toBe("shopify");
    expect(statusSourceLabel("aliclik", "woocommerce")).toBe("aliclik");
    expect(statusSourceLabel("manual", "woocommerce")).toBe("manual");
    expect(statusSourceLabel(null, "woocommerce")).toBe("—");
    // El resolver sigue escribiendo `shopify` (lo leen el barrido del cuaderno y
    // la 0270, que miran `status_source`).
    const status = read("lib/order-status.ts");
    expect(status.match(/source: "shopify",/g)?.length).toBe(2);
  });
});

describe("parseWooOrderId y wooOrderAdminUrl viven en un módulo sin Node, y se reexportan", () => {
  it("son las mismas funciones desde lib/woocommerce.ts y lib/woocommerce-orders.ts", () => {
    expect(parseWooOrderIdFromWoo).toBe(parseWooOrderId);
    expect(wooOrderAdminUrlFromOrders).toBe(wooOrderAdminUrl);
    expect(parseWooOrderId("wc-aur-11076")).toEqual({ siteKey: "aur", wooId: "11076" });
    expect(parseWooOrderId("11076")).toBeNull();
  });

  it("lib/order-admin-url.ts y lo que importa no traen nada de Node (los usa el navegador)", () => {
    for (const path of ["lib/order-admin-url.ts", "lib/shopify-urls.ts"]) {
      const src = read(path);
      expect(src, path).not.toMatch(/from "node:/);
      expect(src, path).not.toMatch(/from "@\/lib\/(shopify|woocommerce|woocommerce-orders|db|ingest)"/);
    }
    const imports = [...read("lib/order-admin-url.ts").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["@/lib/shopify-urls", "@/lib/types"]);
  });
});

describe("«Pedidos anteriores» de Leads", () => {
  const order = (name: string, createdAt: string, platform?: "shopify" | "woocommerce"): PriorOrder => ({
    name,
    createdAt,
    amount: 100,
    adminUrl: null,
    ...(platform ? { platform } : {}),
  });

  it("la lista de Shopify manda, pero los pedidos de WooCommerce locales no se pierden", () => {
    const shop = [order("#AUR178540", "2026-10-20T10:00:00Z"), order("#AUR178000", "2026-10-01T10:00:00Z")];
    const local = [
      order("#AUR900004", "2026-10-24T10:00:00Z", "woocommerce"),
      order("#AUR178540", "2026-10-20T10:00:00Z", "shopify"),
    ];
    expect(mergePriorOrders(shop, local).map((o) => o.name)).toEqual(["#AUR900004", "#AUR178540", "#AUR178000"]);
  });

  it("sin pedidos de WooCommerce, la lista de Shopify tal cual", () => {
    const shop = [order("#AUR178540", "2026-10-20T10:00:00Z")];
    expect(mergePriorOrders(shop, [order("#AUR178540", "2026-10-20T10:00:00Z", "shopify")])).toBe(shop);
  });

  it("quedan los tres más nuevos", () => {
    const shop = [1, 2, 3].map((d) => order(`#S${d}`, `2026-10-0${d}T10:00:00Z`));
    const local = [order("#W9", "2026-10-09T10:00:00Z", "woocommerce")];
    expect(mergePriorOrders(shop, local).map((o) => o.name)).toEqual(["#W9", "#S3", "#S2"]);
  });

  describe("getCustomerHistory enlaza cada pedido local a su tienda", () => {
    type Row = Record<string, unknown>;
    let selects: string[];
    function mockOrders(rows: Row[], { platformColumn = true } = {}) {
      selects = [];
      createServerSupabaseMock.mockResolvedValue({
        from: () => {
          let columns = "";
          const q: Record<string, unknown> = {};
          q.select = (cols: string) => {
            columns = cols;
            selects.push(cols);
            return q;
          };
          for (const m of ["eq", "is", "order", "limit"]) q[m] = () => q;
          q.then = (resolve: (v: unknown) => void) =>
            resolve(
              !platformColumn && columns.includes("platform")
                ? { data: null, error: { code: "42703", message: "column orders.platform does not exist" } }
                : { data: rows.map((r) => (platformColumn ? r : { ...r, platform: undefined })), error: null },
            );
          return q;
        },
      });
    }

    const rows: Row[] = [
      { id: "o1", shopify_order_id: "wc-aur-11076", name: "#AUR900004", created_at: "2026-10-24T10:00:00Z", total_amount: 149, total_refunded: 0, line_items: [], platform: "woocommerce" },
      { id: "o2", shopify_order_id: "7549608558887", name: "#AUR178540", created_at: "2026-10-20T10:00:00Z", total_amount: 99, total_refunded: 0, line_items: [], platform: "shopify" },
    ];

    beforeEach(() => createServerSupabaseMock.mockReset());

    it("el de WooCommerce a wp-admin y el de Shopify a Shopify", async () => {
      mockOrders(rows);
      const h = await getCustomerHistory("store-aurela", "51999888777", null, AURELA_SHOP, AURELA_SITE);
      expect(selects[0]).toContain("platform");
      expect(h!.recentOrders).toEqual([
        {
          name: "#AUR900004",
          createdAt: "2026-10-24T10:00:00Z",
          amount: 149,
          adminUrl: "https://aurela.pe/wp-admin/admin.php?page=wc-orders&action=edit&id=11076",
          platform: "woocommerce",
        },
        {
          name: "#AUR178540",
          createdAt: "2026-10-20T10:00:00Z",
          amount: 99,
          adminUrl: "https://admin.shopify.com/store/aurela-peru/orders/7549608558887",
          platform: "shopify",
        },
      ]);
    });

    it("sin el sitio de WooCommerce, ese pedido va sin enlace (nunca al de Shopify)", async () => {
      mockOrders(rows);
      const h = await getCustomerHistory("store-aurela", "51999888777", null, AURELA_SHOP, null);
      expect(h!.recentOrders[0]).toMatchObject({ name: "#AUR900004", adminUrl: null, platform: "woocommerce" });
      expect(h!.recentOrders[1]!.adminUrl).toBe("https://admin.shopify.com/store/aurela-peru/orders/7549608558887");
    });

    it("sin la 0274 se lee sin la columna: todos Shopify y el wc-… sin enlace", async () => {
      mockOrders(rows, { platformColumn: false });
      const h = await getCustomerHistory("store-aurela", "51999888777", null, AURELA_SHOP, AURELA_SITE);
      expect(selects).toHaveLength(2);
      expect(selects[1]).not.toContain("platform");
      expect(h!.recentOrders.map((o) => [o.platform, o.adminUrl])).toEqual([
        ["shopify", null],
        ["shopify", "https://admin.shopify.com/store/aurela-peru/orders/7549608558887"],
      ]);
    });
  });
});

describe("eventNoteLabel: la nota guardada de la tarea de anulación", () => {
  const KIND = "confirmation_cancellation_task_created";

  it("es la que guarda la base (la última definición del RPC y el apply)", () => {
    expect(read("db/migrations/0190_voice_calls.sql")).toContain(`'${CANCELLATION_TASK_STORED_NOTE}'`);
    expect(read("db/apply_bundled.sql")).toContain(`'${CANCELLATION_TASK_STORED_NOTE}'`);
  });

  it("en un pedido de WooCommerce dice WooCommerce; en uno de Shopify o sin plataforma, tal cual", () => {
    expect(eventNoteLabel(KIND, CANCELLATION_TASK_STORED_NOTE, "woocommerce")).toBe(
      "Revisar y anular manualmente en WooCommerce si el cliente no confirmó.",
    );
    expect(eventNoteLabel(KIND, CANCELLATION_TASK_STORED_NOTE, "shopify")).toBe(CANCELLATION_TASK_STORED_NOTE);
    expect(eventNoteLabel(KIND, CANCELLATION_TASK_STORED_NOTE, undefined)).toBe(CANCELLATION_TASK_STORED_NOTE);
  });

  it("no toca otra nota ni otro hecho", () => {
    expect(eventNoteLabel(KIND, "Lo anulé en Shopify yo misma.", "woocommerce")).toBe("Lo anulé en Shopify yo misma.");
    expect(eventNoteLabel("comment", CANCELLATION_TASK_STORED_NOTE, "woocommerce")).toBe(CANCELLATION_TASK_STORED_NOTE);
    expect(eventNoteLabel(KIND, null, "woocommerce")).toBeNull();
    expect(eventNoteLabel(KIND, undefined, "woocommerce")).toBeNull();
  });
});

describe("cada enlace a un pedido pasa por orderAdminLink (fuente)", () => {
  const drawer = read("components/order-drawer.tsx");

  it("la ficha del Master: la flechita y «Revisar en …» con la plataforma del detalle", () => {
    expect(drawer).toContain("orderAdminLink({");
    expect(drawer).toContain("platform: detail.platform,");
    expect(drawer).toContain("wooSiteUrl: storeWooSite?.(row.store_id) ?? null,");
    expect(drawer).toContain("title={adminLink.label}");
    expect(drawer).toContain("en ${adminLink.platformName} (nueva pestaña)");
    expect(drawer).toContain("Revisar en {adminLink.platformName}");
    expect(drawer).not.toContain("shopifyOrderAdminUrl");
    expect(drawer).not.toContain('title="Abrir en Shopify"');
    expect(drawer).not.toContain("Revisar en Shopify");
  });

  it("la ficha nombra la tienda del pedido y lee la fuente del estado por plataforma", () => {
    expect(drawer).toContain("fuente: {statusSourceLabel(detail.row.status_source, detail.platform)}");
    expect(drawer).toContain("const storePlatform = orderPlatformName(detail?.platform);");
    expect(drawer).toContain("la anulación se crea a mano en ${storePlatform}");
    expect(drawer).toContain("sincronizados desde ${storePlatform}");
    expect(drawer).toContain("storePlatform={storePlatform}");
    expect(drawer).not.toContain('"según Shopify"');
    expect(flat(drawer)).toContain("Esta corrección gana sobre {storePlatform}, sobre los");
    expect(drawer).not.toContain("gana sobre Shopify");
    expect(drawer).toContain("{eventNoteLabel(t.kind, t.note ?? t.reason, detail.platform)}");
    // La Mesa de cierre ya no nombra la plataforma: «anulado en la tienda» (owner, 24-10-2026).
    expect(flat(read("components/order-closure-desk.tsx"))).toContain("pero el pedido está anulado en la tienda:");
  });

  it("el detalle trae orders.platform, con la lectura de antes si falta la columna", () => {
    const access = flat(read("lib/orders-master-access.ts"));
    expect(access).toContain('const res = await read(`${ORDER_DETAIL_COLUMNS},platform`);');
    expect(access).toContain("return res.error ? read(ORDER_DETAIL_COLUMNS) : res;");
    expect(access).toContain("platform: orderPlatform(orderRow?.platform),");
  });

  it("el Master y la ficha suelta reciben el sitio de WooCommerce de cada tienda", () => {
    expect(read("components/orders-master.tsx")).toContain("storeWooSite={storeWooSite}");
    expect(read("components/order-drawer-host.tsx")).toContain("storeWooSite={storeWooSite}");
    expect(flat(read("app/dashboard/layout.tsx"))).toContain("woo_site_url: s.woo_site_url ?? null,");
    const access = flat(read("lib/access.ts"));
    expect(access).toContain("let res = await read(`${STORE_SUMMARY_COLUMNS},woo_site_url`);");
    expect(access).toContain("if (res.error) res = await read(STORE_SUMMARY_COLUMNS);");
  });

  it("Leads: la lista local con orderAdminLink, el sitio desde las credenciales y la flechita con su tienda", () => {
    const leadsAccess = read("lib/leads-access.ts");
    expect(leadsAccess).toContain("const platform = orderPlatform(r.platform);");
    expect(leadsAccess).toContain("orderAdminLink({ platform, shopifyOrderId: r.shopify_order_id, shopDomain, wooSiteUrl })");
    expect(leadsAccess).not.toContain("shopifyOrderAdminUrl");
    const actions = flat(read("app/dashboard/leads/actions.ts"));
    expect(actions).toContain("storeWooSiteUrl(admin, ctx.storeId),");
    expect(actions).toContain('admin.from("stores").select("woo_site_url").eq("id", storeId).maybeSingle();');
    expect(actions).toContain("customerHistory.recentOrders = mergePriorOrders<PriorOrder>(shopOrders, customerHistory.recentOrders);");
    // getStoreCreds sigue sin leer nada de WooCommerce (38.11).
    expect(read("lib/ingest.ts")).not.toContain("woo_site_url");
    const leadsDrawer = read("components/leads-drawer.tsx");
    expect(leadsDrawer).toContain("title={`Abrir en ${orderPlatformName(o.platform)}`}");
    expect(leadsDrawer).not.toContain('title="Abrir en Shopify"');
    // El carrito sigue siendo un borrador de Shopify.
    expect(leadsDrawer).toContain("Ver borrador en Shopify");
  });

  it("ningún componente arma a mano un enlace al admin de un pedido", () => {
    for (const path of [
      "components/order-drawer.tsx",
      "components/orders-master.tsx",
      "components/order-master-shared.tsx",
      "components/leads-drawer.tsx",
      "components/leads-next.tsx",
      "components/shipments.tsx",
    ]) {
      const src = read(path);
      expect(src, path).not.toContain("shopifyOrderAdminUrl");
      expect(src, path).not.toContain("admin.shopify.com");
      expect(src, path).not.toContain("wp-admin");
    }
  });

  it("Envíos y Tanders no le piden a Shopify un pedido de WooCommerce", () => {
    const envios = read("app/dashboard/envios/actions.ts");
    expect(envios).toContain('order.shopify_order_id && order.platform !== "woocommerce"');
    const shipments = flat(read("lib/shipments-access.ts"));
    expect(shipments).toContain('if (!shippingAddress && orderRow.shopify_order_id && platform === "shopify") {');
    expect(shipments).toContain('let orderRes = await readOrder("name,shopify_order_id,line_items,raw,platform");');
    expect(shipments).toContain('if (orderRes.error) orderRes = await readOrder("name,shopify_order_id,line_items,raw");');
    expect(read("app/dashboard/pedidos/tanders-actions.ts")).toContain(
      'if ((await orderPlatformOf(admin, orderId)) === "woocommerce") return stored;',
    );
    const ui = read("components/shipments.tsx");
    expect(ui).toContain("Obtenido de ${orderStoreName}");
    expect(ui).toContain("Productos de {orderPlatformName(order.platform)}");
    expect(ui).toContain("el pedido es de WooCommerce: allí no se cambia");
    expect(flat(ui)).toContain('dirección de {orderStoreName} es{" "}');
    expect(ui).not.toContain("dirección de Shopify es");
  });

  it("el séptimo día de confirmación nombra la tienda del pedido", () => {
    const pedidos = flat(read("app/dashboard/pedidos/actions.ts"));
    expect(pedidos).toContain("const platform = await orderPlatformOf(admin, orderId);");
    expect(pedidos).toContain("revisar y anular manualmente en ${orderPlatformName(platform)}.");
    expect(pedidos).not.toContain("anular manualmente en Shopify");
  });

  it("la guía Swayp directa nombra la tienda del pedido (destino, reembolsado); anulado, «en la tienda»", () => {
    const envios = flat(read("app/dashboard/envios/actions.ts"));
    expect(envios).toContain("const platform = await orderPlatformOf(admin, order.id);");
    expect(envios).toContain("orderName: order.name, platform,");
    expect(envios).toContain("reembolso parcial en ${orderPlatformName(platform)}");
    const modal = read("components/direct-fenix-guide-modal.tsx");
    expect(modal).toContain("? orderPlatformName(preview.platform)");
    expect(modal).toContain('"El pedido está anulado en la tienda; no se puede crear la guía."');
    expect(modal).toContain("reembolsado por completo en ${orderPlatformName(preview.platform)}");
    expect(modal).not.toContain('? "Shopify"');
    expect(modal).not.toContain("cancelado en");
  });
});

describe("MOM §38.12", () => {
  const mom = read("docs/mom/master-pedidos-v1.md");
  const start = mom.indexOf("### 38.12 ");
  const s38_12 = flat(mom.slice(start, mom.indexOf("### 38.13 ")));

  it("fija la regla del enlace y dónde se usa", () => {
    expect(s38_12).toContain("#### El enlace al pedido y el nombre de su tienda (24-10-2026)");
    expect(s38_12).toContain("lo decide **solo `orders.platform`**");
    expect(s38_12).toContain("**Sin el sitio guardado** (o con un id que no es `wc-…`) **no hay enlace**");
    expect(s38_12).toContain("**así se sigue guardando**");
    expect(s38_12).toContain("«tienda (WooCommerce)»");
    expect(s38_12).toContain("`test/order-admin-url.test.ts`");
  });

  it("el pendiente de los gid de Shopify dice qué se hizo y qué queda", () => {
    expect(s38_12).toContain("«Ver en Shopify»): **hecho (24-10-2026)**, con `orders.platform`");
    expect(s38_12).not.toContain("Pasarlos a `orders.platform`.");
    // «Anulado en la tienda» (owner, 24-10-2026): el pendiente de los textos ya está hecho.
    expect(s38_12).toContain("**Textos que decían «anulado en Shopify» de cualquier pedido:** **hecho (24-10-2026)**");
    // El export de Swayp ni llama: solo pregunta por ids de dígitos.
    expect(s38_12).toContain("que se salta (el id `wc-…` no es de Shopify");
    expect(s38_12).not.toContain("una llamada que Shopify rechaza y cae a lo guardado");
    expect(read("app/api/export/fenix-programacion/route.ts")).toContain(
      "if (!shopifyOrderId || !/^\\d+$/.test(shopifyOrderId)) continue;",
    );
    for (const where of [
      "`lib/master-door.ts`",
      "`lib/order-companion.ts`",
      "`lib/order-status.ts`",
      "`lib/scan-cancelled.ts`",
      "`lib/notebook-import.ts`",
      "`lib/urpi-report-apply.ts`",
      "`components/urpi-results-board.tsx`",
      "`components/tanders-cobros.tsx`",
      "`lib/swayp-desde-confirmacion.ts`",
      "`lib/swayp-directa.ts`",
    ]) {
      expect(s38_12, where).toContain(where);
    }
    expect(s38_12).toContain("(`eventNoteLabel`, solo esa nota exacta");
  });
});
