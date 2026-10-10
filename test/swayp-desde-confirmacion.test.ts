import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOrderState, type GuideSnapshot, type OrderSnapshot } from "@/lib/order-status";
import {
  MACRO_SUBSTAGES_BY_STAGE,
  MACRO_SUBSTAGE_LABEL,
  MOM_RESOLUTION_VERSION,
  resolveMacroStage,
  type MacroGuideSnapshot,
  type MacroOrderSnapshot,
} from "@/lib/order-macro-stage";
import {
  SWAYP_DESDE_CONFIRMACION_KIND,
  swaypDesdeConfirmacionFailed,
  swaypDesdeConfirmacionOutcome,
  swaypGuiaDeVuelta,
  swaypNoEntregoMotivo,
} from "@/lib/swayp-desde-confirmacion";

/**
 * Swayp desde Por confirmar (MOM §11.11, v1.24, 09-10-2026, decisión del owner).
 *
 * El pedido de provincia COD sale por Swayp desde la mesa de confirmación, SIN
 * confirmar. Si Swayp entrega, terminó. Si no entrega —por el motivo que sea—,
 * vuelve a «Por confirmar · Swayp no entregó» para llamarlo otra vez, en vez de
 * caer en Gestión Reproprovincia.
 */

const NOW = "2026-10-09T15:00:00.000Z";
const hace = (dias: number) => new Date(Date.parse(NOW) - dias * 86_400_000).toISOString();
const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

const ENVIO = hace(3);

function guia(over: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return {
    id: "sw1",
    courier: "fenix",
    guide_code: "50000144135",
    delivery_status: "en_ruta",
    attempts: 0,
    assigned_at: ENVIO,
    dispatched_at: hace(2),
    out_for_delivery_at: null,
    rescheduled_at: null,
    closed_at: null,
    returned_at: null,
    pickup_state: null,
    agency_branch: null,
    agency_arrived_at: null,
    agency_expires_at: null,
    reported_status: null,
    swayp_state: 5,
    created_at: ENVIO,
    updated_at: hace(1),
    ...over,
  };
}

function macroGuia(g: GuideSnapshot, over: Partial<MacroGuideSnapshot> = {}): MacroGuideSnapshot {
  return {
    id: g.id,
    courier: g.courier,
    delivery_status: g.delivery_status,
    attempts: g.attempts,
    assigned_at: g.assigned_at,
    dispatched_at: g.dispatched_at,
    out_for_delivery_at: g.out_for_delivery_at,
    rescheduled_at: g.rescheduled_at,
    returned_at: g.returned_at,
    pickup_state: g.pickup_state,
    custody_state: g.swayp_state === 8 ? "retorno" : "courier",
    reported_status: g.reported_status,
    swayp_state: g.swayp_state,
    closed_at: g.closed_at,
    updated_at: g.updated_at,
    ...over,
  };
}

const pedido = (over: Partial<OrderSnapshot> = {}): OrderSnapshot => ({
  created_at: hace(6),
  cancelled_at: null,
  financial_status: "pending",
  shipping_mode: "cod",
  ...over,
});

const macroPedido = (over: Partial<MacroOrderSnapshot> = {}): MacroOrderSnapshot => ({
  created_at: hace(6),
  confirmation_activation_date: "2026-06-01",
  cancelled_at: null,
  financial_status: "pending",
  shipping_mode: "cod",
  coverage: "provincia_cod",
  region: "Piura",
  province: "Piura",
  district: "Piura",
  ...over,
});

const caso = { kind: SWAYP_DESDE_CONFIRMACION_KIND, occurred_at: ENVIO, shipment_id: "sw1" };

/** De punta a punta: el legado sale del MISMO `resolveOrderState`. */
function resolver(
  guides: GuideSnapshot[],
  events: { kind: string; occurred_at: string; shipment_id?: string | null }[] = [caso],
  o = pedido(),
) {
  const legacy = resolveOrderState({
    order: o,
    guides,
    events: events.map((e) => ({ kind: e.kind, occurred_at: e.occurred_at, courier: null, new_status: null, new_operational: null })),
    override: null,
    now: NOW,
    recoveryWindowDays: 30,
  });
  return resolveMacroStage({
    order: macroPedido({ cancelled_at: o.cancelled_at }),
    guides: guides.map((g) => macroGuia(g)),
    events,
    legacy: { general: legacy.general, operational: legacy.operational, since: legacy.since },
    paymentState: "sin_pago",
    recoveryWindowDays: 30,
    now: NOW,
  });
}

