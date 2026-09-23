import { describe, expect, it, vi } from "vitest";
import {
  amountForFlow,
  commerceOrderFor,
  confirmationUrl,
  ensureFlowPaymentLink,
  reusableLink,
} from "@/lib/flow/link";

describe("amountForFlow", () => {
  it("siempre dos decimales: lo que se firma es el string", () => {
    // JavaScript escribe 59.10 como «59.1», y lo que se firma es String(v):
    // firmar una cosa y que Flow lea otra es un 401 sin explicación.
    expect(amountForFlow(59.1)).toBe("59.10");
    expect(amountForFlow(119)).toBe("119.00");
    expect(amountForFlow(0.005)).toBe("0.01");
  });
});

describe("commerceOrderFor", () => {
  it("lleva el pedido delante, para el que concilia en el panel de Flow", () => {
    expect(commerceOrderFor("#KP133540", "diferencia", "ab12cd")).toBe("KP133540-dif-ab12cd");
  });

  it("un pedido sin nombre no se queda sin llave", () => {
    expect(commerceOrderFor(null, "adelanto", "ab12cd")).toBe("PEDIDO-ade-ab12cd");
  });
});

describe("reusableLink", () => {
  const NOW = "2026-09-17T12:00:00Z";
  const vivo = {
    id: "l1",
    amount: 59.1,
    link: "https://flow/pay?token=T1",
    expires_at: "2026-09-19T12:00:00Z",
  };

  it("el mismo importe se reenvía: es el mismo cobro, no uno nuevo", () => {
    expect(reusableLink([vivo], 59.1, NOW)?.id).toBe("l1");
    // 59.1 y «59.10» son el mismo saldo; comparar flotantes diría que no.
    expect(reusableLink([{ ...vivo, amount: "59.10" }], 59.1, NOW)?.id).toBe("l1");
  });

  it("otro importe NO se reutiliza: cobraría de más o de menos", () => {
    expect(reusableLink([vivo], 89.1, NOW)).toBeNull();
  });

  it("uno vencido no sirve, y uno sin link todavía tampoco", () => {
    expect(reusableLink([{ ...vivo, expires_at: "2026-09-16T12:00:00Z" }], 59.1, NOW)).toBeNull();
    expect(reusableLink([{ ...vivo, link: null }], 59.1, NOW)).toBeNull();
  });
});

describe("confirmationUrl", () => {
  it("el secreto viaja en la URL, escapado", () => {
    expect(confirmationUrl("https://kapta.pe/", "store-1", "a b&c")).toBe(
      "https://kapta.pe/api/webhooks/flowcl/store-1?secret=a%20b%26c",
    );
  });
});

// ── ensureFlowPaymentLink ───────────────────────────────────────────────────

function fakeAdmin(vivos: any[] = []) {
  const inserts: any[] = [];
  const updates: { patch: any; ids: any }[] = [];
  const admin: any = {
    inserts,
    updates,
    from() {
      const chain: any = {
        insert(row: any) {
          inserts.push(row);
          chain._inserted = row;
          return chain;
        },
        update(patch: any) {
          updates.push({ patch, ids: null });
          return chain;
        },
        select: () => chain,
        eq: () => chain,
        in: (_col: string, ids: any) => {
          if (updates.length) updates[updates.length - 1]!.ids = ids;
          return Promise.resolve({ error: null });
        },
        order: () => chain,
        limit: () => Promise.resolve({ data: vivos, error: null }),
        single: () => Promise.resolve({ data: { id: "link-nuevo" }, error: null }),
        maybeSingle: () => Promise.resolve({ data: null }),
        then(res: any, rej: any) {
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        },
      };
      return chain;
    },
  };
  return admin;
}

const INPUT = {
  storeId: "store-1",
  orderId: "ord-1",
  orderName: "#KP133540",
  kind: "diferencia" as const,
  amount: 59.1,
  email: "cobros@kenku.pe",
  ttlHours: 48,
  yapeOnly: false,
};

const DEPS = {
  siteUrl: "https://kapta.pe",
  webhookSecret: "hook-secret",
  nowIso: "2026-09-17T12:00:00Z",
  suffix: () => "ab12cd",
};

