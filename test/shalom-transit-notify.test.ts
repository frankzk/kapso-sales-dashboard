import { describe, expect, it, vi } from "vitest";

// El ticket en cabecera baja de Shalom y se firma en Storage: se simulan los
// dos para que la prueba no dependa de ninguna red.
vi.mock("@/lib/shalom/label-cache", () => ({
  shalomVoucherPdf: vi.fn(async () => new Uint8Array([0x25])),
  signedDocUrl: vi.fn(async () => "https://storage/signed/voucher.pdf"),
}));
vi.mock("@/lib/shalom/session", () => ({
  loadStoreShalom: vi.fn(async () => ({ shalom_pro_email: "x@y.z" })),
}));

import {
  OLVA_TRANSIT_DEFAULT_PARAMS,
  TRANSIT_DEFAULT_PARAMS,
  TRANSIT_MAX_ATTEMPTS,
  amountValue,
  enqueueTransitNotification,
  moneyLabel,
  noticeGuideCode,
  noticeSkipReason,
  parseTransitParams,
  pendingBalance,
  pickupDeadlineLabel,
  pickupWindowDays,
  processTransitNotifications,
  productsLabel,
  resolveSenderNumber,
  transitBodyParams,
  transitConfig,
  transitWithinHours,
  type TransitFacts,
} from "@/lib/shalom/transit-notify";

// #KP133540, el ejemplo con el que se pidió esto: guía 95451003 / PMC3 a
// Espinar, S/ 89.10 con S/ 30 de adelanto validado.
function facts(over: Partial<TransitFacts> = {}): TransitFacts {
  return {
    customerName: "Armando Idme Quispe",
    guideCode: "95451003",
    shalomCodigo: "PMC3",
    lineItems: [{ title: "Zapatilla Runner", variant_title: "39-40", quantity: 1 }],
    agencyName: "CUSCO / ESPINAR / YAURI ( ESPINAR ) / ESPINAR",
    orderTotal: 89.1,
    validatedAmount: 30,
    yapeNumber: "930 555 309",
    ...over,
  };
}

const ALL = parseTransitParams(TRANSIT_DEFAULT_PARAMS);

describe("parseTransitParams", () => {
  it("el orden por defecto es el de guias_shalom tal como se aprobó", () => {
    expect(ALL).toEqual(["nombre", "guia", "codigo", "producto", "agencia", "total", "adelanto", "saldo", "yape"]);
  });
  it("ignora tokens desconocidos en vez de romper", () => {
    expect(parseTransitParams("nombre, GUIA ,clave,saldo")).toEqual(["nombre", "guia", "saldo"]);
  });
});

describe("importes", () => {
  // La plantilla aprobada YA escribe el símbolo: «Monto total del pedido: S/
  // {{6}}». Mandar «S/ 89.10» en {{6}} le enseñaba a la clienta «S/ S/ 89.10».
  it("el parámetro de la plantilla va SIN «S/»: lo pone la plantilla", () => {
    expect(amountValue(89.1)).toBe("89.10");
    expect(amountValue(0)).toBe("0.00");
    expect(amountValue(null)).toBe("");
    expect(amountValue(-1)).toBe("");
  });

  it("el texto libre que escribe Kapta sí lo lleva", () => {
    expect(moneyLabel(59.1)).toBe("S/ 59.10");
    expect(moneyLabel(null)).toBe("");
  });
});

describe("pendingBalance", () => {
  it("es el total menos lo validado, y nunca negativo", () => {
    expect(pendingBalance(89.1, 30)).toBe(59.1);
    expect(pendingBalance(89.1, 0)).toBe(89.1);
    expect(pendingBalance(89.1, 200)).toBe(0);
    expect(pendingBalance(null, 30)).toBeNull();
  });
});

describe("productsLabel", () => {
  it("cantidad, título y variante — lo que la clienta reconoce", () => {
    expect(
      productsLabel([
        { title: "Zapatilla Runner", variant_title: "39-40", quantity: 2 },
        { title: "Medias", variant_title: "Default Title", quantity: 1 },
      ]),
    ).toBe("2× Zapatilla Runner (39-40), 1× Medias");
    expect(productsLabel(null)).toBe("");
  });
});

