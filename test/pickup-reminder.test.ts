// El recordatorio de recojo (MOM §12, 0242): día 3 y día 7 en la agencia, a
// quien todavía debe; con la foto del producto en la cabecera.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// El ticket no se usa en el recordatorio, pero el módulo lo importa.
vi.mock("@/lib/shalom/label-cache", () => ({
  shalomVoucherPdf: vi.fn(async () => new Uint8Array([0x25])),
  signedDocUrl: vi.fn(async () => "https://storage/signed/voucher.pdf"),
}));
vi.mock("@/lib/shalom/session", () => ({
  loadStoreShalom: vi.fn(async () => ({ shalom_pro_email: "x@y.z" })),
}));

import {
  NOTICE_KINDS,
  REMINDER_DEFAULT_PARAMS,
  REMINDER_DEFAULT_TEMPLATE,
  REMINDER_KINDS,
  guideArrivalAt,
  isReminderKind,
  parseNoticeKind,
  parseTransitParams,
  processTransitNotifications,
  reminderHeaderImage,
  reminderSendSkipReason,
  transitBodyParams,
  transitConfig,
} from "@/lib/shalom/transit-notify";
import {
  REMINDER_MIN_GAP_HOURS,
  REMINDER_PENDING_CAP,
  dueReminder,
  enqueueDueReminders,
  type ReminderCandidate,
} from "@/lib/shalom/pickup-reminder";
import { firstProductWithImage } from "@/lib/cart-image-test";
import { buildStoreUpdate } from "@/lib/store-settings";

const DAY = 24 * 3600 * 1000;
/** Llegó a la agencia el 18/09 a las 10:00 de Lima: vence el 16 de octubre. */
const LLEGADA = "2026-09-18T15:00:00Z";
const dia = (n: number, horas = 1) => new Date(Date.parse(LLEGADA) + n * DAY + horas * 3600_000).toISOString();

function guia(over: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    courier: "shalom",
    arrivedAt: LLEGADA,
    pickupState: "disponible_para_recojo",
    deliveryStatus: "pendiente",
    generalStatus: "en_proceso",
    orderTotal: 89.1,
    validatedAmount: 30,
    webPrepaid: false,
    // El aviso de llegada salió el mismo día que llegó.
    notices: [{ kind: "disponible", status: "sent", sentAt: LLEGADA }],
    ...over,
  };
}

// ── Cuándo toca ─────────────────────────────────────────────────────────────

describe("dueReminder: día 3 y día 7", () => {
  it("antes del día 3 no toca nada", () => {
    expect(dueReminder(guia(), dia(2, 20))).toEqual({ due: false, reason: "aún no toca" });
  });

  it("el día 3 toca el de día 3, con la fecha límite del courier", () => {
    const r = dueReminder(guia(), dia(3));
    expect(r).toMatchObject({ due: true, kind: "recordatorio_d3" });
    if (r.due) expect(r.deadlineIso).toBe(new Date(Date.parse(LLEGADA) + 28 * DAY).toISOString());
  });

  it("entre el 3 y el 7, con el de día 3 ya enviado, no repite", () => {
    const g = guia({ notices: [{ kind: "disponible", status: "sent", sentAt: LLEGADA }, { kind: "recordatorio_d3", status: "sent", sentAt: dia(3) }] });
    expect(dueReminder(g, dia(5))).toEqual({ due: false, reason: "ya tiene ese recordatorio" });
  });

  it("el día 7 toca el de día 7", () => {
    const g = guia({ notices: [{ kind: "disponible", status: "sent", sentAt: LLEGADA }, { kind: "recordatorio_d3", status: "sent", sentAt: dia(3) }] });
    expect(dueReminder(g, dia(7))).toMatchObject({ due: true, kind: "recordatorio_d7" });
  });

  it("después del de día 7 no sale nada más", () => {
    const g = guia({
      notices: [
        { kind: "recordatorio_d3", status: "sent", sentAt: dia(3) },
        { kind: "recordatorio_d7", status: "sent", sentAt: dia(7) },
      ],
    });
    expect(dueReminder(g, dia(15))).toEqual({ due: false, reason: "ya tiene ese recordatorio" });
  });
});

