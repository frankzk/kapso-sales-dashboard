import { describe, expect, it } from "vitest";
import { recomputeOrderMaster, recomputeOrderMasterSafe } from "@/lib/order-master";
import { MOM_RESOLUTION_VERSION } from "@/lib/order-macro-stage";

// Supabase se stubea a mano (convención del repo — ver test/ingest.test.ts): un
// `from(table)` que devuelve el conjunto de filas preparado para esa tabla y
// registra los upserts, para poder afirmar sobre la fila materializada.
interface Tables {
  orders?: any[];
  shipments?: any[];
  shipment_calls?: any[];
  order_events?: any[];
  peru_districts?: any[];
  draft_orders?: any[];
}

function stubAdmin(
  tables: Tables,
  opts: { shipmentColumnError?: boolean; coverage?: string; coverageError?: boolean } = {},
) {
  const upserts: any[][] = [];
  let shipmentSelects = 0;

  const admin = {
    from(table: string) {
      const rows: any[] = (tables as Record<string, any[]>)[table] ?? [];
      let failThisSelect = false;
      const builder: any = {
        select(columns: string) {
          if (table === "shipments") {
            shipmentSelects++;
            // Simula el desfase de despliegue: las columnas de gestión (0047)
            // todavía no existen, así que el primer intento falla.
            failThisSelect =
              Boolean(opts.shipmentColumnError) && columns.includes("pickup_state");
          }
          return builder;
        },
        in() {
          if (failThisSelect) return Promise.resolve({ data: null, error: { message: "column does not exist" } });
          return Promise.resolve({ data: rows, error: null });
        },
        eq() {
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return Promise.resolve({ data: rows, error: null });
        },
        upsert(batch: any[]) {
          upserts.push(batch);
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
    // Cobertura canónica (0104). Sin `opts.coverage` devuelve null por pedido,
    // que es como se comporta un destino que la base no sabe clasificar: quien
    // llama cae entonces a la clasificación por nombre.
    rpc(fn: string, args: any) {
      if (fn !== "order_coverage_batch") return Promise.resolve({ data: null, error: null });
      if (opts.coverageError) {
        return Promise.resolve({ data: null, error: { message: "function does not exist" } });
      }
      const rows = ((args?.p_rows ?? []) as any[]).map((probe) => ({
        order_id: probe.order_id,
        coverage: opts.coverage ?? null,
      }));
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return { admin: admin as any, upserts, shipmentSelects: () => shipmentSelects };
}

const NOW = "2026-07-20T12:00:00.000Z";

const ORDER = {
  id: "order-1",
  store_id: "store-a",
  shopify_order_id: "9001",
  name: "#KP114985",
  created_at: "2026-07-01T10:00:00.000Z",
  cancelled_at: null,
  financial_status: "pending",
  shipping_mode: "cod",
  customer_phone: "51987654321",
  total_amount: 149.9,
  raw: {
    shippingAddress: {
      address1: "Av. Siempre Viva 123",
      address2: null,
      city: "El Tambo",
      province: "Junín",
      name: "Ana Quispe",
      phone: "987654321",
    },
  },
};

async function recompute(
  tables: Tables,
  opts: { shipmentColumnError?: boolean; coverage?: string; coverageError?: boolean } = {},
) {
  const stub = stubAdmin(tables, opts);
  const result = await recomputeOrderMaster(stub.admin, ["order-1"], { now: NOW });
  return { result, row: stub.upserts[0]?.[0], upserts: stub.upserts, stub };
}

describe("recomputeOrderMaster — snapshot del pedido", () => {
  it("denormaliza cliente, teléfono y dirección desde orders.raw", async () => {
    const { row, result } = await recompute({ orders: [ORDER] });
    expect(result).toEqual({ requested: 1, written: 1 });
    expect(row).toMatchObject({
      store_id: "store-a",
      order_id: "order-1",
      order_name: "#KP114985",
      customer_name: "Ana Quispe",
      customer_phone: "51987654321",
      district: "El Tambo",
      region: "Junín",
      order_total: 149.9,
    });
  });

  it("un pedido sin gestión queda pendiente y sin couriers", async () => {
    const { row } = await recompute({ orders: [ORDER] });
    expect(row.general_status).toBe("pendiente");
    expect(row.operational_status).toBe("sin_confirmar");
    expect(row.macro_stage).toBe("por_confirmar");
    expect(row.macro_substage).toBe("sin_llamar");
    // Contra la constante, no contra un literal: lo que importa es que la fila
    // quede sellada con la versión VIGENTE del resolvedor. Si se escribiera otra,
    // el cron la volvería a tomar como pendiente en cada pasada, para siempre.
    expect(row.macro_version).toBe(MOM_RESOLUTION_VERSION);
    expect(row.courier_count).toBe(0);
    expect(row.attempt_count).toBe(0);
    expect(row.status_locked).toBe(false);
  });

  // La cobertura la decide `order_coverage_for` en la base, no una segunda
  // implementación en TypeScript. La de TS solo casa nombres de tarifa, así que
  // en un destino cubierto por el mapa de puntos COD (0100) —Puerto Maldonado
  // por Aliclik es el caso real— devolvía `agencia` mientras la columna decía
  // `provincia_cod`. La fila se contradecía y, como Agencia sí exige abono
  // validado, el pedido quedaba congelado en «Por confirmar» pese a tener guía.
  it("toma la cobertura de la base, no de la clasificación por nombre", async () => {
    const { row } = await recompute(
      { orders: [ORDER], shipments: [{ id: "s-1", order_id: "order-1", courier: "aliclik" }] },
      { coverage: "provincia_cod" },
    );
    expect(row.macro_operation).toBe("provincia_cod");
    // Con la operación correcta el abono deja de aplicar y el pedido avanza:
    // ya tiene guía, así que le toca Preparación.
    expect(row.macro_stage).toBe("preparacion");
  });

  it("cae a la clasificación por nombre si la 0104 no está aplicada", async () => {
    const { row, result } = await recompute(
      { orders: [ORDER], shipments: [{ id: "s-1", order_id: "order-1", courier: "aliclik" }] },
      { coverageError: true },
    );
    expect(result).toEqual({ requested: 1, written: 1 });
    expect(row.macro_version).toBe(MOM_RESOLUTION_VERSION);
  });

  it("calcula Lima nuevo como Preparación sin cambiar el estado legado", async () => {
    const lima = {
      ...ORDER,
      raw: {
        shippingAddress: {
          address1: "Av. La Marina 123",
          address2: "Frente al parque",
          city: "San Miguel",
          province: "Lima",
          name: "Ana Quispe",
          phone: "987654321",
        },
      },
    };
    const { row } = await recompute({ orders: [lima] });
    expect(row.general_status).toBe("pendiente");
    expect(row.operational_status).toBe("sin_confirmar");
    expect(row.macro_stage).toBe("preparacion");
    expect(row.macro_substage).toBe("por_generar_rotulo");
  });

  it("no escribe nada cuando el pedido no existe", async () => {
    const { result, upserts } = await recompute({ orders: [] });
    expect(result).toEqual({ requested: 1, written: 0 });
    expect(upserts).toHaveLength(0);
  });

  it("una lista vacía no consulta nada", async () => {
    const stub = stubAdmin({});
    expect(await recomputeOrderMaster(stub.admin, [])).toEqual({ requested: 0, written: 0 });
  });
});

describe("recomputeOrderMaster — provincia (§13)", () => {
  it("resuelve la provincia por el ubigeo cuando Shopify no la trae", async () => {
    const { row } = await recompute({
      orders: [ORDER],
      peru_districts: [{ district_key: "el tambo", province: "Huancayo", department: "Junín" }],
    });
    expect(row.province).toBe("Huancayo");
  });

  it("la provincia del reporte del courier manda sobre la inferida", async () => {
    const { row } = await recompute({
      orders: [ORDER],
      peru_districts: [{ district_key: "el tambo", province: "Huancayo", department: "Junín" }],
      shipments: [
        {
          id: "s1",
          order_id: "order-1",
          store_id: "store-a",
          courier: "aliclik",
          guide_code: "AUR5XA",
          delivery_status: "pendiente",
          status_category: "pending",
          aliclik_attempts: null,
          reroute_attempts: 0,
          delivered_source: null,
          district: "El Tambo",
          province: "Concepción",
          region: "Junín",
          customer_name: null,
          customer_phone: null,
          created_at: "2026-07-02T10:00:00.000Z",
          updated_at: "2026-07-02T10:00:00.000Z",
        },
      ],
    });
    expect(row.province).toBe("Concepción");
  });

  it("sin ubigeo sembrado el Master sigue funcionando, solo sin provincia", async () => {
    const { row } = await recompute({ orders: [ORDER] });
    expect(row.province).toBeNull();
    expect(row.district).toBe("El Tambo");
  });
});

describe("recomputeOrderMaster — rollup logístico", () => {
  const guide = (over: Record<string, unknown> = {}) => ({
    id: "s1",
    order_id: "order-1",
    store_id: "store-a",
    courier: "aliclik",
    guide_code: "AUR5XA",
    delivery_status: "pendiente",
    status_category: "pending",
    aliclik_attempts: null,
    reroute_attempts: 0,
    delivered_source: null,
    district: null,
    province: null,
    region: null,
    customer_name: null,
    customer_phone: null,
    created_at: "2026-07-02T10:00:00.000Z",
    updated_at: "2026-07-02T10:00:00.000Z",
    ...over,
  });

  it("cuenta couriers e intentos a través de varias guías", async () => {
    const { row } = await recompute({
      orders: [ORDER],
      shipments: [
        guide({ id: "s1", delivery_status: "transferido", aliclik_attempts: 2 }),
        guide({ id: "s2", courier: "fenix", guide_code: "FNX1", reroute_attempts: 1 }),
      ],
    });
    expect(row.courier_count).toBe(2);
    expect(row.attempt_count).toBe(3);
    expect(row.general_status).toBe("en_proceso");
    expect(row.current_courier).toBe("fenix");
    expect(row.guide_code).toBe("FNX1");
  });

  it("deriva la fecha de despacho del historial de gestiones", async () => {
    // Antes de 0047 la guía no tiene columna de despacho: el primer paso a
    // "en_ruta" registrado en shipment_calls es la fecha real de salida.
    const { row } = await recompute({
      orders: [ORDER],
      shipments: [guide({ delivery_status: "en_ruta" })],
      shipment_calls: [
        { shipment_id: "s1", kind: "state_change", new_status: "en_ruta", occurred_at: "2026-07-04T09:00:00.000Z" },
        { shipment_id: "s1", kind: "state_change", new_status: "en_ruta", occurred_at: "2026-07-11T09:00:00.000Z" },
      ],
    });
    expect(row.dispatched_at).toBe("2026-07-04T09:00:00.000Z");
  });

  it("una gestión registrada por el equipo cuenta como movimiento del pedido", async () => {
    const { row } = await recompute({
      orders: [ORDER],
      shipments: [guide()],
      shipment_calls: [
        { shipment_id: "s1", kind: "call", new_status: null, occurred_at: "2026-07-15T09:00:00.000Z" },
      ],
    });
    expect(row.last_movement_at).toBe("2026-07-15T09:00:00.000Z");
  });

  it("atribuye la entrega al courier que la reportó", async () => {
    const { row } = await recompute({
      orders: [ORDER],
      shipments: [
        guide({ id: "s1", delivery_status: "anulado" }),
        guide({ id: "s2", courier: "fenix", guide_code: "FNX1", delivery_status: "entregado" }),
      ],
      shipment_calls: [
        { shipment_id: "s2", kind: "state_change", new_status: "entregado", occurred_at: "2026-07-09T15:00:00.000Z" },
      ],
    });
    expect(row.general_status).toBe("entregado");
    expect(row.delivered_courier).toBe("fenix");
    expect(row.delivered_at).toBe("2026-07-09T15:00:00.000Z");
  });
});

describe("recomputeOrderMaster — eventos del Master", () => {
  it("cuenta los comentarios", async () => {
    const { row } = await recompute({
      orders: [ORDER],
      order_events: [
        { order_id: "order-1", kind: "comment", occurred_at: "2026-07-05T10:00:00.000Z", courier: null, new_status: null, new_operational: null },
        { order_id: "order-1", kind: "comment", occurred_at: "2026-07-06T10:00:00.000Z", courier: null, new_status: null, new_operational: null },
        { order_id: "order-1", kind: "created", occurred_at: "2026-07-01T10:00:00.000Z", courier: null, new_status: null, new_operational: null },
      ],
    });
    expect(row.comment_count).toBe(2);
  });

  it("un override manual congela el estado y queda marcado", async () => {
    const { row } = await recompute({
      orders: [ORDER],
      order_events: [
        {
          order_id: "order-1",
          kind: "status_override",
          occurred_at: "2026-07-16T10:00:00.000Z",
          courier: null,
          new_status: "devuelto",
          new_operational: "devuelto_al_origen",
        },
      ],
    });
    expect(row.general_status).toBe("devuelto");
    expect(row.status_locked).toBe(true);
    expect(row.status_source).toBe("manual");
  });

  it("gana el override más reciente", async () => {
    const { row } = await recompute({
      orders: [ORDER],
      order_events: [
        { order_id: "order-1", kind: "status_override", occurred_at: "2026-07-10T10:00:00.000Z", courier: null, new_status: "anulado", new_operational: null },
        { order_id: "order-1", kind: "status_override", occurred_at: "2026-07-16T10:00:00.000Z", courier: null, new_status: "en_proceso", new_operational: null },
      ],
    });
    expect(row.general_status).toBe("en_proceso");
  });

  it("un override con un estado inválido se ignora", async () => {
    const { row } = await recompute({
      orders: [ORDER],
      order_events: [
        { order_id: "order-1", kind: "status_override", occurred_at: "2026-07-16T10:00:00.000Z", courier: null, new_status: "inventado", new_operational: null },
      ],
    });
    expect(row.general_status).toBe("pendiente");
    expect(row.status_locked).toBe(false);
  });
});

describe("recomputeOrderMaster — robustez", () => {
  it("cae al conjunto de columnas antiguo si 0047 aún no se aplicó", async () => {
    const { row, stub } = await recompute(
      { orders: [ORDER], shipments: [] },
      { shipmentColumnError: true },
    );
    // Reintentó con el conjunto reducido y siguió adelante.
    expect(stub.shipmentSelects()).toBeGreaterThan(1);
    expect(row.general_status).toBe("pendiente");
  });

  it("recomputeOrderMasterSafe no propaga errores, pero los CUENTA", async () => {
    // Seguir sin lanzar es lo correcto —el import ya está ingestado y no se
    // deshace porque el Master falle—, pero durante un tiempo eso significó que
    // nadie se enteraba: el 09-08 se congelaron 1.125 pedidos y el import salió
    // «procesado». El fallo ya no desaparece: vuelve en `failed` (0118).
    const explodingAdmin = {
      from() {
        return {
          select() {
            return this;
          },
          in() {
            return Promise.resolve({ data: null, error: { message: "boom" } });
          },
        };
      },
    } as any;
    await expect(recomputeOrderMasterSafe(explodingAdmin, ["order-1"])).resolves.toEqual({
      requested: 1,
      written: 0,
      failed: 1,
    });
  });
});