describe("transitBodyParams", () => {
  it("rellena los nueve en orden, con el saldo calculado sobre lo VALIDADO", () => {
    const r = transitBodyParams(ALL, facts());
    expect(r).toEqual({
      ok: true,
      params: [
        "Armando",
        "95451003",
        "PMC3",
        "1× Zapatilla Runner (39-40)",
        "CUSCO / ESPINAR / YAURI ( ESPINAR ) / ESPINAR",
        "89.10",
        "30.00",
        "59.10",
        "930 555 309",
      ],
    });
  });

  it("ningún importe lleva «S/»: la plantilla ya lo escribe", () => {
    const r = transitBodyParams(ALL, facts());
    expect(r.ok && r.params.some((p) => p.includes("S/"))).toBe(false);
  });

  // La variante con el ticket en PDF trae el Yape fijo en el cuerpo, así que
  // son OCHO parámetros y el token `yape` sobra.
  it("acepta la configuración de ocho de guias_shalom_imagen", () => {
    const ocho = parseTransitParams("nombre,guia,codigo,producto,agencia,total,adelanto,saldo");
    const r = transitBodyParams(ocho, facts({ yapeNumber: null }));
    expect(r).toEqual({
      ok: true,
      params: ["Armando", "95451003", "PMC3", "1× Zapatilla Runner (39-40)", "CUSCO / ESPINAR / YAURI ( ESPINAR ) / ESPINAR", "89.10", "30.00", "59.10"],
    });
  });

  it("sin adelanto validado el adelanto es 0.00 y el saldo es el total", () => {
    const r = transitBodyParams(ALL, facts({ validatedAmount: 0 }));
    expect(r.ok && r.params[6]).toBe("0.00");
    expect(r.ok && r.params[7]).toBe("89.10");
  });

  it("un sobrepago no deja el saldo en negativo", () => {
    const r = transitBodyParams(ALL, facts({ validatedAmount: 200 }));
    expect(r.ok && r.params[7]).toBe("0.00");
  });

  it("nombra QUÉ falta en vez de mandar un parámetro vacío que Meta rechaza", () => {
    const r = transitBodyParams(ALL, facts({ shalomCodigo: null, yapeNumber: null }));
    expect(r).toEqual({ ok: false, missing: ["codigo", "yape"] });
    // Sin total no hay ni total ni saldo.
    const sinTotal = transitBodyParams(ALL, facts({ orderTotal: null }));
    expect(sinTotal.ok).toBe(false);
    expect(!sinTotal.ok && sinTotal.missing).toEqual(["total", "saldo"]);
  });
});

describe("transitConfig", () => {
  const creds = (over: Record<string, unknown> = {}) =>
    ({
      shalom_transit_template_enabled: true,
      shalom_transit_template_name: "guias_shalom",
      shalom_transit_template_language: "es",
      shalom_transit_params: TRANSIT_DEFAULT_PARAMS,
      shalom_transit_attach_ticket: false,
      shalom_transit_phone_number_id: null,
      whatsapp_phone_number_id: "PN-store",
      kapso_api_key: "k",
      shalom_transit_hour_start: 8,
      shalom_transit_hour_end: 21,
      timezone: "America/Lima",
      ...over,
    }) as any;

  it("nace apagado: sin el interruptor no hay config", () => {
    expect(transitConfig(creds({ shalom_transit_template_enabled: false }))).toEqual({
      cfg: null,
      reason: "aviso apagado en la tienda",
    });
  });
  it("dice qué falta", () => {
    expect(transitConfig(creds({ shalom_transit_template_name: null })).cfg).toBeNull();
    expect(transitConfig(creds({ kapso_api_key: null })).cfg).toBeNull();
    expect(transitConfig(creds({ shalom_transit_params: "clave" })).cfg).toBeNull();
  });
  it("con todo, resuelve", () => {
    const r = transitConfig(creds());
    expect(r.cfg?.templateName).toBe("guias_shalom");
    expect(r.cfg?.tokens).toHaveLength(9);
  });
});

describe("resolveSenderNumber", () => {
  const cfg = { phoneNumberId: null, storePhoneNumberId: "PN-store" };
  it("el número propio manda; si no, el de la clienta; si no, el de la tienda", () => {
    expect(resolveSenderNumber({ ...cfg, phoneNumberId: "PN-propio" }, "PN-lead")).toBe("PN-propio");
    expect(resolveSenderNumber(cfg, "PN-lead")).toBe("PN-lead");
    expect(resolveSenderNumber(cfg, null)).toBe("PN-store");
    expect(resolveSenderNumber({ phoneNumberId: null, storePhoneNumberId: null }, null)).toBeNull();
  });
});

