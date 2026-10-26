import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { chatbyCustomerLocation, coordinateInText, mapChatbyMessages } from "@/lib/chatby-conversation";
import { WOO_PIN_META_KEY, mapWooOrder, wooConfirmedPin, type WooOrder } from "@/lib/woocommerce";

/**
 * De dónde sale la coordenada de un pedido de WooCommerce (MOM §11, 26-10-2026).
 * WooCommerce no geocodifica, como hacía Shopify: #AUR900024 llegó sin
 * coordenada y Aliclik la exige para cotizar. Dos fuentes:
 *   1. la ubicación que la clienta confirma en el formulario de COD Core
 *      (`_cod_ubicacion`, cuando el plugin la guarde);
 *   2. la que manda por WhatsApp al bot de Chatby, que el panel de Aliclik
 *      propone con un clic.
 */

const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");

describe("la ubicación que manda por WhatsApp (Chatby)", () => {
  it("lee la coordenada de un texto, de un enlace de Maps o de una ubicación compartida", () => {
    expect(coordinateInText("Location: -12.123456001282,-77.035125732422")).toEqual({ lat: -12.123456001282, lng: -77.035125732422 });
    expect(coordinateInText("https://maps.google.com/?q=-12.0431,-77.0282")).toEqual({ lat: -12.0431, lng: -77.0282 });
    expect(coordinateInText("https://www.google.com/maps/@-16.4090,-71.5375,17z")).toEqual({ lat: -16.409, lng: -71.5375 });
    // Fuera del Perú, o sin decimales suficientes, no es una ubicación.
    expect(coordinateInText("-34.6037, -58.3816")).toBeNull();
    expect(coordinateInText("Pedido #KP200123 por S/ 298.00")).toBeNull();
    expect(coordinateInText("https://maps.app.goo.gl/abc123")).toBeNull();
  });

  it("propone la última de la clienta, nunca una que escribió el bot o el equipo", () => {
    const messages = mapChatbyMessages({
      data: [
        { id: 4, type: "agent", msg_type: "text", content: "¿Es aquí? -12.0500, -77.0300", ts: 400 },
        { id: 3, type: "in", msg_type: "location", content: "", payload: { latitude: -12.0461, longitude: -77.0428 }, ts: 300 },
        { id: 2, type: "out", msg_type: "text", content: "Compártenos tu ubicación", ts: 200 },
        { id: 1, type: "in", msg_type: "text", content: "Location: -12.1000,-77.0100", ts: 100 },
      ],
    });
    expect(messages.find((m) => m.id === "3")?.text).toBe("Ubicación: -12.0461, -77.0428");
    expect(chatbyCustomerLocation(messages)).toEqual({ lat: -12.0461, lng: -77.0428, at: new Date(300_000).toISOString() });
    expect(chatbyCustomerLocation(messages.filter((m) => m.kind !== "cliente"))).toBeNull();
  });

  it("el panel de Aliclik la propone con un clic y no la llena sola", () => {
    const panel = read("components/aliclik-guide-panel.tsx");
    expect(panel).toContain("chatbyCustomerLocation(res.messages)");
    expect(panel).toContain("onClick={() => setCoordinate(whatsappPinText)}");
    expect(panel).toContain("if (hasCoordinate) return;");
  });
});

describe("la ubicación que confirma en el formulario (COD Core)", () => {
  const meta = (value: unknown) => [{ key: WOO_PIN_META_KEY, value }];

  it("`_cod_ubicacion` como objeto o como JSON; solo dentro del Perú", () => {
    expect(wooConfirmedPin(meta({ lat: -11.99, lng: -77.07, precision_m: 12, fuente: "gps", confirmado: 1793030500 }))).toEqual({ lat: -11.99, lng: -77.07 });
    expect(wooConfirmedPin(meta('{"lat":"-11.99","lng":"-77.07"}'))).toEqual({ lat: -11.99, lng: -77.07 });
    expect(wooConfirmedPin(meta({ lat: 40.4, lng: -3.7 }))).toBeNull();
    expect(wooConfirmedPin(meta("sin ubicación"))).toBeNull();
    expect(wooConfirmedPin([])).toBeNull();
  });

  it("llega al pedido como lo hacía Shopify: en la latitud y la longitud de la dirección de envío", () => {
    const order = {
      id: 11179,
      number: "AUR900024",
      status: "cod-pending",
      currency: "PEN",
      total: "158.00",
      date_created_gmt: "2026-10-26T16:00:48",
      date_modified_gmt: "2026-10-26T16:02:05",
      billing: { first_name: "Karina", city: "Los Olivos", state: "LMA", country: "PE", address_1: "MZ B LT 22", phone: "+51964668948" },
      shipping: { first_name: "Karina", city: "Los Olivos", state: "LMA", country: "PE", address_1: "MZ B LT 22", phone: "+51964668948" },
      line_items: [],
      meta_data: meta({ lat: -11.9912, lng: -77.0705 }),
    } as unknown as WooOrder;
    const row = mapWooOrder(order, { id: "store", woo_site_key: "aur" });
    const raw = row?.raw as { shipping_address?: { latitude: number | null; longitude: number | null } };
    expect(raw.shipping_address).toMatchObject({ latitude: -11.9912, longitude: -77.0705 });

    const sinPin = mapWooOrder({ ...order, meta_data: [] } as WooOrder, { id: "store", woo_site_key: "aur" });
    expect((sinPin?.raw as typeof raw).shipping_address).toMatchObject({ latitude: null, longitude: null });
  });
});

describe("el MOM y el pedido al equipo de COD Core", () => {
  it("lo cuentan", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("#### La coordenada de un pedido de WooCommerce (26-10-2026)");
    const doc = read("docs/kapta/cod-core-ubicacion.md");
    expect(doc).toContain("`_cod_ubicacion`");
  });
});
