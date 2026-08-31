import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * El barrido de Aliclik deja constancia en el PEDIDO, no solo en la guía.
 *
 * EL CASO REAL. #KP131561: una venta cerrada por la asesora que Aliclik anuló 33
 * segundos después de que creáramos la guía —`PENDING_DELIVERY · TO_PREPARE ·
 * ANNULLED`, o sea por su LLAMADA, no por el reparto—. La pestaña Actividad
 * mostraba la llamada, la venta y la guía registrada, pero NO que se había
 * anulado. El dato más importante de ese pedido era justo el que faltaba.
 *
 * No era de ese pedido: `applyAliclikSnapshot` no escribía ningún evento, nunca.
 * Shalom llevaba 2.241 `courier_status` y Aliclik 0, siendo la misma información
 * y el mismo courier de contraentrega.
 *
 * Se escanea el fuente: la función habla con Supabase y con la API de Aliclik, y
 * lo que se vigila —que escriba, cuándo, y con qué— es estructural.
 */

const TRACK = "lib/aliclik-track.ts";
const read = () => readFileSync(resolve(process.cwd(), TRACK), "utf8");

function cuerpoDelApply(): string {
  const s = read();
  const start = s.indexOf("export async function applyAliclikSnapshot(");
  expect(start, "no se encontró applyAliclikSnapshot").toBeGreaterThan(0);
  return s.slice(start, s.indexOf("\n/**", start + 10));
}

describe("cada transición deja un evento en el pedido", () => {
  it("escribe un courier_status, como ya hacía Shalom", () => {
    const body = cuerpoDelApply();
    expect(body).toContain('.from("order_events").insert(');
    expect(body).toContain('kind: "courier_status"');
    expect(body).toContain('source: "aliclik"');
    expect(body).toContain('courier: "aliclik"');
  });

  it("SOLO cuando el estado cambia de verdad", () => {
    // El barrido relee las mismas guías cada pocos minutos. Sin esta condición
    // el historial se llenaría de líneas idénticas, que es la otra forma de
    // perder la información.
    const body = cuerpoDelApply();
    expect(body).toContain("if (shipment.order_id && next !== shipment.delivery_status) {");
  });

  it("y solo si la guía está vinculada a un pedido", () => {
    // Una guía huérfana no tiene historial donde escribir; el insert fallaría
    // por `order_id` nulo y se llevaría por delante el resto de la pasada.
    expect(cuerpoDelApply()).toContain("shipment.order_id &&");
  });

  it("guarda el estado ANTERIOR, no solo el nuevo", () => {
    // Sin él, el historial dice «anulado» pero no de dónde venía, y no se puede
    // distinguir una anulación desde pendiente de una desde en_ruta.
    expect(cuerpoDelApply()).toContain("previous_status: shipment.delivery_status");
  });

  it("la nota lleva la etiqueta CRUDA de Aliclik, donde vive el motivo", () => {
    // «anulado» a secas no dice quién ni por qué. `ANNULLED` en el tercer campo
    // dice que fue su LLAMADA y no su reparto — que es toda la diferencia entre
    // «el paquete volvió» y «nos cancelaron la venta antes de salir».
    const body = cuerpoDelApply();
    expect(body).toContain("aliclikStatusLabel(order).trim()");
    expect(body).toContain("`Aliclik: ${next}${etiqueta ? ` · ${etiqueta}` : \"\"}.`");
  });

  it("se fecha con el reloj de Aliclik, no con el nuestro", () => {
    // `updatedAt` es cuándo pasó de verdad; `nowIso` es cuándo nos enteramos.
    // Fechar con el segundo mete el retraso del barrido dentro del historial.
    expect(cuerpoDelApply()).toContain("occurred_at: updatedAt ?? nowIso");
  });

  it("va DESPUÉS de que la escritura de la guía haya salido bien", () => {
    // Un evento que anuncia un cambio que no se llegó a escribir es peor que no
    // tenerlo: el historial diría una cosa y la guía otra.
    const body = cuerpoDelApply();
    expect(body.indexOf("if (upErr) return")).toBeLessThan(body.indexOf('kind: "courier_status"'));
  });
});
