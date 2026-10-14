// Recordatorio de reposición (MOM §34, 13-10-2026). A quién le
// llega, el grupo de control, y que un «Sí, quiero» lo tome una asesora sin
// pisar los otros mensajes automáticos. Lo que vence cada día lo prueba
// scripts/sql/restock_reminders_smoke.sql.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  RESTOCK_PHONE_COOLDOWN_DAYS,
  handleRestockReply,
  isControlPhone,
  matchRestockReply,
  restockBodyParams,
  restockConfirmation,
  restockHandoffContext,
  restockSkipReason,
  runRestockReminders,
  type RestockCandidate,
  type RestockHistory,
} from "@/lib/restock-reminder";
import { handoffStatus } from "@/lib/leads";
import {
  RESTOCK_DEFAULT_DAYS,
  restockProductList,
  restockResultsSummary,
  suggestShortName,
} from "@/lib/restock-view";

// Con 10 %, estos teléfonos caen en el control y estos no (sha256 del
// teléfono: siempre los mismos).
const CONTROL = "51999222001";
const ENVIO = "51999222002";
const ENVIO_2 = "51999222004";

const cand = (over: Partial<RestockCandidate> = {}): RestockCandidate => ({
  order_id: "ord-1",
  order_name: "#KP1",
  customer_name: "ana pérez",
  customer_phone: ENVIO,
  delivered_at: "2026-09-15T15:00:00Z",
  product_key: "111",
  product_name: "Aceite de Semilla Negra",
  units: 2,
  due_at: "2026-10-08T15:00:00Z",
  ...over,
});

const empty = (): RestockHistory => ({
  failedAttempts: new Map(),
  recentPhones: new Set(),
  optedOut: new Set(),
  productsWithImage: new Set(["111"]),
});

describe("el grupo de control", () => {
  it("lo decide el teléfono: la misma clienta cae siempre del mismo lado", () => {
    expect(isControlPhone(CONTROL, 10)).toBe(true);
    expect(isControlPhone(CONTROL, 10)).toBe(true);
    expect(isControlPhone(ENVIO, 10)).toBe(false);
  });

  it("con 0 % no hay control, y el reparto se parece al porcentaje", () => {
    expect(isControlPhone(CONTROL, 0)).toBe(false);
    let n = 0;
    for (let i = 0; i < 5000; i++) if (isControlPhone(`51${900000000 + i}`, 10)) n++;
    expect(n / 5000).toBeGreaterThan(0.08);
    expect(n / 5000).toBeLessThan(0.12);
  });
});

describe("a quién no", () => {
  it("a quien pidió que no le escriban, a quien ya se le recordó hace poco y sin nombre", () => {
    expect(restockSkipReason(cand(), empty())).toBeNull();
    const h = empty();
    h.optedOut.add(ENVIO);
    expect(restockSkipReason(cand(), h)).toBe("pidió que no le escriban");
    const h2 = empty();
    h2.recentPhones.add(ENVIO);
    expect(restockSkipReason(cand(), h2)).toContain(`${RESTOCK_PHONE_COOLDOWN_DAYS} días`);
    expect(restockSkipReason(cand({ customer_name: " " }), empty())).toBe("sin nombre de la clienta");
    expect(restockSkipReason(cand({ customer_phone: "123" }), empty())).toBe("sin número de WhatsApp válido");
  });

  it("sin foto del producto en Shopify no se manda: la plantilla lleva la foto", () => {
    const h = empty();
    h.productsWithImage.clear();
    expect(restockSkipReason(cand(), h)).toBe("el producto no tiene foto en Shopify");
  });

  it("tras tres rechazos de Meta sobre el mismo pedido se deja de intentar", () => {
    const h = empty();
    h.failedAttempts.set("ord-1", 3);
    expect(restockSkipReason(cand(), h)).toContain("3 veces");
  });
});

describe("las variables de la plantilla", () => {
  it("nombre de pila, el nombre corto del producto, las unidades y el pedido", () => {
    expect(restockBodyParams(["nombre", "producto", "unidades", "pedido"], cand())).toEqual([
      "Ana",
      "Aceite de Semilla Negra",
      "2",
      "#KP1",
    ]);
  });
  it("un valor vacío no se manda: Meta lo rechaza", () => {
    expect(restockBodyParams(["nombre", "pedido"], cand({ order_name: null }))).toBeNull();
  });
});

// ── El envío ────────────────────────────────────────────────────────────────

