// El estado de las guías Swayp leído de su API (29-09-2026).
//
// El webhook de Swayp solo mandaba entregas: las 147 guías vivas seguían en el
// estado 1 y el Master enseñaba «En tránsito» a 112 devoluciones (#KP135009).
// Aquí se prueba, de abajo arriba: cómo se lee el `estado` de
// `GET /v2/guias/{guia}`, qué escribe cada estado en la guía, el barrido, y qué
// hace el Master con una Devolución de Swayp.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  mapSwaypState,
  readSwaypGuide,
  swaypCustodyFor,
  swaypResponseShape,
  swaypStateFromLabel,
  SWAYP_RETURN_STATES,
  SWAYP_STATES,
  type SwaypClientOpts,
} from "@/lib/swayp";
import { normalizeSwaypIncoming, swaypStatePatch, type SwaypShipmentRow } from "@/lib/swayp-ingest";
import { describeSwaypFailure, sweepSwaypStatus } from "@/lib/swayp-status-sweep";
import { SwaypError } from "@/lib/swayp";
import {
  guideFailedAfterDispatch,
  guideFailedAt,
  recoveryActive,
  recoveryWindowDaysFor,
  swaypGuideFailed,
  TANDERS_RECOVERY_DAYS,
} from "@/lib/reproprovincia";
import { resolveOrderState, type GuideSnapshot, type OrderSnapshot } from "@/lib/order-status";
import { expiredRecoveryKind, guideDoorRejection, recoveryWindow } from "@/lib/reproprovincia";
import { voiceRecoveryEligible, type VoiceCandidateInput } from "@/lib/voice-recovery-queue";
import { swaypLabelSaysRejection, swaypLabelSaysUndispatched, swaypNoveltyLabel, SWAYP_REJECTION_NOVELTIES, SWAYP_UNDISPATCHED_NOVELTY } from "@/lib/swayp";
import { resolveMacroStage, type MacroGuideSnapshot, type MacroOrderSnapshot } from "@/lib/order-macro-stage";
import { failedOutputLabel, lastFailedOutput, outputsBlockingRetry } from "@/lib/gf-retry";

const NOW = "2026-09-29T15:00:00.000Z";
const hace = (dias: number) => new Date(Date.parse(NOW) - dias * 86_400_000).toISOString();
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/**
 * La guía 50000139816 (#KP135009) tal como la enseña Swayp, con los nombres
 * cambiados: el mismo `estado` de texto y el mismo historial de `notas`.
 */
const GUIA_DEVUELTA = {
  guia: 50000139816,
  estado: "Devolucion",
  ciudad: "PUENTE PIEDRA",
  fechaReparto: "2026-09-28T08:56:47.089Z",
  fechaNovedad: "2026-09-28T18:15:55.642Z",
  fechaEntregada: "",
  fechaDevolucion: "",
  notas: [
    { nota: "Generada desde API", fecha: "2026-09-28T02:01:27.135Z", estado: "Generada" },
    { nota: "Procesado en el origen", fecha: "2026-09-28T07:32:15.121Z", estado: "Por Recolectar", codigoEstado: "3" },
    { nota: "Asignada en SWAYP Moto", fecha: "2026-09-28T08:46:26.834Z", estado: "Asignada", codigoEstado: "4" },
    { nota: "Paquete en Reparto", fecha: "2026-09-28T08:56:47.089Z", estado: "Reparto", codigoEstado: "5" },
    { nota: "Novedad creada", fecha: "2026-09-28T18:15:55.642Z", estado: "Novedad", codigoEstado: "6", idNovedad: "16", nombreNovedad: "Destinatario indica que ya no desea el producto" },
    { nota: "Marcado para devolución, pendiente por entregar al origen", fecha: "2026-09-28T22:03:38.357Z", estado: "Devolucion", codigoEstado: "8" },
  ],
};

describe("el catálogo, corregido con las 147 guías reales", () => {
  it("8 es Devolución, 9 Devolución confirmada y 12 con cobro (no Revisión ni Cancelación)", () => {
    expect(SWAYP_STATES[8]).toBe("Devolución");
    expect(SWAYP_STATES[9]).toBe("Devolución confirmada");
    expect(SWAYP_STATES[12]).toBe("Devolución confirmada con cobro");
  });

  it("los textos que escribe Swayp se traducen sin tildes ni mayúsculas", () => {
    expect(swaypStateFromLabel("Devolucion")).toBe(8);
    expect(swaypStateFromLabel("DEVOLUCIÓN")).toBe(8);
    expect(swaypStateFromLabel("Devolucion Confirmada")).toBe(9);
    expect(swaypStateFromLabel("Devolucion Confirmada Con Cobro")).toBe(12);
    expect(swaypStateFromLabel("  por   recolectar ")).toBe(3);
    // La novedad resuelta vuelve a Reparto con otro nombre.
    expect(swaypStateFromLabel("Solucionado")).toBe(5);
    expect(swaypStateFromLabel("Entregada")).toBe(7);
    expect(swaypStateFromLabel("Cancelada")).toBe(10);
  });

  it("un texto que no conocemos no se adivina", () => {
    expect(swaypStateFromLabel("En camino a Marte")).toBeNull();
    expect(swaypStateFromLabel("")).toBeNull();
    expect(swaypStateFromLabel(null)).toBeNull();
  });

  it("no entregó = Devolución, Devolución confirmada y con cobro; Cancelada no", () => {
    expect([...SWAYP_RETURN_STATES].sort((a, b) => a - b)).toEqual([8, 9, 12]);
  });

  it("la custodia: con el mensajero en ruta, de retorno al volver, nunca «devuelto» por la API", () => {
    expect(swaypCustodyFor(4)).toBe("courier");
    expect(swaypCustodyFor(5)).toBe("courier");
    expect(swaypCustodyFor(6)).toBe("courier");
    expect(swaypCustodyFor(8)).toBe("retorno");
    // Confirmada es que llegó a la bodega de Swayp: la caja se recoge después (§9.4).
    expect(swaypCustodyFor(9)).toBe("retorno");
    expect(swaypCustodyFor(12)).toBe("retorno");
    for (const s of [1, 2, 3, 7, 10, 11]) expect(swaypCustodyFor(s), String(s)).toBeNull();
  });
});

