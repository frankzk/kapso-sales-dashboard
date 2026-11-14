// @vitest-environment happy-dom
//
// Compras (MOM §45.1): «Quitar» pide un segundo paso en la misma fila, sin
// diálogos del navegador, y los archivos se eligen con un botón en castellano
// («Elegir archivos» / «Ningún archivo») que deja el input nativo para el
// teclado y el lector de pantalla. Montado de verdad (React + DOM).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmRemove, removeTriggerProps } from "@/components/compras/confirm-remove";
import { FilePicker, chosenFilesText } from "@/components/compras/file-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const byText = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

/** Una fila como las del detalle: la tarjeta de la sección (tabIndex −1), el botón «Quitar» y la barra. */
function Row({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return createElement(
    "section",
    { tabIndex: -1, "data-testid": "seccion" },
    createElement("button", { type: "button", ...removeTriggerProps("costo-1", open), onClick: () => setOpen((v) => !v) }, "Quitar"),
    open &&
      createElement(ConfirmRemove, {
        id: "costo-1",
        question: "¿Quitar «AFORO FÍSICO»?",
        onCancel: () => setOpen(false),
        onConfirm: () => {
          setOpen(false);
          onConfirm();
        },
      }),
  );
}

describe("«Quitar» con un segundo paso en la fila", () => {
  it("el primer clic solo pregunta; el foco va a «No»", () => {
    const onConfirm = vi.fn();
    act(() => root.render(createElement(Row, { onConfirm })));
    const trigger = byText("Quitar")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    act(() => trigger.click());
    expect(onConfirm).not.toHaveBeenCalled();
    const group = host.querySelector('[role="group"]')!;
    expect(group.textContent).toContain("¿Quitar «AFORO FÍSICO»?");
    expect(byText("Sí, quitar")).toBeTruthy();
    expect(document.activeElement).toBe(byText("No"));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(group.id);
    expect(group.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("«No» cierra sin quitar y devuelve el foco al botón de la fila", async () => {
    const onConfirm = vi.fn();
    act(() => root.render(createElement(Row, { onConfirm })));
    act(() => byText("Quitar")!.click());
    act(() => byText("No")!.click());
    await act(frame);
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byText("Quitar"));
  });

  it("Escape también cierra sin quitar", async () => {
    const onConfirm = vi.fn();
    act(() => root.render(createElement(Row, { onConfirm })));
    act(() => byText("Quitar")!.click());
    act(() => {
      byText("No")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(frame);
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byText("Quitar"));
  });

  it("«Sí, quitar» quita una vez y deja el foco en la tarjeta de la sección", () => {
    const onConfirm = vi.fn();
    act(() => root.render(createElement(Row, { onConfirm })));
    act(() => byText("Quitar")!.click());
    act(() => byText("Sí, quitar")!.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(host.querySelector('[data-testid="seccion"]'));
  });

  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("Compras no usa diálogos del navegador", () => {
    for (const f of ["components/compras/import-detail.tsx", "components/compras/suppliers.tsx"]) {
      expect(read(f)).not.toMatch(/window\.confirm|\bconfirm\(|window\.alert|window\.prompt/);
    }
  });

  it("producto, foto, costo, pago, documento y entrega se quitan solo desde «Sí, quitar»", () => {
    const ui = read("components/compras/import-detail.tsx");
    for (const call of [
      "removeImportItem(it.id)",
      "setImportItemPhoto(it.id, null)",
      "removeImportCost(c.id)",
      "removeImportPayment(p.id)",
      "removeImportDocument(d.id)",
      "removeDelivery(d.id)",
    ]) {
      const at = ui.indexOf(`run(() => ${call})`);
      expect(at, call).toBeGreaterThan(-1);
      expect(ui.indexOf(`run(() => ${call})`, at + 1), `${call} una sola vez`).toBe(-1);
      // La llamada vive dentro del `onConfirm` de un `ConfirmRemove`.
      const before = ui.slice(Math.max(0, at - 700), at);
      expect(before.lastIndexOf("<ConfirmRemove"), call).toBeGreaterThan(-1);
      expect(before.lastIndexOf("onConfirm"), call).toBeGreaterThan(before.lastIndexOf("<ConfirmRemove"));
    }
  });
});

describe("elegir archivos en castellano", () => {
  function Picker({ multiple = false, max, onFiles }: { multiple?: boolean; max?: number; onFiles?: (f: File[]) => void }) {
    const [files, setFiles] = useState<File[]>([]);
    return createElement(FilePicker, {
      label: "Archivos",
      hint: "Hasta 10 por vez.",
      multiple,
      max,
      files,
      onFiles: (f: File[]) => {
        setFiles(f);
        onFiles?.(f);
      },
    });
  }

  it("el texto: «Ningún archivo», el nombre, o cuántos y cuáles", () => {
    expect(chosenFilesText([])).toBe("Ningún archivo");
    expect(chosenFilesText(["factura.pdf"])).toBe("factura.pdf");
    expect(chosenFilesText(["a.jpg", "b.jpg"])).toBe("2 archivos: a.jpg, b.jpg");
  });

  it("un botón «Elegir archivos» ligado al input nativo, oculto pero en el tabulador", () => {
    act(() => root.render(createElement(Picker, { multiple: true })));
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.className).toContain("sr-only");
    expect(input.tabIndex).not.toBe(-1);
    expect(input.multiple).toBe(true);
    const label = host.querySelector(`label[for="${input.id}"]`)!;
    expect(label.textContent).toContain("Elegir archivos");
    // El nombre accesible: la etiqueta del campo y el texto del botón; la descripción, lo elegido.
    const [fieldId, buttonId] = input.getAttribute("aria-labelledby")!.split(" ");
    expect(document.getElementById(fieldId!)?.textContent).toBe("Archivos");
    expect(document.getElementById(buttonId!)?.textContent).toBe("Elegir archivos");
    const [statusId, hintId] = input.getAttribute("aria-describedby")!.split(" ");
    expect(document.getElementById(statusId!)?.textContent).toBe("Ningún archivo");
    expect(document.getElementById(hintId!)?.textContent).toBe("Hasta 10 por vez.");
    expect(host.textContent).not.toMatch(/Choose|No file chosen/);
  });

  it("uno solo dice «Elegir archivo»", () => {
    act(() => root.render(createElement(Picker, {})));
    expect(host.textContent).toContain("Elegir archivo");
    expect(host.textContent).not.toContain("Elegir archivos");
  });

  it("al elegir, muestra los nombres y respeta el tope", () => {
    const onFiles = vi.fn();
    act(() => root.render(createElement(Picker, { multiple: true, max: 2, onFiles })));
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const picked = [new File(["x"], "uno.jpg"), new File(["y"], "dos.jpg"), new File(["z"], "tres.jpg")];
    Object.defineProperty(input, "files", { value: picked, configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]![0].map((f: File) => f.name)).toEqual(["uno.jpg", "dos.jpg"]);
    expect(host.textContent).toContain("2 archivos: uno.jpg, dos.jpg");
  });

  it("cada subida de Compras usa el selector en castellano (sin el input nativo a la vista)", () => {
    const ui = readFileSync(resolve(process.cwd(), "components/compras/import-detail.tsx"), "utf8");
    // Documentos, fotos de la entrega, comprobante del pago y foto del producto nuevo.
    expect((ui.match(/<FilePicker\b/g) ?? []).length).toBe(4);
    // Los dos `type="file"` que quedan son los botones de texto ya en castellano («Foto / Cambiar»,
    // «Agregar fotos»), con el input oculto dentro de su etiqueta.
    const natives = [...ui.matchAll(/type="file"[\s\S]{0,200}?className="([^"]*)"/g)].map((m) => m[1]);
    expect(natives.length).toBe(2);
    for (const c of natives) expect(c).toContain("sr-only");
    expect(ui).not.toContain("file:mr-3");
  });
});
