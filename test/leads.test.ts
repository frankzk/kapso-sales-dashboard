import { describe, it, expect } from "vitest";
import {
  LEAD_STATUSES,
  MANUAL_STATUSES,
  canDispositionLead,
  categoryOf,
  isCallable,
  isValidStatus,
  deriveAutoState,
  nextLeadState,
  isClaimActive,
  mapExcelStatus,
  CLAIM_TTL_MINUTES,
  LEAD_SEGMENTS,
  leadSegment,
  isLeadSegment,
  countLeadSegments,
  LEAD_GESTIONES,
  gestionOf,
  isLeadGestion,
  AUTO_FOLLOWUP_STATUSES,
  defaultFollowupAt,
  countGestiones,
  QUEUE_STATES,
  isQueueState,
  matchesQueueState,
  leadInteractionDateFilterFromParams,
  leadInteractionDateKey,
  matchesLeadInteractionDate,
  countQueueStates,
  yapeKind,
} from "@/lib/leads";

describe("canDispositionLead (a manual call must not silently erase a real sale)", () => {
  it("blocks downgrading a won lead with an ACTIVE order to a non-won status", () => {
    // The reported bug: an order placed directly in Shopify, then a different
    // advisor re-calls the same lead before the queue catches up and marks it
    // "ya_compro_otro_lado" — erasing a real sale.
    expect(
      canDispositionLead({ currentCategory: "won", newStatus: "ya_compro_otro_lado", hasActiveOrder: true }),
    ).toBe(false);
  });
  it("allows the downgrade once the order is no longer active (a genuine loss)", () => {
    expect(
      canDispositionLead({ currentCategory: "won", newStatus: "ya_compro_otro_lado", hasActiveOrder: false }),
    ).toBe(true);
  });
  it("allows re-dispositioning won→won (e.g. re-registering the same sale)", () => {
    expect(
      canDispositionLead({ currentCategory: "won", newStatus: "pedido_generado", hasActiveOrder: true }),
    ).toBe(true);
  });
  it("has nothing to protect when the lead isn't currently won", () => {
    expect(
      canDispositionLead({ currentCategory: "open", newStatus: "ya_compro_otro_lado", hasActiveOrder: true }),
    ).toBe(true);
    expect(
      canDispositionLead({ currentCategory: undefined, newStatus: "no_responde", hasActiveOrder: true }),
    ).toBe(true);
  });
});

describe("gestionOf / countGestiones (call-state buckets)", () => {
  it("maps call dispositions to the right bucket", () => {
    expect(gestionOf("nuevo")).toBe("sin_llamar");
    expect(gestionOf("no_responde")).toBe("nr");
    expect(gestionOf("buzon")).toBe("buzon_cuelga");
    expect(gestionOf("cuelga")).toBe("buzon_cuelga");
    expect(gestionOf("contactado_dejo_wsp")).toBe("contactados");
    expect(gestionOf("otros_productos")).toBe("contactados");
  });
  it("returns null for statuses outside the call queue (casi_cierra, lost, won)", () => {
    expect(gestionOf("casi_cierra")).toBeNull();
    expect(gestionOf("cancelado")).toBeNull();
    expect(gestionOf("pedido_generado")).toBeNull();
  });
  it("isLeadGestion validates bucket keys", () => {
    expect(isLeadGestion("nr")).toBe(true);
    expect(isLeadGestion("frio")).toBe(false); // that's a segment, not a gestión
    expect(isLeadGestion(undefined)).toBe(false);
  });
  it("countGestiones tallies and ignores unmapped statuses", () => {
    expect(
      countGestiones([
        { status: "nuevo" },
        { status: "nuevo" },
        { status: "no_responde" },
        { status: "buzon" },
        { status: "cuelga" },
        { status: "contactado_dejo_wsp" },
        { status: "casi_cierra" }, // unmapped → ignored
        { status: "sin_stock" },
      ]),
    ).toEqual({ sin_llamar: 2, nr: 1, buzon_cuelga: 2, contactados: 1, sin_stock: 1 });
  });
  it("LEAD_GESTIONES lists the buckets in order", () => {
    expect(LEAD_GESTIONES.map((g) => g.key)).toEqual([
      "sin_llamar",
      "nr",
      "buzon_cuelga",
      "contactados",
      "sin_stock",
    ]);
  });
});

