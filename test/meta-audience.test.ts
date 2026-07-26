import { describe, it, expect } from "vitest";
import {
  audienceFirstName,
  buildMetaAudienceCsv,
  buildMetaAudienceRows,
  metaAudienceFilename,
} from "@/lib/meta-audience";

describe("buildMetaAudienceRows", () => {
  it("exporta el teléfono con código de país (solo dígitos) y deduce el país", () => {
    expect(buildMetaAudienceRows([{ phone: "980694766", name: "Flor" }])).toEqual([
      { phone: "51980694766", fn: "flor", country: "pe" },
    ]);
    // ya normalizado (con país) y con formato suelto → mismo resultado
    expect(buildMetaAudienceRows([{ phone: "+51 980 694 766", name: "Flor" }])[0]!.phone).toBe(
      "51980694766",
    );
  });

  it("deduplica por teléfono conservando la primera aparición", () => {
    const rows = buildMetaAudienceRows([
      { phone: "980694766", name: "Flor Ramírez" },
      { phone: "51980694766", name: "otra ficha" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fn).toBe("flor");
  });

  it("descarta teléfonos ausentes, basura o demasiado cortos", () => {
    expect(
      buildMetaAudienceRows([
        { phone: null, name: "sin tel" },
        { phone: "   ", name: "vacío" },
        { phone: "12345", name: "corto" },
        { phone: "abc", name: "no numérico" },
      ]),
    ).toEqual([]);
  });

  it("deja el país en blanco para prefijos que no conocemos (no adivina)", () => {
    const rows = buildMetaAudienceRows([{ phone: "34600123456", name: "Ana" }]);
    expect(rows[0]).toEqual({ phone: "34600123456", fn: "ana", country: "" });
  });

  it("preserva el orden original para que el archivo sea estable", () => {
    const rows = buildMetaAudienceRows([
      { phone: "980000001", name: "A" },
      { phone: "980000002", name: "B" },
      { phone: "980000003", name: "C" },
    ]);
    expect(rows.map((r) => r.phone)).toEqual(["51980000001", "51980000002", "51980000003"]);
  });
});

describe("audienceFirstName", () => {
  it("toma el primer nombre y limpia emoji, acentos y puntuación", () => {
    expect(audienceFirstName("Ivanita 🐻🍎")).toBe("ivanita");
    expect(audienceFirstName("José Luis Pérez")).toBe("jose");
    expect(audienceFirstName("  maría-fernanda ")).toBe("maria");
    expect(audienceFirstName("FerSal")).toBe("fersal");
  });

  it("devuelve vacío cuando no queda un nombre usable", () => {
    expect(audienceFirstName(null)).toBe("");
    expect(audienceFirstName("🐻🍎")).toBe("");
    expect(audienceFirstName("999")).toBe("");
    expect(audienceFirstName("F")).toBe(""); // una letra suelta es ruido
  });
});

describe("buildMetaAudienceCsv", () => {
  it("emite exactamente los encabezados que Meta espera, sin BOM", () => {
    const csv = buildMetaAudienceCsv([{ phone: "980694766", name: "Flor" }]);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("phone,fn,country");
    expect(lines[1]).toBe("51980694766,flor,pe");
    expect(csv.startsWith("﻿")).toBe(false);
  });

  it("el teléfono sale como dígitos crudos, sin el escape anti-fórmula del CSV", () => {
    // Un "+" inicial haría que toCsv prefije una comilla ("'+51…") y Meta no
    // podría parsear el número — de ahí que exportemos solo dígitos.
    const csv = buildMetaAudienceCsv([{ phone: "980694766", name: "Flor" }]);
    expect(csv).toContain("51980694766");
    expect(csv).not.toContain("'");
    expect(csv).not.toContain("+");
  });
});

describe("metaAudienceFilename", () => {
  it("arma un nombre legible por segmento y fecha", () => {
    expect(metaAudienceFilename("Sin llamar · Frío", "2026-07-26")).toBe(
      "audiencia-meta_sin-llamar-frio_2026-07-26.csv",
    );
    expect(metaAudienceFilename("", "2026-07-26")).toBe("audiencia-meta_leads_2026-07-26.csv");
  });
});
