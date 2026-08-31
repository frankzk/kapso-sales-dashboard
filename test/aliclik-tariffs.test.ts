import { describe, expect, it } from "vitest";
import {
  pickTopWarehouse,
  planTariffUpdates,
  QUOTE_PAUSE_MS,
  syncAliclikTariffs,
  type ExistingTariff,
  type ObservedRate,
} from "@/lib/aliclik-tariffs";

const obs = (district: string, amount: number, concept: ObservedRate["concept"] = "primer_intento"): ObservedRate => ({
  district,
  concept,
  amount,
});

const cur = (
  district: string,
  amount: number,
  effective_from = "2026-07-01",
  concept = "primer_intento",
): ExistingTariff => ({ id: `${district}-${concept}`, concept, district, amount, effective_from });

describe("planTariffUpdates", () => {
  it("inserta la tarifa de un distrito que aún no tenía", () => {
    const p = planTariffUpdates([obs("Arequipa", 16.5)], [], "2026-07-28");
    expect(p.insert).toEqual([
      { district: "Arequipa", concept: "primer_intento", amount: 16.5, effectiveFrom: "2026-07-28" },
    ]);
    expect(p.close).toHaveLength(0);
  });

  it("NO escribe nada cuando el precio no cambió", () => {
    // Es la regla que hace viable un cron diario: sin ella se crearían 661
    // filas cada día y la vigencia de cada tarifa duraría 24 horas, dejando
    // inservible el propio mecanismo de "al cambiarla se cierra la anterior".
    const p = planTariffUpdates([obs("Arequipa", 16.5)], [cur("Arequipa", 16.5)], "2026-07-28");
    expect(p.insert).toHaveLength(0);
    expect(p.close).toHaveLength(0);
    expect(p.remove).toHaveLength(0);
  });

  it("cierra la anterior y abre una nueva cuando el precio sube", () => {
    const p = planTariffUpdates([obs("Arequipa", 18.5)], [cur("Arequipa", 16.5)], "2026-07-28");
    expect(p.close).toEqual([{ id: "Arequipa-primer_intento", effectiveTo: "2026-07-27" }]);
    expect(p.insert[0]?.amount).toBe(18.5);
    // El histórico no se mueve: la anterior sigue existiendo, solo acotada.
    expect(p.remove).toHaveLength(0);
  });

  it("borra en vez de cerrar la que empezaría después de su propio cierre", () => {
    // Una tarifa registrada hoy y corregida hoy mismo: cerrarla ayer daría un
    // intervalo imposible y la volvería invisible.
    const p = planTariffUpdates([obs("Arequipa", 18.5)], [cur("Arequipa", 16.5, "2026-07-28")], "2026-07-28");
    expect(p.remove).toEqual(["Arequipa-primer_intento"]);
    expect(p.close).toHaveLength(0);
  });

  it("trata entrega y devolución como tarifas independientes", () => {
    const p = planTariffUpdates(
      [obs("Puno", 18.5), obs("Puno", 10.5, "devolucion")],
      [cur("Puno", 18.5)],
      "2026-07-28",
    );
    // La entrega no cambió; la devolución no existía.
    expect(p.insert).toHaveLength(1);
    expect(p.insert[0]?.concept).toBe("devolucion");
  });

  it("compara distritos sin que las mayúsculas cuenten", () => {
    // Los pedidos traen "URUBAMBA" y "Urubamba" indistintamente.
    const p = planTariffUpdates([obs("URUBAMBA", 21.5)], [cur("Urubamba", 21.5)], "2026-07-28");
    expect(p.insert).toHaveLength(0);
  });

  it("ignora importes imposibles en vez de escribirlos", () => {
    const p = planTariffUpdates(
      [obs("Lima", Number.NaN), obs("Lima", -5), obs("Lima", 12)],
      [],
      "2026-07-28",
    );
    expect(p.insert).toHaveLength(1);
    expect(p.insert[0]?.amount).toBe(12);
  });

  it("no toca un distrito que ya tiene tarifa manual", () => {
    // El cron no puede pisar lo que alguien averiguó y cargó a mano. Y no basta
    // con no borrarla: al resolver el costo se desempata por `effective_from`
    // más reciente, así que una fila automática de hoy le ganaría a la manual
    // de ayer sin haberla tocado.
    const manual = cur("Miraflores", 8.5, "2026-07-20");
    const p = planTariffUpdates([obs("Miraflores", 16.5)], [], "2026-07-28", [manual]);
    expect(p.insert).toHaveLength(0);
    expect(p.close).toHaveLength(0);
    expect(p.remove).toHaveLength(0);
    expect(p.skippedManual).toBe(1);
  });

  it("el veto manual es por concepto, no por distrito entero", () => {
    // Que alguien sepa cuánto cuesta entregar en Miraflores no significa que
    // sepa cuánto cuesta devolver desde ahí.
    const manual = cur("Miraflores", 8.5, "2026-07-20");
    const p = planTariffUpdates(
      [obs("Miraflores", 16.5), obs("Miraflores", 10.5, "devolucion")],
      [],
      "2026-07-28",
      [manual],
    );
    expect(p.insert).toHaveLength(1);
    expect(p.insert[0]?.concept).toBe("devolucion");
    expect(p.skippedManual).toBe(1);
  });

  it("el veto manual también ignora los acentos", () => {
    // Los pedidos traen "Ancón" y los reportes "ANCON": si la comparación fuera
    // literal el cron duplicaría la tarifa que ya se cargó a mano.
    const p = planTariffUpdates([obs("ANCON", 16.5)], [], "2026-07-28", [cur("Ancón", 12)]);
    expect(p.insert).toHaveLength(0);
    expect(p.skippedManual).toBe(1);
  });

  it("no confunde una tarifa manual sin distrito con una del cron", () => {
    // Las tarifas generales (sin ámbito) no tienen distrito y no deben casar
    // con nada: si casaran, el cron creería que ya cotizó ese distrito.
    const sinDistrito: ExistingTariff = {
      id: "general",
      concept: "primer_intento",
      district: null,
      amount: 8.5,
      effective_from: "2026-07-01",
    };
    const p = planTariffUpdates([obs("Arequipa", 16.5)], [sinDistrito], "2026-07-28");
    expect(p.insert).toHaveLength(1);
    expect(p.close).toHaveLength(0);
  });
});

