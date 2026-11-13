// «Lista de pago adelantado» (MOM §41, owner 05-11-2026): la regla pura.
// Lo que se fija:
//   - el celular: una sola forma canónica (`51` + 9 dígitos), y lo que no es
//     un móvil peruano nunca está en la lista;
//   - qué la dispara: UNA definición que reusa los detectores que había
//     (`guideDoorRejection` del §8.2 y Swayp 15/16), más el «rechazado» del
//     motorizado propio y el no recogido en agencia; lo que no es rechazo
//     (no contestó, cancelado, Swayp sin cobertura) no entra;
//   - la baja a mano se respeta: solo un hecho POSTERIOR y nuevo vuelve a
//     agregar;
//   - lo que se exige: el pago completo (`orderFullyPaid`), no el adelanto;
//   - los mensajes, las validaciones y el resumen de la simulación.

import { describe, expect, it } from "vitest";
import { countDoorRejections } from "@/lib/door-rejection";
import {
  PREPAY_LIST_LABEL,
  PREPAY_SIMULATION_SAMPLES,
  parsePrepayEvidence,
  parsePrepaySimulationSummary,
  prepayAutoDecision,
  prepayAutoReason,
  prepayBlockMessage,
  prepayEntryBlockMessage,
  prepayEntryRequirementMet,
  prepayEntryRequirementOf,
  PREPAY_ENTRY_REQUIREMENT_LABEL,
  prepayEvidenceOf,
  prepayEvidenceOrderIds,
  prepayPhoneInput,
  prepayPhoneKey,
  prepayPhoneLabel,
  prepayReasonProblem,
  prepayRequirementMet,
  prepaySimulationHeadline,
  prepayTriggersOfOrder,
  withPrepayListed,
  prepayListedKey,
  prepayKnownOrderIds,
  prepayKnownOrderIdsOf,
  prepayLinkPlan,
  type PrepayEntryFact,
  type PrepayOrderFact,
  type PrepayTrigger,
} from "@/lib/prepay-list";

const order = (over: Partial<PrepayOrderFact> = {}): PrepayOrderFact => ({
  order_id: "o1",
  store_id: "s1",
  order_name: "#KP1",
  customer_phone: "51987654321",
  order_created_at: "2026-10-01T10:00:00Z",
  ...over,
});

describe("el celular", () => {
  it("una sola forma canónica: 51 + 9 dígitos que empiezan por 9", () => {
    for (const raw of ["987654321", "987 654 321", "+51 987-654-321", "51987654321", "0051987654321"]) {
      expect(prepayPhoneKey(raw), raw).toBe("51987654321");
    }
  });

  it("lo que no es un móvil peruano no entra ni se busca", () => {
    for (const raw of ["", null, undefined, "12345", "014445566", "5114445566", "1 202 555 0100", "51887654321"]) {
      expect(prepayPhoneKey(raw as string | null), String(raw)).toBeNull();
    }
    expect(prepayPhoneInput("12345")).toMatchObject({ ok: false });
    expect(prepayPhoneInput("987654321")).toEqual({ ok: true, phone: "51987654321" });
  });

  it("se muestra sin el 51, en grupos de tres", () => {
    expect(prepayPhoneLabel("51987654321")).toBe("987 654 321");
  });
});

