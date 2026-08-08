import { describe, expect, it } from "vitest";
import {
  buildWarehouseQueue,
  warehouseBlocker,
  warehouseCloser,
  warehousePanels,
  WAREHOUSE_STALE_DAYS,
  type WarehousePanel,
} from "@/lib/warehouse-queue";

const NOW = Date.parse("2026-08-07T18:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

/** El grupo pedido, o falla: un `undefined` silencioso no prueba nada. */
function groupOf<G extends { operation: string }>(queue: { groups: G[] }, operation: string): G {
  const group = queue.groups.find((candidate) => candidate.operation === operation);
  if (!group) throw new Error(`La cola no tiene grupo ${operation}`);
  return group;
}

function entryOf<E>(entries: E[], index: number): E {
  const entry = entries[index];
  if (!entry) throw new Error(`La cola no tiene la posición ${index}`);
  return entry;
}

function salida(over: Partial<Parameters<typeof buildWarehouseQueue>[0][number]> & { id?: string } = {}) {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    courier: "propio",
    delivery_status: "pendiente",
    created_at: daysAgo(0),
    operation: "lima",
    ...over,
  };
}

describe("warehouseCloser", () => {
  it("solo Aliclik cierra el armado por su cuenta (MOM §6.2)", () => {
    // `PREPARED` autenticado equivale al escaneo físico. Es la única equivalencia
    // documentada: para el resto la caja espera al lector de almacén.
    expect(warehouseCloser("aliclik")).toBe("courier");
    expect(warehouseCloser("Aliclik")).toBe("courier");
  });

  it("Lima, agencia y Swayp siguen esperando el escaneo", () => {
    for (const courier of ["propio", "axel", "urpi", "tanders", "fenix", "shalom", "olva", null]) {
      expect(warehouseCloser(courier)).toBe("escaneo");
    }
  });
});

describe("warehouseBlocker", () => {
  it("una guía anulada o transferida ya no se arma", () => {
    expect(warehouseBlocker("anulado")).toBe("Guía anulada");
    expect(warehouseBlocker("transferido")).toBe("Guía transferida");
  });

  it("si el courier ya la reporta en ruta o entregada, tampoco", () => {
    // Contradice el propio estado de la cola: la caja no está aquí.
    expect(warehouseBlocker("en_ruta")).toBeTruthy();
    expect(warehouseBlocker("entregado")).toBeTruthy();
  });

  it("lo pendiente y lo desconocido sí se arman", () => {
    expect(warehouseBlocker("pendiente")).toBeNull();
    expect(warehouseBlocker(null)).toBeNull();
    expect(warehouseBlocker("estado_nuevo")).toBeNull();
  });
});

describe("buildWarehouseQueue", () => {
  it("agrupa en la prioridad de almacén del MOM §6.2: Lima, agencia, provincia", () => {
    const queue = buildWarehouseQueue(
      [
        salida({ operation: "provincia_cod", courier: "aliclik" }),
        salida({ operation: "agencia", courier: "shalom" }),
        salida({ operation: "lima", courier: "tanders" }),
      ],
      NOW,
    );
    expect(queue.groups.map((group) => group.operation)).toEqual([
      "lima",
      "agencia",
      "provincia_cod",
    ]);
  });

  it("no inventa grupos vacíos", () => {
    const queue = buildWarehouseQueue([salida({ operation: "lima" })], NOW);
    expect(queue.groups).toHaveLength(1);
  });

  it("una operación que no reconoce cae en «sin clasificar», al final", () => {
    const queue = buildWarehouseQueue(
      [salida({ operation: null }), salida({ operation: "lima" })],
      NOW,
    );
    expect(queue.groups.map((group) => group.operation)).toEqual(["lima", "desconocida"]);
  });

  it("marca cuántas del grupo dependen del reporte del courier", () => {
    // Es la respuesta a «¿por qué provincia no baja aunque nadie escanee?».
    const queue = buildWarehouseQueue(
      [
        salida({ operation: "provincia_cod", courier: "aliclik" }),
        salida({ operation: "provincia_cod", courier: "aliclik" }),
        salida({ operation: "provincia_cod", courier: "fenix" }),
      ],
      NOW,
    );
    const provincia = groupOf(queue, "provincia_cod");
    expect(provincia.entries).toHaveLength(3);
    expect(provincia.waitingOnCourier).toBe(2);
  });

  it("aparta lo que ya no se puede armar y no lo cuenta como pendiente", () => {
    const queue = buildWarehouseQueue(
      [
        salida({ id: "viva", operation: "lima" }),
        salida({ id: "anulada", operation: "provincia_cod", delivery_status: "anulado" }),
      ],
      NOW,
    );
    expect(queue.total).toBe(1);
    expect(queue.blocked).toHaveLength(1);
    const [apartada] = queue.blocked;
    expect(apartada?.shipment.id).toBe("anulada");
    expect(apartada?.reason).toBe("Guía anulada");
  });

  it("cuenta la antigüedad en días y marca detenida a partir del corte", () => {
    const queue = buildWarehouseQueue(
      [
        salida({ id: "hoy", created_at: daysAgo(0) }),
        salida({ id: "vieja", created_at: daysAgo(WAREHOUSE_STALE_DAYS) }),
      ],
      NOW,
    );
    const lima = groupOf(queue, "lima");
    // Lo más viejo primero: es lo que hay que mirar.
    expect(lima.entries.map((entry) => entry.shipment.id)).toEqual(["vieja", "hoy"]);
    expect(entryOf(lima.entries, 0).stalled).toBe(true);
    expect(entryOf(lima.entries, 0).ageDays).toBe(WAREHOUSE_STALE_DAYS);
    expect(entryOf(lima.entries, 1).stalled).toBe(false);
    expect(queue.stalled).toBe(1);
  });

  it("una caja sin fecha no se inventa antigüedad", () => {
    const queue = buildWarehouseQueue([salida({ created_at: null })], NOW);
    const primera = entryOf(groupOf(queue, "lima").entries, 0);
    expect(primera.ageDays).toBe(0);
    expect(primera.stalled).toBe(false);
  });
});

