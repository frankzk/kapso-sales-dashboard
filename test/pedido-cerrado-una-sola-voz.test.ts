import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REOPEN_HINT, terminalOrderBlocker } from "@/lib/order-status";
import { routeDeskGate } from "@/lib/order-route-plan";

/**
 * Un pedido cerrado se dice igual en todas las pantallas.
 *
 * #AUR176830: la mesa de ruta solo se apagaba con la macroetapa en `finalizado`,
 * así que con el expediente reabierto y el pedido todavía `anulado` pintaba
 * «Crear en Tanders» en negro y recomendado. La negativa salía recién dentro del
 * modal, y mandaba a un panel llamado «Estado del pedido» que no existe.
 */

describe("terminalOrderBlocker: el hecho y el sitio donde se arregla", () => {
  it("un pedido vivo no tiene nada que decir", () => {
    expect(terminalOrderBlocker("pendiente")).toBeNull();
    expect(terminalOrderBlocker("en_proceso")).toBeNull();
    expect(terminalOrderBlocker("")).toBeNull();
  });

  it("los tres estados terminales sí, y todos nombran dónde se reabre", () => {
    for (const estado of ["entregado", "anulado", "devuelto"]) {
      const aviso = terminalOrderBlocker(estado);
      expect(aviso).toBeTruthy();
      expect(aviso!.toLowerCase()).toContain("gestión manual → registrar estado");
    }
  });

  it("ya no manda a «Estado del pedido», que no existe con ese nombre", () => {
    for (const estado of ["entregado", "anulado", "devuelto"]) {
      expect(terminalOrderBlocker(estado)).not.toContain("Estado del pedido");
    }
  });

  it("al anulado se le dice antes que quizá no haya nada que corregir", () => {
    // El caso más probable es que quien lo lee acabe de anular la salida para
    // cambiar de courier: ese estado se recalcula solo.
    const aviso = terminalOrderBlocker("anulado")!;
    expect(aviso).toContain("se recalcula solo");
    expect(aviso).toContain("cambiar de courier");
  });

  it("los otros dos usan la etiqueta del estado, no el código crudo", () => {
    expect(terminalOrderBlocker("entregado")).toContain("El pedido está entregado.");
    expect(terminalOrderBlocker("devuelto")).toContain("El pedido está devuelto.");
  });
});

describe("routeDeskGate: las dos puertas son independientes", () => {
  it("el pedido de #AUR176830 — expediente reabierto, estado todavía anulado", () => {
    const { blockers } = routeDeskGate({ macroStage: "por_cerrar", generalStatus: "anulado" });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.text).toContain("Gestión manual");
    // Y el que NO aplica no se inventa.
    expect(blockers[0]!.text).not.toContain("Mesa de cierre");
  });

  it("expediente finalizado con el pedido entregado: se dicen las dos", () => {
    const { blockers } = routeDeskGate({ macroStage: "finalizado", generalStatus: "entregado" });
    expect(blockers).toHaveLength(2);
    expect(blockers[0]!.text).toContain("Mesa de cierre");
    expect(blockers[1]!.text).toContain("Gestión manual");
  });

  it("finalizado con el pedido vivo: solo la del expediente", () => {
    const { blockers } = routeDeskGate({ macroStage: "finalizado", generalStatus: "en_proceso" });
    expect(blockers).toEqual([
      {
        text: "El expediente está finalizado. Reábrelo en la Mesa de cierre antes de crear una salida.",
        target: "cierre",
        cta: "Ir a la Mesa de cierre ↓",
      },
    ]);
  });

  /**
   * NOMBRAR EL PANEL NO BASTÓ. #AUR176830 se quedó dos rondas sin encontrarlo
   * con la instrucción delante: los dos sitios viven al fondo de la pestaña
   * Operar, detrás de «Salidas y guías», y quien lee el aviso está arriba.
   */
  it("cada motivo lleva su atajo, y cada uno al panel que le toca", () => {
    const cerrado = routeDeskGate({ macroStage: "finalizado", generalStatus: "anulado" });
    expect(cerrado.blockers.map((b) => b.target)).toEqual(["cierre", "acciones"]);
    for (const blocker of cerrado.blockers) {
      expect(blocker.cta).toBeTruthy();
    }
  });

  it("un pedido operable no bloquea nada", () => {
    expect(routeDeskGate({ macroStage: "en_curso", generalStatus: "en_proceso" })).toEqual({
      blockers: [],
      blockedActions: [],
    });
    expect(routeDeskGate({})).toEqual({ blockers: [], blockedActions: [] });
  });
});

