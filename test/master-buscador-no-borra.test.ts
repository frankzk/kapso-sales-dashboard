import { describe, expect, it } from "vitest";
import { receiveSearchValue, shouldSendSearch } from "@/lib/search-input-echo";

/**
 * «TIPEAS Y SE BORRA LA MITAD» (reportado el 29-09-2026).
 *
 * El buscador del Master manda lo escrito a la URL tras una pausa y la URL
 * vuelve como `value`. El input copiaba ese `value` siempre, así que quien
 * escribía «KP12», dudaba y seguía con «34» veía volver «KP12» cuando ya tenía
 * «KP1234», y perdía el «34».
 *
 * Se simula el input con la misma regla que usa el componente: lo que se
 * escribe, lo que se manda y lo que vuelve de la URL, en el orden real.
 */
function input(initial = "") {
  let text = initial;
  let pending: string[] = [];
  let url = initial;
  return {
    type(next: string) {
      text = next;
    },
    /** Pasó la pausa: el input manda lo escrito si hace falta. */
    pause(): string | null {
      const next = text.trim();
      if (!shouldSendSearch(next, url, pending)) return null;
      pending = [...pending, next];
      return next;
    },
    /** La URL cambia (respuesta del servidor, atrás/adelante, un botón). */
    urlBecomes(value: string) {
      url = value;
      const r = receiveSearchValue(pending, value);
      pending = r.pending;
      if (r.adopt) text = value;
    },
    get text() {
      return text;
    },
  };
}

describe("el buscador no pisa lo que se sigue escribiendo", () => {
  it("la respuesta tardía de «KP12» no borra el «34» tecleado después", () => {
    const i = input();
    i.type("KP12");
    expect(i.pause()).toBe("KP12");
    i.type("KP1234"); // se sigue escribiendo mientras el servidor contesta
    i.urlBecomes("KP12"); // llega la respuesta de lo primero
    expect(i.text).toBe("KP1234");
    // Y lo que quedaba por mandar se manda.
    expect(i.pause()).toBe("KP1234");
    i.urlBecomes("KP1234");
    expect(i.text).toBe("KP1234");
  });

  it("varias pausas seguidas: ningún eco intermedio pisa el texto", () => {
    const i = input();
    i.type("mar");
    i.pause();
    i.type("maria");
    i.pause();
    i.type("maria qu");
    i.urlBecomes("mar");
    expect(i.text).toBe("maria qu");
    i.urlBecomes("maria");
    expect(i.text).toBe("maria qu");
  });

  it("si el router se salta el eco intermedio, el último igual se reconoce", () => {
    const i = input();
    i.type("mar");
    i.pause();
    i.type("maria");
    i.pause();
    i.urlBecomes("maria");
    expect(i.text).toBe("maria");
    expect(i.pause()).toBeNull();
  });

  it("un eco no provoca otra navegación idéntica", () => {
    const i = input();
    i.type("KP125285");
    expect(i.pause()).toBe("KP125285");
    expect(i.pause()).toBeNull();
    i.urlBecomes("KP125285");
    expect(i.pause()).toBeNull();
  });
});

describe("la URL sigue mandando cuando el cambio viene de fuera", () => {
  it("«Limpiar búsqueda» vacía el campo", () => {
    const i = input("KP125285");
    i.urlBecomes("");
    expect(i.text).toBe("");
  });

  it("atrás/adelante del navegador se ve en el campo", () => {
    const i = input();
    i.type("KP1");
    i.pause();
    i.urlBecomes("KP1");
    i.type("KP125");
    i.pause();
    i.urlBecomes("KP125");
    // Atrás: la URL vuelve a una búsqueda anterior que ya no está en camino.
    i.urlBecomes("KP1");
    expect(i.text).toBe("KP1");
  });

  it("un cambio de fuera con envíos en camino gana, y los envíos dejan de contar", () => {
    const i = input();
    i.type("KP12");
    i.pause();
    i.urlBecomes("");
    expect(i.text).toBe("");
    // Un eco retrasado de lo anterior ya no se reconoce como propio: manda la URL.
    i.urlBecomes("KP12");
    expect(i.text).toBe("KP12");
  });
});
