import { describe, expect, it } from "vitest";
import {
  pickTopWarehouse,
  planTariffUpdates,
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
      { apiToken: "t", baseUrl: "https://api.aliclik-test.local", fetchImpl: impl, egress: "direct" },
      "2026-07-29",
      noAdmin,
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
      { apiToken: "t", baseUrl: "https://api.aliclik-test.local", fetchImpl: impl, egress: "direct" },
      "2026-07-29",
      noAdmin,
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
