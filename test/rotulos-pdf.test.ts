import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { pickShipmentForLabel, selectLabelsForOrders } from "@/lib/labels/pick-shipment";
import {
  buildRotulosPdf,
  fieldHeight,
  linesThatFit,
  sanitizeWinAnsi,
  wrapText,
} from "@/lib/labels/rotulo-pdf";
import { PDFDocument, StandardFonts } from "pdf-lib";

function ship(over: Partial<Parameters<typeof pickShipmentForLabel>[0][number]> & { id: string }) {
  return {
    order_id: "o1",
    courier: "propio",
    guide_code: "G-1",
    output_code: null,
    output_number: null,
    qr_token: "tok",
    custody_state: "empresa",
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("pickShipmentForLabel", () => {
  it("sin salidas devuelve null", () => {
    expect(pickShipmentForLabel([])).toBeNull();
  });

  it("prefiere la salida bajo custodia de la empresa (la que se va a preparar)", () => {
    const picked = pickShipmentForLabel([
      ship({ id: "vieja", custody_state: "courier", created_at: "2026-02-01T00:00:00Z" }),
      ship({ id: "empresa", custody_state: "empresa", created_at: "2026-01-01T00:00:00Z" }),
    ]);
    expect(picked?.id).toBe("empresa");
  });

  it("si ninguna está en la empresa, toma la más reciente", () => {
    const picked = pickShipmentForLabel([
      ship({ id: "a", custody_state: "courier", created_at: "2026-01-01T00:00:00Z" }),
      ship({ id: "b", custody_state: "devuelto", created_at: "2026-03-01T00:00:00Z" }),
    ]);
    expect(picked?.id).toBe("b");
  });

  it("sin fecha, desempata por consecutivo de salida", () => {
    const picked = pickShipmentForLabel([
      ship({ id: "s1", custody_state: "courier", created_at: null, output_number: 1 }),
      ship({ id: "s2", custody_state: "courier", created_at: null, output_number: 2 }),
    ]);
    expect(picked?.id).toBe("s2");
  });
});

describe("selectLabelsForOrders", () => {
  it("respeta el orden en que se seleccionaron los pedidos", () => {
    const result = selectLabelsForOrders(
      ["o2", "o1"],
      [ship({ id: "a", order_id: "o1" }), ship({ id: "b", order_id: "o2" })],
    );
    expect(result.labels.map((l) => l.id)).toEqual(["b", "a"]);
    expect(result.missing).toEqual([]);
  });

  it("reporta los pedidos que todavía no tienen salida", () => {
    const result = selectLabelsForOrders(["o1", "sin-salida"], [ship({ id: "a", order_id: "o1" })]);
    expect(result.labels.map((l) => l.id)).toEqual(["a"]);
    expect(result.missing).toEqual(["sin-salida"]);
  });

  it("una salida por pedido aunque el pedido tenga varias", () => {
    const result = selectLabelsForOrders(
      ["o1"],
      [
        ship({ id: "s1", order_id: "o1", created_at: "2026-01-01T00:00:00Z" }),
        ship({ id: "s2", order_id: "o1", created_at: "2026-02-01T00:00:00Z" }),
      ],
    );
    expect(result.labels).toHaveLength(1);
    expect(result.labels[0]!.id).toBe("s2");
  });
});

describe("sanitizeWinAnsi", () => {
  it("conserva acentos y ñ (están en WinAnsi)", () => {
    expect(sanitizeWinAnsi("Panadería Ñuñoa")).toBe("Panadería Ñuñoa");
  });
  it("reemplaza tipografía que la fuente estándar no tiene", () => {
    expect(sanitizeWinAnsi("Lima — Surco · 2")).toBe("Lima - Surco - 2");
  });
  it("descarta lo que rompería la escritura (emoji) sin perder el resto", () => {
    expect(sanitizeWinAnsi("Casa 🏠 azul")).toBe("Casa azul");
  });
  it("nulos y espacios colapsados", () => {
    expect(sanitizeWinAnsi(null)).toBe("");
    expect(sanitizeWinAnsi("  a   b  ")).toBe("a b");
  });
});

describe("wrapText", () => {
  it("parte por palabras y respeta el máximo de líneas", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = wrapText("uno dos tres cuatro cinco seis siete ocho", font, 10, 60, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toBeTruthy();
  });

  it("corta una palabra más ancha que la caja en vez de desbordar", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = wrapText("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", font, 10, 40, 5);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(40);
  });
});

describe("linesThatFit (tope que protege el QR)", () => {
  it("recorta las líneas cuando queda poco espacio", () => {
    // Espacio para el armazón del campo pero para ninguna línea.
    expect(linesThatFit(100, 100 - fieldHeight(0, 9.5), 9.5, 3)).toBe(0);
    // Espacio justo para una línea.
    expect(linesThatFit(100, 100 - fieldHeight(1, 9.5), 9.5, 3)).toBe(1);
    expect(linesThatFit(100, 100 - fieldHeight(3, 9.5), 9.5, 3)).toBe(3);
  });
  it("nunca devuelve más de lo pedido ni menos de cero", () => {
    expect(linesThatFit(1000, 0, 9.5, 2)).toBe(2);
    expect(linesThatFit(0, 500, 9.5, 3)).toBe(0);
  });
});

describe("buildRotulosPdf", () => {
  it("genera un PDF con una página por rótulo", async () => {
    const qrPng = new Uint8Array(await QRCode.toBuffer("tok-1", { type: "png", width: 120 }));
    const base = {
      courier: "propio",
      orderName: "#KP1",
      customerName: "Ana Pérez",
      customerPhone: "51999",
      items: [{ quantity: 2, name: "Colágeno", variant: null }],
      destination: "Surco / Lima / Lima",
      address: "Av. Siempre Viva 742",
      reference: "Portón azul",
      qrPayload: "tok-1",
      qrPng,
    };
    const pdf = await buildRotulosPdf([
      { ...base, code: "KP1-S01-PROPIO" },
      { ...base, code: "KP2-S01-PROPIO" },
    ]);

    expect(pdf.byteLength).toBeGreaterThan(500);
    // Cabecera PDF real.
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");

    const parsed = await PDFDocument.load(pdf);
    expect(parsed.getPageCount()).toBe(2);
    const [page] = parsed.getPages();
    // 100 × 150 mm en puntos, con tolerancia de redondeo.
    expect(page!.getWidth()).toBeCloseTo(283.46, 1);
    expect(page!.getHeight()).toBeCloseTo(425.2, 1);
  });

  it("con datos larguísimos sigue siendo una sola página por rótulo", async () => {
    // Antes del tope `minY`, una dirección y una lista de productos largas
    // empujaban el texto encima del QR del pie.
    const qrPng = new Uint8Array(await QRCode.toBuffer("y", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP999999999-S05-MOTORIZADO-PROPIO",
        courier: "motorizado propio",
        orderName: "#KP999999999",
        customerName: "María Fernanda de los Ángeles Rodríguez Villavicencio",
        customerPhone: "51999888777",
        items: [
          { quantity: 3, name: "Colágeno Hidrolizado 300g", variant: null },
          { quantity: 2, name: "Magnesio Quelado 120 cápsulas", variant: "Sabor naranja" },
          { quantity: 4, name: "Omega 3 1000mg", variant: null },
          { quantity: 1, name: "Vitamina D3 K2", variant: null },
          { quantity: 2, name: "Multivitamínico", variant: null },
        ],
        destination: "San Juan de Lurigancho / Lima / Lima Metropolitana",
        address:
          "Avenida Próceres de la Independencia 3450, Urbanización Las Flores de Lurigancho, Manzana J Lote 14, tercer piso",
        reference:
          "A media cuadra del grifo Primax, casa de tres pisos con reja verde y portón corredizo, tocar el timbre de arriba",
        qrPayload: "c4d5e6f7-9999-8888-7777-666655554444",
        qrPng,
      },
    ]);
    const parsed = await PDFDocument.load(pdf);
    expect(parsed.getPageCount()).toBe(1);
  });


  it("una cantidad mayor a 1 se imprime más grande que la de 1 unidad", async () => {
    // Empacar una unidad cuando iban dos es un reenvío completo: el número tiene
    // que saltar a la vista, no leerse igual que el resto de la línea.
    const qrPng = new Uint8Array(await QRCode.toBuffer("q", { type: "png", width: 120 }));
    const base = {
      code: "KP1-S01",
      courier: "propio",
      orderName: "#KP1",
      customerName: "Ana",
      customerPhone: "519",
      destination: "Surco",
      address: "Av. 1",
      reference: null,
      qrPayload: "q",
      qrPng,
    };
    const uno = await buildRotulosPdf([
      { ...base, items: [{ quantity: 1, name: "Producto", variant: null }] },
    ]);
    const dos = await buildRotulosPdf([
      { ...base, items: [{ quantity: 2, name: "Producto", variant: null }] },
    ]);
    // El PDF con la cantidad destacada usa un tamaño de fuente extra, así que
    // referencia una fuente más que el de una sola unidad.
    expect(dos.byteLength).not.toBe(uno.byteLength);
    expect((await PDFDocument.load(dos)).getPageCount()).toBe(1);
  });

  it("no falla con datos vacíos ni con texto fuera de WinAnsi", async () => {
    const qrPng = new Uint8Array(await QRCode.toBuffer("x", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "",
        courier: "aliclik",
        orderName: null,
        customerName: "🙂 Cliente",
        customerPhone: null,
        items: [],
        destination: null,
        address: null,
        reference: null,
        qrPayload: "x",
        qrPng,
      },
    ]);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });
});
