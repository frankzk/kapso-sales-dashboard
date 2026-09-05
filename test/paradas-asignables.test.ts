import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MACRO_SUBSTAGES_BY_STAGE, SUBETAPAS_ASIGNABLES_A_RUTA } from "@/lib/order-macro-stage";
import { terminoSeguro } from "@/lib/routes-access";

/**
 * Qué pedidos se pueden meter en la ruta de un motorizado, y cómo se encuentran.
 *
 * EL CASO REAL. El coordinador tecleaba `KP131277` en «Añadir paradas nuevas» y
 * la pantalla contestaba «No hay pedidos sin asignar para ese día». El pedido
 * existía, era de Lima, estaba vivo y en `Por despachar · Listo para asignar`.
 *
 * Fallaban dos cosas y hacían falta las DOS para que se viera:
 *
 *   1. La consulta pedía `general_status IN (pendiente, en_proceso)` y nada
 *      más: 7.643 pedidos, de los cuales 4.250 estaban en Preparación —el
 *      atraso de Lima— y no se pueden rutear porque el paquete no existe aún.
 *   2. El tope de 300 recortaba por fecha. #KP131277 era el 422.º más reciente,
 *      así que nunca bajaba; y el buscador filtraba EN MEMORIA sobre lo que
 *      había bajado, de modo que buscarlo era imposible por construcción.
 *
 * Acotar por subetapa deja 1.830, que sigue sin caber en 300. Por eso la
 * búsqueda tiene que ir al servidor: la lista es una muestra, el buscador es
 * quien responde.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const ACCESS = "lib/routes-access.ts";
const PANTALLA = "components/routes.tsx";

describe("qué entra en una ruta", () => {
  it("lo que está armado y esperando", () => {
    expect(SUBETAPAS_ASIGNABLES_A_RUTA).toContain("listo_para_asignar");
  });

  it("lo que se sacó de un manifiesto vuelve al pool", () => {
    // Retirarlo de una ruta con motivo (§6.3) devuelve el paquete al almacén.
    // Si no volviera a ofrecerse, retirarlo sería perderlo.
    expect(SUBETAPAS_ASIGNABLES_A_RUTA).toContain("retirado_del_manifiesto");
  });

  it("y un no entregado de Lima que espera segundo intento", () => {
    // §830. El panel de reintentos lo ofrece cuando hay parada fallida en
    // `delivery_stops`; esto lo cubre también cuando el fallo llegó por estado
    // del courier y no por reporte del motorizado.
    expect(SUBETAPAS_ASIGNABLES_A_RUTA).toContain("por_reprogramar_lima");
  });
});

describe("qué NO entra", () => {
  it("Preparación no se rutea: el paquete todavía no existe", () => {
    // Son 4.255 de los 7.643 que la consulta traía. No es que estorben: es que
    // ocupaban el cupo de 300 y empujaban fuera a los que SÍ se podían rutear.
    for (const substage of MACRO_SUBSTAGES_BY_STAGE.preparacion) {
      expect(SUBETAPAS_ASIGNABLES_A_RUTA, substage).not.toContain(substage);
    }
  });

  it("ni lo que está por confirmar: no hay venta cerrada que repartir", () => {
    for (const substage of MACRO_SUBSTAGES_BY_STAGE.por_confirmar) {
      expect(SUBETAPAS_ASIGNABLES_A_RUTA, substage).not.toContain(substage);
    }
  });

  it("lo que ya va en otra ruta no se ofrece dos veces", () => {
    // Dos motorizados con el mismo paquete es el fallo caro.
    expect(SUBETAPAS_ASIGNABLES_A_RUTA).not.toContain("asignado_a_ruta");
    expect(SUBETAPAS_ASIGNABLES_A_RUTA).not.toContain("en_cotejo");
  });

  it("lo de agencia lo recoge la clienta, no lo lleva un motorizado", () => {
    expect(SUBETAPAS_ASIGNABLES_A_RUTA).not.toContain("listo_para_recojo");
  });

  it("ni nada que ya esté en manos del courier", () => {
    for (const substage of ["en_transito", "en_reparto", "recibido_por_courier"] as const) {
      expect(SUBETAPAS_ASIGNABLES_A_RUTA, substage).not.toContain(substage);
    }
  });
});

describe("el recorte va en la consulta, no después de traer las filas", () => {
  // Es el mismo error que este repo ya cometió en Repro Provincia. Filtrar en
  // memoria con un tope activo significa gastar el cupo en filas que se van a
  // descartar y perder al final las que sí valían.
  const cuerpo = () => {
    const source = read(ACCESS);
    const start = source.indexOf("export async function getAssignableOrders(");
    return source.slice(start, source.indexOf("\n}", start));
  };

  it("la subetapa se filtra en la base", () => {
    expect(cuerpo()).toContain('.in("macro_substage", SUBETAPAS_ASIGNABLES_A_RUTA)');
  });

  it("y sale de la constante del MOM, no de una lista escrita a mano aquí", () => {
    // Escribir los nombres otra vez es cómo se separan la regla y su uso.
    const source = read(ACCESS);
    expect(source).toContain("SUBETAPAS_ASIGNABLES_A_RUTA");
    expect(source).not.toContain('"listo_para_asignar"');
  });

  it("la búsqueda también: si no, solo miraría el recorte", () => {
    expect(cuerpo()).toContain("q.or(");
    expect(cuerpo()).toContain("order_name.ilike");
  });
});

describe("la pantalla le pregunta al servidor", () => {
  it("el buscador llama a searchAssignable", () => {
    // ESTO es lo que arregla el caso. Sin esta llamada, teclear el código de un
    // pedido que quedó fuera de la muestra no encuentra nada, y la pantalla
    // dice «No hay pedidos» cuando lo que pasa es que no bajó.
    const source = read(PANTALLA);
    expect(source).toContain("searchAssignable(route.route_date, termino)");
  });

  it("la acción del servidor consulta el pool entero", () => {
    const source = read("app/dashboard/rutas/actions.ts");
    const start = source.indexOf("export async function searchAssignable(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("getAssignableOrders");
    expect(body).toContain("search: termino");
  });

  it("y la muestra recortada se anuncia como recortada", () => {
    // Una lista que parece completa y no lo es es peor que una lista corta.
    expect(read(PANTALLA)).toContain("assignable.length >= 300");
  });
});

describe("lo que se teclea no rompe la consulta", () => {
  // En `or()` de PostgREST la coma separa filtros y el paréntesis los agrupa:
  // un nombre con coma partiría el filtro en dos y devolvería cualquier cosa.
  it("la coma y el paréntesis no llegan a la consulta", () => {
    expect(terminoSeguro("Gómez, Ana")).toBe("Gómez  Ana");
    expect(terminoSeguro("a)or(b")).toBe("a or b");
  });

  it("el comodín lo pone el código, no el usuario", () => {
    expect(terminoSeguro("%")).toBe("");
    expect(terminoSeguro("KP*")).toBe("KP");
  });

  it("un código de pedido pasa tal cual, con almohadilla o sin ella", () => {
    expect(terminoSeguro("KP131277")).toBe("KP131277");
    expect(terminoSeguro("#KP131277")).toBe("#KP131277");
    expect(terminoSeguro("  KP131277  ")).toBe("KP131277");
  });

  it("los acentos y la eñe sobreviven: son la mitad de los nombres", () => {
    expect(terminoSeguro("Muñoz Aréstegui")).toBe("Muñoz Aréstegui");
  });
});
