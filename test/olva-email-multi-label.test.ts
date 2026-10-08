// Un PDF de Olva con varios rótulos (0232, 06-10-2026): el registro
// 202600718786 traía cuatro envíos y solo se cotejaba el primero. Datos
// inventados con la forma exacta del texto que sale del PDF real.

import { describe, expect, it } from "vitest";
import { parseOlvaLabelText, splitOlvaLabelTexts } from "@/lib/olva/email-label";
import { ingestOlvaEmailLabels } from "@/lib/olva/email-ingest";

const rotulo = (k: number, n: number, recibe: string, tel: string, tracking: string) =>
  [
    "ENVIA: GRUPO GF S.A.C.",
    "RUC/DNI: 20556792829",
    "TELEFONO/CELULAR: 965391481",
    `RECIBE: ${recibe}`,
    `RUC/DNI: 4${k}000000`,
    `TELEFONO/CELULAR: ${tel}`,
    "DIRECCION: JR LOS PINOS 123",
    "ILO - ILO - MOQUEGUA",
    "REFERENCIA: cercado",
    `N° REGISTRO: 202600000001 (${k}/${n})`,
    "FECHA WEB: 05/10/26",
    "OLVA",
    `LIMA TRACKING ${tracking}-26 (ubigeo)`,
    "180301",
  ].join("\n");

const CUATRO = [
  rotulo(1, 4, "ANA PRIMERA", "911111111", "2000001"),
  rotulo(2, 4, "BETO SEGUNDO", "922222222", "2000002"),
  rotulo(3, 4, "CARLA TERCERA", "933333333", "2000003"),
  rotulo(4, 4, "DIEGO CUARTO", "944444444", "2000004"),
].join("\n");

describe("un PDF con varios rótulos", () => {
  it("se parte en un rótulo por envío, cada uno con su tracking, destinatario y posición", () => {
    const parts = splitOlvaLabelTexts(CUATRO);
    expect(parts).toHaveLength(4);
    const labels = parts.map(parseOlvaLabelText);
    expect(labels.map((l) => l.id?.tracking)).toEqual(["2000001", "2000002", "2000003", "2000004"]);
    expect(labels.map((l) => l.recipientName)).toEqual(["ANA PRIMERA", "BETO SEGUNDO", "CARLA TERCERA", "DIEGO CUARTO"]);
    expect(labels.map((l) => l.recipientPhone)).toEqual(["911111111", "922222222", "933333333", "944444444"]);
    expect(labels.map((l) => [l.part, l.parts])).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
    expect(labels.every((l) => l.senderDoc === "20556792829" && l.fecha === "2026-10-05")).toBe(true);
  });

  it("un PDF de un solo rótulo sigue siendo uno", () => {
    const parts = splitOlvaLabelTexts(rotulo(1, 1, "ANA PRIMERA", "911111111", "2000001"));
    expect(parts).toHaveLength(1);
    expect(parseOlvaLabelText(parts[0]!)).toMatchObject({ part: 1, parts: 1 });
  });

  it("un texto sin «ENVIA:» no se pierde: se lee entero", () => {
    expect(splitOlvaLabelTexts("TRACKING 2660913-26")).toEqual(["TRACKING 2660913-26"]);
  });

  it("cada rótulo se guarda en su fila: misma clave de correo y PDF, su propio label_index", async () => {
    const upserts: { row: Record<string, unknown>; onConflict: string }[] = [];
    const chain = (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "limit", "or", "order", "gte", "not"]) q[m] = () => q;
      // Ninguna salida tiene esos trackings y ninguna tienda ese RUC: «sin pareja».
      q.maybeSingle = async () => ({ data: null, error: null });
      q.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      q.upsert = async (row: Record<string, unknown>, opts: { onConflict: string }) => {
        if (table === "olva_email_labels") upserts.push({ row, onConflict: opts.onConflict });
        return { error: null };
      };
      return q;
    };
    const admin = { from: chain } as never;

    const results = await ingestOlvaEmailLabels(admin, {
      messageId: "msg-1",
      fileName: "rotulo-202600000001.pdf",
      receivedAt: "2026-10-05T14:14:01Z",
      subject: "Registro exitoso pendiente de pago - PagoEfectivo - Registro Nro 202600000001",
      text: CUATRO,
    });

    expect(results.map((r) => r.tracking)).toEqual(["2000001-26", "2000002-26", "2000003-26", "2000004-26"]);
    expect(upserts.map((u) => u.onConflict)).toEqual(Array(4).fill("message_id,file_name,label_index"));
    expect(upserts.map((u) => [u.row.label_index, u.row.label_count, u.row.recipient_name])).toEqual([
      [1, 4, "ANA PRIMERA"],
      [2, 4, "BETO SEGUNDO"],
      [3, 4, "CARLA TERCERA"],
      [4, 4, "DIEGO CUARTO"],
    ]);
    // Cada fila guarda el texto de SU rótulo, no el del PDF entero.
    expect(upserts.every((u) => (u.row.raw_text as string).split("RECIBE:").length === 2)).toBe(true);
  });
});
