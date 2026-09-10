import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECOVERY_CALL_DISPOSITIONS,
  RECOVERY_DISCARDED_KIND,
  RECOVERY_LABEL,
  aliclikGuideFailedAfterDispatch,
  recoveryActive,
  recoveryOutcome,
  recoveryWindow,
} from "@/lib/reproprovincia";
import { DISCARD_REASON_MAX, DISCARD_REASON_MIN, validarMotivoDescarte } from "@/lib/recovery-discard";
import { derivedGuideDates } from "@/lib/guide-dates";
import { resolveOrderState, type GuideSnapshot, type OrderSnapshot } from "@/lib/order-status";
import {
  MACRO_SUBSTAGES_BY_STAGE,
  MOM_RESOLUTION_VERSION,
  resolveMacroStage,
  type MacroGuideSnapshot,
  type MacroOrderSnapshot,
} from "@/lib/order-macro-stage";

/**
 * Reproprovincia: cuando Aliclik no entregó, el PEDIDO sigue vivo.
 *
 * EL CASO. Aliclik anula la guía porque no pudo entregar y el paquete vuelve.
 * Hasta la v1.10, «todas las guías anuladas» hacía que el PEDIDO pasara a
 * `anulado` —o a `devuelto` al volver el paquete— y el Master lo mandaba a «Por
 * cerrar · Devolución pendiente de inventario»: un balde de almacén. Y como la
 * gestión de llamadas era por guía, tampoco se podía llamar.
 *
 * MEDIDO (60 días): 920 pedidos así, 561 de los últimos 15 días, 570 en ciudad
 * con bodega Swayp. Salidas Swayp posteriores: 3. Llamadas registradas: 0.
 *
 * La regla del MOM §11 ya existía —«una guía cerrada NO cierra el pedido»—;
 * estas pruebas vigilan que el estado del pedido y la macroetapa la apliquen, y
 * que la apliquen IGUAL.
 */

const NOW = "2026-09-09T12:00:00.000Z";
const hace = (dias: number) => new Date(Date.parse(NOW) - dias * 86_400_000).toISOString();

/** Etiqueta cruda tal como la escribe `aliclikStatusLabel`: status · dispatch · call. */
const FALLO_TRAS_SALIR = "CANCEL · PICKED · ";
const FALLO_SIN_SALIR = "CANCEL · PREPARED · ";

function guia(over: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return {
    id: "g1",
    courier: "aliclik",
    guide_code: "AUR5X1",
    delivery_status: "anulado",
    attempts: 1,
    assigned_at: hace(12),
    dispatched_at: hace(11),
    out_for_delivery_at: null,
    rescheduled_at: null,
    closed_at: hace(5),
    returned_at: null,
    pickup_state: null,
    agency_branch: null,
    agency_arrived_at: null,
    agency_expires_at: null,
    reported_status: FALLO_TRAS_SALIR,
    created_at: hace(12),
    updated_at: hace(5),
    ...over,
  };
}

function pedido(over: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return { created_at: hace(14), cancelled_at: null, financial_status: "pending", shipping_mode: "cod", ...over };
}

