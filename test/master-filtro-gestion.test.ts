import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { applyServerFilters } from "@/lib/orders-master-access";
import { buildMasterQuery, hasQueryFilters, parseMasterQuery } from "@/lib/master-query";
import {
  emptyFilters,
  hasActiveFilters,
  MANAGEMENT_DAY_STEPS,
  managementDayLabel,
  matchesFilters,
  type MasterFilters,
} from "@/lib/order-master-filters";
import type { OrderMasterRow } from "@/lib/types";

/**
 * Filtrar por la columna «Gestión».
 *
 * La columna llevaba tiempo en la tabla —«3/7 días», los días distintos con
 * llamada— y no se podía filtrar por ella. Son dos colas muy distintas dentro
 * de «Por confirmar»: el de 1 día no se ha trabajado todavía, el de 4 lleva
 * media escalera gastada sin cerrar, y atacarlas igual desperdicia las dos.
 *
 * Medido el 15-09-2026 en producción: 0→5, 1→137, 2→139, 3→75, 4→7.
 */

const row = (over: Partial<OrderMasterRow> = {}): OrderMasterRow =>
  ({
    id: "o1",
    store_id: "s1",
    order_name: "#KP1",
    customer_name: "Cliente",
    customer_phone: "519",
    general_status: "en_proceso",
    operational_status: "por_confirmar",
    comment_count: 0,
    courier_count: 0,
    attempt_count: 0,
    confirmation_day_count: 2,
    ...over,
  }) as unknown as OrderMasterRow;

const con = (...days: string[]): MasterFilters => ({
  ...emptyFilters(),
  managementDays: new Set(days),
});

describe("el filtro de Gestión decide qué fila entra", () => {
  it("vacío no filtra: un conjunto sin elegir significa «todas»", () => {
    expect(matchesFilters(row({ confirmation_day_count: 4 }), emptyFilters())).toBe(true);
  });

  it("elegir un paso deja solo ese paso", () => {
    expect(matchesFilters(row({ confirmation_day_count: 2 }), con("2"))).toBe(true);
    expect(matchesFilters(row({ confirmation_day_count: 3 }), con("2"))).toBe(false);
  });

  it("se pueden pedir varios pasos a la vez, que es como se ataca la cola larga", () => {
    const cuatroOMas = con("4", "5", "6", "7");
    expect(matchesFilters(row({ confirmation_day_count: 4 }), cuatroOMas)).toBe(true);
    expect(matchesFilters(row({ confirmation_day_count: 6 }), cuatroOMas)).toBe(true);
    expect(matchesFilters(row({ confirmation_day_count: 1 }), cuatroOMas)).toBe(false);
  });

  // La celda de la tabla pinta `confirmation_day_count ?? 0`. Si el filtro no
  // leyera lo mismo, pedir «0/7 días» dejaría fuera justo las filas que la
  // pantalla está enseñando como 0 — el filtro contradiría a la columna.
  it("un pedido sin dato se ve como 0 en la tabla, y pedir el 0 lo trae", () => {
    expect(matchesFilters(row({ confirmation_day_count: undefined }), con("0"))).toBe(true);
    expect(matchesFilters(row({ confirmation_day_count: undefined }), con("1"))).toBe(false);
  });

  it("cuenta como filtro activo, para poder ofrecer «Limpiar filtros»", () => {
    expect(hasActiveFilters(emptyFilters())).toBe(false);
    expect(hasActiveFilters(con("3"))).toBe(true);
  });
});

describe("el filtro viaja por la URL", () => {
  it("ida y vuelta sin perder nada", () => {
    const qs = buildMasterQuery({
      filters: con("1", "3"),
      sortKey: "created",
      page: 1,
    }).toString();
    expect(qs).toContain("gd=1%2C3");
    expect([...parseMasterQuery(new URLSearchParams(qs)).filters.managementDays]).toEqual(["1", "3"]);
  });

  it("una URL sin el parámetro no filtra", () => {
    const q = parseMasterQuery(new URLSearchParams(""));
    expect(q.filters.managementDays.size).toBe(0);
    expect(hasQueryFilters(q.filters)).toBe(false);
  });
});

describe("la consulta que llega a la base", () => {
  const sb = createClient("http://local", "anon");
  const ahora = new Date("2026-09-15T12:00:00.000Z");
  const url = (f: MasterFilters): URL =>
    (applyServerFilters(sb.from("order_master").select("id"), f, ahora) as unknown as { url: URL })
      .url;

  it("los pasos salen como enteros, no como texto", () => {
    // `confirmation_day_count` es integer: mandarlo entrecomillado lo rechaza la
    // base. Se comprueba la cadena producida, no que la línea esté escrita.
    expect(url(con("1", "3")).searchParams.get("confirmation_day_count")).toBe("in.(1,3)");
  });

  // `?gd=abc` lo produce un enlace viejo o una URL tocada a mano. Sin la guarda,
  // `Number("abc")` mete un NaN en el `in(...)`, PostgREST devuelve error de
  // tipo y la pantalla de trabajo diaria se queda en blanco.
  it("un valor que no es un entero se ignora en vez de romper la pantalla", () => {
    expect(url(con("abc")).searchParams.get("confirmation_day_count")).toBeNull();
    expect(url(con("2.5")).searchParams.get("confirmation_day_count")).toBeNull();
    expect(url(con("-1")).searchParams.get("confirmation_day_count")).toBeNull();
  });

  it("la basura no arrastra a lo bueno: se filtra por lo que sí se entiende", () => {
    expect(url(con("abc", "2")).searchParams.get("confirmation_day_count")).toBe("in.(2)");
  });

  it("sin filtro no se toca la columna", () => {
    expect(url(emptyFilters()).searchParams.get("confirmation_day_count")).toBeNull();
  });
});

describe("la escalera y su etiqueta", () => {
  it("va de 0 a 7, que es el denominador que pinta la columna", () => {
    expect([...MANAGEMENT_DAY_STEPS]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  // La etiqueta del desplegable y la celda de la tabla tienen que decir lo
  // mismo, o el usuario no relaciona lo que filtra con lo que ve.
  it("la etiqueta es la misma cadena que la celda", () => {
    expect(managementDayLabel(3)).toBe("3/7 días");
    expect(managementDayLabel("0")).toBe("0/7 días");
  });
});
