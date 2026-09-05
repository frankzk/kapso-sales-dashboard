import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveAliclikHealth,
  resolveAliclikCreateHealth,
  describeAliclikHealth,
  HEALTH_FRESHNESS_MS,
} from "@/lib/aliclik-health";

const NOW = Date.parse("2026-08-03T18:00:00.000Z"); // 13:00 Perú

describe("resolveAliclikHealth", () => {
  it("verde cuando la última sonda OK es fresca", () => {
    const latest = { status: "operativo", checkedAt: new Date(NOW - 60_000).toISOString() };
    expect(resolveAliclikHealth(latest, NOW)).toBe("operativo");
  });

  it("rojo cuando la última sonda fresca reporta fallos", () => {
    const latest = { status: "fallos", checkedAt: new Date(NOW - 120_000).toISOString() };
    expect(resolveAliclikHealth(latest, NOW)).toBe("fallos");
  });

  it("gris cuando no hay ninguna sonda", () => {
    expect(resolveAliclikHealth(null, NOW)).toBe("sin_monitoreo");
  });

  it("gris cuando la última sonda es vieja (de noche o cron caído)", () => {
    const stale = { status: "operativo", checkedAt: new Date(NOW - HEALTH_FRESHNESS_MS - 1).toISOString() };
    expect(resolveAliclikHealth(stale, NOW)).toBe("sin_monitoreo");
  });

  it("gris ante una fecha del futuro (reloj torcido), no verde a ciegas", () => {
    const future = { status: "operativo", checkedAt: new Date(NOW + 5 * 60_000).toISOString() };
    expect(resolveAliclikHealth(future, NOW)).toBe("sin_monitoreo");
  });

  it("gris ante un status desconocido", () => {
    const weird = { status: "otra_cosa", checkedAt: new Date(NOW).toISOString() };
    expect(resolveAliclikHealth(weird, NOW)).toBe("sin_monitoreo");
  });
});

// ── Salud del camino de CREACIÓN ────────────────────────────────────────────
// Cotizar y crear son endpoints distintos y se caen por separado. El 10-08
// cotizar iba 3/3 en ~1 s mientras crear se iba en timeout, y el foco pintaba
// verde: la asesora pulsaba confiando en él y se llevaba el pedido bloqueado.

const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();
const attempt = (status: string, mins: number, error: string | null = null) => ({
  status,
  error,
  createdAt: ago(mins),
});
const TIMEOUT = "Edge no pudo contactar con Aliclik: The operation was aborted due to timeout";

describe("resolveAliclikCreateHealth", () => {
  it("degradado con dos timeouts seguidos y ningún éxito después (el caso del 10-08)", () => {
    const attempts = [attempt("pending", 1, TIMEOUT), attempt("pending", 5, TIMEOUT)];
    expect(resolveAliclikCreateHealth(attempts, NOW)).toBe("degradado");
  });

  it("un solo fallo NO enciende el aviso: pasa con la API sana y sería ruido", () => {
    expect(resolveAliclikCreateHealth([attempt("pending", 2, TIMEOUT)], NOW)).toBe("ok");
  });

  it("se apaga en cuanto una creación vuelve a funcionar, sin esperar a la ventana", () => {
    const attempts = [
      attempt("sent", 1),
      attempt("failed", 4, TIMEOUT),
      attempt("failed", 6, TIMEOUT),
    ];
    expect(resolveAliclikCreateHealth(attempts, NOW)).toBe("ok");
  });

  it("un 'pending' sin error es una creación EN VUELO, no un fallo", () => {
    // La fila se escribe antes del POST: contarla como fallo encendería el foco
    // cada vez que dos asesoras crean a la vez.
    const attempts = [attempt("pending", 0), attempt("pending", 0), attempt("sent", 3)];
    expect(resolveAliclikCreateHealth(attempts, NOW)).toBe("ok");
  });

  it("los fallos viejos no cuentan: fuera de la ventana no describen el presente", () => {
    const attempts = [attempt("failed", 45, TIMEOUT), attempt("failed", 50, TIMEOUT)];
    expect(resolveAliclikCreateHealth(attempts, NOW)).toBe("sin_datos");
  });

  it("sin intentos, sin_datos — callar es más honesto que dar por bueno", () => {
    expect(resolveAliclikCreateHealth([], NOW)).toBe("sin_datos");
  });

  it("ordena por fecha aunque lleguen desordenados: la racha es la más reciente", () => {
    const attempts = [attempt("failed", 8, TIMEOUT), attempt("sent", 1), attempt("failed", 6, TIMEOUT)];
    expect(resolveAliclikCreateHealth(attempts, NOW)).toBe("ok");
  });

  it("una fecha ilegible se descarta en vez de mover la racha al azar", () => {
    const attempts = [
      { status: "failed", error: TIMEOUT, createdAt: "no-es-fecha" },
      attempt("failed", 2, TIMEOUT),
    ];
    expect(resolveAliclikCreateHealth(attempts, NOW)).toBe("ok");
  });
});

