import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

// Con el drawer abierto se perdía de vista qué fila de la tabla era (30-09-2026).
describe("Master: la fila del drawer abierto se resalta", () => {
  const board = read("components/orders-master.tsx");

  it("las dos tablas (pestañas y búsqueda) reciben el pedido abierto", () => {
    expect(board.match(/openId=\{openId\}/g)?.length).toBe(2);
  });

  it("la fila abierta tiene su propio fondo, distinto del de la casilla marcada", () => {
    expect(board).toContain('aria-current={isOpen ? "true" : undefined}');
    expect(board).toContain('? "bg-brand-100"');
    expect(board).toContain('"bg-brand-50/60 hover:bg-slate-50"');
  });

  it("el velo del drawer deja ver la tabla", () => {
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain('className="fixed inset-0 z-30 flex justify-end bg-slate-900/20"');
    expect(drawer).not.toContain("bg-slate-900/40 backdrop-blur-[1px]");
  });
});