const CREDS = {
  restock_enabled: true,
  restock_template_name: "recordatorio_reposicion",
  restock_template_language: "es",
  restock_params: "nombre,producto",
  restock_phone_number_id: null,
  restock_button_label: "Sí, quiero",
  restock_hour_start: 9,
  restock_hour_end: 20,
  restock_pace_count: 5,
  restock_pace_minutes: 20,
  restock_days_before: 7,
  restock_control_pct: 10,
  kapso_api_key: "k",
  whatsapp_phone_number_id: "PN-store",
  timezone: "America/Lima",
} as any;

/** Un cliente de Supabase de mentira: lo que se lee sale de `tables`, lo que
 *  se escribe queda en `writes`. */
function fakeAdmin(opts: {
  candidates?: RestockCandidate[];
  tables?: Record<string, any[]>;
  maybe?: Record<string, any>;
  insertError?: Record<string, any>;
} = {}) {
  const writes: { table: string; op: string; row: any; filters?: any[] }[] = [];
  const rpcCalls: { fn: string; args: any }[] = [];
  const admin: any = {
    writes,
    rpcCalls,
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      return { data: fn === "restock_candidates" ? (opts.candidates ?? []) : null, error: null };
    },
    from(table: string) {
      const filters: any[] = [];
      const chain: any = {
        insert(row: any) {
          writes.push({ table, op: "insert", row });
          return Promise.resolve({ error: opts.insertError?.[table] ?? null });
        },
        upsert(row: any) {
          writes.push({ table, op: "upsert", row });
          return Promise.resolve({ error: null });
        },
        update(row: any) {
          const w = { table, op: "update", row, filters };
          writes.push(w);
          return chain;
        },
        select: () => chain,
        eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), chain),
        in: (c: string, v: unknown) => (filters.push(["in", c, v]), chain),
        is: (c: string, v: unknown) => (filters.push(["is", c, v]), chain),
        not: () => chain,
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: opts.maybe?.[table] ?? null, error: null }),
        then(res: any, rej: any) {
          const tables: Record<string, any[]> = { shopify_product_images: [{ product_id: "111" }], ...opts.tables };
          return Promise.resolve({ data: tables[table] ?? [], error: null }).then(res, rej);
        },
      };
      return chain;
    },
  };
  return admin;
}

// 15:00 UTC = 10:00 en Lima: dentro del horario.
const NOW = "2026-10-13T15:00:00Z";