describe("la regla, pura", () => {
  it("una guía Aliclik anulada con intento fallido y el paquete fuera merece otro intento", () => {
    expect(aliclikGuideFailedAfterDispatch(guia())).toBe(true);
  });

  it("si el paquete nunca salió, no: no hay a quién reenviarle nada distinto", () => {
    expect(aliclikGuideFailedAfterDispatch(guia({ reported_status: FALLO_SIN_SALIR }))).toBe(false);
  });

  it("y la etiqueta no se reimplementa: sin etiqueta no hay decisión", () => {
    // Es la misma regla del chip «Por recuperar» de Envíos. Dos listas del
    // vocabulario de Aliclik es cómo se separan en silencio.
    expect(aliclikGuideFailedAfterDispatch(guia({ reported_status: null }))).toBe(false);
    expect(readFileSync(resolve(process.cwd(), "lib/reproprovincia.ts"), "utf8")).toContain(
      "etiquetaDiceTerminoSinEntregar(guide.reported_status)",
    );
  });

  it("la ventana se cuenta desde que el courier cerró, no desde que el paquete volvió", () => {
    // Los 207 que todavía viajan de vuelta son los más calientes; anclar en
    // `returned_at` los dejaba fuera, que es lo que hacía el WhatsApp automático.
    const w = recoveryWindow([guia({ closed_at: hace(5), returned_at: null })], [], NOW, 30);
    expect(w?.closedAt).toBe(hace(5));
    expect(w?.expired).toBe(false);
  });

  it("vencida a los 30 días: se sabe que fue recuperable, no se olvida", () => {
    const w = recoveryWindow([guia({ closed_at: hace(31) })], [], NOW, 30);
    expect(w?.expired).toBe(true);
    expect(recoveryActive([guia({ closed_at: hace(31) })], [], NOW, 30)).toBeNull();
  });

  it("descartada a mano, deja de estar en gestión", () => {
    const ev = [{ kind: RECOVERY_DISCARDED_KIND, occurred_at: hace(1) }];
    expect(recoveryActive([guia()], ev, NOW)).toBeNull();
  });

  it("con una guía VIVA no aplica: la gestión la lleva esa guía", () => {
    expect(recoveryActive([guia(), guia({ id: "g2", delivery_status: "en_ruta", courier: "fenix" })], [], NOW)).toBeNull();
  });

  it("con dos intentos Aliclik, la ventana corre desde el último cierre", () => {
    const w = recoveryWindow([guia({ id: "a", closed_at: hace(40) }), guia({ id: "b", closed_at: hace(3) })], [], NOW, 30);
    expect(w?.closedAt).toBe(hace(3));
    expect(w?.expired).toBe(false);
  });

  it("sin `closed_at` (guías anteriores al sello) cae al retorno o al último movimiento, nunca a «ahora»", () => {
    const w = recoveryWindow([guia({ closed_at: null, returned_at: null, updated_at: hace(9) })], [], NOW, 30);
    expect(w?.closedAt).toBe(hace(9));
  });
});

describe("el estado del pedido la aplica", () => {
  const resolver = (guides: GuideSnapshot[], o = pedido(), events: { kind: string; occurred_at: string }[] = []) =>
    resolveOrderState({ order: o, guides, events: events.map((e) => ({ ...e, courier: null, new_status: null, new_operational: null })), override: null, now: NOW, recoveryWindowDays: 30 });

  it("con la ventana abierta el pedido sigue EN PROCESO, pendiente de nuevo courier", () => {
    // Antes: «todas las guías anuladas ⇒ anulado», que borraba la diferencia
    // entre «nos cancelaron la venta» y «el courier no pudo».
    const s = resolver([guia()]);
    expect(s.general).toBe("en_proceso");
    expect(s.operational).toBe("pendiente_nuevo_courier");
    expect(s.since).toBe(hace(5));
  });

  it("aunque el paquete YA haya vuelto: el retorno es inventario, no el fin de la venta", () => {
    const s = resolver([guia({ returned_at: hace(2) })]);
    expect(s.general).toBe("en_proceso");
    expect(s.returnedAt).toBe(hace(2));
  });

  it("vencida la ventana, cae por su cadena normal: devuelto si volvió, anulado si no", () => {
    expect(resolver([guia({ closed_at: hace(31), returned_at: hace(20) })]).general).toBe("devuelto");
    expect(resolver([guia({ closed_at: hace(31), returned_at: null })]).general).toBe("anulado");
  });

  it("la anulación en Shopify GANA: la decide una persona", () => {
    const s = resolver([guia()], pedido({ cancelled_at: hace(1) }));
    expect(s.general).toBe("anulado");
    expect(s.source).toBe("shopify");
  });

  it("descartada a mano, el pedido se cierra", () => {
    const s = resolver([guia()], pedido(), [{ kind: RECOVERY_DISCARDED_KIND, occurred_at: hace(1) }]);
    expect(s.general).toBe("anulado");
  });

  it("si el paquete nunca salió, no hay recuperación: anulado como siempre", () => {
    expect(resolver([guia({ reported_status: FALLO_SIN_SALIR, dispatched_at: null })]).general).toBe("anulado");
  });

  it("entregado sigue siendo pegajoso", () => {
    const s = resolver([guia({ id: "g0", delivery_status: "entregado", closed_at: hace(8) }), guia()]);
    expect(s.general).toBe("entregado");
  });
});

