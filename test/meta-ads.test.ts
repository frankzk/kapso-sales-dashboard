import { describe, it, expect } from "vitest";
import {
  adObjectiveLabel,
  adStatusLabel,
  adsManagerUrl,
  prettyAdName,
} from "@/lib/meta-ads";

describe("meta-ads display helpers", () => {
  it("prettyAdName drops the extension and normalises the full-width colon", () => {
    expect(prettyAdName("mochila viral 81 9：16.mp4")).toBe("mochila viral 81 9:16");
    expect(prettyAdName("mochila viral 33.mp4")).toBe("mochila viral 33");
    expect(prettyAdName("Promo verano.MOV")).toBe("Promo verano");
    expect(prettyAdName("ya limpio")).toBe("ya limpio");
  });

  it("adsManagerUrl builds a deep link only when the account is known", () => {
    expect(adsManagerUrl("1253056442078246", "120246655557300657")).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/ads?act=1253056442078246&selected_ad_ids=120246655557300657",
    );
    expect(adsManagerUrl(null, "120246655557300657")).toBeNull();
    expect(adsManagerUrl("123", "")).toBeNull();
  });

  it("adObjectiveLabel maps known codes and passes through unknown ones", () => {
    expect(adObjectiveLabel("OUTCOME_ENGAGEMENT")).toBe("Interacción / Mensajes");
    expect(adObjectiveLabel("OUTCOME_SALES")).toBe("Ventas");
    expect(adObjectiveLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(adObjectiveLabel(null)).toBeNull();
  });

  it("adStatusLabel maps status to a label + tone", () => {
    expect(adStatusLabel("ACTIVE")).toEqual({ label: "Activo", tone: "green" });
    expect(adStatusLabel("PAUSED")).toEqual({ label: "Pausado", tone: "amber" });
    expect(adStatusLabel("ARCHIVED")).toEqual({ label: "Archivado", tone: "slate" });
    expect(adStatusLabel(null)).toBeNull();
  });
});