describe("runRestockReminders", () => {
  it("a la clienta le llega la plantilla; a la del control solo se le registra", async () => {
    const admin = fakeAdmin({
      candidates: [
        cand({ order_id: "o1", customer_phone: ENVIO }),
        cand({ order_id: "o2", customer_phone: CONTROL, customer_name: "Bea" }),
      ],
    });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.1" });
    const rep = await runRestockReminders(admin, "store", CREDS, send, NOW, "https://kapta.app");
    expect(rep).toEqual({ sent: 1, control: 1, failed: 0, skipped: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      { apiKey: "k" },
      expect.objectContaining({
        to: ENVIO,
        templateName: "recordatorio_reposicion",
        bodyParams: ["Ana", "Aceite de Semilla Negra"],
        // La foto del producto, convertida a JPG por /api/wa-image.
        headerImage: { link: "https://kapta.app/api/wa-image/store/111.jpg" },
      }),
    );
    const rows = admin.writes.filter((w: any) => w.table === "restock_sends").map((w: any) => w.row);
    expect(rows).toEqual([
      expect.objectContaining({ order_id: "o1", arm: "enviado", ok: true, units: 2, product_key: "111" }),
      expect.objectContaining({ order_id: "o2", arm: "control", ok: true }),
    ]);
    expect(admin.rpcCalls[0]).toMatchObject({
      fn: "restock_candidates",
      args: { p_store_id: "store", p_days_before: 7, p_window_days: 14 },
    });
  });

  it("sin foto del producto no sale, ni a la clienta ni al control", async () => {
    const admin = fakeAdmin({
      candidates: [cand({ order_id: "o1" }), cand({ order_id: "o2", customer_phone: CONTROL })],
      tables: { shopify_product_images: [] },
    });
    const send = vi.fn();
    const rep = await runRestockReminders(admin, "store", CREDS, send, NOW);
    expect(rep).toEqual({ sent: 0, control: 0, failed: 0, skipped: 2 });
    expect(send).not.toHaveBeenCalled();
  });

  it("dos pedidos de la misma clienta: un solo recordatorio", async () => {
    const admin = fakeAdmin({
      candidates: [cand({ order_id: "o1" }), cand({ order_id: "o2" })],
    });
    const send = vi.fn().mockResolvedValue({ ok: true, id: "w" });
    const rep = await runRestockReminders(admin, "store", CREDS, send, NOW);
    expect(rep.sent).toBe(1);
    expect(rep.skipped).toBe(1);
  });

  it("a quien dijo BAJA o «no me contacten» no le llega", async () => {
    const admin = fakeAdmin({
      candidates: [cand({ order_id: "o1" }), cand({ order_id: "o2", customer_phone: ENVIO_2 })],
      tables: { contact_opt_outs: [{ phone: ENVIO }], leads: [{ phone: ENVIO_2 }] },
    });
    const send = vi.fn();
    const rep = await runRestockReminders(admin, "store", CREDS, send, NOW);
    expect(send).not.toHaveBeenCalled();
    expect(rep.skipped).toBe(2);
  });

  it("respeta el ritmo: con la ventana llena no lee ni la cola", async () => {
    const admin = fakeAdmin({
      candidates: [cand()],
      tables: { restock_sends: Array.from({ length: 5 }, () => ({ sent_at: NOW })) },
    });
    const send = vi.fn();
    const rep = await runRestockReminders(admin, "store", CREDS, send, NOW);
    expect(rep.sent).toBe(0);
    expect(admin.rpcCalls).toHaveLength(0);
  });

  it("fuera de horario, apagado o sin plantilla, no hace nada", async () => {
    const send = vi.fn();
    // 03:00 UTC = 22:00 en Lima.
    expect((await runRestockReminders(fakeAdmin({ candidates: [cand()] }), "s", CREDS, send, "2026-10-14T03:00:00Z")).sent).toBe(0);
    expect((await runRestockReminders(fakeAdmin({ candidates: [cand()] }), "s", { ...CREDS, restock_enabled: false }, send, NOW)).sent).toBe(0);
    expect((await runRestockReminders(fakeAdmin({ candidates: [cand()] }), "s", { ...CREDS, restock_template_name: " " }, send, NOW)).sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("ante el tope de mensajería de Meta corta el lote", async () => {
    const admin = fakeAdmin({
      candidates: [cand({ order_id: "o1" }), cand({ order_id: "o2", customer_phone: ENVIO_2 })],
    });
    const send = vi.fn().mockResolvedValue({ ok: false, error: "limit", code: 131056 });
    const rep = await runRestockReminders(admin, "store", CREDS, send, NOW);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rep.failed).toBe(1);
  });
});

// ── La respuesta ────────────────────────────────────────────────────────────

const msg = (over: Record<string, unknown> = {}) =>
  ({
    id: "wamid.IN1",
    from: ENVIO,
    phoneNumberId: "PN-451",
    conversationId: "conv-1",
    direction: "inbound",
    type: "button",
    text: "Sí, quiero",
    buttonText: "Sí, quiero",
    buttonPayload: "Sí, quiero",
    mediaKind: null,
    mediaUrl: null,
    ...over,
  }) as any;

const yesText = (text: string) => msg({ type: "text", text, buttonText: null, buttonPayload: null });

describe("matchRestockReply", () => {
  it("el botón de la tienda, con o sin acento, por rótulo o payload", () => {
    expect(matchRestockReply(msg(), "Sí, quiero")).toBe("boton");
    expect(matchRestockReply(msg({ buttonText: "si quiero", buttonPayload: null }), "Sí, quiero")).toBe("boton");
    expect(matchRestockReply(msg({ buttonText: null, buttonPayload: "Sí, quiero" }), null)).toBe("boton");
  });

  it("otro botón no es el suyo, aunque diga «sí»", () => {
    expect(matchRestockReply(msg({ buttonText: "Pagar con Yape", buttonPayload: null }), "Sí, quiero")).toBeNull();
    expect(matchRestockReply(msg({ buttonText: "Sí", buttonPayload: null }), "Sí, quiero")).toBeNull();
  });

  it("un «sí» escrito vale; una pregunta no, sigue con el bot y la asesora", () => {
    expect(matchRestockReply(yesText("Sí"), null)).toBe("si");
    expect(matchRestockReply(yesText("si quiero!!"), null)).toBe("si");
    expect(matchRestockReply(yesText("Sí por favor"), null)).toBe("si");
    expect(matchRestockReply(yesText("sí, pero ¿cuánto cuesta?"), null)).toBeNull();
    expect(matchRestockReply(yesText("no gracias"), null)).toBeNull();
  });

  it("BAJA es pedir que no le escriban más", () => {
    expect(matchRestockReply(yesText("BAJA"), null)).toBe("baja");
    expect(matchRestockReply(yesText("no me escriban más"), null)).toBe("baja");
  });
});

describe("lo que lee la asesora", () => {
  it("sin palabras de cobro: el handoff queda en Atender ahora y no en Yape", () => {
    const ctx = restockHandoffContext({
      product_name: "Aceite de Semilla Negra",
      units: 2,
      order_name: "#KP1",
      delivered_at: "2026-09-15T15:00:00Z",
      tz: "America/Lima",
    });
    expect(ctx).toBe(
      "Quiere reponer Aceite de Semilla Negra: contestó SÍ al recordatorio de reposición. Su pedido anterior: #KP1 (2 u., entregado el 15 de setiembre). Escríbele para armar el pedido.",
    );
    expect(handoffStatus("recompra", ctx)).toBe("casi_cierra");
  });

  it("si el nombre del producto trae una palabra de cobro, se omite", () => {
    const ctx = restockHandoffContext({ product_name: "Kit Pago Fácil", units: 1, order_name: null, delivered_at: null, tz: "America/Lima" });
    expect(ctx).not.toContain("Pago");
    expect(handoffStatus("recompra", ctx)).toBe("casi_cierra");
  });

  it("la clienta recibe una confirmación que no promete minutos", () => {
    expect(restockConfirmation("ana pérez", "Aceite de Semilla Negra")).toBe(
      "¡Gracias, Ana! 🙌 Ya le avisé a una asesora: te escribe por aquí para coordinar tu Aceite de Semilla Negra.",
    );
  });
});

const SEND = { id: "send-1", order_id: "ord-1", product_name: "Aceite de Semilla Negra", units: 2, sent_at: "2026-10-12T15:00:00Z", replied_at: null };

describe("handleRestockReply", () => {
  it("«Sí, quiero» tras un recordatorio: lo toma una asesora y se le confirma", async () => {
    const admin = fakeAdmin({
      maybe: {
        restock_sends: SEND,
        order_master: { order_name: "#KP1", customer_name: "Ana Pérez", delivered_at: "2026-09-15T15:00:00Z" },
      },
    });
    const handoff = vi.fn().mockResolvedValue({ ok: true });
    const sendText = vi.fn().mockResolvedValue({ ok: true, id: "wamid.OUT" });
    const res = await handleRestockReply(admin, "store", CREDS, msg(), { handoff, sendText, nowIso: NOW });
    expect(res).toEqual({ reason: "restock:boton;handoff:ok" });

    // Primero la reserva del mensaje (Kapso reintenta los webhooks)…
    expect(admin.writes[0]).toMatchObject({
      table: "wa_auto_replies",
      op: "insert",
      row: { inbound_message_id: "wamid.IN1", trigger: "recompra", order_id: "ord-1" },
    });
    // …el recordatorio queda contestado…
    expect(admin.writes.find((w: any) => w.table === "restock_sends")).toMatchObject({
      op: "update",
      row: { replied_at: NOW, reply_kind: "boton" },
    });
    // …el lead sube a Atender ahora por el camino de siempre…
    expect(handoff).toHaveBeenCalledWith(
      admin,
      "store",
      expect.objectContaining({
        phone_number: ENVIO,
        conversation_id: "conv-1",
        reason: "recompra",
        conversation: { contact_name: "Ana Pérez" },
      }),
    );
    expect(handoff.mock.calls[0]![2].context_summary).toContain("Quiere reponer Aceite de Semilla Negra");
    // …y la clienta sabe que alguien le escribe, por el número por el que entró.
    expect(sendText).toHaveBeenCalledWith(
      { apiKey: "k" },
      { phoneNumberId: "PN-451", to: ENVIO, body: expect.stringContaining("Ya le avisé a una asesora") },
    );
  });

  it("sin recordatorio reciente no es suyo: sigue el resto del webhook", async () => {
    const handoff = vi.fn();
    const res = await handleRestockReply(fakeAdmin(), "store", CREDS, yesText("sí"), { handoff, nowIso: NOW });
    expect(res).toBeNull();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("un segundo «sí» al mismo recordatorio no vuelve a derivar", async () => {
    const admin = fakeAdmin({ maybe: { restock_sends: { ...SEND, replied_at: "2026-10-12T16:00:00Z" } } });
    const handoff = vi.fn();
    expect(await handleRestockReply(admin, "store", CREDS, yesText("si"), { handoff, nowIso: NOW })).toBeNull();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("la reentrega del mismo mensaje no deriva dos veces", async () => {
    const admin = fakeAdmin({ maybe: { restock_sends: SEND }, insertError: { wa_auto_replies: { code: "23505", message: "dup" } } });
    const handoff = vi.fn();
    expect(await handleRestockReply(admin, "store", CREDS, msg(), { handoff, nowIso: NOW })).toEqual({ reason: "duplicate_inbound" });
    expect(handoff).not.toHaveBeenCalled();
  });

  it("BAJA tras un recordatorio: se anota, en silencio", async () => {
    const admin = fakeAdmin({ maybe: { restock_sends: SEND } });
    const sendText = vi.fn();
    const handoff = vi.fn();
    expect(await handleRestockReply(admin, "store", CREDS, yesText("BAJA"), { sendText, handoff, nowIso: NOW })).toEqual({
      reason: "restock:baja",
    });
    expect(admin.writes).toEqual([
      expect.objectContaining({ table: "contact_opt_outs", op: "upsert", row: { store_id: "store", phone: ENVIO, source: "restock_baja" } }),
    ]);
    expect(sendText).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("el webhook lo atiende ANTES que el acuse: tras un recordatorio, «sí» es una compra", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/wa-button-replies.ts"), "utf8");
    const restock = src.indexOf("handleRestockReply(admin");
    expect(restock).toBeGreaterThan(src.indexOf("matchPaymentButton(msg.buttonText"));
    expect(restock).toBeLessThan(src.indexOf("isAcknowledgement(msg.text)"));
  });
});

// ── Ajustes ─────────────────────────────────────────────────────────────────

describe("la lista de productos en Ajustes", () => {
  it("primero los que reciben recordatorio, aunque no se hayan vendido; después lo vendido", () => {
    const list = restockProductList(
      [
        { product_key: "1", title: "Pelador", pedidos: 300, unidades: 400 },
        { product_key: "2", title: "Aceite", pedidos: 100, unidades: 150 },
      ],
      [
        { product_key: "2", shopify_title: "Aceite", short_name: "aceite", days_per_unit: 30 },
        { product_key: "9", shopify_title: "Viejo", short_name: "viejo", days_per_unit: 60 },
      ],
    );
    expect(list.map((i) => [i.key, i.config?.days ?? null])).toEqual([
      ["2", 30],
      ["9", 60],
      ["1", null],
    ]);
  });

  it("marca los productos sin foto: no se les envía aunque tengan días", () => {
    const list = restockProductList(
      [{ product_key: "2", title: "Aceite", pedidos: 100, unidades: 150 }],
      [
        { product_key: "2", shopify_title: "Aceite", short_name: "aceite", days_per_unit: 30 },
        { product_key: "9", shopify_title: "Viejo", short_name: "viejo", days_per_unit: 60 },
      ],
      ["2"],
    );
    expect(list.map((i) => [i.key, i.hasImage])).toEqual([
      ["2", true],
      ["9", false],
    ]);
  });

  it("sugiere un nombre corto, y el mes por frasco es solo el valor inicial", () => {
    expect(suggestShortName("Nattokinase - Mejora de Circulación Arterial (90 cápsulas)")).toBe("Nattokinase");
    expect(suggestShortName("Magnesio 12 en 1 Complex (120 Cápsulas)")).toBe("Magnesio 12 en 1 Complex");
    expect(RESTOCK_DEFAULT_DAYS).toBe(30);
  });
});

describe("el resultado contra el control", () => {
  it("lo que vende es la diferencia con quien no lo recibió", () => {
    const r = restockResultsSummary([
      { arm: "enviado", clientas: 400, respondieron: 60, compraron: 48, entregados: 40 },
      { arm: "control", clientas: 40, respondieron: 0, compraron: 2, entregados: 2 },
    ]);
    expect(r.enviado.tasa).toBeCloseTo(0.12);
    expect(r.veredicto).toBe("Con recordatorio compra el 12.0%; sin él, el 5.0%. El recordatorio suma 7.0 puntos.");
  });

  it("con pocas clientas en el control no se concluye nada", () => {
    expect(
      restockResultsSummary([
        { arm: "enviado", clientas: 50, respondieron: 5, compraron: 5, entregados: 5 },
        { arm: "control", clientas: 6, respondieron: 0, compraron: 0, entregados: 0 },
      ]).veredicto,
    ).toContain("pocas clientas en el grupo de control (6)");
  });
});

describe("MOM §34", () => {
  it("documenta el recordatorio, quién lo atiende y el grupo de control", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("Recordatorio de reposición (13-10-2026)");
    expect(mom).toContain("lo toma una asesora");
    expect(mom).toContain("grupo de control");
    expect(mom).toContain("Un producto sin foto no recibe recordatorio");
  });
});