describe("qué mete a un celular en la lista (una sola definición)", () => {
  it("el REFUSED de Aliclik, el mismo que cuenta el §8.2", () => {
    const shipments = [{ order_id: "o1", courier: "aliclik", reported_status: "REFUSED · DISPATCHED · CALLED", closed_at: "2026-10-03T15:00:00Z" }];
    const t = prepayTriggersOfOrder({ order: order(), shipments });
    expect(t).toEqual([
      { orderId: "o1", orderName: "#KP1", storeId: "s1", kind: "rechazo_en_puerta", detail: "Aliclik: REFUSED", at: "2026-10-03T15:00:00.000Z" },
    ]);
    // La misma etiqueta que el cierre de Aliclik: no hay dos definiciones.
    expect(countDoorRejections(shipments)).toBe(1);
  });

  it("la novedad 15/16 de Swayp, solo en una guía de Swayp/Fénix", () => {
    const label = "Swayp · Destinatario ya no desea el producto (16)";
    expect(prepayTriggersOfOrder({ order: order(), shipments: [{ order_id: "o1", courier: "swayp", reported_status: label }] })[0]?.kind).toBe(
      "rechazo_en_puerta",
    );
    expect(prepayTriggersOfOrder({ order: order(), shipments: [{ order_id: "o1", courier: "fenix", reported_status: "Swayp · No ha comprado ningún producto (15)" }] }))
      .toHaveLength(1);
    // La misma frase en otro courier no es una novedad de Swayp.
    expect(prepayTriggersOfOrder({ order: order(), shipments: [{ order_id: "o1", courier: "aliclik", reported_status: label }] })).toEqual([]);
    // Sin cobertura, bodega no despachó: es falla de Swayp, no de la clienta.
    expect(prepayTriggersOfOrder({ order: order(), shipments: [{ order_id: "o1", courier: "swayp", reported_status: "Swayp · Sin cobertura (21)" }] })).toEqual([]);
  });

  it("no contestó, cancelado o anulado no son rechazo", () => {
    for (const status of ["NOT_RESPOND · DISPATCHED · CALLED", "CANCEL · TO_PREPARE · CALLED", "ANNULLED", "DELIVERED"]) {
      expect(prepayTriggersOfOrder({ order: order(), shipments: [{ order_id: "o1", courier: "aliclik", reported_status: status }] }), status).toEqual([]);
    }
  });

  it("el «rechazado» del motorizado propio (Grupo GF)", () => {
    const t = prepayTriggersOfOrder({
      order: order(),
      stops: [
        { order_id: "o1", status: "no_entregado", outcome_reason: "rechazado", reported_at: "2026-10-05T20:00:00Z" },
        { order_id: "o1", status: "no_entregado", outcome_reason: "no_contesta", reported_at: "2026-10-04T20:00:00Z" },
      ],
    });
    expect(t).toEqual([expect.objectContaining({ kind: "rechazo_en_puerta", detail: "Motorizado propio: rechazado", at: "2026-10-05T20:00:00.000Z" })]);
  });

  it("no recogió en la agencia: el estado de recojo, o un pedido de agencia que salió y terminó devuelto o anulado", () => {
    expect(
      prepayTriggersOfOrder({ order: order(), shipments: [{ order_id: "o1", courier: "shalom", reported_status: null, pickup_state: "devuelto_al_origen" }] })[0]?.kind,
    ).toBe("no_recogio_en_agencia");
    expect(prepayTriggersOfOrder({ order: order({ pickup_state: "retorno_iniciado" }) })[0]?.kind).toBe("no_recogio_en_agencia");
    expect(
      prepayTriggersOfOrder({ order: order({ agency_branch: "Shalom Juliaca", dispatched_at: "2026-10-02T10:00:00Z", general_status: "anulado" }) })[0]?.kind,
    ).toBe("no_recogio_en_agencia");
    // Anulado sin salir es una corrección, no un no recogido.
    expect(prepayTriggersOfOrder({ order: order({ agency_branch: "Shalom Juliaca", dispatched_at: null, general_status: "anulado" }) })).toEqual([]);
    // Esperando el recojo todavía no es no recogido.
    expect(prepayTriggersOfOrder({ order: order({ pickup_state: "pendiente_de_recojo" }) })).toEqual([]);
  });

  it("un pedido rechazado dos veces es un pedido: un hecho por tipo, el más antiguo", () => {
    const t = prepayTriggersOfOrder({
      order: order(),
      shipments: [
        { order_id: "o1", courier: "aliclik", reported_status: "REFUSED", closed_at: "2026-10-09T10:00:00Z" },
        { order_id: "o1", courier: "aliclik", reported_status: "REFUSED", closed_at: "2026-10-03T10:00:00Z" },
        { order_id: "otro", courier: "aliclik", reported_status: "REFUSED", closed_at: "2026-10-01T10:00:00Z" },
      ],
    });
    expect(t).toHaveLength(1);
    expect(t[0]!.at).toBe("2026-10-03T10:00:00.000Z");
  });
});

const trig = (orderId: string, at: string | null, kind: PrepayTrigger["kind"] = "rechazo_en_puerta"): PrepayTrigger => ({
  orderId,
  orderName: `#${orderId}`,
  storeId: "s1",
  kind,
  detail: "Aliclik: REFUSED",
  at,
});