describe("warehousePanels", () => {
  /** El panel pedido, o falla. */
  function panelOf(panels: WarehousePanel[], operation: string): WarehousePanel {
    const panel = panels.find((candidate) => candidate.operation === operation);
    if (!panel) throw new Error(`El panel no tiene ${operation}`);
    return panel;
  }

  it("enseña las tres operaciones aunque estén vacías, en la prioridad del §6.2", () => {
    // El cero es el dato: un grupo sin cajas no se dibuja en la lista, así que sin
    // el panel el almacén no puede saber si Lima ya cerró el turno.
    const panels = warehousePanels(buildWarehouseQueue([], NOW));
    expect(panels.map((panel) => panel.operation)).toEqual(["lima", "agencia", "provincia_cod"]);
    expect(panels.every((panel) => panel.total === 0 && panel.closer === null)).toBe(true);
  });

  it("cuenta por operación y dice quién cierra cada panel", () => {
    const panels = warehousePanels(
      buildWarehouseQueue(
        [
          salida({ id: "l1", operation: "lima" }),
          salida({ id: "l2", operation: "lima" }),
          salida({ id: "p1", operation: "provincia_cod", courier: "aliclik" }),
        ],
        NOW,
      ),
    );
    const lima = panelOf(panels, "lima");
    expect(lima.total).toBe(2);
    expect(lima.closer).toBe("escaneo");

    // Provincia COD la cierra el `PREPARED` de Aliclik, no el lector del almacén.
    const provincia = panelOf(panels, "provincia_cod");
    expect(provincia.total).toBe(1);
    expect(provincia.closer).toBe("courier");

    expect(panelOf(panels, "agencia").total).toBe(0);
  });

  it("marca mixto cuando en la misma operación conviven las dos formas de cerrar", () => {
    const panels = warehousePanels(
      buildWarehouseQueue(
        [
          salida({ id: "api", operation: "provincia_cod", courier: "aliclik" }),
          salida({ id: "lector", operation: "provincia_cod", courier: "swayp" }),
        ],
        NOW,
      ),
    );
    expect(panelOf(panels, "provincia_cod").closer).toBe("mixto");
  });

  it("no cuenta en el panel lo que ya no se puede armar", () => {
    // Una guía anulada no es trabajo pendiente: si sumara, el turno nunca cerraría.
    const panels = warehousePanels(
      buildWarehouseQueue(
        [
          salida({ id: "viva", operation: "lima" }),
          salida({ id: "anulada", operation: "lima", delivery_status: "anulado" }),
        ],
        NOW,
      ),
    );
    expect(panelOf(panels, "lima").total).toBe(1);
  });

  it("arrastra las detenidas de cada operación y solo añade Sin clasificar si existe", () => {
    const panels = warehousePanels(
      buildWarehouseQueue(
        [
          salida({ id: "vieja", operation: "lima", created_at: daysAgo(WAREHOUSE_STALE_DAYS) }),
          salida({ id: "rara", operation: null }),
        ],
        NOW,
      ),
    );
    expect(panelOf(panels, "lima").stalled).toBe(1);
    expect(panelOf(panels, "desconocida").total).toBe(1);
  });
});