describe("leer `estado` de GET /v2/guias/{guia}", () => {
  it("#KP135009: el texto «Devolucion» es el estado 8, con sus fechas del historial", () => {
    expect(readSwaypGuide(GUIA_DEVUELTA)).toEqual({
      state: 8,
      label: "Devolucion",
      // La primera salida con el mensajero (Asignada), no el Reparto.
      departedAt: "2026-09-28T08:46:26.834Z",
      changedAt: "2026-09-28T22:03:38.357Z",
      novelty: { id: 16, name: "Destinatario indica que ya no desea el producto" },
    });
  });

  it("también dentro de `data`, o como primer elemento de una lista", () => {
    expect(readSwaypGuide({ success: true, data: { estado: "Novedad" } }).state).toBe(6);
    expect(readSwaypGuide([{ estado: "Entregada" }]).state).toBe(7);
  });

  it("si `estado` viene como número, u objeto con código y nombre, también", () => {
    expect(readSwaypGuide({ estado: 9 }).state).toBe(9);
    expect(readSwaypGuide({ estado: "12" }).state).toBe(12);
    expect(readSwaypGuide({ estado: { codigo: 6, nombre: "Novedad" } })).toMatchObject({ state: 6, label: "Novedad" });
    expect(readSwaypGuide({ estado: { id: "8" } }).state).toBe(8);
  });

  it("sin `estado` se prueba `idEstado`", () => {
    expect(readSwaypGuide({ guia: 1, idEstado: 5 }).state).toBe(5);
    expect(readSwaypGuide({ guia: 1, codigoEstado: "10" }).state).toBe(10);
  });

  it("un texto desconocido deja el estado en null y conserva el texto para el reporte", () => {
    expect(readSwaypGuide({ estado: "Extraviada" })).toMatchObject({ state: null, label: "Extraviada" });
    // Un número fuera del catálogo tampoco.
    expect(readSwaypGuide({ estado: 99 }).state).toBeNull();
  });

  it("sin historial, las fechas salen de los campos `fecha…`", () => {
    const r = readSwaypGuide({ estado: "Devolucion Confirmada", fechaReparto: "2026-09-20T10:00:00Z", fechaDevolucion: "2026-09-25T09:00:00Z" });
    expect(r).toMatchObject({ state: 9, departedAt: "2026-09-20T10:00:00.000Z", changedAt: "2026-09-25T09:00:00.000Z" });
  });

  it("una respuesta vacía o rara no inventa nada", () => {
    for (const body of [null, undefined, "hola", 42, {}, []]) {
      expect(readSwaypGuide(body), JSON.stringify(body)).toEqual({ state: null, label: null, departedAt: null, changedAt: null, novelty: null });
    }
  });
});

/** Una guía Swayp directa como está hoy en la base: nace `en_ruta` con el estado 1. */
function fila(over: Partial<SwaypShipmentRow> = {}): SwaypShipmentRow {
  return {
    id: "s1",
    order_id: "o1",
    delivery_status: "en_ruta",
    swayp_state: 1,
    custody_state: null,
    custody_transferred_at: null,
    dispatched_at: null,
    out_for_delivery_at: null,
    closed_at: null,
    ...over,
  };
}

