// «Cotejar Olva › Correos de Olva» (MOM §12): cada rótulo que llegó por correo
// y si encontró su pedido. Se fija lo que la pestaña promete: que lo que hizo
// el correo al llegar no se confunda con lo que pasó después, que lo de hoy
// mande sobre la bitácora, y que una fila guardada sin `outcome` (antes de la
// 0226) se lea igual que la rellenó la migración.

import { describe, expect, it } from "vitest";
import {
  buildEmailLog,
  emailLogDayLabel,
  emailLogMoment,
  emailLogSince,
  emailLogWhen,
  groupEmailLogByDay,
  labelOutcome,
  limaDay,
  linkedBy,
  type EmailLabelRow,
  type EmailLogLinkEvent,
  type EmailLogShipment,
} from "@/lib/olva/email-log";

const NOW = new Date("2026-10-05T17:00:00Z"); // 12:00 en Lima, lunes 5

function correo(over: Partial<EmailLabelRow> & { id: string }): EmailLabelRow {
  return {
    message_id: `msg-${over.id}`,
    file_name: "rotulo.pdf",
    received_at: "2026-10-05T14:20:00Z",
    created_at: "2026-10-05T14:21:00Z",
    subject: "Registro exitoso - Registro Nro 202600715289",
    registro: "202600715289",
    olva_tracking: "2669353",
    olva_emision: "26",
    sender_doc: "20556792829",
    recipient_name: "IRIS ROJAS PILARES",
    address: "HUARI - OFICINA HUARI",
    parse_error: null,
    linked_shipment_id: null,
    suggested_order_name: null,
    match_note: null,
    outcome: null,
    ...over,
  };
}

function salida(over: Partial<EmailLogShipment> & { id: string }): EmailLogShipment {
  return { order_id: `ord-${over.id}`, order_name: null, olva_tracking: null, olva_emision: null, ...over };
}

function build(input: {
  labels: EmailLabelRow[];
  shipments?: EmailLogShipment[];
  events?: EmailLogLinkEvent[];
  suggestedOrders?: { order_id: string; order_name: string }[];
  visible?: string[];
}) {
  const shipments = input.shipments ?? [];
  return buildEmailLog({
    labels: input.labels,
    shipments,
    events: input.events ?? [],
    suggestedOrders: input.suggestedOrders ?? [],
    visibleOrderIds: new Set(input.visible ?? shipments.flatMap((s) => (s.order_id ? [s.order_id] : []))),
    orgByRuc: new Map([["20556792829", "org-1"]]),
    truncated: false,
    now: NOW,
  });
}

describe("labelOutcome", () => {
  it("con la 0226, manda lo que guardó el webhook", () => {
    expect(labelOutcome(correo({ id: "a", outcome: "sugerido", match_note: "Ya estaba en #KP1." }))).toBe("sugerido");
  });

  it("sin `outcome`, lee las frases del webhook como el relleno de la migración", () => {
    expect(labelOutcome(correo({ id: "a", olva_tracking: null, parse_error: "no se leyó el tracking del rótulo" }))).toBe(
      "ilegible",
    );
    expect(labelOutcome(correo({ id: "b", linked_shipment_id: "s1", match_note: "Ya estaba en #KP137860." }))).toBe(
      "ya_vinculado",
    );
    expect(labelOutcome(correo({ id: "c", linked_shipment_id: "s1", match_note: "Puesto en #KP137860 (mismo teléfono)." }))).toBe(
      "vinculado",
    );
    expect(labelOutcome(correo({ id: "d", suggested_order_name: "#KP138331" }))).toBe("sugerido");
    expect(labelOutcome(correo({ id: "e", match_note: "Coincide con varias salidas: #KP1, #KP2." }))).toBe("ambiguo");
    expect(labelOutcome(correo({ id: "f", match_note: "Ningún pedido con ese teléfono ni DNI." }))).toBe("sin_pareja");
    expect(labelOutcome(correo({ id: "g", outcome: "otra-cosa", match_note: "Ningún pedido." }))).toBe("sin_pareja");
  });
});