describe("la regla automática: quién entra y cuándo se respeta una baja", () => {
  it("sin altas previas, un solo hecho basta", () => {
    const d = prepayAutoDecision({ triggers: [trig("o1", "2026-10-03T10:00:00Z")], entries: [] });
    expect(d.add).toBe(true);
    if (d.add) {
      expect(d.reason).toBe("Rechazó en la puerta 1 pedido (#o1).");
      expect(prepayEvidenceOrderIds(d.evidence)).toEqual(["o1"]);
    }
  });

  it("sin hechos, nadie entra", () => {
    expect(prepayAutoDecision({ triggers: [], entries: [] })).toEqual({ add: false, why: "sin_hechos" });
  });

  it("con un alta viva no se agrega otra", () => {
    const entries: PrepayEntryFact[] = [{ source: "manual", added_at: "2026-09-01T00:00:00Z", removed_at: null, evidence: { kind: "manual" } }];
    expect(prepayAutoDecision({ triggers: [trig("o9", "2026-10-03T10:00:00Z")], entries })).toEqual({ add: false, why: "ya_en_lista" });
  });

  it("LA BAJA A MANO SE RESPETA: los mismos hechos no lo vuelven a meter", () => {
    const removed: PrepayEntryFact = {
      source: "auto",
      added_at: "2026-10-04T00:00:00Z",
      removed_at: "2026-10-10T00:00:00Z",
      evidence: { kind: "auto", orders: [{ order_id: "o1" }] },
    };
    // El hecho que lo metió, aunque su fecha se haya movido después de la baja.
    expect(prepayAutoDecision({ triggers: [trig("o1", "2026-10-12T00:00:00Z")], entries: [removed] })).toEqual({
      add: false,
      why: "quitado_sin_hecho_nuevo",
    });
    // Un hecho anterior a la baja que no estaba en la evidencia (p. ej. una baja de un alta manual).
    expect(prepayAutoDecision({ triggers: [trig("o2", "2026-10-05T00:00:00Z")], entries: [removed] })).toEqual({
      add: false,
      why: "quitado_sin_hecho_nuevo",
    });
    // Un hecho sin fecha no se puede probar posterior: manda la persona.
    expect(prepayAutoDecision({ triggers: [trig("o3", null)], entries: [removed] })).toEqual({ add: false, why: "quitado_sin_hecho_nuevo" });
  });

  it("un rechazo NUEVO, posterior a la última baja, lo vuelve a agregar solo con ese hecho", () => {
    const entries: PrepayEntryFact[] = [
      { source: "auto", added_at: "2026-08-01T00:00:00Z", removed_at: "2026-08-10T00:00:00Z", evidence: { kind: "auto", orders: [{ order_id: "o1" }] } },
      { source: "manual", added_at: "2026-09-01T00:00:00Z", removed_at: "2026-10-10T00:00:00Z", evidence: { kind: "manual" } },
    ];
    const d = prepayAutoDecision({
      triggers: [trig("o1", "2026-07-30T00:00:00Z"), trig("o2", "2026-09-15T00:00:00Z"), trig("o3", "2026-10-20T00:00:00Z", "no_recogio_en_agencia")],
      entries,
    });
    expect(d.add).toBe(true);
    if (d.add) {
      expect(d.triggers.map((t) => t.orderId)).toEqual(["o3"]);
      expect(d.reason).toBe("No recogió en la agencia 1 pedido (#o3).");
    }
  });
});