describe("leadSegment (Por llamar sub-segmentation)", () => {
  it("Yape leads are no longer a sub-bucket — classified by their other signals", () => {
    // (Ya tienen su propia pestaña superior "Yape/Shalom".)
    expect(
      leadSegment({ status: "yape_por_verificar", cart_item_count: 3, district: "Breña", inbound_count: 9 }),
    ).toBe("carrito");
    expect(leadSegment({ status: "yape_por_verificar" })).toBe("frio");
  });
  it("carrito when an open cart exists (and not a payment handoff)", () => {
    expect(leadSegment({ status: "nuevo", cart_item_count: 2, district: "Surco" })).toBe("carrito");
  });
  it("carrito also triggers on a real Shopify draft (draft_order_gid)", () => {
    expect(leadSegment({ status: "nuevo", draft_order_gid: "gid://shopify/DraftOrder/1" })).toBe("carrito");
  });
  it("distrito when a district was given but no cart", () => {
    expect(leadSegment({ status: "nuevo", district: "Pueblo Libre", inbound_count: 5 })).toBe("distrito");
    expect(leadSegment({ status: "nuevo", district: "   ", inbound_count: 5 })).toBe("converso"); // blank ignored
  });
  it("converso when engaged (inbound >= 2) without cart/district", () => {
    expect(leadSegment({ status: "nuevo", inbound_count: 2 })).toBe("converso");
  });
  it("frio when barely interacted / no signals", () => {
    expect(leadSegment({ status: "nuevo", inbound_count: 1 })).toBe("frio");
    expect(leadSegment({ status: "nuevo" })).toBe("frio");
  });
  it("countLeadSegments tallies and isLeadSegment validates", () => {
    const counts = countLeadSegments([
      { status: "yape_por_verificar" },
      { status: "nuevo", cart_item_count: 1 },
      { status: "nuevo", district: "Ate" },
      { status: "nuevo", inbound_count: 4 },
      { status: "nuevo", inbound_count: 0 },
    ]);
    expect(counts).toEqual({ carrito: 1, distrito: 1, converso: 1, frio: 2 });
    expect(LEAD_SEGMENTS.map((s) => s.key)).toEqual(["carrito", "distrito", "converso", "frio"]);
    expect(isLeadSegment("carrito")).toBe(true);
    expect(isLeadSegment("nope")).toBe(false);
  });
});

describe("queue state (primary axis: Sin llamar vs En seguimiento)", () => {
  it("QUEUE_STATES lists the two state tabs in order", () => {
    expect(QUEUE_STATES.map((s) => s.key)).toEqual(["sin_llamar", "seguimiento"]);
  });

  it("isQueueState accepts the two states, not segments/gestión/loose keys", () => {
    expect(isQueueState("sin_llamar")).toBe(true);
    expect(isQueueState("seguimiento")).toBe(true);
    expect(isQueueState("carrito")).toBe(false); // a segment, not a state
    expect(isQueueState("nr")).toBe(false); // a gestión bucket
    expect(isQueueState("all")).toBe(false);
    expect(isQueueState(undefined)).toBe(false);
  });

  it("splits on whether anyone has called the lead yet (status nuevo)", () => {
    expect(matchesQueueState({ status: "nuevo" }, "sin_llamar")).toBe(true);
    expect(matchesQueueState({ status: "nuevo" }, "seguimiento")).toBe(false);
    expect(matchesQueueState({ status: "no_responde" }, "sin_llamar")).toBe(false);
    expect(matchesQueueState({ status: "no_responde" }, "seguimiento")).toBe(true);
  });

  it("countQueueStates tallies the nuevo / not-nuevo split", () => {
    expect(
      countQueueStates([
        { status: "nuevo" },
        { status: "nuevo" },
        { status: "no_responde" },
        { status: "contactado_dejo_wsp" },
        { status: "buzon" },
      ]),
    ).toEqual({ sin_llamar: 2, seguimiento: 3 });
  });
});

