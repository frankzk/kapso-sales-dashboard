import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  confirmFlowPayment,
  describeFlowPayment,
  paidAmountOf,
} from "@/lib/flow/confirm";
import type { FlowClient } from "@/lib/flow/client";
import type { FlowPaymentStatus } from "@/lib/flow/types";

/**
 * La confirmación de un pago de Flow.
 *
 * LO QUE SE PROTEGE ACÁ es que el dinero no se invente ni se pierda:
 *  · no se cree el aviso (que llega sin firma y sin monto),
 *  · la misma entrega dos veces no crea dos comprobantes,
 *  · y si el comprobante no se puede registrar, el cobro queda MARCADO en vez
 *    de devolver «ok» y desaparecer.
 */

/** Un link vivo, sin pagar todavía. */
function link(over: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    store_id: "store-1",
    order_id: "order-1",
    commerce_order: "ADEL-1042",
    kind: "adelanto",
    amount: 20,
    currency: "PEN",
    status: "creado",
    payment_id: null,
    ...over,
  };
}

/** Lo que devuelve payment/getStatus para un cobro pagado por Yape. */
function statusPagado(over: Partial<FlowPaymentStatus> = {}): FlowPaymentStatus {
  return {
    flowOrder: 181182854,
    commerceOrder: "ADEL-1042",
    requestDate: "2026-09-12 15:01:00",
    status: 2,
    subject: "Adelanto pedido",
    currency: "PEN",
    amount: 20,
    payer: "cliente@correo.pe",
    paymentData: { date: "2026-09-12 15:03:11", media: "Yape", amount: 20, fee: 0.83, balance: 19.17 },
    ...over,
  };
}

function fakeAdmin(opts: { link?: Record<string, unknown> | null; insertError?: string } = {}) {
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];

  const from = (table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: opts.link ?? null, error: null }),
      }),
    }),
    update: (patch: Record<string, unknown>) => ({
      eq: async () => {
        updates.push({ table, patch });
        return { error: null };
      },
    }),
    insert: (row: Record<string, unknown>) => ({
      select: () => ({
        single: async () => {
          inserts.push({ table, row });
          return opts.insertError
            ? { data: null, error: { message: opts.insertError } }
            : { data: { id: "pago-1" }, error: null };
        },
      }),
    }),
  });

  return { admin: { from } as unknown as SupabaseClient, updates, inserts };
}

function fakeClient(status: FlowPaymentStatus) {
  const getStatus = vi.fn(async () => status);
  return { client: { getStatus } as unknown as FlowClient, getStatus };
}