describe("transitWithinHours", () => {
  it("respeta la hora local de la tienda", () => {
    // 15:00Z = 10:00 en Lima.
    expect(transitWithinHours("2026-09-15T15:00:00Z", "America/Lima", 8, 21)).toBe(true);
    // 06:00Z = 01:00 en Lima.
    expect(transitWithinHours("2026-09-15T06:00:00Z", "America/Lima", 8, 21)).toBe(false);
  });
});

// ── La cola de punta a punta ────────────────────────────────────────────────

interface FakeOpts {
  pending?: any[];
  shipment?: any;
  master?: any;
  order?: any;
  draft?: any;
  payments?: any[];
  methods?: any[];
  lead?: any;
}

function fakeAdmin(opts: FakeOpts = {}) {
  const updates: { table: string; patch: any }[] = [];
  const inserts: { table: string; row: any }[] = [];
  const upserts: { table: string; row: any; opts: any }[] = [];
  const methods = opts.methods ?? [
    { id: "y", kind: "yape", label: "YAPE 1", holder: "Grupo GF SAC", account: "930555309", detail: null, primary_yape: true, active: true, sort: 1 },
  ];
  const admin: any = {
    updates,
    inserts,
    upserts,
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
        insert(row: any) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        update(patch: any) {
          updates.push({ table, patch });
          return chain;
        },
        upsert(row: any, o: any) {
          upserts.push({ table, row, opts: o });
          return Promise.resolve({ error: null });
        },
        maybeSingle() {
          // `null` explícito significa «esa fila NO existe»; solo un `undefined`
          // cae al valor por defecto. Con `??` un draft nulo se convertía en el
          // de ejemplo y la prueba de «falta la agencia» no probaba nada.
          const pick = <T,>(key: keyof FakeOpts, fallback: T): T | null =>
            key in opts ? ((opts[key] as T | null) ?? null) : fallback;
          const one: Record<string, any> = {
            shipments: pick("shipment", {
              id: "ship-1",
              guide_code: "95451003",
              shalom_codigo: "PMC3",
              shalom_ose_id: 584210,
              customer_name: null,
              customer_phone: null,
              agency_branch: null,
              province: "Espinar",
              district: "Yauri",
            }),
            order_master: pick("master", {
              order_name: "#KP133540",
              customer_name: "Armando Idme Quispe",
              customer_phone: "51929098849",
              order_total: 89.1,
            }),
            orders: pick("order", {
              name: "#KP133540",
              total_amount: 89.1,
              customer_phone: "51929098849",
              line_items: [{ title: "Zapatilla Runner", variant_title: "39-40", quantity: 1 }],
            }),
            shalom_order_drafts: pick("draft", { destiny_terminal_name: "CUSCO / ESPINAR / YAURI ( ESPINAR ) / ESPINAR" }),
            leads: pick("lead", { wa_phone_number_id: "PN-lead" }),
          };
          return Promise.resolve({ data: table in one ? one[table] : null, error: null });
        },
        then(res: any, rej: any) {
          const lists: Record<string, any[]> = {
            shalom_transit_notifications: opts.pending ?? [{ id: "n1", store_id: "store", shipment_id: "ship-1", order_id: "ord-1", attempts: 0 }],
            order_payments: opts.payments ?? [
              { amount: 30, validation_status: "validado" },
              { amount: 59.1, validation_status: "pendiente_revision" },
            ],
            store_payment_methods: methods,
          };
          return Promise.resolve({ data: lists[table] ?? [], error: null }).then(res, rej);
        },
      };
      return chain;
    },
  };
  return admin;
}

const CREDS = {
  shalom_transit_template_enabled: true,
  shalom_transit_template_name: "guias_shalom",
  shalom_transit_template_language: "es",
  shalom_transit_params: TRANSIT_DEFAULT_PARAMS,
  shalom_transit_attach_ticket: false,
  shalom_transit_phone_number_id: null,
  whatsapp_phone_number_id: "PN-store",
  kapso_api_key: "k",
  shalom_transit_hour_start: 0,
  shalom_transit_hour_end: 24,
  timezone: "America/Lima",
} as any;

