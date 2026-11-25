// GF Courier: anular una guía que GF ya preparó (17-11-2026, #AUR901039 y
// KP206968). GF responde CANCEL_REQUESTED —recibió la anulación— y la anula
// (CANCELLED) recién cuando su almacén saca el paquete de preparación. Kapta
// decía «anulada, sin costo» y la guía seguía viva; ahora lo dice tal cual y no
// la trata como anulada en ningún camino (MOM §29.17).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gfCancelBlockedByRider, gfCancelRequested, gfCancelRequestedText, liveGfGuides, mapGfStatus } from "@/lib/gf-courier-status";
import { courierStatusText } from "@/lib/repro-lima-blocks";

const read = (p: string) => readFileSync(p, "utf8");

describe("CANCEL_REQUESTED de GF", () => {
  it("para Kapta la guía queda anulada ya (owner 17-11-2026, #KP206881)", () => {
    expect(mapGfStatus("CANCEL_REQUESTED")).toMatchObject({ deliveryStatus: "anulado", operational: "anulado", terminal: false, unknown: [] });
    expect(mapGfStatus("CANCELLED")).toMatchObject({ deliveryStatus: "anulado", terminal: true });
  });

  it("se reconoce en `reported_status` y se dice qué falta", () => {
    expect(gfCancelRequested("CANCEL_REQUESTED")).toBe(true);
    expect(gfCancelRequested(" cancel_requested ")).toBe(true);
    expect(gfCancelRequested("CANCELLED")).toBe(false);
    expect(gfCancelRequested("READY_FOR_PICKUP:AWAITING_ASSIGNMENT")).toBe(false);
    expect(gfCancelRequested(null)).toBe(false);
    expect(gfCancelRequestedText("AURELA-AUR901039")).toBe(
      "Guía AURELA-AUR901039 anulada. GF ya no la asigna a ningún motorizado; su almacén solo desarma la caja.",
    );
    expect(courierStatusText("CANCEL_REQUESTED")).toBe("En GF: anulada, GF desarma la caja");
  });
});

describe("caminos que dependen de la anulación", () => {
  it("cancelGfGuideFor: CANCELLED y CANCEL_REQUESTED cuentan como anulada; otro estado vuelve `requested`", () => {
    const src = read("lib/gf-courier-guide.ts");
    expect(src).toContain("const requested = code !== \"CANCELLED\" && code !== \"CANCEL_REQUESTED\";");
    expect(src).toContain("return { ok: true, trackingId, cancelCost: Number(res.data.cancel_cost ?? 0), requested };");
  });

  it("«Anular guía GF» dice que quedó pedida y no la vuelve a pedir", () => {
    const src = read("app/dashboard/pedidos/gf-courier-actions.ts");
    expect(src).toContain("if (gfCancelRequested(live.reported_status)) return");
    expect(src).toContain("if (res.requested) return { notice: `${gfCancelRequestedText(res.trackingId)}${cost}`, pending: true };");
  });

  it("Aliclik no se crea encima de una GF con la anulación solo pedida", () => {
    const src = read("lib/aliclik-guide.ts");
    const at = src.indexOf("if (cancelled.requested)");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf("gfCancelled.push(gf.guide_code);"));
  });

  it("Repro Lima no crea la guía GF nueva si la anterior quedó solo pedida", () => {
    const src = read("app/dashboard/pedidos/repro-lima/actions.ts");
    const at = src.indexOf("if (res.requested) {");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf("cancelled.push(old.guideCode);"));
  });

  it("la Mesa de ruta y «Salidas y guías» no ofrecen anularla otra vez", () => {
    expect(read("components/order-route-desk.tsx")).toContain("!gfCancelRequested(route.blockingOutput!.reportedStatus)");
    expect(read("components/order-drawer.tsx")).toContain("Anulación pedida a GF: falta que GF saque el paquete de preparación y la confirme.");
  });
});

