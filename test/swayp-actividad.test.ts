import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { swaypStatusEvent, type SwaypShipmentRow } from "@/lib/swayp-ingest";

/**
 * #KP140633 (13-10-2026): Swayp lo entregó, «Salidas y guías» decía Entregado y
 * la pestaña Actividad no tenía ni una línea. Ahora cada transición de Swayp
 * deja un `courier_status` en el pedido, como Aliclik y Shalom.
 */

const NOW = "2026-10-12T21:40:05.722Z";
const guia: SwaypShipmentRow = {
  id: "sh-1",
  order_id: "o-1",
  store_id: "st-1",
  guide_code: "50000149641",
  delivery_status: "en_ruta",
  swayp_state: 5,
  dispatched_at: "2026-10-12T13:00:00Z",
};

describe("el hecho de Swayp en el historial del pedido", () => {
  it("la entrega queda con su estado y su guía", () => {
    expect(swaypStatusEvent(guia, { state: 7 }, "entregado", NOW)).toMatchObject({
      kind: "courier_status",
      source: "fenix",
      courier: "fenix",
      guide_code: "50000149641",
      shipment_id: "sh-1",
      previous_status: "en_ruta",
      new_status: "entregado",
      occurred_at: NOW,
      note: "Swayp: Entregada (7).",
    });
  });

  it("la novedad va en la nota, y la hora es la de Swayp si la da", () => {
    const ev = swaypStatusEvent(
      guia,
      { state: 8, novelty: "Swayp · Destinatario no contesta (7)", changedAt: "2026-10-12T20:00:00Z" },
      "en_ruta",
      NOW,
    );
    expect(ev?.note).toBe("Swayp: Devolución (8) · Destinatario no contesta (7).");
    expect(ev?.occurred_at).toBe("2026-10-12T20:00:00Z");
  });

  it("un 10 sobre una guía que ya salió se registra como el fin de su devolución (9)", () => {
    expect(swaypStatusEvent(guia, { state: 10 }, "anulado", NOW)?.note).toBe("Swayp: Devolución confirmada (9).");
  });

  it("sin pedido no hay a quién contárselo", () => {
    expect(swaypStatusEvent({ ...guia, order_id: null }, { state: 7 }, "entregado", NOW)).toBeNull();
  });

  it("solo se escribe cuando algo cambió, no en cada lectura del barrido", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/swayp-ingest.ts"), "utf8");
    expect(src).toContain("if (changed) {\n    const evento = swaypStatusEvent(row, incoming, deliveryStatus, nowIso);");
    expect(src).toContain('"id,order_id,store_id,guide_code,delivery_status,');
  });

  it("la Actividad lo nombra en castellano, y también al envío desde Por confirmar", () => {
    // Se lee el texto: importar el componente arrastra acciones de servidor.
    const ui = readFileSync(resolve(process.cwd(), "components/order-master-shared.tsx"), "utf8");
    expect(ui).toContain('courier_status: "Estado informado por el courier",');
    expect(ui).toContain('swayp_desde_por_confirmar: "Enviado por Swayp desde Por confirmar",');
  });
});
