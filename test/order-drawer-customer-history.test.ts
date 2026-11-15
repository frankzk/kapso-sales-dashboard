import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// «Historial del cliente» en la pestaña Información (owner, 13-11-2026; MOM §8.1).
const drawer = readFileSync("components/order-drawer.tsx", "utf8");
const actions = readFileSync("app/dashboard/pedidos/actions.ts", "utf8");
const mom = readFileSync("docs/mom/master-pedidos-v1.md", "utf8");

describe("Historial del cliente en Información", () => {
  it("la pestaña Información monta la sección, debajo de «Pedido y cliente» y antes de Ubicación", () => {
    const panel = drawer.slice(drawer.indexOf('id="pedido-panel-informacion"'), drawer.indexOf('id="pedido-panel-actividad"'));
    const cliente = panel.indexOf('data-drawer-section="cliente"');
    const historial = panel.indexOf("<CustomerHistorySection");
    const ubicacion = panel.indexOf('data-drawer-section="ubicacion"');
    expect(cliente).toBeGreaterThan(-1);
    expect(historial).toBeGreaterThan(cliente);
    expect(ubicacion).toBeGreaterThan(historial);
    expect(panel).toContain('visible={workspace === "informacion"}');
  });

  it("lee con su propia acción (sin la consulta de duplicados de Aliclik) y reusa «Antes de llamar»", () => {
    expect(actions).toContain("export async function loadCustomerHistory(");
    const body = actions.slice(actions.indexOf("export async function loadCustomerHistory("));
    expect(body.slice(0, body.indexOf("\n}\n"))).not.toContain("loadAliclikDuplicateHold");
    expect(drawer).toContain("preloaded={brief}");
  });

  it("dice «Primer pedido» y distingue el pedido sin teléfono", () => {
    expect(drawer).toContain('<Badge tone="info">Primer pedido</Badge>');
    expect(drawer).toContain("El pedido no tiene teléfono");
  });

  it("el número de cada pedido del historial abre su ficha", () => {
    const row = drawer.slice(drawer.indexOf("function PriorOrderRow("), drawer.indexOf("function CustomerHistorySection("));
    expect(row).toContain("<OrderLink");
  });

  it("el MOM lo documenta en §8.1", () => {
    expect(mom).toContain("También en «Información», en cualquier etapa (13-11-2026");
  });
});
