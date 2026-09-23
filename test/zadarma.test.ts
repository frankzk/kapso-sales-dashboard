import { describe, expect, it } from "vitest";
import {
  buildCallbackParams,
  requestCallback,
  zadarmaLocalPeru,
  zadarmaQuery,
  zadarmaSignature,
} from "@/lib/zadarma";

// Vectores calculados aparte (Python: hashlib + hmac + base64), con el mismo
// algoritmo de la librería oficial de Zadarma. Si esto cambia, la API responde
// «Not authorized» y la llamada no sale.
describe("firma de Zadarma", () => {
  it("coincide con un vector calculado fuera de este código", () => {
    expect(
      zadarmaSignature("/v1/request/callback/", "from=17058243&sip=100&to=930555309", "secreto-de-prueba"),
    ).toBe("ZjE5ZGZiOGIzYzAxNWI2MWIxY2UyNTA5NmY0YzdhNDQ4MGUyODgxNA==");
  });

  it("ordena por clave y codifica como http_build_query de PHP", () => {
    // Es la misma query que funcionó a mano el 22-09-2026 contra /v1/statistics/.
    const q = zadarmaQuery({ start: "2026-09-22 00:00:00", end: "2026-09-22 23:59:59" });
    expect(q).toBe("end=2026-09-22+23%3A59%3A59&start=2026-09-22+00%3A00%3A00");
    expect(zadarmaSignature("/v1/statistics/", q, "secreto-de-prueba")).toBe(
      "NDA4ODk1NDE0OGY2YjI5ZDNjNzRmMjJiYWU5MjNlN2JlM2JlMmE3NQ==",
    );
  });

  it("omite los parámetros vacíos, para que la firma no los cuente", () => {
    expect(zadarmaQuery({ to: "930555309", from: "17058243", predicted: undefined, sip: "" })).toBe(
      "from=17058243&to=930555309",
    );
  });
});

describe("números peruanos sin 51", () => {
  // Con el 51 la cuenta lo duplicaba: el historial registraba 5151930555309 y
  // «failed». Todos los formatos terminan en el número local.
  it.each([
    ["51930555309", "930555309"],
    ["+51 930 555 309", "930555309"],
    ["930555309", "930555309"],
    ["0051930555309", "930555309"],
    ["5117058243", "17058243"],
    ["+51 1 705 8243", "17058243"],
    ["017058243", "17058243"],
    ["17058243", "17058243"],
  ])("%s → %s", (raw, local) => {
    expect(zadarmaLocalPeru(raw)).toBe(local);
  });

  it("un número de otro país no se marca", () => {
    expect(zadarmaLocalPeru("+12027734798")).toBeNull();
    expect(zadarmaLocalPeru("50688296100")).toBeNull();
    expect(zadarmaLocalPeru("")).toBeNull();
  });
});

describe("callback", () => {
  it("va SIN predicted: la locución de espera la oye el agente, no la clienta", () => {
    const built = buildCallbackParams({ agentNumber: "+5117058243", customerPhone: "51930555309", sip: "100" });
    expect(built).toEqual({ ok: true, params: { from: "17058243", sip: "100", to: "930555309" } });
    expect(built.ok && "predicted" in built.params).toBe(false);
  });

  it("sin extensión con caller ID peruano NO llama: la clienta vería el número de EE. UU.", () => {
    const built = buildCallbackParams({ agentNumber: "17058243", customerPhone: "930555309", sip: " " });
    expect(built.ok).toBe(false);
  });

  it("firma la petición y la manda con Authorization key:firma", async () => {
    let url = "";
    let auth = "";
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      auth = String((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ status: "success", from: 17058243, to: 930555309 }), { status: 200 });
    }) as typeof fetch;
    const r = await requestCallback(
      { key: "clave", secret: "secreto-de-prueba" },
      { agentNumber: "17058243", customerPhone: "930555309", sip: "100" },
      fake,
    );
    expect(r.ok).toBe(true);
    expect(url).toBe("https://api.zadarma.com/v1/request/callback/?from=17058243&sip=100&to=930555309");
    expect(auth).toBe("clave:ZjE5ZGZiOGIzYzAxNWI2MWIxY2UyNTA5NmY0YzdhNDQ4MGUyODgxNA==");
  });

  it("un rechazo de Zadarma no se da por llamada hecha", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ status: "error", message: "Not authorized" }), { status: 401 })) as typeof fetch;
    const r = await requestCallback(
      { key: "k", secret: "s" },
      { agentNumber: "17058243", customerPhone: "930555309", sip: "100" },
      fake,
    );
    expect(r).toMatchObject({ ok: false });
  });
});
