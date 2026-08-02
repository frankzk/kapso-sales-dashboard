import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { pickShipmentForLabel, selectLabelsForOrders } from "@/lib/labels/pick-shipment";
import {
  buildRotulosPdf,
  fieldHeight,
  linesThatFit,
  productsReservedHeight,
  sanitizeWinAnsi,
  wrapText,
} from "@/lib/labels/rotulo-pdf";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { inflateSync } from "node:zlib";

/**
 * Cada texto dibujado en el PDF con su tamaño de fuente.
 *
 * Lee los content streams de verdad: comprobar que el PDF "no explota" no dice
 * nada sobre si el monto se ve. pdf-lib escribe el texto como `<hex> Tj` después
 * de un `/Fuente TAMAÑO Tf`.
 */
function textWithSizes(pdf: Uint8Array): { text: string; size: number }[] {
  const raw = Buffer.from(pdf).toString("latin1");
  const out: { text: string; size: number }[] = [];
  const streams = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streams.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    let content: string;
    try {
      content = inflateSync(Buffer.from(raw.slice(start, end), "latin1")).toString("latin1");
    } catch {
      continue; // imágenes y otros streams no comprimidos con deflate
    }
    let size = 0;
    for (const line of content.split("\n")) {
      const tf = line.match(/\/\S+\s+([\d.]+)\s+Tf/);
      if (tf) size = Number(tf[1]);
      const tj = line.match(/<([0-9A-Fa-f]+)>\s*Tj/);
      if (tj) out.push({ text: Buffer.from(tj[1]!, "hex").toString("latin1"), size });
    }
  }
  return out;
}

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

describe("productsReservedHeight (los productos ganan a la referencia)", () => {
  it("sin productos no reserva nada", () => {
    expect(productsReservedHeight([])).toBe(0);
  });

  it("una variante cuesta una línea extra", () => {
    const sin = productsReservedHeight([{ quantity: 1, name: "A", variant: null }]);
    const con = productsReservedHeight([{ quantity: 1, name: "A", variant: "M" }]);
    expect(con).toBeGreaterThan(sin);
  });

  it("un pedido de quince líneas no se come el rótulo entero", () => {
    const muchos = Array.from({ length: 15 }, (_, i) => ({
      quantity: 1,
      name: `P${i}`,
      variant: null,
    }));
    const cuatro = muchos.slice(0, 4);
    expect(productsReservedHeight(muchos)).toBe(productsReservedHeight(cuatro));
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
      collectAmount: 298,
      currency: "PEN",
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
        collectAmount: 1299.5,
        currency: "PEN",
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
      collectAmount: 149,
      currency: "PEN",
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

  it("el monto a cobrar es el texto MÁS GRANDE del rótulo", async () => {
    // Es el dato que más caro sale equivocar y se lee de pie, en la puerta. Si
    // algún día otro campo lo supera en tamaño, este test lo dice.
    const qrPng = new Uint8Array(await QRCode.toBuffer("m", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP1-S01",
        courier: "propio",
        orderName: "#KP1",
        customerName: "Ana",
        customerPhone: "519",
        items: [{ quantity: 1, name: "Producto", variant: null }],
        collectAmount: 298,
        currency: "PEN",
        destination: "Surco",
        address: "Av. 1",
        reference: null,
        qrPayload: "m",
        qrPng,
      },
    ]);

    const drawn = textWithSizes(pdf);
    const amount = drawn.find((d) => d.text === "S/ 298");
    expect(amount, "el monto tiene que estar impreso").toBeTruthy();
    const biggest = Math.max(...drawn.map((d) => d.size));
    expect(amount!.size).toBe(biggest);
  });

  it("sin total no imprime cero: manda a mirar el pedido", async () => {
    // Un "S/ 0" grande hace que el motorizado entregue sin cobrar.
    const qrPng = new Uint8Array(await QRCode.toBuffer("n", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP2-S01",
        courier: "propio",
        orderName: "#KP2",
        customerName: "Ana",
        customerPhone: "519",
        items: [],
        collectAmount: null,
        currency: null,
        destination: "Surco",
        address: "Av. 1",
        reference: null,
        qrPayload: "n",
        qrPng,
      },
    ]);
    const drawn = textWithSizes(pdf).map((d) => d.text);
    expect(drawn).toContain("VER PEDIDO");
    expect(drawn.some((t) => /^S\/\s*0$/.test(t))).toBe(false);
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
        collectAmount: null,
        currency: null,
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
