import { describe, expect, it, vi } from "vitest";
import {
  buildButtonReply,
  handleInboundMessage,
  matchPaymentButton,
} from "@/lib/wa-button-replies";
import type { PaymentMethod } from "@/lib/payment-methods";

const METHODS: PaymentMethod[] = [
  { id: "1", kind: "banco", label: "BCP", holder: "Grupo GF SAC", account: "191-2434540-0-12", detail: "CUENTA CORRIENTE BCP SOLES", primaryYape: false, active: true, sort: 10 },
  { id: "2", kind: "yape", label: "YAPE 1", holder: "Grupo GF SAC", account: "930555309", detail: null, primaryYape: true, active: true, sort: 50 },
];

describe("matchPaymentButton", () => {
  it("reconoce los tres rótulos de la plantilla, con y sin acento", () => {
    expect(matchPaymentButton("Pagar con Yape")).toBe("yape");
    expect(matchPaymentButton("Transferencia Depósito")).toBe("transferencia");
    expect(matchPaymentButton("Transferencia Deposito")).toBe("transferencia");
    expect(matchPaymentButton("Link de pago")).toBe("link_pago");
  });

  it("mira también el payload, que en las quick replies de Meta es el mismo texto", () => {
    expect(matchPaymentButton(null, "Pagar con Yape")).toBe("yape");
  });

  it("NO se dispara con texto libre que solo mencione el medio", () => {
    // «yape» dentro de una frase no es el botón: ese mensaje sigue con el bot y
    // la asesora, y meterse ahí es el choque de dos voces que hay que evitar.
    expect(matchPaymentButton("ya te hice el yape")).toBeNull();
    expect(matchPaymentButton("¿me pasas el link de pago?")).toBeNull();
    expect(matchPaymentButton("No, gracias")).toBeNull();
    expect(matchPaymentButton(null, null)).toBeNull();
  });
});

describe("buildButtonReply", () => {
  it("Yape: la línea corta", () => {
    expect(buildButtonReply("yape", METHODS, { paymentLinkTemplate: null })).toBe(
      "YAPE GRUPO GF SAC 930 555 309",
    );
  });

  it("Transferencia: la lista completa", () => {
    expect(buildButtonReply("transferencia", METHODS, { paymentLinkTemplate: null })).toContain(
      "BCP: A nombre de Grupo GF SAC, CUENTA CORRIENTE BCP SOLES:\n191-2434540-0-12",
    );
  });

  it("Link de pago: el texto configurado con el saldo, el pedido y el Yape puestos", () => {
    const out = buildButtonReply(
      "link_pago",
      METHODS,
      { paymentLinkTemplate: "Paga tu saldo de {saldo} del pedido {pedido}: https://pago.x/{yape}" },
      { saldo: "S/ 59.10", pedido: "#KP133540" },
    );
    expect(out).toBe("Paga tu saldo de S/ 59.10 del pedido #KP133540: https://pago.x/930 555 309");
  });

  it("Link de pago sin configurar cae al Yape, nunca al silencio", () => {
    expect(buildButtonReply("link_pago", METHODS, { paymentLinkTemplate: "  " })).toBe(
      "YAPE GRUPO GF SAC 930 555 309",
    );
  });

  it("sin cuentas no hay nada verdadero que decir", () => {
    expect(buildButtonReply("yape", [], { paymentLinkTemplate: null })).toBeNull();
    expect(buildButtonReply("transferencia", [], { paymentLinkTemplate: null })).toBeNull();
  });
});

// ── El webhook de punta a punta ─────────────────────────────────────────────

/** Un mensaje entrante de botón, con la forma REAL que devuelve la API de
 *  Kapso (leída el 15-09-2026). */
function buttonEvent(text: string, id = "wamid.BTN1") {
  return {
    event: "whatsapp.message.received",
    message: {
      id,
      from: "51987654321",
      type: "button",
      button: { text, payload: text },
      kapso: { direction: "inbound", phone_number_id: "PN-451", whatsapp_conversation_id: "conv-1" },
      timestamp: "1789432286",
    },
  };
}

function fakeAdmin(
  opts: {
    methods?: any[];
    duplicate?: boolean;
    lastNotification?: any;
    /** Lo que hay HOY en el pedido: de aquí sale el saldo, recalculado. */
    master?: any;
    payments?: any[];
  } = {},
) {
  const inserts: { table: string; row: any }[] = [];
  const updates: { table: string; patch: any }[] = [];
  const anomalies: any[] = [];
  const admin: any = {
    inserts,
    updates,
    anomalies,
    rpc: async (_fn: string, args: any) => {
      anomalies.push(args);
      return { error: null };
    },
    from(table: string) {
      const chain: any = {
        insert(row: any) {
          inserts.push({ table, row });
          return Promise.resolve({ error: opts.duplicate ? { code: "23505", message: "dup" } : null });
        },
        update(patch: any) {
          updates.push({ table, patch });
          return chain;
        },
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          if (table === "shalom_transit_notifications") return Promise.resolve({ data: opts.lastNotification ?? null });
          if (table === "order_master") {
            return Promise.resolve({
              data: opts.master ?? { order_name: "#KP133540", order_total: 89.1 },
            });
          }
          return Promise.resolve({ data: null });
        },
        then(res: any, rej: any) {
          const lists: Record<string, any[]> = {
            store_payment_methods:
              opts.methods ??
              METHODS.map((m) => ({
                id: m.id,
                kind: m.kind,
                label: m.label,
                holder: m.holder,
                account: m.account,
                detail: m.detail,
                primary_yape: m.primaryYape,
                active: m.active,
                sort: m.sort,
              })),
            order_payments: opts.payments ?? [{ amount: 30, validation_status: "validado" }],
          };
          return Promise.resolve({ data: lists[table] ?? null, error: null }).then(res, rej);
        },
      };
      return chain;
    },
  };
  return admin;
}

