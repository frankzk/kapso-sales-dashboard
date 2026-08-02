import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { pickShipmentForLabel, selectLabelsForOrders } from "@/lib/labels/pick-shipment";
import {
  buildRotulosPdf,
  fieldHeight,
  fitProducts,
  groupLines,
  linesThatFit,
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
function textWithSizes(pdf: Uint8Array): { text: string; size: number; y: number }[] {
  const raw = Buffer.from(pdf).toString("latin1");
  const out: { text: string; size: number; y: number }[] = [];
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
    let y = 0;
    for (const line of content.split("\n")) {
      const tf = line.match(/\/\S+\s+([\d.]+)\s+Tf/);
      if (tf) size = Number(tf[1]);
      const tm = line.match(/1 0 0 1 [\d.-]+ ([\d.-]+) Tm/);
      if (tm) y = Number(tm[1]);
      const tj = line.match(/<([0-9A-Fa-f]+)>\s*Tj/);
      if (tj) out.push({ text: Buffer.from(tj[1]!, "hex").toString("latin1"), size, y });
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

describe("groupLines", () => {
  it("un producto sin variantes ocupa una sola línea", () => {
    expect(groupLines({ name: "A", variants: [{ quantity: 2, variant: null }] })).toBe(1);
  });

  it("con variantes: el título una vez, y una línea por talla", () => {
    // Tres tallas del mismo título costaban SEIS líneas (título repetido tres
    // veces + tres variantes). Agrupadas cuestan cuatro.
    expect(
      groupLines({
        name: "SoftFlex",
        variants: [
          { quantity: 1, variant: "37-38" },
          { quantity: 2, variant: "39-40" },
          { quantity: 1, variant: "41-42" },
        ],
      }),
    ).toBe(4);
  });
});

describe("fitProducts", () => {
  const grupo = (name: string, n: number) => ({
    name,
    variants: Array.from({ length: n }, (_, i) => ({ quantity: 1, variant: `v${i}` })),
  });

  it("con sitio de sobra dibuja todo y no oculta nada", () => {
    const { drawn, hidden } = fitProducts([grupo("A", 1), grupo("B", 1)], 20);
    expect(drawn).toHaveLength(2);
    expect(hidden).toBe(0);
  });

  it("corta por producto entero, no a media lista de tallas", () => {
    // Media lista de tallas es peor que ninguna: parece completa.
    const { drawn, hidden } = fitProducts([grupo("A", 3), grupo("B", 3)], 5);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.name).toBe("A");
    expect(hidden).toBe(1);
  });

  it("reserva la línea del aviso antes de decidir", () => {
    // Tres productos de una línea en dos líneas disponibles: entra uno, y la
    // segunda línea se gasta en avisar de los dos que faltan. Si no se
    // reservara, entrarían dos y el aviso se quedaría sin sitio — el rótulo
    // callaría que hay más producto del que muestra.
    const simple = (name: string) => ({ name, variants: [{ quantity: 1, variant: null }] });
    const { drawn, hidden } = fitProducts([simple("A"), simple("B"), simple("C")], 2);
    expect(drawn).toHaveLength(1);
    expect(hidden).toBe(2);
  });

  it("si entran todos no gasta línea en un aviso que sobra", () => {
    const simple = (name: string) => ({ name, variants: [{ quantity: 1, variant: null }] });
    const { drawn, hidden } = fitProducts([simple("A"), simple("B")], 2);
    expect(drawn).toHaveLength(2);
    expect(hidden).toBe(0);
  });

  it("sin sitio para nada no dibuja ni inventa", () => {
    expect(fitProducts([grupo("A", 3)], 0)).toEqual({ drawn: [], hidden: 1 });
  });
});

describe("buildRotulosPdf", () => {
  it("genera un PDF con una página por rótulo", async () => {
    const qrPng = new Uint8Array(await QRCode.toBuffer("tok-1", { type: "png", width: 120 }));
    const base = {
      storeName: "Kenku Peru",
      orderName: "#KP1",
      customerName: "Ana Pérez",
      customerPhone: "51999",
      items: [{ quantity: 2, name: "Colágeno", variant: null }],
      collectAmount: 298,
      currency: "PEN",
      destination: "Surco / Lima / Lima",
      address: "Av. Siempre Viva 742",
      reference: "Portón azul",
      note: null,
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
        storeName: "Kenku Peru",
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
        note: "Enviar con Tanders antes de la 1 y 30. Llamar al llegar, el timbre no suena.",
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
      storeName: "Kenku Peru",
      orderName: "#KP1",
      customerName: "Ana",
      customerPhone: "519",
      collectAmount: 149,
      currency: "PEN",
      destination: "Surco",
      address: "Av. 1",
      reference: null,
      note: null,
      qrPayload: "q",
      qrPng,
    };
    const uno = await buildRotulosPdf([
      { ...base, items: [{ quantity: 1, name: "Producto", variant: null }] },
    ]);
    const dos = await buildRotulosPdf([
      { ...base, items: [{ quantity: 2, name: "Producto", variant: null }] },
    ]);

    const sizeOf = (pdf: Uint8Array, qty: string) =>
      textWithSizes(pdf).find((d) => d.text === qty)?.size;
    const unaUnidad = sizeOf(uno, "1");
    const dosUnidades = sizeOf(dos, "2");
    expect(unaUnidad, "la cantidad tiene que estar impresa").toBeTruthy();
    expect(dosUnidades).toBeGreaterThan(unaUnidad!);
    expect((await PDFDocument.load(dos)).getPageCount()).toBe(1);
  });

  it("la cabecera es la tienda sobre el código, sin marca interna ni courier", async () => {
    // "KAPTA - SALIDA FISICA" no le dice nada a quien recibe la caja, y el
    // courier ya viaja dentro del código cuando está decidido. Un "POR DEFINIR"
    // grande era ruido: quien lo decide es la Mesa de despacho.
    const qrPng = new Uint8Array(await QRCode.toBuffer("t", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP1-S01",
        storeName: "Kenku Peru",
        orderName: "#KP1",
        customerName: "Ana",
        customerPhone: "519",
        items: [{ quantity: 1, name: "Producto", variant: null }],
        collectAmount: 99,
        currency: "PEN",
        destination: "Surco",
        address: "Av. 1",
        reference: null,
        note: null,
        qrPayload: "t",
        qrPng,
      },
    ]);

    const drawn = textWithSizes(pdf);
    const store = drawn.find((d) => d.text === "KENKU PERU");
    const code = drawn.find((d) => d.text === "KP1-S01");
    expect(store, "la tienda tiene que estar impresa").toBeTruthy();
    expect(code).toBeTruthy();
    // La tienda va ENCIMA del código: mayor `y` es más arriba en un PDF.
    expect(store!.y).toBeGreaterThan(code!.y);
    const texts = drawn.map((d) => d.text);
    expect(texts.some((t) => t.includes("KAPTA"))).toBe(false);
    expect(texts.some((t) => t.includes("POR DEFINIR"))).toBe(false);
  });

  it("sin tienda conocida no rompe la cabecera", async () => {
    const qrPng = new Uint8Array(await QRCode.toBuffer("u", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP1-S01",
        storeName: null,
        orderName: "#KP1",
        customerName: "Ana",
        customerPhone: "519",
        items: [],
        collectAmount: null,
        currency: null,
        destination: null,
        address: null,
        reference: null,
        note: null,
        qrPayload: "u",
        qrPng,
      },
    ]);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("la nota del pedido se imprime junto al QR, y la leyenda queda al pie", async () => {
    // La nota es donde el asesor escribe las instrucciones reales («enviar con
    // Tanders», «antes de la 1 y 30»). Quien arma la caja no las tenía en
    // ninguna parte del papel: había que abrir Shopify.
    const qrPng = new Uint8Array(await QRCode.toBuffer("n1", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP1-S01",
        storeName: "Kenku Peru",
        orderName: "#KP1",
        customerName: "Ana",
        customerPhone: "519",
        items: [{ quantity: 1, name: "Producto", variant: null }],
        collectAmount: 99,
        currency: "PEN",
        destination: "Surco / Lima",
        address: "Av. 1",
        reference: null,
        note: "enviar tander antes de las 1 y 30",
        qrPayload: "n1",
        qrPng,
      },
    ]);

    const drawn = textWithSizes(pdf);
    const note = drawn.find((d) => d.text.includes("enviar tander"));
    const legend = drawn.find((d) => d.text.startsWith("Escanear en cada cotejo"));
    expect(note, "la nota tiene que estar impresa").toBeTruthy();
    expect(legend).toBeTruthy();
    // La leyenda es lo más chico del rótulo y va debajo de la nota.
    expect(legend!.size).toBeLessThan(note!.size);
    expect(legend!.y).toBeLessThan(note!.y);
  });

  it("sin nota lo dice, en vez de dejar el hueco mudo", async () => {
    const qrPng = new Uint8Array(await QRCode.toBuffer("n2", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP1-S01",
        storeName: "Kenku Peru",
        orderName: "#KP1",
        customerName: "Ana",
        customerPhone: "519",
        items: [],
        collectAmount: null,
        currency: null,
        destination: null,
        address: null,
        reference: null,
        note: null,
        qrPayload: "n2",
        qrPng,
      },
    ]);
    expect(textWithSizes(pdf).map((d) => d.text)).toContain("Sin notas");
  });

  it("el monto a cobrar es el texto MÁS GRANDE del rótulo", async () => {
    // Es el dato que más caro sale equivocar y se lee de pie, en la puerta. Si
    // algún día otro campo lo supera en tamaño, este test lo dice.
    const qrPng = new Uint8Array(await QRCode.toBuffer("m", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP1-S01",
        storeName: "Kenku Peru",
        orderName: "#KP1",
        customerName: "Ana",
        customerPhone: "519",
        items: [{ quantity: 1, name: "Producto", variant: null }],
        collectAmount: 298,
        currency: "PEN",
        destination: "Surco",
        address: "Av. 1",
        reference: null,
        note: null,
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
        storeName: "Kenku Peru",
        orderName: "#KP2",
        customerName: "Ana",
        customerPhone: "519",
        items: [],
        collectAmount: null,
        currency: null,
        destination: "Surco",
        address: "Av. 1",
        reference: null,
        note: null,
        qrPayload: "n",
        qrPng,
      },
    ]);
    const drawn = textWithSizes(pdf).map((d) => d.text);
    expect(drawn).toContain("VER PEDIDO");
    expect(drawn.some((t) => /^S\/\s*0$/.test(t))).toBe(false);
  });

  it("con poco contenido reparte el aire en vez de dejar un hueco sobre el QR", async () => {
    // El defecto que se vio impreso: los campos apretados arriba y un vacío
    // grande justo encima del QR. Se mide la distancia entre bloques y la que
    // queda hasta el pie: ningún salto puede ser desproporcionado.
    const qrPng = new Uint8Array(await QRCode.toBuffer("g", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP1-S01",
        storeName: "Kenku Peru",
        orderName: "#KP1",
        customerName: "Ana",
        customerPhone: "519",
        items: [{ quantity: 1, name: "Uno", variant: null }],
        collectAmount: 99,
        currency: "PEN",
        destination: "Surco",
        address: "Av. 1",
        reference: "Reja azul",
        note: null,
        qrPayload: "g",
        qrPng,
      },
    ]);

    const drawn = textWithSizes(pdf);
    // El pie empieza en el bloque de notas, a la derecha del QR.
    const footer = drawn.find((d) => d.text === "NOTAS DEL PEDIDO");
    const producto = drawn.find((d) => d.text === "Uno");
    expect(footer && producto).toBeTruthy();

    const gap = producto!.y - footer!.y;
    // 150 mm de alto son 425 pt. Antes del reparto, este hueco pasaba de 60 pt.
    expect(gap).toBeLessThan(60);
  });

  it("no falla con datos vacíos ni con texto fuera de WinAnsi", async () => {
    const qrPng = new Uint8Array(await QRCode.toBuffer("x", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "",
        storeName: "Kenku Peru",
        orderName: null,
        customerName: "🙂 Cliente",
        customerPhone: null,
        items: [],
        collectAmount: null,
        currency: null,
        destination: null,
        address: null,
        reference: null,
        note: null,
        qrPayload: "x",
        qrPng,
      },
    ]);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });
});
