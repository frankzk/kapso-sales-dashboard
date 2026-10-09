// «Por reprogramar Lima» que de verdad lo es, y que Grupo GF puede tomar
// (v1.19, 29-09-2026). Tres reglas del Master y una puerta de Despacho del día:
//
//   1. La guía Swayp directa no es una reprogramación (#KP135009).
//   2. Tanders que no entrega abre la recuperación, con 65 días (#KP135035,
//      #KP135161).
//   3. Una salida devuelta no cierra el pedido si otra sigue viva.
//   4. «Desde la lista» ofrece lo que otro courier no entregó y, al tomarlo,
//      abre una salida nueva con el motivo escrito solo.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { derivedGuideDates } from "@/lib/guide-dates";
import {
  TANDERS_RECOVERY_DAYS,
  guideFailedAfterDispatch,
  recoveryActive,
  recoveryOutcome,
  recoveryWindow,
  tandersGuideFailed,
} from "@/lib/reproprovincia";
import { resolveOrderState, type GuideSnapshot, type OrderSnapshot } from "@/lib/order-status";
import {
  MOM_RESOLUTION_VERSION,
  resolveMacroStage,
  type MacroGuideSnapshot,
  type MacroOrderSnapshot,
} from "@/lib/order-macro-stage";
import {
  RETRY_QUEUE_FILTER,
  failedOutputLabel,
  isRetryAdmission,
  lastFailedOutput,
  outputsBlockingRetry,
  retryAdditionalReason,
  retryTakenNote,
} from "@/lib/gf-retry";
import { puertaDeSalidaAdicional } from "@/lib/shipment-output";
import { EMPTY_QUEUE_FILTERS, filterQueue, isPorReprogramar, queueTileCounts, type QueueRow } from "@/lib/dispatch-day";

const NOW = "2026-09-29T15:00:00.000Z";
const hace = (dias: number) => new Date(Date.parse(NOW) - dias * 86_400_000).toISOString();
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** Guía de Tanders como la deja su barrido: RETURNING sigue en ruta y vuelve. */
function tanders(over: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return {
    id: "t1",
    courier: "tanders",
    guide_code: "TANDER17897732286911945",
    delivery_status: "en_ruta",
    attempts: 0,
    assigned_at: hace(12),
    dispatched_at: hace(10),
    out_for_delivery_at: null,
    rescheduled_at: null,
    closed_at: null,
    returned_at: null,
    pickup_state: null,
    agency_branch: null,
    agency_arrived_at: null,
    agency_expires_at: null,
    reported_status: "RETURNING",
    created_at: hace(12),
    // El barrido la toca cada hora: no sirve de ancla.
    updated_at: hace(0),
    ...over,
  };
}

const RETURNED = { delivery_status: "anulado", reported_status: "RETURNED", returned_at: hace(4) } as const;

function pedido(over: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return { created_at: hace(13), cancelled_at: null, financial_status: "pending", shipping_mode: "cod", ...over };
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
    preparation_state: "listo_despacho",
    custody_state: g.returned_at ? "devuelto" : g.reported_status === "RETURNING" ? "retorno" : "courier",
    reported_status: g.reported_status,
    closed_at: g.closed_at,
    updated_at: g.updated_at,
    ...over,
  };
}

const lima = (over: Partial<MacroOrderSnapshot> = {}): MacroOrderSnapshot => ({
  created_at: hace(13),
  confirmation_activation_date: "2026-06-01",
  cancelled_at: null,
  financial_status: "pending",
  shipping_mode: "cod",
  coverage: "lima",
  region: "Lima",
  province: "Lima",
  district: "Ate",
  ...over,
});

/** De punta a punta: el legado sale del MISMO `resolveOrderState`. */
function resolverTodo(guides: GuideSnapshot[], o = pedido(), macroOver: Partial<MacroGuideSnapshot>[] = [], orderOver: Partial<MacroOrderSnapshot> = {}) {
  const legacy = resolveOrderState({ order: o, guides, events: [], override: null, now: NOW, recoveryWindowDays: 30 });
  const macro = resolveMacroStage({
    order: lima({ cancelled_at: o.cancelled_at, ...orderOver }),
    guides: guides.map((g, i) => macroGuia(g, macroOver[i] ?? {})),
    events: [],
    legacy: { general: legacy.general, operational: legacy.operational, since: legacy.since },
    paymentState: "sin_pago",
    recoveryWindowDays: 30,
    now: NOW,
  });
  return { legacy, macro };
}

