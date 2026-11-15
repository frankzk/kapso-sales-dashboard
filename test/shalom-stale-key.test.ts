// La clave de la guía muerta no sobrevive al reemplazo (13-11-2026, #KP201792):
// cada guía de Shalom tiene su clave de recojo, y la de la muerta se le dio a
// la clienta, que en la agencia oyó «no es la clave».
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("reemplazo de guía muerta sin clave nueva", () => {
  const src = read("lib/shalom/register-guide.ts");
  const fn = src.slice(src.indexOf("LA CLAVE DE LA GUÍA MUERTA NO SIRVE"));
  const block = fn.slice(0, fn.indexOf("const { data: validatedPayments }"));

  it("solo cuando reemplaza y no trae la clave de la nueva", () => {
    expect(block).toContain("if (!guide.pickupCode && replaced.length) {");
  });

  it("borra la clave guardada y lo dice en la nota y el payload", () => {
    expect(block).toContain('admin.from("shalom_pickup_keys").delete().eq("order_id", row.order_id)');
    expect(block).toContain("y se quitó: no sirve para la nueva.");
    expect(src).toContain("staleKeyNote,");
    expect(src).toContain("...(staleKeyNote ? { clave_vieja_quitada: true } : {}),");
  });

  it("si la clienta ya la tenía, pide avisarle la guía y la clave nuevas", () => {
    expect(block).toContain('.in("kind", ["key_view", "key_shared"])');
    expect(block).toContain('admin.from("pickup_key_shares")');
    expect(block).toContain("La clienta ya la tenía: avísale la guía y la clave nuevas.");
  });

  it("el MOM lo documenta", () => {
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("**Sin la clave de la nueva, la de la muerta se quita (13-11-2026).**");
  });
});