describe("dueReminder: el primer encendido manda UNO, no dos", () => {
  it("una guía que ya pasó el día 7 recibe solo el de día 7", () => {
    const r = dueReminder(guia(), dia(10));
    expect(r).toMatchObject({ due: true, kind: "recordatorio_d7" });
  });

  it("con ese de día 7 en la cola, no entra el de día 3", () => {
    const g = guia({ notices: [{ kind: "recordatorio_d7", status: "pending", sentAt: null }] });
    expect(dueReminder(g, dia(10)).due).toBe(false);
  });

  it("y con el de día 7 ya enviado, tampoco: el de día 3 no llega nunca", () => {
    const g = guia({ notices: [{ kind: "recordatorio_d7", status: "sent", sentAt: dia(10) }] });
    expect(dueReminder(g, dia(14))).toEqual({ due: false, reason: "ya tiene ese recordatorio" });
  });

  it("el de día 3 retenido en la cola no se junta con el de día 7", () => {
    const g = guia({ notices: [{ kind: "recordatorio_d3", status: "pending", sentAt: null }] });
    expect(dueReminder(g, dia(7))).toEqual({ due: false, reason: "hay otro aviso de esta guía en la cola" });
  });

  it("ni sale a menos de 48 h de otro aviso a la misma guía", () => {
    // El de día 3 salió tarde por el tope (día 6): el de día 7 espera al 8.
    const g = guia({ notices: [{ kind: "recordatorio_d3", status: "sent", sentAt: dia(6) }] });
    expect(dueReminder(g, dia(7))).toEqual({ due: false, reason: `se le escribió hace menos de ${REMINDER_MIN_GAP_HOURS} h` });
    expect(dueReminder(g, dia(8, 2))).toMatchObject({ due: true, kind: "recordatorio_d7" });
  });

  it("un aviso de llegada que salió tarde también aplaza el recordatorio", () => {
    const g = guia({ notices: [{ kind: "disponible", status: "sent", sentAt: dia(3) }] });
    expect(dueReminder(g, dia(4)).due).toBe(false);
  });
});

describe("dueReminder: Olva solo el de día 3", () => {
  const olva = (over: Partial<ReminderCandidate> = {}) => guia({ courier: "olva", ...over });

  it("el día 3 toca, con la fecha límite a 6 días", () => {
    const r = dueReminder(olva(), dia(3));
    expect(r).toMatchObject({ due: true, kind: "recordatorio_d3" });
    if (r.due) expect(r.deadlineIso).toBe(new Date(Date.parse(LLEGADA) + 6 * DAY).toISOString());
  });

  it("el día 5 sin recordatorio, el de día 3 (no existe un día 7 de Olva)", () => {
    expect(dueReminder(olva({ notices: [] }), dia(5))).toMatchObject({ due: true, kind: "recordatorio_d3" });
  });

  it("pasados los 6 días ya no toca nada", () => {
    expect(dueReminder(olva(), dia(6))).toEqual({ due: false, reason: "ya pasó la fecha límite de recojo" });
  });
});

describe("dueReminder: a quién no", () => {
  it("pasado el plazo de Shalom (28 días), nada", () => {
    expect(dueReminder(guia(), dia(28))).toEqual({ due: false, reason: "ya pasó la fecha límite de recojo" });
  });

  it("a quien ya pagó todo, ni a quien pagó en el checkout", () => {
    expect(dueReminder(guia({ validatedAmount: 89.1 }), dia(3))).toEqual({
      due: false,
      reason: "ya pagó todo: no hay saldo que cobrar",
    });
    expect(dueReminder(guia({ webPrepaid: true, validatedAmount: 0 }), dia(3))).toEqual({
      due: false,
      reason: "pagado en el checkout: no hay saldo que cobrar",
    });
  });

  it("a un pedido cerrado", () => {
    expect(dueReminder(guia({ generalStatus: "entregado" }), dia(3))).toEqual({
      due: false,
      reason: "el pedido ya está entregado",
    });
  });

  it("a una guía que ya no está esperando en la agencia", () => {
    expect(dueReminder(guia({ pickupState: "entregado", deliveryStatus: "entregado" }), dia(3)).due).toBe(false);
    expect(dueReminder(guia({ pickupState: "retorno_iniciado", deliveryStatus: "anulado" }), dia(3)).due).toBe(false);
    expect(dueReminder(guia({ pickupState: "en_transito", deliveryStatus: "en_ruta" }), dia(3)).due).toBe(false);
  });

  it("sin fecha de llegada no se adivina, y sin total no se sabe el saldo", () => {
    expect(dueReminder(guia({ arrivedAt: null }), dia(3))).toEqual({ due: false, reason: "sin fecha de llegada a la agencia" });
    expect(dueReminder(guia({ orderTotal: null }), dia(3))).toEqual({
      due: false,
      reason: "sin total del pedido: no se sabe el saldo",
    });
  });
});

describe("guideArrivalAt: de dónde sale la llegada", () => {
  it("manda el primer courier_status de la guía; luego el aviso de llegada; luego agency_arrived_at", () => {
    expect(
      guideArrivalAt({ firstArrivalEventAt: "2026-09-18T15:00:00Z", arrivalNoticeSentAt: "2026-09-18T16:00:00Z", agencyArrivedAt: "2026-09-19T00:00:00Z" }),
    ).toBe("2026-09-18T15:00:00Z");
    expect(guideArrivalAt({ firstArrivalEventAt: null, arrivalNoticeSentAt: "2026-09-18T16:00:00Z", agencyArrivedAt: "2026-09-19T00:00:00Z" })).toBe(
      "2026-09-18T16:00:00Z",
    );
    // Olva la escribe en la guía; Shalom no.
    expect(guideArrivalAt({ firstArrivalEventAt: null, arrivalNoticeSentAt: null, agencyArrivedAt: "2026-09-19T00:00:00Z" })).toBe(
      "2026-09-19T00:00:00Z",
    );
    expect(guideArrivalAt({ firstArrivalEventAt: null, arrivalNoticeSentAt: null, agencyArrivedAt: null })).toBeNull();
  });
});

