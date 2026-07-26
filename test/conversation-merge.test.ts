import { describe, it, expect } from "vitest";
import { mergeConversationMessages } from "@/lib/conversation-merge";

const msg = (id: string | null, at: string, text = "t", direction = "inbound") => ({
  id,
  at,
  text,
  direction,
});

describe("mergeConversationMessages", () => {
  it("conserva el historial que la respuesta nueva no trae (el bug del hilo que se ocultaba)", () => {
    // Ya fundido: sesiones viejas + activa. El poll solo devuelve la activa.
    const cargado = [
      msg("v1", "2026-07-25T10:00:00.000Z", "viejo 1"),
      msg("v2", "2026-07-25T10:01:00.000Z", "viejo 2"),
      msg("a1", "2026-07-26T15:58:00.000Z", "Ok"),
    ];
    const poll = [msg("a1", "2026-07-26T15:58:00.000Z", "Ok")];

    const out = mergeConversationMessages(cargado, poll);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.id)).toEqual(["v1", "v2", "a1"]);
  });

  it("suma los mensajes nuevos del poll, ordenados por fecha", () => {
    const out = mergeConversationMessages(
      [msg("a", "2026-07-26T10:00:00.000Z")],
      [msg("c", "2026-07-26T12:00:00.000Z"), msg("b", "2026-07-26T11:00:00.000Z")],
    );
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("ante el mismo mensaje gana el entrante (trae el estado de entrega fresco)", () => {
    const out = mergeConversationMessages(
      [{ ...msg("m1", "2026-07-26T10:00:00.000Z"), status: "sent" }],
      [{ ...msg("m1", "2026-07-26T10:00:00.000Z"), status: "read" }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("read");
  });

  it("deduplica mensajes sin id por instante + sentido + texto", () => {
    const out = mergeConversationMessages(
      [msg(null, "2026-07-26T10:00:00.000Z", "hola", "inbound")],
      [
        msg(null, "2026-07-26T10:00:00.000Z", "hola", "inbound"), // mismo
        msg(null, "2026-07-26T10:00:00.000Z", "hola", "outbound"), // otro sentido → distinto
      ],
    );
    expect(out).toHaveLength(2);
  });

  it("una fecha ilegible no reordena el hilo (cae al orden de llegada)", () => {
    const out = mergeConversationMessages(
      [msg("a", "no-es-fecha", "primero")],
      [msg("b", "2026-07-26T10:00:00.000Z", "segundo")],
    );
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("sin nada previo devuelve lo entrante (carga inicial / cambio de hilo)", () => {
    const incoming = [msg("x", "2026-07-26T10:00:00.000Z")];
    expect(mergeConversationMessages([], incoming)).toEqual(incoming);
    expect(mergeConversationMessages([], [])).toEqual([]);
  });
});
