import { describe, expect, it } from "vitest";
import { listIntegrationProducts } from "@/lib/swayp";

// GET /v1/integrations/products va a la misma base y con la misma credencial
// que las guías. La forma de la respuesta todavía no se conoce: se devuelve cruda.
describe("listIntegrationProducts", () => {
  it("GET a {base}/v1/integrations/products con Bearer + email + x-country", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ data: [{ barCode: "AURE001" }] }) } as Response;
    }) as unknown as typeof fetch;
    const r = await listIntegrationProducts({
      token: "TOK",
      email: "api@kapta.pe",
      baseUrl: "https://api.example.com/api/",
      fetchImpl,
    });
    expect(r).toEqual({ data: [{ barCode: "AURE001" }] });
    expect(seen[0]!.url).toBe("https://api.example.com/api/v1/integrations/products");
    expect(seen[0]!.init.method).toBe("GET");
    const h = seen[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer TOK");
    expect(h.email).toBe("api@kapta.pe");
    expect(h["x-country"]).toBe("PE");
  });
});