describe("reminderSendSkipReason: lo que se vuelve a mirar al enviar", () => {
  const base = { courier: "shalom" as const, pickupState: "disponible_para_recojo", deliveryStatus: "pendiente", arrivedAt: LLEGADA };
  it("sigue en la agencia y en plazo: sale", () => {
    expect(reminderSendSkipReason({ ...base, nowIso: dia(3) })).toBeNull();
  });
  it("recogido mientras esperaba en la cola: no sale", () => {
    expect(reminderSendSkipReason({ ...base, pickupState: "entregado", deliveryStatus: "entregado", nowIso: dia(3) })).toBe(
      "la guía ya no está esperando en la agencia",
    );
  });
  it("el tope lo retuvo hasta pasado el plazo: no sale", () => {
    expect(reminderSendSkipReason({ ...base, courier: "olva", nowIso: dia(6, 2) })).toBe("ya pasó la fecha límite de recojo");
  });
});

// ── La imagen ───────────────────────────────────────────────────────────────

describe("la foto de la cabecera", () => {
  const catalog = [
    { product_id: "111", catalog_title: "Zapatilla Runner" },
    { product_id: "222", catalog_title: "Aceite de Semilla Negra" },
  ];

  it("en un pedido de varios productos, el primero que tenga foto", () => {
    const items = [
      { product_id: 999, title: "Producto sin foto" },
      { product_id: null, title: "aceite de semilla  negra" },
      { product_id: 111, title: "Zapatilla Runner" },
    ];
    expect(firstProductWithImage(items, catalog)).toBe("222");
    expect(firstProductWithImage(null, catalog)).toBeNull();
  });

  it("la foto del producto pasa por /api/wa-image (JPG)", () => {
    expect(
      reminderHeaderImage({
        lineItems: [{ product_id: 111, title: "Zapatilla Runner" }],
        catalog,
        siteUrl: "https://kapta.test",
        storeId: "store",
        fallbackUrl: "https://cdn.test/logo.jpg",
      }),
    ).toEqual({ ok: true, link: "https://kapta.test/api/wa-image/store/111.jpg", source: "producto" });
  });

  it("sin foto, la imagen de respaldo de la tienda", () => {
    expect(
      reminderHeaderImage({ lineItems: [{ title: "Nuevo" }], catalog, siteUrl: "https://kapta.test", storeId: "store", fallbackUrl: "https://cdn.test/logo.jpg" }),
    ).toEqual({ ok: true, link: "https://cdn.test/logo.jpg", source: "respaldo" });
  });

  it("sin foto ni respaldo (o con un respaldo que no es https) no hay recordatorio", () => {
    for (const fallbackUrl of [null, "", "http://inseguro.test/logo.jpg"]) {
      const r = reminderHeaderImage({ lineItems: [{ title: "Nuevo" }], catalog, siteUrl: "https://kapta.test", storeId: "store", fallbackUrl });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/sin foto del producto ni imagen de respaldo/);
    }
  });
});

// ── Config y parámetros ─────────────────────────────────────────────────────

const STORE = {
  shalom_transit_template_enabled: true,
  shalom_transit_template_name: "guias_shalom_imagen",
  shalom_transit_template_language: "es",
  shalom_transit_params: "nombre,guia,codigo,producto,agencia,total,adelanto,saldo",
  shalom_transit_attach_ticket: true,
  shalom_arrival_template_enabled: true,
  shalom_arrival_template_name: "guias_shalom_llegada",
  shalom_arrival_params: "nombre,guia,codigo,producto,agencia,total,adelanto,saldo",
  shalom_arrival_attach_ticket: true,
  olva_transit_template_enabled: true,
  olva_transit_template_name: "guias_olva",
  olva_transit_params: "nombre,guia,producto,agencia,total,adelanto,saldo,yape",
  olva_arrival_template_enabled: true,
  olva_arrival_template_name: "guias_olva_llegada",
  olva_arrival_params: "nombre,guia,producto,agencia,total,adelanto,saldo",
  // Los defaults de la 0242: apagado, con nombre y orden ya puestos.
  shalom_reminder_template_enabled: false,
  shalom_reminder_template_name: "guias_shalom_recordatorio",
  shalom_reminder_params: "nombre,agencia,guia,saldo,vence",
  olva_reminder_template_enabled: false,
  olva_reminder_template_name: "guias_olva_recordatorio",
  olva_reminder_params: "nombre,agencia,guia,saldo,vence",
  shalom_reminder_fallback_image_url: null,
  kapso_api_key: "k",
  whatsapp_phone_number_id: "PN-store",
  shalom_transit_phone_number_id: null,
  shalom_transit_hour_start: 0,
  shalom_transit_hour_end: 24,
  timezone: "America/Lima",
} as any;

