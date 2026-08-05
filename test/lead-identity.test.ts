import { describe, it, expect } from "vitest";
import { leadCanCall, leadHandle } from "@/lib/leads";
import { leadUpsertConflictTarget } from "@/lib/leads-ingest";

/**
 * Identidad del lead cuando Meta deja de compartir el teléfono (0105).
 *
 * El teléfono pasó de ser lo que SIEMPRE está a ser lo que HABILITA la llamada.
 * Estas dos funciones son la frontera entre "cómo se muestra" y "qué se puede
 * hacer", y todo lo demás del panel las consulta a ellas.
 */

describe("leadHandle", () => {
  it("prefiere el teléfono", () => {
    // Es lo que la asesora reconoce, dicta y busca. Mientras exista, gana.
    expect(leadHandle({ phone: "51999888777", username: "pepe", bsuid: "PE.1" })).toBe("+51999888777");
  });

  it("cae al username cuando no hay número", () => {
    expect(leadHandle({ phone: null, username: "cfloresw13", bsuid: "PE.1595605215510035" })).toBe(
      "@cfloresw13",
    );
  });

  it("cae al BSUID cuando tampoco hay username", () => {
    // Feo, pero es un identificador real. Un hueco en pantalla se lee como un
    // error de la aplicación y la asesora deja de confiar en la fila.
    expect(leadHandle({ phone: null, username: null, bsuid: "PE.1595605215510035" })).toBe(
      "PE.1595605215510035",
    );
  });

  it("nunca devuelve vacío", () => {
    expect(leadHandle({ phone: null, username: null, bsuid: null })).toBe("sin identidad");
    expect(leadHandle({})).toBe("sin identidad");
  });

  it("ignora valores en blanco en vez de mostrarlos", () => {
    // `"  "` es verdadero en JS: sin el trim, un username de espacios ganaría al
    // BSUID y el lead aparecería como "@" a secas.
    expect(leadHandle({ phone: "   ", username: "  ", bsuid: "PE.9" })).toBe("PE.9");
  });
});

describe("leadCanCall", () => {
  it("solo con teléfono", () => {
    expect(leadCanCall({ phone: "51999888777" })).toBe(true);
    expect(leadCanCall({ phone: null, username: "pepe", bsuid: "PE.1" })).toBe(false);
    expect(leadCanCall({})).toBe(false);
  });

  it("un teléfono en blanco no habilita la llamada", () => {
    // Un `tel:+` vacío abre el marcador sin número y parece que falló el equipo.
    expect(leadCanCall({ phone: "  " })).toBe(false);
    expect(leadCanCall({ phone: "" })).toBe(false);
  });
});

describe("leadUpsertConflictTarget", () => {
  it("empareja por teléfono cuando lo hay", () => {
    expect(leadUpsertConflictTarget({ phone: "51999888777" })).toBe("store_id,phone");
  });

  it("empareja por BSUID cuando no hay teléfono", () => {
    // ESTE es el que importa. Con `store_id,phone` un lead sin número nunca
    // colisionaría consigo mismo — en Postgres los NULL son distintos entre sí —
    // y el cron insertaría una fila nueva cada cinco minutos, para siempre, sin
    // un solo error en los logs.
    expect(leadUpsertConflictTarget({ phone: null })).toBe("store_id,bsuid");
  });

  it("un teléfono vacío cuenta como sin teléfono", () => {
    // Hoy es inalcanzable — `normalizePhone` devuelve null, nunca "" — y se
    // afirma igual porque el día que dejara de serlo el fallo sería silencioso y
    // grave: `unique (store_id, phone)` trata "" como un valor REAL, así que
    // todos los leads sin número colisionarían entre sí y se pisarían uno a otro.
    expect(leadUpsertConflictTarget({ phone: "" })).toBe("store_id,bsuid");
  });
});
