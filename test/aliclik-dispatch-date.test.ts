import { describe, expect, it } from "vitest";
import {
  dispatchFallsOnSunday,
  expectedDispatchDate,
  naiveDispatchDate,
} from "@/lib/aliclik-dispatch-date";

// Las horas se escriben en UTC y se leen en Lima (UTC−5, sin horario de verano).
// 19:00Z = 14:00 en Lima, que es la hora de corte del caso real.
const lima = (iso: string) => new Date(iso);

const CUTOFF = "14:00";

describe("expectedDispatchDate — la regla de Aliclik", () => {
  it("antes del corte despacha hoy", () => {
    // Viernes 4 de septiembre, 13:00 de Lima.
    expect(expectedDispatchDate(CUTOFF, lima("2026-09-04T18:00:00Z"))).toBe("2026-09-04");
  });

  it("pasado el corte despacha mañana", () => {
    // Viernes 16:00 → sábado 5.
    expect(expectedDispatchDate(CUTOFF, lima("2026-09-04T21:00:00Z"))).toBe("2026-09-05");
  });

  it("a la hora exacta del corte todavía es hoy", () => {
    // El borde decide el caso de última hora, que es el que acaba en discusión
    // con el motorizado. «Hasta las 14:00» incluye las 14:00.
    expect(expectedDispatchDate(CUTOFF, lima("2026-09-04T19:00:00Z"))).toBe("2026-09-04");
    // Y un minuto después ya es mañana.
    expect(expectedDispatchDate(CUTOFF, lima("2026-09-04T19:01:00Z"))).toBe("2026-09-05");
  });
});

describe("expectedDispatchDate — el fin de semana", () => {
  // La ventana que describe la operación: desde el sábado a las 14:01 hasta el
  // lunes a las 14:00, todo se despacha el lunes.
  it("sábado 16:00 → lunes", () => {
    expect(expectedDispatchDate(CUTOFF, lima("2026-09-05T21:00:00Z"))).toBe("2026-09-07");
  });

  it("sábado 13:00 → el mismo sábado, que sí recogen", () => {
    expect(expectedDispatchDate(CUTOFF, lima("2026-09-05T18:00:00Z"))).toBe("2026-09-05");
  });

  it("domingo a cualquier hora → lunes", () => {
    expect(expectedDispatchDate(CUTOFF, lima("2026-09-06T15:00:00Z"))).toBe("2026-09-07");
    // También pasado el corte: el domingo +1 es lunes y ahí no hay salto extra.
    expect(expectedDispatchDate(CUTOFF, lima("2026-09-06T21:00:00Z"))).toBe("2026-09-07");
  });

  it("lunes 13:00 → el mismo lunes; 16:00 → martes", () => {
    expect(expectedDispatchDate(CUTOFF, lima("2026-09-07T18:00:00Z"))).toBe("2026-09-07");
    expect(expectedDispatchDate(CUTOFF, lima("2026-09-07T21:00:00Z"))).toBe("2026-09-08");
  });

  it("reproduce la guía AUR5X846640592825", () => {
    // Creada el sábado 29-08-2026 a las 19:13:30 UTC = 14:13 de Lima, courier
    // estándar con schedule "14:00". Aliclik la fechó para el domingo 30; su
    // propia regla mandaba el lunes 31.
    expect(expectedDispatchDate(CUTOFF, lima("2026-08-29T19:13:30Z"))).toBe("2026-08-31");
    expect(naiveDispatchDate(CUTOFF, lima("2026-08-29T19:13:30Z"))).toBe("2026-08-30");
    expect(dispatchFallsOnSunday(CUTOFF, lima("2026-08-29T19:13:30Z"))).toBe(true);
  });
});

describe("expectedDispatchDate — el corte es de Aliclik, no nuestro", () => {
  it("respeta un corte distinto del de ALIDRIVER", () => {
    // El ejemplo de su documentación trae "16:30" para Olva. A las 16:00 de un
    // viernes ese courier todavía despacha hoy, y el de las 14:00 ya no.
    const viernes1600 = lima("2026-09-04T21:00:00Z");
    expect(expectedDispatchDate("16:30", viernes1600)).toBe("2026-09-04");
    expect(expectedDispatchDate("14:00", viernes1600)).toBe("2026-09-05");
  });

  it("sin corte conocido no adelanta el día, pero sí salta el domingo", () => {
    // Los express vienen con schedule null. No sabemos si pasó un corte, así
    // que no se retrasa por un dato que falta; el domingo no depende de la hora.
    expect(expectedDispatchDate(null, lima("2026-09-04T21:00:00Z"))).toBe("2026-09-04");
    expect(expectedDispatchDate(null, lima("2026-09-06T15:00:00Z"))).toBe("2026-09-07");
  });
});

describe("dispatchFallsOnSunday — cuándo hay algo que advertir", () => {
  it("solo avisa cuando el corte empuja al domingo", () => {
    // Sábado pasado el corte: su cálculo cae en domingo.
    expect(dispatchFallsOnSunday(CUTOFF, lima("2026-09-05T21:00:00Z"))).toBe(true);
    // Domingo antes del corte: también, porque «hoy» ya es domingo.
    expect(dispatchFallsOnSunday(CUTOFF, lima("2026-09-06T15:00:00Z"))).toBe(true);
  });

  it("no avisa el resto de la semana", () => {
    // Callarse importa tanto como avisar: un aviso que sale siempre se ignora.
    for (const iso of [
      "2026-09-04T18:00:00Z", // viernes antes del corte
      "2026-09-04T21:00:00Z", // viernes después → sábado, que sí recogen
      "2026-09-07T21:00:00Z", // lunes después → martes
    ]) {
      expect(dispatchFallsOnSunday(CUTOFF, lima(iso))).toBe(false);
    }
  });
});
