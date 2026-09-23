import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildFicha,
  isStale,
  montoHablado,
  pickOpenCall,
  primerNombre,
  productoCorto,
  staleCallResolution,
  tiendaHablada,
  translateGestion,
  voiceDates,
  type OpenCall,
} from "@/lib/voice-recovery";

// 22-09-2026 21:00 en Lima (martes) = 23-09-2026 02:00 UTC.
const MARTES_NOCHE = new Date("2026-09-23T02:00:00.000Z");

describe("fechas que dice el agente (hora de Lima)", () => {
  it("de noche en Lima sigue siendo hoy, aunque en UTC ya sea mañana", () => {
    // El 22-09-2026 el mock calculó en UTC y dijo un día de más. Lima es UTC-5.
    const d = voiceDates(MARTES_NOCHE);
    expect(d.hoy).toBe("2026-09-22");
    expect(d.hoy_texto).toBe("martes 22 de septiembre");
    expect(d.fecha_minima).toBe("2026-09-23");
    expect(d.fecha_minima_texto).toBe("miércoles 23 de septiembre");
    expect(d.fecha_saludo).toBe("el día de mañana");
  });

  it("nunca ofrece domingo: un sábado propone el lunes y lo dice", () => {
    const sabado = new Date("2026-09-26T15:00:00.000Z");
    const d = voiceDates(sabado);
    expect(d.hoy_texto).toBe("sábado 26 de septiembre");
    expect(d.fecha_minima).toBe("2026-09-28");
    expect(d.fecha_minima_texto).toBe("lunes 28 de septiembre");
    expect(d.fecha_saludo).toBe("el lunes 28");
  });

  it("cruza de mes sin inventar fechas", () => {
    const d = voiceDates(new Date("2026-09-30T15:00:00.000Z"));
    expect(d.fecha_minima_texto).toBe("jueves 1 de octubre");
  });
});

describe("lo que se dice en voz alta", () => {
  it.each([
    [
      "SUPER HUMAN Ethiopian Black Seed Oil – Aceite de Semilla Negra Etíope Alta Potencia (60 Cápsulas)",
      "Aceite de Semilla Negra",
    ],
    [
      "Suplemento Natural para Hígado y Drenaje Linfático (60 cápsulas) SUPER HUMAN",
      "Suplemento Natural para Hígado",
    ],
    ["Nails Repairing – Sérum Tea Tree Ginger para Uñas (30ml)", "Sérum Tea Tree Ginger"],
    ["Crema", "Crema"],
    ["", "su pedido"],
  ])("producto corto de «%s»", (title, corto) => {
    expect(productoCorto(title)).toBe(corto);
  });

  it("no termina en preposición", () => {
    expect(productoCorto("Set de Pelador de Verduras")).toBe("Set de Pelador");
  });

  it("tienda, nombre y monto", () => {
    expect(tiendaHablada("Kenku Peru")).toBe("Kenku");
    expect(tiendaHablada("Aurela")).toBe("Aurela");
    expect(primerNombre("GONZALO Gonzalo")).toBe("Gonzalo");
    expect(montoHablado("298.00")).toBe("S/ 298");
    expect(montoHablado(149.5)).toBe("S/ 149.50");
    expect(montoHablado(null)).toBe("");
  });
});

