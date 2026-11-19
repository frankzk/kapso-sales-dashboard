// @vitest-environment happy-dom
import { createElement, act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LimaBlockDetails } from "@/components/lima-block-details";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => { document.body.innerHTML = ""; });

describe("selección del detalle operativo", () => {
  it("filtra al tocar una cifra, la marca elegida y permite volver a todo el bloque", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Preview() {
      const [selected, setSelected] = useState<string | null>(null);
      return createElement("div", null,
        createElement(LimaBlockDetails, { label: "Programados", total: 2, active: selected, onPick: setSelected,
          groups: [{ title: "Guías", items: [{ key: "guide", label: "Con guía vigente", count: 1 }, { key: "none", label: "Sin datos", count: 0 }] }] }),
        createElement("output", null, selected ? "1 pedido" : "2 pedidos"));
    }
    try {
      await act(async () => { root.render(createElement(Preview)); });
      const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Con guía vigente"))!;
      const all = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Todos los del bloque"))!;
      await act(async () => { button.click(); });
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelector("output")?.textContent).toBe("1 pedido");
      await act(async () => { button.click(); });
      expect(container.querySelector("output")?.textContent).toBe("2 pedidos");
      await act(async () => { button.click(); all.click(); });
      expect(all.getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelector("output")?.textContent).toBe("2 pedidos");
      expect([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Sin datos"))?.disabled).toBe(true);
    } finally { await act(async () => { root.unmount(); }); }
  });
});