describe("la baja guarda lo que ya se sabía (no la fecha del hecho)", () => {
  const removedWith = (known: unknown, removed_at = "2026-11-01T00:00:00Z"): PrepayEntryFact => ({
    source: "manual",
    added_at: "2026-10-20T00:00:00Z",
    removed_at,
    evidence: { kind: "manual" },
    removed_known_order_ids: known,
  });

  it("un pedido que ya disparaba el alta al quitarla no vuelve a meterlo, aunque su fecha se mueva después de la baja", () => {
    // El alta era manual (su evidencia no nombra pedidos) y el reporte nuevo del
    // courier movió la fecha del mismo rechazo después de la baja.
    expect(prepayAutoDecision({ triggers: [trig("o1", "2026-11-04T00:00:00Z")], entries: [removedWith(["o1"])] })).toEqual({
      add: false,
      why: "quitado_sin_hecho_nuevo",
    });
  });

  it("un pedido que no estaba lo vuelve a meter, aunque su fecha sea anterior a la baja (guía creada antes y rechazada después)", () => {
    const d = prepayAutoDecision({ triggers: [trig("o1", "2026-10-02T00:00:00Z"), trig("o2", "2026-10-26T00:00:00Z")], entries: [removedWith(["o1"])] });
    expect(d.add).toBe(true);
    if (d.add) expect(d.triggers.map((t) => t.orderId)).toEqual(["o2"]);
    // Sin fecha también: el pedido no estaba en lo sabido.
    expect(prepayAutoDecision({ triggers: [trig("o3", null)], entries: [removedWith([])] }).add).toBe(true);
  });

  it("lo sabido de TODAS las bajas cuenta; una baja sin ese dato cae a la fecha", () => {
    const entries = [removedWith(["o1"], "2026-09-01T00:00:00Z"), removedWith(["o2"], "2026-10-01T00:00:00Z")];
    expect(prepayAutoDecision({ triggers: [trig("o1", "2026-10-05T00:00:00Z"), trig("o2", "2026-10-05T00:00:00Z")], entries })).toEqual({
      add: false,
      why: "quitado_sin_hecho_nuevo",
    });
    const legacy = removedWith(null, "2026-10-10T00:00:00Z");
    expect(prepayAutoDecision({ triggers: [trig("o5", "2026-10-05T00:00:00Z")], entries: [legacy] }).add).toBe(false);
    expect(prepayAutoDecision({ triggers: [trig("o5", "2026-10-12T00:00:00Z")], entries: [legacy] }).add).toBe(true);
  });

  it("lo que se guarda: los pedidos sin repetir; lo que se lee tolera la base", () => {
    expect(prepayKnownOrderIdsOf([trig("o2", null), trig("o1", null), trig("o2", null, "no_recogio_en_agencia")])).toEqual(["o1", "o2"]);
    expect(prepayKnownOrderIds(["o1", 3, "", null])).toEqual(["o1"]);
    expect(prepayKnownOrderIds(null)).toBeNull();
    expect(prepayKnownOrderIds({ o1: true })).toBeNull();
  });

  it("la fecha que se muestra no sale de `last_report_at` ni de `status_since`, que se mueven con el mismo hecho", () => {
    const at = prepayTriggersOfOrder({
      order: order(),
      shipments: [
        { order_id: "o1", courier: "aliclik", reported_status: "REFUSED", created_at: "2026-10-02T00:00:00Z", last_report_at: "2026-11-04T00:00:00Z" } as never,
      ],
    })[0]!.at;
    expect(at).toBe("2026-10-02T00:00:00.000Z");
    const agency = prepayTriggersOfOrder({
      order: order({ pickup_state: "devuelto_al_origen", dispatched_at: "2026-10-03T00:00:00Z", status_since: "2026-11-04T00:00:00Z" } as never),
    })[0]!.at;
    expect(agency).toBe("2026-10-03T00:00:00.000Z");
  });
});

describe("el link de pago: lo que falta, en el plan de cobro del pedido", () => {
  const pay = (kind: string, amount: number, validation_status = "validado") => ({ kind, amount, validation_status });

  it("sin comprobantes: el total", () => {
    expect(prepayLinkPlan([], 129.9)).toEqual({ ok: true, kind: "total", amount: 129.9, alreadyPaid: 0 });
    // Un comprobante rechazado no cuenta.
    expect(prepayLinkPlan([pay("adelanto", 20, "rechazado")], 129.9)).toMatchObject({ ok: true, kind: "total", amount: 129.9 });
  });

  it("con un adelanto validado: la diferencia por lo que falta (un «total» chocaría con el índice 0092)", () => {
    expect(prepayLinkPlan([pay("adelanto", 20)], 129.9)).toEqual({ ok: true, kind: "diferencia", amount: 109.9, alreadyPaid: 20 });
    expect(prepayLinkPlan([pay("adelanto", 20), pay("diferencia", 50)], "129.90")).toEqual({ ok: true, kind: "diferencia", amount: 59.9, alreadyPaid: 70 });
  });

  it("con un comprobante por validar, un pago total, nada que cobrar o sin total: no crea cobro", () => {
    for (const status of ["pendiente_revision", "posible_duplicado", "revision_admin"]) {
      expect(prepayLinkPlan([pay("adelanto", 20, status)], 129.9), status).toMatchObject({ ok: false, error: expect.stringMatching(/por validar/) });
    }
    expect(prepayLinkPlan([pay("total", 129.9)], 129.9)).toMatchObject({ ok: false, error: expect.stringMatching(/pago total/) });
    // Menos de S/ 1 por cubrir es redondeo: está pagado.
    expect(prepayLinkPlan([pay("adelanto", 30), pay("diferencia", 99.5)], 129.9)).toMatchObject({ ok: false, error: expect.stringMatching(/ya cubre/) });
    expect(prepayLinkPlan([pay("diferencia", 30)], 129.9)).toMatchObject({ ok: false, error: expect.stringMatching(/adelanto/) });
    expect(prepayLinkPlan([], 0)).toMatchObject({ ok: false });
    expect(prepayLinkPlan([], null)).toMatchObject({ ok: false });
  });
});

