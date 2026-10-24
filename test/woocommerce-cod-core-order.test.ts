// Un pedido REAL del formulario contra entrega de Aurela (plugin COD Core),
// del ensayo de producción del 24-10-2026, con la clienta cambiada por datos
// de prueba y sin los meta de rastreo. Ata el mapeador a lo que de verdad manda
// la tienda: «Por confirmar» (cod-pending), el pack 3 + 2 con su regalo a S/ 0,
// las ofertas adicionales, el canal y la dirección (MOM §38.2-38.7).

import { describe, expect, it } from "vitest";
import { mapWooOrder, type WooOrder } from "@/lib/woocommerce";
import { salesChannel } from "@/lib/sales-channel";
import { shopifyDepartamentoElegido, shopifyShippingAddress } from "@/lib/shopify-address";
import { orderTotals } from "@/lib/order-totals";
import { limaRegionKind } from "@/lib/order-coverage";

const AURELA = { id: "4c6522f9-c775-4be3-95b0-160a3c16d27a", woo_site_key: "aur" };

const PEDIDO = {
  "id": 11075,
  "parent_id": 0,
  "status": "cod-pending",
  "currency": "PEN",
  "version": "11.2.1",
  "prices_include_tax": false,
  "date_created": "2026-10-24T12:04:16",
  "date_modified": "2026-10-24T12:05:27",
  "discount_total": "0.00",
  "discount_tax": "0.00",
  "shipping_total": "0.00",
  "shipping_tax": "0.00",
  "cart_tax": "0.00",
  "total": "484.80",
  "total_tax": "0.00",
  "customer_id": 0,
  "billing": {
    "first_name": "Clienta",
    "last_name": "De Prueba",
    "company": "",
    "address_1": "Jr. Ejemplo 123",
    "address_2": "frente al parque",
    "city": "Barranco",
    "state": "LMA",
    "postcode": "",
    "country": "PE",
    "email": "",
    "phone": "+51987654321"
  },
  "shipping": {
    "first_name": "Clienta",
    "last_name": "De Prueba",
    "company": "",
    "address_1": "Jr. Ejemplo 123",
    "address_2": "frente al parque",
    "city": "Barranco",
    "state": "LMA",
    "postcode": "",
    "country": "PE",
    "phone": "+51987654321"
  },
  "payment_method": "cod",
  "payment_method_title": "Pago contra entrega",
  "transaction_id": "",
  "created_via": "cod-core-form",
  "customer_note": "",
  "date_completed": null,
  "date_paid": null,
  "number": "AUR900003",
  "meta_data": [
    {
      "id": 31,
      "key": "_order_number",
      "value": "AUR900003"
    },
    {
      "id": 32,
      "key": "kapta_channel",
      "value": "web_formulario"
    },
    {
      "id": 36,
      "key": "_cod_territorio",
      "value": {
        "codigo": "150104",
        "region": "Lima",
        "provincia": "Lima",
        "distrito": "Barranco"
      }
    },
    {
      "id": 41,
      "key": "_wc_order_attribution_utm_source",
      "value": "(direct)"
    },
    {
      "id": 40,
      "key": "_wc_order_attribution_source_type",
      "value": "typein"
    }
  ],
  "line_items": [
    {
      "id": 6,
      "name": "Bividi Camiseta de Alta Compresión",
      "product_id": 10405,
      "variation_id": 10415,
      "quantity": 5,
      "subtotal": "337.00",
      "subtotal_tax": "0.00",
      "total": "337.00",
      "total_tax": "0.00",
      "meta_data": [
        {
          "id": 43,
          "key": "talla",
          "value": "M",
          "display_key": "Talla",
          "display_value": "M"
        },
        {
          "id": 44,
          "key": "Pack",
          "value": "3 + 2 gratis",
          "display_key": "Pack",
          "display_value": "3 + 2 gratis"
        },
        {
          "id": 45,
          "key": "_cod_pack",
          "value": "0",
          "display_key": "_cod_pack",
          "display_value": "0"
        }
      ],
      "sku": "36710849",
      "price": 67.4,
      "parent_name": "Bividi Camiseta de Alta Compresión"
    },
    {
      "id": 7,
      "name": "Tobillera X Pro",
      "product_id": 1386,
      "variation_id": 0,
      "quantity": 2,
      "subtotal": "0.00",
      "subtotal_tax": "0.00",
      "total": "0.00",
      "total_tax": "0.00",
      "meta_data": [
        {
          "id": 55,
          "key": "Regalo",
          "value": "Pack 3 + 2 gratis",
          "display_key": "Regalo",
          "display_value": "Pack 3 + 2 gratis"
        }
      ],
      "sku": "25652067",
      "price": 0,
      "parent_name": null
    },
    {
      "id": 9,
      "name": "Rodillera X Pro",
      "product_id": 1920,
      "variation_id": 0,
      "quantity": 1,
      "subtotal": "40.00",
      "subtotal_tax": "0.00",
      "total": "40.00",
      "total_tax": "0.00",
      "meta_data": [
        {
          "id": 72,
          "key": "_cod_upsell",
          "value": "1",
          "display_key": "Oferta adicional",
          "display_value": "Sí"
        }
      ],
      "sku": "81852859",
      "price": 40,
      "parent_name": null
    },
    {
      "id": 10,
      "name": "Guantes de Compresión Suave para Artritis, Artrosis, Tendinitis y Túnel Carpiano",
      "product_id": 3811,
      "variation_id": 3820,
      "quantity": 1,
      "subtotal": "45.50",
      "subtotal_tax": "0.00",
      "total": "45.50",
      "total_tax": "0.00",
      "meta_data": [
        {
          "id": 82,
          "key": "talla",
          "value": "Small (13-17 cm)",
          "display_key": "Talla",
          "display_value": "Small (13-17 cm)"
        },
        {
          "id": 83,
          "key": "_cod_upsell",
          "value": "1",
          "display_key": "Oferta adicional",
          "display_value": "Sí, después de la compra (1 clic)"
        }
      ],
      "sku": "818532661",
      "price": 45.5,
      "parent_name": "Guantes de Compresión Suave para Artritis, Artrosis, Tendinitis y Túnel Carpiano"
    },
    {
      "id": 11,
      "name": "Pack de 10 Pares de Calcetines Tribal Desodorantes Antibacterianos Transpirables",
      "product_id": 9916,
      "variation_id": 0,
      "quantity": 1,
      "subtotal": "62.30",
      "subtotal_tax": "0.00",
      "total": "62.30",
      "total_tax": "0.00",
      "meta_data": [],
      "sku": "96258884",
      "price": 62.3,
      "parent_name": null
    }
  ],
  "tax_lines": [],
  "shipping_lines": [
    {
      "id": 8,
      "method_title": "Envío gratis",
      "method_id": "free_shipping",
      "total": "0.00",
      "total_tax": "0.00",
      "meta_data": []
    }
  ],
  "fee_lines": [],
  "coupon_lines": [],
  "refunds": [],
  "date_created_gmt": "2026-10-24T17:04:16",
  "date_modified_gmt": "2026-10-24T17:05:27",
  "date_completed_gmt": null,
  "date_paid_gmt": null
} as unknown as WooOrder;

