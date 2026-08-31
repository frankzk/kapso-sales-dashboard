import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

describe("admisión de pedidos de Grupo GF Courier", () => {
  it("impide dos solicitudes activas para el mismo pedido y operador", () => {
    const sql = readFileSync(
      resolve(root, "db/migrations/0138_group_gf_logistics_requests.sql"),
      "utf8",
    );
    expect(sql).toContain("logistics_requests_active_order_uniq");
    expect(sql).toContain("on logistics_requests(provider_id, order_id)");
    expect(sql).toContain("where status <> 'cancelled'");
    expect(sql).toContain("logistics_request_events");
  });

  it("toma pedidos desde la bandeja y no desde el modal manual del pedido", () => {
    const courier = readFileSync(resolve(root, "components/grupo-gf-courier.tsx"), "utf8");
    const master = readFileSync(resolve(root, "components/orders-master.tsx"), "utf8");
    expect(courier).toContain("Pedidos disponibles");
    expect(courier).toContain("takeGroupGfCourierOrders");
    expect(courier).toContain("Tomar pedido");
    expect(master).toContain("/dashboard/courier?pedido=");
    expect(master).not.toContain('{ key: "propio", label: "Grupo GF Courier" }');
  });

  it("conserva el QR al rellenar una salida por definir", () => {
    const action = readFileSync(resolve(root, "app/dashboard/courier/actions.ts"), "utf8");
    expect(action).toContain("writeCourierGuide(admin, orderId");
    expect(action).toContain("Se reutilizó la salida existente y su QR.");
    expect(action).toContain("reusedOutput: write.filled");
  });
});