const NOW = "2026-09-11T16:46:00Z";

describe("enqueueTransitNotification", () => {
  it("es idempotente por guía Y POR TIPO de aviso: la unique hace el trabajo", async () => {
    // La unique dejó de ser `shipment_id` a secas (0169): una misma guía tiene
    // que poder recibir el aviso de tránsito y, días después, el de llegada.
    // Lo que sigue garantizando es que ninguno de los dos se repita.
    const admin = fakeAdmin();
    await enqueueTransitNotification(admin, { storeId: "store", shipmentId: "ship-1", orderId: "ord-1" });
    expect(admin.upserts[0]).toMatchObject({
      table: "shalom_transit_notifications",
      row: { shipment_id: "ship-1", kind: "transito" },
      opts: { onConflict: "shipment_id,kind", ignoreDuplicates: true },
    });
  });

  it("sin decir el tipo, es el de tránsito: es el que ya existía", async () => {
    const admin = fakeAdmin();
    await enqueueTransitNotification(admin, {
      storeId: "store",
      shipmentId: "ship-2",
      orderId: "ord-2",
      kind: "disponible",
    });
    expect(admin.upserts[0]!.row).toMatchObject({ kind: "disponible" });
  });
});

describe("processTransitNotifications", () => {
  it("manda la plantilla con los nueve parámetros, por el número de la clienta, y deja rastro", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.T" });
    const report = await processTransitNotifications(admin, {
      nowIso: NOW,
      sendTemplate: send,
      loadCreds: async () => CREDS,
    });
    expect(report).toMatchObject({ sent: 1, failed: 0, skipped: 0, deferred: 0 });
    expect(send).toHaveBeenCalledWith(
      { apiKey: "k" },
      expect.objectContaining({
        phoneNumberId: "PN-lead",
        to: "51929098849",
        templateName: "guias_shalom",
        bodyParams: ["Armando", "95451003", "PMC3", "1× Zapatilla Runner (39-40)", "CUSCO / ESPINAR / YAURI ( ESPINAR ) / ESPINAR", "89.10", "30.00", "59.10", "930 555 309"],
      }),
    );
    // Sin ticket no va cabecera.
    expect(send.mock.calls[0]![1].headerDocument).toBeUndefined();
    // La fila queda cerrada con lo que se dijo…
    expect(admin.updates.at(-1)).toMatchObject({
      table: "shalom_transit_notifications",
      patch: { status: "sent", provider_message_id: "wamid.T", phone: "51929098849", phone_number_id: "PN-lead" },
    });
    // …y el pedido lo cuenta en su línea de tiempo.
    expect(admin.inserts[0]).toMatchObject({
      table: "order_events",
      row: { order_id: "ord-1", kind: "whatsapp_template", source: "shalom_transit", guide_code: "95451003" },
    });
  });

  it("con la tienda apagada cierra la fila como skipped: encender después no dispara avisos viejos", async () => {
    const admin = fakeAdmin();
    const send = vi.fn();
    const report = await processTransitNotifications(admin, {
      nowIso: NOW,
      sendTemplate: send,
      loadCreds: async () => ({ ...CREDS, shalom_transit_template_enabled: false }),
    });
    expect(report.skipped).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates[0]!.patch).toMatchObject({ status: "skipped", error: "aviso apagado en la tienda" });
  });

  it("fuera de horario no toca nada: se queda pendiente para la próxima pasada", async () => {
    const admin = fakeAdmin();
    const send = vi.fn();
    const report = await processTransitNotifications(admin, {
      nowIso: "2026-09-11T06:00:00Z", // 01:00 en Lima
      sendTemplate: send,
      loadCreds: async () => ({ ...CREDS, shalom_transit_hour_start: 8, shalom_transit_hour_end: 21 }),
    });
    expect(report.deferred).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates).toHaveLength(0);
  });

  it("un rechazo de Meta reintenta más tarde, y al agotar los intentos queda failed con el motivo", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: false, error: "Template not found", code: 132001 });
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => CREDS });
    expect(report).toMatchObject({ sent: 0, deferred: 1 });
    const patch = admin.updates.at(-1)!.patch;
    expect(patch).toMatchObject({ status: "pending", attempts: 1, error: "Template not found", error_code: 132001 });
    expect(Date.parse(patch.next_attempt_at)).toBe(Date.parse(NOW) + 30 * 60_000);

    const ultimo = fakeAdmin({ pending: [{ id: "n1", store_id: "store", shipment_id: "ship-1", order_id: "ord-1", attempts: TRANSIT_MAX_ATTEMPTS - 1 }] });
    const r2 = await processTransitNotifications(ultimo, { nowIso: NOW, sendTemplate: send, loadCreds: async () => CREDS });
    expect(r2.failed).toBe(1);
    expect(ultimo.updates.at(-1)!.patch).toMatchObject({ status: "failed", attempts: TRANSIT_MAX_ATTEMPTS });
  });

  it("una llamada ambigua NO se reintenta: repetirla duplicaría el aviso", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: false, error: "network", ambiguous: true });
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => CREDS });
    expect(report.failed).toBe(1);
    expect(admin.updates.at(-1)!.patch).toMatchObject({ status: "failed", error: "network" });
  });

  it("sin celular al que escribir falla en seco, sin gastar intentos", async () => {
    const admin = fakeAdmin({
      master: { order_name: "#KP1", customer_name: "Ana", customer_phone: null, order_total: 50 },
      order: { name: "#KP1", total_amount: 50, customer_phone: null, line_items: [] },
    });
    const send = vi.fn();
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => CREDS });
    expect(report.failed).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)!.patch).toMatchObject({ status: "failed" });
    expect(admin.updates.at(-1)!.patch.error).toMatch(/sin celular/);
  });

  it("si falta un dato lo nombra y reintenta: la agencia puede apuntarse tarde", async () => {
    const admin = fakeAdmin({ draft: null, shipment: { id: "ship-1", guide_code: "95451003", shalom_codigo: "PMC3", shalom_ose_id: 1, customer_name: null, customer_phone: null, agency_branch: null, province: null, district: null } });
    const send = vi.fn();
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => CREDS });
    expect(report.deferred).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)!.patch.error).toBe("faltan datos para la plantilla: agencia");
  });

  it("con el ticket pedido manda la cabecera con la URL firmada", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.D" });
    await processTransitNotifications(admin, {
      nowIso: NOW,
      sendTemplate: send,
      loadCreds: async () => ({ ...CREDS, shalom_transit_attach_ticket: true }),
    });
    expect(send.mock.calls[0]![1].headerDocument).toEqual({
      link: "https://storage/signed/voucher.pdf",
      filename: "ticket-shalom-95451003.pdf",
    });
    // Y NO queda sellado, aunque el ticket haya viajado en la cabecera: encima
    // de un mensaje de quince líneas el adjunto se pierde, así que se reenvía
    // con la primera respuesta. El sello lo pone esa vía.
    expect(admin.updates.at(-1)!.patch).toMatchObject({ status: "sent" });
    expect(admin.updates.at(-1)!.patch.ticket_sent_at).toBeUndefined();
  });

  it("con el ticket pedido y una guía sin OSE ID no se puede: falla en seco y lo dice", async () => {
    const admin = fakeAdmin({ shipment: { id: "ship-1", guide_code: "95451003", shalom_codigo: "PMC3", shalom_ose_id: null, customer_name: null, customer_phone: null, agency_branch: null, province: null, district: null } });
    const send = vi.fn();
    const report = await processTransitNotifications(admin, {
      nowIso: NOW,
      sendTemplate: send,
      loadCreds: async () => ({ ...CREDS, shalom_transit_attach_ticket: true }),
    });
    expect(report.failed).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)!.patch.error).toMatch(/OSE ID/);
  });
});