describe("ensureFlowPaymentLink", () => {
  it("crea la orden y guarda el token con el que volverá el pago", async () => {
    const admin = fakeAdmin();
    const createPayment = vi.fn().mockResolvedValue({
      url: "https://www.flow.cl/app/web/pay.php",
      token: "TOK1",
      flowOrder: 9001,
      link: "https://www.flow.cl/app/web/pay.php?token=TOK1",
    });
    const res = await ensureFlowPaymentLink(admin, INPUT, {
      ...DEPS,
      client: { createPayment } as any,
    });
    expect(res).toMatchObject({ ok: true, reused: false, link: "https://www.flow.cl/app/web/pay.php?token=TOK1" });

    // El importe viaja como string de dos decimales, y el vencimiento como
    // `timeout` en segundos: sin él la orden queda pagable para siempre.
    expect(createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        commerceOrder: "KP133540-dif-ab12cd",
        amount: "59.10",
        currency: "PEN",
        timeout: 48 * 3600,
        urlConfirmation: "https://kapta.pe/api/webhooks/flowcl/store-1?secret=hook-secret",
        urlReturn: "https://kapta.pe/pago/gracias",
      }),
    );
    // Y sin `paymentMethod`: la tienda no pidió forzar Yape.
    expect(createPayment.mock.calls[0]![0].paymentMethod).toBeUndefined();

    // La fila se escribió ANTES de llamar a Flow (ver cabecera del módulo).
    expect(admin.inserts[0]).toMatchObject({
      order_id: "ord-1",
      kind: "diferencia",
      amount: "59.10",
      status: "creado",
      expires_at: "2026-09-19T12:00:00.000Z",
    });
    expect(admin.updates.at(-1)!.patch).toMatchObject({ flow_token: "TOK1", flow_order: 9001 });
  });

  it("«Solo Yape» manda el medio 170, que es el que abre la app", async () => {
    const admin = fakeAdmin();
    const createPayment = vi.fn().mockResolvedValue({ url: "u", token: "T", flowOrder: 1, link: "u?token=T" });
    await ensureFlowPaymentLink(
      admin,
      { ...INPUT, yapeOnly: true },
      { ...DEPS, client: { createPayment } as any },
    );
    expect(createPayment.mock.calls[0]![0].paymentMethod).toBe(170);
    expect(admin.inserts[0].payment_method).toBe(170);
  });

  it("un link vivo por el mismo importe se REENVÍA, no se crea otro", async () => {
    // Es la regla que evita dos órdenes cobrables por el mismo saldo cuando
    // la clienta pulsa el botón dos veces.
    const admin = fakeAdmin([
      { id: "l1", amount: 59.1, link: "https://flow/pay?token=T1", expires_at: "2026-09-19T12:00:00Z" },
    ]);
    const createPayment = vi.fn();
    const res = await ensureFlowPaymentLink(admin, INPUT, { ...DEPS, client: { createPayment } as any });
    expect(res).toMatchObject({ ok: true, reused: true, link: "https://flow/pay?token=T1" });
    expect(createPayment).not.toHaveBeenCalled();
    expect(admin.inserts).toHaveLength(0);
  });

  it("si el saldo cambió, el link viejo se deja de ofrecer y nace otro", async () => {
    const admin = fakeAdmin([
      { id: "l1", amount: 89.1, link: "https://flow/pay?token=T1", expires_at: "2026-09-19T12:00:00Z" },
    ]);
    const createPayment = vi.fn().mockResolvedValue({ url: "u", token: "T2", flowOrder: 2, link: "u?token=T2" });
    const res = await ensureFlowPaymentLink(admin, INPUT, { ...DEPS, client: { createPayment } as any });
    expect(res).toMatchObject({ ok: true, reused: false });
    expect(admin.updates[0]).toMatchObject({ patch: { status: "anulado" }, ids: ["l1"] });
  });

  it("si Flow rechaza, la fila queda con el motivo y NO se reintenta", async () => {
    // `payment/create` no es idempotente: reintentar a ciegas deja dos links
    // vivos y la clienta puede pagar los dos.
    const admin = fakeAdmin();
    const createPayment = vi.fn().mockRejectedValue(new Error("apiKey not found"));
    const res = await ensureFlowPaymentLink(admin, INPUT, { ...DEPS, client: { createPayment } as any });
    expect(res).toMatchObject({ ok: false, reason: "flow_rechazo:apiKey not found" });
    expect(createPayment).toHaveBeenCalledTimes(1);
    expect(admin.updates.at(-1)!.patch).toMatchObject({
      status: "anulado",
      last_status: { create_error: "apiKey not found" },
    });
  });

  it("sin saldo, sin email o sin secreto no se crea nada", async () => {
    const createPayment = vi.fn();
    const client = { createPayment } as any;
    expect(await ensureFlowPaymentLink(fakeAdmin(), { ...INPUT, amount: 0 }, { ...DEPS, client })).toMatchObject({
      ok: false,
      reason: "sin_saldo",
    });
    expect(await ensureFlowPaymentLink(fakeAdmin(), { ...INPUT, email: "" }, { ...DEPS, client })).toMatchObject({
      ok: false,
      reason: "sin_email",
    });
    expect(
      await ensureFlowPaymentLink(fakeAdmin(), INPUT, { ...DEPS, client, webhookSecret: "" }),
    ).toMatchObject({ ok: false, reason: "sin_secreto_de_webhook" });
    expect(createPayment).not.toHaveBeenCalled();
  });
});
