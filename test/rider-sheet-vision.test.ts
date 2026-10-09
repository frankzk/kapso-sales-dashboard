// La hoja del motorizado sin app leída por visión (MOM §29.7, 08-10-2026).
import { describe, expect, it } from "vitest";
import { parseRiderSheet, readRiderSheet } from "@/lib/rider-sheet-vision";

const answer = JSON.stringify({
  date: "2026-10-05",
  rider_name: null,
  total_amount: "S/.3,575.10",
  total_fee: 256,
  lines: [
    { item: 2, store: "AURELA", customer: "Carlos Castan.", district: "Carabayllo", written: "YAPE PROV", amount: "S/.0.00", fee: "S/ 13.00", order: "#KP138611", notes: null },
    { item: 8, store: "AURELA", customer: "Diana Mancill.", district: "SJL", written: "EFECTIVO", amount: 89, fee: 12, order: null, notes: "No especificado" },
    // Repetida en el borde de dos capturas.
    { item: 8, store: "AURELA", customer: "Diana Mancill.", district: "SJL", written: "EFECTIVO", amount: 89, fee: 12, order: null, notes: "No especificado" },
    { item: 9, written: "EFECTIVO", amount: "ilegible", order: "#KP138900" },
    { item: null, store: null, customer: null, written: null, amount: null, order: null },
  ],
});

describe("parseRiderSheet", () => {
  it("lee montos con S/., no repite filas, no inventa y descarta las vacías", () => {
    const sheet = parseRiderSheet(`Aquí está:\n${answer}`)!;
    expect(sheet.date).toBe("2026-10-05");
    expect(sheet.totals).toEqual({ amount: 3575.1, fee: 256 });
    expect(sheet.lines).toHaveLength(3);
    expect(sheet.lines[0]).toMatchObject({ item: 2, amount: 0, fee: 13, order: "#KP138611", written: "YAPE PROV" });
    expect(sheet.lines[1]).toMatchObject({ item: 8, order: null, notes: "No especificado" });
    // «ilegible» no es S/ 0.00: es null.
    expect(sheet.lines[2]!.amount).toBeNull();
  });

  it("una respuesta sin JSON no es una hoja vacía", () => {
    expect(parseRiderSheet("No puedo leer la imagen.")).toBeNull();
  });
});

describe("readRiderSheet", () => {
  it("manda todas las capturas en una sola llamada y nunca lanza", async () => {
    let body: { content?: unknown; messages: { content: { type: string }[] }[] } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: answer }], stop_reason: "end_turn" }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await readRiderSheet(
      [{ base64: "aaa", contentType: "image/png" }, { base64: "bbb", contentType: "image/jpg" }],
      { apiKey: "k", model: "m", fetchImpl },
    );
    expect(res.ok).toBe(true);
    expect(res.lines).toHaveLength(3);
    expect(body!.messages[0]!.content.filter((c) => c.type === "image")).toHaveLength(2);

    const failing = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    expect(await readRiderSheet([{ base64: "a", contentType: null }], { apiKey: "k", model: "m", fetchImpl: failing }))
      .toMatchObject({ ok: false, failure: "api_error", lines: [] });
    expect(await readRiderSheet([], { apiKey: "k", model: "m" })).toMatchObject({ ok: false, failure: "missing_credentials" });
  });
});

describe("la hoja de 40 filas del 07/10 (08-10-2026)", () => {
  it("filas como arreglos, esfuerzo bajo y, si se corta, las filas completas con aviso", async () => {
    const rows = JSON.stringify({
      date: "2026-10-07", rider_name: null, total_amount: null, total_fee: null,
      rows: [[1, "AURELA", "Marisol mora", "SMP", "EFECTIVO", "S/.129.00", 10, "#AUR177898", null], [2, "KENKU", "Esteban", "La Victoria", "REPRO", 0, 0, "#KP139398", null]],
    });
    expect(parseRiderSheet(rows)!.lines).toMatchObject([
      { item: 1, customer: "Marisol mora", written: "EFECTIVO", amount: 129, order: "#AUR177898" },
      { item: 2, written: "REPRO", order: "#KP139398" },
    ]);
    // Cortada a media fila 3: quedan la 1 y la 2; la 3 no se completa.
    const cutText = rows.replace(/\]\]\}$/, '], [3, "AURELA", "Genaro", "Puente Pie');
    expect(parseRiderSheet(cutText)).toBeNull();
    const salvaged = parseRiderSheet(cutText, true)!;
    expect(salvaged.date).toBe("2026-10-07");
    expect(salvaged.lines.map((l) => l.item)).toEqual([1, 2]);

    const bodies: Record<string, unknown>[] = [];
    const reply = (text: string, stop: string) => new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "" }, { type: "text", text }], stop_reason: stop }), { status: 200 });
    let cutFetch = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return reply(cutText, "max_tokens"); }) as unknown as typeof fetch;
    const res = await readRiderSheet([{ base64: "a", contentType: "image/jpeg" }], { apiKey: "k", model: "claude-sonnet-5", fetchImpl: cutFetch });
    expect(res).toMatchObject({ ok: true, truncated: true });
    expect(res.lines).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ max_tokens: 16000, output_config: { effort: "low" } });

    // Cortada antes de la primera fila: error claro, no una hoja vacía.
    cutFetch = (async () => reply('{"date": "2026-10-07", "rows": [[1, "AUR', "max_tokens")) as unknown as typeof fetch;
    expect(await readRiderSheet([{ base64: "a", contentType: null }], { apiKey: "k", model: "m", fetchImpl: cutFetch }))
      .toMatchObject({ ok: false, failure: "invalid_response" });

    // Un modelo que no acepta el esfuerzo: se repite sin él.
    const sent: Record<string, unknown>[] = [];
    const picky = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      return body.output_config
        ? new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "output_config.effort: not supported" } }), { status: 400 })
        : reply(rows, "end_turn");
    }) as unknown as typeof fetch;
    const retried = await readRiderSheet([{ base64: "a", contentType: null }], { apiKey: "k", model: "old", fetchImpl: picky });
    expect(retried.ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.output_config).toBeUndefined();
  });
});