describe("la evidencia", () => {
  it("cuenta pedidos por tipo, sin repetir, en orden de fecha, y se lee de vuelta", () => {
    const ev = prepayEvidenceOf([trig("o2", "2026-10-05T00:00:00Z"), trig("o1", "2026-10-01T00:00:00Z"), trig("o1", "2026-10-01T00:00:00Z")]);
    expect(ev.kind).toBe("auto");
    if (ev.kind === "auto") {
      expect(ev.counts).toEqual({ rechazo_en_puerta: 2, no_recogio_en_agencia: 0 });
      expect(ev.orders.map((o) => o.order_id)).toEqual(["o1", "o2"]);
    }
    expect(parsePrepayEvidence(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
    expect(prepayAutoReason(ev)).toBe("Rechazó en la puerta 2 pedidos (#o1, #o2).");
  });

  it("lo que venga raro de la base no rompe", () => {
    expect(parsePrepayEvidence(null)).toEqual({ kind: "manual", order_name: null });
    expect(parsePrepayEvidence({ kind: "auto", orders: [null, { order_id: 3 }] })).toEqual({
      kind: "auto",
      counts: { rechazo_en_puerta: 0, no_recogio_en_agencia: 0 },
      orders: [],
    });
    expect(prepayEvidenceOrderIds("x")).toEqual([]);
  });
});

describe("lo que se exige: el pago completo", () => {
  it("solo el pago completo deja seguir; el adelanto no basta", () => {
    expect(prepayRequirementMet({ paymentState: "pago_completo" })).toBe(true);
    expect(prepayRequirementMet({ financialStatus: "paid", totalRefunded: 0, paymentGateway: "checkout" })).toBe(true);
    for (const paymentState of ["sin_pago", "adelanto_cargado", "adelanto_validado", "diferencia_cargada", "pago_total_cargado"]) {
      expect(prepayRequirementMet({ paymentState }), paymentState).toBe(false);
    }
    // Pagado y reembolsado vuelve a estar por cobrar.
    expect(prepayRequirementMet({ financialStatus: "paid", totalRefunded: 50, paymentGateway: "checkout" })).toBe(false);
  });

  it("cada punto lo dice como la automática (lib/lista-negra-copy.ts): solo cambian el motivo y «pago total»", () => {
    expect(PREPAY_LIST_LABEL).toBe("Lista negra");
    const reason = "Fraude con otra cuenta.";
    expect(prepayBlockMessage("confirmar", reason)).toBe("Lista negra (agregada a mano: Fraude con otra cuenta): falta el pago total validado.");
    expect(prepayBlockMessage("guia", reason)).toBe("Lista negra (agregada a mano: Fraude con otra cuenta): falta el pago total validado.");
    expect(prepayBlockMessage("pedido", reason)).toBe(
      "Lista negra (agregada a mano: Fraude con otra cuenta): solo con pago total por adelantado; no se genera contra entrega.",
    );
    // Al bot nunca el motivo escrito.
    expect(prepayBlockMessage("bot", reason)).toBe(
      "Cliente en Lista negra (agregada a mano). El bot no crea pedidos contra entrega: deriva a una asesora para cobrar el pago total.",
    );
    expect(prepayEntryBlockMessage("confirmar", "adelanto", reason)).toBe("Lista negra (agregada a mano: Fraude con otra cuenta): falta el adelanto de S/ 20 validado.");
    expect(prepayEntryBlockMessage("pedido", "adelanto", reason)).toBe("· Lista negra: no sale sin el adelanto de S/ 20 validado.");
    expect(prepayEntryBlockMessage("bot", "adelanto", reason)).toContain("para cobrar el adelanto de S/ 20 o el pago online completo.");
  });

  it("lo que pide cada alta (0329): sin la columna, el total; el adelanto se cumple con el adelanto validado", () => {
    expect(prepayEntryRequirementOf(undefined)).toBe("pago_completo");
    expect(prepayEntryRequirementOf(null)).toBe("pago_completo");
    expect(prepayEntryRequirementOf("gratis")).toBe("pago_completo");
    expect(prepayEntryRequirementOf("adelanto")).toBe("adelanto");
    expect(PREPAY_ENTRY_REQUIREMENT_LABEL).toEqual({ adelanto: "Adelanto de S/ 20", pago_completo: "Pago total" });
    expect(prepayEntryRequirementMet("adelanto", { paymentState: "adelanto_validado" })).toBe(true);
    expect(prepayEntryRequirementMet("adelanto", { paymentState: "adelanto_cargado" })).toBe(false);
    expect(prepayEntryRequirementMet("pago_completo", { paymentState: "adelanto_validado" })).toBe(false);
    expect(prepayEntryRequirementMet("pago_completo", { paymentState: "pago_completo" })).toBe(true);
  });
});

describe("validaciones y resumen", () => {
  it("el motivo pide al menos 8 caracteres", () => {
    expect(prepayReasonProblem("corto")).toMatch(/al menos 8/);
    expect(prepayReasonProblem("   ocho  ")).toMatch(/al menos 8/);
    expect(prepayReasonProblem("Rechazó dos veces")).toBeNull();
    expect(prepayReasonProblem("x".repeat(501))).toMatch(/largo/);
  });

  it("marca las filas de una página en lote, por organización; sin lectura no afirma nada", () => {
    const storeOrg = new Map([
      ["sA", "orgA"],
      ["sB", "orgB"],
    ]);
    const rows = [
      { store_id: "sA", customer_phone: "987654321" },
      { store_id: "sA", customer_phone: "51911111111" },
      { store_id: "sA", customer_phone: null },
      // El mismo celular en una tienda de OTRA organización: su lista no lo tiene.
      { store_id: "sB", customer_phone: "987654321" },
      // Una tienda que no está en el mapa no se marca.
      { store_id: "sZ", customer_phone: "987654321" },
    ];
    const listed = new Set([prepayListedKey("orgA", "51987654321")]);
    expect(prepayListedKey("orgA", "51987654321")).toBe("orgA|51987654321");
    expect(withPrepayListed(rows, listed, storeOrg).map((r) => r.prepay_listed)).toEqual([true, false, false, false, false]);
    expect(withPrepayListed(rows, null, storeOrg)).toBe(rows);
  });

  it("el resumen de la simulación: cuentas y nombres de pedido, nunca celulares", () => {
    const s = parsePrepaySimulationSummary({
      at: "2026-11-05T15:00:00Z",
      mode: "simulacion",
      phonesWithFacts: 700,
      wouldAdd: 692,
      alreadyListed: 0,
      respectedRemovals: 8,
      withoutPhone: 3,
      byKind: { rechazo_en_puerta: 598, no_recogio_en_agencia: 94 },
      samples: Array.from({ length: 300 }, (_, i) => `#KP${i}`),
    });
    expect(s).not.toBeNull();
    expect(s!.samples).toHaveLength(PREPAY_SIMULATION_SAMPLES);
    expect(prepaySimulationHeadline(s!)).toBe("Entrarían 692 clientes: 598 por rechazo en la puerta y 94 por no recoger en la agencia.");
    expect(prepaySimulationHeadline({ ...s!, mode: "activo", wouldAdd: 1, byKind: { rechazo_en_puerta: 1, no_recogio_en_agencia: 0 } })).toBe(
      "Entraron 1 cliente: 1 por rechazo en la puerta.",
    );
    expect(prepaySimulationHeadline({ ...s!, wouldAdd: 0 })).toBe("No entraría ningún cliente nuevo.");
    expect(parsePrepaySimulationSummary(null)).toBeNull();
    expect(parsePrepaySimulationSummary({ wouldAdd: 3 })).toBeNull();
  });
});