describe("syncAliclikTariffs: la pasada no se pierde por una racha de 5xx", () => {
  const probe = (district: string) => ({
    district,
    lat: -6.7813,
    lng: -79.842,
    warehouseId: 133,
    pending: 5,
  });

  /** fetch guionizado por número de llamada. */
  const stub = (status: (call: number) => number) => {
    let calls = 0;
    const impl = (async () => {
      const s = status(++calls);
      return new Response(JSON.stringify({ message: "Internal server error" }), {
        status: s,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { impl, count: () => calls };
  };

  // Nunca se llega a tocar la base: sin ninguna cotización buena, `syncAliclikTariffs`
  // sale antes de cargar las tarifas vigentes. Por eso el admin puede ser un hueco.
  const noAdmin = null as unknown as Parameters<typeof syncAliclikTariffs>[4];

  it("da una segunda vuelta a los distritos que fallaron con 5xx", async () => {
    const { impl, count } = stub(() => 500);
    const res = await syncAliclikTariffs(
      "org",
      [probe("Chiclayo"), probe("Trujillo")],
      {
        apiToken: "t",
        baseUrl: "https://api.aliclik-test.local",
        fetchImpl: impl,
        egress: "direct",
        retryBaseMs: 0,
      },
      "2026-07-29",
      noAdmin,
      0, // sin pausa: acá se mide el reintento, no el ritmo
    );
    // 2 distritos × 3 intentos del cliente HTTP × 2 vueltas.
    expect(count()).toBe(12);
    expect(res.quoted).toBe(0);
    expect(res.failed).toBe(2);
  });

  it("cuenta como fallido un 4xx, pero NO le da segunda vuelta", async () => {
    // Un dato malo no mejora repitiéndolo: se cuenta y se deja en paz.
    const { impl, count } = stub(() => 400);
    const res = await syncAliclikTariffs(
      "org",
      [probe("Chiclayo")],
      {
        apiToken: "t",
        baseUrl: "https://api.aliclik-test.local",
        fetchImpl: impl,
        egress: "direct",
        retryBaseMs: 0,
      },
      "2026-07-29",
      noAdmin,
      0, // sin pausa: acá se mide el reintento, no el ritmo
    );
    expect(count()).toBe(1);
    expect(res.failed).toBe(1);
  });
});

describe("pickTopWarehouse", () => {
  it("elige el almacén con más SKUs, no uno cualquiera", () => {
    // El caso real: 65 almacenes en el catálogo, uno solo despacha de verdad.
    expect(pickTopWarehouse(new Map([[183, 85], [133, 724], [15, 2]]))).toBe(133);
  });

  it("a igualdad elige el id más bajo, para no cambiar de un día para otro", () => {
    expect(pickTopWarehouse(new Map([[200, 4], [100, 4]]))).toBe(100);
  });

  it("sin nada que contar no inventa un almacén", () => {
    expect(pickTopWarehouse(new Map())).toBeUndefined();
  });
});

describe("syncAliclikTariffs: las cotizaciones van espaciadas", () => {
  // POR QUÉ. Las 60 cotizaciones salían pegadas y eso tumbaba la API de Aliclik
  // un cuarto de hora, todos los días, a la hora exacta de este cron. La sonda
  // 24/7 lo dejó ver: 3/3 y ~1 s a las 11:25; 0/3 y ~33 s a las 11:30, 11:35 y
  // 11:40; 3/3 otra vez a las 11:46. Y ya había pasado antes a las 09:30, que era
  // la hora vieja del cron: los fallos se mudaron con él.
  const probe = (district: string) => ({
    district,
    lat: -6.7813,
    lng: -79.842,
    warehouseId: 133,
    pending: 5,
  });
  const noAdmin = null as unknown as Parameters<typeof syncAliclikTariffs>[4];

  /** fetch que anota CUÁNDO se le llamó. Sin cobertura: así la pasada no toca la base. */
  const timedStub = (status = 200) => {
    const at: number[] = [];
    const impl = (async () => {
      at.push(Date.now());
      return new Response(JSON.stringify({ couriers: [] }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { impl, at };
  };

  const run = (probes: ReturnType<typeof probe>[], impl: typeof fetch, pauseMs: number) =>
    syncAliclikTariffs(
      "org",
      probes,
      { apiToken: "t", baseUrl: "https://api.aliclik-test.local", fetchImpl: impl, egress: "direct", retryBaseMs: 0 },
      "2026-07-29",
      noAdmin,
      pauseMs,
    );

  it("espera entre una cotización y la siguiente", async () => {
    const { impl, at } = timedStub();
    const started = Date.now();
    await run([probe("A"), probe("B"), probe("C")], impl, 40);

    expect(at).toHaveLength(3);
    // La PRIMERA sale enseguida: esperar sin nada delante solo alarga la pasada.
    expect(at[0]! - started).toBeLessThan(30);
    // Y entre cada par hay pausa.
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(30);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(30);
  });

  it("la segunda vuelta tampoco va en ráfaga", async () => {
    // Si la primera pasada cayó por saturación, rematarla a ritmo de ráfaga es
    // exactamente lo que no hay que hacer.
    const { impl, at } = timedStub(500);
    await run([probe("A"), probe("B")], impl, 40);

    // 2 distritos × 3 intentos del cliente × 2 vueltas.
    expect(at).toHaveLength(12);
    // Entre el último intento del distrito A y el primero del B, en CADA vuelta.
    expect(at[3]! - at[2]!).toBeGreaterThanOrEqual(30); // 1ª vuelta: A→B
    expect(at[9]! - at[8]!).toBeGreaterThanOrEqual(30); // 2ª vuelta: A→B
  });

  it("la pausa POR DEFECTO —la que usa el cron— es real", async () => {
    // Lo que casi se me escapa: todas las pruebas de arriba inyectan su propia
    // pausa, así que dejar el valor por defecto en 0 las mantendría verdes
    // mientras producción vuelve a la ráfaga que tumbaba la API. Se fija acá.
    expect(QUOTE_PAUSE_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("y el cron no la pisa: usa el valor por defecto", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "app/api/cron/aliclik-tariffs/route.ts"), "utf8");
    const call = source.slice(source.indexOf("syncAliclikTariffs("));
    const args = call.slice(0, call.indexOf(");"));
    // orgId, probes, opts, today, admin — y nada más.
    expect(args).toContain("admin,");
    expect(args).not.toMatch(/admin,\s*\d/);
  });

  it("con pausa 0 no espera nada, para que las pruebas no duerman", async () => {
    const { impl, at } = timedStub();
    await run([probe("A"), probe("B"), probe("C")], impl, 0);
    expect(at).toHaveLength(3);
    expect(at[2]! - at[0]!).toBeLessThan(30);
  });
});
