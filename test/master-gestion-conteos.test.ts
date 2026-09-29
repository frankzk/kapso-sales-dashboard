import { describe, expect, it, vi } from "vitest";

/**
 * LOS CHIPS DE «POR CONFIRMAR» NO PUEDEN CONTARSE A SÍ MISMOS.
 *
 * El desplegable de Gestión enseña «2/7 días (139 pedidos)» para poder atacar
 * por tamaño. Si al contar se aplicara también el paso que está puesto, elegir
 * uno dejaría los otros siete en cero y el desplegable se volvería inútil justo
 * después de usarlo: nadie podría comparar «me quedan 137 de 1 día contra 7 de
 * 4 días» estando dentro de uno de los dos. Los chips de «Fecha pactada» siguen
 * la misma regla con su propio filtro.
 *
 * Y cada juego SÍ respeta el filtro del otro: con «Hoy» elegido, la escalera
 * cuenta los de hoy; con «2/7 días» elegido, los chips cuentan los de 2 días.
 * Así el número del chip es exactamente lo que la tabla enseña al pulsarlo.
 *
 * Desde el 29-09-2026 los dos juegos salen de UNA lectura (antes eran doce
 * conteos por carga) y se cuentan con `confirmationQueueBucket`, la regla de la
 * que `applyServerFilters` es el espejo. La razón de escribirlo como prueba es
 * que no falla ruidosamente — los números salen, solo que mintiendo.
 */

// `vi.mock` se iza al principio del fichero, así que lo que su fábrica usa
// tiene que izarse con ella o no existe todavía cuando corre.
const { consultas, filas, createServerSupabaseMock } = vi.hoisted(() => {
  const consultas: { filtros: string[]; confirmationDayCount: boolean; rango: [number, number] | null }[] = [];
  const filas: { current: unknown[] } = { current: [] };
  return { consultas, filas, createServerSupabaseMock: vi.fn() };
});

function queryFalsa() {
  const estado = { filtros: [] as string[], confirmationDayCount: false, rango: null as [number, number] | null };
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (columna: string, valor: unknown) => {
    estado.filtros.push(`${columna}=${String(valor)}`);
    return q;
  };
  q.in = (columna: string, valores: unknown[]) => {
    // El filtro de gestión colándose en la lectura: la mutación que se caza.
    if (columna === "confirmation_day_count") estado.confirmationDayCount = true;
    estado.filtros.push(`${columna} in ${JSON.stringify(valores)}`);
    return q;
  };
  q.or = (expr: string) => {
    estado.filtros.push(`or ${expr}`);
    return q;
  };
  q.lt = (columna: string, valor: unknown) => {
    estado.filtros.push(`${columna}<${String(valor)}`);
    return q;
  };
  q.range = (from: number, to: number) => {
    estado.rango = [from, to];
    return q;
  };
  for (const metodo of ["gt", "gte", "lte", "not", "is", "order", "limit"]) {
    q[metodo] = () => q;
  }
  q.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
    consultas.push({ ...estado, filtros: [...estado.filtros] });
    const [from, to] = estado.rango ?? [0, filas.current.length - 1];
    return Promise.resolve({ data: filas.current.slice(from, to + 1), error: null }).then(ok, fail);
  };
  return q;
}

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
  createAdminSupabase: vi.fn(),
}));

import {
  getConfirmationQueueCounts,
  tallyConfirmationQueue,
  type ConfirmationQueueRow,
} from "@/lib/orders-master-access";
import { emptyFilters, type MasterFilters } from "@/lib/order-master-filters";

createServerSupabaseMock.mockImplementation(async () => ({ from: () => queryFalsa() }));

// 28-08-2026 a las 15:30 Lima (20:30 UTC).
const AHORA = new Date("2026-08-28T20:30:00.000Z");

function fila(p: Partial<ConfirmationQueueRow>): ConfirmationQueueRow {
  return {
    confirmation_next_contact_on: null,
    confirmation_reminder_due_at: null,
    confirmation_cycle_due_on: null,
    confirmation_day_count: 0,
    ...p,
  };
}

// Una cola pequeña con un poco de todo: dos vencidos, tres de hoy (pactado,
// recordatorio llegado y sin ninguna fecha), dos próximos.
const COLA: ConfirmationQueueRow[] = [
  fila({ confirmation_next_contact_on: "2026-08-26", confirmation_day_count: 2 }), // vencido
  fila({ confirmation_next_contact_on: "2026-08-27", confirmation_day_count: 3 }), // vencido
  fila({ confirmation_next_contact_on: "2026-08-28", confirmation_day_count: 2 }), // hoy
  fila({ confirmation_reminder_due_at: "2026-08-28T19:00:00.000Z", confirmation_day_count: 1 }), // hoy
  fila({ confirmation_day_count: 0 }), // hoy: nunca se le llamó
  fila({ confirmation_next_contact_on: "2026-08-30", confirmation_day_count: 2 }), // próximo
  fila({ confirmation_reminder_due_at: "2026-08-28T23:00:00.000Z", confirmation_day_count: 1 }), // próximo
];