describe("1. la guía Swayp directa no es una reprogramación (#KP135009)", () => {
  it("la gestión con la que nace la guía directa no fija fecha de reprogramación", () => {
    // La que deja la guía directa: cuenta como gestión, no como reprogramada.
    const d = derivedGuideDates([{ kind: "reroute", new_status: null, occurred_at: hace(1) }], { directGuide: true });
    expect(d.rescheduled_at).toBeNull();
    // Pero sí es un movimiento de la guía.
    expect(d.lastCallAt).toBe(hace(1));
  });

  it("en una guía MADRE la misma fila sin estado sí reprograma (reenvíos de julio, #KP117144)", () => {
    // En julio el reenvío por Fenix dejaba el `reroute` sin estado en la madre.
    // La v1.19 lo ignoraba en todas las guías y cinco pedidos cayeron en
    // «Preparación · Por armar».
    expect(derivedGuideDates([{ kind: "reroute", new_status: null, occurred_at: hace(40) }]).rescheduled_at).toBe(hace(40));
    expect(derivedGuideDates([{ kind: "reroute", new_status: null, occurred_at: hace(40) }], { directGuide: false }).rescheduled_at).toBe(hace(40));
  });

  it("las reprogramaciones de verdad siempre cuentan, también en una guía directa", () => {
    expect(derivedGuideDates([{ kind: "reroute", new_status: "en_ruta", occurred_at: hace(2) }], { directGuide: true }).rescheduled_at).toBe(hace(2));
    expect(derivedGuideDates([{ kind: "reroute", new_status: "transferido", occurred_at: hace(3) }]).rescheduled_at).toBe(hace(3));
    // La más reciente con estado manda, aunque después llegue la de alta.
    expect(
      derivedGuideDates(
        [
          { kind: "reroute", new_status: "en_ruta", occurred_at: hace(5) },
          { kind: "reroute", new_status: null, occurred_at: hace(1) },
        ],
        { directGuide: true },
      ).rescheduled_at,
    ).toBe(hace(5));
  });

  it("el Master decide «guía directa» por su `created_via`", () => {
    const src = read("lib/order-master.ts");
    expect(src).toContain("derivedGuideDates(calls, { directGuide: s.created_via === FENIX_DIRECT_CREATED_VIA })");
  });

  it("sin fecha de reprogramación, la guía directa en ruta es En curso · En tránsito", () => {
    // La forma de #KP135009: Swayp directa escrita sobre la salida S01, En
    // ruta, sin salir de la empresa y sin intentos.
    const swayp: MacroGuideSnapshot = {
      id: "s1",
      courier: "fenix",
      delivery_status: "en_ruta",
      attempts: 0,
      assigned_at: hace(12),
      dispatched_at: null,
      out_for_delivery_at: null,
      rescheduled_at: derivedGuideDates([{ kind: "reroute", new_status: null, occurred_at: hace(2) }], { directGuide: true }).rescheduled_at,
      returned_at: null,
      pickup_state: null,
      preparation_state: "listo_despacho",
      custody_state: "empresa",
      reported_status: null,
    };
    const r = resolveMacroStage({
      order: lima(),
      guides: [swayp],
      events: [],
      legacy: { general: "en_proceso", operational: "en_ruta", since: hace(12) },
      paymentState: "sin_pago",
      now: NOW,
    });
    expect(r.stage).toBe("en_curso");
    expect(r.substage).toBe("en_transito");
  });
});

