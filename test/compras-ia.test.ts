// «Leer con IA» en Compras (MOM §45.10): las reglas puras y la llamada a la
// API con `fetch` simulado (nunca la API de verdad).
//   - Qué documentos se leen y el tope de tamaño que aguanta la API.
//   - La normalización de la respuesta: JSON roto, campos que faltan, cantidad
//     entera ≥ 1, precio = el de la unidad o total ÷ cantidad, cargos.
//   - Sin «Montos de compras», ni precios ni cargos.
//   - La coincidencia con los SKU conocidos (referencia §6.9).
//   - La conversión a USD con «1 USD = X <moneda>» (4 decimales y 2).
//   - La llamada: PDF como `document`, imagen como `image`, herramienta con
//     esquema, nunca lanza.

import { describe, expect, it, vi } from "vitest";
import {
  AI_MAX_IMAGE_BYTES,
  AI_MAX_PDF_BYTES,
  aiConfirmToInputs,
  aiReadEventNote,
  buildCatalog,
  canReadWithAi,
  chargeToUsd,
  checkAiFile,
  matchCatalog,
  normalizeProductName,
  normalizeQty,
  parseAiProposal,
  stripAiMoney,
  unitPriceOf,
  unitToUsd,
} from "@/lib/compras-ia";
import { apiErrorMessage, fileBlock, readPurchaseDocument } from "@/lib/compras-ia-vision";
import { cleanCost, cleanItem } from "@/lib/compras";

