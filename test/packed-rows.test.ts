// Owner, 27-11-2026: «sigue con la etapa 2». «Por llamar» manda ~6.700 leads por tienda con 47 campos (~11 MB) en
// cada carga. Como objetos, cada lead repite el nombre de sus campos: medido ese día, el 38 % de lo que viaja. Como
// filas, los nombres van una vez. El navegador rearma los mismos objetos: no cambia nada de lo que llega.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPackedRows, packRows, unpackRows } from "@/lib/packed-rows";

const lead = (i: number) => ({
  id: `0000000${i}-0000-4000-8000-000000000000`,
  store_id: "11111111-1111-4111-8111-111111111111",
  phone: `5199900${String(i).padStart(4, "0")}`,
  name: i % 3 ? `Nombre ${i}` : null,
  first_seen_at: "2026-11-20T15:04:05.000Z",
  last_interaction_at: "2026-11-27T10:00:00.000Z",
  kapso_conversation_id: `conv-${i}`,
  handoff_context: i % 5 ? null : { reason: "pide hablar", texto: "dice \"hola\"" },
  category: "open",
  status: "nuevo",
  needs_attention: i % 7 === 0,
  call_queue_ready: true,
  call_attempt_count: i % 3,
  next_followup_at: null,
  contact_opt_out_at: null,
  has_order: false,
  cart_value: i * 12.5,
  entry_product: i % 4 ? { handle: "astaxantina", title: "Astaxantina", source: "customer_text", at: "2026-11-20T15:04:05.000Z", evidence: "quiero la astaxantina", message_id: `m-${i}` } : undefined,
  interest_product: null,
  first_inbound_text: "Hola, quiero información",
  ad_id: i % 2 ? `ad-${i}` : null,
  lista_negra: null,
});

describe("la cola viaja como filas y llega igual", () => {
  it("rearma los mismos objetos, campo por campo, con los nulos, los anidados y los `undefined`", () => {
    const rows = Array.from({ length: 50 }, (_, i) => lead(i));
    const wire = packRows(rows);
    expect(isPackedRows(wire)).toBe(true);
    const back = unpackRows<ReturnType<typeof lead>>(wire);
    expect(back).toEqual(rows);
    for (let i = 0; i < rows.length; i += 1) {
      expect(Object.keys(back[i]!)).toEqual(Object.keys(rows[i]!));
      // Un campo que vale `undefined` sigue presente, como antes.
      expect("entry_product" in back[i]!).toBe(true);
    }
    expect(back[0]!.entry_product).toBeUndefined();
    expect(back[1]!.entry_product?.evidence).toBe("quiero la astaxantina");
  });

  it("pesa bastante menos: los nombres de los campos van una vez", () => {
    const rows = Array.from({ length: 500 }, (_, i) => lead(i));
    const asObjects = JSON.stringify(rows).length;
    const asRows = JSON.stringify(packRows(rows)).length;
    expect(asRows).toBeLessThan(asObjects * 0.75);
  });

  it("si las filas no tienen los mismos campos, la lista va como antes", () => {
    const mixed = [{ id: "a", pending_voucher: { amount: 10 } }, { id: "b" }];
    expect(packRows(mixed)).toEqual(mixed);
    expect(isPackedRows(packRows(mixed))).toBe(false);
    const sameCountOtherKeys = [{ id: "a", x: 1 }, { id: "b", y: 2 }];
    expect(packRows(sameCountOtherKeys)).toEqual(sameCountOtherKeys);
    expect(packRows([])).toEqual([]);
    // Lo que no viene empaquetado se devuelve igual.
    expect(unpackRows(mixed)).toBe(mixed);
  });

  it("la página empaqueta la cola y el tablero la rearma una vez por llegada", () => {
    const page = readFileSync("app/dashboard/leads/page.tsx", "utf8");
    expect(page).toContain("leads={packRows(markedLeads)}");
    const board = readFileSync("components/leads.tsx", "utf8");
    expect(board).toContain("const serverLeads = useMemo(() => unpackRows<LeadRow>(serverLeadsWire), [serverLeadsWire]);");
    expect(board).toContain("leads: LeadRow[] | PackedRows;");
    // Lo que se rearma no depende de nada del servidor.
    expect(readFileSync("lib/packed-rows.ts", "utf8")).not.toMatch(/^import /m);
  });
});