describe("describeAliclikHealth", () => {
  it("cotizar caído gana: si el servidor no responde, no hay nada que crear", () => {
    const copy = describeAliclikHealth({ quote: "fallos", create: "degradado" });
    expect(copy.tone).toBe("rojo");
    expect(copy.label).toBe("Aliclik con fallos");
  });

  it("cotizar bien + crear degradado ya NO es verde: es el caso caro", () => {
    const copy = describeAliclikHealth({ quote: "operativo", create: "degradado" });
    expect(copy.tone).toBe("ambar");
    expect(copy.label).toBe("Aliclik: crear guías falla");
    // El aviso tiene que nombrar la consecuencia, no solo el síntoma.
    expect(copy.hint).toContain("bloqueado");
  });

  it("verde solo cuando ambos caminos están bien", () => {
    expect(describeAliclikHealth({ quote: "operativo", create: "ok" }).tone).toBe("verde");
  });

  it("verde sin creaciones recientes, pero el texto no promete lo que no vio", () => {
    const copy = describeAliclikHealth({ quote: "operativo", create: "sin_datos" });
    expect(copy.tone).toBe("verde");
    expect(copy.hint).toContain("Sin creaciones recientes");
  });

  it("sin sonda fresca es gris aunque no haya fallos de creación", () => {
    expect(describeAliclikHealth({ quote: "sin_monitoreo", create: "ok" }).tone).toBe("gris");
  });
});

describe("la sonda vigila las 24 horas", () => {
  // POR QUÉ SE PRUEBA UN CRON. Esto se restringió una vez con un argumento
  // razonable —"de noche nadie crea guías"— y el hueco tardó semanas en verse:
  // el barrido `aliclik-close` sí corre a toda hora, así que las caídas de
  // madrugada producían fallos reales sin dejar ni una fila de salud. Volver a
  // acotarlo "para ahorrar llamadas" es una tentación con buena pinta, y esta
  // prueba es lo único que la convierte en una decisión consciente.
  it("el cron corre cada 5 minutos, sin ventana horaria", () => {
    const cfg = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")) as {
      crons: { path: string; schedule: string }[];
    };
    const health = cfg.crons.find((c) => c.path === "/api/cron/aliclik-health");
    expect(health).toBeDefined();
    expect(health!.schedule).toBe("*/5 * * * *");
  });

  it("y el handler tampoco se salta horas por su cuenta", () => {
    // El cron dice CUÁNDO se dispara; el handler decidía SI hacía algo. Con las
    // dos puertas, abrir solo una no cambia nada — que es justo el error que
    // habría cometido quien tocara únicamente el vercel.json.
    const source = readFileSync(resolve(process.cwd(), "app/api/cron/aliclik-health/route.ts"), "utf8");
    expect(source).not.toContain("withinBusinessHoursPeru");
  });
});
