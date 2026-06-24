import { describe, it, expect } from "vitest";
import {
  LEAD_STATUSES,
  MANUAL_STATUSES,
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
} from "@/lib/leads";

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