describe("y la macroetapa la aplica IGUAL", () => {
  function macroGuia(over: Partial<MacroGuideSnapshot> = {}): MacroGuideSnapshot {
    const g = guia();
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
      custody_state: "devuelto",
      reported_status: g.reported_status,
      closed_at: g.closed_at,
      updated_at: g.updated_at,
      ...over,
    };
  }
  const macroPedido = (over: Partial<MacroOrderSnapshot> = {}): MacroOrderSnapshot => ({
    created_at: hace(14),
    confirmation_activation_date: "2026-06-01",
    cancelled_at: null,
    financial_status: "pending",
    shipping_mode: "cod",
    coverage: "provincia_cod",
    region: "Arequipa",
    province: "Arequipa",
    district: "Arequipa",
    ...over,
  });

  /** De punta a punta: el legado sale del MISMO `resolveOrderState`, no se inventa. */
  function resolverTodo(guides: GuideSnapshot[], macroGuides: MacroGuideSnapshot[], o = pedido(), events: { kind: string; occurred_at: string }[] = []) {
    const legacy = resolveOrderState({
      order: o,
      guides,
      events: events.map((e) => ({ ...e, courier: null, new_status: null, new_operational: null })),
      override: null,
      now: NOW,
      recoveryWindowDays: 30,
    });
    return resolveMacroStage({
      order: macroPedido({ cancelled_at: o.cancelled_at }),
      guides: macroGuides,
      events: events.map((e) => ({ kind: e.kind, occurred_at: e.occurred_at })),
      legacy: { general: legacy.general, operational: legacy.operational, since: legacy.since },
      paymentState: "sin_pago",
      recoveryWindowDays: 30,
      now: NOW,
    });
  }

  it("con la ventana abierta: En curso · En gestión Reproprovincia", () => {
    // Antes caía en «Por cerrar · Devolución pendiente de inventario», donde
    // nadie que vende mira. La guía sigue anulada y con custodia «devuelto»:
    // la rama de En curso la habría leído como En retorno, por eso esto va antes.
    const r = resolverTodo([guia()], [macroGuia()]);
    expect(r.stage).toBe("en_curso");
    expect(r.substage).toBe("gestion_reproprovincia");
    expect(r.since).toBe(hace(5));
  });

  it("el inventario del paquete devuelto CONVIVE como razón, no tapa la gestión", () => {
    const r = resolverTodo([guia({ returned_at: hace(2) })], [macroGuia({ returned_at: hace(2) })]);
    expect(r.stage).toBe("en_curso");
    expect(r.reasons).toContain("devolucion_pendiente_inventario");
  });

  it("vencida: Por cerrar con la razón escrita, «recuperación vencida»", () => {
    // Es la única forma de medir cuánto se pierde por no llamar: distingue el
    // balde de «nunca fue recuperable» del de «lo fue y nadie lo trabajó».
    const r = resolverTodo(
      [guia({ closed_at: hace(31), returned_at: hace(20) })],
      [macroGuia({ closed_at: hace(31), returned_at: hace(20) })],
    );
    expect(r.stage).toBe("por_cerrar");
    expect(r.reasons).toContain("recuperacion_vencida");
    expect(MACRO_SUBSTAGES_BY_STAGE.por_cerrar).toContain("recuperacion_vencida");
  });

  it("un override manual a «pendiente de nuevo courier» sin guía fallida NO fabrica una recuperación", () => {
    // Se aísla la rama nueva quitándole a la guía toda señal de custodia externa:
    // así la rama previa de «En curso» —que ya mapea ese operativo a
    // Reproprovincia cuando la guía salió— no puede ser la que responda. Si el
    // resultado fuera Reproprovincia, solo podría venir de la rama nueva, y esa
    // no debe encender sin etiqueta de intento fallido.
    const r = resolveMacroStage({
      order: macroPedido(),
      guides: [macroGuia({ reported_status: null, dispatched_at: null, custody_state: "empresa", attempts: 0 })],
      events: [],
      legacy: { general: "en_proceso", operational: "pendiente_nuevo_courier", since: hace(5) },
      paymentState: "sin_pago",
      recoveryWindowDays: 30,
      now: NOW,
    });
    expect(r.stage).not.toBe("en_curso");
    expect(r.substage).not.toBe("gestion_reproprovincia");
  });

  it("la versión del MOM sube, para que el cron reconcilie el histórico", () => {
    expect(MOM_RESOLUTION_VERSION).toBe("mom-v1.10");
  });
});

