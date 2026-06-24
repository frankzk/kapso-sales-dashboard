import { describe, it, expect } from "vitest";
import { extractReferral } from "@/lib/kapso";

describe("extractReferral (CTWA ad attribution)", () => {
  it("pulls the ad referral off the first inbound message (Jeannette's real shape)", () => {
    const page = [
      { type: "text", kapso: { direction: "outbound" }, text: { body: "¡Hola! Soy Akemi de Aurela" } },
      {
        type: "text",
        from: "51920582451",
        kapso: { direction: "inbound" },
        text: { body: "Hola! Más info de TravelersBackpack™" },
        referral: {
          headline: "✈️ Viaja Sin Maletas",
          source_type: "ad",
          source_id: "120246653255450657",
          ctwa_clid: "AfiDsrCCkdGj2FiH5W8fwxZl",
          media_type: "video",
          source_url: "https://fb.me/3XPC5CmkQ",
        },
      },
    ];
    expect(extractReferral(page)).toEqual({
      source: "meta_ad",
      ad_id: "120246653255450657",
      ad_headline: "✈️ Viaja Sin Maletas",
      ctwa_clid: "AfiDsrCCkdGj2FiH5W8fwxZl",
    });
  });

  it("returns null for an organic conversation (no referral on any message)", () => {
    const page = [
      { kapso: { direction: "inbound" }, text: { body: "Hola, ¿tienen la mochila?" } },
      { kapso: { direction: "outbound" }, text: { body: "¡Claro!" } },
    ];
    expect(extractReferral(page)).toBeNull();
  });

  it("coerces a numeric source_id and tolerates missing optional fields", () => {
    const r = extractReferral([
      { kapso: { direction: "inbound" }, referral: { source_type: "ad", source_id: 12345 } },
    ]);
    expect(r).toEqual({ source: "meta_ad", ad_id: "12345", ad_headline: null, ctwa_clid: null });
  });
});