describe("se apaga por modalidad, no por pedido entero", () => {
  it("con el pedido anulado: Tanders y Shalom se niegan siempre, Aliclik y Swayp no miran", () => {
    const { blockedActions } = routeDeskGate({ macroStage: "por_cerrar", generalStatus: "anulado" });
    expect(blockedActions).toContain("tanders");
    expect(blockedActions).toContain("shalom");
    expect(blockedActions).not.toContain("aliclik");
    expect(blockedActions).not.toContain("swayp");
  });

  /**
   * LA EXCEPCIÓN QUE NO SE PUEDE APAGAR. El MOM §11 admite «guía cancelada por
   * courier y devolución» como entrada a Reproprovincia, y `createManualRouteOutput`
   * la respeta: son 844 guías sobre 842 pedidos. Un interruptor único por estado
   * terminal les habría apagado el botón a todas.
   */
  it("la salida manual sigue disponible si el pedido se cerró por una entrega fallida", () => {
    const cerradoNormal = routeDeskGate({ generalStatus: "devuelto" });
    expect(cerradoNormal.blockedActions).toContain("manual");

    const entregaFallida = routeDeskGate({
      generalStatus: "devuelto",
      closedByFailedDelivery: true,
    });
    expect(entregaFallida.blockedActions).not.toContain("manual");
    // Pero el aviso se sigue contando: el hecho es cierto aunque el botón siga.
    expect(entregaFallida.blockers).toHaveLength(1);
  });

  it("el expediente finalizado sí las apaga todas: el cierre no admite salidas activas", () => {
    const { blockedActions } = routeDeskGate({
      macroStage: "finalizado",
      generalStatus: "en_proceso",
      closedByFailedDelivery: true,
    });
    expect([...blockedActions].sort()).toEqual([
      "aliclik",
      "manual",
      "shalom",
      "swayp",
      "tanders",
    ]);
  });
});

describe("las tres pantallas usan la misma frase", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("Tanders y Shalom la piden en vez de escribir la suya", () => {
    for (const file of [
      "app/dashboard/pedidos/tanders-actions.ts",
      "app/dashboard/pedidos/shalom-actions.ts",
    ]) {
      const src = read(file);
      expect(src).toContain("terminalOrderBlocker(row.general_status)");
      // La lista literal era la que permitía que cada uno dijera otra cosa.
      expect(src).not.toContain('["entregado", "devuelto", "anulado"].includes(row.general_status)');
    }
  });

  it("la mesa de ruta recibe los motivos, ya no un booleano de macroetapa", () => {
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain("gate={detail.routeGate}");
    expect(drawer).not.toContain('closed={detail.row.macro_stage === "finalizado"}');
  });

  it("y los pinta encima de las tarjetas, no solo en el botón apagado", () => {
    const desk = read("components/order-route-desk.tsx");
    expect(desk).toContain("{blockers.map((blocker) => (");
    expect(desk).toContain("const closed = blockedActions.has(route.action);");
  });

  it("la excepción de la entrega fallida se lee de la etiqueta del courier", () => {
    const access = read("lib/orders-master-access.ts");
    expect(access).toContain("etiquetaDiceTerminoSinEntregar(guide.reported_status)");
    // Y la columna que hace falta llega de verdad.
    expect(access).toContain("reported_status,");
  });

  it("el sitio se nombra una sola vez en todo el código", () => {
    expect(REOPEN_HINT).toContain("Gestión manual → Registrar estado");
    expect(REOPEN_HINT).toContain("Operar");
  });
});