describe("2. Tanders que no entrega abre la recuperación (65 días)", () => {
  it("RETURNING y RETURNED son «no entregó»; lo demás no", () => {
    expect(tandersGuideFailed(tanders())).toBe(true);
    expect(tandersGuideFailed(tanders(RETURNED))).toBe(true);
    // Su API ha devuelto el mismo estado en otra caja de letras.
    expect(tandersGuideFailed(tanders({ reported_status: "returning" }))).toBe(true);
    for (const code of ["PICKED", "DELIVERED", "PENDING", "CANCELLED", null]) {
      expect(tandersGuideFailed(tanders({ reported_status: code })), String(code)).toBe(false);
    }
    // El vocabulario es de Tanders: otro courier con ese texto no cuenta.
    expect(tandersGuideFailed(tanders({ courier: "fenix" }))).toBe(false);
    expect(guideFailedAfterDispatch(tanders())).toBe(true);
  });

  it("la ventana se cuenta desde la SALIDA del intento y dura 65 días", () => {
    expect(TANDERS_RECOVERY_DAYS).toBe(65);
    const w = recoveryWindow([tanders()], [], NOW, 30);
    // No desde `updated_at`, que el barrido reescribe cada hora.
    expect(w?.closedAt).toBe(hace(10));
    expect(w?.deadline).toBe(new Date(Date.parse(hace(10)) + 65 * 86_400_000).toISOString());
    expect(w?.expired).toBe(false);
    // La de la tienda (30) no manda sobre Tanders: a los 40 días sigue viva…
    expect(recoveryActive([tanders({ dispatched_at: hace(40) })], [], NOW, 30)).not.toBeNull();
    // …y a los 66 vence.
    expect(recoveryWindow([tanders({ dispatched_at: hace(66) })], [], NOW, 30)?.expired).toBe(true);
  });

  it("el ancla no salta cuando la caja llega: RETURNING y RETURNED dan la misma", () => {
    expect(recoveryWindow([tanders(RETURNED)], [], NOW, 30)?.closedAt).toBe(hace(10));
    // Sin salida registrada, cae a la devolución, nunca a «ahora».
    expect(recoveryWindow([tanders({ ...RETURNED, dispatched_at: null })], [], NOW, 30)?.closedAt).toBe(hace(4));
  });

  it("la guía que VUELVE no cuenta como viva; otra salida viva sí apaga la recuperación", () => {
    const gf = tanders({ id: "g2", courier: "propio", reported_status: null, delivery_status: "pendiente", dispatched_at: null });
    expect(recoveryActive([tanders()], [], NOW, 30)).not.toBeNull();
    expect(recoveryActive([tanders(), gf], [], NOW, 30)).toBeNull();
    // Tanders reintenta (vuelve a PICKED): la guía está viva otra vez.
    expect(recoveryActive([tanders({ reported_status: "PICKED" })], [], NOW, 30)).toBeNull();
  });

  it("las otras pantallas leen la MISMA regla: activa, y vencida a los 65 días", () => {
    expect(recoveryOutcome([tanders()], [], NOW, 30)).toBe("activa");
    expect(recoveryOutcome([tanders({ ...RETURNED, dispatched_at: hace(66) })], [], NOW, 30)).toBe("vencida");
    expect(recoveryOutcome([tanders({ reported_status: "PICKED" })], [], NOW, 30)).toBeNull();
  });

  it("Aliclik conserva la ventana de su tienda", () => {
    const aliclik = tanders({ courier: "aliclik", delivery_status: "anulado", reported_status: "CANCEL · PICKED · ", closed_at: hace(31) });
    expect(recoveryWindow([aliclik], [], NOW, 30)?.expired).toBe(true);
  });

  it("#KP135035 (vuelve): En curso · Por reprogramar Lima, sin razón de inventario", () => {
    const { legacy, macro } = resolverTodo([tanders()]);
    expect(legacy.general).toBe("en_proceso");
    expect(legacy.operational).toBe("pendiente_nuevo_courier");
    expect(macro.stage).toBe("en_curso");
    expect(macro.substage).toBe("por_reprogramar_lima");
    expect(macro.since).toBe(hace(10));
    expect(macro.reasons).not.toContain("devolucion_pendiente_inventario");
  });

  it("#KP135161 (volvió): ya no es «Devuelto · Por cerrar»; el inventario convive como razón", () => {
    const { legacy, macro } = resolverTodo([tanders(RETURNED)]);
    expect(legacy.general).toBe("en_proceso");
    expect(macro.stage).toBe("en_curso");
    expect(macro.substage).toBe("por_reprogramar_lima");
    expect(macro.reasons).toContain("devolucion_pendiente_inventario");
  });

  it("vencidos los 65 días, cae a Devuelto con «recuperación vencida»", () => {
    const { legacy, macro } = resolverTodo([tanders({ ...RETURNED, dispatched_at: hace(70), returned_at: hace(60) })]);
    expect(legacy.general).toBe("devuelto");
    expect(macro.stage).toBe("por_cerrar");
    expect(macro.reasons).toContain("recuperacion_vencida");
  });

  it("la anulación en Shopify gana: no se reprograma", () => {
    // Con la caja de vuelta, la devolución probada va antes que la anulación
    // (como siempre); volviendo todavía, es un anulado con devolución física.
    const volvio = resolverTodo([tanders(RETURNED)], pedido({ cancelled_at: hace(2) }));
    expect(volvio.legacy.general).toBe("devuelto");
    expect(volvio.macro.stage).toBe("por_cerrar");
    const vuelve = resolverTodo([tanders()], pedido({ cancelled_at: hace(2) }));
    expect(vuelve.legacy.general).not.toBe("en_proceso");
    expect(vuelve.macro.substage).not.toBe("por_reprogramar_lima");
  });
});