describe("last interaction date filter", () => {
  const lead = {
    last_interaction_at: "2026-07-16T02:30:00.000Z", // July 15, 9:30 p.m. Lima
    first_seen_at: "2026-07-01T15:00:00.000Z",
  };

  it("uses the store calendar day and prefers last interaction over first seen", () => {
    expect(leadInteractionDateKey(lead, "America/Lima")).toBe("2026-07-15");
    expect(
      leadInteractionDateKey(
        { last_interaction_at: null, first_seen_at: "2026-07-14T15:00:00.000Z" },
        "America/Lima",
      ),
    ).toBe("2026-07-14");
  });

  it("matches an exact day and the exclusive +7d boundary", () => {
    expect(matchesLeadInteractionDate(lead, { kind: "day", date: "2026-07-15" }, "America/Lima")).toBe(true);
    expect(matchesLeadInteractionDate(lead, { kind: "day", date: "2026-07-16" }, "America/Lima")).toBe(false);
    expect(matchesLeadInteractionDate(lead, { kind: "older", before: "2026-07-16" }, "America/Lima")).toBe(true);
    expect(matchesLeadInteractionDate(lead, { kind: "older", before: "2026-07-15" }, "America/Lima")).toBe(false);
  });

  it("parses only valid shareable filter params", () => {
    expect(leadInteractionDateFilterFromParams("2026-07-15", undefined)).toEqual({
      kind: "day",
      date: "2026-07-15",
    });
    expect(leadInteractionDateFilterFromParams(undefined, "2026-07-10")).toEqual({
      kind: "older",
      before: "2026-07-10",
    });
    expect(leadInteractionDateFilterFromParams("2026-02-31", undefined)).toBeNull();
  });
});

describe("lead status model", () => {
  it("every status has a unique code and valid category", () => {
    const codes = new Set(LEAD_STATUSES.map((s) => s.code));
    expect(codes.size).toBe(LEAD_STATUSES.length);
    for (const s of LEAD_STATUSES) {
      expect(["won", "hot", "open", "lost"]).toContain(s.category);
    }
  });

  it("won/lost are not callable; open/hot generally are", () => {
    expect(isCallable("pedido_generado")).toBe(false);
    expect(isCallable("lista_negra")).toBe(false);
    expect(isCallable("yape_por_verificar")).toBe(true);
    expect(isCallable("no_responde")).toBe(true);
  });

  it("MANUAL_STATUSES are the agent-settable ones", () => {
    expect(MANUAL_STATUSES.every((s) => s.source === "manual")).toBe(true);
    expect(MANUAL_STATUSES.map((s) => s.code)).toContain("no_responde");
    expect(MANUAL_STATUSES.map((s) => s.code)).not.toContain("yape_por_verificar");
  });

  it("isValidStatus / categoryOf", () => {
    expect(isValidStatus("nuevo")).toBe(true);
    expect(isValidStatus("inventado")).toBe(false);
    expect(categoryOf("ya_compro_otro_lado")).toBe("lost");
    expect(categoryOf("unknown")).toBe("open");
  });

  it("includes the abandoned-cart Excel statuses with the right category", () => {
    expect(isValidStatus("repetido")).toBe(true);
    expect(categoryOf("repetido")).toBe("open");
    expect(isValidStatus("volver_a_llamar")).toBe(true);
    expect(categoryOf("volver_a_llamar")).toBe("open");
    expect(categoryOf("solo_miraba")).toBe("lost");
    expect(categoryOf("fuera_de_ciudad")).toBe("lost");
    expect(MANUAL_STATUSES.map((s) => s.code)).toEqual(
      expect.arrayContaining(["repetido", "volver_a_llamar", "solo_miraba", "fuera_de_ciudad"]),
    );
  });

  it("mapExcelStatus maps the new abandoned-cart comments + reuses buzon for Buzón-CE", () => {
    expect(mapExcelStatus("Solo miraba")).toBe("solo_miraba");
    expect(mapExcelStatus("Fuera de la ciudad")).toBe("fuera_de_ciudad");
    expect(mapExcelStatus("Volver a llamar")).toBe("volver_a_llamar");
    expect(mapExcelStatus("Repetido")).toBe("repetido");
    expect(mapExcelStatus("buzon-ce-sin wsp")).toBe("buzon");
  });
});

