import { describe, it, expect } from "vitest";
import {
  generatePickupKey,
  isValidDateKey,
  minAgencyScheduleDate,
  PICKUP_KEY_LENGTH,
  resolveAgencyKeyCode,
  resolveAgencyScheduleDate,
  selectDefaultAgencyPackageSize,
  splitCustomerName,
  validateAgencyUnits,
} from "@/lib/aliclik-agency";

// Lima es UTC-5: 15:00Z = 10:00 en Lima, 20:00Z = 15:00 en Lima.
const limaAt = (dateUtc: string) => new Date(dateUtc);

describe("selectDefaultAgencyPackageSize", () => {
  it("elige Caja Paquete XXS aunque SOBRE sea la primera opción de Aliclik", () => {
    expect(
      selectDefaultAgencyPackageSize(["SOBRE", "Caja Paquete XXS", "Caja Paquete XS"]),
    ).toBe("Caja Paquete XXS");
  });

  it("conserva el texto exacto del catálogo y tolera espacios o mayúsculas", () => {
    expect(selectDefaultAgencyPackageSize(["SOBRE", "  CAJA PAQUETE XXS  "])).toBe(
      "  CAJA PAQUETE XXS  ",
    );
  });

  it("cae a la primera opción válida si XXS no está disponible", () => {
    expect(selectDefaultAgencyPackageSize(["", "SOBRE", "Caja Paquete XS"])).toBe("SOBRE");
    expect(selectDefaultAgencyPackageSize([])).toBe("");
  });
});

describe("minAgencyScheduleDate", () => {
  it("antes del corte, el despacho puede ser hoy", () => {
    // 2026-07-20 es lunes. 15:00Z = 10:00 Lima, antes del corte de las 13:00.
    expect(minAgencyScheduleDate("13:00", limaAt("2026-07-20T15:00:00Z"))).toBe("2026-07-20");
  });

  it("después del corte, pasa al día siguiente", () => {
    // 20:00Z = 15:00 Lima, ya pasado el corte.
    expect(minAgencyScheduleDate("13:00", limaAt("2026-07-20T20:00:00Z"))).toBe("2026-07-21");
  });

  it("sábado después del corte salta el domingo y cae en lunes", () => {
    // 2026-07-25 es sábado.
    expect(minAgencyScheduleDate("13:00", limaAt("2026-07-25T20:00:00Z"))).toBe("2026-07-27");
  });

  it("un domingo se traslada a lunes aunque no haya pasado el corte", () => {
    // 2026-07-26 es domingo; 15:00Z = 10:00 Lima.
    expect(minAgencyScheduleDate("13:00", limaAt("2026-07-26T15:00:00Z"))).toBe("2026-07-27");
  });

  it("sin hora de corte conocida asume hoy — no retrasa por un dato que nos falta", () => {
    expect(minAgencyScheduleDate(null, limaAt("2026-07-20T20:00:00Z"))).toBe("2026-07-20");
  });
});

describe("resolveAgencyScheduleDate", () => {
  it("respeta una fecha válida y futura", () => {
    const r = resolveAgencyScheduleDate({
      requested: "2026-07-22",
      formatTimeAgency: "13:00",
      now: limaAt("2026-07-20T15:00:00Z"),
    });
    expect(r).toMatchObject({ date: "2026-07-22", adjusted: false, reason: "ok" });
  });

  it("sube una fecha demasiado temprana, como hace Aliclik en silencio", () => {
    const r = resolveAgencyScheduleDate({
      requested: "2026-07-18",
      formatTimeAgency: "13:00",
      now: limaAt("2026-07-20T15:00:00Z"),
    });
    expect(r.adjusted).toBe(true);
    expect(r.reason).toBe("too_early");
    expect(r.date).toBe("2026-07-20");
    expect(r.message).toContain("2026-07-18");
  });

  it("traslada un domingo al lunes", () => {
    const r = resolveAgencyScheduleDate({
      requested: "2026-08-02", // domingo
      formatTimeAgency: "13:00",
      now: limaAt("2026-07-20T15:00:00Z"),
    });
    expect(r.date).toBe("2026-08-03");
    expect(r.reason).toBe("sunday");
    expect(r.adjusted).toBe(true);
  });

  it("una fecha mal formada cae a la mínima en vez de romper", () => {
    const r = resolveAgencyScheduleDate({
      requested: "20/07/2026",
      formatTimeAgency: "13:00",
      now: limaAt("2026-07-20T15:00:00Z"),
    });
    expect(r.reason).toBe("invalid_request");
    expect(r.date).toBe("2026-07-20");
  });

  it("sin fecha pedida, explica el corte cuando ya pasó", () => {
    const r = resolveAgencyScheduleDate({
      formatTimeAgency: "13:00",
      now: limaAt("2026-07-20T20:00:00Z"),
    });
    expect(r.date).toBe("2026-07-21");
    expect(r.reason).toBe("after_cutoff");
    expect(r.message).toContain("13:00");
  });
});