describe("3. una salida devuelta no cierra el pedido si otra sigue viva", () => {
  const aliclikDevuelta = tanders({
    id: "a1",
    courier: "aliclik",
    guide_code: "AUR5X1",
    delivery_status: "transferido",
    reported_status: "CANCEL · PICKED · ",
    returned_at: hace(6),
  });
  const swaypViva = tanders({ id: "s2", courier: "fenix", guide_code: "50000140632", reported_status: null, delivery_status: "en_ruta", dispatched_at: hace(3), assigned_at: hace(3) });

  it("el reenvío en la calle manda: en proceso, no devuelto", () => {
    const s = resolveOrderState({ order: pedido(), guides: [aliclikDevuelta, swaypViva], events: [], override: null, now: NOW });
    expect(s.general).toBe("en_proceso");
    // El operativo es el de la salida viva, no «en proceso de retorno».
    expect(s.operational).toBe("en_ruta");
  });

  it("sin salida viva, la devolución probada sigue cerrando como Devuelto", () => {
    const s = resolveOrderState({ order: pedido(), guides: [aliclikDevuelta], events: [], override: null, now: NOW });
    expect(s.general).toBe("devuelto");
  });

  it("la salida nueva de Grupo GF tras un retorno de Tanders queda en la lista, no en Por cerrar", () => {
    const gf = tanders({ id: "g2", courier: "propio", guide_code: "MOM-KP135161-PROPIO-1", reported_status: null, delivery_status: "pendiente", dispatched_at: null, assigned_at: hace(0) });
    const { legacy, macro } = resolverTodo([tanders(RETURNED), gf], pedido(), [{}, { custody_state: "empresa", preparation_state: "rotulo_generado" }]);
    expect(legacy.general).toBe("en_proceso");
    expect(macro.stage).not.toBe("por_cerrar");
    expect(macro.stage).not.toBe("en_curso");
  });
});

