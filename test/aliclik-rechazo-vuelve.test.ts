// El rechazo de Aliclik que ya vuelve abre la recuperación (05-11-2026).
//
// #KP200684: la clienta lo rechazó en la puerta el 04-11 y desde el 05-11
// Aliclik dice `REFUSED · STORE_CENTRAL` (el paquete en su almacén central),
// pero no anula la guía. Kapta la daba por viva: el pedido seguía «En tránsito»
// y Grupo GF no lo podía tomar para mandarlo con Alexis. Owner: «en Aliclik ya
// está rechazada, no hay más que pedir». Medido en 120 días: de 126 pedidos
// rechazados que llegaron a STORE_CENTRAL ninguno se entregó después; de 1.744
// con cualquier intento fallido en STORE_CENTRAL, ninguno.
import { describe, expect, it } from "vitest";
import { etiquetaDiceVuelveSinEntregar } from "@/lib/aliclik-status";
import { aliclikVuelveSinEntregar, puertaDeSalidaAdicional, salidasQueEstorban } from "@/lib/shipment-output";
import {
  aliclikRefusedReturning,
  guideFailedAfterDispatch,
  recoveryActive,
  recoveryWindow,
} from "@/lib/reproprovincia";
import { resolveOrderState, type GuideSnapshot, type OrderSnapshot } from "@/lib/order-status";
import { resolveMacroStage, type MacroGuideSnapshot, type MacroOrderSnapshot } from "@/lib/order-macro-stage";
import { isRetryAdmission, lastFailedOutput, outputsBlockingRetry } from "@/lib/gf-retry";

const NOW = "2026-11-05T18:00:00.000Z";
const hace = (dias: number) => new Date(Date.parse(NOW) - dias * 86_400_000).toISOString();

/** La S01 de #KP200684 como la deja el barrido de Aliclik. */
function aliclik(over: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return {
    id: "a1",
    courier: "aliclik",
    guide_code: "AUR5X379899835261",
    delivery_status: "en_ruta",
    attempts: 0,
    assigned_at: hace(8),
    dispatched_at: hace(7),
    out_for_delivery_at: null,
    rescheduled_at: null,
    closed_at: null,
    returned_at: null,
    pickup_state: null,
    agency_branch: null,
    agency_arrived_at: null,
    agency_expires_at: null,
    reported_status: "REFUSED · STORE_CENTRAL · CONFIRMED",
    created_at: hace(8),
    // El barrido la reescribe en cada pasada: no sirve de ancla.
    updated_at: hace(0),
    ...over,
  };
}

function pedido(over: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return { created_at: hace(8), cancelled_at: null, financial_status: "pending", shipping_mode: "cod", ...over };
}

function macroGuia(g: GuideSnapshot): MacroGuideSnapshot {
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
    preparation_state: "listo_despacho",
    custody_state: g.returned_at ? "devuelto" : "courier",
    reported_status: g.reported_status,
    closed_at: g.closed_at,
    updated_at: g.updated_at,
  };
}

const lima = (): MacroOrderSnapshot => ({
  created_at: hace(8),
  confirmation_activation_date: "2026-06-01",
  cancelled_at: null,
  financial_status: "pending",
  shipping_mode: "cod",
  coverage: "lima",
  region: "Lima",
  province: "Lima",
  district: "San Juan de Lurigancho",
});

/** De punta a punta: el legado sale del MISMO `resolveOrderState`, con la ventana de Lima. */
function resolverTodo(guides: GuideSnapshot[]) {
  const legacy = resolveOrderState({ order: pedido(), guides, events: [], override: null, now: NOW, recoveryWindowDays: 21 });
  const macro = resolveMacroStage({
    order: lima(),
    guides: guides.map(macroGuia),
    events: [],
    legacy: { general: legacy.general, operational: legacy.operational, since: legacy.since },
    paymentState: "sin_pago",
    recoveryWindowDays: 21,
    now: NOW,
  });
  return { legacy, macro };
}

describe("la etiqueta: el intento falló y el paquete vuelve", () => {
  it("un fallo definitivo con el paquete de vuelta o ya en el almacén central", () => {
    for (const status of ["NOT_RESPOND", "REFUSED", "CANCEL", "ANNULLED"]) {
      for (const dispatch of ["TO_RETURN", "STORE_CENTRAL"]) {
        expect(etiquetaDiceVuelveSinEntregar(`${status} · ${dispatch} · CONFIRMED`), `${status} · ${dispatch}`).toBe(true);
      }
    }
  });

  it("no lo que todavía puede entregarse", () => {
    // En traslado hacia su reparto (provincia): sin intento, sigue viva.
    expect(etiquetaDiceVuelveSinEntregar("PENDING_DELIVERY · STORE_CENTRAL · CONFIRMED")).toBe(false);
    expect(etiquetaDiceVuelveSinEntregar("PENDING_DELIVERY · TO_RETURN · CONFIRMED")).toBe(false);
    expect(etiquetaDiceVuelveSinEntregar("RESCHEDULED · STORE_CENTRAL · CONFIRMED")).toBe(false);
    // El rechazo todavía con el motorizado: 3 de las 5 entregas tras un rechazo salieron de ahí.
    expect(etiquetaDiceVuelveSinEntregar("REFUSED · PICKED · CONFIRMED")).toBe(false);
    expect(etiquetaDiceVuelveSinEntregar(null)).toBe(false);
  });

  it("la puerta de otra salida la lee igual: STORE_CENTRAL ya no bloquea la Swayp directa", () => {
    const guide = { courier: "aliclik", delivery_status: "en_ruta", reported_status: "NOT_RESPOND · STORE_CENTRAL · CONFIRMED", output_code: "KP1-S01", custody_state: "courier" };
    expect(aliclikVuelveSinEntregar(guide)).toBe(true);
    expect(salidasQueEstorban([guide])).toEqual([]);
    expect(puertaDeSalidaAdicional({ courier: "fenix", operation: "provincia_cod", outputs: [guide], motivo: null }).ok).toBe(true);
  });
});

