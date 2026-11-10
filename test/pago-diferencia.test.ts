import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildPagoDiferenciaRows,
  filterPagoDiferencia,
  isPagoDiferenciaGestion,
  limaDayOf,
  pagoDiferenciaGroup,
  type PagoDiferenciaEventInput,
  type PagoDiferenciaOrderInput,
} from "@/lib/pago-diferencia";

const NOW = new Date("2026-11-10T20:00:00Z"); // 15:00 en Lima

function order(id: string, over: Partial<PagoDiferenciaOrderInput> = {}): PagoDiferenciaOrderInput {
  return {
    order_id: id,
    macro_substage: "pendiente_pago_diferencia",
    macro_operation: "agencia",
    payment_state: "adelanto_validado",
    store_id: "s1",
    order_name: `#KP${id}`,
    customer_name: `Cliente ${id}`,
    customer_phone: "+51987654321",
    order_total: 149,
    current_courier: "shalom",
    guide_code: "102371814",
    agency_branch: "SAN RAMÓN",
    agency_arrived_at: "2026-11-05T15:00:00Z",
    agency_expires_at: null,
    macro_since: "2026-11-05T15:00:00Z",
    province: "Chanchamayo",
    district: "San Ramón",
    ...over,
  };
}

function gestion(orderId: string, at: string, over: Partial<PagoDiferenciaEventInput> = {}): PagoDiferenciaEventInput {
  return {
    order_id: orderId,
    kind: "comment",
    occurred_at: at,
    actor: "u-gero",
    note: "Lo llamé, no contestó; le dejé WhatsApp.",
    comment_type: "Pago de diferencia",
    payload: { photos: ["s1/1/comment-1-a.jpg"] },
    ...over,
  };
}

