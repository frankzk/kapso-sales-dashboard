import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readUrpiGoogleWorkbook, urpiGoogleClientEmail, urpiGooglePrivateKey } from "@/lib/urpi-google-sheets";

const id = "123456789012345678901234567890";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function setup() {
  vi.stubEnv("URPI_GOOGLE_CLIENT_EMAIL", "reader@example.test");
  vi.stubEnv("URPI_GOOGLE_PRIVATE_KEY", privateKey);
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("Urpi Google reader", () => {
  it("authenticates read-only and reads bounded ranges discovered from metadata", async () => {
    const fetcher = setup();
    fetcher.mockResolvedValueOnce(json({ access_token: "test-token" })).mockResolvedValueOnce(json({ properties: { title: "Octubre" }, sheets: [
      { properties: { title: "01/10/26", sheetId: 42, gridProperties: { rowCount: 986, columnCount: 15 } } },
      { properties: { title: "30/09/26", sheetId: 43, gridProperties: { rowCount: 1000, columnCount: 15 } } },
    ] })).mockResolvedValueOnce(json({ valueRanges: [{ values: [["A"]] }] }));
    expect(await readUrpiGoogleWorkbook(id, "2026-10")).toEqual({ title: "Octubre", tabs: [{ title: "01/10/26", sheetId: 42, values: [["A"]] }] });
    const body = fetcher.mock.calls[0]![1].body as URLSearchParams;
    const claims = JSON.parse(Buffer.from(body.get("assertion")!.split(".")[1]!, "base64url").toString());
    expect(claims.scope).toBe("https://www.googleapis.com/auth/spreadsheets.readonly");
    const url = new URL(fetcher.mock.calls[2]![0]);
    expect(url.searchParams.getAll("ranges")).toEqual(["'01/10/26'!A1:O986"]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("refuses access denied and does not return an empty replacement", async () => {
    const fetcher = setup();
    fetcher.mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({}, 403));
    await expect(readUrpiGoogleWorkbook(id, "2026-10")).rejects.toThrow("no puede leer");
  });
  it("rejects incomplete API results", async () => {
    const fetcher = setup();
    fetcher.mockResolvedValueOnce(json({ access_token: "token" })).mockResolvedValueOnce(json({ properties: { title: "Octubre" }, sheets: [{ properties: { title: "01/10/26", sheetId: 42, gridProperties: { rowCount: 986, columnCount: 15 } } }] }))
      .mockResolvedValueOnce(json({ valueRanges: [] }));
    await expect(readUrpiGoogleWorkbook(id, "2026-10")).rejects.toThrow("incompleta");
  });
  it("requires application credentials independently of the chat connector", async () => {
    vi.stubEnv("URPI_GOOGLE_CLIENT_EMAIL", ""); vi.stubEnv("URPI_GOOGLE_PRIVATE_KEY", "");
    await expect(readUrpiGoogleWorkbook(id, "2026-10")).rejects.toThrow("no está conectada");
  });
});

// 03-11-2026: la primera lectura con la clave pegada en Vercel falló con
// «error:1E08010C:DECODER routines::unsupported». La clave se reconstruye venga
// como venga pegada.
describe("la clave de la cuenta de servicio, como se haya pegado", () => {
  const escaped = privateKey.replace(/\n/g, "\\n");
  const pastes: Record<string, string> = {
    "PEM con saltos reales": privateKey,
    "con \\n escritos, como en el JSON": escaped,
    "entre comillas, con coma": `"${escaped}",`,
    "con \\n escapados dos veces": privateKey.replace(/\n/g, "\\\\n"),
    "con saltos de Windows": privateKey.replace(/\n/g, "\r\n"),
    "en una línea con espacios": privateKey.replace(/\n/g, " "),
    "el JSON entero": JSON.stringify({ type: "service_account", client_email: "reader@example.test", private_key: privateKey }),
    "la línea del JSON": `"private_key": "${escaped}",`,
  };
  for (const [name, raw] of Object.entries(pastes)) {
    it(name, () => {
      expect(() => createPrivateKey(urpiGooglePrivateKey(raw))).not.toThrow();
      expect(urpiGooglePrivateKey(raw)).toBe(urpiGooglePrivateKey(privateKey));
    });
  }
  it("lo que no es una clave se rechaza diciendo qué copiar", () => {
    expect(() => urpiGooglePrivateKey("AIzaSyEjemploDeClaveDeApi")).toThrow("Copia el valor de «private_key» del JSON");
  });
  it("el correo, sin comillas y también desde el JSON", () => {
    expect(urpiGoogleClientEmail(' "tienda-sheets@x.iam.gserviceaccount.com", ')).toBe("tienda-sheets@x.iam.gserviceaccount.com");
    expect(urpiGoogleClientEmail(JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com" }))).toBe("a@b.iam.gserviceaccount.com");
  });
  it("con la clave pegada entre comillas, la lectura autentica igual", async () => {
    const fetcher = setup();
    vi.stubEnv("URPI_GOOGLE_PRIVATE_KEY", `"${escaped}"`);
    fetcher.mockResolvedValueOnce(json({ access_token: "test-token" })).mockResolvedValueOnce(json({ properties: { title: "Octubre" }, sheets: [
      { properties: { title: "01/10/26", sheetId: 42, gridProperties: { rowCount: 10, columnCount: 15 } } },
    ] })).mockResolvedValueOnce(json({ valueRanges: [{ values: [["A"]] }] }));
    await expect(readUrpiGoogleWorkbook(id, "2026-10")).resolves.toEqual({ title: "Octubre", tabs: [{ title: "01/10/26", sheetId: 42, values: [["A"]] }] });
  });
});
