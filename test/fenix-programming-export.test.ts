import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildFenixProgrammingRows,
  createFenixProgrammingWorkbook,
  type FenixProgrammingOrder,
  type FenixProgrammingShipment,
} from "@/lib/fenix-programming-export";
import { parseSheet } from "@/lib/xlsx";

const shipment: FenixProgrammingShipment = {
  id: "shipment-1",
  store_id: "store-1",
  guide_code: "#KP12184218072026",
  order_id: "order-1",
  order_name: "#KP121842",
  customer_name: "Fernando Fernando",
  customer_phone: "947541115",
  product: "Producto resumido",
  city: "HUANCAYO",
  district: "EL TAMBO",
  delivery_address: "JR PARRA DEL RIEGO 1498",
  delivery_reference: "Parra y Sucre",
  latitude: -12.064351906356214,
  longitude: -75.28415364447635,
  next_followup_at: "2026-07-18T00:00:00.000Z",
};

const order: FenixProgrammingOrder = {
  id: "order-1",
  name: "#KP121842",
  total_amount: 189,
  line_items: [
    {
      title: "Pulsera Magnética de Cobre",
      quantity: 2,
      sku: "PUL-01",
      product_id: "1",
      variant_id: "11",
      price: 89,
    },
    {
      title: "Estuche de regalo",
      quantity: 1,
      sku: "EST-01",
      product_id: "2",
      variant_id: "22",
      price: 11,
    },
  ],
  raw: {
    note: "Entregar en horario de oficina",
    shipping_address: {
      address1: "Dirección antigua",
      address2: "Referencia antigua",
      city: "Huancayo",
    },
  },
};

describe("Fenix programming export", () => {
  it("builds a complete row from the shipment, Shopify order and latest note", () => {
    const rows = buildFenixProgrammingRows(
      [shipment],
      new Map([[order.id, order]]),
      new Map([[shipment.id, "Cliente confirma sábado de 9 a 10 am"]]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // La columna #PEDIDO lleva el código de guía (pedido + fecha), que es con
      // el que Fenix identifica el despacho.
      orderName: "#KP12184218072026",
      product: "Pulsera Magnética de Cobre | Estuche de regalo",
      quantity: 3,
      amount: 189,
      province: "Huancayo",
      district: "EL TAMBO",
      address: "JR PARRA DEL RIEGO 1498",
      reference: "Parra y Sucre",
      notes: "Entregar en horario de oficina | Cliente confirma sábado de 9 a 10 am",
      gpsUrl: `https://www.google.com/maps?q=${shipment.latitude},${shipment.longitude}`,
    });
  });

  it("recupera la dirección del carrito COD cuando la guía y Shopify no la traen", () => {
    // Caso real: el reporte Aliclik solo informó REFERENCIA, y el pedido de
    // Shopify no trae shippingAddress — pero el formulario COD sí guardó la
    // dirección en el carrito.
    const sinDireccion: FenixProgrammingShipment = {
      ...shipment,
      delivery_address: null,
      delivery_reference: "a media cuadra del bcp.",
    };
    const sinAddressEnShopify: FenixProgrammingOrder = { ...order, raw: { note: "" } };

    const rows = buildFenixProgrammingRows(
      [sinDireccion],
      new Map([[order.id, sinAddressEnShopify]]),
      new Map(),
      new Map([["order-1", { address1: "Jr Túpac Amaru cdra 12", reference: null }]]),
    );

    expect(rows[0]?.address).toBe("Jr Túpac Amaru cdra 12");
    expect(rows[0]?.reference).toBe("a media cuadra del bcp."); // la de la guía manda
  });

  it("la dirección de la guía tiene prioridad sobre el respaldo del carrito", () => {
    const rows = buildFenixProgrammingRows(
      [shipment],
      new Map([[order.id, order]]),
      new Map(),
      new Map([["order-1", { address1: "Dirección del carrito", reference: "Ref carrito" }]]),
    );

    expect(rows[0]?.address).toBe("JR PARRA DEL RIEGO 1498");
    expect(rows[0]?.reference).toBe("Parra y Sucre");
  });

  it("deja la dirección vacía cuando no existe en ninguna fuente", () => {
    const sinNada: FenixProgrammingShipment = {
      ...shipment,
      delivery_address: null,
      delivery_reference: null,
    };
    const rows = buildFenixProgrammingRows(
      [sinNada],
      new Map([[order.id, { ...order, raw: { note: "" } }]]),
    );

    expect(rows[0]?.address).toBe("");
    expect(rows[0]?.reference).toBe("");
  });

  it("exporta una guía directa (sin GPS) con la celda de ubicación vacía", () => {
    const directa: FenixProgrammingShipment = {
      ...shipment,
      guide_code: "#KP12415825072026",
      latitude: null,
      longitude: null,
    };
    const rows = buildFenixProgrammingRows([directa], new Map([[order.id, order]]));

    expect(rows[0]?.orderName).toBe("#KP12415825072026");
    expect(rows[0]?.gpsUrl).toBeNull();
    expect(rows[0]?.address).toBe("JR PARRA DEL RIEGO 1498");
  });

  it("creates an XLSX with the exact Fenix column order and typed values", async () => {
    const rows = buildFenixProgrammingRows([shipment], new Map([[order.id, order]]));
    const buffer = await createFenixProgrammingWorkbook(rows);
    const parsed = await parseSheet(buffer);

    expect(Object.keys(parsed[0] ?? {})).toEqual([
      "FECHA ENVÍO",
      "#PEDIDO",
      "PRODUCTO",
      "CANTIDAD",
      "COBRAR",
      "NOMBRE",
      "TELÉFONO",
      "PROVINCIA",
      "DISTRITO",
      "DIRECCIÓN",
      "REFERENCIA",
      "NOTAS",
      "UBICACIÓN GPS",
    ]);
    expect(parsed[0]).toMatchObject({
      "#PEDIDO": "#KP12184218072026",
      PRODUCTO: "Pulsera Magnética de Cobre | Estuche de regalo",
      CANTIDAD: "3",
      COBRAR: "189",
      TELÉFONO: "947541115",
      "UBICACIÓN GPS": `${shipment.latitude}, ${shipment.longitude}`,
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet("PEDIDOS");
    expect(sheet?.views[0]?.state).toBe("frozen");
    expect(sheet?.autoFilter).toBe("A1:M2");
    expect(sheet?.getCell("A2").value).toBeInstanceOf(Date);
    expect(sheet?.getCell("E2").numFmt).toBe('"S/ "#,##0.00');
    expect(sheet?.getCell("M2").value).toMatchObject({
      hyperlink: `https://www.google.com/maps?q=${shipment.latitude},${shipment.longitude}`,
    });
  });
});