describe("las piezas en el código", () => {
  const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

  it("la mesa de confirmación también se enseña en Reproprovincia: la gestión es por PEDIDO", () => {
    const src = read("components/orders-master.tsx");
    expect(src).toContain('detail.row.macro_substage === "gestion_reproprovincia") &&');
    expect(src).toContain("<DescartarRecuperacion");
  });

  it("descartar exige motivo y escribe un EVENTO, no un override", () => {
    const src = read("app/dashboard/pedidos/actions.ts");
    const start = src.indexOf("export async function descartarRecuperacion(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    // El hecho se escribe por `discardRecovery`, el mismo que usa Envíos.
    expect(body).toContain("validarMotivoDescarte(motivo)");
    expect(body).toContain("await discardRecovery(admin, {");
    expect(body).not.toContain("status_override");
    const helper = read("lib/recovery-discard.ts");
    expect(helper).toContain("kind: RECOVERY_DISCARDED_KIND");
    expect(helper).toContain('source: "manual"');
  });

  it("el barrido sella `closed_at` al anular, una sola vez", () => {
    // Sin el sello, la ventana caía al último movimiento — que cada relectura
    // de la API corre hacia adelante, estirando la ventana sin que nadie haga nada.
    const src = read("lib/aliclik-track.ts");
    expect(src).toContain('if (next === "anulado" && !shipment.closed_at) {');
    expect(src).toContain('"returned_at,returned_source,closed_at"');
  });

  it("el Master lleva la etiqueta cruda y la ventana por tienda a los DOS resolvedores", () => {
    const src = read("lib/order-master.ts");
    expect(src).toContain("created_at,updated_at,reported_status");
    expect(src).toContain("recoveryWindowByStore.set(row.id, row.return_recovery_max_days ?? RECOVERY_DEFAULT_MAX_DAYS)");
    expect((src.match(/recoveryWindowDays: recoveryWindowByStore\.get\(order\.store_id\)/g) ?? []).length).toBe(2);
  });

  it("el MOM lo dice, que es donde manda", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("#### El ciclo de recuperación (v1.10)");
    expect(mom).toContain("`recovery_discarded`");
    expect(mom).toContain("`recuperacion_vencida`");
  });
});

/**
 * Envíos lee la MISMA regla.
 *
 * EL CASO. Tras la v1.10 había dos reglas: Envíos decidía «por recuperar» con
 * «cerrada + etiqueta de intento fallido», y el Master con eso más la ventana y
 * el descarte. Medido: 976 guías en la cola de Envíos, 164 que el Master ya
 * daba por vencidas; y un descarte hecho en el Master no sacaba la fila de
 * Envíos. En la tabla todas decían «Anulado» a secas, así que una guía viva
 * para Swayp se veía igual que una muerta.
 */
describe("en qué quedó la recuperación, para enseñarlo", () => {
  const guiaR = (over: Partial<GuideSnapshot> = {}) => guia(over);

  it("activa: dentro de la ventana y sin descarte", () => {
    expect(recoveryOutcome([guiaR()], [], NOW, 30)).toBe("activa");
  });

  it("vencida: la ventana pasó", () => {
    expect(recoveryOutcome([guiaR({ closed_at: hace(31), updated_at: hace(31) })], [], NOW, 30)).toBe("vencida");
  });

  it("descartada: alguien lo decidió con motivo, aunque la ventana siga abierta", () => {
    const evento = { kind: RECOVERY_DISCARDED_KIND, occurred_at: hace(1) };
    expect(recoveryOutcome([guiaR()], [evento], NOW, 30)).toBe("descartada");
  });

  it("un descarte sobre una guía que nunca fue recuperable no la vuelve «descartada»", () => {
    const evento = { kind: RECOVERY_DISCARDED_KIND, occurred_at: hace(1) };
    expect(recoveryOutcome([guiaR({ reported_status: FALLO_SIN_SALIR })], [evento], NOW, 30)).toBeNull();
    expect(recoveryOutcome([guiaR({ reported_status: "DELIVERED · PICKED · " })], [evento], NOW, 30)).toBeNull();
  });

  it("con una guía viva la gestión la lleva ella: sin segunda mitad", () => {
    const swayp = guiaR({ id: "g2", courier: "swayp", delivery_status: "pendiente", reported_status: null });
    expect(recoveryOutcome([guiaR(), swayp], [], NOW, 30)).toBeNull();
  });

  it("los tres textos existen y el Master usa el MISMO para «vencida»", () => {
    expect(RECOVERY_LABEL.activa).toBe("Reproprovincia");
    expect(RECOVERY_LABEL.vencida).toBe("Recuperación vencida");
    expect(RECOVERY_LABEL.descartada).toBe("Descartada");
    expect(readFileSync(resolve(process.cwd(), "lib/order-macro-stage.ts"), "utf8")).toContain(
      "recuperacion_vencida: RECOVERY_LABEL.vencida,",
    );
  });
});

