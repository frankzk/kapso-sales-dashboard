import { describe, it, expect } from "vitest";
import { mapKapsoNumber } from "@/lib/ingest";
import type { KapsoPhoneNumber } from "@/lib/kapso";

describe("mapKapsoNumber (Kapso number → whatsapp_numbers label row)", () => {
  it("maps a Cloud API number → kind 'api'", () => {
    const n: KapsoPhoneNumber = {
      phone_number_id: "1241790819006805",
      name: "Aurela",
      verified_name: "Aurela",
      display_phone_number: "+51 917 173 327",
      is_coexistence: false,
      kind: "production",
    };
    expect(mapKapsoNumber(n)).toEqual({
      phone_number_id: "1241790819006805",
      name: "Aurela",
      display_phone: "+51 917 173 327",
      kind: "api",
    });
  });

  it("maps a coexistence (Business app) number → kind 'business'", () => {
    const n: KapsoPhoneNumber = {
      phone_number_id: "1022274334303691",
      name: "Aurela Kenku Consultas",
      display_phone_number: "+51 902 004 410",
      is_coexistence: true,
      kind: "production",
    };
    expect(mapKapsoNumber(n)).toMatchObject({ kind: "business", name: "Aurela Kenku Consultas" });
  });

  it("maps a sandbox number → kind 'sandbox' even without coexistence", () => {
    const n: KapsoPhoneNumber = {
      phone_number_id: "597907523413541",
      name: "Sandbox WhatsApp",
      display_phone_number: null,
      is_coexistence: false,
      kind: "sandbox",
    };
    expect(mapKapsoNumber(n)).toMatchObject({ kind: "sandbox", display_phone: null });
  });

  it("falls back name → verified_name → display_name, and drops rows without an id", () => {
    expect(mapKapsoNumber({ phone_number_id: "1", verified_name: "VN" })?.name).toBe("VN");
    expect(mapKapsoNumber({ phone_number_id: "1", display_name: "DN" })?.name).toBe("DN");
    expect(mapKapsoNumber({ name: "no id" })).toBeNull();
  });
});
