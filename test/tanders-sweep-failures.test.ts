import { describe, expect, it } from "vitest";
import {
  describeSweepError,
  isThrottled,
  MAX_DISTINCT_FAILURES,
  OTHER_LABEL,
  recordSweepFailure,
  SWEEP_PACE_MS,
  type SweepFailure,
  isNotYetDelivered,
} from "@/lib/tanders/sweep-failures";
import { TandersApiError } from "@/lib/tanders/types";

/**
 * EL CASO. El 08-09-2026 las 330 guías Tanders seguían en PENDING tras tres
 * semanas de cron horario: ninguna con `last_report_at` ni comprobación de
 * pago. Los barridos tragaban cada error y el reporte decía «errores: 200» y
 * nada más. Con eso no se distingue la contraseña del endpoint de la red.
 */

describe("describeSweepError", () => {
  it("un error de su API dice método, ruta y status: eso es el diagnóstico", () => {
    // 404 en GET /orders/{id} = la ruta no existe. 401 = la contraseña. 5xx =
    // Tanders caído. El reporte tiene que decir cuál de los tres es.
    const err = new TandersApiError("Not Found", 404, null, "GET", "/orders/cmtru1tlb00250m1ysr2upshi");
    expect(describeSweepError(err)).toBe("Tanders GET /orders/{id} → 404: Not Found");
  });

  it("el id concreto se reemplaza para que 200 guías sean UN motivo", () => {
    const a = new TandersApiError("Not Found", 404, null, "GET", "/orders/cmtru1tlb00250m1ysr2upshi");
    const b = new TandersApiError("Not Found", 404, null, "GET", "/orders/cmtrxyz9900250m1ysr2aaaaa");
    expect(describeSweepError(a)).toBe(describeSweepError(b));
  });

  it("una ruta con más segmentos también se normaliza", () => {
    const err = new TandersApiError("Forbidden", 403, null, "GET", "/orders/me/cmtru1tlb00250m1ysr2upshi/aliclik/evidences");
    expect(describeSweepError(err)).toBe(
      "Tanders GET /orders/me/{id}/aliclik/evidences → 403: Forbidden",
    );
  });

  it("un error sin ruta (login) sigue diciendo el status", () => {
    const err = new TandersApiError("Unauthorized", 401);
    expect(describeSweepError(err)).toBe("Tanders → 401: Unauthorized");
  });

  it("un error que no es de su API conserva nombre y mensaje", () => {
    expect(describeSweepError(new TypeError("fetch failed"))).toBe("TypeError: fetch failed");
    expect(describeSweepError("algo raro")).toBe("algo raro");
  });
});

describe("isThrottled: un 429 no es una guía que falla, es Tanders diciendo «basta»", () => {
  // El 08-09-2026, con 200 lecturas seguidas, las últimas 80 volvieron «429
  // ThrottlerException». Seguir tras el primero solo quema llamadas y alarga
  // el castigo: el barrido para ahí y deja el resto para la próxima pasada.
  it("reconoce el 429 de su API", () => {
    expect(isThrottled(new TandersApiError("Too Many Requests", 429, null, "GET", "/orders/me/x"))).toBe(true);
  });

  it("cualquier otro fallo NO detiene el barrido", () => {
    expect(isThrottled(new TandersApiError("Forbidden resource", 403))).toBe(false);
    expect(isThrottled(new TandersApiError("boom", 500))).toBe(false);
    expect(isThrottled(new TypeError("fetch failed"))).toBe(false);
    expect(isThrottled(null)).toBe(false);
  });

  it("la pausa entre guías hace que 60 lecturas duren segundos, no milisegundos", () => {
    // 60 × 300 ms = 18 s: cabe de sobra en el cron y no parece una ráfaga.
    expect(SWEEP_PACE_MS).toBeGreaterThanOrEqual(200);
    expect(60 * SWEEP_PACE_MS).toBeLessThan(60_000);
  });
});

describe("recordSweepFailure", () => {
  it("agrupa por mensaje y cuenta", () => {
    const list: SweepFailure[] = [];
    for (let i = 0; i < 3; i++) {
      recordSweepFailure(list, new TandersApiError("Not Found", 404, null, "GET", `/orders/id${i}aaaaaaaaaaaaaaaaaaaaa`));
    }
    recordSweepFailure(list, new TandersApiError("Unauthorized", 401));
    expect(list).toEqual([
      { mensaje: "Tanders GET /orders/{id} → 404: Not Found", n: 3 },
      { mensaje: "Tanders → 401: Unauthorized", n: 1 },
    ]);
  });

  it("más motivos distintos que el tope se agrupan en «otros», sin perder la cuenta", () => {
    const list: SweepFailure[] = [];
    for (let i = 0; i < MAX_DISTINCT_FAILURES + 3; i++) {
      recordSweepFailure(list, new Error(`motivo ${i}`));
    }
    expect(list).toHaveLength(MAX_DISTINCT_FAILURES + 1);
    expect(list[list.length - 1]).toEqual({ mensaje: OTHER_LABEL, n: 3 });
    // Un motivo ya visto sigue sumando en su fila aunque el tope esté lleno.
    recordSweepFailure(list, new Error("motivo 0"));
    expect(list[0]).toEqual({ mensaje: "Error: motivo 0", n: 2 });
  });
});

describe("isNotYetDelivered", () => {
  it("reconoce el 400 de una guía todavía en ruta", () => {
    // Es la respuesta NORMAL del endpoint de evidencias mientras el paquete no
    // se entregó: contarla como error escondía los fallos de verdad.
    expect(
      isNotYetDelivered(
        new TandersApiError("Order is not yet delivered", 400, null, "GET", "/orders/me/x/aliclik/evidences"),
      ),
    ).toBe(true);
  });

  it("no confunde otros 400 ni otros status", () => {
    expect(isNotYetDelivered(new TandersApiError("Bad request", 400))).toBe(false);
    expect(isNotYetDelivered(new TandersApiError("Order is not yet delivered", 500))).toBe(false);
    expect(isNotYetDelivered(new Error("Order is not yet delivered"))).toBe(false);
  });
});