describe("Envíos, en el código", () => {
  const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

  it("la cola de Pendiente solo anexa las ACTIVAS, decididas por la misma función", () => {
    const src = read("lib/shipments-access.ts");
    const start = src.indexOf("async function guiasPorRecuperar(");
    const fn = src.slice(start, src.indexOf("\n}\n", start));
    expect(fn).toContain("await withRecoveryState(sb, cerradasSinEntregar)");
    expect(fn).toContain('row.recovery === "activa"');
  });

  it("la decisión se calcula con los hechos del PEDIDO, no se lee del cron", () => {
    const src = read("lib/shipments-access.ts");
    const start = src.indexOf("async function withRecoveryState(");
    const fn = src.slice(start, src.indexOf("\n}\n", start));
    expect(fn).toContain("recoveryOutcome(");
    expect(fn).toContain('.eq("kind", RECOVERY_DISCARDED_KIND)');
    expect(fn).toContain('.not("cancelled_at", "is", null)');
    expect(fn).toContain('select("id,return_recovery_max_days")');
    expect(fn).not.toContain("order_master");
  });

  it("el contador del chip pasa por la MISMA decisión que la lista", () => {
    const src = read("lib/shipments-access.ts");
    expect(src).toContain("guiasPorRecuperar(sb, storeIds, RECUPERAR_COUNT_COLUMNS)");
    expect(src).toMatch(/RECUPERAR_COUNT_COLUMNS =\s*\n?\s*"[^"]*order_id[^"]*reported_status[^"]*closed_at[^"]*"/);
  });

  it("el badge escribe la segunda mitad desde el mismo texto", () => {
    const src = read("components/shipments.tsx");
    expect(src).toContain("if (s.recovery) return ` · ${RECOVERY_LABEL[s.recovery]}`;");
  });

  it("y el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("**Envíos aplica la MISMA regla que el Master**");
    expect(mom).toContain("**El badge de Estado tiene dos mitades.**");
  });
});

/**
 * Llamadas desde Envíos sobre la guía anulada.
 *
 * La otra mitad del mareo: la guía anulada no admitía gestión —bien, está
 * cerrada de verdad— y por eso nadie podía anotar «llamé, no quiere». Ahora la
 * llamada es sobre el PEDIDO y no mueve la guía; «Cliente no quiere» escribe el
 * MISMO evento de descarte que el Master.
 */
describe("gestión sobre la guía anulada, desde Envíos", () => {
  const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
  const accion = () => {
    const src = read("app/dashboard/envios/actions.ts");
    const start = src.indexOf("export async function registerRecoveryCall(");
    return src.slice(start, src.indexOf("\n}\n", start));
  };

  it("tres disposiciones, y ninguna es «confirma» ni «cancela»: ésas mueven la guía", () => {
    expect(RECOVERY_CALL_DISPOSITIONS.map((d) => d.key)).toEqual(["programar", "no_contesta", "no_quiere"]);
  });

  it("el motivo del descarte: obligatorio, con sustancia, y un solo mínimo", () => {
    expect(validarMotivoDescarte("")).toEqual({ error: `Escribe el motivo (mínimo ${DISCARD_REASON_MIN} caracteres).` });
    expect(validarMotivoDescarte("  no  ")).toHaveProperty("error");
    expect(validarMotivoDescarte("  ya no quiere el producto  ")).toEqual({ reason: "ya no quiere el producto" });
    expect(validarMotivoDescarte("x".repeat(DISCARD_REASON_MAX + 1))).toHaveProperty("error");
    expect(DISCARD_REASON_MIN).toBe(8);
  });

  it("la puerta del servidor es la MISMA función que puso la segunda mitad del badge", () => {
    const body = accion();
    expect(body).toContain("await withRecoveryState(admin, [shipment as unknown as ShipmentRow])");
    expect(body).toContain('recovery !== "activa"');
    // Y no la de las guías vivas, que rechaza «anulado» — con razón.
    expect(body).not.toContain("isCallable(");
    expect(body).not.toContain("nextShipmentTransition(");
  });

  it("«no quiere» escribe el mismo descarte que el Master y no toca el estado de la guía", () => {
    const body = accion();
    expect(body).toContain("await discardRecovery(admin, {");
    expect(body).toContain("validarMotivoDescarte(note)");
    expect(body).not.toMatch(/delivery_status:\s*"/);
    expect(body).not.toContain("status_category:");
  });

  it("programar exige fecha futura; no contesta no cambia nada de la guía", () => {
    const body = accion();
    expect(body).toContain('input.disposition === "programar" && !isFutureShipmentFollowup(input.nextFollowupAt)');
    expect(body).toContain("new_status: null,");
  });

  it("el drawer solo lo ofrece cuando la segunda mitad dice «activa», y reenviar deja de ser «excepción»", () => {
    const src = read("components/shipments.tsx");
    expect(src).toContain('const enRecuperacion = shipment?.delivery_status === "anulado" && shipment.recovery === "activa";');
    expect(src).toContain("{enRecuperacion && (");
    expect(src).toContain("registerRecoveryCall(shipmentId, {");
    expect(src).toContain('{enRecuperacion ? "Reproprovincia" : "Excepción auditada"}');
  });

  it("y el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("**Desde Envíos, sobre la guía anulada**");
  });
});