// ── El segundo aviso: «ya llegó a tu agencia» (0169) ────────────────────────

describe("pickupDeadlineLabel", () => {
  it("28 días desde que llegó, en hora de Lima", () => {
    // Una FECHA y no «te quedan 12 días»: el WhatsApp se queda en el chat y un
    // contador relativo envejece mal; una fecha sigue siendo cierta mañana.
    expect(pickupDeadlineLabel("2026-09-18T15:00:00Z", "America/Lima")).toBe("16 de octubre");
  });

  it("sin fecha de llegada no se inventa un plazo", () => {
    // Prometerle un día que no sabemos es peor que no decir nada: la clienta
    // planifica su viaje a la agencia con eso.
    expect(pickupDeadlineLabel(null, "America/Lima")).toBe("");
    expect(pickupDeadlineLabel("no es una fecha", "America/Lima")).toBe("");
  });
});

describe("transitConfig por tipo de aviso", () => {
  const base = {
    shalom_transit_template_enabled: true,
    shalom_transit_template_name: "guias_shalom_imagen",
    shalom_transit_template_language: "es",
    shalom_transit_params: "nombre,guia,codigo,producto,agencia,total,adelanto,saldo",
    shalom_transit_attach_ticket: true,
    shalom_arrival_template_enabled: false,
    shalom_arrival_template_name: null,
    shalom_arrival_params: "nombre,guia,codigo,producto,agencia,total,adelanto,saldo,vence",
    shalom_arrival_attach_ticket: false,
    kapso_api_key: "k",
    whatsapp_phone_number_id: "PN-store",
    shalom_transit_phone_number_id: "PN-600",
    shalom_transit_hour_start: 8,
    shalom_transit_hour_end: 21,
    timezone: "America/Lima",
  } as any;

  it("cada aviso trae su plantilla y sus variables", () => {
    const creds = {
      ...base,
      shalom_arrival_template_enabled: true,
      shalom_arrival_template_name: "guias_shalom_llegada",
    };
    const t = transitConfig(creds, "transito");
    const d = transitConfig(creds, "disponible");
    expect(t.cfg!.templateName).toBe("guias_shalom_imagen");
    expect(t.cfg!.tokens).not.toContain("vence");
    expect(d.cfg!.templateName).toBe("guias_shalom_llegada");
    expect(d.cfg!.tokens).toContain("vence");
  });

  it("el número y el horario SÍ se comparten: son de la tienda, no del aviso", () => {
    const creds = {
      ...base,
      shalom_arrival_template_enabled: true,
      shalom_arrival_template_name: "guias_shalom_llegada",
    };
    const d = transitConfig(creds, "disponible").cfg!;
    expect(d.phoneNumberId).toBe("PN-600");
    expect(d.hourStart).toBe(8);
    expect(d.hourEnd).toBe(21);
  });

  it("encender uno NO enciende el otro", () => {
    // Con el de tránsito funcionando, el de llegada sigue apagado hasta que
    // alguien lo encienda — y su motivo lo dice, para que no parezca un fallo.
    expect(transitConfig(base, "transito").cfg).not.toBeNull();
    const d = transitConfig(base, "disponible");
    expect(d.cfg).toBeNull();
    expect((d as { reason: string }).reason).toMatch(/aviso de llegada apagado/);
  });
});

