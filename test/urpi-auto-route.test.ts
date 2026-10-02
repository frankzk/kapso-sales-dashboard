import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/cron/urpi-programming/route";
import { createAdminSupabase } from "@/lib/db";
import { syncUrpiAutomatically, urpiAutoEnabled } from "@/lib/urpi-auto-sync";
vi.mock("@/lib/db", () => ({ createAdminSupabase: vi.fn(() => ({})) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/urpi-auto-sync", () => ({ syncUrpiAutomatically: vi.fn(), urpiAutoEnabled: vi.fn(() => true) }));
const request = (authorization?: string) => new Request("https://kapta.test/api/cron/urpi-programming?secret=test-secret", { headers: authorization ? { authorization } : {} });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("CRON_SECRET", "test-secret"); vi.stubEnv("VERCEL_ENV", "production");
  vi.mocked(urpiAutoEnabled).mockReturnValue(true);
  vi.mocked(syncUrpiAutomatically).mockResolvedValue({ scanned: 1, changed: 1, unchanged: 0, failed: 0, busy: 0, deferred: 0, skipped: false });
});
afterEach(() => vi.unstubAllEnvs());
it("rechaza acceso público, query secret y secreto vacío", async () => {
  expect((await GET(request())).status).toBe(401);
  expect((await GET(request("Bearer wrong"))).status).toBe(401);
  vi.stubEnv("CRON_SECRET", "");
  expect((await GET(request("Bearer "))).status).toBe(401);
  expect(createAdminSupabase).not.toHaveBeenCalled();
});
it("omite previews y configuración pendiente sin consultar la base", async () => {
  vi.stubEnv("VERCEL_ENV", "preview");
  expect(await (await GET(request("Bearer test-secret"))).json()).toMatchObject({ skipped: true });
  vi.stubEnv("VERCEL_ENV", "production"); vi.mocked(urpiAutoEnabled).mockReturnValue(false);
  expect(await (await GET(request("Bearer test-secret"))).json()).toMatchObject({ skipped: true });
  expect(createAdminSupabase).not.toHaveBeenCalled();
});
it("ejecuta con bearer correcto y devuelve fallos parciales como 503", async () => {
  expect((await GET(request("Bearer test-secret"))).status).toBe(200);
  vi.mocked(syncUrpiAutomatically).mockResolvedValueOnce({ scanned: 1, changed: 0, unchanged: 0, failed: 1, busy: 0, deferred: 0, skipped: false });
  expect((await GET(request("Bearer test-secret"))).status).toBe(503);
});
it("no expone detalles de excepciones internas", async () => {
  vi.mocked(syncUrpiAutomatically).mockRejectedValueOnce(new Error("private credentials"));
  const result = await GET(request("Bearer test-secret"));
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain("private credentials");
});
