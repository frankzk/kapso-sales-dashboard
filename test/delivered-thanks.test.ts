import { describe, expect, it } from "vitest";
import {
  THANKS_BATCH_CAP,
  THANKS_MAX_ATTEMPTS,
  parseThanksBodyParams,
  parseThanksButtonParam,
  runDeliveredThanks,
  thanksBodyParams,
  thanksButtonParam,
  thanksConfig,
  thanksSkipReason,
  type ThanksCandidate,
  type ThanksHistory,
} from "@/lib/delivered-thanks";
import type { StoreCreds } from "@/lib/ingest";

/**
 * «Ni bien el pedido se marca como entregado, se les envía una plantilla de
 * WhatsApp»: agradecimiento y botón al catálogo privado con descuento, que
 * identifica a la clienta por su celular (`?wa=`).
 */

const NOW = "2026-09-25T17:00:00.000Z"; // 12:00 en Lima
const nowMs = Date.parse(NOW);

const pedido = (over: Partial<ThanksCandidate> = {}): ThanksCandidate => ({
  order_id: "o1",
  order_name: "#KP136564",
  customer_name: "FERNANDO ruiz",
  customer_phone: "51945425593",
  general_status: "entregado",
  delivered_at: "2026-09-25T15:00:00.000Z",
  ...over,
});

const vacio = (): ThanksHistory => ({
  thankedOrders: new Set(),
  failedAttempts: new Map(),
  recentPhones: new Set(),
});

describe("a quién se le agradece", () => {
  it("un pedido recién entregado, con nombre y celular válido", () => {
    expect(thanksSkipReason(pedido(), vacio(), { nowMs, maxHours: 72 })).toBeNull();
  });

  it("solo si está ENTREGADO", () => {
    for (const general_status of ["en_proceso", "devuelto", "anulado", null]) {
      expect(
        thanksSkipReason(pedido({ general_status }), vacio(), { nowMs, maxHours: 72 }),
        String(general_status),
      ).toBe("el pedido no está entregado");
    }
  });

  /**
   * Muchas entregas se marcan en bloque al importar un reporte de Aliclik, a
   * veces días después. Un «gracias» de hace una semana suena a error.
   */
  it("no si la entrega es vieja", () => {
    const vieja = pedido({ delivered_at: "2026-09-20T15:00:00.000Z" });
    expect(thanksSkipReason(vieja, vacio(), { nowMs, maxHours: 72 })).toContain("más de 72 h");
  });

  it("una vez por pedido", () => {
    const h = vacio();
    h.thankedOrders.add("o1");
    expect(thanksSkipReason(pedido(), h, { nowMs, maxHours: 72 })).toBe("ya se le agradeció");
  });

  it("una vez por clienta cada 7 días, aunque sea otro pedido", () => {
    const h = vacio();
    h.recentPhones.add("51945425593");
    expect(thanksSkipReason(pedido({ order_id: "o2" }), h, { nowMs, maxHours: 72 })).toContain(
      "últimos 7 días",
    );
  });

  it("deja de intentar tras varios rechazos de Meta", () => {
    const h = vacio();
    h.failedAttempts.set("o1", THANKS_MAX_ATTEMPTS);
    expect(thanksSkipReason(pedido(), h, { nowMs, maxHours: 72 })).toContain("rechazó");
  });

  it("sin celular peruano válido o sin nombre, no se gasta el envío", () => {
    expect(
      thanksSkipReason(pedido({ customer_phone: "945425593" }), vacio(), { nowMs, maxHours: 72 }),
    ).toBe("sin número de WhatsApp válido");
    expect(
      thanksSkipReason(pedido({ customer_name: "  " }), vacio(), { nowMs, maxHours: 72 }),
    ).toBe("sin nombre de la clienta");
  });
});

describe("las variables de la plantilla", () => {
  it("el nombre es solo el primero, con mayúscula inicial", () => {
    expect(thanksBodyParams(["nombre"], pedido())).toEqual(["Fernando"]);
  });

  it("el pedido va sin «#»", () => {
    expect(thanksBodyParams(["nombre", "pedido"], pedido())).toEqual(["Fernando", "KP136564"]);
  });

  /**
   * En una URL el «+» se lee como espacio: `?wa=+519…` le llegaría al catálogo
   * como ` 519…`. Van solo dígitos.
   */
  it("el celular del botón va en dígitos y sin «+»", () => {
    expect(thanksButtonParam("telefono", pedido({ customer_phone: "+51 945 425 593" }))).toBe(
      "51945425593",
    );
  });

  it("los tokens desconocidos se ignoran y el botón vacío significa sin botón", () => {
    expect(parseThanksBodyParams("nombre, precio ,pedido")).toEqual(["nombre", "pedido"]);
    expect(parseThanksButtonParam("")).toBeNull();
    expect(parseThanksButtonParam("TELEFONO")).toBe("telefono");
  });
});

