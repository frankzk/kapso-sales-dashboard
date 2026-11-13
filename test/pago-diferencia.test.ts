import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildPagoDiferenciaRows,
  PAGO_DIFERENCIA_GROUPS,
  PAGO_DIFERENCIA_RETURN_WARN_DAYS,
  RETORNO_OVERDUE_DAYS,
  agencyArrivalMessage,
  porRetornar,
  filterPagoDiferencia,
  isPagoDiferenciaCobro,
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

  it("la pestaña «Todos» suma los tres grupos (owner, 10-11-2026)", () => {
    const tray = readFileSync("components/pago-diferencia-tray.tsx", "utf8");
    expect(tray).toContain('const TABS: readonly GroupTab[] = [...PAGO_DIFERENCIA_GROUPS, "todos", "por_retornar", "retornando"];');
    expect(tray).toContain('if (tab === "todos") return isPagoDiferenciaCobro(r.group);');
    // Abre en «Todos» (owner, 10-11-2026).
    expect(tray).toContain('useState<GroupTab>("todos")');
  });

  // Owner, 13-11-2026: «cómo saber cuáles están retornando de la provincia a
  // Lima porque el cliente nunca pagó la diferencia».
  it("«Retornando»: Shalom u Olva en devolución física pendiente, fuera de «Todos» y de la cuenta", () => {
    const g = (macro_substage: string, current_courier: string | null = "shalom") =>
      pagoDiferenciaGroup({ macro_substage, macro_operation: "agencia", payment_state: "adelanto_validado", current_courier });
    expect(g("devolucion_fisica_pendiente")).toBe("retornando");
    expect(g("devolucion_fisica_pendiente", "olva")).toBe("retornando");
    expect(g("devolucion_fisica_pendiente", "aliclik")).toBeNull();
    expect(isPagoDiferenciaCobro("retornando")).toBe(false);
    expect(PAGO_DIFERENCIA_GROUPS).not.toContain("retornando");
    const [row] = buildPagoDiferenciaRows({
      orders: [order("r", { macro_substage: "devolucion_fisica_pendiente", macro_since: "2026-10-20T15:00:00Z" })],
      payments: [],
      events: [],
      names: new Map(),
      now: NOW,
    });
    expect(row).toMatchObject({ group: "retornando", waitingDays: 21 });
    expect(RETORNO_OVERDUE_DAYS).toBe(15);
    expect(readFileSync("app/dashboard/pedidos/pago-diferencia/page.tsx", "utf8")).toContain("bandeja: rows.filter((r) => isPagoDiferenciaCobro(r.group)).length");
    expect(readFileSync("lib/pago-diferencia-access.ts", "utf8")).toContain('"devolucion_fisica_pendiente"]');
    expect(readFileSync("docs/mom/master-pedidos-v1.md", "utf8")).toContain("**«Retornados» (13-11-2026).**");
  });

  // Owner, 13-11-2026: «que te lance los urgentes por llamar cuando se acercan
  // al plazo». Shalom devuelve a los 38 días de mediana; el 5 % antes de 19.
  it("«Por retornar»: en agencia desde 20 días con Shalom u Olva por vencer", () => {
    const base = { group: "en_agencia" as const, courier: "shalom", waitingDays: 19, expiresAt: null };
    expect(porRetornar(base, NOW)).toBe(false);
    expect(porRetornar({ ...base, waitingDays: PAGO_DIFERENCIA_RETURN_WARN_DAYS }, NOW)).toBe(true);
    expect(porRetornar({ ...base, group: "en_camino", waitingDays: 40 }, NOW)).toBe(false);
    expect(porRetornar({ ...base, courier: "olva", waitingDays: 2, expiresAt: "2026-11-12T20:00:00Z" }, NOW)).toBe(true);
    expect(porRetornar({ ...base, courier: "olva", waitingDays: 25, expiresAt: "2026-11-30T20:00:00Z" }, NOW)).toBe(false);
    const rows = buildPagoDiferenciaRows({
      orders: [order("v", { agency_arrived_at: "2026-10-15T15:00:00Z" }), order("n")],
      payments: [],
      events: [],
      names: new Map(),
      now: NOW,
    });
    expect(rows.find((r) => r.orderId === "v")?.porRetornar).toBe(true);
    expect(rows.find((r) => r.orderId === "n")?.porRetornar).toBe(false);
    const access = readFileSync("lib/pago-diferencia-access.ts", "utf8");
    expect(access).toContain("export async function countPorRetornar(");
  });

  it("«Copiar mensaje»: el aviso YA LLEGÓ con guía, código, producto y saldo", () => {
    const msg = agencyArrivalMessage({
      guideCode: "103118676",
      shalomCodigo: "7PHK",
      products: ["SUPER HUMAN Ethiopian Black Seed Oil"],
      orderTotal: 304.2,
      paidValidated: 30,
      remaining: 274.2,
    });
    expect(msg).toBe(
      [
        "Hola, 👋",
        "",
        "Tu pedido YA LLEGÓ a la agencia y te está esperando.",
        "",
        "📦 Guía: 103118676",
        "🔑 Código: 7PHK",
        "🛍️ Producto: SUPER HUMAN Ethiopian Black Seed Oil",
        "",
        "Resumen de pago:",
        "💰 Monto total del pedido: S/ 304.20",
        "✅ Adelanto recibido: S/ 30.00",
        "💵 Saldo pendiente: S/ 274.20",
        "",
        "🙌 Te recomendamos recogerlo lo antes posible.",
        "",
        "Paga el saldo ahora y tu pedido queda listo para que solo pases a retirarlo.",
        "",
        "📲 Nuestro Yape a nombre del GRUPO GF SAC: 930 555 309",
      ].join("\n"),
    );
    expect(readFileSync("components/pago-diferencia-tray.tsx", "utf8")).toContain("navigator.clipboard.writeText(agencyArrivalMessage(row))");
  });

  it("el menú la lleva y el MOM la documenta", () => {
    expect(readFileSync("components/sidebar.tsx", "utf8")).toContain('href: "/dashboard/pedidos/pago-diferencia"');
    const mom = readFileSync("docs/mom/master-pedidos-v1.md", "utf8");
    expect(mom).toContain("## 44. Bandeja «Pago de diferencia»");
    expect(mom).toContain("pendiente_pago_diferencia");
  });
});