describe("qué escribe cada estado en la guía (webhook y barrido, la misma función)", () => {
  const now = "2026-09-29T15:00:00.000Z";

  it("Devolución: el estado crudo, la custodia de retorno y la salida como ancla; sigue en ruta", () => {
    const r = swaypStatePatch(fila(), { state: 8, departedAt: "2026-09-28T08:46:26.834Z", changedAt: "2026-09-28T22:03:38.357Z" }, now);
    expect(r.changed).toBe(true);
    expect(r.deliveryStatus).toBe("en_ruta");
    expect(r.patch).toEqual({
      swayp_state: 8,
      custody_state: "retorno",
      custody_transferred_at: "2026-09-28T08:46:26.834Z",
      dispatched_at: "2026-09-28T08:46:26.834Z",
    });
  });

  it("Devolución confirmada: cierra la guía sin entregar, con su fecha", () => {
    const r = swaypStatePatch(fila(), { state: 9, changedAt: "2026-09-27T12:00:00.000Z" }, now);
    expect(r.deliveryStatus).toBe("anulado");
    expect(r.patch).toMatchObject({
      swayp_state: 9,
      delivery_status: "anulado",
      status_category: "closed",
      closed_at: "2026-09-27T12:00:00.000Z",
      custody_state: "retorno",
      // Sin fecha de salida, la del estado: el paquete salió seguro.
      dispatched_at: "2026-09-27T12:00:00.000Z",
    });
  });

  it("una novedad resuelta (Solucionado → 5) vuelve a estar con el mensajero, en reparto", () => {
    const r = swaypStatePatch(
      fila({ swayp_state: 8, custody_state: "retorno", custody_transferred_at: hace(2), dispatched_at: hace(2) }),
      { state: 5, changedAt: hace(0) },
      now,
    );
    expect(r.patch).toEqual({ swayp_state: 5, custody_state: "courier", out_for_delivery_at: hace(0) });
  });

  it("una guía que no había salido pasa a en_ruta con la novedad", () => {
    const r = swaypStatePatch(fila({ delivery_status: "pendiente" }), { state: 6 }, now);
    expect(r.patch).toMatchObject({ swayp_state: 6, delivery_status: "en_ruta", custody_state: "courier", dispatched_at: now, out_for_delivery_at: now });
  });

  it("«Por recolectar» no devuelve a pendiente una guía directa que nació en ruta", () => {
    const r = swaypStatePatch(fila(), { state: 3 }, now);
    expect(r.patch).toEqual({ swayp_state: 3 });
  });

  it("repetir el mismo estado no cambia nada", () => {
    expect(swaypStatePatch(fila({ swayp_state: 8, custody_state: "retorno" }), { state: 8 }, now)).toEqual({
      patch: {},
      changed: false,
      deliveryStatus: "en_ruta",
    });
  });

  it("una guía cerrada no se reabre ni cambia de estado crudo por uno vivo", () => {
    expect(swaypStatePatch(fila({ delivery_status: "anulado", swayp_state: 9 }), { state: 8 }, now).changed).toBe(false);
    expect(swaypStatePatch(fila({ delivery_status: "entregado", swayp_state: 7 }), { state: 5 }, now).changed).toBe(false);
    // Pero una cerrada que se confirma con cobro sí registra el 12.
    expect(swaypStatePatch(fila({ delivery_status: "anulado", swayp_state: 9 }), { state: 12 }, now).patch).toMatchObject({ swayp_state: 12 });
  });

  it("la caja ya recibida en oficina (`devuelto`) no vuelve a «retorno»", () => {
    const r = swaypStatePatch(fila({ custody_state: "devuelto" }), { state: 9 }, now);
    expect(r.patch).not.toHaveProperty("custody_state");
  });

  it("las fechas se llenan una vez: no se pisan", () => {
    const r = swaypStatePatch(fila({ dispatched_at: hace(5), custody_transferred_at: hace(5), closed_at: null }), { state: 8, departedAt: hace(1) }, now);
    expect(r.patch).not.toHaveProperty("dispatched_at");
    expect(r.patch).not.toHaveProperty("custody_transferred_at");
  });

  it("entregada: cierra con su fecha", () => {
    const r = swaypStatePatch(fila({ swayp_state: 5 }), { state: 7, changedAt: hace(0) }, now);
    expect(r.patch).toMatchObject({ swayp_state: 7, delivery_status: "entregado", closed_at: hace(0) });
  });

  it("mapea 6 y 8 a en_ruta: el paquete está con el mensajero", () => {
    expect(mapSwaypState(6)).toBe("en_ruta");
    expect(mapSwaypState(8)).toBe("en_ruta");
  });
});

describe("la API cierra una devolución como 10 «Cancelada» (29-09-2026)", () => {
  // Las 15 guías que el tracking enseña en 9 «Devolución confirmada» llegaron por
  // GET /v2/guias como 10, y siete pedidos sin anular cayeron en «Finalizado ·
  // Anulado cerrado». Su doc dice que 10 solo sale de 1 (Generada).
  const now = "2026-09-29T21:00:00.000Z";

  it("un 10 sobre una guía que ya salió es el final de su devolución: 9", () => {
    // Cada prueba de salida, sola, basta.
    const base = { swayp_state: 1, custody_state: "empresa", dispatched_at: null, out_for_delivery_at: null } as const;
    for (const s of [4, 5, 6, 8, 9, 12]) {
      expect(normalizeSwaypIncoming(fila({ ...base, swayp_state: s }), { state: 10 }).state, `estado ${s}`).toBe(9);
    }
    expect(normalizeSwaypIncoming(fila({ ...base, dispatched_at: hace(3) }), { state: 10 }).state).toBe(9);
    expect(normalizeSwaypIncoming(fila({ ...base, out_for_delivery_at: hace(3) }), { state: 10 }).state).toBe(9);
    expect(normalizeSwaypIncoming(fila({ ...base, custody_state: "courier" }), { state: 10 }).state).toBe(9);
    expect(normalizeSwaypIncoming(fila({ ...base, custody_state: "retorno" }), { state: 10 }).state).toBe(9);
  });

  it("un 10 sobre una guía que nunca salió es una cancelación de verdad", () => {
    // La guía directa nace en_ruta, con custodia de la empresa y sin salida.
    expect(normalizeSwaypIncoming(fila({ swayp_state: 1, custody_state: "empresa" }), { state: 10 }).state).toBe(10);
    // Los demás estados no se tocan.
    expect(normalizeSwaypIncoming(fila({ swayp_state: 8 }), { state: 5 }).state).toBe(5);
  });

  it("la devolución que termina en 10 queda como Devolución confirmada, con su custodia de retorno", () => {
    const r = swaypStatePatch(fila({ swayp_state: 8, custody_state: "retorno", custody_transferred_at: hace(2), dispatched_at: hace(2) }), { state: 10 }, now);
    expect(r.deliveryStatus).toBe("anulado");
    expect(r.patch).toMatchObject({ swayp_state: 9, delivery_status: "anulado", closed_at: now });
    expect(r.patch).not.toHaveProperty("custody_state");
  });

  it("y el pedido sigue en recuperación, no en Finalizado", () => {
    const antes = fila({ swayp_state: 8, custody_state: "retorno", custody_transferred_at: hace(2), dispatched_at: hace(2) });
    const { patch } = swaypStatePatch(antes, { state: 10 }, now);
    const g = { ...antes, ...patch } as SwaypShipmentRow;
    const { legacy, macro } = resolverTodo([swayp({ swayp_state: g.swayp_state, delivery_status: g.delivery_status, dispatched_at: g.dispatched_at ?? null, closed_at: g.closed_at ?? null })]);
    expect(legacy.operational).toBe("pendiente_nuevo_courier");
    expect(macro.stage).toBe("en_curso");
    expect(macro.substage).toBe("por_reprogramar_lima");
  });

  it("una guía ya confirmada que vuelve a leerse como 10 no cambia", () => {
    const r = swaypStatePatch(fila({ delivery_status: "anulado", swayp_state: 9, custody_state: "retorno", dispatched_at: hace(3), closed_at: hace(1) }), { state: 10 }, now);
    expect(r.changed).toBe(false);
  });
});