describe("ficha de identificar_llamada", () => {
  const base = {
    storeName: "Kenku Peru",
    customerName: "Gonzalo Gonzalo",
    orderName: "#KP135098",
    lineItems: [
      {
        title: "SUPER HUMAN Ethiopian Black Seed Oil – Aceite de Semilla Negra Etíope Alta Potencia (60 Cápsulas)",
        quantity: 3,
      },
    ],
    total: "298.00",
    district: "Cusco",
    province: "Cusco",
    address: "Urb Versalles quenqoro lote 10",
    reference: "Costado de la u andina",
    mode: "test" as const,
  };

  it("trae los campos que usa el prompt del agente", () => {
    const f = buildFicha(base, MARTES_NOCHE);
    expect(f).toMatchObject({
      encontrada: true,
      modo: "test",
      tienda: "Kenku",
      nombre: "Gonzalo",
      pedido: "#KP135098",
      producto_corto: "Aceite de Semilla Negra",
      cantidad: 3,
      monto: "S/ 298",
      distrito: "Cusco",
      ciudad: "Cusco",
      fecha_minima_texto: "miércoles 23 de septiembre",
      fecha_saludo: "el día de mañana",
      ventana_horaria: "de 9 de la mañana a 6 de la tarde",
    });
  });

  it("nombra el pedido por Shopify, nunca por un código de guía (§11.1)", () => {
    const f = buildFicha(base, MARTES_NOCHE);
    expect(JSON.stringify(f)).not.toMatch(/AUR5X|KEN5X|guia|guía/i);
  });

  it("con varios productos no inventa uno solo", () => {
    const f = buildFicha(
      { ...base, lineItems: [{ title: "Crema facial", quantity: 1 }, { title: "Sérum", quantity: 2 }] },
      MARTES_NOCHE,
    );
    expect(f.producto_corto).toBe("Crema facial y otros productos");
    expect(f.cantidad).toBe(3);
  });
});

describe("la atadura: la llamada se elige por la fila, no por el teléfono", () => {
  const NOW = new Date("2026-09-22T22:00:00.000Z");
  const hace = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
  const call = (over: Partial<OpenCall>): OpenCall => ({
    id: "c1",
    agent_number: "17058243",
    phone: "930555309",
    status: "dialing",
    dialed_at: hace(1),
    started_at: null,
    ...over,
  });

  it("una sola llamada abierta: es esa, aunque el agente no mande número", () => {
    expect(pickOpenCall([call({})], "dialing", { now: NOW })).toEqual({ call: call({}) });
  });

  it("el número del agente en la URL separa a dos tiendas", () => {
    const calls = [call({ id: "a" }), call({ id: "b", agent_number: "17000000" })];
    expect(pickOpenCall(calls, "dialing", { now: NOW })).toEqual({ error: "ambigua" });
    expect(pickOpenCall(calls, "dialing", { now: NOW, agentNumber: "+5117058243" })).toMatchObject({
      call: { id: "a" },
    });
  });

  it("si llega el teléfono de la clienta y coincide, gana", () => {
    const calls = [call({ id: "a" }), call({ id: "b", phone: "987654321" })];
    expect(pickOpenCall(calls, "dialing", { now: NOW, customerPhone: "+51 987 654 321" })).toMatchObject({
      call: { id: "b" },
    });
  });

  it("un caller ID que no coincide (el +1 de la cuenta) no ata a nada por sí solo", () => {
    const calls = [call({ id: "a" }), call({ id: "b", agent_number: "17000000" })];
    expect(pickOpenCall(calls, "dialing", { now: NOW, customerPhone: "+12027734798" })).toEqual({
      error: "ambigua",
    });
  });

  it("una llamada caducada no recibe nada: ni la ficha ni el registro", () => {
    expect(isStale(call({ dialed_at: hace(4) }), NOW)).toBe(true);
    expect(pickOpenCall([call({ dialed_at: hace(4) })], "dialing", { now: NOW })).toEqual({ error: "ninguna" });
    const enCurso = call({ status: "in_progress", started_at: hace(11) });
    expect(pickOpenCall([enCurso], "in_progress", { now: NOW })).toEqual({ error: "ninguna" });
  });

  it("registrar solo ve llamadas en curso; identificar solo las que marcan", () => {
    expect(pickOpenCall([call({})], "in_progress", { now: NOW })).toEqual({ error: "ninguna" });
  });
});

