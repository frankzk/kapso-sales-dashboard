import { describe, expect, it } from "vitest";
import { applyAliclikSnapshot } from "@/lib/aliclik-track";

/**
 * Cada cambio de ETIQUETA de Aliclik deja un evento en el pedido, aunque el
 * estado nuestro no cambie; y un snapshot idéntico no deja ninguno.
 *
 * EL CASO (15-09-2026). `AUR5X250809378012` pasó por IN_TRANSIT → IN_AGENCY →
 * PICKED, los tres traducidos a `en_ruta`. La Actividad mostraba «en ruta» el
 * 11-09 y nada más, mientras el panel de Aliclik enseñaba Recolectado, En
 * agencia y Validado con su hora. La API trae cada paso; no se registraba
 * porque el evento solo se escribía cuando cambiaba el estado NUESTRO.
 *
 * El reverso ya lo cubren #571 y #581: un snapshot igual al último aplicado
 * escribe solo los sellos y sale, y el mismo NO CONTESTA no saca de la cola a la
 * guía que metió. Aquí se comprueba que el evento nuevo respeta las dos cosas.
 */

interface Row {
  id: string;
  store_id: string;
  order_id: string | null;
  courier: string;
  guide_code: string | null;
  external_order_number: string | null;
  delivery_status: string;
  status_category: string | null;
  reported_status: string | null;
  reported_collect_amount: number | null;
  last_report_at: string | null;
  api_report_at: string | null;
  api_updated_at: string | null;
  preparation_state: string | null;
  custody_state: string | null;
  ready_at: string | null;
  custody_transferred_at: string | null;
  next_followup_at: string | null;
  returned_at: string | null;
  returned_source: string | null;
  closed_at: string | null;
  pickup_state: string | null;
  delivered_source: string | null;
  dispatched_at: string | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "ship-1",
    store_id: "store-1",
    order_id: "order-1",
    courier: "aliclik",
    guide_code: "AUR5X250809378012",
    external_order_number: "AUR5X250809378012",
    delivery_status: "pendiente",
    status_category: "pending",
    reported_status: null,
    reported_collect_amount: null,
    last_report_at: null,
    api_report_at: null,
    api_updated_at: null,
    preparation_state: null,
    custody_state: null,
    ready_at: null,
    custody_transferred_at: null,
    next_followup_at: null,
    returned_at: null,
    returned_source: null,
    closed_at: null,
    pickup_state: null,
    delivered_source: null,
    dispatched_at: null,
    ...over,
  };
}

/**
 * Doble de PostgREST que APLICA los updates sobre la fila —para poder encadenar
 * pasadas— y captura los inserts en `order_events`. Cualquier otra tabla
 * (el recálculo del Master) responde vacío sin fallar. `maybeSingle` devuelve
 * una COPIA, como haría PostgREST: el aplicador compara la fila que leyó con lo
 * que va a escribir, y si fuera el mismo objeto el update la mutaría antes.
 */
function fakeAdmin(initial: Row) {
  const rows = [initial];
  const events: Record<string, unknown>[] = [];
  const admin = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {};
      const proxy: Record<string, unknown> = new Proxy(chain, {
        get(_target, prop: string) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
          }
          if (prop === "insert") {
            return (p: Record<string, unknown>) => {
              if (table === "order_events") events.push(p);
              return Promise.resolve({ data: null, error: null });
            };
          }
          if (prop === "update") {
            return (p: Record<string, unknown>) => {
              patch = p;
              return proxy;
            };
          }
          if (prop === "eq") {
            return (col: string, val: unknown) => {
              if (patch && col === "id" && table === "shipments") {
                const target = rows.find((r) => r.id === val);
                if (target) Object.assign(target, patch);
                return Promise.resolve({ error: null });
              }
              filters[col] = val;
              return proxy;
            };
          }
          if (prop === "maybeSingle") {
            return async () => {
              const found =
                table === "shipments"
                  ? rows.find((r) =>
                      Object.entries(filters).every(
                        ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
                      ),
                    )
                  : undefined;
              return { data: found ? { ...found } : null, error: null };
            };
          }
          return () => proxy;
        },
      });
      return proxy;
    },
  };
  return { admin: admin as never, rows, events };
}

