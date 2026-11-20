// La nota del pedido llega al rótulo de GF (owner, 20-11-2026: «en los rótulos de GF no se está mostrando las notas que vienen
// de Kapta»): va al crear la guía y, si se escribe o cambia después, gf-reconcile se la manda. Datos FICTICIOS.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const updateNotes = vi.fn();
vi.mock("@/lib/gf-courier", async (orig) => ({ ...(await orig<typeof import("@/lib/gf-courier")>()), gfCourier: { updateNotes } }));
const { syncGfNoteFor } = await import("@/lib/gf-courier-guide");
type GfOrder = import("@/lib/gf-courier").GfOrder;

const order = (observations?: string | null): GfOrder => ({
  tracking_id: "KENKU-KP900001", external_id: "#KP900001", service: "COD_LIMA", status: { code: "CREATED", name: "Creada", sub_status: null, final: false } as never,
  shipping_cost: 10, currency: "PEN", estimated_delivery_date: "2026-11-21", label_url: "https://gf.test/label", tracking_url: null,
  ...(observations === undefined ? {} : { observations }),
});
const ORDER = "22222222-2222-4222-8222-222222222222";

describe("nota del pedido → GF", () => {
  beforeEach(() => { updateNotes.mockReset(); updateNotes.mockResolvedValue({ ok: true, data: order("x") }); });

  it("manda la nota nueva cuando GF tiene otra (o ninguna)", async () => {
    expect(await syncGfNoteFor({ token: "tok", orderId: ORDER, current: order(null), raw: { note: " CNF - ALEXIS " } })).toBe("sent");
    expect(updateNotes).toHaveBeenCalledTimes(1);
    const [opts, tracking, text, key] = updateNotes.mock.calls[0]!;
    expect(opts).toEqual({ apiToken: "tok" });
    expect(tracking).toBe("KENKU-KP900001");
    expect(text).toBe("CNF - ALEXIS");
    expect(String(key)).toMatch(new RegExp(`^KP-${ORDER}-notes-KENKU-KP900001-`));
    expect(String(key).length).toBeLessThanOrEqual(128);
  });

  it("no reenvía la misma nota; sin nota en Kapta, borra la de GF", async () => {
    expect(await syncGfNoteFor({ token: "tok", orderId: ORDER, current: order("CNF - ALEXIS"), raw: { note: "CNF - ALEXIS" } })).toBe("same");
    expect(await syncGfNoteFor({ token: "tok", orderId: ORDER, current: order(null), raw: { note: null } })).toBe("same");
    expect(updateNotes).not.toHaveBeenCalled();
    expect(await syncGfNoteFor({ token: "tok", orderId: ORDER, current: order("Llamar antes"), raw: { note: "" } })).toBe("sent");
    expect(updateNotes.mock.calls[0]![2]).toBe("");
  });

  it("con un GF que todavía no informa la nota, no hace nada", async () => {
    expect(await syncGfNoteFor({ token: "tok", orderId: ORDER, current: order(undefined), raw: { note: "CNF - ALEXIS" } })).toBe("unknown");
    expect(updateNotes).not.toHaveBeenCalled();
  });

  it("si GF la rechaza, lo dice", async () => {
    updateNotes.mockResolvedValue({ ok: false, status: 409, error: { code: "INVALID_STATE", message: "Solo se cambia la nota de un pedido activo." } });
    expect(await syncGfNoteFor({ token: "tok", orderId: ORDER, current: order(null), raw: { note: "tarde" } })).toEqual({ error: "INVALID_STATE: Solo se cambia la nota de un pedido activo." });
  });

  it("gf-reconcile lo hace con la misma lectura de cada guía viva, con la columna shopify_note y con tope por pasada", () => {
    const cron = readFileSync(join(process.cwd(), "app/api/cron/gf-reconcile/route.ts"), "utf8");
    // Qué guías lee y en qué orden: test/gf-reconcile-coverage.test.ts.
    expect(cron).toContain("loadLiveGfGuides(admin, GF_COURIER)");
    expect(readFileSync(join(process.cwd(), "lib/gf-reconcile-live.ts"), "utf8")).toContain('.select("id,store_id,guide_code,order_id,api_report_at")');
    expect(cron).toContain('.from("orders").select("id,shopify_note")');
    expect(cron).toContain("syncGfNoteFor({ token, orderId: s.order_id, current: current.data");
    expect(cron).toContain("report.notes < NOTES_PER_RUN");
  });
});