describe("transitConfig del recordatorio", () => {
  it("nace apagado, para Shalom y para Olva, aunque los otros avisos estén encendidos", () => {
    for (const kind of REMINDER_KINDS) {
      expect(transitConfig(STORE, kind, "shalom")).toEqual({ cfg: null, reason: "recordatorio de recojo apagado en la tienda" });
      expect(transitConfig(STORE, kind, "olva")).toEqual({ cfg: null, reason: "recordatorio de recojo de Olva apagado en la tienda" });
    }
  });

  it("encendido: su plantilla, sus cinco variables, imagen en la cabecera y SIN ticket", () => {
    const creds = { ...STORE, shalom_reminder_template_enabled: true, shalom_reminder_fallback_image_url: "https://cdn.test/logo.jpg" };
    for (const kind of REMINDER_KINDS) {
      const cfg = transitConfig(creds, kind, "shalom").cfg!;
      expect(cfg.templateName).toBe("guias_shalom_recordatorio");
      expect(cfg.tokens).toEqual(["nombre", "agencia", "guia", "saldo", "vence"]);
      expect(cfg.headerImage).toBe(true);
      // El aviso de llegada lleva el ticket; el recordatorio no: la cabecera es la foto.
      expect(cfg.attachTicket).toBe(false);
      expect(cfg.fallbackImageUrl).toBe("https://cdn.test/logo.jpg");
    }
    // Encender el de Shalom no enciende el de Olva.
    expect(transitConfig(creds, "recordatorio_d3", "olva").cfg).toBeNull();
    // Y los otros avisos siguen sin imagen.
    expect(transitConfig(creds, "disponible", "shalom").cfg!.headerImage).toBe(false);
  });

  it("Olva usa SU plantilla", () => {
    const cfg = transitConfig({ ...STORE, olva_reminder_template_enabled: true }, "recordatorio_d3", "olva").cfg!;
    expect(cfg.templateName).toBe("guias_olva_recordatorio");
    expect(cfg.courier).toBe("olva");
  });

  it("los defaults: plantillas guias_*_recordatorio y {{1}} nombre … {{5}} vence", () => {
    expect(REMINDER_DEFAULT_TEMPLATE).toEqual({ shalom: "guias_shalom_recordatorio", olva: "guias_olva_recordatorio" });
    const r = transitBodyParams(parseTransitParams(REMINDER_DEFAULT_PARAMS), {
      customerName: "Armando Idme Quispe",
      guideCode: "95451003",
      shalomCodigo: "PMC3",
      lineItems: [],
      agencyName: "CUSCO / ESPINAR",
      orderTotal: 89.1,
      validatedAmount: 30,
      yapeNumber: null,
      pickupDeadline: "16 de octubre",
    });
    expect(r).toEqual({ ok: true, params: ["Armando", "CUSCO / ESPINAR", "95451003", "59.10", "16 de octubre"] });
  });
});

describe("los tipos de aviso", () => {
  it("son los cuatro del check de la cola, y un kind desconocido se lee como tránsito", () => {
    expect(NOTICE_KINDS).toEqual(["transito", "disponible", "recordatorio_d3", "recordatorio_d7"]);
    expect(isReminderKind("recordatorio_d7")).toBe(true);
    expect(isReminderKind("disponible")).toBe(false);
    expect(parseNoticeKind("recordatorio_d3")).toBe("recordatorio_d3");
    expect(parseNoticeKind(null)).toBe("transito");
  });

  it("la migración 0242 admite exactamente esos cuatro", () => {
    const sql = readFileSync(resolve(process.cwd(), "db/migrations/0242_pickup_reminder.sql"), "utf8");
    const check = /check \(kind in \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    expect(check.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...NOTICE_KINDS]);
  });
});

// ── Un Supabase en memoria, con filtros de verdad ──────────────────────────

