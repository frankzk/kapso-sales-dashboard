import { describe, it, expect } from "vitest";
import { leadSearchPasses } from "@/lib/leads";

/**
 * Qué columnas se buscan para una consulta dada.
 *
 * Equivocarse acá no da error: da "sin resultados" para alguien que está a la
 * vista en la cola, que es la peor forma de fallar porque parece que el lead no
 * existe. Pasó de verdad — buscar `@vanepey6` no devolvía nada aunque el lead
 * estuviera en pantalla, mientras el inbox de Kapso sí lo encontraba.
 */

const cols = (q: string) => leadSearchPasses(q).map((p) => p.col);

describe("leadSearchPasses", () => {
  it("busca el username con y sin arroba", () => {
    // La cola muestra `@vanepey6`, así que es lo que la asesora copia o teclea.
    // El arroba no es parte del valor guardado.
    expect(leadSearchPasses("@vanepey6")).toContainEqual({ col: "username", value: "vanepey6" });
    expect(leadSearchPasses("vanepey6")).toContainEqual({ col: "username", value: "vanepey6" });
  });

  it("el caso exacto que fallaba: @vanepey6 ya no cae solo en el nombre", () => {
    // Antes solo corría el pase de nombre: los dígitos de "@vanepey6" son "6",
    // un solo carácter, por debajo del mínimo de dos. Y el nombre era "Vane 💖".
    expect(cols("@vanepey6")).toEqual(["name", "username"]);
  });

  it("un teléfono busca por dígitos, ignorando espacios y símbolos", () => {
    const passes = leadSearchPasses("+51 999 888 777");
    expect(passes).toContainEqual({ col: "phone", value: "51999888777" });
  });

  it("no gasta una consulta de teléfono con un solo dígito", () => {
    // Un pase por pulsación de teclado tiene costo: "a1" no es un teléfono.
    expect(cols("a1")).not.toContain("phone");
    expect(cols("a12")).toContain("phone");
  });

  it("busca el BSUID solo cuando la consulta lo parece", () => {
    // Nadie teclea un BSUID: se pega. Condicionarlo evita una consulta inútil en
    // cada pulsación de las búsquedas normales.
    expect(cols("PE.1595605215510035")).toContain("bsuid");
    expect(cols("Vanessa")).not.toContain("bsuid");
    expect(cols("999888777")).not.toContain("bsuid");
  });

  it("el nombre se busca siempre", () => {
    for (const q of ["Vane", "@pepe", "51999888777", "PE.123"]) {
      expect(cols(q)[0]).toBe("name");
    }
  });

  it("una consulta demasiado corta no busca nada", () => {
    // Con una letra el resultado sería medio padrón y cuatro consultas por tecla.
    expect(leadSearchPasses("a")).toEqual([]);
    expect(leadSearchPasses(" ")).toEqual([]);
    expect(leadSearchPasses("")).toEqual([]);
  });

  it("un arroba suelto no dispara el pase de username", () => {
    // `@` deja el handle vacío; buscar '%%' devolvería la tabla entera.
    expect(cols("@a")).not.toContain("username");
  });

  it("recorta los espacios de los bordes", () => {
    expect(leadSearchPasses("  Vane  ")).toContainEqual({ col: "name", value: "Vane" });
  });
});