describe("buildEmailLog", () => {
  it("el correo que vinculó al llegar enlaza su pedido", () => {
    const log = build({
      labels: [correo({ id: "a", outcome: "vinculado", linked_shipment_id: "s1", match_note: "Puesto en #KP137860 (mismo teléfono)." })],
      shipments: [salida({ id: "s1", order_name: "#KP137860", olva_tracking: "2669353", olva_emision: "26" })],
    });
    const [e] = log.entries;
    expect(e?.state).toBe("vinculado");
    expect(e?.order).toEqual({ id: "ord-s1", name: "#KP137860" });
    expect(e?.later).toBeNull();
    expect(e?.tracking).toBe("2669353-26");
    expect(e?.orgId).toBe("org-1");
    expect(log.counts.vinculado).toBe(1);
  });

  it("si después se corrigió en el Master, lo dice sin dejar de contar que vinculó", () => {
    const moved = build({
      labels: [correo({ id: "a", outcome: "vinculado", linked_shipment_id: "s1" })],
      shipments: [
        salida({ id: "s1", order_name: "#KP137860" }),
        salida({ id: "s2", order_name: "#KP137999", olva_tracking: "2669353", olva_emision: "26" }),
      ],
    });
    expect(moved.entries[0]?.state).toBe("vinculado");
    expect(moved.entries[0]?.order?.name).toBe("#KP137860");
    expect(moved.entries[0]?.later).toBe("Hoy el tracking está en #KP137999.");

    const gone = build({
      labels: [correo({ id: "a", outcome: "vinculado", linked_shipment_id: "s1" })],
      shipments: [salida({ id: "s1", order_name: "#KP137860" })],
    });
    expect(gone.entries[0]?.later).toBe("Hoy el tracking ya no está en ninguna salida.");
  });

  it("«ya tenía tracking» dice quién se adelantó y a qué hora", () => {
    const log = build({
      labels: [correo({ id: "a", outcome: "ya_vinculado", linked_shipment_id: "s1", match_note: "Ya estaba en #KP137860." })],
      shipments: [salida({ id: "s1", order_name: "#KP137860", olva_tracking: "2669353", olva_emision: "26" })],
      events: [
        {
          shipment_id: "s1",
          occurred_at: "2026-10-05T14:00:00Z",
          actor: null,
          payload: { olvaTracking: "2669353-26", via: "cotejo_doc_externo" },
        },
      ],
    });
    expect(log.entries[0]?.state).toBe("ya_vinculado");
    expect(log.entries[0]?.how).toBe("Lo puso el cotejo del portal (Doc. externo) a las 09:00.");
  });

  it("lo que llegó sin pareja y hoy está en una salida es «vinculado después», con quién lo puso", () => {
    const log = build({
      labels: [correo({ id: "a", outcome: "sin_pareja", match_note: "Ningún pedido con ese teléfono ni DNI." })],
      shipments: [salida({ id: "s1", order_name: "#KP136585", olva_tracking: "2669353", olva_emision: "26" })],
      events: [
        // Un evento de otro tracking de la misma salida no cuenta.
        { shipment_id: "s1", occurred_at: "2026-10-06T10:00:00Z", actor: "u1", payload: { olvaTracking: "1111111-26" } },
        { shipment_id: "s1", occurred_at: "2026-10-05T16:30:00Z", actor: "u1", payload: { olvaTracking: "2669353-26" } },
      ],
    });
    const [e] = log.entries;
    expect(e?.state).toBe("despues");
    expect(e?.order?.name).toBe("#KP136585");
    expect(e?.how).toBe("Lo puso una persona a mano a las 11:30.");
    expect(e?.note).toBe("Ningún pedido con ese teléfono ni DNI.");
  });

  it("lo que sigue sin salida espera a una persona, con su pedido sugerido", () => {
    const log = build({
      labels: [
        correo({
          id: "a",
          outcome: "sugerido",
          suggested_order_name: "#KP138331",
          match_note: "#KP138331 tiene ese teléfono y no tiene salida de Olva sin tracking.",
        }),
        correo({ id: "b", olva_tracking: "2669354", outcome: "sugerido", suggested_order_name: "#AUR9" }),
      ],
      suggestedOrders: [{ order_id: "ord-138331", order_name: "#KP138331" }],
    });
    const [kp, aur] = log.entries;
    expect(kp?.state).toBe("pendiente");
    expect(kp?.suggested).toEqual({ id: "ord-138331", name: "#KP138331" });
    expect(kp?.order).toBeNull();
    // Un sugerido fuera de las tiendas de quien mira se nombra sin enlace.
    expect(aur?.suggested).toEqual({ id: null, name: "#AUR9" });
    expect(log.counts.pendiente).toBe(2);
  });

  it("el ilegible cuenta aparte y conserva el asunto para buscarlo en Outlook", () => {
    const log = build({
      labels: [
        correo({
          id: "a",
          olva_tracking: null,
          olva_emision: null,
          registro: null,
          sender_doc: null,
          parse_error: "no se leyó el tracking del rótulo",
          match_note: "No se leyó el tracking del rótulo.",
        }),
      ],
    });
    const [e] = log.entries;
    expect(e?.state).toBe("ilegible");
    expect(e?.tracking).toBeNull();
    expect(e?.subject).toBe("Registro exitoso - Registro Nro 202600715289");
    expect(e?.orgId).toBeNull();
    expect(log.counts.ilegible).toBe(1);
  });

  it("un pedido de otra tienda se nombra pero no se enlaza", () => {
    const log = build({
      labels: [correo({ id: "a", outcome: "vinculado", linked_shipment_id: "s1" })],
      shipments: [salida({ id: "s1", order_name: "#OTRA1", olva_tracking: "2669353", olva_emision: "26" })],
      visible: [],
    });
    expect(log.entries[0]?.order).toEqual({ id: null, name: "#OTRA1" });
  });

  it("ordena del último correo al primero y agrupa por día de Lima", () => {
    const log = build({
      labels: [
        correo({ id: "viejo", received_at: "2026-10-04T13:00:00Z", outcome: "sin_pareja" }),
        // 03:30 UTC del 5 son las 22:30 del 4 en Lima.
        correo({ id: "noche", received_at: "2026-10-05T03:30:00Z", outcome: "sin_pareja" }),
        correo({ id: "hoy", received_at: "2026-10-05T15:00:00Z", outcome: "sin_pareja" }),
        correo({ id: "sin-fecha", received_at: null, created_at: "2026-10-05T16:00:00Z", outcome: "sin_pareja" }),
      ],
    });
    expect(log.entries.map((e) => e.id)).toEqual(["sin-fecha", "hoy", "noche", "viejo"]);
    expect(log.lastReceivedAt).toBe("2026-10-05T16:00:00Z");
    expect(log.firstReceivedAt).toBe("2026-10-04T13:00:00Z");
    const days = groupEmailLogByDay(log.entries);
    expect(days.map((d) => [d.day, d.entries.length])).toEqual([
      ["2026-10-05", 2],
      ["2026-10-04", 2],
    ]);
  });
});