describe("mientras Swayp lo lleva, el pedido está En curso", () => {
  it("en reparto", () => {
    expect(resolver([guia()]).stage).toBe("en_curso");
  });

  it("una novedad abierta (6) todavía no es un fallo: Swayp la resuelve todos los días", () => {
    const g = guia({ swayp_state: 6, reported_status: "Swayp · Destinatario no contesta (7)" });
    expect(swaypDesdeConfirmacionFailed(g)).toBe(false);
    expect(resolver([g]).stage).toBe("en_curso");
  });
});

describe("si Swayp no entrega, vuelve a Por confirmar", () => {
  it("Devolución (8) por no contesta: Por confirmar · Swayp no entregó, sin motivo especial", () => {
    const g = guia({ swayp_state: 8, reported_status: "Swayp · Destinatario no contesta (7)" });
    const r = resolver([g]);
    expect(r.stage).toBe("por_confirmar");
    expect(r.substage).toBe("swayp_no_entrego");
    expect(r.reasons).toEqual([]);
  });

  it("sin el botón, la misma Swayp fallida sigue yendo a Gestión Reproprovincia", () => {
    const g = guia({ swayp_state: 8, reported_status: "Swayp · Destinatario no contesta (7)" });
    const r = resolver([g], []);
    expect(r.stage).toBe("en_curso");
    expect(r.substage).toBe("gestion_reproprovincia");
  });

  it("un rechazo en la puerta TAMBIÉN vuelve, marcado como tal (decisión del owner)", () => {
    const g = guia({ swayp_state: 8, reported_status: "Swayp · Destinatario ya no desea el producto (16)" });
    const r = resolver([g]);
    expect(r.substage).toBe("swayp_no_entrego");
    expect(r.reasons).toContain("swayp_rechazo_en_puerta");
    expect(swaypNoEntregoMotivo(g)).toBe("rechazo_en_puerta");
  });

  it("una falla de Swayp (bodega no despachó) vuelve con su motivo", () => {
    const g = guia({ swayp_state: 8, reported_status: "Swayp · Bodega no despacho mercancía (20)" });
    expect(resolver([g]).reasons).toContain("swayp_falla_propia");
  });

  it("Devolución confirmada (9) y una guía anulada también vuelven", () => {
    expect(resolver([guia({ swayp_state: 9, delivery_status: "anulado" })]).substage).toBe("swayp_no_entrego");
    expect(resolver([guia({ swayp_state: 10, delivery_status: "anulado" })]).substage).toBe("swayp_no_entrego");
  });

  it("entra a las llamadas: es una subetapa de Por confirmar, no un motivo suelto", () => {
    expect(MACRO_SUBSTAGES_BY_STAGE.por_confirmar).toContain("swayp_no_entrego");
    expect(MACRO_SUBSTAGE_LABEL.swayp_no_entrego).toBe("Swayp no entregó");
  });
});

describe("deja de mandar en cuanto pasa algo después", () => {
  const fallida = () => guia({ swayp_state: 8, reported_status: "Swayp · Destinatario no contesta (7)" });

  it("Swayp entregó: no se toca", () => {
    const r = resolver([guia({ swayp_state: 7, delivery_status: "entregado" })]);
    expect(r.stage).not.toBe("por_confirmar");
  });

  it("se reconfirma después del envío: pasa a Preparación para el rótulo nuevo", () => {
    const r = resolver([fallida()], [caso, { kind: "confirmed", occurred_at: hace(0.5) }]);
    expect(r.stage).toBe("preparacion");
    expect(r.substage).toBe("por_generar_rotulo");
  });

  it("una confirmación ANTERIOR al envío no cuenta", () => {
    const r = resolver([fallida()], [{ kind: "confirmed", occurred_at: hace(4) }, caso]);
    expect(r.substage).toBe("swayp_no_entrego");
  });

  it("sale otra guía: manda la guía nueva", () => {
    const aliclik = guia({
      id: "al1",
      courier: "aliclik",
      guide_code: "AUR5X9",
      delivery_status: "pendiente",
      swayp_state: null,
      dispatched_at: null,
      created_at: hace(0.5),
    });
    const r = resolver([fallida(), aliclik]);
    expect(r.stage).not.toBe("por_confirmar");
  });

  it("anulado en Shopify: lo decide una persona y gana", () => {
    const r = resolver([fallida()], [caso], pedido({ cancelled_at: hace(0.5) }));
    expect(r.stage).not.toBe("por_confirmar");
  });
});