const con = (p: Partial<MasterFilters>): MasterFilters => ({ ...emptyFilters(), ...p });

describe("tallyConfirmationQueue — los dos juegos de chips con una sola lectura", () => {
  it("sin filtros, cuenta todo en su cubo y en su paso", () => {
    const { due, managementDays } = tallyConfirmationQueue(COLA, emptyFilters(), AHORA);
    expect(due).toEqual({ all: 7, vencido: 2, hoy: 3, proximo: 2 });
    expect(managementDays).toEqual({ 0: 1, 1: 2, 2: 3, 3: 1, 4: 0, 5: 0, 6: 0, 7: 0 });
  });

  it("el paso de Gestión elegido NO vacía la escalera, pero sí acota los chips de fecha", () => {
    const { due, managementDays } = tallyConfirmationQueue(COLA, con({ managementDays: new Set(["2"]) }), AHORA);
    // La escalera entera sigue a la vista…
    expect(managementDays[1]).toBe(2);
    expect(managementDays[3]).toBe(1);
    // …y los chips de fecha cuentan solo los de 2 días.
    expect(due).toEqual({ all: 3, vencido: 1, hoy: 1, proximo: 1 });
  });

  it("la fecha pactada elegida NO vacía sus chips, pero sí acota la escalera", () => {
    const { due, managementDays } = tallyConfirmationQueue(COLA, con({ confirmationDue: "hoy" }), AHORA);
    expect(due).toEqual({ all: 7, vencido: 2, hoy: 3, proximo: 2 });
    expect(managementDays).toEqual({ 0: 1, 1: 1, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 });
  });

  it("un paso que no es un entero se ignora, igual que en la consulta de la tabla", () => {
    const { due } = tallyConfirmationQueue(COLA, con({ managementDays: new Set(["abc"]) }), AHORA);
    expect(due.all).toBe(7);
  });

  it("un nulo no cuenta como el paso 0: en la base tampoco casa", () => {
    const { managementDays, due } = tallyConfirmationQueue(
      [fila({ confirmation_day_count: null })],
      con({ managementDays: new Set(["0"]) }),
      AHORA,
    );
    expect(managementDays[0]).toBe(0);
    expect(due.all).toBe(0);
  });
});

describe("getConfirmationQueueCounts — la lectura", () => {
  it("lee UNA vez, sin ninguno de los dos filtros de los chips", async () => {
    consultas.length = 0;
    filas.current = COLA;
    const counts = await getConfirmationQueueCounts(["s1"], {
      filters: con({ managementDays: new Set(["2"]), confirmationDue: "hoy" }),
      now: AHORA,
    });
    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.confirmationDayCount).toBe(false);
    // Ni el espejo de «Hoy» en PostgREST: se decide al contar.
    expect(consultas[0]!.filtros.some((f) => f.includes("confirmation_next_contact_on"))).toBe(false);
    expect(counts.due.hoy).toBe(1);
    expect(counts.managementDays[2]).toBe(1);
  });

  it("los DEMÁS filtros sí se aplican: el conteo es el de lo que se está mirando", async () => {
    consultas.length = 0;
    filas.current = [];
    await getConfirmationQueueCounts(["s1"], {
      filters: con({ regions: new Set(["Junín"]), withComments: true }),
      substage: "por_confirmar",
    });
    const filtros = consultas[0]!.filtros;
    expect(filtros).toContain('region in ["Junín"]');
    expect(filtros).toContain('store_id in ["s1"]');
    expect(filtros).toContain("macro_stage=por_confirmar");
    expect(filtros).toContain("macro_substage=por_confirmar");
  });

  it("pagina si la cola pasa de mil filas, sin perder ninguna", async () => {
    consultas.length = 0;
    filas.current = Array.from({ length: 1500 }, () => fila({ confirmation_day_count: 1 }));
    const counts = await getConfirmationQueueCounts(["s1"], { filters: emptyFilters(), now: AHORA });
    expect(consultas).toHaveLength(2);
    expect(counts.managementDays[1]).toBe(1500);
    expect(counts.due.all).toBe(1500);
  });

  it("sin tiendas no consulta nada y devuelve todo en cero", async () => {
    consultas.length = 0;
    const counts = await getConfirmationQueueCounts([], { filters: emptyFilters() });
    expect(consultas).toHaveLength(0);
    expect(counts.due).toEqual({ all: 0, vencido: 0, hoy: 0, proximo: 0 });
    expect(counts.managementDays[0]).toBe(0);
    expect(counts.managementDays[7]).toBe(0);
  });
});
