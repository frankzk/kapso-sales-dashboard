// «Ya llegó, recógelo con tu DNI» para la clienta de Olva que ya pagó (0281,
// MOM §12, decisión del owner del 25-10-2026). Casos: #KP141593, #KP142910,
// #KP140003 — pagaron completo, el aviso de llegada (de cobro) se omitió, y en
// Olva no hay clave que les hubiera dicho «preséntala cuando llegue».
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shalom/label-cache", () => ({
  shalomVoucherPdf: vi.fn(async () => new Uint8Array([0x25])),
  signedDocUrl: vi.fn(async () => "https://storage/signed/voucher.pdf"),
}));
vi.mock("@/lib/shalom/session", () => ({
  loadStoreShalom: vi.fn(async () => ({ shalom_pro_email: "x@y.z" })),
}));

import {
  MONEY_TOKENS,
  OLVA_TRANSIT_DEFAULT_PARAMS,
  PAID_ARRIVAL_DEFAULT_PARAMS,
  PAID_ARRIVAL_DEFAULT_TEMPLATE,
  TRANSIT_DEFAULT_PARAMS,
  olvaPaidArrivalApplies,
  processTransitNotifications,
  transitConfig,
} from "@/lib/shalom/transit-notify";
import { buildStoreUpdate } from "@/lib/store-settings";

const NOW = "2026-10-25T16:00:00Z";

/** La misma tienda de prueba que los avisos de Olva, con el de pagados aparte. */
const BASE = {
  shalom_transit_template_enabled: true,
  shalom_transit_template_name: "guias_shalom",
  shalom_transit_template_language: "es",
  shalom_transit_params: TRANSIT_DEFAULT_PARAMS,
  shalom_transit_attach_ticket: false,
  shalom_arrival_template_enabled: true,
  shalom_arrival_template_name: "guias_shalom_llegada",
  shalom_arrival_params: "nombre,guia,codigo,producto,agencia,total,adelanto,saldo",
  shalom_arrival_attach_ticket: false,
  olva_transit_template_enabled: true,
  olva_transit_template_name: "guias_olva",
  olva_transit_params: OLVA_TRANSIT_DEFAULT_PARAMS,
  olva_arrival_template_enabled: true,
  olva_arrival_template_name: "guias_olva_llegada",
  olva_arrival_params: "nombre,guia,producto,agencia,total,adelanto,saldo",
  olva_paid_arrival_template_enabled: false,
  olva_paid_arrival_template_name: PAID_ARRIVAL_DEFAULT_TEMPLATE,
  olva_paid_arrival_params: PAID_ARRIVAL_DEFAULT_PARAMS,
  kapso_api_key: "k",
  whatsapp_phone_number_id: "PN-store",
  shalom_transit_phone_number_id: "PN-600",
  shalom_transit_hour_start: 0,
  shalom_transit_hour_end: 24,
  timezone: "America/Lima",
} as any;

const ON = { ...BASE, olva_paid_arrival_template_enabled: true };

const OLVA_SHIPMENT = {
  id: "ship-olva",
  guide_code: "MOM-KP141593-OLVA-1",
  shalom_codigo: null,
  shalom_ose_id: null,
  olva_tracking: "2552504",
  olva_emision: "26",
  customer_name: null,
  customer_phone: null,
  agency_branch: "JAEN - CALLE MARISCAL CASTILLA 1250",
  province: "Cajamarca",
  district: "Jaén",
  pickup_state: "disponible_para_recojo",
  delivery_status: "pendiente",
  // CONFIRMACION EN TIENDA del 23-10 al mediodía de Lima: vence el 29.
  agency_arrived_at: "2026-10-23T17:00:00Z",
};

interface Opts {
  pending?: any[];
  shipment?: any;
  order?: any;
  payments?: any[];
}

/** Lo justo de Supabase para la cola: una fila, su guía y su pedido. */
function fakeAdmin(opts: Opts = {}) {
  const updates: { table: string; patch: any }[] = [];
  const inserts: { table: string; row: any }[] = [];
  const admin: any = {
    updates,
    inserts,
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
        in: () => chain,
        insert(row: any) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        update(patch: any) {
          updates.push({ table, patch });
          return chain;
        },
        maybeSingle() {
          const one: Record<string, any> = {
            shipments: opts.shipment ?? OLVA_SHIPMENT,
            order_master: {
              order_name: "#KP141593",
              customer_name: "Armando Idme Quispe",
              customer_phone: "51929098849",
              order_total: 89.1,
              general_status: "en_proceso",
            },
            orders: opts.order ?? {
              name: "#KP141593",
              total_amount: 89.1,
              customer_phone: "51929098849",
              line_items: [{ title: "Zapatilla Runner", variant_title: "39-40", quantity: 1 }],
            },
            leads: { wa_phone_number_id: "PN-lead" },
          };
          return Promise.resolve({ data: one[table] ?? null, error: null });
        },
        then(res: any, rej: any) {
          const lists: Record<string, any[]> = {
            shalom_transit_notifications: opts.pending ?? [
              { id: "n-olva", store_id: "store", shipment_id: "ship-olva", order_id: "ord-1", attempts: 0, kind: "disponible", courier: "olva" },
            ],
            // Pagó todo: S/ 89.10 validados.
            order_payments: opts.payments ?? [
              { amount: 30, validation_status: "validado" },
              { amount: 59.1, validation_status: "validado" },
            ],
            store_payment_methods: [
              { id: "y", kind: "yape", label: "YAPE 1", holder: "Grupo GF SAC", account: "930555309", detail: null, primary_yape: true, active: true, sort: 1 },
            ],
          };
          return Promise.resolve({ data: lists[table] ?? [], error: null }).then(res, rej);
        },
      };
      return chain;
    },
  };
  return admin;
}

