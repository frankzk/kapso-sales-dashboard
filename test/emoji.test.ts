import { describe, it, expect } from "vitest";
import {
  ALL_EMOJIS,
  DEFAULT_RECENTS,
  EMOJI_GROUPS,
  insertAtCursor,
  pushRecent,
  searchEmojis,
} from "@/lib/emoji";

/**
 * El selector de emojis del compositor.
 *
 * Lo que se prueba es lo que falla EN SILENCIO: dónde cae el emoji dentro del
 * texto y dónde queda el cursor. Nada de eso lanza un error — solo produce
 * mensajes mal escritos que la asesora manda sin darse cuenta.
 */

describe("insertAtCursor", () => {
  it("inserta en el cursor, no al final", () => {
    // El caso normal: se corrige una frase ya escrita.
    const r = insertAtCursor("hola  ¿cómo estás?", 5, 5, "😊");
    expect(r.text).toBe("hola 😊 ¿cómo estás?");
  });

  it("el cursor queda DETRÁS del emoji", () => {
    // Si saltara al final, el segundo emoji de un mensaje caería en otro sitio
    // que el primero y quien escribe lo haría a ciegas.
    const r = insertAtCursor("hola mundo", 4, 4, "👍");
    expect(r.caret).toBe(4 + "👍".length);
    expect(r.text.slice(0, r.caret)).toBe("hola👍");
  });

  it("cuenta en unidades UTF-16, que es lo que usa setSelectionRange", () => {
    // Casi todos los emojis son pares subrogados: con .length medido en puntos
    // de código el cursor quedaría una posición corta y partiría el carácter.
    expect("😊".length).toBe(2);
    expect(insertAtCursor("", 0, 0, "😊").caret).toBe(2);
  });

  it("reemplaza lo seleccionado", () => {
    const r = insertAtCursor("me gusta mucho", 3, 8, "❤️");
    expect(r.text).toBe("me ❤️ mucho");
  });

  it("en un texto vacío simplemente lo pone", () => {
    expect(insertAtCursor("", 0, 0, "📦")).toEqual({ text: "📦", caret: 2 });
  });

  it("un índice fuera de rango no pierde texto", () => {
    // El textarea puede devolver posiciones raras tras un pegado o un undo.
    // Acotar es preferible a truncar el mensaje que la asesora ya escribió.
    expect(insertAtCursor("hola", 99, 99, "✅").text).toBe("hola✅");
    expect(insertAtCursor("hola", -5, -5, "✅").text).toBe("✅hola");
  });

  it("un rango invertido no borra nada", () => {
    expect(insertAtCursor("hola", 3, 1, "✅").text).toBe("hol✅a");
  });
});

describe("searchEmojis", () => {
  it("busca por palabra en español", () => {
    expect(searchEmojis("gracias").map((r) => r.e)).toContain("🙏");
    expect(searchEmojis("paquete").map((r) => r.e)).toContain("📦");
  });

  it("ignora las tildes en los dos sentidos", () => {
    // La asesora teclea "envío" con tilde y las claves están sin ella.
    expect(searchEmojis("envío").map((r) => r.e)).toContain("🚚");
    expect(searchEmojis("envio").map((r) => r.e)).toContain("🚚");
  });

  it("ignora mayúsculas y espacios de los bordes", () => {
    expect(searchEmojis("  GRACIAS ").map((r) => r.e)).toContain("🙏");
  });

  it("prioriza lo que EMPIEZA por lo tecleado", () => {
    // Con dos letras hay muchas coincidencias; las que empiezan así son las que
    // la persona está buscando. Si no, el resultado útil aparece en la fila 4.
    const r = searchEmojis("ubica").map((x) => x.e);
    expect(r[0]).toBe("📍");
  });

  it("una consulta vacía no devuelve nada", () => {
    // Devolver el catálogo entero taparía los grupos y los recientes, que es lo
    // que hay que ver cuando aún no se ha escrito nada.
    expect(searchEmojis("")).toEqual([]);
    expect(searchEmojis("   ")).toEqual([]);
  });

  it("no repite un emoji entre las dos pasadas de búsqueda", () => {
    const r = searchEmojis("pago").map((x) => x.e);
    expect(new Set(r).size).toBe(r.length);
  });

  it("una consulta sin coincidencias devuelve la lista vacía, no todo", () => {
    expect(searchEmojis("xyzzy")).toEqual([]);
  });
});

describe("pushRecent", () => {
  it("pone el último usado al principio", () => {
    expect(pushRecent(["👍", "😊"], "📦")[0]).toBe("📦");
  });

  it("no duplica: lo mueve al frente", () => {
    // Sin esto, usar el mismo emoji tres veces llenaría la fila con tres copias
    // y echaría a los demás — lo contrario de para lo que sirve.
    expect(pushRecent(["👍", "😊", "📦"], "😊")).toEqual(["😊", "👍", "📦"]);
  });

  it("tiene tope: no crece sin fin en localStorage", () => {
    let list: string[] = [];
    for (const e of ALL_EMOJIS) list = pushRecent(list, e.e);
    expect(list.length).toBe(16);
  });
});

describe("catálogo", () => {
  it("no hay emojis repetidos", () => {
    // Un duplicado saldría dos veces en la rejilla sin que nadie entienda por qué.
    const all = ALL_EMOJIS.map((e) => e.e);
    expect(new Set(all).size).toBe(all.length);
  });

  it("todo emoji tiene al menos una palabra de búsqueda", () => {
    // Uno sin claves es invisible: existe en su grupo pero no se puede buscar.
    for (const item of ALL_EMOJIS) {
      expect(item.k.trim().length, `sin claves: ${item.e}`).toBeGreaterThan(0);
    }
  });

  it("los recientes por defecto existen en el catálogo", () => {
    // Si no, la primera vez que se abre el panel se ven huecos.
    for (const e of DEFAULT_RECENTS) {
      expect(ALL_EMOJIS.some((x) => x.e === e), `fuera del catálogo: ${e}`).toBe(true);
    }
  });

  it("cada grupo tiene id único y contenido", () => {
    const ids = EMOJI_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of EMOJI_GROUPS) expect(g.items.length).toBeGreaterThan(0);
  });

  it("el primer grupo es el de la operación, no el de las caras", () => {
    // Confirmar, cobrar y despachar es el caso frecuente acá; dejarlo detrás
    // pondría el 📦 a tres pestañas del uso más común.
    expect(EMOJI_GROUPS[0]!.id).toBe("venta");
  });
});