describe("deriveAutoState", () => {
  it("order present → won", () => {
    expect(deriveAutoState({ hasOrder: true, handoffReason: "validacion_logistica" })).toEqual({
      status: "pedido_generado",
      category: "won",
      needsAttention: false,
    });
  });
  it("handoff validacion_logistica → hot (Yape por verificar)", () => {
    expect(deriveAutoState({ handoffReason: "validacion_logistica" })).toEqual({
      status: "yape_por_verificar",
      category: "hot",
      needsAttention: true,
    });
  });
  it("unknown handoff reason → casi_cierra (hot)", () => {
    const s = deriveAutoState({ handoffReason: "otra_cosa" });
    expect(s.status).toBe("casi_cierra");
    expect(s.category).toBe("hot");
    expect(s.needsAttention).toBe(true);
  });
  it("payment-flavoured handoff reason variants → Yape por verificar", () => {
    expect(deriveAutoState({ handoffReason: "validacion de pago" }).status).toBe("yape_por_verificar");
    expect(deriveAutoState({ handoffReason: "pago_yape" }).status).toBe("yape_por_verificar");
    expect(deriveAutoState({ handoffReason: "voucher_adelanto" }).status).toBe("yape_por_verificar");
  });
  it("generic handoff reason but payment context → Yape por verificar", () => {
    const s = deriveAutoState({
      handoffReason: "needs_human",
      handoffContext: "Cliente envió voucher de adelanto S/30 para recojo en Shalom",
    });
    expect(s.status).toBe("yape_por_verificar");
  });
  it("generic handoff reason with non-payment context stays casi_cierra", () => {
    expect(
      deriveAutoState({ handoffReason: "needs_human", handoffContext: "Pide hablar con un asesor" }).status,
    ).toBe("casi_cierra");
  });
  it("duplicate → lost", () => {
    expect(deriveAutoState({ isDuplicate: true }).status).toBe("duplicado");
  });
  it("nothing → nuevo (open)", () => {
    expect(deriveAutoState({})).toEqual({ status: "nuevo", category: "open", needsAttention: false });
  });
});

describe("nextLeadState", () => {
  it("order present → won, overriding anything", () => {
    expect(nextLeadState({ status: "no_responde" }, { hasOrder: true })).toEqual({
      status: "pedido_generado",
      category: "won",
      needsAttention: false,
    });
  });
  it("keeps an agent's manual status (null = no change)", () => {
    expect(nextLeadState({ status: "no_responde" }, {})).toBeNull();
  });
  it("re-derives hot from an existing handoff reason", () => {
    expect(
      nextLeadState({ status: "yape_por_verificar", handoff_reason: "validacion_logistica" }, {}),
    ).toMatchObject({ status: "yape_por_verificar", category: "hot", needsAttention: true });
  });
  it("new lead → nuevo", () => {
    expect(nextLeadState(null, {})).toEqual({ status: "nuevo", category: "open", needsAttention: false });
  });
  it("keeps an already-won lead sticky even when a cart signal arrives", () => {
    expect(nextLeadState({ status: "pedido_generado" }, { hasOrder: true, hasRecentIntent: true })).toBeNull();
    expect(nextLeadState({ status: "ya_tiene_pedido" }, { hasOrder: true, hasRecentIntent: true })).toBeNull();
  });
  it("order without a newer cart still wins", () => {
    expect(nextLeadState(null, { hasOrder: true, hasRecentIntent: false })).toMatchObject({
      status: "pedido_generado",
      category: "won",
    });
  });
});

