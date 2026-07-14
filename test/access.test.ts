import { describe, expect, it } from "vitest";
import { defaultRange } from "@/lib/access";
import { localPresetRange } from "@/lib/productivity";

// 01:30Z del 13/07 = 20:30 del 12/07 en Lima (UTC−5): la hora exacta en la que
// el viejo defaultRange (UTC) saltaba a "mañana" y corría todo el rango un día.
const NIGHT = "2026-07-13T01:30:00Z";

describe("defaultRange", () => {
  it("ancla 'hoy' al día local de la tienda, no al UTC", () => {
    expect(defaultRange(30, "America/Lima", NIGHT)).toEqual({ from: "2026-06-13", to: "2026-07-12" });
    expect(defaultRange(1, "America/Lima", NIGHT)).toEqual({ from: "2026-07-12", to: "2026-07-12" });
  });

  it("en UTC reproduce el calendario UTC", () => {
    expect(defaultRange(30, "UTC", NIGHT)).toEqual({ from: "2026-06-14", to: "2026-07-13" });
  });

  it("coincide con el preset '30d' del tablero (mismo rango → el chip se activa)", () => {
    expect(defaultRange(30, "America/Lima", NIGHT)).toEqual(localPresetRange(30, "America/Lima", NIGHT));
  });
});