describe("¿toca el aviso para pagados?", () => {
  const pagado = { kind: "disponible" as const, courier: "olva" as const, generalStatus: "en_proceso", orderTotal: 89.1, validatedAmount: 89.1 };

  it("la llegada de Olva de quien ya no debe nada", () => {
    expect(olvaPaidArrivalApplies(pagado)).toBe(true);
    expect(olvaPaidArrivalApplies({ ...pagado, validatedAmount: 0, webPrepaid: true })).toBe(true);
  });

  it("no a quien todavía debe: a ésa le toca el de cobro", () => {
    expect(olvaPaidArrivalApplies({ ...pagado, validatedAmount: 30 })).toBe(false);
  });

  it("Shalom no cambia: tiene su clave", () => {
    expect(olvaPaidArrivalApplies({ ...pagado, courier: "shalom" })).toBe(false);
  });

  it("ni el de tránsito ni los recordatorios, ni un pedido cerrado", () => {
    expect(olvaPaidArrivalApplies({ ...pagado, kind: "transito" })).toBe(false);
    expect(olvaPaidArrivalApplies({ ...pagado, kind: "recordatorio_d3" })).toBe(false);
    for (const estado of ["entregado", "anulado", "devuelto"]) {
      expect(olvaPaidArrivalApplies({ ...pagado, generalStatus: estado })).toBe(false);
    }
  });
});

describe("la plantilla para pagados", () => {
  it("nace apagada y lo dice", () => {
    const r = transitConfig(BASE, "disponible", "olva", { paid: true });
    expect(r.cfg).toBeNull();
    expect((r as { reason: string }).reason).toBe("aviso de llegada para pagados de Olva apagado en la tienda");
  });

  it("encendida: su plantilla, sus variables, sin ticket ni imagen, y el número de los demás", () => {
    const cfg = transitConfig(ON, "disponible", "olva", { paid: true }).cfg!;
    expect(cfg.templateName).toBe("guias_olva_llegada_pagado");
    expect(cfg.tokens).toEqual(["nombre", "producto", "agencia", "guia", "vence"]);
    expect(cfg.attachTicket).toBe(false);
    expect(cfg.headerImage).toBe(false);
    expect(cfg.phoneNumberId).toBe("PN-600");
  });

  it("no admite importes: un «saldo 0.00» a quien pagó es lo que no hay que hacer", () => {
    for (const t of MONEY_TOKENS) {
      const r = transitConfig({ ...ON, olva_paid_arrival_params: `nombre,${t},guia` }, "disponible", "olva", { paid: true });
      expect(r.cfg).toBeNull();
      expect((r as { reason: string }).reason).toContain(`quita ${t}`);
    }
  });

  it("solo existe para la llegada de Olva", () => {
    expect(transitConfig(ON, "disponible", "shalom", { paid: true }).cfg).toBeNull();
    expect(transitConfig(ON, "transito", "olva", { paid: true }).cfg).toBeNull();
  });

  it("Ajustes la guarda como las demás", () => {
    const patch = buildStoreUpdate({
      olva_paid_arrival_template_enabled: "true",
      olva_paid_arrival_template_name: " guias_olva_llegada_pagado ",
      olva_paid_arrival_params: "nombre,agencia,guia,vence",
    });
    expect(patch).toMatchObject({
      olva_paid_arrival_template_enabled: true,
      olva_paid_arrival_template_name: "guias_olva_llegada_pagado",
      olva_paid_arrival_params: "nombre,agencia,guia,vence",
    });
    // Sin los campos (Ajustes sin la 0281) no se toca nada.
    expect(buildStoreUpdate({})).not.toHaveProperty("olva_paid_arrival_template_enabled");
  });
});

