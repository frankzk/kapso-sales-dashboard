import { describe, expect, it } from "vitest";
import { applyAliclikSnapshot } from "@/lib/aliclik-track";
import { courierReason, wasRefusedInPerson } from "@/lib/return-recovery";

// EL MOTIVO DEL COURIER Y EL SELLO DE LA DEVOLUCIÓN.
//
// Las dos cosas deciden lo mismo: si a esta clienta se le pide un adelanto. El
// motivo es con lo que se aplica el MOM §11 —«si vio el producto y lo rechazó,
// no reenviar»— y el sello dice qué constancia hay detrás de la devolución.
//
// Lo que se prueba acá es sobre todo lo que NO debe pasar: que una relectura de
// la API reescriba un sello que puso una persona, y que un motivo ausente se
// confunda con un motivo que dice que todo está bien.

describe("courierReason — qué consta sobre la no entrega", () => {
  it("prefiere lo que dijo el courier sobre lo que anotó quien gestionó", () => {
    expect(
      courierReason({
        reported_status: "CANCEL · LEFT_IN_WAREHOUSE",
        non_delivery_reason: "no contesta",
      }),
    ).toBe("CANCEL · LEFT_IN_WAREHOUSE");
  });

  it("cae en la nota de la persona cuando el courier no dijo nada", () => {
    expect(courierReason({ reported_status: null, non_delivery_reason: "no contesta" })).toBe(
      "no contesta",
    );
  });

  it("es null cuando no consta nada, venga como venga el vacío", () => {
    expect(courierReason({ reported_status: null, non_delivery_reason: null })).toBeNull();
    // `aliclikStatusLabel` devolvía cadena vacía al unir tres campos vacíos, así
    // que la columna llegó a tener dos formas del mismo vacío (0119).
    expect(courierReason({ reported_status: "", non_delivery_reason: "" })).toBeNull();
    expect(courierReason({ reported_status: "   ", non_delivery_reason: null })).toBeNull();
  });
});

describe("MOM §11 sobre una devolución sin motivo", () => {
  // La prueba que da nombre a todo esto. `wasRefusedInPerson` es la exclusión, y
  // sobre dos columnas vacías dice `false` — que NO significa «no la rechazó»
  // sino «no consta». Las dos funciones juntas permiten distinguirlo: sin
  // motivo la guía pasa el filtro, y por eso la cola lo escribe en pantalla en
  // vez de pintar un guion.
  it("no excluye, porque no hay con qué excluir — y eso no es una absolución", () => {
    const sinMotivo = { reported_status: null, non_delivery_reason: null };
    expect(wasRefusedInPerson(sinMotivo.reported_status, sinMotivo.non_delivery_reason)).toBe(false);
    expect(courierReason(sinMotivo)).toBeNull();
  });

  it("excluye en cuanto el motivo aparece y habla de rechazo", () => {
    expect(wasRefusedInPerson("REFUSED · RETURNED · CONFIRMED", null)).toBe(true);
    expect(wasRefusedInPerson(null, "la clienta rechazó el producto")).toBe(true);
  });
});

// ── El sello de devolución frente a una relectura de la API ─────────────────
//
// Importa ahora más que nunca: la pasada de motivo del cron (0119) consulta a
// Aliclik justo por las guías YA devueltas. Sin la guarda de `sealReturn`, cada
// consulta convertiría en «API de Aliclik» un paquete que recibió una persona en
// el almacén, y de paso borraría su nombre de `returned_by`. La columna que se
// creó para distinguirlas se habría borrado sola en la primera pasada.

interface Row {
  id: string;
  store_id: string;
  order_id: string | null;
  courier: string;
  guide_code: string | null;
  external_order_number: string | null;
  delivery_status: string;
  last_report_at: string | null;
  preparation_state: string | null;
  custody_state: string | null;
  ready_at: string | null;
  custody_transferred_at: string | null;
  returned_at: string | null;
  returned_source: string | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "ship-1",
    store_id: "store-1",
    order_id: null, // sin pedido: evita el recálculo del Master en el test
    courier: "aliclik",
    guide_code: "AUR5X122767",
    external_order_number: null,
    delivery_status: "anulado",
    last_report_at: null,
    preparation_state: null,
    custody_state: null,
    ready_at: null,
    custody_transferred_at: null,
    returned_at: null,
    returned_source: null,
    ...over,
  };
}