describe("transitBodyParams con `vence`", () => {
  const facts = {
    customerName: "Madeleine Rodríguez",
    guideCode: "96028510",
    shalomCodigo: "MHTT",
    lineItems: [{ name: "Aceite de Semilla Negra", quantity: 1 }],
    agencyName: "SAN MARTIN / TARAPOTO",
    orderTotal: 89.1,
    validatedAmount: 30,
    yapeNumber: "930 555 309",
    pickupDeadline: "16 de octubre",
  };

  it("la fecha límite viaja como un parámetro más", () => {
    const r = transitBodyParams(
      ["nombre", "guia", "codigo", "producto", "agencia", "total", "adelanto", "saldo", "vence"],
      facts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.at(-1)).toBe("16 de octubre");
  });

  it("sin fecha límite el aviso NO sale, y se dice qué faltó", () => {
    const r = transitBodyParams(["nombre", "guia", "vence"], { ...facts, pickupDeadline: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["vence"]);
  });
});

// ── Olva: misma cola, otra plantilla (0175) ─────────────────────────────────

describe("avisos de Olva", () => {
  const base = {
    shalom_transit_template_enabled: true,
    shalom_transit_template_name: "guias_shalom",
    shalom_transit_template_language: "es",
    shalom_transit_params: TRANSIT_DEFAULT_PARAMS,
    shalom_transit_attach_ticket: true,
    shalom_arrival_template_enabled: true,
    shalom_arrival_template_name: "guias_shalom_llegada",
    shalom_arrival_params: "nombre,guia,codigo,producto,agencia,total,adelanto,saldo",
    shalom_arrival_attach_ticket: true,
    olva_transit_template_enabled: false,
    olva_transit_template_name: null,
    olva_transit_params: OLVA_TRANSIT_DEFAULT_PARAMS,
    olva_arrival_template_enabled: false,
    olva_arrival_template_name: null,
    olva_arrival_params: "nombre,guia,producto,agencia,total,adelanto,saldo",
    kapso_api_key: "k",
    whatsapp_phone_number_id: "PN-store",
    shalom_transit_phone_number_id: "PN-600",
    shalom_transit_hour_start: 0,
    shalom_transit_hour_end: 24,
    timezone: "America/Lima",
  } as any;

  it("las variables por omisión son las de Shalom sin `codigo`", () => {
    expect(OLVA_TRANSIT_DEFAULT_PARAMS).toBe("nombre,guia,producto,agencia,total,adelanto,saldo,yape");
  });

  it("encender los de Shalom NO enciende los de Olva: cada courier tiene su interruptor", () => {
    const t = transitConfig(base, "transito", "olva");
    expect(t.cfg).toBeNull();
    expect((t as { reason: string }).reason).toMatch(/aviso de Olva apagado/);
    const d = transitConfig(base, "disponible", "olva");
    expect((d as { reason: string }).reason).toMatch(/aviso de llegada de Olva apagado/);
  });

  it("con los suyos encendidos usa SU plantilla, sin ticket, y comparte número y horario", () => {
    const creds = {
      ...base,
      olva_transit_template_enabled: true,
      olva_transit_template_name: "guias_olva",
      olva_arrival_template_enabled: true,
      olva_arrival_template_name: "guias_olva_llegada",
    };
    const t = transitConfig(creds, "transito", "olva").cfg!;
    expect(t.courier).toBe("olva");
    expect(t.templateName).toBe("guias_olva");
    expect(t.tokens).toEqual(["nombre", "guia", "producto", "agencia", "total", "adelanto", "saldo", "yape"]);
    // Shalom tiene el ticket encendido; Olva no tiene ticket que adjuntar.
    expect(t.attachTicket).toBe(false);
    expect(t.phoneNumberId).toBe("PN-600");
    expect(t.language).toBe("es");
    const d = transitConfig(creds, "disponible", "olva").cfg!;
    expect(d.templateName).toBe("guias_olva_llegada");
    expect(d.tokens).not.toContain("codigo");
  });

  it("la guía de Olva es su tracking con el año, no el código interno del rótulo", () => {
    const shipment = {
      id: "s",
      guide_code: "MOM-KP135087-OLVA-B68DB94F",
      shalom_codigo: null,
      shalom_ose_id: null,
      olva_tracking: "2552504",
      olva_emision: "26",
      customer_name: null,
      customer_phone: null,
      agency_branch: null,
      province: null,
      district: null,
    };
    expect(noticeGuideCode("olva", shipment)).toBe("2552504-26");
    expect(noticeGuideCode("shalom", { ...shipment, guide_code: "95451003" })).toBe("95451003");
    // Sin tracking no hay guía que decir: el aviso lo nombrará como dato que falta.
    expect(noticeGuideCode("olva", { ...shipment, olva_tracking: null })).toBeNull();
  });

  it("Olva devuelve a los 6 días; Shalom a los 28", () => {
    expect(pickupWindowDays("olva")).toBe(6);
    expect(pickupWindowDays("shalom")).toBe(28);
    // 10/09 mediodía de Lima + 6 días = 16 de setiembre (así lo escribe es-PE).
    expect(pickupDeadlineLabel("2026-09-10T17:00:00Z", "America/Lima", pickupWindowDays("olva"))).toMatch(
      /^16 de (setiembre|septiembre)$/,
    );
  });

  it("se encola con el courier marcado, y sin decirlo sigue siendo Shalom", async () => {
    const admin = fakeAdmin();
    await enqueueTransitNotification(admin, {
      storeId: "store",
      shipmentId: "ship-olva",
      orderId: "ord-1",
      kind: "disponible",
      courier: "olva",
    });
    expect(admin.upserts[0]).toMatchObject({
      table: "shalom_transit_notifications",
      row: { shipment_id: "ship-olva", kind: "disponible", courier: "olva" },
      opts: { onConflict: "shipment_id,kind", ignoreDuplicates: true },
    });
    await enqueueTransitNotification(admin, { storeId: "store", shipmentId: "ship-1", orderId: "ord-1" });
    expect(admin.upserts[1]!.row.courier).toBe("shalom");
  });

  it("de punta a punta: la fila de Olva sale con la plantilla de Olva, el tracking y la oficina", async () => {
    const admin = fakeAdmin({
      pending: [{ id: "n-olva", store_id: "store", shipment_id: "ship-olva", order_id: "ord-1", attempts: 0, kind: "disponible", courier: "olva" }],
      shipment: {
        id: "ship-olva",
        guide_code: "MOM-KP135087-OLVA-B68DB94F",
        shalom_codigo: null,
        shalom_ose_id: null,
        olva_tracking: "2552504",
        olva_emision: "26",
        customer_name: null,
        customer_phone: null,
        agency_branch: "JAEN - CALLE MARISCAL CASTILLA 1250",
        province: "Cajamarca",
        district: "Jaén",
      },
      // Olva no tiene borrador de Shalom del que sacar la agencia.
      draft: null,
    });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.O" });
    const report = await processTransitNotifications(admin, {
      nowIso: NOW,
      sendTemplate: send,
      loadCreds: async () => ({
        ...base,
        olva_arrival_template_enabled: true,
        olva_arrival_template_name: "guias_olva_llegada",
      }),
    });
    expect(report).toMatchObject({ sent: 1, failed: 0, skipped: 0 });
    expect(send).toHaveBeenCalledWith(
      { apiKey: "k" },
      expect.objectContaining({
        templateName: "guias_olva_llegada",
        bodyParams: ["Armando", "2552504-26", "1× Zapatilla Runner (39-40)", "JAEN - CALLE MARISCAL CASTILLA 1250", "89.10", "30.00", "59.10"],
      }),
    );
    // Sin ticket en cabecera, aunque la tienda lo tenga encendido para Shalom.
    expect(send.mock.calls[0]![1].headerDocument).toBeUndefined();
    // Y en la línea de tiempo queda como aviso de Olva, de llegada.
    expect(admin.inserts[0]).toMatchObject({
      table: "order_events",
      row: { kind: "whatsapp_template", source: "olva_transit", courier: "olva" },
    });
    expect(admin.inserts[0]!.row.note).toMatch(/Aviso de llegada a la agencia/);
  });

  it("una fila de Olva con los avisos de Olva apagados se omite, aunque Shalom esté encendido", async () => {
    const admin = fakeAdmin({
      pending: [{ id: "n-olva", store_id: "store", shipment_id: "ship-olva", order_id: "ord-1", attempts: 0, kind: "transito", courier: "olva" }],
    });
    const send = vi.fn();
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => base });
    expect(report).toMatchObject({ sent: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)).toMatchObject({
      table: "shalom_transit_notifications",
      patch: { status: "skipped", error: "aviso de Olva apagado en la tienda" },
    });
  });
});

describe("a quién NO se le manda el aviso de cobro", () => {
  // #KP135533: a Alvina se le mandó «ya llegó a tu agencia» con saldo S/ 0.00 y
  // los tres botones de pago, un día después de pagar todo y con el pedido ya
  // marcado Entregado.
  it("a quien ya pagó todo", () => {
    expect(noticeSkipReason({ generalStatus: "en_proceso", orderTotal: 298, validatedAmount: 298 })).toBe(
      "ya pagó todo: no hay saldo que cobrar",
    );
  });

  it("a un pedido cerrado, deba lo que deba", () => {
    for (const estado of ["entregado", "anulado", "devuelto"]) {
      expect(noticeSkipReason({ generalStatus: estado, orderTotal: 298, validatedAmount: 100 })).toContain(
        estado,
      );
    }
  });

  it("a quien debe algo, sí se le manda", () => {
    expect(noticeSkipReason({ generalStatus: "en_proceso", orderTotal: 298, validatedAmount: 100 })).toBeNull();
  });

  it("sin total conocido no decide aquí: la plantilla ya se niega sola", () => {
    expect(noticeSkipReason({ generalStatus: "en_proceso", orderTotal: null, validatedAmount: 0 })).toBeNull();
  });
});
