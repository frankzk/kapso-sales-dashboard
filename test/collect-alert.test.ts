import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COLLECT_REALERT_MIN,
  formatCollectAlert,
  selectCollectMismatches,
  type CollectAlertRow,
} from "@/lib/collect-alert";

/**
 * El detector de cobros equivocados, por fin conectado.
 *
 * QUÉ PASÓ. La migración 0060 guarda desde hace meses `reported_collect_amount`
 * —lo que el courier declara que va a cobrar, refrescado cada 20 minutos— y su
 * cabecera decía que persistirlo «convierte esa pasada en un detector
 * permanente». Pero `collectAmountMismatch` solo lo llamaba su propio test: el
 * dato se recogía y no lo miraba nadie. El fallo que lo motivó —una guía
 * cobrando S/ 447 cuando la clienta debía S/ 298— se habría repetido igual de
 * invisible.
 *
 * Y ahora hay un caso más caro: un pedido pagado en el checkout cuya guía sigue
 * cobrando en la puerta. Ahí esto es la única defensa, porque Aliclik calcula su
 * importe desde los precios de línea y no pasa por `defaultCollectionAmount`.
 */

const AHORA = Date.parse("2026-08-24T15:00:00.000Z");
const HACE = (min: number) => AHORA - min * 60_000;

const row = (over: Partial<CollectAlertRow> = {}): CollectAlertRow => ({
  id: "s1",
  orderName: "#KP130001",
  guideCode: "ALC-1",
  courier: "aliclik",
  deliveryStatus: "en_ruta",
  reported: 456.3,
  orderTotal: 456.3,
  facts: { financialStatus: "pending" },
  alertSentAtMs: null,
  ...over,
});

describe("qué se avisa", () => {
  it("un pedido PAGADO cuya guía cobra: la alerta más cara", () => {
    // Antes esto no era ni un descuadre: 456.30 contra 456.30 «cuadra». Lo que
    // lo convierte en alarma es saber que el cliente ya puso el dinero.
    const due = selectCollectMismatches([row({ facts: { financialStatus: "paid" } })], AHORA);
    expect(due).toHaveLength(1);
    expect(due[0]!.kind).toBe("cobra_de_mas");
    expect(due[0]!.gap).toBe(456.3);
    expect(due[0]!.message).toContain("YA ESTÁ PAGADO");
  });

  it("el caso clásico de cobrar de más sigue detectándose", () => {
    // El de los S/447. Es el que motivó la 0060 y nunca llegó a avisar a nadie.
    const due = selectCollectMismatches([row({ reported: 447, orderTotal: 298 })], AHORA);
    expect(due).toHaveLength(1);
    expect(due[0]!.gap).toBeCloseTo(149, 2);
  });

  it("una guía que cuadra no molesta", () => {
    expect(selectCollectMismatches([row()], AHORA)).toHaveLength(0);
  });

  it("una guía en 0 sobre un pedido pagado es lo CORRECTO: silencio", () => {
    expect(
      selectCollectMismatches([row({ reported: 0, facts: { financialStatus: "paid" } })], AHORA),
    ).toHaveLength(0);
  });
});

describe("cuándo NO se avisa", () => {
  it("un pedido ya entregado o cerrado: no hay nada que evitar", () => {
    // Avisar acá no es una alerta, es un reproche — el dinero ya se cobró y
    // devolverlo no se hace desde el panel del courier.
    for (const estado of ["entregado", "devuelto", "anulado", "transferido"]) {
      const due = selectCollectMismatches(
        [row({ deliveryStatus: estado, facts: { financialStatus: "paid" } })],
        AHORA,
      );
      expect(due, estado).toHaveLength(0);
    }
  });

  it("avisado hace poco: no se repite cada 20 minutos", () => {
    // El cron corre cada 20 min. Sin este freno, el mismo pedido genera setenta
    // alertas antes de entregarse y el canal deja de leerse justo cuando importa.
    const reciente = row({ facts: { financialStatus: "paid" }, alertSentAtMs: HACE(30) });
    expect(selectCollectMismatches([reciente], AHORA)).toHaveLength(0);
  });

  it("pero SÍ se repite pasadas las tres horas: el problema no se resuelve solo", () => {
    const viejo = row({
      facts: { financialStatus: "paid" },
      alertSentAtMs: HACE(COLLECT_REALERT_MIN + 1),
    });
    expect(selectCollectMismatches([viejo], AHORA)).toHaveLength(1);
  });

  it("sin importe declarado todavía no se opina", () => {
    expect(selectCollectMismatches([row({ reported: null })], AHORA)).toHaveLength(0);
  });
});

describe("el mensaje", () => {
  it("nombra el pedido y la guía: hay que ir a buscarlos", () => {
    const due = selectCollectMismatches([row({ facts: { financialStatus: "paid" } })], AHORA);
    const text = formatCollectAlert("Kenku Peru", due);
    expect(text).toContain("Kenku Peru");
    expect(text).toContain("#KP130001");
    expect(text).toContain("ALC-1");
    expect(text).toContain("Anula el cobro con el courier");
  });

  it("el encabezado concuerda en número", () => {
    const uno = selectCollectMismatches([row({ facts: { financialStatus: "paid" } })], AHORA);
    expect(formatCollectAlert("Kenku", uno)).toContain("1 guía va a cobrar");
    const dos = selectCollectMismatches(
      [
        row({ id: "a", facts: { financialStatus: "paid" } }),
        row({ id: "b", orderName: "#KP130002", facts: { financialStatus: "paid" } }),
      ],
      AHORA,
    );
    expect(formatCollectAlert("Kenku", dos)).toContain("2 guías van a cobrar");
  });
});

describe("está enchufado de verdad", () => {
  it("el cron lo llama", () => {
    // La lección de este PR: una función correcta que nadie invoca es un
    // detector apagado. `collectAmountMismatch` estuvo así desde la 0060, con
    // pruebas en verde todo el tiempo.
    const source = readFileSync(resolve(process.cwd(), "app/api/cron/sync/route.ts"), "utf8");
    expect(source).toContain("alertCollectMismatches");
    expect(source).toMatch(/await alertCollectMismatches\(id, admin\)/);
  });

  it("y el fallo del aviso no puede tumbar la sincronización", () => {
    const source = readFileSync(resolve(process.cwd(), "app/api/cron/sync/route.ts"), "utf8");
    const i = source.indexOf("alertCollectMismatches(id, admin)");
    expect(source.slice(i, i + 200)).toContain("catch");
  });
});