describe("pedido real de COD Core (Aurela, 24-10-2026)", () => {
  const row = mapWooOrder(PEDIDO, AURELA)!;

  it("entra vivo: id con la clave del sitio, número con prefijo, contra entrega sin cobrar", () => {
    expect(row).toMatchObject({
      shopify_order_id: "wc-aur-11075",
      name: "#AUR900003",
      platform: "woocommerce",
      financial_status: "pending",
      payment_gateway: "cod",
      cancelled_at: null,
      total_amount: 484.8,
      customer_phone: "51987654321",
      created_at: "2026-10-24T17:04:16Z",
      updated_at: "2026-10-24T17:05:27Z",
    });
  });

  it("canal «Web · formulario» por kapta_channel", () => {
    expect(row.tags).toEqual(["easysell_cod_form"]);
    expect(salesChannel(row.tags, row.kapso_conversation_id)).toBe("web_formulario");
  });

  it("líneas: el pack 3 + 2 a 67.40 la unidad, el regalo a S/ 0 y las ofertas, cada una con su SKU", () => {
    expect(row.line_items.map((l) => [l.sku, l.quantity, l.price, l.variant_title])).toEqual([
      ["36710849", 5, 67.4, "M / 3 + 2 gratis"],
      ["25652067", 2, 0, null],
      ["81852859", 1, 40, null],
      ["818532661", 1, 45.5, "Small (13-17 cm)"],
      ["96258884", 1, 62.3, null],
    ]);
    // La suma de las líneas es el total: el desglose del cajón cuadra.
    const suma = row.line_items.reduce((s, l) => s + (l.price ?? 0) * l.quantity, 0);
    expect(Math.round(suma * 100) / 100).toBe(484.8);
    expect(orderTotals(row.raw, row.total_amount)).toMatchObject({ discounts: 0, shipping: 0, total: 484.8 });
  });

  it("dirección: distrito en city, referencia en address2, Lima Metropolitana (LMA)", () => {
    const addr = shopifyShippingAddress(row.raw)!;
    expect(addr).toMatchObject({ address1: "Jr. Ejemplo 123", address2: "frente al parque", city: "Barranco", province: "Lima (provincia)" });
    expect(shopifyDepartamentoElegido(row.raw)).toBe("PE-LMA");
    expect(limaRegionKind(addr.province)).toBe("metropolitana");
  });

  it("los meta ocultos del plugin no ensucian los atributos; la atribución sí entra", () => {
    const names = ((row.raw as { note_attributes: { name: string }[] }).note_attributes ?? []).map((a) => a.name);
    expect(names).toContain("utm_source");
    expect(names.some((n) => n.startsWith("_cod"))).toBe(false);
  });
});
