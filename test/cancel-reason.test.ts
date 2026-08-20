import { describe, expect, it } from "vitest";
import { mapRestOrder, mapGraphqlOrder, normalizeCancelReason } from "@/lib/shopify";
import { upsertOrders } from "@/lib/ingest";

// EL MOTIVO DE ANULACIÓN (0125).
//
// Se ingería `cancelled_at` pero nunca `cancelReason`, así que un pedido anulado
// decía CUÁNDO murió y no POR QUÉ. Medido en Cajamarca sobre 90 días: 140 de 421
// pedidos se anularon sin llegar a generar guía —más que las 50 devoluciones— y
// 135 sin un solo evento en la aplicación. Ocho días de media persiguiéndolos,
// para acabar sin saber la causa.
//
// LO QUE SE FIJA ACÁ es la trampa de este campo: llega con DOS grafías según la
// puerta por la que entre, y si se guardan las dos, media consulta se queda
// fuera sin avisar.

describe("normalizeCancelReason — una sola grafía para el mismo motivo", () => {
  it("baja a minúscula lo que GraphQL manda en mayúscula", () => {
    expect(normalizeCancelReason("CUSTOMER")).toBe("customer");
    expect(normalizeCancelReason("INVENTORY")).toBe("inventory");
  });

  it("deja como está lo que REST ya manda en minúscula", () => {
    expect(normalizeCancelReason("declined")).toBe("declined");
  });

  it("un motivo ausente o vacío es null, no cadena vacía", () => {
    // Si se guardara "", un `where cancel_reason is not null` contaría pedidos
    // que no tienen motivo, y el recuento de «ciegos» saldría mal.
    expect(normalizeCancelReason(null)).toBeNull();
    expect(normalizeCancelReason(undefined)).toBeNull();
    expect(normalizeCancelReason("")).toBeNull();
    expect(normalizeCancelReason("   ")).toBeNull();
  });

  it("no valida contra una lista cerrada", () => {
    // Es el vocabulario de Shopify, no el nuestro: si añaden un valor, se lee
    // igual de bien como texto en vez de romper la ingesta.
    expect(normalizeCancelReason("MOTIVO_NUEVO")).toBe("motivo_nuevo");
  });
});

describe("los dos mapeadores guardan el mismo motivo", () => {
  it("REST: cancel_reason en minúscula", () => {
    const row = mapRestOrder(
      { id: 1, name: "#KP1", cancelled_at: "2026-08-01T00:00:00Z", cancel_reason: "customer" },
      "store-a",
    );
    expect(row.cancel_reason).toBe("customer");
  });

  it("GraphQL: cancelReason en MAYÚSCULA acaba igual que el de REST", () => {
    // La prueba que importa: la misma anulación por dos puertas distintas tiene
    // que quedar guardada idéntica.
    const row = mapGraphqlOrder(
      {
        id: "gid://shopify/Order/1",
        name: "#KP1",
        cancelledAt: "2026-08-01T00:00:00Z",
        cancelReason: "CUSTOMER",
      },
      "store-a",
    );
    expect(row.cancel_reason).toBe("customer");
  });

  it("un pedido vivo no inventa motivo", () => {
    expect(mapRestOrder({ id: 1, name: "#KP1" }, "store-a").cancel_reason).toBeNull();
    expect(
      mapGraphqlOrder({ id: "gid://shopify/Order/1", name: "#KP1" }, "store-a").cancel_reason,
    ).toBeNull();
  });
});

// ── Que una migración sin aplicar no tire la ingesta entera ─────────────────
//
// Desplegar NO aplica migraciones, así que hay una ventana —a veces de días— en
// la que el código escribe una columna que la base todavía no tiene. Sin
// escalón, ese upsert falla y se lleva por delante TODOS los pedidos de la
// pasada: se pierde el pedido completo por un campo accesorio.
//
// Esto ya existía para `discount_codes` con un `if` a medida. Al añadir
// `cancel_reason` el segundo caso demuestra que no era una excepción, y por eso
// ahora es una lista — y por eso tiene prueba, que antes no tenía.

describe("upsertOrders — la columna que la base aún no tiene", () => {
  const fakeAdmin = (columnasQueFaltan: string[]) => {
    const intentos: Record<string, unknown>[][] = [];
    return {
      intentos,
      admin: {
        from() {
          return {
            upsert(rows: Record<string, unknown>[]) {
              intentos.push(rows);
              const falta = columnasQueFaltan.find((c) => rows.some((r) => c in r));
              return Promise.resolve(
                falta
                  ? { error: { message: `column "${falta}" of relation "orders" does not exist` } }
                  : { error: null },
              );
            },
          };
        },
      } as any,
    };
  };

  const pedido = () =>
    ({
      store_id: "s1",
      shopify_order_id: "1",
      name: "#KP1",
      discount_codes: ["X"],
      cancel_reason: "customer",
    }) as any;

  it("reintenta sin la columna que falta y el pedido entra igual", async () => {
    const { admin, intentos } = fakeAdmin(["cancel_reason"]);
    await upsertOrders(admin, [pedido()]);
    expect(intentos).toHaveLength(2);
    expect("cancel_reason" in intentos[1]![0]!).toBe(false);
    // Lo demás sobrevive: se pierde el campo accesorio, no el pedido.
    expect(intentos[1]![0]!.name).toBe("#KP1");
    expect(intentos[1]![0]!.discount_codes).toEqual(["X"]);
  });

  it("aguanta que falten VARIAS, que es lo que el `if` a medida no hacía", async () => {
    const { admin, intentos } = fakeAdmin(["discount_codes", "cancel_reason"]);
    await upsertOrders(admin, [pedido()]);
    expect(intentos.at(-1)![0]!.name).toBe("#KP1");
    expect("cancel_reason" in intentos.at(-1)![0]!).toBe(false);
    expect("discount_codes" in intentos.at(-1)![0]!).toBe(false);
  });

  it("un error que NO es de columna sí revienta", async () => {
    // Quitar columnas no puede convertirse en tragarse cualquier fallo: una
    // caída de la base tiene que verse.
    const admin = {
      from: () => ({ upsert: () => Promise.resolve({ error: { message: "connection refused" } }) }),
    } as any;
    await expect(upsertOrders(admin, [pedido()])).rejects.toThrow(/connection refused/);
  });
});
