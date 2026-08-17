import { describe, expect, it } from "vitest";
import { budgetShareMs, recomputeInBatches, staleByShipment } from "@/lib/order-master";

// LA CUARTA PUERTA DEL BARRIDO.
//
// `order_master` es una foto derivada: si algo escribe en `shipments` y no
// recalcula, el pedido se queda mostrando la etapa anterior para siempre. El
// 09-08 se enlazaron 71 guías huérfanas a sus pedidos con SQL a mano contra la
// base — ninguna ruta de la aplicación intervino, así que no hubo recálculo que
// pudiera fallar. Pedidos que recibían su PRIMERA guía, algunos ya ENTREGADA,
// siguieron en «Por confirmar · Sin llamar» durante días.
//
// El barrido no los veía: tenían fila, tenían la versión vigente del MOM, y por
// antigüedad quedaban fuera de la lista de candidatos. Esta función es la señal
// que faltaba —guía escrita después del último recálculo— y funciona sin saber
// quién escribió, que es justo lo que hace falta cuando la escritura vino de
// fuera de la aplicación.

const master = (order_id: string, recomputed_at: string | null) => ({ order_id, recomputed_at });
const write = (order_id: string | null, updated_at: string | null) => ({ order_id, updated_at });

describe("staleByShipment — pedidos con la etapa vieja", () => {
  it("señala el pedido cuya guía se escribió después del recálculo", () => {
    // El caso real: #AUR173240, enlazada a su pedido el 09-08, Master del 07-08.
    expect(
      staleByShipment(
        [write("AUR173240", "2026-08-09T19:24:01Z")],
        [master("AUR173240", "2026-08-07T19:50:56Z")],
      ),
    ).toEqual(["AUR173240"]);
  });

  it("deja en paz al pedido recalculado después de su última guía", () => {
    expect(
      staleByShipment(
        [write("ok", "2026-08-09T19:24:01Z")],
        [master("ok", "2026-08-09T19:24:30Z")],
      ),
    ).toEqual([]);
  });

  it("no cuenta el empate: el recálculo que sigue a la escritura ya está al día", () => {
    // Las dos marcas nacen del mismo movimiento y coinciden al segundo. Contarlo
    // como viejo metía al pedido en TODAS las pasadas del cron, para siempre.
    expect(
      staleByShipment([write("a", "2026-08-09T19:24:01Z")], [master("a", "2026-08-09T19:24:01Z")]),
    ).toEqual([]);
  });

  it("señala al pedido que no tiene fila en el Master todavía", () => {
    expect(staleByShipment([write("nuevo", "2026-08-09T19:24:01Z")], [])).toEqual(["nuevo"]);
  });

  it("señala la fila sin recomputed_at, que no prueba ningún recálculo", () => {
    expect(
      staleByShipment([write("a", "2026-08-09T19:24:01Z")], [master("a", null)]),
    ).toEqual(["a"]);
  });

  it("compara contra la ESCRITURA MÁS RECIENTE de un pedido con varias guías", () => {
    // Un pedido con dos salidas: basta con que UNA se haya movido después. Mirar
    // la primera que llegue dejaría fuera al pedido reexpedido, que es justo el
    // que más se mueve.
    expect(
      staleByShipment(
        [
          write("multi", "2026-08-01T10:00:00Z"),
          write("multi", "2026-08-09T19:24:01Z"),
        ],
        [master("multi", "2026-08-07T19:50:56Z")],
      ),
    ).toEqual(["multi"]);

    expect(
      staleByShipment(
        [
          write("multi", "2026-08-09T19:24:01Z"),
          write("multi", "2026-08-01T10:00:00Z"),
        ],
        [master("multi", "2026-08-10T00:00:00Z")],
      ),
    ).toEqual([]);
  });

  it("ignora guías sin pedido y sin fecha en vez de romperse", () => {
    expect(
      staleByShipment(
        [write(null, "2026-08-09T19:24:01Z"), write("sinfecha", null)],
        [],
      ),
    ).toEqual([]);
  });

  it("no repite un pedido aunque tenga muchas escrituras viejas", () => {
    const writes = Array.from({ length: 5 }, (_, i) =>
      write("uno", `2026-08-0${i + 1}T10:00:00Z`),
    );
    expect(staleByShipment(writes, [master("uno", "2026-07-01T00:00:00Z")])).toEqual(["uno"]);
  });
});

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
