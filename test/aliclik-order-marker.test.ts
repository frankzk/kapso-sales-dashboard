import { describe, expect, it } from "vitest";
import { readOrderMarker, stampOrderMarker } from "@/lib/aliclik-reconcile";

// La marca que viaja en la nota y vuelve en la respuesta de Aliclik.
//
// Es lo que permite reencontrar una guía cuando la creación se va en timeout y
// su número se pierde con la respuesta. Antes ese reencuentro era por teléfono,
// que no identifica un pedido: hay clientes con dos pedidos abiertos a la vez, y
// pegarle la guía al equivocado deja a los dos mal.

describe("stampOrderMarker", () => {
  it("añade la marca al final de la nota del operador", () => {
    expect(stampOrderMarker("Dejar con el portero", "#KP125252")).toBe(
      "Dejar con el portero [Kapta #KP125252]",
    );
  });

  it("sin nota, la marca es toda la nota", () => {
    expect(stampOrderMarker("", "#KP125252")).toBe("[Kapta #KP125252]");
    expect(stampOrderMarker(null, "#KP125252")).toBe("[Kapta #KP125252]");
  });

  it("es idempotente: no la duplica si ya está", () => {
    const once = stampOrderMarker("Timbre malogrado", "#KP125252");
    expect(stampOrderMarker(once, "#KP125252")).toBe(once);
  });

  it("normaliza el # para que la marca sea siempre igual", () => {
    expect(stampOrderMarker("", "KP125252")).toBe("[Kapta #KP125252]");
  });

  it("sin nombre de pedido devuelve la nota intacta", () => {
    expect(stampOrderMarker("Solo mañanas", null)).toBe("Solo mañanas");
    expect(stampOrderMarker("", null)).toBeUndefined();
  });
});

describe("readOrderMarker", () => {
  it("recupera el pedido desde la nota que devuelve Aliclik", () => {
    expect(readOrderMarker("Dejar con el portero [Kapta #KP125252]")).toBe("#KP125252");
  });

  it("una nota sin marca no inventa un pedido", () => {
    expect(readOrderMarker("Dejar con el portero")).toBeNull();
    expect(readOrderMarker("")).toBeNull();
    expect(readOrderMarker(null)).toBeNull();
  });

  it("ida y vuelta: lo estampado es lo que se lee", () => {
    for (const name of ["#KP125252", "#AUR175008", "#KP126449"]) {
      expect(readOrderMarker(stampOrderMarker("nota cualquiera", name))).toBe(name);
    }
  });

  it("no confunde un corchete cualquiera del operador con la marca", () => {
    expect(readOrderMarker("[urgente] entregar hoy")).toBeNull();
  });
});
