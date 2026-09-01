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
import { CODE39_PATTERNS } from "@/lib/labels/barcode39";
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

/**
 * Rectángulos rellenos del PDF. pdf-lib los escribe como un `cm` de traslación
 * seguido del recorrido del rectángulo y un `f`. La banda del monto se dibuja
 * solo con borde (`S`), así que no entra: los únicos rellenos son las barras.
 */
function filledRects(pdf: Uint8Array): { x: number; y: number; w: number; h: number }[] {
  const raw = Buffer.from(pdf).toString("latin1");
  const out: { x: number; y: number; w: number; h: number }[] = [];
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
      continue;
    }
    const rect =
      /1 0 0 1 ([-\d.]+) ([-\d.]+) cm\s+1 0 0 1 0 0 cm\s+1 0 0 1 0 0 cm\s+0 0 m\s+0 ([-\d.]+) l\s+([-\d.]+) [-\d.]+ l\s+[-\d.]+ 0 l\s+h\s+f/g;
    let hit: RegExpExecArray | null;
    while ((hit = rect.exec(content))) {
      out.push({ x: Number(hit[1]), y: Number(hit[2]), w: Number(hit[4]), h: Number(hit[3]) });
    }
  }
  return out;
}

/**
 * Lee las barras como lo haría el pistolete: mide anchos, los clasifica en
 * ancho/estrecho y los traduce con la tabla del estándar.
 *
 * Comprobar que "se dibujaron N rectángulos" no dice nada sobre si el escáner
 * va a devolver el número de pedido. Esto sí.
 */
