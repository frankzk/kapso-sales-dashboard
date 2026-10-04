import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { matchLabel, parseOlvaLabelText, phoneKey } from "@/lib/olva/email-label";
import { pdfText } from "@/lib/olva/email-ingest";
import type { CotejoCandidate } from "@/lib/olva/portal-match";

// El rótulo del correo «Registro exitoso … - Registro Nro 202600715289»
// (02-10-2026), con el nombre y los números cambiados.
const LINES = [
  "OLVA",
  "LIMA",
  "TRACKING 2660913-26",
  "(ubigeo)",
  "080101",
  "ENVIA: GRUPO GF S.A.C.",
  "RUC/DNI: 20556792829",
  "TELEFONO/CELULAR: 965391481",
  "RECIBE: WALTER DAVID ORELLA FERRANDEZ",
  "RUC/DNI: 09912345",
  "TELEFONO/CELULAR: 942500111",
  "DIRECCION: CUSCO - AV PARDO NRO 575 B-PASEO DE LOS HEROES - CUSCO",
  "CUSCO - CUSCO - CUSCO",
  "REFERENCIA: OFICINA TIENDA PARDO-CUSCO - AV PARDO NRO 575",
  "N° REGISTRO: 202600715289 (1/1)",
  "FECHA WEB: 02/10/26",
];

describe("el rótulo del correo", () => {
  it("lee tracking, destinatario, DNI, teléfono, dirección y registro", () => {
    const l = parseOlvaLabelText(LINES.join("\n"));
    expect(l.id).toEqual({ tracking: "2660913", emision: "26" });
    expect(l.senderDoc).toBe("20556792829");
    expect(l.recipientName).toBe("WALTER DAVID ORELLA FERRANDEZ");
    expect(l.recipientDoc).toBe("09912345");
    // El teléfono es el de quien RECIBE, no el de la empresa que envía.
    expect(l.recipientPhone).toBe("942500111");
    expect(l.address).toBe("CUSCO - AV PARDO NRO 575 B-PASEO DE LOS HEROES - CUSCO CUSCO - CUSCO - CUSCO");
    expect(l.reference).toBe("OFICINA TIENDA PARDO-CUSCO - AV PARDO NRO 575");
    expect(l.registro).toBe("202600715289");
    expect(l.ubigeo).toBe("080101");
    expect(l.fecha).toBe("2026-10-02");
  });

  it("aguanta el texto en una sola tira, como a veces sale de un PDF", () => {
    const l = parseOlvaLabelText(LINES.join(" "));
    expect(l.recipientPhone).toBe("942500111");
    expect(l.recipientName).toBe("WALTER DAVID ORELLA FERRANDEZ");
  });

  it("el rótulo que baja el portal escribe «0-26-02649804» y no trae teléfono", () => {
    const l = parseOlvaLabelText("TRACKING: 0-26-02649804 (1/1) RECIBE: CIRO ALEGRIA ALVARON DIRECCIÓN: AV LAS FLORES 322");
    expect(l.id).toEqual({ tracking: "2649804", emision: "26" });
    expect(l.recipientPhone).toBeNull();
  });

  it("sin tracking legible no hay rótulo", () => {
    expect(parseOlvaLabelText("hola").id).toBeNull();
  });

  it("del PDF de verdad sale el mismo texto", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 220]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    LINES.forEach((line, i) => page.drawText(line.replace("°", "o"), { x: 5, y: 205 - i * 12, size: 8, font }));
    const l = parseOlvaLabelText(await pdfText(new Uint8Array(await doc.save())));
    expect(l.id?.tracking).toBe("2660913");
    expect(l.recipientPhone).toBe("942500111");
    expect(l.registro).toBe("202600715289");
  });
});

describe("con qué salida casa el rótulo", () => {
  const label = parseOlvaLabelText(LINES.join("\n"));
  const cand = (o: Partial<CotejoCandidate> & { shipmentId: string }): CotejoCandidate => ({
    storeId: "kenku",
    orderName: null,
    guideCode: null,
    customerName: null,
    address: null,
    district: null,
    createdAt: "2026-10-01T20:00:00Z",
    ...o,
  });

  it("el teléfono es la llave, con el 51 delante o sin él", () => {
    expect(phoneKey("51942500111")).toBe("942500111");
    expect(phoneKey("+51 942 500 111")).toBe("942500111");
    expect(phoneKey("12345")).toBeNull();
    // «Walter Orellana» en Kapta: un nombre en común basta con el mismo teléfono.
    const walter = cand({ shipmentId: "s-w", orderName: "#KP138371", customerName: "Walter Orella", phone: "51942500111" });
    expect(matchLabel(label, [walter])).toMatchObject({ kind: "match", via: "telefono", candidate: { shipmentId: "s-w" } });
  });

  it("también por el DNI apuntado en «DNI y agencia»", () => {
    const c = cand({ shipmentId: "s-d", customerName: "Walter", dni: "09912345", phone: "51900000000" });
    expect(matchLabel(label, [c])).toMatchObject({ kind: "match", via: "dni" });
  });

  it("el mismo teléfono con otro nombre no basta", () => {
    const otra = cand({ shipmentId: "s-x", customerName: "Rosa Quispe", phone: "51942500111" });
    expect(matchLabel(label, [otra])).toEqual({ kind: "none" });
  });

  it("dos pedidos de la misma clienta: no se adivina", () => {
    const a = cand({ shipmentId: "a", customerName: "Walter", phone: "51942500111" });
    const b = cand({ shipmentId: "b", customerName: "Walter", phone: "942500111" });
    expect(matchLabel(label, [a, b])).toMatchObject({ kind: "ambiguous" });
  });

  it("una salida de hace dos meses no es candidata", () => {
    const vieja = cand({ shipmentId: "v", customerName: "Walter", phone: "51942500111", createdAt: "2026-08-01T20:00:00Z" });
    expect(matchLabel(label, [vieja])).toEqual({ kind: "none" });
  });
});

describe("el pedido sugerido tiene que ser de la fecha del rótulo", () => {
  it("la clienta que vuelve a comprar: el rótulo de septiembre no sugiere el pedido de octubre", async () => {
    const { orderFitsLabelDate } = await import("@/lib/olva/email-label");
    // 2386211-26, rótulo del 02-09; #KP138415 es del 02-10.
    expect(orderFitsLabelDate("2026-10-02T15:00:00Z", "2026-09-02")).toBe(false);
    expect(orderFitsLabelDate("2026-08-28T15:00:00Z", "2026-09-02")).toBe(true);
    expect(orderFitsLabelDate("2026-09-02T23:00:00Z", "2026-09-02")).toBe(true);
    expect(orderFitsLabelDate(null, "2026-09-02")).toBe(true);
  });
});