describe("isValidDateKey", () => {
  it("acepta fechas reales y rechaza las imposibles", () => {
    expect(isValidDateKey("2026-07-20")).toBe(true);
    expect(isValidDateKey("2026-02-30")).toBe(false); // no existe
    expect(isValidDateKey("20/07/2026")).toBe(false);
    expect(isValidDateKey(null)).toBe(false);
  });
});

describe("generatePickupKey", () => {
  it("tiene la longitud acordada", () => {
    expect(generatePickupKey()).toHaveLength(PICKUP_KEY_LENGTH);
  });

  it("evita glifos que se confunden al dictar la clave por teléfono", () => {
    // 300 claves cubren de sobra el alfabeto.
    const all = Array.from({ length: 300 }, () => generatePickupKey()).join("");
    for (const bad of ["0", "O", "1", "I", "L", "5", "S"]) {
      expect(all).not.toContain(bad);
    }
  });

  it("es determinista con un generador inyectado", () => {
    expect(generatePickupKey(() => 0)).toBe("AAAAAA");
    // 0.999… nunca debe desbordar el alfabeto.
    expect(generatePickupKey(() => 0.9999999)).toHaveLength(PICKUP_KEY_LENGTH);
  });
});

describe("resolveAgencyKeyCode", () => {
  it("REUTILIZA la clave existente — acuñar otra dejaría el paquete varado", () => {
    const r = resolveAgencyKeyCode({ existingKey: "A1B2C3", generated: "ZZZZZZ" });
    expect(r).toEqual({ keyCode: "A1B2C3", reused: true });
  });

  it("usa la generada cuando no hay ninguna registrada", () => {
    const r = resolveAgencyKeyCode({ existingKey: null, generated: "ZZZZZZ" });
    expect(r).toEqual({ keyCode: "ZZZZZZ", reused: false });
  });

  it("genera una si no se le pasa ninguna", () => {
    const r = resolveAgencyKeyCode({});
    expect(r.reused).toBe(false);
    expect(r.keyCode).toHaveLength(PICKUP_KEY_LENGTH);
  });

  it("una clave existente en blanco no cuenta como existente", () => {
    expect(resolveAgencyKeyCode({ existingKey: "   ", generated: "ZZZZZZ" }).reused).toBe(false);
  });
});

describe("validateAgencyUnits", () => {
  it("acepta hasta 6 unidades", () => {
    expect(validateAgencyUnits([{ quantity: 6 }])).toMatchObject({ ok: true, total: 6 });
    expect(validateAgencyUnits([{ quantity: 2 }, { quantity: 4 }])).toMatchObject({ ok: true });
  });

  it("rechaza a partir de 7 y dice cuántas hay", () => {
    const r = validateAgencyUnits([{ quantity: 4 }, { quantity: 3 }]);
    expect(r.ok).toBe(false);
    expect(r.total).toBe(7);
    expect(r.message).toContain("7");
  });

  it("rechaza un pedido sin unidades", () => {
    expect(validateAgencyUnits([]).ok).toBe(false);
  });
});

describe("splitCustomerName", () => {
  it("parte con el criterio peruano: los dos últimos tokens son apellidos", () => {
    expect(splitCustomerName("Juan Pérez García")).toEqual({
      firstName: "Juan",
      firstLastName: "Pérez",
      secondLastName: "García",
    });
    expect(splitCustomerName("Ana María Pérez García")).toEqual({
      firstName: "Ana María",
      firstLastName: "Pérez",
      secondLastName: "García",
    });
  });

  it("rellena con '.' en vez de dejar vacío: un vacío hace que Aliclik rechace todo", () => {
    expect(splitCustomerName("Juan")).toEqual({
      firstName: "Juan",
      firstLastName: ".",
      secondLastName: ".",
    });
    expect(splitCustomerName("Juan Pérez")).toEqual({
      firstName: "Juan",
      firstLastName: "Pérez",
      secondLastName: ".",
    });
    expect(splitCustomerName(null)).toEqual({
      firstName: ".",
      firstLastName: ".",
      secondLastName: ".",
    });
  });

  it("tolera espacios de más", () => {
    expect(splitCustomerName("  Juan   Pérez   García ")).toEqual({
      firstName: "Juan",
      firstLastName: "Pérez",
      secondLastName: "García",
    });
  });
});
