// Los dos paneles de pago de la ficha se avisan (lib/payment-panel-sync.ts).
// El caso (10-10-2026): registrar la diferencia en «Cobro» no encendía
// «Mostrar clave» en «Salidas y guías» hasta actualizar la página.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { announcePaymentPanelChange, subscribePaymentPanelChange } from "@/lib/payment-panel-sync";

describe("el aviso entre paneles de pago", () => {
  it("el otro panel del mismo pedido se entera y recarga", () => {
    const bus = new EventTarget();
    const credencial = vi.fn();
    subscribePaymentPanelChange("pedido-1", "credencial", credencial, bus);
    announcePaymentPanelChange("pedido-1", "cobro", bus);
    expect(credencial).toHaveBeenCalledTimes(1);
  });

  it("quien avisa no se recarga dos veces: ya lo hizo antes de avisar", () => {
    const bus = new EventTarget();
    const cobro = vi.fn();
    subscribePaymentPanelChange("pedido-1", "cobro", cobro, bus);
    announcePaymentPanelChange("pedido-1", "cobro", bus);
    expect(cobro).not.toHaveBeenCalled();
  });

  it("el panel de otro pedido no se toca", () => {
    const bus = new EventTarget();
    const otro = vi.fn();
    subscribePaymentPanelChange("pedido-2", "credencial", otro, bus);
    announcePaymentPanelChange("pedido-1", "cobro", bus);
    expect(otro).not.toHaveBeenCalled();
  });

  it("al desmontarse deja de escuchar", () => {
    const bus = new EventTarget();
    const credencial = vi.fn();
    const stop = subscribePaymentPanelChange("pedido-1", "credencial", credencial, bus);
    stop();
    announcePaymentPanelChange("pedido-1", "cobro", bus);
    expect(credencial).not.toHaveBeenCalled();
  });

  it("sin navegador (render en el servidor) no hace nada ni lanza", () => {
    expect(() => announcePaymentPanelChange("pedido-1", "cobro", null)).not.toThrow();
    expect(() => subscribePaymentPanelChange("pedido-1", "cobro", () => {}, null)()).not.toThrow();
  });

  it("los dos paneles de la ficha avisan tras registrar, validar o cambiar la clave", () => {
    const src = readFileSync(resolve(process.cwd(), "components/pickup-key-panel.tsx"), "utf8");
    // El hook compartido escucha y avisa…
    expect(src).toContain("subscribePaymentPanelChange(orderId, source");
    expect(src).toContain("announcePaymentPanelChange(orderId, source)");
    // …y ninguna acción vuelve a recargar solo su propio panel.
    expect(src).not.toMatch(/await reload\(\);\s*onChanged\(\);/);
    expect(src).not.toMatch(/void reload\(\);\s*onChanged\(\);/);
    expect(src.match(/changed\(\);\s*onChanged\(\);/g)).toHaveLength(3);
  });
});
