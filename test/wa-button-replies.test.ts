import { describe, expect, it, vi } from "vitest";

// El ticket baja de Shalom y se firma en Storage: se simulan los dos para que
// la prueba no dependa de ninguna red.
vi.mock("@/lib/shalom/label-cache", () => ({
  shalomVoucherPdf: vi.fn(async () => new Uint8Array([0x25])),
  signedDocUrl: vi.fn(async () => "https://storage/signed/ticket.pdf"),
}));
vi.mock("@/lib/shalom/session", () => ({
  loadStoreShalom: vi.fn(async () => ({ shalom_pro_email: "x@y.z" })),
}));

import {
  buildButtonReply,
  handleInboundMessage,
  isAcknowledgement,
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
      { saldo: "S/ 59.10", saldoValue: 59.1, pedido: "#KP133540" },
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

  it("el saldo va DELANTE de la cuenta, en los dos botones", () => {
    // El importe ya iba en el aviso, pero al pulsar el botón ese mensaje quedó
    // arriba: la cifra tiene que estar pegada a la cuenta a la que va a pagar.
    const link = { saldo: "S/ 119.00", saldoValue: 119, pedido: "#KP133540" };
    expect(buildButtonReply("yape", METHODS, { paymentLinkTemplate: null }, link)).toBe(
      "💵 Saldo pendiente: S/ 119.00\n\nYAPE GRUPO GF SAC 930 555 309",
    );
    const t = buildButtonReply("transferencia", METHODS, { paymentLinkTemplate: null }, link)!;
    expect(t.startsWith("💵 Saldo pendiente: S/ 119.00\n\n")).toBe(true);
    expect(t).toContain("191-2434540-0-12");
  });

  it("sin saldo conocido se contesta como siempre, sin inventar una cifra", () => {
    expect(
      buildButtonReply("yape", METHODS, { paymentLinkTemplate: null }, { saldo: null, saldoValue: null, pedido: null }),
    ).toBe("YAPE GRUPO GF SAC 930 555 309");
  });

  it("con cobro de Flow y sin texto configurado, manda el link y cuándo vence", () => {
    const out = buildButtonReply(
      "link_pago",
      METHODS,
      { paymentLinkTemplate: null },
      { saldo: "S/ 119.00", saldoValue: 119, pedido: "#KP1", payLink: "https://flow/pay?token=T", payLinkHours: 48 },
    );
    expect(out).toBe(
      "💵 Saldo pendiente: S/ 119.00\n\nPuedes pagar aquí, con Yape o tarjeta:\nhttps://flow/pay?token=T\n\n⏱️ El link vence en 48 horas.",
    );
  });

  it("el texto configurado puede poner el link donde quiera con {link}", () => {
    expect(
      buildButtonReply(
        "link_pago",
        METHODS,
        { paymentLinkTemplate: "Paga {saldo} del {pedido}: {link}" },
        { saldo: "S/ 119.00", saldoValue: 119, pedido: "#KP1", payLink: "https://flow/pay?token=T" },
      ),
    ).toBe("Paga S/ 119.00 del #KP1: https://flow/pay?token=T");
  });

  it("un texto que promete {link} sin link cae al Yape, no se manda a medias", () => {
    // Mandar «Paga aquí: » con el hueco vacío es peor que no mandar el link.
    expect(
      buildButtonReply(
        "link_pago",
        METHODS,
        { paymentLinkTemplate: "Paga aquí: {link}" },
        { saldo: "S/ 119.00", saldoValue: 119, pedido: "#KP1", payLink: null },
      ),
    ).toBe("💵 Saldo pendiente: S/ 119.00\n\nYAPE GRUPO GF SAC 930 555 309");
  });

  it("a quien ya no debe nada no se le enseña ninguna cuenta", () => {
    // Darle el número a quien ya pagó es invitarla a pagar dos veces.
    const pagado = { saldo: "S/ 0.00", saldoValue: 0, pedido: "#KP133540" };
    for (const b of ["yape", "transferencia", "link_pago"] as const) {
      const out = buildButtonReply(b, METHODS, { paymentLinkTemplate: "Paga {saldo}" }, pagado)!;
      expect(out).toContain("ya está pagado");
      expect(out).not.toContain("930 555 309");
      expect(out).not.toContain("191-2434540-0-12");
    }
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
    shipment?: any;
    /** Una respuesta nuestra ya enviada desde el aviso (anti-repetición). */
    yaContestado?: any;
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
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          if (table === "wa_auto_replies") {
            return Promise.resolve({ data: opts.yaContestado ?? null });
          }
          if (table === "shalom_transit_notifications") {
            return Promise.resolve({
              data:
                "lastNotification" in opts
                  ? opts.lastNotification
                  : { id: "notif-1", order_id: "ord-1", shipment_id: "ship-1", ticket_sent_at: null },
            });
          }
          if (table === "shipments") {
            return Promise.resolve({ data: opts.shipment ?? { shalom_ose_id: 584210, guide_code: "95451003" } });
          }
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

/** Lo que sale por defecto con el pedido de `fakeAdmin`: S/ 89.10 con S/ 30
 *  validados ⇒ debe S/ 59.10, y esa cifra encabeza la respuesta. */
const YAPE_CON_SALDO = "💵 Saldo pendiente: S/ 59.10\n\nYAPE GRUPO GF SAC 930 555 309";

describe("handleInboundMessage", () => {
  it("contesta el botón de Yape por el MISMO número por el que entró, y lo registra", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.OUT" });
    const res = await handleInboundMessage(admin, "store", CREDS, buttonEvent("Pagar con Yape"), {
      sendText: send,
      sendDocument: vi.fn().mockResolvedValue({ ok: true, id: "wamid.DOC" }),
    });
    expect(res.reason).toBe("replied:yape;ticket:enviado");
    expect(send).toHaveBeenCalledWith(
      { apiKey: "k" },
      { phoneNumberId: "PN-451", to: "51987654321", body: YAPE_CON_SALDO },
    );
    // Se reservó ANTES de contestar (la unique es la deduplicación)…
    expect(admin.inserts[0]).toMatchObject({
      table: "wa_auto_replies",
      row: { inbound_message_id: "wamid.BTN1", trigger: "yape", phone: "51987654321" },
    });
    // …y se cerró con lo que se dijo. Se busca la escritura de `wa_auto_replies`
    // en vez de la última: detrás va el sello del ticket, que es de otra tabla.
    expect(admin.updates.find((u: any) => u.table === "wa_auto_replies")).toMatchObject({
      patch: { ok: true, body: YAPE_CON_SALDO, provider_message_id: "wamid.OUT" },
    });
  });

  it("detrás del texto manda el ticket PDF de la guía, una sola vez", async () => {
    // Es la idea que reemplaza a la plantilla con cabecera de documento: el
    // botón abre la ventana de 24 h, así que el PDF sale como mensaje normal,
    // sin plantilla que aprobar en Meta.
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.OUT" });
    const sendDoc = vi.fn().mockResolvedValue({ ok: true, id: "wamid.DOC" });
    const res = await handleInboundMessage(admin, "store", CREDS, buttonEvent("Pagar con Yape"), {
      sendText: send,
      sendDocument: sendDoc,
      nowIso: "2026-09-15T16:00:00Z",
    });
    expect(res.reason).toBe("replied:yape;ticket:enviado");
    expect(sendDoc).toHaveBeenCalledWith(
      { apiKey: "k" },
      {
        phoneNumberId: "PN-451",
        to: "51987654321",
        documentUrl: "https://storage/signed/ticket.pdf",
        filename: "ticket-shalom-95451003.pdf",
        caption: "📄 Este es el ticket de tu envío por Shalom. Guía 95451003.",
      },
    );
    // El sello vive en la fila del AVISO, que es única por guía.
    expect(admin.updates.at(-1)).toMatchObject({
      table: "shalom_transit_notifications",
      patch: { ticket_sent_at: "2026-09-15T16:00:00Z", ticket_error: null },
    });
  });

  it("quien pulsa un SEGUNDO botón recibe el ticket otra vez, debajo de la respuesta", async () => {
    // El ticket del primer botón ya quedó fuera de pantalla. Repetirlo es
    // ponerlo donde la clienta está mirando —el problema que resolvió sacarlo
    // de la cabecera del aviso— y sale de la caché, sin llamada extra a Shalom.
    const admin = fakeAdmin({
      lastNotification: { id: "notif-1", order_id: "ord-1", shipment_id: "ship-1", ticket_sent_at: "2026-09-15T15:00:00Z" },
    });
    const sendText = vi.fn().mockResolvedValue({ ok: true, id: "x" });
    const sendDoc = vi.fn().mockResolvedValue({ ok: true, id: "wamid.DOC" });
    const res = await handleInboundMessage(admin, "store", CREDS, buttonEvent("Transferencia Depósito"), {
      sendText,
      sendDocument: sendDoc,
    });
    expect(res.reason).toBe("replied:transferencia;ticket:enviado");
    expect(sendDoc).toHaveBeenCalledTimes(1);
    // Y el saldo encabeza también la lista de cuentas.
    expect(sendText.mock.calls[0]![1].body.startsWith("💵 Saldo pendiente: S/ 59.10\n\n")).toBe(true);
  });

  it("una guía sin OSE ID no tiene ticket, y el texto con las cuentas sale igual", async () => {
    // Las que llegaron por el reporte Excel. Que no haya PDF no puede costarle
    // a la clienta el mensaje que sí le sirve para pagar.
    const admin = fakeAdmin({ shipment: { shalom_ose_id: null, guide_code: "95451003" } });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.OUT" });
    const sendDoc = vi.fn();
    const res = await handleInboundMessage(admin, "store", CREDS, buttonEvent("Pagar con Yape"), {
      sendText: send,
      sendDocument: sendDoc,
    });
    expect(res.reason).toBe("replied:yape;ticket:sin_ose_id");
    expect(send).toHaveBeenCalled();
    expect(sendDoc).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)!.patch.ticket_error).toMatch(/OSE ID/);
  });

  it("si el ticket lo rechaza Meta, el texto ya salió y solo queda el motivo", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.OUT" });
    const sendDoc = vi.fn().mockResolvedValue({ ok: false, error: "media download failed" });
    const res = await handleInboundMessage(admin, "store", CREDS, buttonEvent("Pagar con Yape"), {
      sendText: send,
      sendDocument: sendDoc,
    });
    expect(res.reason).toBe("replied:yape;ticket:rechazado");
    expect(admin.updates.at(-1)!.patch).toMatchObject({ ticket_error: "media download failed" });
  });

  it("sin aviso previo se contesta igual, pero no hay guía a la que pedirle ticket", async () => {
    const admin = fakeAdmin({ lastNotification: null });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.OUT" });
    const sendDoc = vi.fn();
    const res = await handleInboundMessage(admin, "store", CREDS, buttonEvent("Pagar con Yape"), {
      sendText: send,
      sendDocument: sendDoc,
    });
    expect(res.reason).toBe("replied:yape");
    expect(send).toHaveBeenCalled();
    expect(sendDoc).not.toHaveBeenCalled();
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

  it("si pagó entre el aviso y el botón, no se le vuelve a cobrar", async () => {
    // El aviso decía S/ 59.10; mientras tanto se validó el resto. Leer el
    // parámetro guardado le habría pedido pagar dos veces; recalculando, lo que
    // sale es la buena noticia y ninguna cuenta.
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
    expect(send.mock.calls[0]![1].body).toContain("ya está pagado");
    expect(send.mock.calls[0]![1].body).not.toContain("930 555 309");
  });

  it("con Flow encendido, «Link de pago» crea el cobro por el saldo de HOY", async () => {
    const admin = fakeAdmin({ lastNotification: { order_id: "ord-1" } });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.L" });
    const ensureLink = vi.fn().mockResolvedValue({
      ok: true,
      link: "https://www.flow.cl/app/web/pay.php?token=TOK",
      reused: false,
      id: "l1",
      expiresAt: null,
    });
    await handleInboundMessage(
      admin,
      "store",
      { ...CREDS, flowcl_link_enabled: true, flowcl_api_key: "a", flowcl_secret_key: "s", flowcl_webhook_secret: "h", flowcl_link_email: "cobros@x.pe", flowcl_link_ttl_hours: 48, flowcl_link_yape_only: false, currency: "PEN" },
      buttonEvent("Link de pago", "wamid.BTN5"),
      { sendText: send, ensureLink },
    );
    // S/ 89.10 con S/ 30 validados: el cobro es por S/ 59.10, no por el total.
    expect(ensureLink.mock.calls[0]![1]).toMatchObject({
      orderId: "ord-1",
      kind: "diferencia",
      amount: 59.1,
      email: "cobros@x.pe",
    });
    expect(send.mock.calls[0]![1].body).toContain("https://www.flow.cl/app/web/pay.php?token=TOK");
    expect(send.mock.calls[0]![1].body).toContain("💵 Saldo pendiente: S/ 59.10");
  });

  it("los otros botones NO crean cobros: pulsar «Yape» no emite una orden", async () => {
    const admin = fakeAdmin();
    const ensureLink = vi.fn();
    await handleInboundMessage(
      admin,
      "store",
      { ...CREDS, flowcl_link_enabled: true, flowcl_api_key: "a", flowcl_secret_key: "s", flowcl_webhook_secret: "h" },
      buttonEvent("Pagar con Yape", "wamid.BTN6"),
      { sendText: vi.fn().mockResolvedValue({ ok: true, id: "x" }), sendDocument: vi.fn().mockResolvedValue({ ok: true, id: "d" }), ensureLink },
    );
    expect(ensureLink).not.toHaveBeenCalled();
  });

  it("si la pasarela falla, la clienta recibe el Yape igual y queda la anomalía", async () => {
    // Que Flow esté caído no puede dejarla sin forma de pagar.
    const admin = fakeAdmin({ lastNotification: { order_id: "ord-1" } });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.L" });
    const ensureLink = vi.fn().mockResolvedValue({ ok: false, reason: "flow_rechazo:timeout" });
    await handleInboundMessage(
      admin,
      "store",
      { ...CREDS, flowcl_link_enabled: true, flowcl_api_key: "a", flowcl_secret_key: "s", flowcl_webhook_secret: "h", flowcl_link_email: "cobros@x.pe" },
      buttonEvent("Link de pago", "wamid.BTN7"),
      { sendText: send, ensureLink },
    );
    expect(send.mock.calls[0]![1].body).toContain("YAPE GRUPO GF SAC 930 555 309");
    expect(admin.anomalies.at(-1)).toMatchObject({ p_reason: "flowcl_link_fallido" });
  });

  it("con el cobro apagado el botón contesta como siempre", async () => {
    const admin = fakeAdmin({ lastNotification: { order_id: "ord-1" } });
    const ensureLink = vi.fn();
    await handleInboundMessage(
      admin,
      "store",
      { ...CREDS, shalom_transit_payment_link: "Saldo {saldo} del {pedido}" },
      buttonEvent("Link de pago", "wamid.BTN8"),
      { sendText: vi.fn().mockResolvedValue({ ok: true, id: "x" }), ensureLink },
    );
    expect(ensureLink).not.toHaveBeenCalled();
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

// ── El «ok» que no pregunta nada ────────────────────────────────────────────

describe("isAcknowledgement", () => {
  it("reconoce los acuses de recibo, con y sin tilde", () => {
    for (const t of ["ok", "Ok", "OK", "okey", "listo", "gracias", "Muchas gracias", "ya", "sí", "perfecto"]) {
      expect(isAcknowledgement(t)).toBe(true);
    }
  });

  it("un mensaje de solo emojis dice lo mismo que un «ok»", () => {
    expect(isAcknowledgement("👍")).toBe(true);
    expect(isAcknowledgement("🙏🙏")).toBe(true);
  });

  it("«buenas noches» y «muy amable» también son cierres", () => {
    // Están en la lista del router del bot, que ante ellos calla. Si nosotros
    // no los reconociéramos, la clienta no recibiría NADA de nadie.
    expect(isAcknowledgement("buenas noches")).toBe(true);
    expect(isAcknowledgement("muy amable")).toBe(true);
    expect(isAcknowledgement("mil gracias")).toBe(true);
    expect(isAcknowledgement("de nada")).toBe(true);
    expect(isAcknowledgement("de acuerdo")).toBe(true);
  });

  it("un mensaje de puros dígitos NO es un acuse: suele ser el nº de operación", () => {
    // El router del bot lo trata como trivial y calla. Nosotros también
    // callamos, pero por el motivo contrario: es un DATO, y quien puede hacer
    // algo con él es la asesora. Pedido al bot: que los mande a `texto`.
    expect(isAcknowledgement("707784")).toBe(false);
    expect(isAcknowledgement("6069")).toBe(false);
  });

  it("una frase larga de puros acuses sigue siendo un acuse", () => {
    // Sin límite de longitud: el router no lo tiene, y ponerlo aquí dejaba
    // frases que él calla y nosotros también. Ahí no contesta nadie.
    expect(isAcknowledgement("buenos dias muchas gracias muy amable de nada")).toBe(true);
  });

  it("«no» NUNCA es un acuse, aunque sea cortito", () => {
    // Después de pedirle un saldo, un «no» es un rechazo: abre devolución, no
    // un recordatorio del Yape. Va a la asesora.
    expect(isAcknowledgement("no")).toBe(false);
    expect(isAcknowledgement("no gracias")).toBe(false);
    expect(isAcknowledgement("ya no")).toBe(false);
    expect(isAcknowledgement("quiero cancelar")).toBe(false);
    expect(isAcknowledgement("devolver")).toBe(false);
  });

  it("NO se traga una consulta de verdad", () => {
    // Éstas tienen que llegar a la asesora. Contestarles con un número de
    // Yape sería atropellar a quien está preguntando otra cosa.
    expect(isAcknowledgement("ok pero me llegó mal el producto")).toBe(false);
    expect(isAcknowledgement("¿cuándo llega?")).toBe(false);
    expect(isAcknowledgement("ya pagué, les mando la constancia")).toBe(false);
    expect(isAcknowledgement("no lo quiero")).toBe(false);
    expect(isAcknowledgement("")).toBe(false);
  });
});

function textEvent(text: string, id = "wamid.TXT1") {
  return {
    event: "whatsapp.message.received",
    message: {
      id,
      from: "51987654321",
      type: "text",
      text: { body: text },
      kapso: { direction: "inbound", phone_number_id: "PN-451" },
    },
  };
}

describe("handleInboundMessage con un «ok»", () => {
  it("le repite el saldo y el Yape", async () => {
    const admin = fakeAdmin({ lastNotification: { id: "n1", order_id: "ord-1", shipment_id: "ship-1", sent_at: "2026-09-19T10:00:00Z" } });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.OUT" });
    const res = await handleInboundMessage(admin, "store", CREDS, textEvent("ok"), {
      sendText: send,
      nowIso: "2026-09-19T11:00:00Z",
    });
    expect(res.reason).toBe("replied:ack");
    expect(send.mock.calls[0]![1].body).toBe(YAPE_CON_SALDO);
    expect(admin.inserts[0]).toMatchObject({ table: "wa_auto_replies", row: { trigger: "ack" } });
  });

  it("sin aviso previo, un «ok» no es nuestro", async () => {
    const admin = fakeAdmin({ lastNotification: null });
    const send = vi.fn();
    const res = await handleInboundMessage(admin, "store", CREDS, textEvent("ok", "wamid.T2"), { sendText: send });
    expect(res.reason).toBe("ack_sin_aviso");
    expect(send).not.toHaveBeenCalled();
  });

  it("pasadas 48 h del aviso, ya es otra conversación", async () => {
    const admin = fakeAdmin({ lastNotification: { id: "n1", order_id: "ord-1", shipment_id: "ship-1", sent_at: "2026-09-15T10:00:00Z" } });
    const send = vi.fn();
    const res = await handleInboundMessage(admin, "store", CREDS, textEvent("gracias", "wamid.T3"), {
      sendText: send,
      nowIso: "2026-09-19T11:00:00Z",
    });
    expect(res.reason).toBe("ack_fuera_de_ventana");
    expect(send).not.toHaveBeenCalled();
  });

  it("a un segundo «ok» ya no se le repite: eso es acoso, no ayuda", async () => {
    const admin = fakeAdmin({
      lastNotification: { id: "n1", order_id: "ord-1", shipment_id: "ship-1", sent_at: "2026-09-19T10:00:00Z" },
      yaContestado: { id: "r1" },
    });
    const send = vi.fn();
    const res = await handleInboundMessage(admin, "store", CREDS, textEvent("gracias", "wamid.T5"), {
      sendText: send,
      nowIso: "2026-09-19T11:00:00Z",
    });
    expect(res.reason).toBe("ack_ya_contestado");
    expect(send).not.toHaveBeenCalled();
  });

  it("una consulta de verdad sigue su camino hacia la asesora", async () => {
    const admin = fakeAdmin();
    const send = vi.fn();
    const res = await handleInboundMessage(admin, "store", CREDS, textEvent("¿me llegó mal el producto?", "wamid.T4"), {
      sendText: send,
    });
    expect(res.reason).toBe("not_a_payment_button");
    expect(send).not.toHaveBeenCalled();
    expect(admin.inserts).toHaveLength(0);
  });
});
