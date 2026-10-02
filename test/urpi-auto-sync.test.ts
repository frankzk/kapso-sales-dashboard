import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncUrpiAutomatically } from "@/lib/urpi-auto-sync";
import { urpiAutoMonths } from "@/lib/urpi-programming";
import { readUrpiGoogleWorkbook, urpiGoogleConfigured } from "@/lib/urpi-google-sheets";
import { saveUrpiProgramming } from "@/lib/urpi-programming-db";

vi.mock("@/lib/urpi-google-sheets", () => ({ readUrpiGoogleWorkbook: vi.fn(), urpiGoogleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/urpi-programming-db", () => ({ saveUrpiProgramming: vi.fn() }));
const header = ["Fecha de entrega", "Tipo de Envio", "Código de pedido", "Destinatario", "Número de contacto", "Provincia", "Distrito", "Dirección", "Producto a entregar", "Monto a Cobrar"];
const workbook = { title: "Octubre", tabs: [{ title: "01/10/26", sheetId: 42, values: [header, ["01/10/26", "Primer Turno", "KP123", "Cliente", "900000000", "Lima", "Rímac", "Dirección", "Producto", 149], ["01/10/26", "Primer Turno", "AUR123", "Cliente", "900000000", "Lima", "Rímac", "Dirección", "Producto", 149]] }] };
const source = (id: string, prefix = "KP") => ({ id, store_id: id, spreadsheet_id: "123456789012345678901", month: "2026-10", order_prefix: prefix, current_snapshot_id: null });

function database(sources: ReturnType<typeof source>[], outcomes?: unknown[]) {
  const queue = outcomes ?? sources.flatMap((s) => [{ data: s, error: null }, { data: { id: s.id }, error: null }]);
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "in", "or", "order", "update", "eq"]) builder[method] = (...args: unknown[]) => { calls.push({ method, args }); return builder; };
  builder.limit = (n: number) => { calls.push({ method: "limit", args: [n] }); return Promise.resolve({ data: sources, error: null }); };
  builder.maybeSingle = () => Promise.resolve(queue.shift());
  const from = vi.fn(() => builder);
  return { admin: { from } as unknown as SupabaseClient, from, calls };
}

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T18:00:00Z"));
  vi.stubEnv("URPI_AUTO_SYNC_ENABLED", "true");
  vi.mocked(urpiGoogleConfigured).mockReturnValue(true);
  vi.mocked(readUrpiGoogleWorkbook).mockResolvedValue(workbook);
  vi.mocked(saveUrpiProgramming).mockResolvedValue({ changed: false, rows: 1, linked: 0 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("lectura automática Urpi", () => {
  it("calcula mes anterior/actual/siguiente con la hora de Lima y cruza años", () => {
    expect(urpiAutoMonths(new Date("2027-01-01T02:00:00Z"))).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(urpiAutoMonths(new Date("2027-01-01T05:00:00Z"))).toEqual(["2026-12", "2027-01", "2027-02"]);
  });
  it("no consulta datos sin credenciales o si está pausada", async () => {
    const db = database([]);
    vi.mocked(urpiGoogleConfigured).mockReturnValue(false);
    expect((await syncUrpiAutomatically(db.admin)).skipped).toBe(true);
    vi.mocked(urpiGoogleConfigured).mockReturnValue(true); vi.stubEnv("URPI_AUTO_SYNC_ENABLED", "false");
    expect((await syncUrpiAutomatically(db.admin)).skipped).toBe(true);
    expect(db.from).not.toHaveBeenCalled();
  });
  it("lee una vez el libro compartido, separa prefijos y usa actor de sistema", async () => {
    const db = database([source("kenku"), source("aurela", "AUR")]);
    vi.mocked(saveUrpiProgramming).mockResolvedValueOnce({ changed: true, rows: 1, linked: 0 });
    expect(await syncUrpiAutomatically(db.admin)).toMatchObject({ scanned: 2, changed: 1, unchanged: 1, failed: 0 });
    expect(readUrpiGoogleWorkbook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveUrpiProgramming).mock.calls.map((call) => call[2].rows[0]?.orderCode)).toEqual(["KP123", "AUR123"]);
    expect(vi.mocked(saveUrpiProgramming).mock.calls[0]?.[3]).toMatchObject({ actor: null, origin: "google", startedAt: "2026-10-01T18:00:00.000Z" });
    expect(db.calls).toContainEqual({ method: "in", args: ["month", ["2026-09", "2026-10", "2026-11"]] });
    expect(db.calls.some((c) => c.method === "eq" && c.args[0] === "auto_sync_token")).toBe(true);
    expect(db.calls.filter((c) => c.method === "or").map((c) => c.args[0])).toContain("auto_sync_until.is.null,auto_sync_until.lt.2026-10-01T18:00:00.000Z");
  });
  it("no lee ni guarda una fuente reclamada por otra ejecución", async () => {
    const db = database([source("kenku")], [{ data: null, error: null }]);
    expect(await syncUrpiAutomatically(db.admin)).toMatchObject({ busy: 1, failed: 0 });
    expect(readUrpiGoogleWorkbook).not.toHaveBeenCalled();
    expect(saveUrpiProgramming).not.toHaveBeenCalled();
  });
  it("un fallo de Google no guarda una versión vacía y no bloquea otro libro", async () => {
    const other = { ...source("other"), spreadsheet_id: "other12345678901234567890" };
    const db = database([source("kenku"), other]);
    vi.mocked(readUrpiGoogleWorkbook).mockRejectedValueOnce(new Error("provider secret must not persist"));
    expect(await syncUrpiAutomatically(db.admin)).toMatchObject({ failed: 1, unchanged: 1 });
    expect(saveUrpiProgramming).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.calls)).not.toContain("provider secret");
    const statuses = db.calls.filter((c) => c.method === "update").map((c) => c.args[0] as Record<string, unknown>);
    expect(statuses.some((s) => typeof s.last_auto_error === "string" && !s.last_auto_success_at)).toBe(true);
  });
  it("mantiene la fecha de lectura original al reutilizar el libro", async () => {
    const db = database([source("kenku"), source("aurela", "AUR")]);
    vi.mocked(saveUrpiProgramming).mockImplementation(async () => { vi.setSystemTime(new Date("2026-10-01T18:01:00Z")); return { changed: false, rows: 1, linked: 0 }; });
    await syncUrpiAutomatically(db.admin);
    expect(vi.mocked(saveUrpiProgramming).mock.calls[1]?.[3].startedAt).toBe("2026-10-01T18:00:00.000Z");
  });
  it("difiere el resto al agotar el tiempo, sin marcarlo como leído", async () => {
    const db = database([source("kenku"), source("other")]);
    vi.mocked(saveUrpiProgramming).mockImplementationOnce(async () => { vi.setSystemTime(new Date("2026-10-01T18:03:01Z")); return { changed: false, rows: 1, linked: 0 }; });
    expect(await syncUrpiAutomatically(db.admin)).toMatchObject({ scanned: 1, deferred: 1 });
    expect(saveUrpiProgramming).toHaveBeenCalledTimes(1);
  });
});