function memoryAdmin(tables: Record<string, any[]>, opts: { failOn?: string } = {}) {
  const updates: { table: string; patch: any }[] = [];
  const inserts: { table: string; row: any }[] = [];
  const upserts: { table: string; row: any; opts: any }[] = [];
  const admin: any = {
    updates,
    inserts,
    upserts,
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      let orden: { col: string; asc: boolean } | null = null;
      let tope: number | null = null;
      let actualizando = false;
      const rows = () => {
        let d = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (orden) {
          const { col, asc } = orden;
          d = [...d].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
        }
        return tope == null ? d : d.slice(0, tope);
      };
      const result = () =>
        opts.failOn === table ? { data: null, error: { message: `no se pudo leer ${table}` } } : { data: rows(), error: null };
      const chain: any = {
        select: () => chain,
        eq(c: string, v: unknown) {
          filters.push((r) => r[c] === v);
          return chain;
        },
        in(c: string, vs: unknown[]) {
          filters.push((r) => vs.includes(r[c]));
          return chain;
        },
        not(c: string, op: string, v: unknown) {
          if (op === "is") filters.push((r) => r[c] != null);
          if (op === "in") {
            const vals = String(v).replace(/[()]/g, "").split(",");
            filters.push((r) => !vals.includes(r[c]));
          }
          return chain;
        },
        gte(c: string, v: any) {
          filters.push((r) => r[c] >= v);
          return chain;
        },
        lte(c: string, v: any) {
          filters.push((r) => r[c] <= v);
          return chain;
        },
        order(c: string, o?: { ascending?: boolean }) {
          orden = { col: c, asc: o?.ascending !== false };
          return chain;
        },
        limit(n: number) {
          tope = n;
          return chain;
        },
        maybeSingle: () => {
          const r = result();
          return Promise.resolve(r.error ? r : { data: (r.data ?? [])[0] ?? null, error: null });
        },
        insert(row: any) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        upsert(row: any, o: any) {
          upserts.push({ table, row, opts: o });
          return Promise.resolve({ error: null });
        },
        update(patch: any) {
          actualizando = true;
          updates.push({ table, patch });
          return chain;
        },
        then(res: any, rej: any) {
          return Promise.resolve(actualizando ? { error: null } : result()).then(res, rej);
        },
      };
      return chain;
    },
  };
  return admin;
}

// ── De punta a punta: el envío ──────────────────────────────────────────────

const NOW = dia(3, 1); // 21/09, 11:00 de Lima

function sendTables(over: Record<string, any[]> = {}) {
  return {
    shalom_transit_notifications: [
      { id: "n-rec", store_id: "store", shipment_id: "ship-1", order_id: "ord-1", attempts: 0, kind: "recordatorio_d3", courier: "shalom", status: "pending", next_attempt_at: LLEGADA },
      { id: "n-lleg", store_id: "store", shipment_id: "ship-1", order_id: "ord-1", attempts: 1, kind: "disponible", courier: "shalom", status: "sent", sent_at: LLEGADA, next_attempt_at: LLEGADA },
    ],
    shipments: [
      {
        id: "ship-1",
        guide_code: "95451003",
        shalom_codigo: "PMC3",
        shalom_ose_id: 584210,
        customer_name: null,
        customer_phone: null,
        agency_branch: null,
        province: "Espinar",
        district: "Yauri",
        pickup_state: "disponible_para_recojo",
        delivery_status: "pendiente",
        agency_arrived_at: null,
      },
    ],
    order_master: [{ order_id: "ord-1", order_name: "#KP133540", customer_name: "Armando Idme Quispe", customer_phone: "51929098849", order_total: 89.1, general_status: "en_proceso" }],
    orders: [
      {
        id: "ord-1",
        name: "#KP133540",
        total_amount: 89.1,
        customer_phone: "51929098849",
        // El primero no tiene foto; el segundo sí: va el segundo.
        line_items: [
          { product_id: 999, title: "Bolsa de regalo", quantity: 1 },
          { product_id: 111, title: "Zapatilla Runner", variant_title: "39-40", quantity: 1 },
        ],
      },
    ],
    shalom_order_drafts: [{ order_id: "ord-1", destiny_terminal_name: "CUSCO / ESPINAR / YAURI ( ESPINAR ) / ESPINAR" }],
    order_payments: [
      { order_id: "ord-1", amount: 30, validation_status: "validado" },
      { order_id: "ord-1", amount: 59.1, validation_status: "pendiente_revision" },
    ],
    order_events: [
      { order_id: "ord-1", guide_code: "95451003", kind: "courier_status", new_operational: "disponible_para_recojo", occurred_at: LLEGADA },
      // Shalom movió la fecha después: la que cuenta es la primera.
      { order_id: "ord-1", guide_code: "95451003", kind: "courier_status", new_operational: "disponible_para_recojo", occurred_at: dia(2) },
    ],
    leads: [{ store_id: "store", phone: "51929098849", wa_phone_number_id: "PN-lead" }],
    store_payment_methods: [],
    shopify_product_images: [
      { store_id: "store", product_id: "111", catalog_title: "Zapatilla Runner", image_url: "https://cdn.shopify.com/s/files/zapatilla.webp" },
      // Sin foto: no cuenta.
      { store_id: "store", product_id: "999", catalog_title: "Bolsa de regalo", image_url: null },
    ],
    ...over,
  };
}

const ON = { ...STORE, shalom_reminder_template_enabled: true };