// Owner, 25-11-2026: «la única limitante que deberíamos de poner es si la guía ya está en reparto con el motorizado».
describe("solo en reparto con el motorizado no se anula desde Kapta (owner 25-11-2026)", () => {
  const order = (code: string, stage: string | null = null) => ({ status: { code, sub_status: null, final: false } as any, stage: stage ? { code: stage, rider_name: "Alexis" } : null });
  it("bloquea si la caja ya está en la calle", () => {
    expect(gfCancelBlockedByRider(order("OUT_FOR_DELIVERY"))).toContain("ya está en reparto con un motorizado");
    expect(gfCancelBlockedByRider(order("REFUSED"))).toContain("no se anula desde Kapta");
    expect(gfCancelBlockedByRider(order("RETURNING"))).toContain("en reparto");
  });
  it("asignada a un motorizado pero sin salir: se anula (GF la retira sola de la carga)", () => {
    expect(gfCancelBlockedByRider(order("READY_FOR_PICKUP", "AWAITING_OFFICE_CHECK"))).toBeNull();
    expect(gfCancelBlockedByRider(order("READY_FOR_PICKUP", "AWAITING_RIDER"))).toBeNull();
  });
  it("deja anular lo que no tiene motorizado", () => {
    expect(gfCancelBlockedByRider(order("READY_FOR_PICKUP", "AWAITING_ASSIGNMENT"))).toBeNull();
    expect(gfCancelBlockedByRider(order("CREATED", "TO_PREPARE"))).toBeNull();
  });
  it("novedad con la caja de vuelta en el almacén de GF: se anula (owner 24-11-2026, #KP206970)", () => {
    expect(gfCancelBlockedByRider(order("INCIDENT", "BACK_IN_WAREHOUSE"))).toBeNull();
    // De vuelta y asignada a una carga nueva que todavía no sale: también.
    expect(gfCancelBlockedByRider(order("INCIDENT", "AWAITING_RIDER"))).toBeNull();
    // Sin la etapa (GF anterior, o la caja sigue con el motorizado), como antes.
    expect(gfCancelBlockedByRider(order("INCIDENT"))).toContain("en reparto");
    expect(gfCancelBlockedByRider(order("OUT_FOR_DELIVERY", "BACK_IN_WAREHOUSE"))).toContain("en reparto");
  });
});

describe("Swayp anula la guía GF viva al crearse (owner 17-11-2026, #KP206994)", () => {
  it("liveGfGuides toma solo GF viva con número", () => {
    const outs = [
      { courier: "gf_courier", delivery_status: "pendiente", guide_code: "KENKU-KP206994" },
      { courier: "gf_courier", delivery_status: "anulado", guide_code: "KENKU-KP206994-S2" },
      { courier: "fenix", delivery_status: "en_ruta", guide_code: "50000176883" },
    ];
    expect(liveGfGuides(outs).map((o) => o.guide_code)).toEqual(["KENKU-KP206994"]);
  });
  it("la guía Swayp directa la anula antes de pedirla a Swayp, solo si la crea una persona", () => {
    const src = read("lib/swayp-directa.ts");
    expect(src).toContain("const gfToCancel = input.actorId ? liveGfGuides(guides) : [];");
    expect(src.indexOf("cancelLiveGfForOtherCourier(admin")).toBeLessThan(src.indexOf("createFenixGuideViaApi({"));
  });
});

describe("Grupo GF ya no sale con salidas nuevas (owner 17-11-2026)", () => {
  it("«Sacar con salida nueva» queda cerrado; tomar en tiendas con GF por API sigue bloqueado", () => {
    const src = read("app/dashboard/courier/actions.ts");
    expect(src).toContain("const GRUPO_GF_NEW_OUTPUTS_CLOSED = true;");
    const replace = src.slice(src.indexOf("export async function replaceOwnOutputs("));
    expect(replace.indexOf("if (GRUPO_GF_NEW_OUTPUTS_CLOSED)")).toBeLessThan(replace.indexOf("createAdminSupabase()"));
    expect(src).toContain("if (await storeUsesGfCourierApi(admin, row.store_id as string | null, gfApiStores)) {");
  });
});
