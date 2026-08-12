import { describe, it, expect } from "vitest";
import {
  isProvisionalGuideCode,
  reconcileAliclikApiGuides,
  type ApiCreatedGuide,
  type IncomingReportRow,
} from "@/lib/aliclik-reconcile";

const guide = (over: Partial<ApiCreatedGuide> = {}): ApiCreatedGuide => ({
  id: "s1",
  store_id: "store-1",
  guide_code: "ALC000123456789",
  external_order_number: "ALC000123456789",
  order_id: "o1",
  order_name: "#KP114985",
  customer_phone: "+51918993266",
  delivery_status: "pendiente",
  ...over,
});

const row = (over: Partial<IncomingReportRow> = {}): IncomingReportRow => ({
  guide_code: "AUR5XABC123",
  order_name: "#KP114985",
  customer_phone: "+51918993266",
  ...over,
});

describe("reconcileAliclikApiGuides — promociones", () => {
  it("promueve por external_order_number cuando el reporte lo trae", () => {
    const res = reconcileAliclikApiGuides(
      [row({ external_order_number: "ALC000123456789" })],
      [guide()],
    );
    expect(res.promotions).toEqual([
      { shipmentId: "s1", fromCode: "ALC000123456789", toCode: "AUR5XABC123", method: "external_order_number" },
    ]);
  });

  it("promueve por nombre de pedido + teléfono", () => {
    const res = reconcileAliclikApiGuides([row()], [guide()]);
    expect(res.promotions).toHaveLength(1);
    expect(res.promotions[0]!.method).toBe("order_name_phone");
  });

  it("promueve solo por teléfono cuando no hay nombre de pedido", () => {
    const res = reconcileAliclikApiGuides([row({ order_name: null })], [guide()]);
    expect(res.promotions).toHaveLength(1);
    expect(res.promotions[0]!.method).toBe("phone");
  });

  it("normaliza el teléfono antes de comparar", () => {
    const res = reconcileAliclikApiGuides(
      [row({ order_name: null, customer_phone: "918993266" })],
      [guide({ customer_phone: "+51 918 993 266" })],
    );
    expect(res.promotions).toHaveLength(1);
  });
});

describe("reconcileAliclikApiGuides — se niega a adivinar", () => {
  it("no promueve cuando dos guías comparten teléfono", () => {
    const res = reconcileAliclikApiGuides(
      [row({ order_name: null })],
      [guide(), guide({ id: "s2", guide_code: "ALC000999", external_order_number: "ALC000999" })],
    );
    expect(res.promotions).toHaveLength(0);
    expect(res.ambiguous[0]).toMatchObject({ reason: "varios_candidatos" });
    expect(res.ambiguous[0]!.candidateIds).toEqual(["s1", "s2"]);
  });

  it("no le da el código de un pedido a la guía de OTRO pedido del mismo cliente", () => {
    // Un mismo teléfono con dos pedidos abiertos. La fila del reporte trae la
    // guía del pedido de julio y su nombre, pero la única guía provisional viva
    // con ese teléfono es la del pedido de junio. El paso 2 no casa —los
    // nombres difieren— y el paso 3 la promovía igual.
    //
    // PREVENTIVO: a 11-08-2026 no se ha promovido ninguna guía en producción.
    // Este agujero nunca llegó a usarse; el daño real de la misma forma de
    // razonar lo hizo el importador (ver test/shipment-match.test.ts).
    const res = reconcileAliclikApiGuides(
      [row({ guide_code: "AUR5X122767", order_name: "#KP122767" })],
      [guide({ order_id: "o-junio", order_name: "#KP120351" })],
    );
    expect(res.promotions).toHaveLength(0);
  });

  it("acepta el teléfono cuando el candidato aún no tiene pedido que contradiga", () => {
    const res = reconcileAliclikApiGuides(
      [row({ guide_code: "AUR5X122767", order_name: "#KP122767" })],
      [guide({ order_id: null, order_name: null })],
    );
    expect(res.promotions).toHaveLength(1);
    expect(res.promotions[0]!.method).toBe("phone");
  });

  it("no promueve una guía ya terminal", () => {
    for (const status of ["entregado", "anulado", "transferido"]) {
      const res = reconcileAliclikApiGuides([row()], [guide({ delivery_status: status })]);
      expect(res.promotions).toHaveLength(0);
    }
  });

  it("no promueve si el código AUR5X ya existe (el envío ya se ingestó)", () => {
    const res = reconcileAliclikApiGuides([row()], [guide()], {
      existingGuideCodes: ["AUR5XABC123"],
    });
    expect(res.promotions).toHaveLength(0);
  });

  it("no promueve sin datos para emparejar", () => {
    const res = reconcileAliclikApiGuides(
      [row({ order_name: null, customer_phone: null })],
      [guide()],
    );
    expect(res.promotions).toHaveLength(0);
  });

  it("ignora filas del reporte sin código de guía", () => {
    const res = reconcileAliclikApiGuides([row({ guide_code: null })], [guide()]);
    expect(res.promotions).toHaveLength(0);
  });

  it("no usa dos veces la misma guía en un lote", () => {
    const res = reconcileAliclikApiGuides(
      [row({ guide_code: "AUR5XAAA" }), row({ guide_code: "AUR5XBBB" })],
      [guide()],
    );
    // La primera fila se la lleva; la segunda ya no tiene candidata libre.
    expect(res.promotions).toHaveLength(1);
    expect(res.promotions[0]!.toCode).toBe("AUR5XAAA");
  });

  it("es idempotente: reimportar no vuelve a promover", () => {
    const promoted = guide({ guide_code: "AUR5XABC123" });
    const res = reconcileAliclikApiGuides([row()], [promoted], {
      existingGuideCodes: ["AUR5XABC123"],
    });
    expect(res.promotions).toHaveLength(0);
  });

  it("empareja cada guía con su propia fila cuando hay varias", () => {
    const res = reconcileAliclikApiGuides(
      [
        row({ guide_code: "AUR5XAAA", order_name: "#KP1", customer_phone: "+51900000001" }),
        row({ guide_code: "AUR5XBBB", order_name: "#KP2", customer_phone: "+51900000002" }),
      ],
      [
        guide({ id: "s1", order_name: "#KP1", customer_phone: "+51900000001" }),
        guide({
          id: "s2",
          guide_code: "ALC000999",
          external_order_number: "ALC000999",
          order_name: "#KP2",
          customer_phone: "+51900000002",
        }),
      ],
    );
    expect(res.promotions).toHaveLength(2);
    expect(res.promotions.map((p) => [p.shipmentId, p.toCode])).toEqual([
      ["s1", "AUR5XAAA"],
      ["s2", "AUR5XBBB"],
    ]);
  });
});

describe("isProvisionalGuideCode", () => {
  it("reconoce un orderNumber de Aliclik", () => {
    expect(isProvisionalGuideCode("ALC000123456789")).toBe(true);
    expect(isProvisionalGuideCode("alc000123")).toBe(true);
  });

  it("no confunde un código de guía real con uno provisional", () => {
    expect(isProvisionalGuideCode("AUR5XABC123")).toBe(false);
    expect(isProvisionalGuideCode(null)).toBe(false);
    expect(isProvisionalGuideCode("ALC")).toBe(false); // sin dígitos no es un número de pedido
  });
});