describe("fechas de Lima", () => {
  it("el día se parte a medianoche de Lima, no de UTC", () => {
    expect(limaDay("2026-10-05T04:59:00Z")).toBe("2026-10-04");
    expect(limaDay("2026-10-05T05:00:00Z")).toBe("2026-10-05");
  });

  it("los días dicen hoy y ayer", () => {
    expect(emailLogDayLabel("2026-10-05", NOW)).toBe("Hoy · lunes 5 de octubre");
    expect(emailLogDayLabel("2026-10-04", NOW)).toBe("Ayer · domingo 4 de octubre");
    expect(emailLogDayLabel("2026-10-02", NOW)).toBe("Viernes 2 de octubre");
    expect(emailLogDayLabel("2025-12-30", NOW)).toBe("Martes 30 de diciembre de 2025");
  });

  it("los momentos y el «desde»", () => {
    expect(emailLogMoment("2026-10-05T14:20:00Z", NOW)).toBe("hoy, 09:20");
    expect(emailLogMoment("2026-10-04T23:05:00Z", NOW)).toBe("ayer, 18:05");
    expect(emailLogMoment("2026-10-02T15:15:00Z", NOW)).toBe("2 oct, 10:15");
    expect(emailLogSince("2026-10-05T14:20:00Z", NOW)).toBe("desde hoy");
    expect(emailLogSince("2026-09-06T14:20:00Z", NOW)).toBe("desde el 6 set");
  });

  it("la hora de «lo puso» omite el día si es el mismo del correo", () => {
    const correoDel3 = "2026-10-03T23:30:00Z"; // 18:30 del sábado 3
    expect(emailLogWhen("2026-10-03T23:45:00Z", correoDel3, NOW)).toBe("a las 18:45");
    expect(emailLogWhen("2026-10-05T05:30:00Z", correoDel3, NOW)).toBe("hoy a las 00:30");
    expect(emailLogWhen("2026-10-04T15:00:00Z", correoDel3, NOW)).toBe("ayer a las 10:00");
    expect(emailLogWhen("2026-10-02T15:00:00Z", "2026-10-01T15:00:00Z", NOW)).toBe("el 2 oct a las 10:00");
  });
});

describe("linkedBy", () => {
  it("nombra el camino que puso el tracking", () => {
    const at = { shipment_id: "s", occurred_at: "2026-10-05T14:00:00Z" };
    expect(linkedBy({ ...at, actor: null, payload: { via: "cotejo_telefono" } })).toBe(
      "el cotejo del portal, con el teléfono de este rótulo",
    );
    expect(linkedBy({ ...at, actor: "u1", payload: { via: "cotejo_algo_nuevo" } })).toBe("el cotejo del portal");
    expect(linkedBy({ ...at, actor: null, payload: { via: "rotulo_dni" } })).toBe("otro correo de Olva (mismo DNI)");
    expect(linkedBy({ ...at, actor: "u1", payload: {} })).toBe("una persona a mano");
    expect(linkedBy({ ...at, actor: null, payload: null })).toBeNull();
    expect(linkedBy(undefined)).toBeNull();
  });
});