describe("processTransitNotifications con un recordatorio", () => {
  it("manda la plantilla con la foto del producto en la cabecera y los cinco parámetros", async () => {
    const admin = memoryAdmin(sendTables());
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.R" });
    const report = await processTransitNotifications(admin, {
      nowIso: NOW,
      sendTemplate: send,
      loadCreds: async () => ON,
      siteUrl: "https://kapta.test",
    });
    expect(report).toMatchObject({ sent: 1, failed: 0, skipped: 0 });
    expect(send).toHaveBeenCalledWith(
      { apiKey: "k" },
      expect.objectContaining({
        phoneNumberId: "PN-lead",
        to: "51929098849",
        templateName: "guias_shalom_recordatorio",
        language: "es",
        // {{1}} nombre, {{2}} agencia, {{3}} guía, {{4}} saldo, {{5}} vence —
        // 28 días desde la PRIMERA llegada, no desde la que Shalom movió.
        bodyParams: ["Armando", "CUSCO / ESPINAR / YAURI ( ESPINAR ) / ESPINAR", "95451003", "59.10", "16 de octubre"],
        headerImage: { link: "https://kapta.test/api/wa-image/store/111.jpg" },
      }),
    );
    // Ni el ticket: la cabecera es una sola y es la foto.
    expect(send.mock.calls[0]![1].headerDocument).toBeUndefined();
    expect(admin.updates.at(-1)).toMatchObject({
      table: "shalom_transit_notifications",
      patch: { status: "sent", header_image_url: "https://kapta.test/api/wa-image/store/111.jpg", template_name: "guias_shalom_recordatorio" },
    });
    expect(admin.inserts.at(-1)).toMatchObject({ table: "order_events", row: { kind: "whatsapp_template", order_id: "ord-1" } });
    expect(admin.inserts.at(-1)!.row.note).toBe(
      "📤 Recordatorio de recojo (día 3): plantilla «guias_shalom_recordatorio» enviada por #KP133540 con la foto del producto.",
    );
  });

  it("sin foto del producto sale con la imagen de respaldo de la tienda", async () => {
    const admin = memoryAdmin(sendTables({ shopify_product_images: [] }));
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.R" });
    await processTransitNotifications(admin, {
      nowIso: NOW,
      sendTemplate: send,
      loadCreds: async () => ({ ...ON, shalom_reminder_fallback_image_url: "https://cdn.test/kenku.jpg" }),
      siteUrl: "https://kapta.test",
    });
    expect(send.mock.calls[0]![1].headerImage).toEqual({ link: "https://cdn.test/kenku.jpg" });
    expect(admin.inserts.at(-1)!.row.note).toMatch(/con la imagen de respaldo\.$/);
  });

  it("sin foto ni respaldo NO se manda, y la fila queda omitida con el motivo", async () => {
    const admin = memoryAdmin(sendTables({ shopify_product_images: [] }));
    const send = vi.fn();
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => ON, siteUrl: "https://kapta.test" });
    expect(report).toMatchObject({ sent: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)!.patch).toMatchObject({ status: "skipped" });
    expect(admin.updates.at(-1)!.patch.error).toMatch(/sin foto del producto ni imagen de respaldo/);
  });

  it("si lo recogió mientras esperaba en la cola, no sale", async () => {
    const t = sendTables();
    t.shipments[0] = { ...t.shipments[0]!, pickup_state: "entregado", delivery_status: "entregado" };
    const admin = memoryAdmin(t);
    const send = vi.fn();
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => ON, siteUrl: "https://kapta.test" });
    expect(report.skipped).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)!.patch).toMatchObject({ status: "skipped", error: "la guía ya no está esperando en la agencia" });
  });

  it("si el tope lo retuvo hasta pasado el plazo, no sale", async () => {
    const admin = memoryAdmin(sendTables());
    const send = vi.fn();
    await processTransitNotifications(admin, { nowIso: dia(28, 2), sendTemplate: send, loadCreds: async () => ON, siteUrl: "https://kapta.test" });
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)!.patch).toMatchObject({ status: "skipped", error: "ya pasó la fecha límite de recojo" });
  });

  it("si ya pagó todo entre encolar y enviar, no sale", async () => {
    const admin = memoryAdmin(
      sendTables({ order_payments: [{ order_id: "ord-1", amount: 89.1, validation_status: "validado" }] }),
    );
    const send = vi.fn();
    await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => ON, siteUrl: "https://kapta.test" });
    expect(send).not.toHaveBeenCalled();
    expect(admin.updates.at(-1)!.patch).toMatchObject({ status: "skipped", error: "ya pagó todo: no hay saldo que cobrar" });
  });

  it("con el recordatorio apagado se omite, aunque llegada y tránsito estén encendidos", async () => {
    const admin = memoryAdmin(sendTables());
    const send = vi.fn();
    const report = await processTransitNotifications(admin, { nowIso: NOW, sendTemplate: send, loadCreds: async () => STORE });
    expect(report.skipped).toBe(1);
    expect(admin.updates.at(-1)!.patch).toMatchObject({ status: "skipped", error: "recordatorio de recojo apagado en la tienda" });
  });
});

// ── De punta a punta: el encolado ───────────────────────────────────────────

