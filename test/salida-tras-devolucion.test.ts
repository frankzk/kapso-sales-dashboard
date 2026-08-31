import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { etiquetaDiceTerminoSinEntregar } from "@/lib/aliclik-status";
import { esPorRecuperar } from "@/lib/shipments";

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

/**
 * La otra mitad: que esos pedidos APAREZCAN en la cola.
 *
 * Desbloquear la salida no sirve de nada si nadie los ve. Van a la MISMA cola
 * —Pendiente— y no a una pestaña propia: el MOM §11 lista las cinco entradas
 * juntas como entradas a una sola cola, y un balde más es un balde que nadie
 * mira. El chip «Por recuperar» las acota dentro.
 */
const ACCESS = "lib/shipments-access.ts";
const BOARD = "components/shipments.tsx";
const src = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

describe("las cerradas por recuperar entran a la cola de Pendiente", () => {
  it("el chip reconoce una guía cerrada sin entregar", () => {
    expect(esPorRecuperar({ status_category: "closed", reported_status: "CANCEL · RETURNED · CONFIRMED" })).toBe(true);
    expect(esPorRecuperar({ status_category: "closed", reported_status: "CANCEL · TO_RETURN · CONFIRMED" })).toBe(true);
  });

  it("una guía ABIERTA no es «por recuperar»", () => {
    // Ya está en la cola por su propio estado; marcarla acá la contaría dos veces
    // como si fuera un rescate, que es otro trabajo.
    expect(esPorRecuperar({ status_category: "pending", reported_status: "CANCEL · RETURNED · CONFIRMED" })).toBe(false);
    expect(esPorRecuperar({ status_category: "in_route", reported_status: "REFUSED · PICKED · CONFIRMED" })).toBe(false);
  });

  it("ni una cerrada por entrega lograda o sin etiqueta", () => {
    expect(esPorRecuperar({ status_category: "closed", reported_status: "DELIVERED · PICKED · CONFIRMED" })).toBe(false);
    expect(esPorRecuperar({ status_category: "closed", reported_status: null })).toBe(false);
    expect(esPorRecuperar({})).toBe(false);
  });

  it("la lista y el contador salen de la MISMA función", () => {
    // Es el fallo que este repo repite: dos caminos para el número y las filas,
    // y el chip acaba diciendo una cosa y la tabla otra. Acá el conteo no puede
    // ser un `head:true` porque el predicado se aplica en memoria, así que la
    // única forma de que coincidan es que sea la misma llamada.
    const s = src(ACCESS);
    expect((s.match(/guiasPorRecuperar\(/g) ?? []).length).toBeGreaterThanOrEqual(3); // def + lista + contador
    expect(s).toContain("return pendientes + recuperables.length;");
  });

  it("solo se anexan en la cola de reprogramación, no en las demás pestañas", () => {
    // Anulado y Entregado son el REGISTRO de lo que pasó: meter ahí las mismas
    // filas otra vez sería duplicarlas, no recuperarlas.
    const s = src(ACCESS);
    const start = s.indexOf("export async function getStoreShipments(");
    const fn = s.slice(start, s.indexOf("\n}", start));
    expect(fn).toContain("if (esColaDeReprogramacion(cats)) {");
    expect(fn).toContain("guiasPorRecuperar(sb, storeIds, SHIPMENT_LIST_COLUMNS)");
  });

  it("la consulta está ACOTADA por ventana: no crece sin fin", () => {
    // Sin ventana, el conjunto sería «todas las cerradas de Aliclik de la
    // historia» y algún día no cabría en una página. Se reusa la ventana que ya
    // documenta la pantalla de recuperación en vez de inventar otra constante.
    const s = src(ACCESS);
    expect(s).toContain("RECOVERY_DEFAULT_MAX_DAYS * 2");
    expect(s).toContain('.eq("status_category", "closed")');
    expect(s).toContain('.eq("courier", "aliclik")');
  });

  it("el chip va en Pendiente, no en una pestaña nueva", () => {
    const s = src(BOARD);
    expect(s).toContain("Por recuperar");
    expect(s).toContain("(!soloPorRecuperar || esPorRecuperar(s))");
    // Si apareciera una vista nueva, sería la pestaña que decidimos NO hacer.
    expect(src(ACCESS)).not.toContain('"por_recuperar"');
  });
});