describe("Pago de diferencia (MOM §44)", () => {
  it("solo cuenta la gestión de una persona", () => {
    expect(isPagoDiferenciaGestion({ kind: "comment", actor: "u" })).toBe(true);
    expect(isPagoDiferenciaGestion({ kind: "chatby_message", actor: "u" })).toBe(true);
    expect(isPagoDiferenciaGestion({ kind: "anura_call", actor: "u" })).toBe(true);
    // El agente de IA y lo automático no tienen persona.
    expect(isPagoDiferenciaGestion({ kind: "comment", actor: null })).toBe(false);
    expect(isPagoDiferenciaGestion({ kind: "status_changed", actor: "u" })).toBe(false);
  });

  it("cuánto falta, contra lo VALIDADO, y si hay un pago por validar", () => {
    const [row] = buildPagoDiferenciaRows({
      orders: [order("1")],
      payments: [
        { order_id: "1", kind: "adelanto", amount: 20, validation_status: "validado" },
        { order_id: "1", kind: "diferencia", amount: 129, validation_status: "pendiente" },
        { order_id: "1", kind: "diferencia", amount: 50, validation_status: "rechazado" },
      ],
      events: [],
      names: new Map(),
      now: NOW,
    });
    expect(row).toMatchObject({ orderTotal: 149, paidValidated: 20, remaining: 129, paymentToValidate: true });
  });

  it("menos de S/ 1 es redondeo, no saldo", () => {
    const [row] = buildPagoDiferenciaRows({
      orders: [order("1", { order_total: 149.5 })],
      payments: [{ order_id: "1", kind: "adelanto", amount: 149, validation_status: "validado" }],
      events: [],
      names: new Map(),
      now: NOW,
    });
    expect(row!.remaining).toBe(0);
  });

  it("la última gestión dice quién, cuándo, por dónde, qué y con cuántas fotos", () => {
    const [row] = buildPagoDiferenciaRows({
      orders: [order("1")],
      payments: [],
      events: [
        gestion("1", "2026-11-08T15:00:00Z", { note: "La primera" }),
        gestion("1", "2026-11-10T16:00:00Z"),
        gestion("1", "2026-11-10T17:00:00Z", { actor: null, note: "IA" }),
      ],
      names: new Map([["u-gero", "gero"]]),
      now: NOW,
    });
    expect(row!.lastGestion).toEqual({
      at: "2026-11-10T16:00:00Z",
      actorName: "gero",
      channel: "Comentario",
      commentType: "Pago de diferencia",
      note: "Lo llamé, no contestó; le dejé WhatsApp.",
      photoCount: 1,
    });
    expect(row!.gestionCount).toBe(2);
    expect(row!.gestionadoHoy).toBe(true);
    expect(row!.waitingDays).toBe(5);
  });

  it("«hoy» es el día de Lima, no el de UTC", () => {
    // 04:00 UTC del 10 = 23:00 del 9 en Lima: fue AYER.
    expect(limaDayOf("2026-11-10T04:00:00Z")).toBe("2026-11-09");
    const [row] = buildPagoDiferenciaRows({
      orders: [order("1")],
      payments: [],
      events: [gestion("1", "2026-11-10T04:00:00Z", { kind: "chatby_message", comment_type: null })],
      names: new Map(),
      now: NOW,
    });
    expect(row!.gestionadoHoy).toBe(false);
    expect(row!.lastGestion?.channel).toBe("WhatsApp (Chatby)");
    expect(row!.lastGestion?.commentType).toBeNull();
  });

  it("primero lo que nadie gestionó hoy; dentro, lo vencido y lo que más espera", () => {
    const rows = buildPagoDiferenciaRows({
      orders: [
        order("hoy", { agency_arrived_at: "2026-10-01T15:00:00Z" }),
        order("nuevo", { agency_arrived_at: "2026-11-09T15:00:00Z" }),
        order("viejo", { agency_arrived_at: "2026-10-20T15:00:00Z" }),
        order("olva", { current_courier: "olva", agency_expires_at: "2026-11-09T00:00:00Z", agency_arrived_at: "2026-11-08T15:00:00Z" }),
      ],
      payments: [],
      events: [gestion("hoy", "2026-11-10T15:00:00Z")],
      names: new Map(),
      now: NOW,
    });
    expect(rows.map((r) => r.orderId)).toEqual(["olva", "viejo", "nuevo", "hoy"]);
    expect(rows[0]!.expired).toBe(true);
    expect(filterPagoDiferencia(rows, "por_gestionar").map((r) => r.orderId)).toEqual(["olva", "viejo", "nuevo"]);
    expect(filterPagoDiferencia(rows, "gestionados_hoy").map((r) => r.orderId)).toEqual(["hoy"]);
    expect(filterPagoDiferencia(rows, "sin_gestion")).toHaveLength(3);
    expect(filterPagoDiferencia(rows, "todos")).toHaveLength(4);
  });

  it("tres grupos: en agencia, en camino (Agencia sin pago completo) y recogidos sin pago", () => {
    const g = (macro_substage: string, macro_operation = "agencia", payment_state = "adelanto_validado", current_courier: string | null = "shalom") =>
      pagoDiferenciaGroup({ macro_substage, macro_operation, payment_state, current_courier });
    expect(g("pendiente_pago_diferencia", "agencia")).toBe("en_agencia");
    expect(g("en_transito")).toBe("en_camino");
    expect(g("en_destino", "agencia", "adelanto_cargado")).toBe("en_camino");
    // Contra entrega o ya pagado: no se le pide diferencia.
    expect(g("en_transito", "provincia_cod")).toBeNull();
    expect(g("en_transito", "lima")).toBeNull();
    expect(g("en_destino", "agencia", "pago_completo")).toBeNull();
    expect(g("recogido_sin_pago_completo", "agencia", "sin_pago")).toBe("recogido_sin_pago");
    expect(g("disponible_para_recojo", "agencia", "pago_completo")).toBeNull();
    // Solo Shalom u Olva (owner, 10-11-2026: #KP130282 iba por Fenix).
    expect(g("en_transito", "agencia", "adelanto_validado", "olva")).toBe("en_camino");
    expect(g("en_transito", "agencia", null as unknown as string, "fenix")).toBeNull();
    expect(g("recogido_sin_pago_completo", "agencia", "sin_pago", null)).toBeNull();
    expect(g("recogido_sin_pago_completo", "agencia", "sin_pago", "aliclik")).toBeNull();
    expect(g("pendiente_pago_diferencia", "agencia", "adelanto_validado", "urpi")).toBeNull();

    const rows = buildPagoDiferenciaRows({
      orders: [
        order("a"),
        order("b", { macro_substage: "en_destino", agency_expires_at: "2026-11-01T00:00:00Z" }),
        order("c", { macro_substage: "recogido_sin_pago_completo" }),
        order("d", { macro_substage: "en_transito", macro_operation: "provincia_cod" }),
      ],
      payments: [],
      events: [],
      names: new Map(),
      now: NOW,
    });
    expect(rows.map((r) => [r.orderId, r.group, r.substage])).toEqual(
      expect.arrayContaining([
        ["a", "en_agencia", null],
        ["b", "en_camino", "En destino"],
        ["c", "recogido_sin_pago", null],
      ]),
    );
    expect(rows).toHaveLength(3);
    // El plazo de la agencia solo cuenta con el paquete en la sucursal.
    expect(rows.find((r) => r.orderId === "b")!.expired).toBe(false);
  });

  it("corregir la dirección no es una gestión con la clienta", () => {
    expect(isPagoDiferenciaGestion({ kind: "comment", actor: "u", comment_type: "ubicacion" })).toBe(false);
    expect(isPagoDiferenciaGestion({ kind: "comment", actor: "u", comment_type: "Pago de diferencia" })).toBe(true);
  });

  it("el menú la lleva y el MOM la documenta", () => {
    expect(readFileSync("components/sidebar.tsx", "utf8")).toContain('href: "/dashboard/pedidos/pago-diferencia"');
    const mom = readFileSync("docs/mom/master-pedidos-v1.md", "utf8");
    expect(mom).toContain("## 44. Bandeja «Pago de diferencia»");
    expect(mom).toContain("pendiente_pago_diferencia");
  });
});
