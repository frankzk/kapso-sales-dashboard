import { describe, expect, it } from "vitest";
import {
  parseReplyParams,
  renderReplyPreview,
  replyAmountLabel,
  replyFirstName,
  resolveReplyParams,
  validateReplyParams,
  type ReplyToken,
} from "@/lib/wa-reply-templates";

describe("parseReplyParams", () => {
  it("lee la lista en el orden configurado", () => {
    expect(parseReplyParams("nombre,producto,monto")).toEqual(["nombre", "producto", "monto"]);
  });

  it("respeta el orden, que es lo único que ata el token a su {{n}}", () => {
    expect(parseReplyParams("monto,nombre")).toEqual(["monto", "nombre"]);
  });

  it("tolera espacios y mayúsculas de quien lo escribió a mano en Ajustes", () => {
    expect(parseReplyParams(" Nombre , PRODUCTO ")).toEqual(["nombre", "producto"]);
  });

  it("ignora un token desconocido en vez de romper el desplegable entero", () => {
    expect(parseReplyParams("nombre,inventado,monto")).toEqual(["nombre", "monto"]);
  });

  it("una plantilla sin parámetros es válida: no todas llevan variables", () => {
    expect(parseReplyParams("")).toEqual([]);
    expect(parseReplyParams(null)).toEqual([]);
  });
});

describe("replyFirstName", () => {
  it("deja solo el primer nombre, capitalizado", () => {
    expect(replyFirstName("JOSE PIO PADILLA")).toBe("Jose");
  });

  it("sin nombre devuelve vacío, que la validación convierte en error legible", () => {
    expect(replyFirstName(null)).toBe("");
    expect(replyFirstName("   ")).toBe("");
  });
});

describe("replyAmountLabel", () => {
  it("formatea como el resto del repo", () => {
    expect(replyAmountLabel(89)).toBe("S/ 89.00");
  });

  it("un monto ausente o no positivo queda vacío, no 'S/ 0.00'", () => {
    expect(replyAmountLabel(null)).toBe("");
    expect(replyAmountLabel(0)).toBe("");
    expect(replyAmountLabel(-5)).toBe("");
  });
});

describe("resolveReplyParams", () => {
  const facts = {
    name: "MARIA ELENA QUISPE",
    product: "Sérum Tea Tree Ginger 30ml",
    amount: 89,
    district: "Los Olivos",
    storeName: "Kenku",
  };

  it("pre-rellena en el orden de los tokens", () => {
    const tokens: ReplyToken[] = ["nombre", "producto", "monto"];
    expect(resolveReplyParams(tokens, facts)).toEqual([
      "Maria",
      "Sérum Tea Tree Ginger 30ml",
      "S/ 89.00",
    ]);
  });

  it("el mismo lead con otro orden da otro array: manda la config, no el dato", () => {
    expect(resolveReplyParams(["monto", "nombre"], facts)).toEqual(["S/ 89.00", "Maria"]);
  });

  it("DEVUELVE huecos en vez de abortar — acá los completa el asesor, no el cron", () => {
    const tokens: ReplyToken[] = ["nombre", "producto"];
    expect(resolveReplyParams(tokens, { name: "Ana", product: null })).toEqual(["Ana", ""]);
  });
});

describe("validateReplyParams", () => {
  it("con todo completo deja enviar", () => {
    expect(validateReplyParams(["nombre", "monto"], ["Ana", "S/ 89.00"])).toBeNull();
  });

  it("una plantilla sin parámetros también deja enviar", () => {
    expect(validateReplyParams([], [])).toBeNull();
  });

  it("nombra el campo que falta, en vez de dejar que Meta responda 132018", () => {
    expect(validateReplyParams(["nombre", "producto"], ["Ana", ""])).toBe("Falta Producto.");
  });

  it("enumera bien cuando faltan varios", () => {
    expect(validateReplyParams(["nombre", "producto", "monto"], ["", "", ""])).toBe(
      "Faltan Nombre, Producto y Monto.",
    );
  });

  it("un valor de solo espacios cuenta como vacío: Meta lo rechaza igual", () => {
    expect(validateReplyParams(["nombre"], ["   "])).toBe("Falta Nombre.");
  });

  it("un array de largo distinto al de los tokens no se envía", () => {
    expect(validateReplyParams(["nombre", "monto"], ["Ana"])).toBe(
      "Los parámetros no coinciden con la plantilla.",
    );
  });
});

describe("renderReplyPreview", () => {
  it("sustituye los placeholders para que el asesor lea lo que manda", () => {
    expect(renderReplyPreview("Hola {{1}}, tu {{2}} sigue disponible.", ["Ana", "sérum"])).toBe(
      "Hola Ana, tu sérum sigue disponible.",
    );
  });

  it("repite el mismo valor si la plantilla usa {{1}} dos veces", () => {
    expect(renderReplyPreview("{{1}}, te escribo por tu pedido, {{1}}.", ["Ana"])).toBe(
      "Ana, te escribo por tu pedido, Ana.",
    );
  });

  it("deja el hueco a la vista cuando el valor falta — es la señal de que falta", () => {
    expect(renderReplyPreview("Hola {{1}}, tu {{2}}.", ["Ana", ""])).toBe("Hola Ana, tu {{2}}.");
  });

  it("tolera el espaciado que Meta permite dentro de las llaves", () => {
    expect(renderReplyPreview("Hola {{ 1 }}.", ["Ana"])).toBe("Hola Ana.");
  });

  it("sin cuerpo cargado no inventa preview", () => {
    expect(renderReplyPreview(null, ["Ana"])).toBe("");
    expect(renderReplyPreview("   ", ["Ana"])).toBe("");
  });
});
