import { describe, it, expect } from "vitest";
import {
  canScheduleExpress,
  isShortenedMapsLink,
  limaTimeHHMM,
  parseCoordinateInput,
  parseHHMM,
  toAliclikCoord,
} from "@/lib/aliclik-geo";

describe("toAliclikCoord", () => {
  it("emits a plain decimal string", () => {
    expect(toAliclikCoord(-12.04318)).toBe("-12.04318");
    expect(toAliclikCoord(-77.02824)).toBe("-77.02824");
  });

  it("never uses exponential notation for small magnitudes", () => {
    // String(0.00000071) === "7.1e-7": Aliclik rechazaría eso como decimal.
    expect(String(0.00000071)).toContain("e"); // el riesgo es real
    expect(toAliclikCoord(0.00000071)).not.toContain("e");
  });

  it("never emits a locale comma", () => {
    expect(toAliclikCoord(-12.5)).toBe("-12.5");
    expect(toAliclikCoord(-12.5)).not.toContain(",");
  });

  it("normalises -0 and rejects non-finite values", () => {
    expect(toAliclikCoord(-0)).toBe("0");
    expect(toAliclikCoord(Number.NaN)).toBe("");
    expect(toAliclikCoord(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("parseCoordinateInput", () => {
  it("reads a bare pair with assorted separators", () => {
    expect(parseCoordinateInput("-12.04318,-77.02824")).toEqual({ lat: -12.04318, lng: -77.02824 });
    expect(parseCoordinateInput(" -12.04318 , -77.02824 ")).toEqual({ lat: -12.04318, lng: -77.02824 });
    expect(parseCoordinateInput("-12.04318 / -77.02824")).toEqual({ lat: -12.04318, lng: -77.02824 });
  });

  it("reads the ?q= form produced by 'compartir ubicación'", () => {
    expect(parseCoordinateInput("https://maps.google.com/?q=-12.04,-77.02")).toEqual({
      lat: -12.04,
      lng: -77.02,
    });
  });

  it("reads the /@lat,lng,17z view centre", () => {
    expect(parseCoordinateInput("https://www.google.com/maps/@-12.04,-77.02,17z")).toEqual({
      lat: -12.04,
      lng: -77.02,
    });
  });

  it("prefers the exact !3d/!4d place pin over the view centre", () => {
    // El @ es el centro de la vista y puede estar desplazado; !3d/!4d es el sitio.
    const url =
      "https://www.google.com/maps/place/X/@-12.09,-77.09,17z/data=!3m1!4b1!3d-12.04318!4d-77.02824";
    expect(parseCoordinateInput(url)).toEqual({ lat: -12.04318, lng: -77.02824 });
  });

  it("rejects input without a plausible pair", () => {
    expect(parseCoordinateInput("")).toBeNull();
    expect(parseCoordinateInput(null)).toBeNull();
    expect(parseCoordinateInput("Av. Larco 123, Miraflores")).toBeNull();
    // Enteros sueltos no son coordenadas: evitan falsos positivos con rangos.
    expect(parseCoordinateInput("1, 2")).toBeNull();
  });

  it("rejects out-of-range values and null island", () => {
    expect(parseCoordinateInput("-91.5,-77.0")).toBeNull();
    expect(parseCoordinateInput("0.0,0.0")).toBeNull();
  });

  it("flags shortened links, which cannot be resolved without opening them", () => {
    expect(isShortenedMapsLink("https://maps.app.goo.gl/abc123")).toBe(true);
    expect(isShortenedMapsLink("https://www.google.com/maps/@-12.04,-77.02,17z")).toBe(false);
  });
});

describe("parseHHMM", () => {
  it("accepts valid times and rejects the rest", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("11:30")).toBe(690);
    expect(parseHHMM("23:59")).toBe(1439);
    expect(parseHHMM("24:00")).toBeNull();
    expect(parseHHMM("11:60")).toBeNull();
    expect(parseHHMM("hola")).toBeNull();
    expect(parseHHMM(null)).toBeNull();
  });
});

describe("canScheduleExpress", () => {
  it("accepts a time inside the window, inclusive at both edges", () => {
    expect(canScheduleExpress("05:00", "00:00", "11:30")).toBe(true);
    expect(canScheduleExpress("00:00", "00:00", "11:30")).toBe(true);
    expect(canScheduleExpress("11:30", "00:00", "11:30")).toBe(true);
  });

  it("rejects a time outside the window", () => {
    expect(canScheduleExpress("11:31", "00:00", "11:30")).toBe(false);
    expect(canScheduleExpress("23:00", "08:00", "17:00")).toBe(false);
  });

  it("handles a window that crosses midnight", () => {
    expect(canScheduleExpress("23:30", "23:00", "02:00")).toBe(true);
    expect(canScheduleExpress("01:00", "23:00", "02:00")).toBe(true);
    expect(canScheduleExpress("12:00", "23:00", "02:00")).toBe(false);
  });

  it("refuses when the window is unknown — never guesses an express slot", () => {
    expect(canScheduleExpress("12:00", null, "17:00")).toBe(false);
    expect(canScheduleExpress("12:00", "08:00", null)).toBe(false);
  });
});

describe("limaTimeHHMM", () => {
  it("converts UTC to Lima (UTC-5, no DST)", () => {
    expect(limaTimeHHMM(new Date("2026-07-20T15:30:00Z"))).toBe("10:30");
    // Cruce de medianoche: 03:00 UTC es todavía el día anterior en Lima.
    expect(limaTimeHHMM(new Date("2026-07-20T03:00:00Z"))).toBe("22:00");
  });

  it("renders midnight as 00:00, not 24:00", () => {
    expect(limaTimeHHMM(new Date("2026-07-20T05:00:00Z"))).toBe("00:00");
  });
});