describe("4. «Desde la lista» ofrece lo que otro courier no entregó", () => {
  it("el reintento de otro courier es solo el que espera courier nuevo", () => {
    expect(isRetryAdmission("en_curso", "por_reprogramar_lima", "pendiente_nuevo_courier")).toBe(true);
    // Una reprogramación de Aliclik con su guía viva la lleva Aliclik.
    expect(isRetryAdmission("en_curso", "por_reprogramar_lima", "reprogramado")).toBe(false);
    expect(isRetryAdmission("en_curso", "gestion_reproprovincia", "pendiente_nuevo_courier")).toBe(false);
    expect(RETRY_QUEUE_FILTER).toBe(
      "and(macro_stage.eq.en_curso,macro_substage.eq.por_reprogramar_lima,operational_status.eq.pendiente_nuevo_courier)",
    );
  });

  it("la salida que falló no bloquea; una viva de verdad sí", () => {
    const vuelve = { courier: "tanders", delivery_status: "en_ruta", reported_status: "RETURNING", output_number: 1 };
    const swayp = { courier: "fenix", delivery_status: "en_ruta", reported_status: null, output_number: 2 };
    expect(outputsBlockingRetry([vuelve])).toEqual([]);
    expect(outputsBlockingRetry([vuelve, swayp])).toEqual([swayp]);
  });

  it("dice quién no entregó y si la caja ya volvió", () => {
    expect(lastFailedOutput([{ courier: "tanders", delivery_status: "en_ruta", reported_status: "RETURNING" }])).toEqual({ courier: "tanders", returned: false });
    expect(lastFailedOutput([{ courier: "tanders", delivery_status: "anulado", reported_status: "RETURNED", returned_at: hace(1) }])).toEqual({ courier: "tanders", returned: true });
    expect(lastFailedOutput([{ courier: "propio", delivery_status: "pendiente" }])).toBeNull();
    expect(failedOutputLabel({ courier: "tanders", returned: false })).toBe("Tanders no entregó · vuelve");
    expect(failedOutputLabel({ courier: "tanders", returned: true })).toBe("Tanders no entregó · volvió");
    expect(retryTakenNote({ courier: "tanders", returned: true })).toContain("Tanders no lo entregó y sale en una salida nueva");
  });

  it("con la caja todavía volviendo, la salida nueva es adicional y su motivo se escribe solo", () => {
    const outputs = [{ courier: "tanders", delivery_status: "en_ruta", custody_state: "retorno", output_code: "KP135035-S01", reported_status: "RETURNING" }];
    // Sin motivo, la regla del §9 lo pediría…
    expect(puertaDeSalidaAdicional({ courier: "propio", operation: "lima", outputs, motivo: null }).ok).toBe(false);
    // …y el reintento lo trae escrito.
    const motivo = retryAdditionalReason({ courier: "tanders", returned: false });
    const puerta = puertaDeSalidaAdicional({ courier: "propio", operation: "lima", outputs, motivo });
    expect(puerta.ok).toBe(true);
    if (puerta.ok) {
      expect(puerta.motivo).toBe(motivo);
      expect(puerta.estorban).toHaveLength(1);
    }
    // Ya devuelta no estorba: no hace falta motivo.
    const devuelta = puertaDeSalidaAdicional({ courier: "propio", operation: "lima", outputs: [{ ...outputs[0]!, delivery_status: "anulado", custody_state: "devuelto" }], motivo: null });
    expect(devuelta).toMatchObject({ ok: true, motivo: null });
  });

  it("cuenta en «Por asignar» y en «Por reprogramar», con casilla", () => {
    const row = (over: Partial<QueueRow>): QueueRow => ({
      orderId: over.orderId ?? "x",
      orderName: "#KP135161",
      storeName: "Kenku Peru",
      customerName: "Esteban",
      customerPhone: null,
      district: "Puente Piedra",
      orderTotal: 89,
      createdAt: hace(11),
      scheduledFor: "2026-09-29",
      tariffAmount: 15,
      taken: false,
      requestId: null,
      armed: null,
      observation: null,
      hasPriorDispatch: true,
      programmedFor: null,
      macroStage: "en_curso",
      macroSubstage: "por_reprogramar_lima",
      assignable: true,
      route: null,
      failedOutput: { courier: "tanders", returned: true },
      ...over,
    });
    const rows = [row({ orderId: "kp135161" }), row({ orderId: "otro", macroStage: "preparacion", macroSubstage: "por_armar", failedOutput: null })];
    expect(isPorReprogramar(rows[0]!)).toBe(true);
    expect(filterQueue(rows, EMPTY_QUEUE_FILTERS, "2026-09-29").map((q) => q.orderId)).toContain("kp135161");
    const tiles = queueTileCounts(rows, rows, "2026-09-29");
    expect(tiles.por_asignar).toBe(2);
    expect(tiles.por_reprogramar).toBe(1);
  });
});