const paso = (dispatchStatus: string, updatedAt: string) => ({
  orderNumber: "AUR5X250809378012",
  status: "PENDING_DELIVERY",
  callStatus: "CONFIRMED",
  dispatchStatus,
  updatedAt,
});

describe("applyAliclikSnapshot — la etiqueta también es una transición", () => {
  it("IN_TRANSIT → IN_AGENCY → PICKED: tres eventos aunque los tres sean «en ruta»", async () => {
    const { admin, rows, events } = fakeAdmin(row());

    await applyAliclikSnapshot(paso("IN_TRANSIT", "2026-09-11T21:33:11.483Z") as never, admin);
    expect(rows[0]!.delivery_status).toBe("en_ruta");
    await applyAliclikSnapshot(paso("IN_AGENCY", "2026-09-11T23:30:22.000Z") as never, admin);
    expect(rows[0]!.delivery_status).toBe("en_ruta");
    await applyAliclikSnapshot(paso("PICKED", "2026-09-15T13:17:31.000Z") as never, admin);
    expect(rows[0]!.delivery_status).toBe("en_ruta");

    // Recolectado, En agencia, Validado: lo que enseña el panel de Aliclik.
    expect(events.map((e) => e.note)).toEqual([
      "Aliclik: en_ruta · PENDING_DELIVERY · IN_TRANSIT · CONFIRMED.",
      "Aliclik: en_ruta · PENDING_DELIVERY · IN_AGENCY · CONFIRMED.",
      "Aliclik: en_ruta · PENDING_DELIVERY · PICKED · CONFIRMED.",
    ]);
    // Fechados con el reloj de Aliclik, no con el del barrido.
    expect(events.map((e) => e.occurred_at)).toEqual([
      "2026-09-11T21:33:11.483Z",
      "2026-09-11T23:30:22.000Z",
      "2026-09-15T13:17:31.000Z",
    ]);
    // El estado anterior y el nuevo se guardan aunque coincidan: el historial
    // dice «seguía en ruta, pero ahora en agencia».
    expect(events[1]).toMatchObject({ previous_status: "en_ruta", new_status: "en_ruta" });
  });

  it("el mismo snapshot releído cada 20 minutos NO deja eventos repetidos", async () => {
    const { admin, events } = fakeAdmin(row());
    const t = "2026-09-11T23:30:22.000Z";
    await applyAliclikSnapshot(paso("IN_AGENCY", t) as never, admin);
    const segunda = await applyAliclikSnapshot(paso("IN_AGENCY", t) as never, admin);
    const tercera = await applyAliclikSnapshot(paso("IN_AGENCY", t) as never, admin);
    expect(segunda.outcome).toBe("unchanged");
    expect(tercera.outcome).toBe("unchanged");
    expect(events).toHaveLength(1);
  });

  it("un NO CONTESTA mete la guía en la cola una vez; el mismo NO CONTESTA no deja más eventos", async () => {
    // La regla de #581 vista desde el historial: la reapertura deja UN evento,
    // y las relecturas del mismo intento no dejan ninguno.
    const { admin, rows, events } = fakeAdmin(row({ delivery_status: "en_ruta", status_category: "in_route" }));
    const noContesta = {
      orderNumber: "AUR5X250809378012",
      status: "NOT_RESPOND",
      callStatus: "CONFIRMED",
      dispatchStatus: "STORE_CENTRAL",
      updatedAt: "2026-09-10T20:43:43.311Z",
    };
    await applyAliclikSnapshot(noContesta as never, admin);
    expect(rows[0]!.delivery_status).toBe("pendiente");
    expect(events).toHaveLength(1);

    await applyAliclikSnapshot(noContesta as never, admin);
    await applyAliclikSnapshot(noContesta as never, admin);
    expect(rows[0]!.delivery_status).toBe("pendiente");
    expect(events).toHaveLength(1);
  });
});
