import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readUrpiGoogleWorkbook } from "@/lib/urpi-google-sheets";

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
