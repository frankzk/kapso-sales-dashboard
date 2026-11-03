import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanRiderComment, cleanSubStatus, parseAliclikRow } from "@/lib/aliclik-import";
import { courierDetail } from "@/lib/aliclik-status";
import { aliclikChainReason } from "@/lib/lima-retry-chain";
import { failureLine } from "@/lib/repro-lima";

// 0304 (owner, 03-11-2026): el Excel de Aliclik trae «SUB ESTADO» y «ÚLTIMO
// COMENTARIO MOTORIZADO», que la API no da. Ejemplos reales de los imports.
const row = (extra: Record<string, string>) => ({
  "NRO. PEDIDO": "AUR5X123456789",
  "ESTADO ENTREGA": "CANCELADO",
  "ESTADO DESPACHO": "POR DEVOLVER",
  "ESTADO LLAMADA": "CONFIRMADO",
  NOTA: "#KP200108",
  ...extra,
});

describe("el parser lee el subestado y el comentario", () => {
  it("CANCELADO · DE VIAJE con el comentario del motorizado", () => {
    const parsed = parseAliclikRow(row({ "SUB ESTADO": "de viaje", "ÚLTIMO COMENTARIO MOTORIZADO": "Cliente desea la entrega el próximo sábado" }));
    expect(parsed.sub_status).toBe("DE VIAJE");
    expect(parsed.rider_comment).toBe("Cliente desea la entrega el próximo sábado");
  });

  it("sin las columnas, null", () => {
    const parsed = parseAliclikRow(row({}));
    expect(parsed.sub_status).toBeNull();
    expect(parsed.rider_comment).toBeNull();
  });

  it("limpia la basura del comentario", () => {
    for (const junk of ["-", ".", "j", "  ", "--", "..."]) expect(cleanRiderComment(junk), junk).toBeNull();
    expect(cleanRiderComment("-caja Arequipa")).toBe("caja Arequipa");
    expect(cleanRiderComment("PAL día lunes")).toBe("PAL día lunes");
    expect(cleanRiderComment("x".repeat(400))?.length).toBe(301);
    expect(cleanSubStatus("  Fuera de  cobertura ")).toBe("FUERA DE COBERTURA");
    expect(cleanSubStatus("")).toBeNull();
  });
});

describe("la cadena de reintentos lee el subestado", () => {
  it("DE VIAJE y POR CLIENTE son reprogramado; FUERA DE COBERTURA es la dirección", () => {
    expect(aliclikChainReason("CANCEL · TO_RETURN · CONFIRMED", "DE VIAJE")).toBe("reprogramado");
    expect(aliclikChainReason("CANCEL · TO_RETURN · CONFIRMED", "POR CLIENTE")).toBe("reprogramado");
    expect(aliclikChainReason("CANCEL · TO_RETURN · CONFIRMED", "FUERA DE COBERTURA")).toBe("direccion_errada");
  });

  it("sin subestado, o con otro, manda el estado como antes", () => {
    expect(aliclikChainReason("CANCEL · TO_RETURN · CONFIRMED")).toBe("otro");
    expect(aliclikChainReason("CANCEL · TO_RETURN · CONFIRMED", "NO CONFIRMADO")).toBe("otro");
    expect(aliclikChainReason("NOT_RESPOND · LEFT_IN_WAREHOUSE · CONFIRMED", null)).toBe("no_contesta");
  });
});

describe("Repro Lima y la ficha lo muestran", () => {
  it("courierDetail", () => {
    expect(courierDetail("DE VIAJE", "para el sábado")).toBe(" · de viaje · «para el sábado»");
    expect(courierDetail(null, null)).toBe("");
  });

  it("la línea del fallo suma subestado y comentario", () => {
    const { text } = failureLine({ kind: "courier", courier: "aliclik", reportedStatus: "CANCEL · TO_RETURN · CONFIRMED", subStatus: "DE VIAJE", riderComment: "para el sábado", failedOn: "2026-11-02" });
    expect(text).toContain(" · de viaje · «para el sábado»");
  });

  it("se lee de la guía en Repro Lima, en la ficha y en la ingesta", () => {
    expect(readFileSync("lib/repro-lima-program.ts", "utf8")).toContain("aliclik_transport_name,aliclik_sub_status,aliclik_rider_comment");
    expect(readFileSync("lib/repro-lima-program.ts", "utf8")).toContain("aliclikChainReason(output.reported_status, output.aliclik_sub_status)");
    expect(readFileSync("lib/shipments-access.ts", "utf8")).toContain("reported_status,aliclik_sub_status,aliclik_rider_comment");
    const ingest = readFileSync("lib/aliclik-ingest.ts", "utf8");
    expect(ingest).toContain("aliclik_sub_status: reportIsLatest ? inc.row.sub_status : existing?.aliclik_sub_status ?? null,");
    expect(ingest).toContain("aliclik_sub_status: _s, aliclik_rider_comment: _c");
  });
});