/** Doble mínimo de PostgREST: filtra por los `.eq()` acumulados. */
function fakeAdmin(rows: Row[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const admin = {
    from() {
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          patch = p;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          if (patch && col === "id") {
            updates.push({ id: String(val), patch });
            return Promise.resolve({ error: null });
          }
          filters[col] = val;
          return chain;
        },
        limit: () => chain,
        maybeSingle: async () => ({
          data:
            rows.find((r) =>
              Object.entries(filters).every(
                ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
              ),
            ) ?? null,
          error: null,
        }),
      };
      return chain;
    },
  };
  return { admin: admin as never, updates };
}

/** Lo que Aliclik responde por una guía que volvió al almacén: el triple exacto
 *  que traen las devoluciones reales, con el intento de entrega que hace de
 *  LEFT_IN_WAREHOUSE un retorno y no un paquete que nunca salió. */
const devuelta = {
  orderNumber: "AUR5X122767",
  status: "CANCEL",
  callStatus: "CONFIRMED",
  dispatchStatus: "LEFT_IN_WAREHOUSE",
  updatedAt: "2026-08-11T12:00:00.000Z",
};

describe("applyAliclikSnapshot — el sello de devolución se pone una vez", () => {
  it("sella con la API la guía que todavía no estaba devuelta", async () => {
    const { admin, updates } = fakeAdmin([row()]);
    await applyAliclikSnapshot(devuelta as never, admin);
    expect(updates[0]?.patch.returned_at).toBe("2026-08-11T12:00:00.000Z");
    expect(updates[0]?.patch.returned_source).toBe("aliclik_api");
  });

  it("NO pisa el sello que puso una persona en el almacén", async () => {
    const { admin, updates } = fakeAdmin([
      row({ returned_at: "2026-08-10T03:26:00.000Z", returned_source: "manual" }),
    ]);
    await applyAliclikSnapshot(devuelta as never, admin);
    expect(updates[0]?.patch).not.toHaveProperty("returned_at");
    expect(updates[0]?.patch).not.toHaveProperty("returned_source");
    // Y el nombre de quien lo recibió sigue en su sitio.
    expect(updates[0]?.patch).not.toHaveProperty("returned_by");
  });

  it("tampoco pisa un sello anterior del propio courier", async () => {
    const { admin, updates } = fakeAdmin([
      row({ returned_at: "2026-07-20T10:00:00.000Z", returned_source: "aliclik_report" }),
    ]);
    await applyAliclikSnapshot(devuelta as never, admin);
    expect(updates[0]?.patch).not.toHaveProperty("returned_source");
  });

  it("aun así escribe el motivo, que es a lo que sale la pasada", async () => {
    const { admin, updates } = fakeAdmin([
      row({ returned_at: "2026-08-10T03:26:00.000Z", returned_source: "manual" }),
    ]);
    await applyAliclikSnapshot(devuelta as never, admin);
    expect(updates[0]?.patch.reported_status).toBe("CANCEL · LEFT_IN_WAREHOUSE · CONFIRMED");
  });

  it("no escribe el motivo cuando Aliclik no dice nada, en vez de borrarlo", async () => {
    // Los tres campos vacíos daban cadena vacía y se guardaba igual, pisando un
    // motivo que el Excel sí había traído.
    const mudo = { orderNumber: "AUR5X122767", updatedAt: "2026-08-11T12:00:00.000Z" };
    const { admin, updates } = fakeAdmin([row({ delivery_status: "en_ruta" })]);
    await applyAliclikSnapshot(mudo as never, admin);
    expect(updates[0]?.patch ?? {}).not.toHaveProperty("reported_status");
  });
});
