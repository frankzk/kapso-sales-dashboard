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
      orderName: "#KP121842",
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
      "#PEDIDO": "#KP121842",
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