describe("la cola, de punta a punta", () => {
  it("Olva, ya pagó, con la plantilla encendida: sale «ya llegó» sin importes, en la misma fila", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.P" });
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => ON });
    expect(report).toMatchObject({ sent: 1, skipped: 0, failed: 0 });
    const msg = send.mock.calls[0]![1];
    expect(msg.templateName).toBe("guias_olva_llegada_pagado");
    expect(msg.bodyParams).toEqual([
      "Armando",
      "1× Zapatilla Runner (39-40)",
      "JAEN - CALLE MARISCAL CASTILLA 1250",
      "2552504-26",
      // 23-10 + 6 días: la misma fecha que `agency_expires_at` del Master.
      "29 de octubre",
    ]);
    expect(msg.headerDocument).toBeUndefined();
    expect(msg.headerImage).toBeUndefined();
    // La fila `disponible` de esa guía se cierra como enviada: es el único
    // aviso de llegada que va a tener (unique shipment_id, kind).
    expect(admin.updates.at(-1)).toMatchObject({
      table: "shalom_transit_notifications",
      patch: { status: "sent", template_name: "guias_olva_llegada_pagado" },
    });
    expect(admin.inserts[0]!.row.note).toMatch(/Aviso de llegada a la agencia \(pedido pagado, sin cobro\)/);
  });

  it("pagado en el checkout también", async () => {
    const admin = fakeAdmin({
      order: {
        name: "#KP142910",
        total_amount: 89.1,
        customer_phone: "51929098849",
        line_items: [{ title: "Zapatilla Runner", quantity: 1 }],
        financial_status: "paid",
        total_refunded: "0.00",
        payment_gateway: "checkout",
      },
      payments: [],
    });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.W" });
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => ON });
    expect(report).toMatchObject({ sent: 1 });
    expect(send.mock.calls[0]![1].templateName).toBe("guias_olva_llegada_pagado");
  });

  it("sin la plantilla encendida se omite como hoy, y el motivo dice qué falta configurar", async () => {
    const admin = fakeAdmin();
    const send = vi.fn();
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => BASE });
    expect(report).toMatchObject({ sent: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    const error = admin.updates.at(-1)!.patch.error as string;
    expect(error).toMatch(/^ya pagó todo: no hay saldo que cobrar/);
    expect(error).toContain("aviso de llegada para pagados de Olva apagado en la tienda");
    expect(error).toContain("Ajustes");
  });

  it("quien todavía debe recibe el de cobro, aunque el de pagados esté encendido", async () => {
    const admin = fakeAdmin({ payments: [{ amount: 30, validation_status: "validado" }] });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.C" });
    await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => ON });
    expect(send.mock.calls[0]![1].templateName).toBe("guias_olva_llegada");
    expect(send.mock.calls[0]![1].bodyParams).toContain("59.10");
  });

  it("los interruptores son independientes: con el de cobro apagado, el de pagados sale igual", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.I" });
    const report = await processTransitNotifications(admin, {
      nowIso: NOW,
      sendTemplate: send,
      loadCreds: async () => ({ ...ON, olva_arrival_template_enabled: false }),
    });
    expect(report).toMatchObject({ sent: 1 });
    expect(send.mock.calls[0]![1].templateName).toBe("guias_olva_llegada_pagado");
  });

  it("…y con el de cobro apagado, quien debe sigue omitida por el de cobro", async () => {
    const admin = fakeAdmin({ payments: [] });
    const send = vi.fn();
    await processTransitNotifications(admin, {
      nowIso: NOW,
      sendTemplate: send,
      loadCreds: async () => ({ ...ON, olva_arrival_template_enabled: false }),
    });
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)!.patch).toMatchObject({ status: "skipped", error: "aviso de llegada de Olva apagado en la tienda" });
  });

  it("Shalom no cambia: a quien ya pagó no le sale nada", async () => {
    const admin = fakeAdmin({
      pending: [{ id: "n-sh", store_id: "store", shipment_id: "ship-1", order_id: "ord-1", attempts: 0, kind: "disponible", courier: "shalom" }],
      shipment: { ...OLVA_SHIPMENT, id: "ship-1", guide_code: "95451003", shalom_codigo: "PMC3", olva_tracking: null },
    });
    const send = vi.fn();
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => ON });
    expect(report).toMatchObject({ sent: 0, skipped: 1 });
    expect(admin.updates.at(-1)!.patch.error).toBe("ya pagó todo: no hay saldo que cobrar");
  });

  it("ni el de tránsito de Olva cambia: a quien ya pagó no le sale", async () => {
    const admin = fakeAdmin({
      pending: [{ id: "n-t", store_id: "store", shipment_id: "ship-olva", order_id: "ord-1", attempts: 0, kind: "transito", courier: "olva" }],
    });
    const send = vi.fn();
    await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => ON });
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)!.patch.error).toBe("ya pagó todo: no hay saldo que cobrar");
  });
});