const creds = (over: Partial<StoreCreds> = {}): StoreCreds =>
  ({
    kapso_api_key: "k",
    whatsapp_phone_number_id: "pn",
    timezone: "America/Lima",
    delivered_thanks_enabled: true,
    delivered_thanks_template_name: "gracias_entrega_oferta",
    delivered_thanks_template_language: "es",
    delivered_thanks_params: "nombre",
    delivered_thanks_button_param: "telefono",
    delivered_thanks_phone_number_id: null,
    delivered_thanks_hour_start: 9,
    delivered_thanks_hour_end: 21,
    delivered_thanks_max_hours: 72,
    ...over,
  }) as StoreCreds;

describe("la config de la tienda", () => {
  it("apagada o sin nombre de plantilla, no hay config", () => {
    expect(thanksConfig(creds({ delivered_thanks_enabled: false }))).toBeNull();
    expect(thanksConfig(creds({ delivered_thanks_template_name: null }))).toBeNull();
    expect(thanksConfig(creds({ kapso_api_key: null }))).toBeNull();
  });

  it("el número propio gana sobre el de la tienda", () => {
    expect(thanksConfig(creds({ delivered_thanks_phone_number_id: "otro" }))?.phoneNumberId).toBe(
      "otro",
    );
  });
});

/** Una base falsa con lo justo: order_master para leer, envíos para registrar. */
function fakeAdmin(rows: ThanksCandidate[], previos: { order_id: string; ok: boolean; phone: string }[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const builder = (table: string) => {
    let result: unknown[] = [];
    if (table === "order_master") result = rows;
    if (table === "delivered_thanks_sends") result = previos;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "order", "limit", "in"]) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: result, error: null });
    b.insert = async (row: Record<string, unknown>) => {
      inserted.push(row);
      return { error: null };
    };
    return b;
  };
  return { admin: { from: builder } as never, inserted };
}

describe("una corrida del cron", () => {
  it("envía con el nombre en el cuerpo y el celular en el botón, y lo registra", async () => {
    const { admin, inserted } = fakeAdmin([pedido()]);
    const llamadas: unknown[] = [];
    const r = await runDeliveredThanks(
      admin,
      "s1",
      creds(),
      async (_o, p) => {
        llamadas.push(p);
        return { ok: true };
      },
      NOW,
    );
    expect(r).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(llamadas[0]).toMatchObject({
      to: "51945425593",
      templateName: "gracias_entrega_oferta",
      bodyParams: ["Fernando"],
      buttonUrlParams: ["51945425593"],
    });
    expect(inserted[0]).toMatchObject({ order_id: "o1", ok: true });
  });

  it("dos pedidos de la misma clienta en el mismo lote: un solo agradecimiento", async () => {
    const { admin } = fakeAdmin([pedido({ order_id: "o1" }), pedido({ order_id: "o2" })]);
    let envios = 0;
    const r = await runDeliveredThanks(
      admin,
      "s1",
      creds(),
      async () => {
        envios += 1;
        return { ok: true };
      },
      NOW,
    );
    expect(envios).toBe(1);
    expect(r.skipped).toBe(1);
  });

  /**
   * Una importación que marca 200 entregas de golpe no puede convertirse en 200
   * plantillas de marketing en un minuto.
   */
  it("respeta el tope por corrida", async () => {
    const muchos = Array.from({ length: 60 }, (_, i) =>
      pedido({ order_id: `o${i}`, customer_phone: `519${String(i).padStart(8, "0")}` }),
    );
    const { admin } = fakeAdmin(muchos);
    const r = await runDeliveredThanks(admin, "s1", creds(), async () => ({ ok: true }), NOW);
    expect(r.sent).toBe(THANKS_BATCH_CAP);
  });

  it("fuera de horario no envía nada", async () => {
    const { admin } = fakeAdmin([pedido()]);
    const madrugada = "2026-09-25T08:00:00.000Z"; // 03:00 en Lima
    const r = await runDeliveredThanks(admin, "s1", creds(), async () => ({ ok: true }), madrugada);
    expect(r).toEqual({ sent: 0, failed: 0, skipped: 0 });
  });

  it("un rechazo se registra y no marca el pedido como agradecido", async () => {
    const { admin, inserted } = fakeAdmin([pedido()]);
    const r = await runDeliveredThanks(
      admin,
      "s1",
      creds(),
      async () => ({ ok: false, error: "template not approved", code: 132001 }),
      NOW,
    );
    expect(r.failed).toBe(1);
    expect(inserted[0]).toMatchObject({ ok: false, error: "template not approved" });
  });

  it("el tope de mensajería de Meta corta el lote", async () => {
    const dos = [pedido({ order_id: "o1" }), pedido({ order_id: "o2", customer_phone: "51900000002" })];
    const { admin } = fakeAdmin(dos);
    let intentos = 0;
    await runDeliveredThanks(
      admin,
      "s1",
      creds(),
      async () => {
        intentos += 1;
        return { ok: false, error: "messaging limit reached", code: 131048 };
      },
      NOW,
    );
    expect(intentos).toBe(1);
  });
});
