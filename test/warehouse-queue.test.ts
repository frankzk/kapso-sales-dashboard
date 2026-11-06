import { describe, expect, it } from "vitest";
import {
  buildWarehouseQueue,
  departedWithOlva,
  previousOutputsOf,
  stallDiagnosis,
  warehouseBlocker,
  warehouseCloser,
  warehousePanels,
  WAREHOUSE_DECIDE_DAYS,
  WAREHOUSE_STALE_DAYS,
  type WarehousePanel,
  type WarehouseQueueInput,
  type WarehouseSiblingOutput,
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

describe("departedWithOlva", () => {
  it("solo cuando la aparta el tracking de Olva, no el estado de la guía", () => {
    expect(departedWithOlva({ courier: "olva", olva_tracking: "2804738" })).toBe(true);
    expect(departedWithOlva({ courier: "olva", olva_tracking: "2804738", delivery_status: "anulado" })).toBe(false);
    expect(departedWithOlva({ courier: "olva", olva_tracking: null })).toBe(false);
    expect(departedWithOlva({ courier: "shalom", olva_tracking: "2804738" })).toBe(false);
  });
});

describe("warehouseBlocker", () => {
  it("una guía anulada o transferida ya no se arma", () => {
    expect(warehouseBlocker({ delivery_status: "anulado" })).toBe("Guía anulada");
    expect(warehouseBlocker({ delivery_status: "transferido" })).toBe("Guía transferida");
  });

  it("si el courier ya la reporta en ruta o entregada, tampoco", () => {
    // Contradice el propio estado de la cola: la caja no está aquí.
    expect(warehouseBlocker({ delivery_status: "en_ruta" })).toBeTruthy();
    expect(warehouseBlocker({ delivery_status: "entregado" })).toBeTruthy();
  });

  it("lo pendiente y lo desconocido sí se arman", () => {
    expect(warehouseBlocker({ delivery_status: "pendiente" })).toBeNull();
    expect(warehouseBlocker({ delivery_status: null })).toBeNull();
    expect(warehouseBlocker({})).toBeNull();
    expect(warehouseBlocker({ delivery_status: "estado_nuevo" })).toBeNull();
  });

  describe("Olva con tracking registrado (06-11-2026)", () => {
    // Olva emite el tracking en el mostrador DESPUÉS de que la caja salió con su
    // rótulo: con tracking, la caja ya no está aquí. Eran 7 de las 10 detenidas
    // de agencia del 06-11-2026 (#KP141980 con 2804738-26, entre otras).
    const olva = { courier: "olva", delivery_status: "pendiente", olva_tracking: "2804738", olva_emision: "26" };

    it("se aparta con el tracking a la vista", () => {
      expect(warehouseBlocker({ ...olva, olva_status: "REGISTRADO" })).toBe("Ya salió con Olva (tracking 2804738-26)");
    });

    it("si el rastreo nunca lo reconoció, pide revisar el número en «Salidas y guías»", () => {
      const reason = warehouseBlocker({ ...olva, olva_status: null });
      expect(reason).toBe(
        "Ya salió con Olva (tracking 2804738-26). El rastreo de Olva todavía no reconoce ese número: revísalo en la ficha del pedido, en «Salidas y guías».",
      );
    });

    it("sin año guardado, enseña el número solo", () => {
      expect(warehouseBlocker({ ...olva, olva_emision: null, olva_status: "DESPACHADO" })).toBe(
        "Ya salió con Olva (tracking 2804738)",
      );
    });

    it("sin tracking sigue siendo armable", () => {
      expect(warehouseBlocker({ ...olva, olva_tracking: null })).toBeNull();
      expect(warehouseBlocker({ ...olva, olva_tracking: "  " })).toBeNull();
    });

    it("el tracking solo cuenta en una salida de Olva", () => {
      expect(warehouseBlocker({ ...olva, courier: "shalom" })).toBeNull();
      expect(warehouseBlocker({ ...olva, courier: "Olva" })).toBeTruthy();
    });

    it("un estado de guía que ya bloquea manda sobre el tracking", () => {
      expect(warehouseBlocker({ ...olva, delivery_status: "anulado" })).toBe("Guía anulada");
    });
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

  it("aparta la salida de Olva que ya tiene tracking y no la cuenta", () => {
    const queue = buildWarehouseQueue(
      [
        salida({ id: "olva-salio", operation: "agencia", courier: "olva", olva_tracking: "2804738", olva_emision: "26", created_at: daysAgo(20) }),
        salida({ id: "olva-aqui", operation: "agencia", courier: "olva", created_at: daysAgo(14) }),
      ],
      NOW,
    );
    expect(queue.total).toBe(1);
    expect(queue.stalled).toBe(1);
    expect(queue.blocked.map((b) => b.shipment.id)).toEqual(["olva-salio"]);
    expect(queue.blocked[0]?.reason).toContain("Ya salió con Olva (tracking 2804738-26)");
  });

  it("solo la detenida trae diagnóstico", () => {
    const queue = buildWarehouseQueue(
      [
        salida({ id: "hoy", created_at: daysAgo(0) }),
        salida({ id: "vieja", created_at: daysAgo(WAREHOUSE_STALE_DAYS) }),
      ],
      NOW,
    );
    const [vieja, hoy] = groupOf(queue, "lima").entries;
    expect(vieja?.diagnosis).toBe("Nadie la armó: rotúlala y escanéala, o avisa si falta stock.");
    expect(hoy?.diagnosis).toBeNull();
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

describe("stallDiagnosis", () => {
  const output = (over: Partial<WarehouseSiblingOutput> = {}): WarehouseSiblingOutput => ({
    id: over.id ?? "s01",
    courier: "tanders",
    delivery_status: "pendiente",
    custody_state: "empresa",
    created_at: daysAgo(20),
    output_code: "KP1-S01",
    ...over,
  });

  function diagnose(over: Partial<WarehouseQueueInput>, ageDays = 7): string {
    const shipment = { ...salida(), ...over };
    return stallDiagnosis({ shipment, closer: warehouseCloser(shipment.courier), ageDays });
  }

  describe("a) la salida anterior se anuló o volvió", () => {
    it("volvió a la oficina: rotular esa caja con esta salida", () => {
      const line = diagnose({
        courier: "propio",
        previousOutputs: [output({ courier: "tanders", delivery_status: "anulado", custody_state: "devuelto" })],
      });
      expect(line).toBe("Salida nueva: la anterior (Tanders) volvió a la oficina. Rotula esa caja con esta salida y escanéala.");
    });

    it("se anuló y viene de vuelta (#KP140302-S02, S01 de Swayp)", () => {
      const line = diagnose({
        courier: "propio",
        previousOutputs: [output({ courier: "fenix", delivery_status: "anulado", custody_state: "retorno" })],
      });
      expect(line).toBe(
        "Salida nueva: la anterior (Swayp) se anuló y viene de vuelta. Si la caja ya está en oficina, rotúlala con esta salida y escanéala.",
      );
    });

    it("anulada sin más", () => {
      const line = diagnose({ courier: "propio", previousOutputs: [output({ delivery_status: "anulado" })] });
      expect(line).toBe("Salida nueva: la anterior (Tanders) se anuló. Si la caja ya está en oficina, rotúlala con esta salida y escanéala.");
    });

    it("con courier por definir, primero elegirlo y después rotular (#KP138976-S02, #KP139613-S02)", () => {
      const line = diagnose({
        courier: "por_definir",
        previousOutputs: [output({ courier: "tanders", delivery_status: "anulado", custody_state: "devuelto" })],
      });
      expect(line).toBe(
        "Salida nueva: la anterior (Tanders) volvió a la oficina. Primero elige courier en Despacho; después rotula esa caja con esta salida y escanéala.",
      );
    });

    it("sin courier por estar vacío cuenta igual que «por definir»", () => {
      const line = diagnose({ courier: null, previousOutputs: [output({ delivery_status: "anulado" })] });
      expect(line).toBe(
        "Salida nueva: la anterior (Tanders) se anuló. Primero elige courier en Despacho; después si la caja ya está en oficina, rotúlala con esta salida y escanéala.",
      );
    });

    it("viene de vuelta sin estar anulada", () => {
      const line = diagnose({ courier: "propio", previousOutputs: [output({ delivery_status: "pendiente", custody_state: "retorno" })] });
      expect(line).toBe(
        "Salida nueva: la anterior (Tanders) viene de vuelta. Si la caja ya está en oficina, rotúlala con esta salida y escanéala.",
      );
    });

    it("si la anterior no tenía courier, no lo nombra", () => {
      const line = diagnose({ courier: "propio", previousOutputs: [output({ courier: null, delivery_status: "anulado" })] });
      expect(line).toBe("Salida nueva: la anterior se anuló. Si la caja ya está en oficina, rotúlala con esta salida y escanéala.");
      const undecided = diagnose({ courier: "propio", previousOutputs: [output({ courier: "por_definir", delivery_status: "anulado" })] });
      expect(undecided).toContain("la anterior se anuló.");
    });

    it("una salida nueva de Aliclik no se manda a escanear: la cierra su reporte", () => {
      const line = diagnose({ courier: "aliclik", previousOutputs: [output({ custody_state: "devuelto" })] });
      expect(line).toBe(
        "Salida nueva: la anterior (Tanders) volvió a la oficina. Rotula esa caja con esta salida; sale de la cola cuando Aliclik la reporte preparada.",
      );
      expect(line).not.toContain("escanéala");
    });

    it("con 30 días o más, además pide decidir", () => {
      const line = diagnose({ courier: "propio", previousOutputs: [output({ delivery_status: "anulado" })] }, 45);
      expect(line).toBe(
        "Salida nueva: la anterior (Tanders) se anuló. Si la caja ya está en oficina, rotúlala con esta salida y escanéala. 30 días o más sin armar: hay que decidir si sale o se cancela.",
      );
    });

    it("habla de la anterior fallida más reciente", () => {
      const line = diagnose({
        courier: "propio",
        previousOutputs: [
          output({ id: "s01", courier: "tanders", delivery_status: "anulado", created_at: daysAgo(30) }),
          output({ id: "s02", courier: "fenix", delivery_status: "anulado", created_at: daysAgo(10) }),
        ],
      });
      expect(line).toContain("la anterior (Swayp)");
    });

    it("solo mira la inmediatamente anterior: una anulada vieja seguida de una viva no explica esta", () => {
      const line = diagnose({
        courier: "propio",
        previousOutputs: [
          output({ id: "s01", courier: "tanders", delivery_status: "anulado", created_at: daysAgo(30) }),
          output({ id: "s02", courier: "propio", delivery_status: "en_ruta", custody_state: "courier", created_at: daysAgo(10) }),
        ],
      });
      expect(line).toBe("Nadie la armó: rotúlala y escanéala, o avisa si falta stock.");
    });

    it("una anterior viva no cuenta como fallida", () => {
      const line = diagnose({ courier: "propio", previousOutputs: [output({ delivery_status: "en_ruta", custody_state: "courier" })] });
      expect(line).toBe("Nadie la armó: rotúlala y escanéala, o avisa si falta stock.");
    });
  });

  it("b) sin courier: elegirlo en Despacho", () => {
    expect(diagnose({ courier: "por_definir" })).toBe("Sin courier: elígelo en Despacho para poder armarla.");
  });

  it("c) Aliclik sin PREPARED: revisar su portal (#KP141698)", () => {
    const line = diagnose({ operation: "provincia_cod", courier: "aliclik", reported_status: "PENDING_DELIVERY · TO_PREPARE · VALIDATED" });
    expect(line).toBe("Aliclik no la reporta preparada (TO_PREPARE): revisa en su portal si ya se empacó.");
  });

  it("c) Aliclik sin TO_PREPARE (o sin reporte) tampoco se manda a escanear: la cierra su reporte", () => {
    const expected = "Aliclik todavía no la reporta preparada: empácala si falta y, si ya está empacada, revísalo en su portal.";
    expect(diagnose({ courier: "aliclik", reported_status: null })).toBe(expected);
    expect(diagnose({ courier: "aliclik", reported_status: "PENDING_DELIVERY · IN_PROCESS" })).toBe(expected);
    expect(diagnose({ courier: "aliclik", reported_status: null })).not.toContain("escanéala");
  });

  it("c) con 30 días o más, además pide decidir", () => {
    expect(diagnose({ courier: "aliclik", reported_status: "PENDING_DELIVERY · TO_PREPARE · CONFIRMED" }, 31)).toBe(
      "Aliclik no la reporta preparada (TO_PREPARE): revisa en su portal si ya se empacó. 30 días o más sin armar: hay que decidir si sale o se cancela.",
    );
  });

  it("b) sin courier también cuando viene vacío", () => {
    expect(diagnose({ courier: null })).toBe("Sin courier: elígelo en Despacho para poder armarla.");
    expect(diagnose({ courier: "  " })).toBe("Sin courier: elígelo en Despacho para poder armarla.");
  });

  it("d) Olva sin tracking: registrarlo si ya salió (#KP143355)", () => {
    expect(diagnose({ operation: "agencia", courier: "olva", olva_tracking: null }, 14)).toBe(
      "Si ya salió, registra el tracking de Olva en la ficha del pedido, en «Salidas y guías»; si no, ármala.",
    );
  });

  it("e) 30 días o más: decidir si sale o se cancela (#KP122204-S01)", () => {
    expect(diagnose({ courier: "propio" }, 87)).toBe("30 días o más sin armar: hay que decidir si sale o se cancela.");
    expect(diagnose({ courier: "propio" }, WAREHOUSE_DECIDE_DAYS)).toContain("hay que decidir");
    expect(diagnose({ courier: "propio" }, WAREHOUSE_DECIDE_DAYS - 1)).not.toContain("hay que decidir");
  });

  it("e) se suma a la razón que haya, no la tapa (#KP127125, por definir 88 días)", () => {
    expect(diagnose({ courier: "por_definir" }, 88)).toBe(
      "Sin courier: elígelo en Despacho para poder armarla. 30 días o más sin armar: hay que decidir si sale o se cancela.",
    );
    expect(diagnose({ courier: "olva" }, 36)).toBe(
      "Si ya salió, registra el tracking de Olva en la ficha del pedido, en «Salidas y guías»; si no, ármala. 30 días o más sin armar: hay que decidir si sale o se cancela.",
    );
  });

  it("f) lo demás: nadie la armó", () => {
    expect(diagnose({ courier: "propio" })).toBe("Nadie la armó: rotúlala y escanéala, o avisa si falta stock.");
  });
});

describe("previousOutputsOf", () => {
  const sibling = (id: string, created_at: string | null): WarehouseSiblingOutput => ({
    id,
    courier: "tanders",
    delivery_status: "anulado",
    custody_state: "devuelto",
    created_at,
  });

  it("solo las creadas antes que esta, sin ella misma", () => {
    const own = { id: "s02", created_at: "2026-10-15T15:00:00+00:00" };
    const out = previousOutputsOf(own, [
      sibling("s01", "2026-10-10T15:00:00+00:00"),
      sibling("s02", "2026-10-15T15:00:00+00:00"),
      sibling("s03", "2026-10-20T15:00:00+00:00"),
      sibling("sin-fecha", null),
    ]);
    expect(out.map((o) => o.id)).toEqual(["s01"]);
  });

  it("sin fecha propia, todas las demás", () => {
    const out = previousOutputsOf({ id: "s02", created_at: null }, [sibling("s01", "2026-10-10T15:00:00Z"), sibling("s02", "2026-10-10T15:00:00Z")]);
    expect(out.map((o) => o.id)).toEqual(["s01"]);
  });
});
