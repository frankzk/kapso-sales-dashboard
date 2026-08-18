import { describe, expect, it } from "vitest";
import { budgetShareMs, recomputeInBatches } from "@/lib/order-master";

// LA REGLA DEL DESFASE YA NO VIVE ACÁ.
//
// `staleByShipment` comparaba en TypeScript sobre una VENTANA de las 2.000 guías
// tocadas más recientemente, porque PostgREST no sabe comparar dos columnas de
// tablas distintas. Esa ventana tenía fondo, y un pedido que caía por debajo no
// volvía a entrar nunca: 381 de 487 desfasados en Kenku el 18-08-2026, mientras
// el barrido recalculaba 620 pedidos por hora en esa misma tienda.
//
// La regla se mudó a la base (`order_master_stale`, 0123), que es donde la
// comparación se puede hacer sin techo, y sus pruebas con ella:
// `scripts/sql/order_master_stale_smoke.sql`. Dejarlas duplicadas acá habría
// conservado la segunda definición que aquel cambio vino a eliminar.
//
// Lo que sigue probándose desde acá es lo que NO se fue a la base: el reparto
// del reloj entre tiendas y el recálculo por tandas.


// ── Que un pedido envenenado no congele a los demás ─────────────────────────
//
// Endurecimiento, no la causa del 09-08 —aquello fue SQL a mano, que no pasa por
// aquí—: el import de Aliclik llega a llamar al recálculo con más de mil pedidos
// de golpe, y un solo pedido que reviente los congelaba a todos sin dejar rastro.

describe("recomputeInBatches — un fallo cuesta un trozo, no la lista", () => {
  it("recalcula todo cuando nada falla", async () => {
    const vistos: string[][] = [];
    const r = await recomputeInBatches(
      ["a", "b", "c", "d", "e"],
      async (batch) => {
        vistos.push(batch);
        return batch.length;
      },
      { batch: 2, retry: 1 },
    );
    expect(r).toEqual({ requested: 5, written: 5, failed: 0, error: null, deferred: 0 });
    expect(vistos).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("aísla al pedido que revienta y salva a los de su tanda", async () => {
    const r = await recomputeInBatches(
      ["ok1", "ok2", "veneno", "ok3"],
      async (batch) => {
        if (batch.includes("veneno")) throw new Error("boom");
        return batch.length;
      },
      { batch: 4, retry: 1 },
    );
    // La tanda de 4 falla, se reintenta de uno en uno: 3 salvados, 1 perdido.
    expect(r).toEqual({ requested: 4, written: 3, failed: 1, error: "boom", deferred: 0 });
  });

  it("cuenta los perdidos cuando el trozo entero sigue fallando", async () => {
    const r = await recomputeInBatches(
      ["a", "b", "c", "d"],
      async () => {
        throw new Error("Supabase caído");
      },
      { batch: 4, retry: 2 },
    );
    expect(r).toEqual({ requested: 4, written: 0, failed: 4, error: "Supabase caído", deferred: 0 });
  });

  it("no pregunta dos veces por el mismo pedido", async () => {
    const vistos: string[] = [];
    const r = await recomputeInBatches(
      ["a", "a", "b", "a"],
      async (batch) => {
        vistos.push(...batch);
        return batch.length;
      },
      { batch: 10 },
    );
    expect(vistos).toEqual(["a", "b"]);
    expect(r.requested).toBe(2);
  });
});

// ── Que a la última tienda de la cola le llegue reloj ───────────────────────
//
// El barrido del Master era la última línea de `runStoreSync`, y el cron
// recorría las tiendas en serie bajo un solo `maxDuration`. Sin reparto, la
// segunda hereda lo que sobre — y lo que sobra, cuando la primera se pasa, es
// nada. Medido en producción el 17-08-2026: Kenku 207 pedidos desfasados con 50
// horas de media, Aurela cero. Misma regla, mismo código; a una tienda no le
// llegaba.
//
// Es lo que estas pruebas fijan, y es lo que ninguna prueba miraba: no si la
// regla acierta —eso ya estaba cubierto— sino si llega a EJECUTARSE.

describe("budgetShareMs — el reparto del reloj entre tiendas", () => {
  it("parte lo que queda entre las tiendas que faltan, esta incluida", () => {
    expect(budgetShareMs(240_000, 2)).toBe(120_000);
    expect(budgetShareMs(120_000, 1)).toBe(120_000);
  });

  it("A LA ÚLTIMA TIENDA LE QUEDA TIEMPO aunque la primera se pase", () => {
    // La prueba que habría cazado el incidente. Se simula el bucle entero: dos
    // tiendas, y la primera consume TODA su parte. La segunda tiene que recibir
    // un reparto mayor que cero — antes recibía lo que la primera no gastó, que
    // era cero.
    const total = 240_000;
    let reloj = 0;
    const partes: number[] = [];
    for (const i of [0, 1]) {
      const parte = budgetShareMs(total - reloj, 2 - i);
      partes.push(parte);
      reloj += parte; // la tienda agota su parte entera
    }
    expect(partes[0]).toBe(120_000);
    expect(partes[1]).toBeGreaterThan(0);
    expect(partes[1]).toBe(120_000);
  });

  it("no reparte tiempo negativo cuando el presupuesto ya se pasó", () => {
    expect(budgetShareMs(-5_000, 2)).toBe(0);
  });

  it("no divide por cero cuando no quedan tiendas", () => {
    expect(budgetShareMs(10_000, 0)).toBe(0);
  });
});

describe("recomputeInBatches — el corte por reloj", () => {
  it("corta ENTRE tandas y cuenta lo aplazado, sin darlo por fallido", () => {
    // Una tanda a medias dejaría unos recalculados y otros no sin saber cuáles.
    let ahora = 0;
    const vistos: string[][] = [];
    return recomputeInBatches(
      ["a", "b", "c", "d", "e", "f"],
      async (batch) => {
        vistos.push(batch);
        ahora += 50; // cada tanda cuesta 50
        return batch.length;
      },
      { batch: 2, deadline: 90, now: () => ahora },
    ).then((r) => {
      // Tercera tanda: el reloj va por 100 y el corte era 90, así que para.
      expect(vistos).toEqual([["a", "b"], ["c", "d"]]);
      expect(r.written).toBe(4);
      expect(r.deferred).toBe(2);
      // Aplazado NO es fallido: nadie lo intentó y vuelve en la pasada siguiente.
      expect(r.failed).toBe(0);
      expect(r.error).toBeNull();
    });
  });

  it("sin `deadline` no corta nunca, que es como se llama desde las acciones", async () => {
    const r = await recomputeInBatches(["a", "b", "c"], async (b) => b.length, { batch: 1 });
    expect(r.written).toBe(3);
    expect(r.deferred).toBe(0);
  });
});