describe("el historial de la API, bajo el nombre que traiga", () => {
  it("se lee también como `historial`, con `idEstado`", () => {
    const r = readSwaypGuide({
      estado: "Devolucion",
      historial: [
        { estado: "Asignada", idEstado: 4, fecha: "2026-09-28T08:46:26.834Z" },
        { estado: "Devolucion", idEstado: 8, fecha: "2026-09-28T22:03:38.357Z" },
      ],
    });
    expect(r).toMatchObject({ state: 8, departedAt: "2026-09-28T08:46:26.834Z", changedAt: "2026-09-28T22:03:38.357Z" });
  });

  it("una lista que no parece historial no se usa", () => {
    expect(readSwaypGuide({ estado: "Reparto", productos: [{ sku: "A", cantidad: 1 }] }).departedAt).toBeNull();
  });

  it("la forma de la respuesta se registra sin sus datos", () => {
    expect(swaypResponseShape({ guia: 1, estado: "Cancelada", idEstado: 10, destinatario: { nombre: "X" } })).toEqual({
      keys: ["destinatario", "estado", "guia", "idEstado"],
      estado: "Cancelada|10",
      historial: null,
      historialClaves: [],
    });
    expect(swaypResponseShape({ data: { estado: 8, historial: [{ estado: "Reparto", fecha: "2026-09-28T08:56:47.089Z" }] } })).toMatchObject({
      estado: "8|-",
      historial: "historial",
      historialClaves: ["estado", "fecha"],
    });
    expect(swaypResponseShape(null).estado).toBe("(vacía)");
  });
});

// ── El barrido ──────────────────────────────────────────────────────────────

interface FakeRow extends SwaypShipmentRow {
  swayp_guide: string;
  order_name: string | null;
}