const CREDS = { kapso_api_key: "k", whatsapp_phone_number_id: "PN-store", shalom_transit_payment_link: null } as any;

describe("handleInboundMessage", () => {
  it("contesta el botón de Yape por el MISMO número por el que entró, y lo registra", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.OUT" });
    const res = await handleInboundMessage(admin, "store", CREDS, buttonEvent("Pagar con Yape"), { sendText: send });
    expect(res.reason).toBe("replied:yape");
    expect(send).toHaveBeenCalledWith(
      { apiKey: "k" },
      { phoneNumberId: "PN-451", to: "51987654321", body: "YAPE GRUPO GF SAC 930 555 309" },
    );
    // Se reservó ANTES de contestar (la unique es la deduplicación)…
    expect(admin.inserts[0]).toMatchObject({
      table: "wa_auto_replies",
      row: { inbound_message_id: "wamid.BTN1", trigger: "yape", phone: "51987654321" },
    });
    // …y se cerró con lo que se dijo.
    expect(admin.updates.at(-1)).toMatchObject({
      table: "wa_auto_replies",
      patch: { ok: true, body: "YAPE GRUPO GF SAC 930 555 309", provider_message_id: "wamid.OUT" },
    });
  });

  it("un webhook reintentado por Kapso no contesta dos veces", async () => {
    const admin = fakeAdmin({ duplicate: true });
    const send = vi.fn();
    const res = await handleInboundMessage(admin, "store", CREDS, buttonEvent("Pagar con Yape"), { sendText: send });
    expect(res.reason).toBe("duplicate_inbound");
    expect(send).not.toHaveBeenCalled();
  });

  it("ignora cualquier mensaje que no sea uno de los tres botones", async () => {
    const admin = fakeAdmin();
    const send = vi.fn();
    const res = await handleInboundMessage(
      admin,
      "store",
      CREDS,
      { event: "whatsapp.message.received", message: { id: "wamid.T", from: "51987654321", type: "text", text: { body: "hola, ya pagué" }, kapso: { direction: "inbound" } } },
      { sendText: send },
    );
    expect(res.reason).toBe("not_a_payment_button");
    expect(send).not.toHaveBeenCalled();
    expect(admin.inserts).toHaveLength(0);
  });

  it("un payload que no se entiende queda como anomalía, no como silencio", async () => {
    const admin = fakeAdmin();
    const res = await handleInboundMessage(admin, "store", CREDS, { event: "whatsapp.message.received", raro: true }, { sendText: vi.fn() });
    expect(res.reason).toBe("unparsed");
    expect(admin.anomalies[0]).toMatchObject({ p_source: "inbound_message", p_reason: "sin_id_o_remitente" });
  });

  it("sin cuentas configuradas no inventa una: registra la anomalía y no envía", async () => {
    const admin = fakeAdmin({ methods: [] });
    const send = vi.fn();
    const res = await handleInboundMessage(admin, "store", CREDS, buttonEvent("Transferencia Depósito"), { sendText: send });
    expect(res.reason).toBe("no_payment_methods");
    expect(send).not.toHaveBeenCalled();
    expect(admin.anomalies[0]).toMatchObject({ p_reason: "sin_cuentas_de_cobro" });
  });

  it("«Link de pago» habla del pedido del último aviso, con el saldo de HOY", async () => {
    // Pedido de S/ 89.10 con S/ 30 validados ⇒ debe S/ 59.10. El importe aquí
    // SÍ lleva «S/»: es texto libre nuestro, no un parámetro de plantilla.
    const admin = fakeAdmin({ lastNotification: { order_id: "ord-1" } });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.L" });
    await handleInboundMessage(
      admin,
      "store",
      { ...CREDS, shalom_transit_payment_link: "Saldo {saldo} del {pedido}" },
      buttonEvent("Link de pago", "wamid.BTN2"),
      { sendText: send },
    );
    expect(send.mock.calls[0]![1].body).toBe("Saldo S/ 59.10 del #KP133540");
  });

  it("si pagó entre el aviso y el botón, el link dice el saldo NUEVO", async () => {
    // El aviso decía S/ 59.10; mientras tanto se validó el resto. Leer el
    // parámetro guardado le habría cobrado dos veces.
    const admin = fakeAdmin({
      lastNotification: { order_id: "ord-1" },
      payments: [
        { amount: 30, validation_status: "validado" },
        { amount: 59.1, validation_status: "validado" },
      ],
    });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.L" });
    await handleInboundMessage(
      admin,
      "store",
      { ...CREDS, shalom_transit_payment_link: "Saldo {saldo} del {pedido}" },
      buttonEvent("Link de pago", "wamid.BTN3"),
      { sendText: send },
    );
    expect(send.mock.calls[0]![1].body).toBe("Saldo S/ 0.00 del #KP133540");
  });

  it("un comprobante en revisión todavía no descuenta", async () => {
    const admin = fakeAdmin({
      lastNotification: { order_id: "ord-1" },
      payments: [
        { amount: 30, validation_status: "validado" },
        { amount: 59.1, validation_status: "pendiente_revision" },
      ],
    });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.L" });
    await handleInboundMessage(
      admin,
      "store",
      { ...CREDS, shalom_transit_payment_link: "Saldo {saldo} del {pedido}" },
      buttonEvent("Link de pago", "wamid.BTN4"),
      { sendText: send },
    );
    expect(send.mock.calls[0]![1].body).toBe("Saldo S/ 59.10 del #KP133540");
  });
});
