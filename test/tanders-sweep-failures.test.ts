import { describe, expect, it } from "vitest";
import {
  describeSweepError,
  MAX_DISTINCT_FAILURES,
  OTHER_LABEL,
  recordSweepFailure,
  type SweepFailure,
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
