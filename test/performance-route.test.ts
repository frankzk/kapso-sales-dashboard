import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getClaims: vi.fn() }));

vi.mock("@/lib/db", () => ({
  createServerSupabase: async () => ({ auth: { getClaims: mocks.getClaims } }),
}));

import { POST } from "@/app/api/performance/route";

function request(body: unknown): Request {
  return new Request("https://kapso.test/api/performance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/performance", () => {
  beforeEach(() => {
    mocks.getClaims.mockReset();
  });

  it("requires an authenticated dashboard session", async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: null } });
    expect((await POST(request({ name: "kapso:call-save", durationMs: 100 }))).status).toBe(401);
  });

  it("accepts and logs a privacy-safe metric", async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(request({
      name: "dashboard:navigation",
      durationMs: 780,
      from: "/dashboard/leads",
      to: "/dashboard/envios",
      prefetched: true,
    }));
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledWith("[Kapso performance]", expect.stringContaining('"durationMs":780'));
    log.mockRestore();
  });

  it("rejects invalid or oversized payloads", async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    expect((await POST(request({ name: "unknown", durationMs: 10 }))).status).toBe(400);
    expect((await POST(request("x".repeat(4_097)))).status).toBe(413);
  });
});
