import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEAD_CALL_MAX_BEFORE_MS,
  LEAD_CALL_NO_ORDER,
  leadCallOrderId,
  leadCallsForOrder,
  type CustomerOrderRef,
} from "@/lib/lead-calls-by-order";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

// El caso real: un lead (51989995354) con dos pedidos. #KP134581 se cerró desde
// Leads el 15-09; #KP141951 llegó por el chatbot el 16-10 y el lead pasó a
// apuntarle. La Actividad de #KP141951 mostraba la guía de #KP134581.
const SEPT: CustomerOrderRef = { order_id: "sept", order_name: "#KP134581", order_created_at: "2026-09-15T22:44:47Z" };
const OCT: CustomerOrderRef = { order_id: "oct", order_name: "#KP141951", order_created_at: "2026-10-16T12:31:50Z" };
const ORDERS = [OCT, SEPT];

const call = (occurred_at: string, note: string | null = null) => ({ occurred_at, note });

const HISTORY = [
  call("2026-09-14T14:23:51Z", "recuerda que para Juliaca contamos contraentrega"),
  call("2026-09-15T22:41:05Z"),
  call("2026-09-15T22:44:48Z", "Carrito recuperado · pedido generado en Shopify · PEN 149.00 · contraentrega"),
  call("2026-09-15T22:45:40Z", "Guía de Aliclik creada · AUR5X901350223182 · pedido #KP134581 · cobrar S/ 149.00"),
  call("2026-10-16T14:56:12Z", "Guía de Aliclik creada · AUR5X314718099724 · pedido #KP141951 · cobrar S/ 297.00"),
];

describe("cada gestión del lead es de un solo pedido", () => {
  it("#KP141951 ya no muestra el ciclo de septiembre", () => {
    const own = leadCallsForOrder(HISTORY, ORDERS, "oct");
    expect(own.map((c) => c.note)).toEqual([
      "Guía de Aliclik creada · AUR5X314718099724 · pedido #KP141951 · cobrar S/ 297.00",
    ]);
  });

  it("y #KP134581 recupera el suyo, con la venta y su guía", () => {
    const own = leadCallsForOrder(HISTORY, ORDERS, "sept");
    expect(own).toHaveLength(4);
    expect(own.map((c) => c.note)).toContain(
      "Guía de Aliclik creada · AUR5X901350223182 · pedido #KP134581 · cobrar S/ 149.00",
    );
  });

  it("la nota que nombra un pedido manda sobre la fecha", () => {
    // Una nota de octubre que habla del pedido de septiembre es de septiembre.
    expect(leadCallOrderId(call("2026-10-20T10:00:00Z", "reclamo por pedido #kp134581"), ORDERS)).toBe("sept");
  });

  it("el trabajo de venta es del pedido que cerró, con margen para la nota de la venta", () => {
    expect(leadCallOrderId(call("2026-10-10T10:00:00Z"), ORDERS)).toBe("oct");
    expect(leadCallOrderId(call("2026-09-15T22:50:00Z"), ORDERS)).toBe("sept");
  });

  it("lo que pasó después del último pedido es del último", () => {
    expect(leadCallOrderId(call("2026-10-20T10:00:00Z"), ORDERS)).toBe("oct");
  });

  it("con un solo pedido, todo es suyo: nada cambia para quien compró una vez", () => {
    expect(leadCallsForOrder(HISTORY, [SEPT], "sept")).toHaveLength(HISTORY.length);
  });

  it("una gestión de más de 14 días antes del pedido no es suya (#AUR900004, 24-10-2026)", () => {
    expect(LEAD_CALL_MAX_BEFORE_MS).toBe(14 * 24 * 60 * 60_000);
    // El caso: dos «Handoff resuelto» de septiembre en el número del owner, y su
    // primer pedido de Aurela el 24-10.
    const AUR: CustomerOrderRef = { order_id: "aur", order_name: "#AUR900004", order_created_at: "2026-10-24T17:35:49Z" };
    const viejos = [
      call("2026-09-06T01:06:00Z", "✅ Handoff resuelto (sacado de Atender ahora)"),
      call("2026-09-28T15:22:00Z", "✅ Handoff resuelto (sacado de Atender ahora)"),
    ];
    for (const c of viejos) expect(leadCallOrderId(c, [AUR])).toBe(LEAD_CALL_NO_ORDER);
    expect(leadCallsForOrder(viejos, [AUR], "aur")).toEqual([]);
    // Dentro de los 14 días sigue siendo el trabajo de esa venta.
    expect(leadCallOrderId(call("2026-10-11T18:00:00Z"), [AUR])).toBe("aur");
    // Y la nota que nombra el pedido manda aunque sea vieja.
    expect(leadCallOrderId(call("2026-09-01T10:00:00Z", "reservado para pedido #AUR900004"), [AUR])).toBe("aur");
    // Lo posterior al pedido sigue siendo suyo, sin tope.
    expect(leadCallOrderId(call("2026-12-24T10:00:00Z"), [AUR])).toBe("aur");
  });

  it("sin fechas de pedido no se esconde nada", () => {
    const sinFecha = [{ ...SEPT, order_created_at: null }];
    expect(leadCallsForOrder(HISTORY, sinFecha, "sept")).toHaveLength(HISTORY.length);
  });
});

describe("el detalle del pedido lo usa", () => {
  const src = read("lib/orders-master-access.ts");

  it("busca los leads de todos los pedidos del cliente y reparte sus gestiones", () => {
    expect(src).toContain('.eq("customer_phone", customerPhone)');
    expect(src).toContain("leadCallsForOrder((data ?? []) as unknown as LeadCallTimelineRow[], customerOrders, orderId)");
  });

  it("el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**El historial del lead se reparte entre los pedidos del cliente (16-10-2026).**");
    expect(mom).toContain("**Una gestión de más de 14 días antes de esa venta no es de ningún pedido (24-10-2026)**");
  });
});
