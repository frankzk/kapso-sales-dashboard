// GF Courier: anular una guía que GF ya preparó (17-11-2026, #AUR901039 y
// KP206968). GF responde CANCEL_REQUESTED —recibió la anulación— y la anula
// (CANCELLED) recién cuando su almacén saca el paquete de preparación. Kapta
// decía «anulada, sin costo» y la guía seguía viva; ahora lo dice tal cual y no
// la trata como anulada en ningún camino (MOM §29.17).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gfCancelRequested, gfCancelRequestedText, mapGfStatus } from "@/lib/gf-courier-status";
import { courierStatusText } from "@/lib/repro-lima-blocks";

const read = (p: string) => readFileSync(p, "utf8");

describe("CANCEL_REQUESTED de GF", () => {
  it("no cambia la salida: sigue viva hasta que GF diga CANCELLED", () => {
    expect(mapGfStatus("CANCEL_REQUESTED")).toMatchObject({ deliveryStatus: null, terminal: false, unknown: [] });
    expect(mapGfStatus("CANCELLED")).toMatchObject({ deliveryStatus: "anulado", terminal: true });
  });

  it("se reconoce en `reported_status` y se dice qué falta", () => {
    expect(gfCancelRequested("CANCEL_REQUESTED")).toBe(true);
    expect(gfCancelRequested(" cancel_requested ")).toBe(true);
    expect(gfCancelRequested("CANCELLED")).toBe(false);
    expect(gfCancelRequested("READY_FOR_PICKUP:AWAITING_ASSIGNMENT")).toBe(false);
    expect(gfCancelRequested(null)).toBe(false);
    expect(gfCancelRequestedText("AURELA-AUR901039")).toBe(
      "GF recibió la anulación de AURELA-AUR901039, pero ya había preparado el paquete: la anula cuando lo saque de preparación. Hasta entonces la guía sigue viva; Kapta la marca anulada cuando GF lo confirme.",
    );
    expect(courierStatusText("CANCEL_REQUESTED")).toBe("En GF: anulación pedida, falta que GF la confirme");
  });
});

describe("ningún camino la trata como anulada", () => {
  it("cancelGfGuideFor: anulada es solo CANCELLED; lo demás vuelve `requested`", () => {
    const src = read("lib/gf-courier-guide.ts");
    expect(src).toContain("const requested = code !== \"CANCELLED\";");
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
