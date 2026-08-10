import { describe, it, expect } from "vitest";
import { isManualReturn, returnedSourceLabel, sealReturn } from "@/lib/returned-source";

describe("procedencia del sello de devolución (0116)", () => {
  it("distingue el sello de una persona del reporte del courier", () => {
    expect(isManualReturn("manual")).toBe(true);
    expect(isManualReturn("MANUAL")).toBe(true);
    expect(isManualReturn("aliclik_report")).toBe(false);
    expect(isManualReturn("aliclik_api")).toBe(false);
  });

  it("una guía vieja SIN procedencia no cuenta como sellada a mano", () => {
    // Antes de 0116 nadie guardaba esto. Suponer «manual» pondría un aviso de
    // desconfianza sobre 300 devoluciones que sí reportó el courier.
    expect(isManualReturn(null)).toBe(false);
    expect(isManualReturn("")).toBe(false);
  });

  it("nombra la vía en castellano, con el courier que la reportó", () => {
    expect(returnedSourceLabel("aliclik_api")).toBe("API de Aliclik");
    expect(returnedSourceLabel("aliclik_report")).toBe("reporte de Aliclik");
    expect(returnedSourceLabel("shalom_report")).toBe("reporte de Shalom");
    expect(returnedSourceLabel("manual")).toBe("sellada a mano");
  });

  it("un courier que todavía no tiene nombre propio se muestra igual", () => {
    // `report-ingest` sirve a couriers que se dan de alta sin tocar este mapa.
    // Mejor «reporte de axel» que perder el dato.
    expect(returnedSourceLabel("axel_report")).toBe("reporte de axel");
  });

  it("sin procedencia no se etiqueta nada", () => {
    expect(returnedSourceLabel(null)).toBeNull();
    expect(returnedSourceLabel("  ")).toBeNull();
  });
});

describe("sealReturn — la devolución se sella una vez, con su procedencia", () => {
  const REPORTE = { returned: true, at: "2026-08-10T12:00:00Z", source: "aliclik_report" };

  it("sella fecha y procedencia cuando el reporte trae la devolución", () => {
    expect(sealReturn(null, REPORTE)).toEqual({
      returned_at: "2026-08-10T12:00:00Z",
      returned_source: "aliclik_report",
    });
  });

  it("un reporte posterior que ya no la menciona NO deshace el sello", () => {
    const yaDevuelta = { returned_at: "2026-08-01T10:00:00Z", returned_source: "aliclik_report" };
    expect(sealReturn(yaDevuelta, { ...REPORTE, returned: false })).toEqual(yaDevuelta);
  });

  it("un reporte del courier NO reescribe la procedencia de un sello a mano", () => {
    // Esta es la razón de ser de la columna. Si el Excel pisara la procedencia,
    // una devolución que recibió una persona en el almacén pasaría a figurar
    // como constancia de Aliclik, y el aviso de la cola desaparecería solo.
    const aMano = { returned_at: "2026-08-01T10:00:00Z", returned_source: "manual" };
    expect(sealReturn(aMano, REPORTE)).toEqual(aMano);
  });

  it("una guía que no volvió no se sella ni se etiqueta", () => {
    expect(sealReturn(null, { ...REPORTE, returned: false })).toEqual({
      returned_at: null,
      returned_source: null,
    });
  });

  it("un sello viejo sin procedencia (pre-0116) se conserva tal cual", () => {
    const legado = { returned_at: "2026-07-01T10:00:00Z", returned_source: null };
    expect(sealReturn(legado, REPORTE)).toEqual(legado);
  });
});