describe("no se cree el aviso", () => {
  it("consulta a Flow antes de escribir nada", async () => {
    const { admin, inserts } = fakeAdmin({ link: link() });
    const { client, getStatus } = fakeClient(statusPagado());

    await confirmFlowPayment("TOK", { admin, client });

    expect(getStatus).toHaveBeenCalledWith("TOK");
    // Y lo que se escribe sale de ahí, no del aviso.
    expect(inserts[0]?.row.amount).toBe(20);
  });

  it("un aviso sin token no llega a la base", async () => {
    const { admin } = fakeAdmin({ link: link() });
    const { client, getStatus } = fakeClient(statusPagado());
    const res = await confirmFlowPayment("", { admin, client });
    expect(res.outcome).toBe("desconocido");
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("un token que no es nuestro no es un error: no hay nada que hacer", async () => {
    // Devolver 5xx haría que Flow reintentara para siempre un token ajeno.
    const { admin } = fakeAdmin({ link: null });
    const { client, getStatus } = fakeClient(statusPagado());
    const res = await confirmFlowPayment("TOK-AJENO", { admin, client });
    expect(res.outcome).toBe("desconocido");
    expect(getStatus).not.toHaveBeenCalled();
  });
});

describe("idempotencia", () => {
  it("la misma entrega dos veces no crea dos comprobantes", async () => {
    // Flow reentrega; el link ya tiene su pago.
    const { admin, inserts } = fakeAdmin({ link: link({ payment_id: "pago-1" }) });
    const { client, getStatus } = fakeClient(statusPagado());

    const res = await confirmFlowPayment("TOK", { admin, client });

    expect(res.outcome).toBe("duplicado");
    expect(res.paymentId).toBe("pago-1");
    expect(inserts).toHaveLength(0);
    // Ni siquiera se molesta en preguntar: ya está resuelto.
    expect(getStatus).not.toHaveBeenCalled();
  });
});

describe("cuando Flow dice que NO está pagada", () => {
  it("pendiente: no crea comprobante y guarda lo que dijo", async () => {
    const { admin, inserts, updates } = fakeAdmin({ link: link() });
    const { client } = fakeClient(statusPagado({ status: 1, paymentData: null }));

    const res = await confirmFlowPayment("TOK", { admin, client });

    expect(res.outcome).toBe("sin_pagar");
    expect(inserts).toHaveLength(0);
    expect(updates[0]?.patch.status).toBe("creado");
    expect(updates[0]?.patch.flow_status).toBe(1);
  });

  it("rechazada y anulada quedan con ese estado en el link", async () => {
    for (const [flowStatus, esperado] of [
      [3, "rechazado"],
      [4, "anulado"],
    ] as const) {
      const { admin, updates } = fakeAdmin({ link: link() });
      const { client } = fakeClient(statusPagado({ status: flowStatus, paymentData: null }));
      const res = await confirmFlowPayment("TOK", { admin, client });
      expect(res.outcome).toBe("sin_pagar");
      expect(updates[0]?.patch.status).toBe(esperado);
    }
  });
});

describe("cuando Flow confirma el pago", () => {
  it("crea el comprobante pendiente de revisión y lo ata al link", async () => {
    const { admin, inserts, updates } = fakeAdmin({ link: link() });
    const { client } = fakeClient(statusPagado());

    const res = await confirmFlowPayment("TOK", { admin, client });

    expect(res.outcome).toBe("registrado");
    expect(res.paymentId).toBe("pago-1");

    const pago = inserts[0]!;
    expect(pago.table).toBe("order_payments");
    expect(pago.row).toMatchObject({
      store_id: "store-1",
      order_id: "order-1",
      kind: "adelanto",
      amount: 20,
      paid_at: "2026-09-12 15:03:11",
    });
    // NO se fija `validation_status`: se queda en `pendiente_revision`, que es
    // el valor por omisión de la tabla. Un cobro por pasarela entra a la cola
    // como cualquier otro comprobante.
    expect(pago.row).not.toHaveProperty("validation_status");
    // Sin imagen que mirar, el drawer necesita leer de dónde salió.
    expect(String(pago.row.notes)).toMatch(/Flow.*181182854/);

    const patch = updates.at(-1)!.patch;
    expect(patch.status).toBe("pagado");
    expect(patch.payment_id).toBe("pago-1");
    expect(patch.register_error).toBeNull();
  });

  it("registra lo que se PAGÓ, no lo que pedimos", async () => {
    // Si entró otra cifra, lo que consta tiene que ser la que entró. Dar por
    // cobrado el importe pedido es no enterarse nunca de una diferencia.
    const { admin, inserts } = fakeAdmin({ link: link({ amount: 20 }) });
    const { client } = fakeClient(
      statusPagado({ amount: 20, paymentData: { date: null, media: "Yape", amount: 18.5 } }),
    );

    await confirmFlowPayment("TOK", { admin, client });
    expect(inserts[0]?.row.amount).toBe(18.5);
  });
});

describe("cuando el comprobante no cabe", () => {
  it("el dinero queda MARCADO en el link, no se traga el error", async () => {
    // `order_payments_kind_uniq` permite un solo adelanto vivo por pedido: si
    // alguien subió un Yape mientras tanto, el insert falla. El pago existe.
    const { admin, updates } = fakeAdmin({
      link: link(),
      insertError: 'duplicate key value violates unique constraint "order_payments_kind_uniq"',
    });
    const { client } = fakeClient(statusPagado());

    const res = await confirmFlowPayment("TOK", { admin, client });

    expect(res.outcome).toBe("sin_registrar");
    expect(res.paymentId).toBeUndefined();

    const patch = updates.at(-1)!.patch;
    // Pagado, sí: Flow lo confirmó. Pero con el motivo escrito al lado.
    expect(patch.status).toBe("pagado");
    expect(String(patch.register_error)).toMatch(/order_payments_kind_uniq/);
    expect(patch.payment_id).toBeUndefined();
  });
});

describe("paidAmountOf", () => {
  it("prefiere el monto pagado sobre el de la orden", () => {
    expect(paidAmountOf(statusPagado({ amount: 20, paymentData: { amount: 18.5 } }))).toBe(18.5);
  });

  it("cae al de la orden si Flow no detalla el pago", () => {
    expect(paidAmountOf(statusPagado({ amount: 20, paymentData: null }))).toBe(20);
  });

  it("devuelve null antes que un número inventado", () => {
    expect(
      paidAmountOf(statusPagado({ amount: undefined as never, paymentData: null })),
    ).toBeNull();
  });
});

describe("describeFlowPayment", () => {
  it("dice de dónde salió el cobro, el medio y el pagador", () => {
    const texto = describeFlowPayment(statusPagado());
    expect(texto).toContain("181182854");
    expect(texto).toContain("Yape");
    expect(texto).toContain("cliente@correo.pe");
  });

  it("no inventa campos que Flow no mandó", () => {
    const texto = describeFlowPayment(
      statusPagado({ payer: "", paymentData: { media: null } }),
    );
    expect(texto).toBe("Cobrado por Flow (orden 181182854)");
  });
});