describe("claim lock", () => {
  it("fresh claim is active, stale is not", () => {
    const now = new Date("2026-06-22T12:00:00Z");
    expect(isClaimActive(new Date("2026-06-22T11:55:00Z"), now)).toBe(true); // 5 min
    expect(isClaimActive(new Date("2026-06-22T11:40:00Z"), now)).toBe(false); // 20 min
    expect(isClaimActive(null, now)).toBe(false);
    expect(CLAIM_TTL_MINUTES).toBeGreaterThan(0);
  });
});

describe("mapExcelStatus", () => {
  it("maps known Excel comentarios + agent-named orders", () => {
    expect(mapExcelStatus("Pedido Generado Daphne")).toBe("pedido_generado");
    expect(mapExcelStatus("contactado dejo wsp")).toBe("contactado_dejo_wsp");
    expect(mapExcelStatus("NR")).toBe("no_responde");
    expect(mapExcelStatus("SOLOQUERIA INFORMACION")).toBe("solo_informacion");
    expect(mapExcelStatus("algo raro")).toBe("nuevo");
  });
});

describe("yapeKind (💰 pago vs 📦 agencia dentro de Yape/Shalom)", () => {
  it("el motivo exacto manda: validacion_logistica → agencia; validacion_pago/pago → pago", () => {
    expect(yapeKind("validacion_logistica")).toBe("agencia");
    expect(yapeKind("validacion_pago")).toBe("pago");
    expect(yapeKind("pago")).toBe("pago");
  });

  it("sin motivo exacto, una señal de agencia en el motivo o el contexto → agencia", () => {
    expect(yapeKind("otro", "envío por Shalom a Chimbote")).toBe("agencia");
    expect(yapeKind("coordinar recojo en agencia")).toBe("agencia");
    expect(yapeKind(null, "quiere Olva")).toBe("agencia");
  });

  it("por defecto es pago — incl. voucher por visión (sin motivo de handoff)", () => {
    expect(yapeKind(null, null)).toBe("pago");
    expect(yapeKind(undefined)).toBe("pago");
    expect(yapeKind("", "me pasó su Yape")).toBe("pago");
  });

  it("el pago explícito NO se confunde aunque el contexto mencione agencia (el motivo exacto gana)", () => {
    expect(yapeKind("validacion_pago", "luego lo envía por agencia")).toBe("pago");
  });
});

describe("defaultFollowupAt · agenda automática de casi_cierra / volver_a_llamar", () => {
  it("antes de las 16h locales → hoy 18:00 (Lima, UTC−5)", () => {
    // 15:00Z = 10:00 en Lima → mismo día a las 18:00 Lima = 23:00Z
    expect(defaultFollowupAt("2026-07-13T15:00:00Z", "America/Lima")).toBe("2026-07-13T23:00:00.000Z");
  });

  it("a las 16h o después → mañana 10:00 local", () => {
    // 21:30Z = 16:30 Lima → 14/07 a las 10:00 Lima = 15:00Z
    expect(defaultFollowupAt("2026-07-13T21:30:00Z", "America/Lima")).toBe("2026-07-14T15:00:00.000Z");
  });

  it("de noche cruzando la medianoche UTC, 'mañana' es el día local siguiente", () => {
    // 02:00Z del 14/07 = 21:00 del 13/07 en Lima → mañana local = 14/07 10:00 Lima
    expect(defaultFollowupAt("2026-07-14T02:00:00Z", "America/Lima")).toBe("2026-07-14T15:00:00.000Z");
  });

  it("en UTC reproduce la regla tal cual", () => {
    expect(defaultFollowupAt("2026-07-13T09:00:00Z", "UTC")).toBe("2026-07-13T18:00:00.000Z");
    expect(defaultFollowupAt("2026-07-13T17:00:00Z", "UTC")).toBe("2026-07-14T10:00:00.000Z");
  });

  it("aplica exactamente a casi_cierra y volver_a_llamar", () => {
    expect(AUTO_FOLLOWUP_STATUSES).toEqual(["casi_cierra", "volver_a_llamar"]);
  });
});
