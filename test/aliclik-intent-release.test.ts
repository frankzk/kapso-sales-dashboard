import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RELEASABLE_GUIDE_STATUSES, aliclikReportSaysClosed, pickGuideToCancel, releasableIntents, type CreationIntent, type IntentGuide } from "@/lib/aliclik-intent-release";

// MOM §10.2, «Una guía anulada suelta el candado» (03-11-2026). Caso real:
// #KP200108, guía AUTOECOM AUR5X510805505383 anulada; «Aprobar · ALIDRIVER»
// chocaba con «Este pedido ya tiene una guía en Aliclik».
const sent: CreationIntent = { id: "i1", status: "sent", order_number: "AUR5X510805505383", released_at: null };
const guide = (delivery_status: string, extra: Partial<IntentGuide> = {}): IntentGuide => ({
  courier: "aliclik", guide_code: "AUR5X510805505383", external_order_number: "AUR5X510805505383", delivery_status,
  // Lo que Aliclik reportó de verdad para #KP200108.
  reported_status: "NOT_RESPOND · LEFT_IN_WAREHOUSE · CONFIRMED", ...extra,
});

describe("releasableIntents", () => {
  it("#KP200108: la guía AUTOECOM anulada suelta el candado", () => {
    const out = releasableIntents([sent], [guide("anulado")]);
    expect(out.release).toEqual([{ id: "i1", reason: expect.stringContaining("AUR5X510805505383 quedó anulado") }]);
    expect(aliclikReportSaysClosed(guide("anulado").reported_status)).toBe(true);
    expect(out.held).toEqual([]);
  });

  it("solo si lo dice Aliclik: un anulado o transferido que puso Kapta sin cancelar en Aliclik se queda", () => {
    // «Cliente cancela», el 7.º «no contesta» o el paso a Swayp escriben el
    // estado en Kapta; la guía puede seguir viva en Aliclik.
    for (const reported of [null, "", "PENDING_DELIVERY · PICKED · CONFIRMED", "NOT_RESPOND · IN_TRANSIT · CONFIRMED", "RESCHEDULED · IN_TRANSIT · CONFIRMED"]) {
      expect(releasableIntents([sent], [guide("anulado", { reported_status: reported })]).release, String(reported)).toEqual([]);
      expect(releasableIntents([sent], [guide("transferido", { reported_status: reported })]).release, String(reported)).toEqual([]);
    }
  });

  it("aliclikReportSaysClosed: devuelta o anulada según Aliclik", () => {
    expect(aliclikReportSaysClosed("NOT_RESPOND · LEFT_IN_WAREHOUSE · CONFIRMED")).toBe(true);
    expect(aliclikReportSaysClosed("REFUSED · RETURNED · CONFIRMED")).toBe(true);
    expect(aliclikReportSaysClosed("CANCEL · TO_RETURN · CONFIRMED")).toBe(true);
    expect(aliclikReportSaysClosed("ANNULLED")).toBe(true);
    expect(aliclikReportSaysClosed("DELIVERED · PICKED · CONFIRMED")).toBe(false);
    expect(aliclikReportSaysClosed("PENDING_DELIVERY · LEFT_IN_WAREHOUSE · CONFIRMED")).toBe(false);
    expect(aliclikReportSaysClosed(null)).toBe(false);
  });

  it("aguanta campos vacíos (la etiqueta los descarta) y el español del Excel", () => {
    // Sin estado de entrega: las partes se corrían de lugar.
    expect(aliclikReportSaysClosed("RETURNED · CONFIRMED")).toBe(true);
    expect(aliclikReportSaysClosed("FAKE")).toBe(true);
    expect(aliclikReportSaysClosed("TO_PREPARE · DUPLICATE")).toBe(true);
    expect(aliclikReportSaysClosed("PENDING_DELIVERY · OUT_OF_STOCK")).toBe(true);
    // Lo que escribe el Excel en ESTADO ENTREGA.
    expect(aliclikReportSaysClosed("ANULADO")).toBe(true);
    expect(aliclikReportSaysClosed("CANCELADO")).toBe(true);
    // Un intento fallido no es una guía cerrada.
    for (const live of ["RECHAZADO", "NO CONTESTA", "NOT_RESPOND · CONFIRMED", "CONFIRMED", "PICKED · CONFIRMED", "ALGO_RARO"]) {
      expect(aliclikReportSaysClosed(live), live).toBe(false);
    }
  });

  it("también una transferida, como en la regla de salidas", () => {
    expect(RELEASABLE_GUIDE_STATUSES).toEqual(["anulado", "transferido"]);
    expect(releasableIntents([sent], [guide("transferido", { reported_status: "CANCEL · TO_RETURN · CONFIRMED" })]).release).toHaveLength(1);
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

  it("el único parcial excluye las soltadas, se crea antes de borrar el viejo y se queda con su nombre", () => {
    expect(migration).toContain("where status <> 'failed' and released_at is null");
    const order = [
      "create unique index if not exists aliclik_order_requests_live_uniq_v2",
      "drop index if exists public.aliclik_order_requests_live_uniq;",
      "alter index if exists public.aliclik_order_requests_live_uniq_v2\n  rename to aliclik_order_requests_live_uniq;",
    ].map((t) => migration.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("la creación lee el reporte de Aliclik de cada salida", () => {
    expect(guideSrc).toContain('select("courier,guide_code,external_order_number,delivery_status,reported_status")');
  });

  it("DEPLOY: la migración va antes del código", () => {
    expect(readFileSync("DEPLOY.md", "utf8")).toContain("**Migración `0303_aliclik_intent_release.sql`**, a mano, ANTES del código.");
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

describe("con dos guías de Aliclik en el pedido", () => {
  it("«Cancelar guía Aliclik» elige la viva más reciente, no la anulada", () => {
    const nueva = { id: "nueva", delivery_status: "pendiente" };
    const vieja = { id: "vieja", delivery_status: "anulado" };
    expect(pickGuideToCancel([nueva, vieja])).toBe(nueva);
    expect(pickGuideToCancel([vieja, nueva])).toBe(nueva);
    expect(pickGuideToCancel([vieja])).toBe(vieja);
    expect(pickGuideToCancel([])).toBeNull();
    const actions = readFileSync("app/dashboard/pedidos/aliclik-actions.ts", "utf8");
    expect(actions).toContain("const guide = pickGuideToCancel(guides ?? []);");
    expect(actions).toContain('.order("created_at", { ascending: false });');
  });

  it("el rescate de una huérfana no le pone el número nuevo a otra guía del pedido", () => {
    const reconcile = readFileSync("app/api/cron/aliclik-reconcile/route.ts", "utf8");
    expect(reconcile).toContain("guide_code.is.null,guide_code.eq.${orderNumber}");
  });
});