describe("el rechazo que vuelve abre la recuperación", () => {
  it("solo el RECHAZO, solo vivo y solo Aliclik", () => {
    expect(aliclikRefusedReturning(aliclik())).toBe(true);
    expect(aliclikRefusedReturning(aliclik({ reported_status: "REFUSED · TO_RETURN · CONFIRMED" }))).toBe(true);
    // «No contestó» que vuelve espera a que Aliclik anule: el agente de voz sí lo llamaría antes.
    expect(aliclikRefusedReturning(aliclik({ reported_status: "NOT_RESPOND · STORE_CENTRAL · CONFIRMED" }))).toBe(false);
    expect(aliclikRefusedReturning(aliclik({ reported_status: "REFUSED · PICKED · CONFIRMED" }))).toBe(false);
    // Anulada ya la cubre la regla de siempre.
    expect(aliclikRefusedReturning(aliclik({ delivery_status: "anulado", closed_at: hace(0) }))).toBe(false);
    expect(aliclikRefusedReturning(aliclik({ courier: "tanders" }))).toBe(false);
    expect(guideFailedAfterDispatch(aliclik())).toBe(true);
  });

  it("#KP200684: En curso · Por reprogramar Lima, y Grupo GF lo puede tomar", () => {
    const guide = aliclik();
    const { legacy, macro } = resolverTodo([guide]);
    expect(legacy.general).toBe("en_proceso");
    expect(legacy.operational).toBe("pendiente_nuevo_courier");
    expect(macro.stage).toBe("en_curso");
    expect(macro.substage).toBe("por_reprogramar_lima");
    // Anclada en la salida del intento, como Tanders: no en `updated_at`.
    expect(macro.since).toBe(hace(7));
    // La puerta de Grupo GF: es un reintento y la guía de Aliclik no lo frena.
    expect(isRetryAdmission(macro.stage, macro.substage, legacy.operational)).toBe(true);
    expect(outputsBlockingRetry([guide])).toEqual([]);
    expect(lastFailedOutput([guide])?.courier).toBe("aliclik");
    // Es un rechazo en la puerta: el agente de voz y WhatsApp no lo llaman.
    expect(recoveryWindow([guide], [], NOW, 21)?.doorRejection).toBe(true);
  });

  it("«no contestó» que vuelve sigue En tránsito hasta que Aliclik anule", () => {
    const { legacy, macro } = resolverTodo([aliclik({ reported_status: "NOT_RESPOND · STORE_CENTRAL · CONFIRMED" })]);
    expect(legacy.operational).not.toBe("pendiente_nuevo_courier");
    expect(macro.substage).not.toBe("por_reprogramar_lima");
  });

  it("la ventana no vence mientras Aliclik no cierre la guía; después cuenta desde su cierre", () => {
    // Provincia, 7 días, salida de hace 20: vencería antes de abrir.
    const vieja = aliclik({ dispatched_at: hace(20) });
    expect(recoveryWindow([vieja], [], NOW, 7)?.expired).toBe(false);
    expect(recoveryActive([vieja], [], NOW, 7)).not.toBeNull();
    // Aliclik la anula: la ventana de la tienda corre desde `closed_at`.
    const anulada = aliclik({ dispatched_at: hace(20), delivery_status: "anulado", closed_at: hace(2) });
    const w = recoveryWindow([anulada], [], NOW, 7);
    expect(w?.closedAt).toBe(hace(2));
    expect(w?.expired).toBe(false);
    expect(recoveryWindow([aliclik({ delivery_status: "anulado", closed_at: hace(8) })], [], NOW, 7)?.expired).toBe(true);
  });

  it("otra salida viva apaga la recuperación, y una entrega la termina", () => {
    const gf = aliclik({ id: "g2", courier: "propio", reported_status: null, delivery_status: "pendiente", dispatched_at: null });
    expect(recoveryActive([aliclik(), gf], [], NOW, 21)).toBeNull();
    // Aliclik la vuelve a mandar y la entrega (2 de 123 con TO_RETURN): la venta terminó bien.
    expect(recoveryActive([aliclik({ delivery_status: "entregado", reported_status: "DELIVERED · PICKED · CONFIRMED" })], [], NOW, 21)).toBeNull();
  });
});