function fakeAdmin(rows: FakeRow[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const query: Record<string, unknown> = {};
  const admin = {
    from(table: string) {
      expect(table).toBe("shipments");
      const chain = {
        select(cols: string) {
          query.select = cols;
          return chain;
        },
        not(col: string, op: string, val: unknown) {
          query.not = [col, op, val];
          return chain;
        },
        in(col: string, vals: unknown[]) {
          query.in = [col, vals];
          return chain;
        },
        order(col: string, opts: unknown) {
          query.order = [col, opts];
          return chain;
        },
        limit(n: number) {
          query.limit = n;
          return Promise.resolve({ data: rows, error: null });
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: async (_col: string, id: string) => {
              updates.push({ id, patch });
              return { error: null };
            },
          };
        },
      };
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { admin, updates, query };
}

function cliente(responses: Record<string, { status: number; body: unknown }>): SwaypClientOpts {
  return {
    token: "t",
    email: "ops@example.pe",
    baseUrl: "https://swayp.test",
    fetchImpl: (async (url: string) => {
      const guia = String(url).split("/").pop()!;
      const r = responses[guia] ?? { status: 200, body: {} };
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch,
  };
}

const guia = (n: string, over: Partial<FakeRow> = {}): FakeRow => ({
  ...fila({ id: `s${n}`, order_id: `o${n}` }),
  swayp_guide: n,
  order_name: `#KP${n}`,
  ...over,
});

describe("el barrido de estados", () => {
  it("lee las vivas, las nunca leídas primero, y aplica lo que entiende", async () => {
    const rows = [
      guia("101"), // devolución
      guia("102"), // no existe
      guia("103"), // texto desconocido
      guia("104"), // 500
      guia("105", { swayp_state: 5, custody_state: "courier", out_for_delivery_at: hace(1) }), // sigue en reparto
    ];
    const { admin, updates, query } = fakeAdmin(rows);
    const recompute = vi.fn(async () => undefined);
    const report = await sweepSwaypStatus(admin, {
      client: cliente({
        "101": { status: 200, body: GUIA_DEVUELTA },
        "102": { status: 200, body: {} },
        "103": { status: 200, body: { estado: "Extraviada" } },
        "104": { status: 500, body: "TypeError: Cannot read properties of undefined (reading 'novedadFoto') en 50000139811" },
        "105": { status: 200, body: { estado: "Reparto" } },
      }),
      now: () => new Date(NOW),
      recompute,
    });

    expect(query).toMatchObject({
      not: ["swayp_guide", "is", null],
      in: ["delivery_status", ["pendiente", "en_ruta"]],
      order: ["swayp_synced_at", { ascending: true, nullsFirst: true }],
      limit: 200,
    });
    expect(report).toMatchObject({
      scanned: 5,
      aplicados: 1,
      sinCambio: 1,
      noEncontradas: 1,
      errores: 1,
      desconocidos: { Extraviada: 1 },
      detenido: null,
    });
    expect(report.cambios).toEqual([{ guia: "101", pedido: "#KP101", de: "en_ruta · 1 Generada", a: "en_ruta · 8 Devolución" }]);
    // El motivo del 500 sin el número de guía: doscientas iguales son UN motivo.
    expect(report.fallos).toEqual([
      { mensaje: "Swayp GET /v2/guias/{guia} → 500: TypeError: Cannot read properties of undefined (reading 'novedadFoto') en {n}", n: 1 },
    ]);
    // Se escribe lo leído (con sello) y nada de lo que no se entendió.
    expect(updates.map((u) => u.id).sort()).toEqual(["s101", "s105"]);
    expect(updates.find((u) => u.id === "s101")!.patch).toMatchObject({ swayp_state: 8, custody_state: "retorno", swayp_synced_at: NOW });
    expect(updates.find((u) => u.id === "s105")!.patch).toEqual({ swayp_synced_at: NOW });
    // El Master, una vez y solo con lo que cambió.
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(recompute).toHaveBeenCalledWith(admin, ["o101"]);
    // La forma, sin datos: estados crudos y claves.
    // La que no existe ({}) no tiene forma: cuenta como no encontrada.
    expect(report.crudos).toEqual({ "Devolucion|-": 1, "Extraviada|-": 1, "Reparto|-": 1 });
    expect(report.forma).toContain("estado");
    expect(report.historial).toBe("notas");
  });

  it("una devolución que la API cierra como 10 se guarda como Devolución confirmada", async () => {
    const { admin, updates } = fakeAdmin([guia("501", { swayp_state: 8, custody_state: "retorno", dispatched_at: hace(2), custody_transferred_at: hace(2) })]);
    const report = await sweepSwaypStatus(admin, {
      client: cliente({ "501": { status: 200, body: { estado: "Cancelada", idEstado: 10 } } }),
      now: () => new Date(NOW),
      recompute: async () => undefined,
    });
    expect(report.cambios).toEqual([{ guia: "501", pedido: "#KP501", de: "en_ruta · 8 Devolución", a: "anulado · 9 Devolución confirmada" }]);
    expect(updates[0]!.patch).toMatchObject({ swayp_state: 9, delivery_status: "anulado" });
    expect(report.crudos).toEqual({ "Cancelada|10": 1 });
  });

  it("el primer 429 lo detiene: lo que queda va en la pasada siguiente", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => guia(String(200 + i)));
    const { admin } = fakeAdmin(rows);
    const responses = Object.fromEntries(rows.map((r) => [r.swayp_guide, { status: 429, body: "Too Many Requests" }]));
    const report = await sweepSwaypStatus(admin, { client: cliente(responses), recompute: async () => undefined });
    expect(report.detenido).toBe("limite");
    // A lo sumo una lectura por trabajador: no sigue quemando llamadas.
    expect(report.scanned).toBeLessThanOrEqual(4);
  });

  it("una credencial muerta también lo detiene", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => guia(String(300 + i)));
    const { admin } = fakeAdmin(rows);
    const responses = Object.fromEntries(rows.map((r) => [r.swayp_guide, { status: 401, body: "Unauthorized" }]));
    const report = await sweepSwaypStatus(admin, { client: cliente(responses), recompute: async () => undefined });
    expect(report.detenido).toBe("credencial");
    expect(report.scanned).toBeLessThanOrEqual(4);
  });

  it("en seco dice qué cambiaría sin escribir ni recalcular", async () => {
    const { admin, updates } = fakeAdmin([guia("401")]);
    const recompute = vi.fn(async () => undefined);
    const report = await sweepSwaypStatus(admin, {
      dry: true,
      client: cliente({ "401": { status: 200, body: { estado: "Devolucion Confirmada" } } }),
      recompute,
    });
    expect(report.aplicados).toBe(1);
    expect(report.cambios[0]).toMatchObject({ a: "anulado · 9 Devolución confirmada" });
    expect(updates).toEqual([]);
    expect(recompute).not.toHaveBeenCalled();
  });

  it("describe los fallos sin datos de la guía", () => {
    expect(describeSwaypFailure(new SwaypError(503, "Service Unavailable"))).toBe("Swayp GET /v2/guias/{guia} → 503: Service Unavailable");
    expect(describeSwaypFailure(new Error("timeout en 50000139816"))).toBe("Error: timeout en {n}");
  });

  it("corre cada media hora con su ruta y se autentica como los demás crons", () => {
    const cfg = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    expect(cfg.crons).toContainEqual({ path: "/api/cron/swayp-status", schedule: "22,52 * * * *" });
    const route = read("app/api/cron/swayp-status/route.ts");
    expect(route).toContain("sweepSwaypStatus(createAdminSupabase())");
    expect(route).toContain("env.cronSecret()");
  });

  it("el webhook y el barrido escriben por la MISMA función", () => {
    const ingest = read("lib/swayp-ingest.ts");
    const sweep = read("lib/swayp-status-sweep.ts");
    expect(ingest).toMatch(/processSwaypWebhook[\s\S]*applySwaypState\(/);
    expect(sweep).toContain("applySwaypState(admin, row, incoming");
  });
});

// ── El Master ───────────────────────────────────────────────────────────────

/** Guía Swayp como la deja el barrido tras leer una Devolución. */
function swayp(over: Partial<GuideSnapshot> = {}): GuideSnapshot {
  return {
    id: "s1",
    courier: "fenix",
    guide_code: "50000139816",
    delivery_status: "en_ruta",
    attempts: 0,
    assigned_at: hace(12),
    dispatched_at: hace(1),
    out_for_delivery_at: hace(1),
    rescheduled_at: null,
    closed_at: null,
    returned_at: null,
    pickup_state: null,
    agency_branch: null,
    agency_arrived_at: null,
    agency_expires_at: null,
    reported_status: null,
    swayp_state: 8,
    created_at: hace(12),
    // El barrido sella cada media hora: no sirve de ancla.
    updated_at: hace(0),
    ...over,
  };
}

function pedido(over: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return { created_at: hace(13), cancelled_at: null, financial_status: "pending", shipping_mode: "cod", ...over };
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
    custody_state: swaypCustodyFor(g.swayp_state ?? 0) ?? "empresa",
    reported_status: g.reported_status,
    swayp_state: g.swayp_state,
    closed_at: g.closed_at,
    updated_at: g.updated_at,
  };
}