describe("la guía Swayp en Devolución no frena la guía Aliclik", () => {
  it("en Devolución o con la caja de vuelta, no frena", () => {
    expect(swaypGuiaDeVuelta({ courier: "fenix", delivery_status: "en_ruta", swayp_state: 8 })).toBe(true);
    expect(swaypGuiaDeVuelta({ courier: "fenix", delivery_status: "en_ruta", swayp_state: 5, returned_at: hace(1) })).toBe(true);
  });

  it("en reparto o con novedad abierta, sí frena", () => {
    expect(swaypGuiaDeVuelta({ courier: "fenix", delivery_status: "en_ruta", swayp_state: 5 })).toBe(false);
    expect(swaypGuiaDeVuelta({ courier: "fenix", delivery_status: "en_ruta", swayp_state: 6 })).toBe(false);
  });

  it("solo aplica a Swayp", () => {
    expect(swaypGuiaDeVuelta({ courier: "tanders", delivery_status: "en_ruta", reported_status: "RETURNING" })).toBe(false);
  });

  it("las dos puertas de Aliclik la usan", () => {
    const src = read("app/dashboard/pedidos/aliclik-actions.ts");
    expect(src).toContain("!swaypGuiaDeVuelta(guide) &&");
    expect(src).toContain(".find((g) => !isFillableRouteOutput(g) && !swaypGuiaDeVuelta(g));");
  });
});

describe("el registro dice lo mismo que el Master", () => {
  const fallida = guia({ swayp_state: 8, reported_status: "Swayp · Destinatario no contesta (7)" });
  it.each([
    [{ guide: guia(), laterOutputs: [], cancelledAt: null }, "en_camino"],
    [{ guide: guia({ swayp_state: 7, delivery_status: "entregado" }), laterOutputs: [], cancelledAt: null }, "entregado"],
    [{ guide: fallida, laterOutputs: [], cancelledAt: null }, "volvio_a_confirmar"],
    [{ guide: fallida, laterOutputs: [{ delivery_status: "pendiente" }], cancelledAt: null }, "nueva_salida"],
    [{ guide: fallida, laterOutputs: [], cancelledAt: hace(0.5) }, "anulado_shopify"],
  ] as const)("%#", (input, expected) => {
    expect(swaypDesdeConfirmacionOutcome(input)).toBe(expected);
  });
});

describe("el botón", () => {
  it("la acción valida Por confirmar y provincia COD, y graba el hecho antes de recalcular", () => {
    const src = read("app/dashboard/envios/actions.ts");
    expect(src).toContain('if (input.origen === "por_confirmar") {');
    expect(src).toContain('if (m?.macro_stage !== "por_confirmar") {');
    expect(src).toContain('if (m.coverage !== "provincia_cod") {');
    const hecho = src.indexOf("kind: SWAYP_DESDE_CONFIRMACION_KIND,");
    const recalculo = src.indexOf("await syncMasterForShipment(admin, childId);");
    expect(hecho).toBeGreaterThan(0);
    expect(hecho).toBeLessThan(recalculo);
  });

  it("se ofrece solo en Por confirmar, provincia COD, Swayp ok, y no en «Swayp no entregó»", () => {
    const src = read("components/order-drawer.tsx");
    expect(src).toContain('detail.row.macro_substage !== "swayp_no_entrego" &&');
    expect(src).toContain('detail.row.coverage === "provincia_cod" &&');
    expect(src).toContain('detail.row.swayp_availability === "ok" && (');
  });

  it("la versión sube y el MOM lo documenta", () => {
    expect(MOM_RESOLUTION_VERSION).toBe("mom-v1.25");
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("### 11.11 Swayp desde Por confirmar (v1.24, 09-10-2026)");
  });
});