function enqueueTables(over: Record<string, any[]> = {}) {
  const shipment = (id: string, order: string, extra: Record<string, unknown> = {}) => ({
    id,
    store_id: "kenku",
    order_id: order,
    guide_code: `G-${id}`,
    courier: "shalom",
    pickup_state: "disponible_para_recojo",
    delivery_status: "pendiente",
    agency_arrived_at: null,
    ...extra,
  });
  const llegada = (order: string, guide: string, at: string) => ({
    order_id: order,
    guide_code: guide,
    kind: "courier_status",
    new_operational: "disponible_para_recojo",
    occurred_at: at,
  });
  const at = (dias: number) => new Date(Date.parse(NOW_ENQ) - dias * DAY).toISOString();
  return {
    stores: [
      { id: "kenku", shalom_reminder_template_enabled: true, olva_reminder_template_enabled: false },
      { id: "aurela", shalom_reminder_template_enabled: false, olva_reminder_template_enabled: false },
    ],
    shipments: [
      shipment("s-d2", "o-d2"), // 2 días: aún no
      shipment("s-d4", "o-d4"), // 4 días: día 3
      shipment("s-d10", "o-d10"), // 10 días, nunca recordado: SOLO el de día 7
      shipment("s-pagado", "o-pagado"), // 5 días, pagó todo
      shipment("s-d30", "o-d30"), // 30 días: pasó el plazo
      shipment("s-recogido", "o-recogido", { pickup_state: "entregado", delivery_status: "entregado" }),
      shipment("s-aurela", "o-aurela", { store_id: "aurela" }), // tienda apagada
      shipment("s-olva", "o-olva", { courier: "olva" }), // otro courier
    ],
    order_events: [
      llegada("o-d2", "G-s-d2", at(2)),
      llegada("o-d4", "G-s-d4", at(4)),
      llegada("o-d10", "G-s-d10", at(10)),
      llegada("o-pagado", "G-s-pagado", at(5)),
      llegada("o-d30", "G-s-d30", at(30)),
    ],
    shalom_transit_notifications: [],
    order_master: ["o-d2", "o-d4", "o-d10", "o-pagado", "o-d30"].map((id) => ({ order_id: id, order_total: 100, general_status: "en_proceso" })),
    orders: ["o-d2", "o-d4", "o-d10", "o-pagado", "o-d30"].map((id) => ({ id, total_amount: 100, financial_status: "pending", total_refunded: 0, payment_gateway: null })),
    order_payments: [
      { order_id: "o-d4", amount: 20, validation_status: "validado" },
      { order_id: "o-pagado", amount: 100, validation_status: "validado" },
      // En revisión no es dinero: o-d10 sigue debiendo los 100.
      { order_id: "o-d10", amount: 100, validation_status: "pendiente_revision" },
    ],
    ...over,
  };
}
const NOW_ENQ = "2026-10-11T15:00:00Z";

describe("enqueueDueReminders", () => {
  it("encola solo lo que toca, el más avanzado, y dice por qué no el resto", async () => {
    const admin = memoryAdmin(enqueueTables());
    const r = await enqueueDueReminders(admin, { courier: "shalom", nowIso: NOW_ENQ });
    expect(r.errores).toEqual([]);
    expect(r.tiendas).toBe(1);
    // Solo Kenku y solo Shalom; lo recogido ya no está en la agencia.
    expect(r.guias).toBe(5);
    const encolados = admin.upserts.map((u: any) => [u.row.shipment_id, u.row.kind, u.row.courier]);
    expect(encolados).toEqual(
      expect.arrayContaining([
        ["s-d4", "recordatorio_d3", "shalom"],
        ["s-d10", "recordatorio_d7", "shalom"],
      ]),
    );
    expect(encolados).toHaveLength(2);
    expect(admin.upserts[0].opts).toEqual({ onConflict: "shipment_id,kind", ignoreDuplicates: true });
    expect(r.encolados).toBe(2);
    expect(r.motivos).toEqual({
      "aún no toca": 1,
      "ya pagó todo: no hay saldo que cobrar": 1,
      "ya pasó la fecha límite de recojo": 1,
    });
  });

  it("lo que vence antes entra primero", async () => {
    const admin = memoryAdmin(enqueueTables());
    await enqueueDueReminders(admin, { courier: "shalom", nowIso: NOW_ENQ });
    expect(admin.upserts.map((u: any) => u.row.shipment_id)).toEqual(["s-d10", "s-d4"]);
  });

  it("con el recordatorio apagado en todas las tiendas no mira nada", async () => {
    const t = enqueueTables();
    t.stores = t.stores.map((s) => ({ ...s, shalom_reminder_template_enabled: false }));
    const admin = memoryAdmin(t);
    const r = await enqueueDueReminders(admin, { courier: "shalom", nowIso: NOW_ENQ });
    expect(r).toMatchObject({ tiendas: 0, guias: 0, encolados: 0 });
    expect(admin.upserts).toHaveLength(0);
  });

  it("no apila: con la cola de recordatorios de la tienda llena, espera", async () => {
    const llenos = Array.from({ length: REMINDER_PENDING_CAP }, (_, i) => ({
      id: `p${i}`,
      store_id: "kenku",
      shipment_id: `otra-${i}`,
      kind: "recordatorio_d3",
      status: "pending",
      sent_at: null,
    }));
    const admin = memoryAdmin(enqueueTables({ shalom_transit_notifications: llenos }));
    const r = await enqueueDueReminders(admin, { courier: "shalom", nowIso: NOW_ENQ });
    expect(r).toMatchObject({ encolados: 0, porTope: 2 });
    expect(admin.upserts).toHaveLength(0);
  });

  it("falla cerrado: si no se pueden leer los pagos, no encola nada", async () => {
    const admin = memoryAdmin(enqueueTables(), { failOn: "order_payments" });
    const r = await enqueueDueReminders(admin, { courier: "shalom", nowIso: NOW_ENQ });
    expect(r.encolados).toBe(0);
    expect(admin.upserts).toHaveLength(0);
    expect(r.errores[0]).toMatch(/pagos/);
  });

  it("Olva: solo su courier y solo el de día 3, con la llegada de agency_arrived_at", async () => {
    const t = enqueueTables({
      stores: [{ id: "kenku", shalom_reminder_template_enabled: false, olva_reminder_template_enabled: true }],
      shipments: [
        {
          id: "s-olva",
          store_id: "kenku",
          order_id: "o-olva",
          guide_code: "MOM-KP1-OLVA",
          courier: "olva",
          pickup_state: "disponible_para_recojo",
          delivery_status: "pendiente",
          // Olva la escribe al llegar; aquí no hay courier_status en la tabla.
          agency_arrived_at: new Date(Date.parse(NOW_ENQ) - 4 * DAY).toISOString(),
        },
      ],
      order_events: [],
      order_master: [{ order_id: "o-olva", order_total: 120, general_status: "en_proceso" }],
      orders: [{ id: "o-olva", total_amount: 120, financial_status: "pending", total_refunded: 0, payment_gateway: null }],
      order_payments: [{ order_id: "o-olva", amount: 20, validation_status: "validado" }],
    });
    const admin = memoryAdmin(t);
    const r = await enqueueDueReminders(admin, { courier: "olva", nowIso: NOW_ENQ });
    expect(r.encolados).toBe(1);
    expect(admin.upserts[0].row).toMatchObject({ shipment_id: "s-olva", kind: "recordatorio_d3", courier: "olva" });
  });
});