const orden = (coverage: "lima" | "provincia", over: Partial<MacroOrderSnapshot> = {}): MacroOrderSnapshot => ({
  created_at: hace(13),
  confirmation_activation_date: "2026-06-01",
  cancelled_at: null,
  financial_status: "pending",
  shipping_mode: "cod",
  coverage,
  region: coverage === "lima" ? "Lima" : "Arequipa",
  province: coverage === "lima" ? "Lima" : "Arequipa",
  district: coverage === "lima" ? "Puente Piedra" : "Cayma",
  ...over,
});

function resolverTodo(guides: GuideSnapshot[], coverage: "lima" | "provincia" = "lima", o = pedido()) {
  const legacy = resolveOrderState({ order: o, guides, events: [], override: null, now: NOW, recoveryWindowDays: 30 });
  const macro = resolveMacroStage({
    order: orden(coverage, { cancelled_at: o.cancelled_at }),
    guides: guides.map(macroGuia),
    events: [],
    legacy: { general: legacy.general, operational: legacy.operational, since: legacy.since },
    paymentState: "sin_pago",
    recoveryWindowDays: 30,
    now: NOW,
  });
  return { legacy, macro };
}

describe("el Master: lo que Swayp no entregó se reprograma", () => {
  it("Devolución, Devolución confirmada y con cobro son «no entregó»; lo demás no", () => {
    for (const s of [8, 9, 12]) expect(swaypGuideFailed(swayp({ swayp_state: s })), String(s)).toBe(true);
    for (const s of [1, 3, 4, 5, 6, 7, 10, 11, null]) expect(swaypGuideFailed(swayp({ swayp_state: s })), String(s)).toBe(false);
    // Solo en guías de Swayp: el mismo número en otro courier no dice nada.
    expect(swaypGuideFailed(swayp({ courier: "aliclik" }))).toBe(false);
    expect(swaypGuideFailed(swayp({ courier: "swayp" }))).toBe(true);
    expect(guideFailedAfterDispatch(swayp())).toBe(true);
  });

  it("#KP135009: la guía que Swayp devuelve saca el pedido de «En tránsito» a «Por reprogramar Lima»", () => {
    const { legacy, macro } = resolverTodo([swayp()]);
    expect(legacy.general).toBe("en_proceso");
    expect(legacy.operational).toBe("pendiente_nuevo_courier");
    expect(macro.stage).toBe("en_curso");
    expect(macro.substage).toBe("por_reprogramar_lima");
  });

  it("también con la devolución ya confirmada (la guía cerrada sin entregar)", () => {
    const { legacy, macro } = resolverTodo([swayp({ swayp_state: 9, delivery_status: "anulado", closed_at: hace(0) })]);
    expect(legacy.operational).toBe("pendiente_nuevo_courier");
    expect(macro.substage).toBe("por_reprogramar_lima");
  });

  it("en provincia va a Gestión Reproprovincia (Swayp se puede repetir allí, §9.3)", () => {
    const { macro } = resolverTodo([swayp()], "provincia");
    expect(macro.stage).toBe("en_curso");
    expect(macro.substage).toBe("gestion_reproprovincia");
  });

  it("la ventana es la de la tienda, anclada en la salida del intento, no en el sello del barrido", () => {
    const g = swayp({ dispatched_at: hace(3), updated_at: hace(0) });
    expect(guideFailedAt(g)).toBe(hace(3));
    expect(recoveryWindowDaysFor(g, 30)).toBe(30);
    expect(recoveryWindowDaysFor(g, 30)).not.toBe(TANDERS_RECOVERY_DAYS);
    const w = recoveryActive([g], [], NOW, 30);
    expect(w?.closedAt).toBe(hace(3));
    // Salió hace 31 días: la ventana ya venció.
    expect(recoveryActive([swayp({ dispatched_at: hace(31) })], [], NOW, 30)).toBeNull();
  });

  it("una novedad NO es un «no entregó»: el paquete sigue con el mensajero, en reparto", () => {
    const { legacy, macro } = resolverTodo([swayp({ swayp_state: 6 })]);
    expect(legacy.operational).not.toBe("pendiente_nuevo_courier");
    expect(macro.stage).toBe("en_curso");
    expect(macro.substage).toBe("en_reparto");
  });

  it("una devolución revertida (vuelve a Reparto) deja de estar en recuperación", () => {
    const { legacy, macro } = resolverTodo([swayp({ swayp_state: 5 })]);
    expect(legacy.operational).not.toBe("pendiente_nuevo_courier");
    expect(macro.substage).toBe("en_reparto");
  });

  it("anulado en Shopify gana: Por cerrar, con la caja todavía por recoger (§9.4)", () => {
    const { legacy, macro } = resolverTodo([swayp({ swayp_state: 9, delivery_status: "anulado", closed_at: hace(0) })], "lima", pedido({ cancelled_at: hace(0) }));
    expect(legacy.general).toBe("anulado");
    expect(macro.stage).toBe("por_cerrar");
    expect(macro.substage).toBe("devolucion_fisica_pendiente");
  });

  it("la salida que Swayp no entregó no bloquea a Grupo GF y se nombra en la fila", () => {
    const outputs = [{ ...swayp(), output_number: 1, custody_state: "retorno" }];
    expect(outputsBlockingRetry(outputs)).toEqual([]);
    const failed = lastFailedOutput(outputs);
    expect(failed).toEqual({ courier: "fenix", returned: false });
    expect(failedOutputLabel(failed!)).toBe("Swayp no entregó · vuelve");
  });

  it("el MOM lo documenta, con los nombres reales de los estados", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("#### Lo que Swayp no entrega, también (v1.22, 29-09-2026)");
    expect(mom).toContain("#### El estado de Swayp se lee de su API (29-09-2026)");
    expect(mom).not.toContain("El estado 8, «Revisión»");
    expect(read("lib/order-macro-stage.ts")).toContain('MOM_RESOLUTION_VERSION = "mom-v1.23"');
  });

  it("todos los lectores de la regla traen el estado de Swayp", () => {
    expect(read("lib/order-master.ts")).toContain("reported_status,swayp_state");
    expect(read("lib/order-master.ts")).toContain("swayp_state: s.swayp_state ?? null");
    expect(read("lib/order-master.ts")).toContain("swayp_state: guide.swayp_state ?? null");
    expect(read("app/dashboard/courier/actions.ts")).toMatch(/ADMISSION_SHIPMENT_COLUMNS =\s*"[^"]*swayp_state/);
    expect(read("lib/shipments-access.ts")).toContain("reported_status,swayp_state,dispatched_at");
    expect(read("lib/voice-recovery-server.ts")).toContain("reported_status, swayp_state, dispatched_at");
  });
});

