import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { etiquetaDiceTerminoSinEntregar } from "@/lib/aliclik-status";

/**
 * Un pedido cerrado porque la entrega FALLÓ sí merece otra salida.
 *
 * EL CASO REAL. Una devolución de Aliclik deja el pedido en `devuelto`, que es
 * terminal, y `createManualRouteOutput` respondía «El pedido está cerrado.
 * Reábrelo antes de crear otra salida». Con stock ya puesto en provincia, no
 * había forma de emitir la Swayp que lo aprovechara — y eso contradice al MOM
 * §11, que nombra «guía cancelada por courier y devolución» como entrada
 * elegible a Reproprovincia, y a su sección de Swayp: «una salida Swayp puede
 * coexistir con la devolución Aliclik».
 *
 * Medido: 844 guías cerradas así, sobre 842 pedidos. 456 con 15 días o menos.
 */

const ACTIONS = "app/dashboard/pedidos/actions.ts";
const read = () => readFileSync(resolve(process.cwd(), ACTIONS), "utf8");

describe("qué etiqueta de Aliclik reabre la puerta", () => {
  it("la devolución y la cancelación del courier, que es lo que dice el MOM", () => {
    expect(etiquetaDiceTerminoSinEntregar("CANCEL · RETURNED · CONFIRMED")).toBe(true);
    expect(etiquetaDiceTerminoSinEntregar("NOT_RESPOND · LEFT_IN_WAREHOUSE · CONFIRMED")).toBe(true);
    expect(etiquetaDiceTerminoSinEntregar("CANCEL · TO_RETURN · CONFIRMED")).toBe(true);
  });

  it("una entrega lograda NO reabre nada", () => {
    expect(etiquetaDiceTerminoSinEntregar("DELIVERED · PICKED · CONFIRMED")).toBe(false);
  });

  it("y una guía sin etiqueta tampoco", () => {
    // Es el caso de las salidas manuales y las `por_definir`: sin etiqueta de
    // Aliclik no hay nada que acredite un intento fallido, y el guarda original
    // tiene que seguir protegiéndolas.
    expect(etiquetaDiceTerminoSinEntregar(null)).toBe(false);
    expect(etiquetaDiceTerminoSinEntregar("")).toBe(false);
  });
});

describe("el guarda distingue POR QUÉ se cerró, no si está cerrado", () => {
  it("sigue bloqueando un pedido cerrado sin entrega fallida", () => {
    // Quitar el guarda entero habría dejado crear salidas sobre pedidos
    // entregados o anulados por decisión. Lo que se añade es la excepción.
    const body = read();
    expect(body).toContain("isTerminalGeneral(ctx.row.general_status) && !cerradoPorEntregaFallida");
    expect(body).toContain("El pedido está cerrado. Reábrelo antes de crear otra salida.");
  });

  it("la excepción se decide con la etiqueta de la guía, no con el estado del pedido", () => {
    // `anulado` cubre tanto «lo canceló el courier» como «lo cancelamos
    // nosotros». Mirar el estado del pedido confundiría las dos y dejaría
    // reabrir cancelaciones deliberadas.
    const body = read();
    expect(body).toContain("etiquetaDiceTerminoSinEntregar(o.reported_status)");
    expect(body).not.toContain('general_status === "devuelto"');
  });

  it("las salidas se leen ANTES del guarda, o no habría con qué decidir", () => {
    const body = read();
    const start = body.indexOf("export async function createManualRouteOutput(");
    const fn = body.slice(start, body.indexOf("\nexport ", start + 10));
    expect(fn.indexOf("reported_status")).toBeLessThan(fn.indexOf("Reábrelo antes de crear otra salida"));
  });
});