describe("qué se lee", () => {
  it("factura comercial, proforma y packing list, en PDF o imagen", () => {
    for (const kind of ["invoice", "proforma", "packing"]) {
      expect(canReadWithAi({ kind, mime: "application/pdf" }), kind).toBe(true);
      expect(canReadWithAi({ kind, mime: "image/png" }), kind).toBe(true);
    }
    expect(canReadWithAi({ kind: "invoice", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe(false);
    for (const kind of ["payment", "tracking", "customs", "photo", "other"]) expect(canReadWithAi({ kind, mime: "application/pdf" }), kind).toBe(false);
  });

  it("corta antes de gastar la llamada lo que la API no recibe", () => {
    expect(checkAiFile({ kind: "invoice", mime: "application/pdf", size: AI_MAX_PDF_BYTES })).toEqual({ ok: true });
    expect(checkAiFile({ kind: "invoice", mime: "application/pdf", size: AI_MAX_PDF_BYTES + 1 })).toEqual({ error: expect.stringMatching(/20 MB/) });
    expect(checkAiFile({ kind: "packing", mime: "image/jpeg", size: AI_MAX_IMAGE_BYTES + 1 })).toEqual({ error: expect.stringMatching(/5 MB/) });
    expect(checkAiFile({ kind: "invoice", mime: "image/jpeg", size: 0 })).toEqual({ error: "El archivo está vacío." });
    expect("error" in checkAiFile({ kind: "payment", mime: "application/pdf", size: 10 })).toBe(true);
    expect(checkAiFile({ kind: "invoice", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 10 })).toEqual({
      error: expect.stringMatching(/no XLSX/),
    });
  });
});

describe("la respuesta del modelo", () => {
  it("JSON roto o sin objeto: null", () => {
    expect(parseAiProposal("no pude leer el documento")).toBeNull();
    expect(parseAiProposal('{"lines": [ {"name": "x" ')).toBeNull();
    expect(parseAiProposal(null)).toBeNull();
    expect(parseAiProposal([1, 2])).toBeNull();
  });

  it("acepta el JSON dentro de texto o de cercas, y la entrada de la herramienta", () => {
    const text = 'Aquí está:\n```json\n{"currency":"cny","lines":[{"name":"Audífonos","quantity":10,"unit_price":12.5}],"charges":[]}\n```';
    expect(parseAiProposal(text)).toMatchObject({ currency: "CNY", lines: [{ name: "Audífonos", qty: 10, unitPrice: 12.5 }] });
    expect(parseAiProposal({ currency: "USD", lines: [], charges: [] })).toEqual({ currency: "USD", lines: [], charges: [], igv: null, dropped: 0 });
  });

  it("campos que faltan: moneda null, SKU null, precio null; sin listas, vacías", () => {
    expect(parseAiProposal({})).toEqual({ currency: null, lines: [], charges: [], igv: null, dropped: 0 });
    const p = parseAiProposal({ lines: [{ name: "Cargador", quantity: "3" }] })!;
    expect(p.currency).toBeNull();
    expect(p.lines).toEqual([{ name: "Cargador", sku: null, qty: 3, unitPrice: null, unitWeightKg: null }]);
    expect(parseAiProposal({ currency: "dólares" })!.currency).toBeNull();
  });

  it("cantidad entera ≥ 1: redondea, una fracción sube a 1; sin cantidad, cero o negativa se descarta", () => {
    expect(normalizeQty(2.4)).toBe(2);
    expect(normalizeQty(2.5)).toBe(3);
    expect(normalizeQty(0.3)).toBe(1);
    expect(normalizeQty("1,500")).toBe(1500);
    expect(normalizeQty(0)).toBeNull();
    expect(normalizeQty(-4)).toBeNull();
    expect(normalizeQty(null)).toBeNull();
    expect(normalizeQty("muchas")).toBeNull();
    const p = parseAiProposal({
      lines: [
        { name: "A", quantity: 0 },
        { name: "", quantity: 5 },
        { name: "B", quantity: null },
        { name: "C", quantity: 0.2 },
        "basura",
      ],
    })!;
    expect(p.lines.map((l) => [l.name, l.qty])).toEqual([["C", 1]]);
    expect(p.dropped).toBe(4);
  });

  it("precio = el de la unidad o, si no, total ÷ cantidad", () => {
    expect(unitPriceOf(2.5, 999, 10)).toBe(2.5);
    expect(unitPriceOf(null, 100, 8)).toBe(12.5);
    expect(unitPriceOf("US$ 3.10", null, 1)).toBe(3.1);
    expect(unitPriceOf(null, null, 4)).toBeNull();
    expect(unitPriceOf(-1, null, 4)).toBeNull();
    const p = parseAiProposal({ lines: [{ name: "Funda", quantity: "200", unit_price: null, line_total: "1,234.00" }] })!;
    expect(p.lines[0]!.unitPrice).toBeCloseTo(6.17, 10);
  });

  it("el peso por unidad: el de la unidad o el de la línea ÷ cantidad", () => {
    const p = parseAiProposal({
      lines: [
        { name: "A", quantity: 4, unit_weight_kg: 0.25 },
        { name: "B", quantity: 3, line_weight_kg: 1 },
      ],
    })!;
    expect(p.lines.map((l) => l.unitWeightKg)).toEqual([0.25, 0.3333]);
  });

  it("los cargos: tipo envío / importación / adicional, nombre por defecto, monto > 0", () => {
    const p = parseAiProposal({
      charges: [
        { kind: "envio", label: "Flete DHL", amount: 120 },
        { kind: "shipping", amount: "35.5" },
        { kind: "importacion", label: "Aranceles", amount: 40 },
        { kind: "raro", label: "Comisión bancaria", amount: 8 },
        { kind: "envio", label: "Gratis", amount: 0 },
        { kind: "envio", label: "Sin monto" },
      ],
    })!;
    expect(p.charges).toEqual([
      { kind: "envio", label: "Flete DHL", amount: 120, currency: null },
      { kind: "envio", label: "Envío", amount: 35.5, currency: null },
      { kind: "importacion", label: "Aranceles", amount: 40, currency: null },
      { kind: "adicional", label: "Comisión bancaria", amount: 8, currency: null },
    ]);
    expect(p.dropped).toBe(2);
  });

  it("sin «Montos de compras»: ni precios, ni cargos, ni moneda, ni IGV", () => {
    const p = parseAiProposal({ currency: "CNY", igv: 76.91, lines: [{ name: "A", sku: "X1", quantity: 5, unit_price: 9 }], charges: [{ kind: "envio", amount: 50 }] })!;
    expect(p.igv).toEqual({ amount: 76.91, currency: "CNY" });
    const stripped = stripAiMoney(p);
    expect(stripped).toEqual({ currency: null, lines: [{ name: "A", sku: "X1", qty: 5, unitPrice: null, unitWeightKg: null }], charges: [], igv: null, dropped: 0 });
    expect(JSON.stringify(stripped)).not.toMatch(/9|50|CNY|76/);
  });
});

describe("la coincidencia con los SKU conocidos (§6.9 de la referencia)", () => {
  const STORE_A = "55555555-5555-4555-8555-555555555555";
  const STORE_B = "55555555-5555-4555-8555-55555555555b";
  const catalog = buildCatalog([
    { sku: " KP-AUD-01 ", name: "Audífonos Bluetooth Pro", storeId: STORE_A },
    { sku: "kp-aud-01", name: null, storeId: STORE_A },
    { sku: "CARG-20W", name: "Cargador rápido 20W", storeId: STORE_A },
    { sku: "CARG-20W", name: "Cargador rápido 20W", storeId: STORE_B },
    { sku: "FUNDA-1", name: "Funda", storeId: null },
    { sku: "LAMP-1", name: "Lámpara LED", storeId: null },
    { sku: "LAMP-2", name: "lampara led", storeId: null },
    { sku: "", name: "Sin SKU", storeId: null },
  ]);

  it("un producto por SKU, sin mayúsculas ni espacios; la tienda solo si siempre fue la misma", () => {
    expect(catalog.map((p) => p.sku)).toEqual(["KP-AUD-01", "CARG-20W", "FUNDA-1", "LAMP-1", "LAMP-2"]);
    expect(catalog.find((p) => p.sku === "KP-AUD-01")).toEqual({ sku: "KP-AUD-01", name: "Audífonos Bluetooth Pro", storeId: STORE_A });
    expect(catalog.find((p) => p.sku === "CARG-20W")!.storeId).toBeNull();
  });

  it("SKU exacto (sin mayúsculas, sin espacios al borde) y único", () => {
    expect(matchCatalog({ sku: "  kp-aud-01", name: "Wireless earbuds" }, catalog)).toMatchObject({ sku: "KP-AUD-01", storeId: STORE_A });
  });

  it("con SKU que no está, prueba el nombre; si no, nuevo", () => {
    expect(matchCatalog({ sku: "ZZZ", name: "Cargador  rápido 20w!" }, catalog)).toMatchObject({ sku: "CARG-20W" });
    expect(matchCatalog({ sku: "ZZZ", name: "Otra cosa distinta" }, catalog)).toBeNull();
  });

  it("nombre normalizado de al menos 6 caracteres y que coincida con uno solo", () => {
    expect(normalizeProductName("  Lámpara-LED  ")).toBe("lampara led");
    // «Funda»: 5 caracteres, no alcanza.
    expect(matchCatalog({ sku: null, name: "FUNDA" }, catalog)).toBeNull();
    // Dos productos con el mismo nombre normalizado: ninguno.
    expect(matchCatalog({ sku: null, name: "Lampara LED" }, catalog)).toBeNull();
    expect(matchCatalog({ sku: null, name: "Audifonos bluetooth PRO" }, catalog)).toMatchObject({ sku: "KP-AUD-01" });
  });

  it("varios con el mismo SKU: ninguno, y no se intenta por nombre", () => {
    const dup = [
      { sku: "X-1", name: "Audífonos Bluetooth Pro", storeId: null },
      { sku: "x-1", name: "Otro", storeId: null },
    ];
    expect(matchCatalog({ sku: "X-1", name: "Audífonos Bluetooth Pro" }, dup)).toBeNull();
  });
});

describe("la conversión con «1 USD = X <moneda>» (§6.5 de la referencia)", () => {
  it("precio por unidad ÷ X a 4 decimales; cargos ÷ X a 2", () => {
    expect(unitToUsd(10, 7.1234)).toBe(1.4038);
    expect(unitToUsd(1, 3)).toBe(0.3333);
    expect(chargeToUsd(100, 7.1234)).toBe(14.04);
    expect(chargeToUsd(10, 3)).toBe(3.33);
  });

  it("sin «Montos de compras»: solo nombre, SKU, tienda, cantidad y peso", () => {
    const r = aiConfirmToInputs(
      { currency: "CNY", fx: "", lines: [{ name: "A", sku: "X", qty: "5", unitWeightKg: "0.2", unitPrice: "70" }], charges: [{ kind: "envio", amount: "50" }] },
      false,
    );
    expect(r).toEqual({ items: [{ name: "A", sku: "X", storeId: "", qty: "5", unitWeightKg: "0.2" }], costs: [], currency: null, fx: null });
    const clean = cleanItem((r as { items: Parameters<typeof cleanItem>[0][] }).items[0]!, false);
    expect(clean).toEqual({ value: { store_id: null, sku: "X", name: "A", qty: 5, unit_weight_kg: 0.2 } });
  });

  it("no USD con precio o cargos: pide el tipo de cambio", () => {
    const lines = [{ name: "A", qty: "5", unitPrice: "70" }];
    expect(aiConfirmToInputs({ currency: "CNY", lines }, true)).toEqual({ error: "Escribe el tipo de cambio: 1 USD = X CNY." });
    expect(aiConfirmToInputs({ currency: "CNY", fx: "0", lines }, true)).toHaveProperty("error");
    // Sin precios ni cargos (un packing list) no hace falta.
    expect(aiConfirmToInputs({ currency: "CNY", lines: [{ name: "A", qty: "5", unitPrice: "" }] }, true)).toMatchObject({ fx: null });
  });

  it("convierte y pasa por cleanItem / cleanCost", () => {
    const r = aiConfirmToInputs(
      {
        currency: "cny",
        fx: "7,1234",
        lines: [{ name: "A", qty: "10", unitPrice: "10" }, { name: "B", qty: "2", unitPrice: "" }],
        charges: [{ kind: "envio", label: "Flete", amount: "100", allocation: "weight" }],
      },
      true,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.currency).toBe("CNY");
    expect(r.fx).toBe(7.1234);
    expect(r.items.map((i) => i.unitCostUsd)).toEqual(["1.4038", ""]);
    expect(cleanItem(r.items[0]!, true)).toMatchObject({ value: { unit_cost_usd: 1.4038, sale_price_pen: null } });
    expect(cleanItem(r.items[1]!, true)).toMatchObject({ value: { unit_cost_usd: 0 } });
    // Un cargo sin moneda es de la del documento (CNY): pasa a USD ÷ X, a 2 decimales.
    expect(r.costs).toEqual([{ kind: "envio", label: "Flete", amount: "14.04", currency: "USD", allocation: "weight" }]);
    expect(cleanCost(r.costs[0]!, [])).toEqual({
      value: { kind: "envio", label: "Flete", currency: "USD", amount_usd: 14.04, amount_pen: null, includes_igv: false, gross_amount: null, allocation: "weight", item_id: null },
    });
  });

  it("en USD no pide tipo de cambio y redondea a 4 decimales", () => {
    const r = aiConfirmToInputs({ currency: "", lines: [{ name: "A", qty: "3", unitPrice: "1.234567" }] }, true);
    expect(r).toMatchObject({ currency: "USD", fx: 1, items: [{ unitCostUsd: "1.2346" }] });
  });

  it("rechaza lo que no vale: nada marcado, moneda rara, cargo «a un producto», monto 0", () => {
    expect(aiConfirmToInputs({ lines: [], charges: [] }, true)).toEqual({ error: "Marca al menos un producto o un cargo." });
    expect(aiConfirmToInputs({ currency: "dólar", lines: [{ name: "A", qty: "1" }] }, true)).toHaveProperty("error");
    expect(aiConfirmToInputs({ charges: [{ kind: "envio", amount: "5", allocation: "item" }] }, true)).toHaveProperty("error");
    expect(aiConfirmToInputs({ charges: [{ kind: "envio", amount: "0" }] }, true)).toHaveProperty("error");
    expect(aiConfirmToInputs({ charges: [{ kind: "flete", amount: "5" }] }, true)).toHaveProperty("error");
    expect(aiConfirmToInputs({ lines: [{ name: "A", qty: "1", unitPrice: "abc" }] }, true)).toEqual({ error: "Producto 1: precio inválido." });
  });

  it("el hecho del historial", () => {
    expect(aiReadEventNote(3, 2, "factura.pdf")).toBe("Leído con IA: 3 productos, 2 cargos agregados de factura.pdf.");
    expect(aiReadEventNote(1, 0, null)).toBe("Leído con IA: 1 producto, 0 cargos agregados de el documento.");
  });
});

describe("la llamada a la API (fetch simulado)", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const opts = (fetchImpl: typeof fetch) => ({ apiKey: "sk-ant-test", model: "claude-sonnet-5", apiBase: "https://api.example.test", fetchImpl });

  it("PDF como `document` y la imagen como `image`", () => {
    expect(fileBlock("QUJD", "application/pdf")).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } });
    expect(fileBlock("QUJD", "image/webp")).toEqual({ type: "image", source: { type: "base64", media_type: "image/webp", data: "QUJD" } });
    expect(fileBlock("QUJD", "text/html")).toBeNull();
  });

  it("manda la herramienta con su esquema y lee su entrada", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      ok({
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Leyendo…" },
          {
            type: "tool_use",
            name: "registrar_documento",
            input: { currency: "USD", lines: [{ name: "Audífonos", sku: "A1", quantity: 100, unit_price: 2, line_total: 200 }], charges: [{ kind: "envio", label: "Flete", amount: 30 }] },
          },
        ],
      }),
    );
    const res = await readPurchaseDocument("QUJD", "application/pdf", opts(fetchImpl as unknown as typeof fetch));
    expect(res).toMatchObject({ ok: true, proposal: { currency: "USD", lines: [{ name: "Audífonos", sku: "A1", qty: 100, unitPrice: 2 }], charges: [{ kind: "envio", amount: 30 }] } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.test/v1/messages");
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.tools[0].name).toBe("registrar_documento");
    expect(body.tools[0].input_schema.required).toEqual(["currency", "lines", "charges", "igv", "igv_currency"]);
    // Cada cargo trae su moneda; los montos, sin IGV.
    expect(body.tools[0].input_schema.properties.charges.items.required).toEqual(["kind", "label", "amount", "currency"]);
    expect(body.system).toMatch(/SIN IGV/);
    expect(body.system).toMatch(/Cada cargo con SU moneda/);
    expect(body.messages[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("si contesta en texto, lee el JSON del texto", async () => {
    const fetchImpl = (async () => ok({ content: [{ type: "text", text: '{"currency":"EUR","lines":[{"name":"X","quantity":2}],"charges":[]}' }] })) as unknown as typeof fetch;
    expect(await readPurchaseDocument("QUJD", "image/png", opts(fetchImpl))).toMatchObject({ ok: true, proposal: { currency: "EUR" } });
  });

  it("nunca lanza: sin clave, HTTP, rechazo, truncado, respuesta ilegible, timeout, red", async () => {
    const never = vi.fn();
    expect(await readPurchaseDocument("QUJD", "application/pdf", { apiKey: "", model: "m", fetchImpl: never as unknown as typeof fetch })).toMatchObject({
      ok: false,
      failure: "missing_credentials",
    });
    expect(await readPurchaseDocument("QUJD", "text/plain", opts(never as unknown as typeof fetch))).toMatchObject({ ok: false, failure: "unsupported" });
    expect(never).not.toHaveBeenCalled();

    const status = (n: number) => (async () => new Response("{}", { status: n })) as unknown as typeof fetch;
    expect(await readPurchaseDocument("QUJD", "application/pdf", opts(status(401)))).toMatchObject({ ok: false, error: apiErrorMessage(401) });
    expect(await readPurchaseDocument("QUJD", "application/pdf", opts(status(400)))).toMatchObject({ ok: false, error: expect.stringMatching(/100 páginas/) });
    expect(await readPurchaseDocument("QUJD", "application/pdf", opts(status(529)))).toMatchObject({ ok: false, error: expect.stringMatching(/ocupada/) });

    const body = (b: unknown) => (async () => ok(b)) as unknown as typeof fetch;
    expect(await readPurchaseDocument("QUJD", "application/pdf", opts(body({ stop_reason: "refusal", content: [] })))).toMatchObject({ ok: false, failure: "refusal" });
    expect(await readPurchaseDocument("QUJD", "application/pdf", opts(body({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"lines": [' }] })))).toMatchObject({
      ok: false,
      failure: "truncated",
    });
    expect(await readPurchaseDocument("QUJD", "application/pdf", opts(body({ content: [{ type: "text", text: "no sé" }] })))).toMatchObject({ ok: false, failure: "invalid_response" });

    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch;
    expect(await readPurchaseDocument("QUJD", "application/pdf", { ...opts(hang), timeoutMs: 10 })).toMatchObject({ ok: false, failure: "timeout" });

    const boom = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await readPurchaseDocument("QUJD", "application/pdf", opts(boom))).toMatchObject({ ok: false, failure: "api_error" });
  });
});