// ── Ajustes ─────────────────────────────────────────────────────────────────

describe("Ajustes del recordatorio", () => {
  it("interruptores, plantillas y orden de variables se guardan como los otros avisos", () => {
    const patch = buildStoreUpdate({
      shalom_reminder_template_enabled: "true",
      shalom_reminder_template_name: "guias_shalom_recordatorio",
      shalom_reminder_params: "nombre,agencia,guia,saldo,vence",
      olva_reminder_template_enabled: "false",
      olva_reminder_template_name: "guias_olva_recordatorio",
      olva_reminder_params: "nombre,agencia,guia,saldo,vence",
    });
    expect(patch).toMatchObject({
      shalom_reminder_template_enabled: true,
      shalom_reminder_template_name: "guias_shalom_recordatorio",
      shalom_reminder_params: "nombre,agencia,guia,saldo,vence",
      olva_reminder_template_enabled: false,
      olva_reminder_template_name: "guias_olva_recordatorio",
    });
  });

  it("la imagen de respaldo: solo https, y vaciable", () => {
    expect(buildStoreUpdate({ shalom_reminder_fallback_image_url: " https://cdn.test/logo.jpg " })).toMatchObject({
      shalom_reminder_fallback_image_url: "https://cdn.test/logo.jpg",
    });
    expect(buildStoreUpdate({ shalom_reminder_fallback_image_url: "" })).toEqual({ shalom_reminder_fallback_image_url: null });
    // Una URL que Meta no podría abrir no se guarda.
    expect(buildStoreUpdate({ shalom_reminder_fallback_image_url: "http://inseguro.test/logo.jpg" })).toEqual({});
  });

  it("el formulario, la acción y la página conocen los siete campos", () => {
    const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
    const form = read("components/store-settings.tsx");
    const action = read("app/dashboard/[storeId]/settings/actions.ts");
    const page = read("app/dashboard/[storeId]/settings/page.tsx");
    for (const campo of [
      "shalom_reminder_template_enabled",
      "shalom_reminder_template_name",
      "shalom_reminder_params",
      "olva_reminder_template_enabled",
      "olva_reminder_template_name",
      "olva_reminder_params",
      "shalom_reminder_fallback_image_url",
    ]) {
      expect(form).toContain(`name="${campo}"`);
      expect(action).toContain(`get("${campo}")`);
      expect(page).toContain(`${campo}:`);
    }
  });
});

// ── MOM ─────────────────────────────────────────────────────────────────────

describe("MOM §12", () => {
  it("documenta el recordatorio de recojo", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("El recordatorio de recojo");
    expect(mom).toContain("`recordatorio_d3`");
    expect(mom).toContain("`recordatorio_d7`");
    expect(mom).toContain("guias_shalom_recordatorio");
    expect(mom).toContain("230 pedidos");
  });
});
