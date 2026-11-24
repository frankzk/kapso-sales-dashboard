// La guía GF que quedó de más se anula sola (owner, 24-11-2026, #KP206950 y #KP207043: «sí, ok»).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gfBoxBackInWarehouse, gfGhostCancelNote, gfGhostReplacedBy, type GhostOtherOutput } from "@/lib/gf-ghost-guide";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const back = { status: { code: "INCIDENT", sub_status: "NO_ANSWER", final: false }, stage: { code: "BACK_IN_WAREHOUSE" } } as any;
const withRider = { status: { code: "INCIDENT", sub_status: "NO_ANSWER", final: false }, stage: null } as any;
// #KP207043: la guía GF del 17-11 volvió al almacén el 23-11; la de Aliclik la creó una persona el 23-11 y está en ruta.
const aliclik: GhostOtherOutput = {
  courier: "aliclik", guide_code: "AUR5X487032723642", delivery_status: "en_ruta", returned_at: null,
  created_at: "2026-11-24T01:26:00Z", by_person: true,
};
const gfCreatedAt = "2026-11-17T22:52:00Z";

describe("guía GF de más (owner 24-11-2026)", () => {
  it("la caja volvió al almacén y el pedido ya salió con Aliclik por una persona: se anula", () => {
    expect(gfBoxBackInWarehouse(back)).toBe(true);
    expect(gfGhostReplacedBy({ gf: back, gfCreatedAt, others: [aliclik] })).toEqual(aliclik);
    expect(gfGhostReplacedBy({ gf: back, gfCreatedAt, others: [{ ...aliclik, delivery_status: "entregado" }] })).not.toBeNull();
    expect(gfGhostCancelNote(aliclik)).toContain("ya salió con Aliclik (guía AUR5X487032723642), creada por una persona");
  });

  it("con la caja todavía en la calle o en una carga nueva, no", () => {
    expect(gfGhostReplacedBy({ gf: withRider, gfCreatedAt, others: [aliclik] })).toBeNull();
    const assigned = { ...back, stage: { code: "AWAITING_RIDER", rider_name: "Alexis" } };
    expect(gfGhostReplacedBy({ gf: assigned, gfCreatedAt, others: [aliclik] })).toBeNull();
  });

  it("solo una guía de otro courier, viva o entregada, creada por una persona DESPUÉS de la guía GF", () => {
    expect(gfGhostReplacedBy({ gf: back, gfCreatedAt, others: [{ ...aliclik, by_person: false }] })).toBeNull();
    expect(gfGhostReplacedBy({ gf: back, gfCreatedAt, others: [{ ...aliclik, created_at: "2026-11-16T10:00:00Z" }] })).toBeNull();
    expect(gfGhostReplacedBy({ gf: back, gfCreatedAt, others: [{ ...aliclik, delivery_status: "anulado" }] })).toBeNull();
    expect(gfGhostReplacedBy({ gf: back, gfCreatedAt, others: [{ ...aliclik, returned_at: "2026-11-24T10:00:00Z" }] })).toBeNull();
    // Grupo GF («propio») y otra guía de GF Courier no la reemplazan.
    expect(gfGhostReplacedBy({ gf: back, gfCreatedAt, others: [{ ...aliclik, courier: "propio" }] })).toBeNull();
    expect(gfGhostReplacedBy({ gf: back, gfCreatedAt, others: [{ ...aliclik, courier: "gf_courier" }] })).toBeNull();
    expect(gfGhostReplacedBy({ gf: back, gfCreatedAt, others: [{ ...aliclik, courier: "fenix" }] })).not.toBeNull();
  });

  it("el aviso de GF y la pasada de gf-reconcile la anulan, sin tumbar su trabajo", () => {
    const hook = read("app/api/webhooks/gf/[storeId]/route.ts");
    expect(hook.indexOf("closeGhostGfGuide(admin, applied.orderId, current.data)")).toBeGreaterThan(hook.indexOf("applyGfSnapshot(current.data, admin)"));
    const cron = read("app/api/cron/gf-reconcile/route.ts");
    expect(cron).toContain("const ghost = await closeGhostGfGuide(admin, c.orderId, current.data);");
    const server = read("lib/gf-courier-guide.ts");
    expect(server).toContain("userId: null, reason: `Ya salió con");
    expect(server).toMatch(/export async function closeGhostGfGuide[\s\S]*?catch \(cause\)/);
  });
});
