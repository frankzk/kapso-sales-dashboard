import { describe, expect, it } from "vitest";
import { sweepResolvedAlerts, sweepUnattributedAlerts } from "@/lib/collection-alerts-access";

/**
 * El caso real: #KP134730, pago validado a las 22:42 del 20-09-2026 y su alerta
 * todavía en la cola cinco horas después. El cierre al validar es un empujón al
 * final de `validatePayment`, y un empujón se puede perder; el pago validado no
 * se pierde, porque ya está escrito. Así que el hecho se comprueba al LEER.
 */
interface Alerta {
  id: string;
  payment_id: string;
}

function fakeAdmin(alertas: Alerta[], pagos: Record<string, string>) {
  const updates: { ids: string[]; patch: Record<string, unknown> }[] = [];
  const admin: any = {
    updates,
    from(table: string) {
      const chain: any = {
        _ids: [] as string[],
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        limit: () =>
          Promise.resolve({
            data: table === "collection_alerts" ? alertas : [],
            error: null,
          }),
        in(_col: string, ids: string[]) {
          chain._ids = ids;
          if (chain._patch) {
            // `.in(...).eq(...)` en el update: se anota y se devuelve la cadena,
            // que es «then-able» para que el await la resuelva.
            updates.push({ ids, patch: chain._patch });
            return chain;
          }
          return Promise.resolve({
            data: ids.map((id) => ({ id, validation_status: pagos[id] ?? "pendiente_revision" })),
            error: null,
          });
        },
        update(patch: Record<string, unknown>) {
          chain._patch = patch;
          return chain;
        },
        then(res: (v: { error: null }) => unknown) {
          return Promise.resolve({ error: null }).then(res);
        },
      };
      return chain;
    },
  };
  return admin;
}

describe("la cola se limpia sola de trabajo ya hecho", () => {
  it("retira la alerta de un pago que ya se validó", async () => {
    const admin = fakeAdmin([{ id: "al-1", payment_id: "pay-1" }], { "pay-1": "validado" });
    expect(await sweepResolvedAlerts(admin, "store-1", "2026-09-21T03:00:00Z")).toBe(1);
    expect(admin.updates[0].ids).toEqual(["al-1"]);
    expect(admin.updates[0].patch).toMatchObject({ status: "atendida" });
  });

  it("también la de un pago rechazado: la decisión ya se tomó", async () => {
    const admin = fakeAdmin([{ id: "al-1", payment_id: "pay-1" }], { "pay-1": "rechazado" });
    expect(await sweepResolvedAlerts(admin, "store-1", "2026-09-21T03:00:00Z")).toBe(1);
  });

  it("NO retira lo que sigue esperando a una persona", async () => {
    // Es la mitad del asunto: barrer de más vaciaría la cola de trabajo real.
    const pendientes = fakeAdmin([{ id: "al-1", payment_id: "pay-1" }], {
      "pay-1": "pendiente_revision",
    });
    expect(await sweepResolvedAlerts(pendientes, "store-1", "2026-09-21T03:00:00Z")).toBe(0);
    expect(pendientes.updates).toHaveLength(0);

    const incompletos = fakeAdmin([{ id: "al-2", payment_id: "pay-2" }], {
      "pay-2": "info_incompleta",
    });
    expect(await sweepResolvedAlerts(incompletos, "store-1", "2026-09-21T03:00:00Z")).toBe(0);
  });

  it("un pago que ya no existe no se da por resuelto", async () => {
    // Sin fila no hay decisión que leer: dejarla abierta hace que alguien mire,
    // que es lo correcto cuando no se sabe.
    const admin = fakeAdmin([{ id: "al-1", payment_id: "pay-desaparecido" }], {});
    admin.from = ((orig) => (table: string) => {
      const chain = orig(table);
      if (table === "order_payments") {
        chain.in = () => Promise.resolve({ data: [], error: null });
      }
      return chain;
    })(admin.from);
    expect(await sweepResolvedAlerts(admin, "store-1", "2026-09-21T03:00:00Z")).toBe(0);
  });

  it("sin alertas abiertas no toca nada", async () => {
    const admin = fakeAdmin([], {});
    expect(await sweepResolvedAlerts(admin, "store-1", "2026-09-21T03:00:00Z")).toBe(0);
    expect(admin.updates).toHaveLength(0);
  });
});