function decodeCode39(bars: readonly { x: number; w: number }[]): string {
  const sorted = [...bars].sort((a, b) => a.x - b.x);
  if (!sorted.length) return "";

  // Barras y espacios, en el orden en que los recorre el lector.
  const elements: number[] = [];
  sorted.forEach((bar, index) => {
    elements.push(bar.w);
    const next = sorted[index + 1];
    if (next) elements.push(next.x - (bar.x + bar.w));
  });

  const narrow = Math.min(...elements);
  const bits = elements.map((width) => (width > narrow * 1.5 ? "1" : "0"));
  const reverse = new Map(Object.entries(CODE39_PATTERNS).map(([char, p]) => [p, char]));

  let text = "";
  for (let i = 0; i < bits.length; i += 10) {
    // 9 elementos por carácter y, entre uno y otro, un espacio separador.
    const char = reverse.get(bits.slice(i, i + 9).join(""));
    if (!char) return `<ilegible en ${i}>`;
    text += char;
  }
  return text;
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

  it("el código de barras decodifica al PEDIDO de Shopify, no a la salida", async () => {
    // Se pistolea contra el Excel del almacén, cuya clave es el número de
    // pedido. Un `-S01` dentro del código obligaría a limpiarlo a mano fila por
    // fila, y a inventar una regla el día que un pedido tenga dos salidas.
    const qrPng = new Uint8Array(await QRCode.toBuffer("b", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP126875-S01-ALICLIK",
        storeName: "Kenku Peru",
        orderName: "#KP126875",
        customerName: "Ana",
        customerPhone: "519",
        items: [{ quantity: 1, name: "Producto", variant: null }],
        collectAmount: 89,
        currency: "PEN",
        destination: "San Borja / Lima",
        address: "Enrique Pastor 115",
        reference: null,
        note: null,
        qrPayload: "b",
        qrPng,
      },
    ]);

    const bars = filledRects(pdf).map((rect) => ({ x: rect.x, w: rect.w }));
    expect(bars.length, "las barras tienen que estar impresas").toBeGreaterThan(0);
    // El lector no entrega los delimitadores `*`; el dato es lo de en medio.
    expect(decodeCode39(bars)).toBe("*KP126875*");
  });

  it("las barras van bajo la tienda y el código, y por encima del monto", async () => {
    const qrPng = new Uint8Array(await QRCode.toBuffer("h", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "KP126875-S01",
        storeName: "Kenku Peru",
        orderName: "#KP126875",
        customerName: "Ana",
        customerPhone: "519",
        items: [{ quantity: 1, name: "Producto", variant: null }],
        collectAmount: 89,
        currency: "PEN",
        destination: "San Borja / Lima",
        address: "Enrique Pastor 115",
        reference: null,
        note: null,
        qrPayload: "h",
        qrPng,
      },
    ]);

    const drawn = textWithSizes(pdf);
    const store = drawn.find((d) => d.text === "KENKU PERU")!;
    const code = drawn.find((d) => d.text === "KP126875-S01")!;
    const amount = drawn.find((d) => d.text === "S/ 89")!;
    const bars = filledRects(pdf);
    const barsTop = Math.max(...bars.map((rect) => rect.y + rect.h));
    const barsBottom = Math.min(...bars.map((rect) => rect.y));

    expect(store.y).toBeGreaterThan(code.y);
    expect(code.y).toBeGreaterThan(barsTop);
    expect(barsBottom).toBeGreaterThan(amount.y);
    // Zona muda: las barras no pueden pegarse al borde del papel.
    const left = Math.min(...bars.map((rect) => rect.x));
    const right = Math.max(...bars.map((rect) => rect.x + rect.w));
    expect(left).toBeGreaterThan(8);
    expect(right).toBeLessThan(283.46 - 8);
  });

  it("el código de barras no le quita campos a un rótulo normal", async () => {
    // El código de barras se paga con espacio vertical. En un rótulo real
    // —un producto, una dirección de una línea— no puede costar ni la
    // referencia ni el distrito: son lo que hace que el paquete llegue.
    const qrPng = new Uint8Array(await QRCode.toBuffer("r", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "AUR175061-S01",
        storeName: "Aurela",
        orderName: "#AUR175061",
        customerName: "Gudelia Salcedo Cárdenas",
        customerPhone: "51998031594",
        items: [{ quantity: 1, name: "Set de Pelador de Verduras", variant: null }],
        collectAmount: 89,
        currency: "PEN",
        destination: "San Borja / Lima",
        address: "Enrique Pastor 115",
        reference: "Espalda hotel Rosa Toro",
        note: "llamar antes // recibe conserje en efectivo",
        qrPayload: "r",
        qrPng,
      },
    ]);

    const drawn = textWithSizes(pdf).map((d) => d.text);
    for (const esperado of [
      "Enrique Pastor 115",
      "San Borja / Lima",
      "Espalda hotel Rosa Toro",
      "Set de Pelador de Verduras",
      "S/ 89",
    ]) {
      expect(drawn, esperado).toContain(esperado);
    }
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("una salida sin pedido reconocible se imprime sin barras, no con barras falsas", async () => {
    // El código es una guía del courier: pistolearla dentro de la columna del
    // pedido contamina el Excel en silencio.
    const qrPng = new Uint8Array(await QRCode.toBuffer("s", { type: "png", width: 120 }));
    const pdf = await buildRotulosPdf([
      {
        code: "1234567890",
        storeName: "Kenku Peru",
        orderName: null,
        customerName: "Ana",
        customerPhone: "519",
        items: [],
        collectAmount: null,
        currency: null,
        destination: null,
        address: null,
        reference: null,
        note: null,
        qrPayload: "s",
        qrPng,
      },
    ]);
    expect(filledRects(pdf)).toHaveLength(0);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
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

/**
 * NINGÚN PRODUCTO SE ESCONDE.
 *
 * EL CASO REAL. El rótulo KP131647-S01 —cinco productos, La Molina, S/ 695—
 * salió de la impresora con tres productos y una línea que decía «+ 2 productos
 * mas (ver el pedido)». Quien arma la caja no puede armarla con eso, y quien la
 * recibe no puede cotejarla: el rótulo existe para esas dos cosas.
 *
 * Faltaban 0,2 mm. La escalera de sacrificios del planificador ponía los
 * productos en cuarto lugar —después de la referencia y del distrito, antes que
 * la dirección— y cedía líneas de la lista hasta que el bloque entraba.
 *
 * Ahora la lista no se negocia: se aprieta el CUERPO de la tabla (8,5 → 7,5 →
 * 6,5 pt) antes que esconder nada, y el armazón de cada campo bajó de 4,2 a
 * 3,4 mm para pagar la línea que faltaba.
 */
describe("la lista de productos entra entera", () => {
  const qr = async () =>
    new Uint8Array(await QRCode.toBuffer("42d92526-3838-4b85-bb46-da1c3a5452b1", {
      type: "png",
      width: 120,
    }));

  /** El pedido de la foto, tal como está en producción. */
  const KP131647 = {
    code: "KP131647-S01",
    storeName: "Kenku Peru",
    orderName: "#KP131647",
    customerName: "Zoila Kenku",
    customerPhone: "51994104518",
    items: [
      { quantity: 1, name: "Acondicionador para Cabello Grueso y Voluminoso con Romero Keratina Ortiga y Biotina (220 gr.) - IdeasLabCo", variant: null },
      { quantity: 1, name: "NAD + Resveratrol - Cápsulas de Reparación Celular Antienvejecimiento y Energía Extra (120 Cápsulas) - SuperHuman", variant: null },
      { quantity: 1, name: "Multi Collagen Peptides - Colágeno Hidrolizado en Polvo Tipo I, II, III, V y X con Glucosamina, Biotina, Condroitina y Cartílago de Tiburón (375 g)", variant: null },
      { quantity: 1, name: "Shampoo de Cebolla REBROTA - Fortalecimiento Capilar y Control de Caída con Romero y Canela", variant: null },
      { quantity: 1, name: "Hair+ | Crecimiento y Densidad con Biotina y Hierro Hemo (120 Caps.)", variant: null },
    ],
    collectAmount: 695,
    currency: "PEN",
    destination: "La Molina / Lima",
    address: "Jr. De los Conquistadores 363 Dpto. 302. Urb. Las Lomas, Por el Ovalo Los Condores",
    reference: null,
    note: "Pedido WhatsApp/Kapso - Contraentrega (efectivo o Yape) Producto(s): 1 x Acondicionador para Cabello Grueso y Voluminoso con Romero Keratina Ortiga y Biotina (220 gr.)",
    qrPayload: "42d92526-3838-4b85-bb46-da1c3a5452b1",
  };

  it("los cinco productos de #KP131647 se imprimen, ninguno se esconde", async () => {
    const pdf = await buildRotulosPdf([{ ...KP131647, qrPng: await qr() }]);
    const drawn = textWithSizes(pdf).map((t) => t.text);

    // Cada producto por una palabra suya que no aparece en ningún otro sitio del
    // rótulo. Comprobar solo que no hay aviso dejaría pasar una lista vacía.
    for (const palabra of ["Acondicionador", "Resveratrol", "Collagen", "Cebolla", "Hair"]) {
      expect(drawn.some((t) => t.includes(palabra)), `falta «${palabra}»`).toBe(true);
    }
  });

  it("y se imprimen al cuerpo completo: cinco productos no obligan a apretar", async () => {
    // Es lo que compra haber bajado el armazón de cada campo de 4,2 a 3,4 mm.
    // Sin esos 3,2 mm la lista entra igual, pero a 7,5 pt: se lee peor sin
    // necesidad. Apretar es el segundo recurso, no el primero.
    const pdf = await buildRotulosPdf([{ ...KP131647, qrPng: await qr() }]);
    const linea = textWithSizes(pdf).find((t) => t.text.includes("Acondicionador"));
    expect(linea?.size).toBe(8.5);
  });

  it("y no queda ni rastro del «+ N productos mas»", async () => {
    const pdf = await buildRotulosPdf([{ ...KP131647, qrPng: await qr() }]);
    const drawn = textWithSizes(pdf).map((t) => t.text).join("\n");
    expect(drawn).not.toMatch(/productos? mas/);
  });

  it("sigue siendo UNA página de 100 × 150: el rollo no da para más", async () => {
    // La página no puede crecer para ganar sitio. Ya se intentó en el rótulo de
    // agencia: con una etiqueta vertical del courier salía de 156 mm y dejaba de
    // caber en el papel. Lo que cede es el aire, no el tamaño del papel.
    const parsed = await PDFDocument.load(await buildRotulosPdf([{ ...KP131647, qrPng: await qr() }]));
    expect(parsed.getPageCount()).toBe(1);
    expect(parsed.getPages()[0]!.getHeight()).toBeCloseTo(425.2, 1);
  });

  it("con referencia larga y dirección larga tampoco esconde ninguno", async () => {
    // El 88,7 % de los pedidos trae referencia. Es el caso común, no el raro.
    const pdf = await buildRotulosPdf([
      {
        ...KP131647,
        reference: "A media cuadra del grifo Primax, casa de tres pisos con reja verde, tocar el timbre de arriba",
        qrPng: await qr(),
      },
    ]);
    const drawn = textWithSizes(pdf).map((t) => t.text);
    for (const palabra of ["Acondicionador", "Resveratrol", "Collagen", "Cebolla", "Hair"]) {
      expect(drawn.some((t) => t.includes(palabra)), `falta «${palabra}»`).toBe(true);
    }
    expect(drawn.join("\n")).not.toMatch(/productos? mas/);
  });

  it("con siete productos —el máximo visto en 180 días— tampoco", async () => {
    const pdf = await buildRotulosPdf([
      {
        ...KP131647,
        items: [
          ...KP131647.items,
          { quantity: 2, name: "Omega 3 1000mg Ultra Concentrado", variant: null },
          { quantity: 1, name: "Vitamina D3 con K2 MK-7", variant: null },
        ],
        reference: "Portón azul, al costado de la bodega",
        qrPng: await qr(),
      },
    ]);
    const drawn = textWithSizes(pdf).map((t) => t.text);
    for (const palabra of ["Acondicionador", "Resveratrol", "Collagen", "Cebolla", "Hair", "Omega", "Vitamina"]) {
      expect(drawn.some((t) => t.includes(palabra)), `falta «${palabra}»`).toBe(true);
    }
    expect(drawn.join("\n")).not.toMatch(/productos? mas/);
    // Y la calle entera. Sin el escalón de cuerpo, quien pagaba la lista era la
    // dirección: se quedaba en «Jr. De los Conquistadores 363 Dpto. 302. Urb...»
    // y el motorizado perdía la urbanización y la referencia del óvalo.
    expect(
      drawn.some((t) => t.includes("Las Lomas")),
      "la dirección perdió su segunda línea",
    ).toBe(true);
  });

  it("la dirección no paga la lista mientras quede otra cosa que ceder", async () => {
    // El orden de sacrificio importa: la dirección es lo que decide si el
    // paquete llega. Con cinco productos y una referencia, quien cede es la
    // referencia y el cuerpo de la tabla, no la calle.
    const pdf = await buildRotulosPdf([
      { ...KP131647, reference: "Casa con reja verde", qrPng: await qr() },
    ]);
    const drawn = textWithSizes(pdf).map((t) => t.text).join(" ");
    expect(drawn).toContain("Conquistadores");
    expect(drawn).toContain("Las Lomas");
  });

  it("un pedido de un solo producto no se aprieta sin motivo", async () => {
    // La compactación es un recurso, no el estado normal: el 91 % de los
    // pedidos trae una sola línea y ese rótulo tiene que seguir leyéndose
    // cómodo, al cuerpo de siempre.
    const pdf = await buildRotulosPdf([
      { ...KP131647, items: [KP131647.items[0]!], reference: "Portón azul", qrPng: await qr() },
    ]);
    const linea = textWithSizes(pdf).find((t) => t.text.includes("Acondicionador"));
    expect(linea?.size).toBe(8.5);
  });
});
