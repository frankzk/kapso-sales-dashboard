// Owner, 23-11-2026 (#KP208482): «me sale ese error al enviarle msj» — «Kapso no
// lo mandó: HTTP 422». El motivo venía en la respuesta, pero en una forma que no
// se leía. Ahora se lee en cualquier forma, queda en los logs y la ficha dice si
// se intentó desde el número principal de la tienda.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { kapsoSendFailure, sendWhatsappText } from "@/lib/kapso";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

function fakeFetch(status: number, raw: string) {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
    json: async () => JSON.parse(raw),
  })) as unknown as typeof fetch;
}

describe("el motivo de un envío rechazado por Kapso", () => {
  it("el error de Meta: mensaje, detalle y código", () => {
    expect(kapsoSendFailure({ error: { message: "Re-engagement message", code: 131047, error_data: { details: "More than 24 hours" } } }))
      .toEqual({ message: "Re-engagement message · More than 24 hours", code: 131047 });
  });

  it("el error de Kapso como texto, en lista o suelto", () => {
    expect(kapsoSendFailure({ error: "Phone number not found" }).message).toBe("Phone number not found");
    expect(kapsoSendFailure({ errors: [{ detail: "to is invalid" }] }).message).toBe("to is invalid");
    expect(kapsoSendFailure({ errors: ["to is invalid"] }).message).toBe("to is invalid");
    expect(kapsoSendFailure({ message: "Unprocessable" }).message).toBe("Unprocessable");
  });

  it("un texto corto que no es JSON sí; una página HTML o nada, no", () => {
    expect(kapsoSendFailure(null, "Conversation is closed").message).toBe("Conversation is closed");
    expect(kapsoSendFailure(null, "<html>Bad gateway</html>").message).toBeNull();
    expect(kapsoSendFailure({}).message).toBeNull();
  });

  it("el envío devuelve el motivo y no «HTTP 422»", async () => {
    const sent = await sendWhatsappText(
      { apiKey: "k", baseUrl: "https://api.kapso.ai/platform/v1", fetchImpl: fakeFetch(422, JSON.stringify({ error: "Message outside 24h window" })) },
      { phoneNumberId: "pn", to: "51999000111", body: "Hola" },
    );
    expect(sent).toEqual({ ok: false, error: "Message outside 24h window", code: undefined });
  });

  it("sin motivo legible queda el código HTTP", async () => {
    const sent = await sendWhatsappText(
      { apiKey: "k", baseUrl: "https://api.kapso.ai/platform/v1", fetchImpl: fakeFetch(422, "") },
      { phoneNumberId: "pn", to: "51999000111", body: "Hola" },
    );
    expect(sent).toMatchObject({ ok: false, error: "HTTP 422" });
  });

  it("la ficha dice si se intentó desde el número principal y lo deja en los logs", () => {
    const actions = read("app/dashboard/pedidos/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function sendOrderKapsoReply("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("const pnId = conversationPn || found.creds.whatsapp_phone_number_id || null;");
    expect(body).toContain("Se intentó desde el número principal de la tienda");
    expect(body).toContain('console.error("[kapso] respuesta desde el número principal"');
    expect(read("lib/kapso.ts")).toContain("console.error(\n      `[kapso] envío rechazado HTTP ${res.status}`");
  });
});