/**
 * El otro barrido: la alerta «no se pudo registrar» de un celular que ya no
 * debe nada. Esmeralda (#KP134470) tenía el pedido pagado, validado y con la
 * clave enviada, y su alerta seguía escalando de persona en persona.
 */
function fakeAdminSinAtribuir(
  alertas: { id: string; phone: string }[],
  pedidos: { id: string; total_amount: number | null }[],
  pagos: { order_id: string; amount: number; validation_status: string }[],
) {
  const updates: { ids: string[]; patch: Record<string, unknown> }[] = [];
  const admin: any = {
    updates,
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () =>
          Promise.resolve({
            data: table === "collection_alerts" ? alertas : pedidos,
            error: null,
          }),
        in(ids: string[] | string, arg?: string[]) {
          const lista = Array.isArray(ids) ? ids : (arg ?? []);
          if (chain._patch) {
            updates.push({ ids: lista, patch: chain._patch });
            return chain;
          }
          return Promise.resolve({ data: pagos, error: null });
        },
        update(patch: Record<string, unknown>) {
          chain._patch = patch;
          return chain;
        },
        then(res: (v: { error: null }) => unknown) {
          return Promise.resolve({ error: null }).then(res);
        },
      };
      return chain;
    },
  };
  return admin;
}

describe("la alerta «no se pudo registrar» de quien ya no debe nada", () => {
  const ALERTA = [{ id: "al-1", phone: "51950636635" }];

  it("se retira cuando el pedido de ese celular ya está cubierto", async () => {
    const admin = fakeAdminSinAtribuir(ALERTA, [{ id: "ord-1", total_amount: 134.1 }], [
      { order_id: "ord-1", amount: 30, validation_status: "validado" },
      { order_id: "ord-1", amount: 104.1, validation_status: "validado" },
    ]);
    expect(await sweepUnattributedAlerts(admin, "store-1", "2026-09-21T16:00:00Z")).toBe(1);
    expect(admin.updates[0].patch).toMatchObject({ status: "atendida" });
  });

  it("cuenta lo CARGADO, no solo lo validado: la alerta pedía que entrara", async () => {
    const admin = fakeAdminSinAtribuir(ALERTA, [{ id: "ord-1", total_amount: 134.1 }], [
      { order_id: "ord-1", amount: 30, validation_status: "validado" },
      { order_id: "ord-1", amount: 104.1, validation_status: "pendiente_revision" },
    ]);
    expect(await sweepUnattributedAlerts(admin, "store-1", "2026-09-21T16:00:00Z")).toBe(1);
  });

  it("un comprobante RECHAZADO no cubre nada", async () => {
    const admin = fakeAdminSinAtribuir(ALERTA, [{ id: "ord-1", total_amount: 134.1 }], [
      { order_id: "ord-1", amount: 30, validation_status: "validado" },
      { order_id: "ord-1", amount: 104.1, validation_status: "rechazado" },
    ]);
    expect(await sweepUnattributedAlerts(admin, "store-1", "2026-09-21T16:00:00Z")).toBe(0);
  });

  it("si todavía debe, se queda: es trabajo de verdad", async () => {
    const admin = fakeAdminSinAtribuir(ALERTA, [{ id: "ord-1", total_amount: 134.1 }], [
      { order_id: "ord-1", amount: 30, validation_status: "validado" },
    ]);
    expect(await sweepUnattributedAlerts(admin, "store-1", "2026-09-21T16:00:00Z")).toBe(0);
    expect(admin.updates).toHaveLength(0);
  });

  it("sin NINGÚN pedido de ese celular se queda: ahí sí no se sabe quién pagó", async () => {
    // Es el caso para el que la alerta existe. Barrerlo sería vaciar la cola
    // justo de lo único que nadie puede resolver solo.
    const admin = fakeAdminSinAtribuir(ALERTA, [], []);
    expect(await sweepUnattributedAlerts(admin, "store-1", "2026-09-21T16:00:00Z")).toBe(0);
  });
});