describe("llamadas caducadas: la clienta se marca primero (§11.8)", () => {
  it("una real que nunca llegó al agente es un «no contesta» y se registra", () => {
    expect(staleCallResolution({ status: "dialing", mode: "real" })).toEqual({
      status: "completed",
      outcome: "no_contesta",
      error: null,
      registerNoAnswer: true,
    });
  });

  it("en modo prueba se cierra igual, pero no escribe nada sobre el pedido", () => {
    expect(staleCallResolution({ status: "dialing", mode: "test" })).toMatchObject({
      outcome: "no_contesta",
      registerNoAnswer: false,
    });
  });

  it("una cortada a media conversación no es gestión: sin resultado y sin escribir", () => {
    expect(staleCallResolution({ status: "in_progress", mode: "real" })).toMatchObject({
      status: "failed",
      outcome: "sin_resultado",
      registerNoAnswer: false,
    });
  });

  it("el no_contesta del barrido es el mismo hecho que el del agente: sin_respuesta", () => {
    const a = translateGestion(
      { disposition: "no_contesta", resumen: "No contestó: la llamada no llegó al agente." },
      { today: "2026-09-23", canDiscard: false, voiceCallId: "vc-9" },
    );
    expect(a).toMatchObject({ kind: "attempt", result: "sin_respuesta", extra: { voice_call_id: "vc-9" } });
  });
});

describe("registrar_gestion: los hechos de cada disposition (§11.8)", () => {
  const opts = { today: "2026-09-22", canDiscard: false, voiceCallId: "vc-1" };

  it("confirma con fecha futura → confirmado, con fecha y dirección en el payload", () => {
    const a = translateGestion(
      { disposition: "confirma", fecha: "2026-09-25", rango: "de 9 a 6", direccion_confirmada: "Lote 10", resumen: "Acepta el viernes." },
      opts,
    );
    expect(a).toMatchObject({
      kind: "attempt",
      result: "confirmado",
      extra: { voice_call_id: "vc-1", reenvio: "swayp", fecha_entrega: "2026-09-25", direccion_confirmada: "Lote 10" },
    });
  });

  it("confirma sin fecha, o con fecha de hoy, NO confirma: queda para una persona", () => {
    for (const fecha of [null, "", "2026-09-22", "2026-09-21", "viernes"]) {
      const a = translateGestion({ disposition: "confirma", fecha }, opts);
      expect(a).toMatchObject({ kind: "attempt", result: "se_deja_mensaje" });
    }
  });

  it("programar con fecha → volver_a_contactar; sin fecha → se_deja_mensaje", () => {
    expect(translateGestion({ disposition: "programar", fecha: "2026-09-24" }, opts)).toMatchObject({
      result: "volver_a_contactar",
      nextContactOn: "2026-09-24",
    });
    expect(translateGestion({ disposition: "programar" }, opts)).toMatchObject({
      result: "se_deja_mensaje",
      nextContactOn: null,
    });
  });

  it("no_contesta → sin_respuesta", () => {
    expect(translateGestion({ disposition: "no_contesta" }, opts)).toMatchObject({ result: "sin_respuesta" });
  });

  it("cancela solo PROPONE el descarte mientras la tienda no lo delegue", () => {
    expect(translateGestion({ disposition: "cancela", motivo: "Ya lo compró en otra tienda" }, opts)).toMatchObject({
      kind: "propose_discard",
      reason: "Agente de voz: Ya lo compró en otra tienda",
    });
    expect(
      translateGestion({ disposition: "cancela", motivo: "No lo quiere" }, { ...opts, canDiscard: true }),
    ).toMatchObject({ kind: "discard" });
  });

  it("una disposition desconocida no escribe nada", () => {
    expect(translateGestion({ disposition: "entregado" }, opts)).toMatchObject({ kind: "invalid" });
    expect(translateGestion({}, opts)).toMatchObject({ kind: "invalid" });
  });
});

describe("la migración", () => {
  const sql = readFileSync("db/migrations/0190_voice_calls.sql", "utf8");

  it("una sola llamada abierta por número de agente", () => {
    expect(sql).toMatch(/create unique index if not exists voice_calls_one_open_per_agent\s+on voice_calls\(agent_number\)\s+where status in \('queued', 'dialing', 'in_progress'\)/);
  });

  it("la v2 escribe la procedencia que recibe; la v1 no se toca", () => {
    expect(sql).toContain("register_confirmation_attempt_v2");
    expect(sql).not.toMatch(/create or replace function public\.register_confirmation_attempt_v1/);
    expect(sql).toContain("v_source, nullif(trim(p_note), '')");
  });
});
