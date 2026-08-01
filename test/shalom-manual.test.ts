import { describe, expect, it } from "vitest";
import { normalizeManualShalomGuide } from "@/lib/shalom/manual";

describe("normalizeManualShalomGuide", () => {
  it("normaliza una guía externa completa sin alterar la clave", () => {
    const result = normalizeManualShalomGuide({
      guideCode: "  v123 / 456  ",
      codigo: " ab9x ",
      pickupCode: "2415",
      agencyBranch: "  REQUE   - CHICLAYO ",
      serie: " v872 ",
      oseId: "98765",
      shalomOrderId: 4567,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        guideCode: "V123/456",
        codigo: "AB9X",
        pickupCode: "2415",
        agencyBranch: "REQUE - CHICLAYO",
        serie: "v872",
        oseId: 98765,
        shalomOrderId: 4567,
      },
    });
  });

  it("solo exige el número que usa el tracking público", () => {
    expect(normalizeManualShalomGuide({ guideCode: "009989001" })).toEqual({
      ok: true,
      value: {
        guideCode: "009989001",
        codigo: null,
        pickupCode: null,
        agencyBranch: null,
        serie: null,
        oseId: null,
        shalomOrderId: null,
      },
    });
  });

  it("rechaza una guía vacía o con caracteres que romperían el rastreo", () => {
    expect(normalizeManualShalomGuide({ guideCode: "" })).toMatchObject({ ok: false });
    expect(normalizeManualShalomGuide({ guideCode: "guía # 123" })).toMatchObject({ ok: false });
  });

  it("valida la clave externa con las mismas reglas que Shalom", () => {
    expect(
      normalizeManualShalomGuide({ guideCode: "998800", pickupCode: "1234" }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/consecutiv/i) });
  });

  it("rechaza identificadores internos no numéricos", () => {
    expect(
      normalizeManualShalomGuide({ guideCode: "998800", oseId: "OSE-12" }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/OSE ID/i) });
  });
});
