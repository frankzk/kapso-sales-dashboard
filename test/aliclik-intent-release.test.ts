import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RELEASABLE_GUIDE_STATUSES, releasableIntents, type CreationIntent, type IntentGuide } from "@/lib/aliclik-intent-release";

// MOM §10.2, «Una guía anulada suelta el candado» (03-11-2026). Caso real:
// #KP200108, guía AUTOECOM AUR5X510805505383 anulada; «Aprobar · ALIDRIVER»
// chocaba con «Este pedido ya tiene una guía en Aliclik».
const sent: CreationIntent = { id: "i1", status: "sent", order_number: "AUR5X510805505383", released_at: null };
const guide = (delivery_status: string, extra: Partial<IntentGuide> = {}): IntentGuide => ({
  courier: "aliclik", guide_code: "AUR5X510805505383", external_order_number: "AUR5X510805505383", delivery_status, ...extra,
});

describe("releasableIntents", () => {
  it("#KP200108: la guía AUTOECOM anulada suelta el candado", () => {
    const out = releasableIntents([sent], [guide("anulado")]);
    expect(out.release).toEqual([{ id: "i1", reason: expect.stringContaining("AUR5X510805505383 quedó anulado") }]);
    expect(out.held).toEqual([]);
  });

  it("también una transferida, como en la regla de salidas", () => {
    expect(RELEASABLE_GUIDE_STATUSES).toEqual(["anulado", "transferido"]);
    expect(releasableIntents([sent], [guide("transferido")]).release).toHaveLength(1);
  });

  it("una guía viva, devuelta sin anular o entregada no suelta nada", () => {
    for (const status of ["en_transito", "pendiente", "devuelto", "entregado", "no_entregado"]) {
      expect(releasableIntents([sent], [guide(status)]).release, status).toEqual([]);
    }
  });

  it("nunca un pending: Aliclik pudo haberla creado", () => {
    const pending = { ...sent, status: "pending" };
    expect(releasableIntents([pending], [guide("anulado")])).toEqual({ release: [], held: [pending] });
  });

  it("sin número, o con un número que no está en las salidas, se queda", () => {
    const sinNumero = { ...sent, order_number: null };
    expect(releasableIntents([sinNumero], [guide("anulado")]).release).toEqual([]);
    expect(releasableIntents([sent], [guide("anulado", { guide_code: "OTRA", external_order_number: "OTRA" })]).release).toEqual([]);
    expect(releasableIntents([sent], []).release).toEqual([]);
  });

  it("si dos salidas tienen ese número y una sigue viva, se queda", () => {
    expect(releasableIntents([sent], [guide("anulado"), guide("en_transito")]).release).toEqual([]);
  });

  it("solo cuentan las salidas de Aliclik, y el número se compara sin # ni mayúsculas", () => {
    expect(releasableIntents([sent], [guide("anulado", { courier: "tanders" })]).release).toEqual([]);
    expect(releasableIntents([{ ...sent, order_number: " aur5x510805505383 " }], [guide("anulado", { guide_code: "#AUR5X510805505383", external_order_number: null })]).release).toHaveLength(1);
  });

  it("duplicate cuenta como sent; failed y las ya soltadas ni se miran", () => {
    expect(releasableIntents([{ ...sent, status: "duplicate" }], [guide("anulado")]).release).toHaveLength(1);
    expect(releasableIntents([{ ...sent, status: "failed" }, { ...sent, id: "i2", released_at: "2026-11-03T07:00:00Z" }], [guide("anulado")])).toEqual({ release: [], held: [] });
  });
});

describe("el candado en la base y en la creación", () => {
  const migration = readFileSync("db/migrations/0303_aliclik_intent_release.sql", "utf8");
  const guideSrc = readFileSync("lib/aliclik-guide.ts", "utf8");

  it("el único parcial excluye las soltadas, y se crea antes de borrar el viejo", () => {
    expect(migration).toContain("where status <> 'failed' and released_at is null");
    expect(migration.indexOf("create unique index if not exists aliclik_order_requests_live_uniq_v2"))
      .toBeLessThan(migration.indexOf("drop index if exists public.aliclik_order_requests_live_uniq;"));
  });

  it("se suelta después de la regla de salidas y antes de escribir la intención", () => {
    const create = guideSrc.slice(guideSrc.indexOf("export async function createAliclikGuideFor"));
    const order = [
      "const finalOutputPolicy = await readAliclikOutputPolicy(",
      "const releaseError = await releaseClosedGuideIntents(admin, orderId);",
      '.from("aliclik_order_requests")\n    .insert(',
    ].map((t) => create.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("soltar es condicional y el aviso del candado ignora las soltadas", () => {
    expect(guideSrc).toContain('.update({ released_at: now, released_reason: r.reason })\n      .eq("id", r.id)\n      .is("released_at", null);');
    expect(guideSrc).toContain('.neq("status", "failed")\n    .is("released_at", null)\n    .order("created_at", { ascending: false })');
  });
});
