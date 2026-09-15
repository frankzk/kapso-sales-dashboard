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
  TRANSIT_DEFAULT_PARAMS,
  TRANSIT_MAX_ATTEMPTS,
  enqueueTransitNotification,
  moneyLabel,
  parseTransitParams,
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

describe("moneyLabel", () => {
  it("cero es un importe válido: un saldo de S/ 0.00 es un dato, no un hueco", () => {
    expect(moneyLabel(0)).toBe("S/ 0.00");
    expect(moneyLabel(89.1)).toBe("S/ 89.10");
    expect(moneyLabel(null)).toBe("");
    expect(moneyLabel(-1)).toBe("");
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
        "S/ 89.10",
        "S/ 30.00",
        "S/ 59.10",
        "930 555 309",
      ],
    });
  });

  it("sin adelanto validado el adelanto es S/ 0.00 y el saldo es el total", () => {
    const r = transitBodyParams(ALL, facts({ validatedAmount: 0 }));
    expect(r.ok && r.params[6]).toBe("S/ 0.00");
    expect(r.ok && r.params[7]).toBe("S/ 89.10");
  });

  it("un sobrepago no deja el saldo en negativo", () => {
    const r = transitBodyParams(ALL, facts({ validatedAmount: 200 }));
    expect(r.ok && r.params[7]).toBe("S/ 0.00");
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
  it("es idempotente por guía: la unique hace el trabajo", async () => {
    const admin = fakeAdmin();
    await enqueueTransitNotification(admin, { storeId: "store", shipmentId: "ship-1", orderId: "ord-1" });
    expect(admin.upserts[0]).toMatchObject({
      table: "shalom_transit_notifications",
      row: { shipment_id: "ship-1" },
      opts: { onConflict: "shipment_id", ignoreDuplicates: true },
    });
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
        bodyParams: ["Armando", "95451003", "PMC3", "1× Zapatilla Runner (39-40)", "CUSCO / ESPINAR / YAURI ( ESPINAR ) / ESPINAR", "S/ 89.10", "S/ 30.00", "S/ 59.10", "930 555 309"],
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