// ── El rechazo en la puerta de Swayp (29-09-2026) ───────────────────────────
//
// El agente de voz podía llamar en provincia a clientas que le dijeron a Swayp
// «ya no desea el producto». Swayp lo dice en su novedad (catálogo público: 16
// «Destinatario ya no desea el producto», 15 «no ha comprado ningún producto»);
// el barrido la guarda como etiqueta del courier y la regla la lee igual que el
// `REFUSED` de Aliclik.

const RECHAZO = "Swayp · Destinatario indica que ya no desea el producto (16)";
const NO_CONTESTA = "Swayp · Destinatario no contesta (7)";

describe("la novedad de Swayp como etiqueta del courier", () => {
  it("la etiqueta lleva nombre e id", () => {
    expect(swaypNoveltyLabel({ id: 16, name: "Destinatario indica que ya no desea el producto" })).toBe(RECHAZO);
    expect(swaypNoveltyLabel({ id: 7, name: " Destinatario no contesta " })).toBe(NO_CONTESTA);
    expect(swaypNoveltyLabel({ id: null, name: "Reprogramado" })).toBe("Swayp · Reprogramado");
    expect(swaypNoveltyLabel({ id: 13, name: null })).toBe("Swayp · Novedad (13)");
  });

  it("rechazo = novedades 15 y 16; decide el id, y sin id el nombre", () => {
    expect([...SWAYP_REJECTION_NOVELTIES].sort((a, b) => a - b)).toEqual([15, 16]);
    expect(swaypLabelSaysRejection(RECHAZO)).toBe(true);
    expect(swaypLabelSaysRejection("Swayp · Destinatario no ha comprado ningún producto (15)")).toBe(true);
    expect(swaypLabelSaysRejection(NO_CONTESTA)).toBe(false);
    // «Pedido diferente al solicitado» no: el error es nuestro.
    expect(swaypLabelSaysRejection("Swayp · Pedido diferente al solicitado (12)")).toBe(false);
    expect(swaypLabelSaysRejection("Swayp · Destinatario ya no desea el producto")).toBe(true);
    // Ni la etiqueta de Aliclik ni nada que no sea de Swayp.
    expect(swaypLabelSaysRejection("REFUSED · PICKED · ")).toBe(false);
    expect(swaypLabelSaysRejection("ya no desea el producto (16)")).toBe(false);
    expect(swaypLabelSaysRejection(null)).toBe(false);
  });

  it("bodega no despachó = novedad 20; decide el id, y sin id el nombre (#KP138099)", () => {
    expect(SWAYP_UNDISPATCHED_NOVELTY).toBe(20);
    expect(swaypLabelSaysUndispatched("Swayp · Bodega no despacho mercancía (20)")).toBe(true);
    expect(swaypLabelSaysUndispatched("Swayp · Bodega no despachó mercancía")).toBe(true);
    expect(swaypLabelSaysUndispatched(NO_CONTESTA)).toBe(false);
    expect(swaypLabelSaysUndispatched("Swayp · Falta Inventario (18)")).toBe(false);
    expect(swaypLabelSaysUndispatched("Bodega no despacho mercancía (20)")).toBe(false);
    expect(swaypLabelSaysUndispatched(null)).toBe(false);
  });

  it("cuenta la ÚLTIMA novedad del historial", () => {
    const historial = (a: [string, string, string], b: [string, string, string]) => ({
      estado: "Devolucion",
      estados: [
        { estado: "Novedad", codigoEstado: "6", fecha: a[0], idNovedad: a[1], nombreNovedad: a[2] },
        { estado: "Novedad", codigoEstado: "6", fecha: b[0], idNovedad: b[1], nombreNovedad: b[2] },
        { estado: "Devolucion", codigoEstado: "8", fecha: "2026-09-28T22:03:38.357Z" },
      ],
    });
    expect(readSwaypGuide(historial(["2026-09-28T10:00:00Z", "7", "Destinatario no contesta"], ["2026-09-28T18:00:00Z", "16", "Destinatario ya no desea el producto"])).novelty).toEqual({ id: 16, name: "Destinatario ya no desea el producto" });
    expect(readSwaypGuide(historial(["2026-09-28T18:00:00Z", "16", "Destinatario ya no desea el producto"], ["2026-09-28T10:00:00Z", "7", "Destinatario no contesta"])).novelty).toEqual({ id: 16, name: "Destinatario ya no desea el producto" });
    expect(readSwaypGuide({ estado: "Reparto" }).novelty).toBeNull();
  });

  it("guardarla es un cambio aunque el estado no cambie; la misma, no", () => {
    const now = "2026-09-29T22:00:00.000Z";
    const viva = fila({ swayp_state: 8, custody_state: "retorno", dispatched_at: hace(2), custody_transferred_at: hace(2) });
    expect(swaypStatePatch(viva, { state: 8, novelty: RECHAZO }, now)).toEqual({ patch: { reported_status: RECHAZO }, changed: true, deliveryStatus: "en_ruta" });
    expect(swaypStatePatch({ ...viva, reported_status: RECHAZO }, { state: 8, novelty: RECHAZO }, now).changed).toBe(false);
    // Sin historial (el webhook) no borra la que hay.
    expect(swaypStatePatch({ ...viva, reported_status: RECHAZO }, { state: 8 }, now).changed).toBe(false);
    // Con cambio de estado, va junto.
    expect(swaypStatePatch(viva, { state: 10, novelty: RECHAZO }, now).patch).toMatchObject({ swayp_state: 9, reported_status: RECHAZO });
  });

  it("el barrido la escribe y deja en el log las claves del historial", async () => {
    const { admin, updates } = fakeAdmin([guia("601", { swayp_state: 8, custody_state: "retorno", dispatched_at: hace(2), custody_transferred_at: hace(2) })]);
    const report = await sweepSwaypStatus(admin, {
      client: cliente({ "601": { status: 200, body: { estado: "Devolucion", idEstado: 8, estados: [{ estado: "Novedad", codigoEstado: "6", fecha: "2026-09-28T18:15:55.642Z", idNovedad: "16", nombreNovedad: "Destinatario indica que ya no desea el producto" }] } } }),
      now: () => new Date(NOW),
      recompute: async () => undefined,
    });
    expect(updates[0]!.patch).toMatchObject({ reported_status: RECHAZO });
    expect(report.historial).toBe("estados");
    expect(report.historialClaves).toEqual(["codigoEstado", "estado", "fecha", "idNovedad", "nombreNovedad"]);
  });
});

