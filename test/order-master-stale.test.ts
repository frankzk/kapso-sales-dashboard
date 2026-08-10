import { describe, expect, it } from "vitest";
import { recomputeInBatches, staleByShipment } from "@/lib/order-master";

// LA CUARTA PUERTA DEL BARRIDO.
//
// `order_master` es una foto derivada: si una ruta escribe en `shipments` y no
// recalcula, el pedido se queda mostrando la etapa anterior para siempre. Pasó
// el 09-08 — un import movió 1.126 guías, el recálculo posterior falló entero y
// se lo tragó el `catch`— y no lo arregló nadie porque el barrido solo miraba
// filas ausentes, `staleBefore` y versiones viejas del MOM. Un pedido con su
// fila, la versión vigente y una guía recién escrita era invisible por las tres.
//
// Esta función es la señal que faltaba: guía escrita después del último
// recálculo. No necesita saber quién escribió, porque todas las rutas que se
// olvidan de recalcular dejan la misma huella.

const master = (order_id: string, recomputed_at: string | null) => ({ order_id, recomputed_at });
const write = (order_id: string | null, updated_at: string | null) => ({ order_id, updated_at });

describe("staleByShipment — pedidos con la etapa vieja", () => {
  it("señala el pedido cuya guía se escribió después del recálculo", () => {
    // El caso real: guía tocada por el import del 09-08, Master del 07-08.
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
// El otro lado del 09-08: el recálculo se llamó con los 1.126 pedidos de una
// vez y `Safe` se tragó el fallo entero. La cuenta final fue 1 recalculado y
// 1.125 congelados, sin rastro en ninguna parte.

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
    expect(r).toEqual({ requested: 5, written: 5, failed: 0 });
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
    expect(r).toEqual({ requested: 4, written: 3, failed: 1 });
  });

  it("cuenta los perdidos cuando el trozo entero sigue fallando", async () => {
    const r = await recomputeInBatches(
      ["a", "b", "c", "d"],
      async () => {
        throw new Error("Supabase caído");
      },
      { batch: 4, retry: 2 },
    );
    expect(r).toEqual({ requested: 4, written: 0, failed: 4 });
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
