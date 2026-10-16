import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { guideCreatorPhrase } from "@/lib/guide-note";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("la nota de la guía dice quién la creó", () => {
  it("una persona, por su usuario", () => {
    expect(guideCreatorPhrase("millonestania5@gmail.com")).toBe("por millonestania5@gmail.com");
  });

  it("la guía automática del día programado lo dice", () => {
    expect(guideCreatorPhrase(null, true)).toBe("automáticamente (envío programado)");
  });

  it("sin nombre que poner, no inventa uno", () => {
    expect(guideCreatorPhrase(null)).toBe("por el sistema");
    expect(guideCreatorPhrase("  ")).toBe("por el sistema");
  });
});

describe("las dos notas lo usan, y siguen sin firmar", () => {
  const core = read("lib/aliclik-guide.ts");
  const actions = read("app/dashboard/pedidos/aliclik-actions.ts");

  it("crear", () => {
    expect(core).toContain("`Guía de Aliclik creada ${guideCreatorPhrase(creator, Boolean(origin))} · ${orderNumber} · `");
    const insert = core.slice(core.indexOf("Guía de Aliclik creada ${") - 1200, core.indexOf("Guía de Aliclik creada ${"));
    expect(insert).toContain("vendedora: null,");
  });

  it("vincular una existente", () => {
    expect(actions).toContain("`Guía Aliclik existente vinculada ${guideCreatorPhrase(linker)} · ${orderNumber} · `");
  });

  it("el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**La nota de la guía dice quién la creó (16-10-2026, decisión del owner).**");
  });
});