describe("el rechazo de Swayp en la recuperación y en el agente de voz", () => {
  const fallida = (reported_status: string | null) => ({
    courier: "fenix",
    delivery_status: "en_ruta",
    swayp_state: 8,
    reported_status,
    dispatched_at: hace(2),
    closed_at: null,
    returned_at: null,
    updated_at: hace(0),
  });

  it("es un rechazo en la puerta solo en una guía de Swayp", () => {
    expect(guideDoorRejection(fallida(RECHAZO))).toBe(true);
    expect(guideDoorRejection(fallida(NO_CONTESTA))).toBe(false);
    expect(guideDoorRejection({ ...fallida(RECHAZO), courier: "aliclik" })).toBe(false);
    // El de Aliclik sigue igual.
    expect(guideDoorRejection({ courier: "aliclik", delivery_status: "anulado", reported_status: "REFUSED · PICKED · " })).toBe(true);
  });

  it("la recuperación sigue abierta, pero si vence es «rechazo no reenviado»", () => {
    const w = recoveryWindow([fallida(RECHAZO)], [], NOW, 30);
    expect(w).toMatchObject({ doorRejection: true, expired: false });
    const vencida = recoveryWindow([{ ...fallida(RECHAZO), dispatched_at: hace(40) }], [], NOW, 30);
    expect(vencida?.expired).toBe(true);
    expect(expiredRecoveryKind(vencida!)).toBe("rechazo_no_reenviado");
    expect(recoveryWindow([fallida(NO_CONTESTA)], [], NOW, 30)?.doorRejection).toBe(false);
  });

  const voz = (reported_status: string | null): VoiceCandidateInput => ({
    now: new Date(NOW),
    today: "2026-09-29",
    guides: [fallida(reported_status)],
    events: [],
    recoveryWindowDays: 30,
    maxAgeDays: 7,
    district: "Cusco",
    region: "Cuzco",
    lineItems: [{ title: "Aceite de Semilla Negra", sku: "ETH-60", quantity: 1 }],
    stock: [{ city: "cusco", product: "Aceite de Semilla Negra", sku: "ETH-60", quantity: 10 }],
    phone: "51930555309",
    priors: [],
    nextContactOn: null,
    agentCalls: [],
    maxAgentAttempts: 2,
    doNotCall: false,
  });

  it("el agente no llama a quien le dijo a Swayp que ya no lo quiere", () => {
    expect(voiceRecoveryEligible(voz(RECHAZO))).toEqual({ eligible: false, reason: "rechazo_en_puerta" });
  });

  it("a quien no contestó, sí", () => {
    expect(voiceRecoveryEligible(voz(NO_CONTESTA))).toMatchObject({ eligible: true });
    expect(voiceRecoveryEligible(voz(null))).toMatchObject({ eligible: true });
  });

  it("el barrido lee la etiqueta y el cron deja las claves del historial", () => {
    expect(read("lib/swayp-status-sweep.ts")).toContain("novelty: reading.novelty ? swaypNoveltyLabel(reading.novelty) : null,");
    expect(read("lib/swayp-ingest.ts")).toContain('"dispatched_at,out_for_delivery_at,closed_at,reported_status"');
    expect(read("app/api/cron/swayp-status/route.ts")).toContain("JSON.stringify(report.historialClaves)");
    expect(read("lib/voice-recovery-queue.ts")).toContain("motivoDelCourier(guide.reported_status).vioElProducto || window.doorRejection");
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("**Swayp también rechaza en la puerta\n   (29-09-2026):**");
    expect(mom).toContain("- **La novedad se guarda como etiqueta del courier** (`reported_status`):");
  });
});