/**
 * Cuadrar Envíos con el Master (10-09-2026), la mañana siguiente.
 *
 * Con el recompute terminado se cruzaron los dos conjuntos. Dos diferencias no
 * eran explicables y las dos eran la misma enfermedad: la misma pregunta con
 * dos fórmulas. (1) Tres pedidos con la Aliclik anulada y una Fenix ENTREGADA:
 * el Master los daba por entregados, Envíos los listaba «Anulado ·
 * Reproprovincia». (2) Diecisiete guías sin `closed_at`: el Master ancla la
 * ventana en la última transición terminal del historial, Envíos caía a
 * `returned_at`, que llega días después — vencidas para uno, activas para el otro.
 */
describe("cuadrar Envíos con el Master", () => {
  const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

  it("con una guía ENTREGADA en el pedido no hay recuperación: ése fue el reenvío que funcionó", () => {
    const fenixEntregada = guia({ id: "g2", courier: "fenix", delivery_status: "entregado", reported_status: null });
    expect(recoveryWindow([guia(), fenixEntregada], [], NOW, 30)).toBeNull();
    expect(recoveryOutcome([guia(), fenixEntregada], [], NOW, 30)).toBeNull();
  });

  it("el ancla derivada es la ÚLTIMA transición terminal del historial, como en el Master", () => {
    const d = derivedGuideDates([
      { kind: "call", new_status: "en_ruta", occurred_at: hace(20) },
      { kind: "report", new_status: "anulado", occurred_at: hace(12) },
      { kind: "report", new_status: "anulado", occurred_at: hace(10) },
      { kind: "call", new_status: null, occurred_at: hace(2) },
    ]);
    expect(d.closed_at).toBe(hace(10));
    expect(d.dispatched_at).toBe(hace(20));
    expect(derivedGuideDates([]).closed_at).toBeNull();
  });

  it("el Master y Envíos derivan con la MISMA función, del mismo archivo", () => {
    expect(read("lib/order-master.ts")).toContain('import { derivedGuideDates } from "@/lib/guide-dates";');
    expect(read("lib/order-master.ts")).not.toContain("function derivedGuideDates(");
    const src = read("lib/shipments-access.ts");
    const start = src.indexOf("export async function withRecoveryState(");
    const fn = src.slice(start, src.indexOf("\n}\n", start));
    expect(fn).toContain("g.closed_at = derivedGuideDates(callsByGuide.get(g.id) ?? []).closed_at;");
    expect(fn).toContain('.select("shipment_id,kind,new_status,occurred_at")');
  });

  it("la ventana vence SOLA, así que el barrido tiene una puerta que la mira", () => {
    // #AUR174406: ventana vencida a las 23:14, y a la mañana siguiente seguía
    // «En gestión» porque nada había escrito nada. Las otras puertas se
    // disparan por escrituras; ésta por el tiempo.
    const src = read("lib/order-master.ts");
    const start = src.indexOf("export async function reconcileOrderMaster(");
    const fn = src.slice(start, src.indexOf("\nexport ", start + 10));
    expect(fn).toContain('.eq("operational_status", "pendiente_nuevo_courier")');
    expect(fn).toContain('.in("macro_substage", ["gestion_reproprovincia", "por_reprogramar_lima"])');
    expect(fn).toContain('.lt("macro_since", cutoff)');
    expect(fn).toContain("store.return_recovery_max_days ?? RECOVERY_DEFAULT_MAX_DAYS");
  });

  it("y el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("**el mismo en el\n  Master y en Envíos**");
    expect(mom).toContain("**No aplica si alguna guía del pedido ya ENTREGÓ**");
  });
});