describe("las piezas en el código", () => {
  it("la cola de Despacho del día pide también el reintento, y con el operativo", () => {
    const src = read("app/dashboard/courier/actions.ts");
    const start = src.indexOf("async function loadCourierOperations(");
    const body = src.slice(start, src.indexOf("\nexport async function loadCourierConfig(", start));
    expect(body).toContain("macro_stage,macro_substage,operational_status");
    // Desde el 06-10-2026 «Por reprogramar Lima» entra por su etapa
    // (`REPROGRAM_QUEUE_FILTER`, que contiene al reintento); el operativo
    // sigue distinguiendo el reintento de otro courier (test/gf-own-retry.test.ts).
    expect(body).toContain("${REPROGRAM_QUEUE_FILTER}");
    expect(body).toContain("isRetryAdmission(order.macro_stage, order.macro_substage, order.operational_status)");
    expect(body).toContain("activeAssignedOutput(review ? outputs.filter((o) => !review.shipmentIds.includes(o.id)) : outputsBlockingRetry(outputs), fillable?.id ?? null)");
    expect(body).toContain("const needsExistingBox = !review && !retry && !own && order.macro_substage !== \"por_generar_rotulo\"");
    expect(body).toContain("failedOutput: retry ? lastFailedOutput(outputs) : null");
  });

  it("tomar un reintento abre salida nueva, con el motivo escrito solo y el tope de cinco", () => {
    const src = read("app/dashboard/courier/actions.ts");
    const start = src.indexOf("async function takeOrdersCore(");
    const body = src.slice(start, src.indexOf("\nexport ", start));
    expect(body).toContain("isCourierAdmissionStage(row.macro_stage, row.macro_substage, row.operational_status)");
    // La salida propia que se reusa tampoco rellena (06-10-2026, test/gf-own-retry.test.ts).
    // Si ya nació su «por definir» al pedir el rótulo (§28, 09-10-2026), se
    // rellena esa; si no, se crea (test/reprogramar-salida-nueva.test.ts).
    expect(body).toContain("const fillable = review || own ? null : pickFillableRouteOutput(outputs);");
    expect(body).toContain("const mayCreateOutput = Boolean(review) || retryCreates || row.macro_substage === \"por_generar_rotulo\";");
    expect(body).toContain("motivo: reviewReason ?? (failedBefore ? retryAdditionalReason(failedBefore) : null)");
    expect(body).toContain("outputs.length >= MAX_OUTPUTS_PER_ORDER");
    expect(body).toContain('kind: "additional_output_reason"');
    expect(body).toContain("reason: puerta.motivo");
  });

  it("la fila lleva la chapa de quién no entregó", () => {
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain("failedOutput: o.failedOutput ?? null");
    expect(board).toContain("{failedOutputLabel(q.failedOutput)}");
  });

  it("el barrido de vencidas busca a Tanders con SU ventana", () => {
    const src = read("lib/order-master.ts");
    expect(src).toContain("const tandersCutoff = new Date(Date.now() - TANDERS_RECOVERY_DAYS * 86_400_000).toISOString();");
    expect(src).toContain('query.eq("last_courier", "tanders").lt("macro_since", tandersCutoff)');
    expect(src).toContain('query.or("last_courier.is.null,last_courier.neq.tanders").lt("macro_since", cutoff)');
  });

  it("todas las lecturas de la regla traen la salida del intento (el ancla de Tanders) y el estado de Swayp", () => {
    expect(read("lib/shipments-access.ts")).toContain('"id,order_id,courier,delivery_status,reported_status,swayp_state,dispatched_at,closed_at,returned_at,updated_at"');
    expect(read("lib/voice-recovery-server.ts")).toContain('"order_id, courier, delivery_status, reported_status, swayp_state, dispatched_at, closed_at, returned_at, updated_at"');
  });

  it("la versión sube y el MOM lo dice", () => {
    // La v1.21 (adelanto mínimo de Agencia, #KP134162) y la v1.22 (Swayp que
    // no entrega) vinieron después; lo que se vigila aquí es que el MOM
    // documente la v1.19.
    expect(MOM_RESOLUTION_VERSION).toBe("mom-v1.24");
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("#### Lo que Tanders no entrega también es «Por reprogramar Lima» (v1.19, 29-09-2026)");
    expect(mom).toContain("**Crear la guía directa no es reprogramar (v1.19, 29-09-2026).**");
    expect(mom).toContain("**Una salida devuelta no cierra el pedido si otra sigue viva (v1.19,");
    expect(mom).toContain("**Lo que otro courier no entregó también se reprograma desde la lista (v1.19,");
  });
});
