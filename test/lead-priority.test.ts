import { describe, it, expect } from "vitest";
import {
  cartWeightForAge,
  leadPriorityScore,
  scoringProfileFor,
  sortLeadsByPriority,
} from "@/lib/lead-priority";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const AURELA = scoringProfileFor("Aurela");
const KENKU = scoringProfileFor("Kenku Peru");

// Señales mínimas por segmento (misma definición que leadSegment).
const carrito = (over = {}) => ({ id: "c", cart_item_count: 1, last_interaction_at: daysAgo(0), ...over });
const interes = (over = {}) => ({ id: "d", district: "Miraflores", last_interaction_at: daysAgo(0), ...over });
// La otra mitad del MISMO balde: llegó desde la ficha de un producto.
const interesPorLink = (over = {}) => ({
  id: "dp",
  first_inbound_text: "https://kenku.pe/products/x Tengo una consulta",
  last_interaction_at: daysAgo(0),
  ...over,
});
const converso = (over = {}) => ({ id: "v", inbound_count: 3, last_interaction_at: daysAgo(0), ...over });
const frio = (over = {}) => ({ id: "f", last_interaction_at: daysAgo(0), ...over });

describe("scoringProfileFor", () => {
  it("usa los pesos medidos de cada tienda", () => {
    expect(AURELA.segment.carrito).toBe(20);
    expect(AURELA.segment.interes).toBe(5); // en Aurela este balde rinde poco (12,2%)
    expect(KENKU.segment.carrito).toBe(14);
    expect(KENKU.segment.interes).toBe(8); // en Kenku rinde bastante más (19,1%)
  });

  it("cae a un promedio que conserva el orden en una tienda sin medir", () => {
    const w = scoringProfileFor("Tienda Nueva").segment;
    expect(w.carrito).toBeGreaterThan(w.interes);
    expect(w.interes).toBeGreaterThan(w.converso);
    expect(w.converso).toBeGreaterThan(w.frio);
  });

  it("no depende de mayúsculas ni espacios", () => {
    expect(scoringProfileFor("  KENKU PERU ")).toEqual(KENKU);
  });
});

describe("leadPriorityScore", () => {
  it("respeta el orden medido: carrito > interés > conversó > frío", () => {
    const s = (lead: Parameters<typeof leadPriorityScore>[0]) => leadPriorityScore(lead, KENKU, NOW);
    expect(s(carrito())).toBeGreaterThan(s(interes()));
    expect(s(interes())).toBeGreaterThan(s(converso()));
    expect(s(converso())).toBeGreaterThan(s(frio()));
  });

  it("entre dos carritos manda el ticket", () => {
    const barato = leadPriorityScore(carrito({ cart_value: 50 }), KENKU, NOW);
    const caro = leadPriorityScore(carrito({ cart_value: 250 }), KENKU, NOW);
    expect(caro).toBeGreaterThan(barato);
  });

  it("el bono de ticket está topado: un carrito enorme no aplasta la señal", () => {
    const grande = leadPriorityScore(carrito({ cart_value: 100_000 }), KENKU, NOW);
    // El carrito recién llegado usa el tramo <1h (24), no el promedio de la tienda.
    expect(grande).toBeLessThanOrEqual(24 + 10);
  });

  // El desgaste por antigüedad es criterio; los pesos son dato medido. Por eso el
  // reloj degrada dentro de una escala pero nunca invierte el orden de segmentos.
  it("la antigüedad nunca hunde un lead por debajo del piso de frescura", () => {
    const antiquisimo = leadPriorityScore(carrito({ last_interaction_at: daysAgo(3650) }), KENKU, NOW);
    expect(antiquisimo).toBeGreaterThan(0);
    // Tramo +1d de Kenku (9) por el piso de frescura (0,4).
    expect(antiquisimo).toBeCloseTo(9 * 0.4, 5);
  });

  it("castiga la antigüedad", () => {
    const hoy = leadPriorityScore(carrito({ last_interaction_at: daysAgo(0) }), KENKU, NOW);
    const viejo = leadPriorityScore(carrito({ last_interaction_at: daysAgo(10) }), KENKU, NOW);
    expect(viejo).toBeLessThan(hoy);
  });

  // El punto del puntaje: la intención pesa más que el reloj. Hoy la cola ordena
  // al revés y por eso los carritos quedan enterrados entre fríos recientes.
  it("un carrito VIEJO sigue por encima de un frío RECIÉN llegado", () => {
    const carritoViejo = leadPriorityScore(carrito({ last_interaction_at: daysAgo(60) }), KENKU, NOW);
    const frioNuevo = leadPriorityScore(frio({ last_interaction_at: daysAgo(0) }), KENKU, NOW);
    expect(carritoViejo).toBeGreaterThan(frioNuevo);
  });

  it("sin fecha alguna no revienta ni castiga", () => {
    const sinFecha = leadPriorityScore({ cart_item_count: 1 }, KENKU, NOW);
    expect(sinFecha).toBe(KENKU.segment.carrito);
  });

  it("una fecha inválida no rompe el puntaje", () => {
    const roto = leadPriorityScore(carrito({ last_interaction_at: "no-es-fecha" }), KENKU, NOW);
    expect(Number.isFinite(roto)).toBe(true);
  });

  it("los pesos por tienda cambian el resultado: este balde rinde distinto", () => {
    const enAurela = leadPriorityScore(interes(), AURELA, NOW);
    const enKenku = leadPriorityScore(interes(), KENKU, NOW);
    expect(enKenku).toBeGreaterThan(enAurela);
  });
});

// Un carrito es un momento perecedero: medido, cae de 44,3% a 13,8% (Aurela) y de
// 24,1% a 17,0% (Kenku) apenas pasa la primera hora. Con el desgaste diario del
// resto del puntaje eso era invisible.
describe("carrito: el peso decae por HORAS", () => {
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const carritoDe = (h: number) => ({
    id: "c",
    cart_item_count: 1,
    first_seen_at: hoursAgo(h),
    last_interaction_at: hoursAgo(h),
  });

  it("el carrito recién llegado puntúa mucho más que el de unas horas", () => {
    const recien = leadPriorityScore(carritoDe(0.2), KENKU, NOW);
    const pocasHoras = leadPriorityScore(carritoDe(4), KENKU, NOW);
    expect(recien).toBeGreaterThan(pocasHoras);
    expect(recien).toBeCloseTo(24, 0); // tramo <1h de Kenku
  });

  it("baja escalón por escalón según los tramos medidos", () => {
    const puntajes = [0.5, 3, 12, 48].map((h) => leadPriorityScore(carritoDe(h), KENKU, NOW));
    // 24 → 17 → 11 → 9, cada uno estrictamente menor que el anterior
    expect(puntajes[0]!).toBeGreaterThan(puntajes[1]!);
    expect(puntajes[1]!).toBeGreaterThan(puntajes[2]!);
    expect(puntajes[2]!).toBeGreaterThan(puntajes[3]!);
  });

  it("en Aurela la caída de la primera hora es mucho más brusca", () => {
    const aurelaCae = 44 - 14; // 44,3% → 13,8%
    const kenkuCae = 24 - 17; // 24,1% → 17,0%
    const dRecienAurela = leadPriorityScore(carritoDe(0.2), AURELA, NOW);
    const dLuegoAurela = leadPriorityScore(carritoDe(3), AURELA, NOW);
    expect(dRecienAurela - dLuegoAurela).toBeGreaterThan(kenkuCae);
    expect(dRecienAurela - dLuegoAurela).toBeCloseTo(aurelaCae, 0);
  });

  // El resto de los segmentos no se toca: ahí la medición mostró que llamar
  // rápido NO cambia nada dentro del primer día.
  it("distrito, conversó y frío no decaen por horas", () => {
    const fresco = leadPriorityScore({ district: "Ate", first_seen_at: hoursAgo(0.2) }, KENKU, NOW);
    const deHoras = leadPriorityScore({ district: "Ate", first_seen_at: hoursAgo(12) }, KENKU, NOW);
    // Solo el desgaste diario general (~0,1 en 12 h), nada parecido al escalón
    // del carrito, que en el mismo lapso pierde 13 puntos.
    expect(Math.abs(fresco - deHoras)).toBeLessThan(0.2);
  });

  // CONSECUENCIA BUSCADA, no un efecto colateral: en Kenku un carrito de más de
  // un día cierra 9,2% y un distrito 9,2%. Al usar las tasas medidas como peso,
  // quedan empatados — y un distrito fresco puede pasar a un carrito de días.
  // Con el peso plano anterior, el carrito ganaba siempre aunque estuviera muerto.
  it("un carrito viejo queda cerca de un distrito, que es lo que mide", () => {
    const carritoViejo = leadPriorityScore(carritoDe(72), KENKU, NOW);
    const distritoFresco = leadPriorityScore({ district: "Ate", first_seen_at: hoursAgo(1) }, KENKU, NOW);
    expect(Math.abs(carritoViejo - distritoFresco)).toBeLessThan(2);
  });

  it("pero un carrito FRESCO sigue muy por encima de cualquier distrito", () => {
    const carritoFresco = leadPriorityScore(carritoDe(0.2), KENKU, NOW);
    const distritoFresco = leadPriorityScore({ district: "Ate", first_seen_at: hoursAgo(0.2) }, KENKU, NOW);
    expect(carritoFresco).toBeGreaterThan(distritoFresco * 2);
  });

  it("una tienda sin tramos medidos usa su peso promedio, no una curva inventada", () => {
    const nueva = scoringProfileFor("Tienda Nueva");
    const recien = leadPriorityScore(carritoDe(0.2), nueva, NOW);
    const viejo = leadPriorityScore({ cart_item_count: 1, first_seen_at: hoursAgo(12) }, nueva, NOW);
    // Los dos alrededor del promedio (17): sin tramos medidos no hay escalón.
    expect(Math.abs(recien - nueva.segment.carrito)).toBeLessThan(0.2);
    expect(Math.abs(viejo - nueva.segment.carrito)).toBeLessThan(0.2);
  });

  it("cartWeightForAge: sin tramos o sin antigüedad cae al respaldo", () => {
    expect(cartWeightForAge(null, 0.5, 14)).toBe(14);
    expect(cartWeightForAge(KENKU.cartByAge, null, 14)).toBe(14);
    expect(cartWeightForAge(KENKU.cartByAge, Number.NaN, 14)).toBe(14);
    expect(cartWeightForAge(KENKU.cartByAge, -5, 14)).toBe(24); // negativo → tramo más fresco
  });
});

describe("sortLeadsByPriority", () => {
  it("ordena de mayor a menor prioridad", () => {
    // Todos del mismo día: así se prueba el orden ENTRE segmentos, sin que se
    // mezcle el decaimiento horario del carrito (que tiene sus propios tests).
    const rows = [
      { id: "frio", last_interaction_at: daysAgo(0) },
      { id: "carrito", cart_item_count: 1, last_interaction_at: daysAgo(0), first_seen_at: daysAgo(0) },
      { id: "converso", inbound_count: 5, last_interaction_at: daysAgo(0) },
      { id: "distrito", district: "Wanchaq", last_interaction_at: daysAgo(0) },
    ];
    expect(sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id)).toEqual([
      "carrito",
      "distrito",
      "converso",
      "frio",
    ]);
  });

  it("no muta la lista original", () => {
    const rows = [
      { id: "a", last_interaction_at: daysAgo(0) },
      { id: "b", cart_item_count: 1, last_interaction_at: daysAgo(0) },
    ];
    const copia = [...rows];
    sortLeadsByPriority(rows, KENKU, NOW);
    expect(rows).toEqual(copia);
  });

  it("empates estables: mismo puntaje mantiene siempre el mismo orden", () => {
    const rows = [
      { id: "zzz", cart_item_count: 1, last_interaction_at: daysAgo(0) },
      { id: "aaa", cart_item_count: 1, last_interaction_at: daysAgo(0) },
    ];
    expect(sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id)).toEqual(["aaa", "zzz"]);
    // dos pasadas seguidas no pueden dar órdenes distintos
    expect(sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id)).toEqual(
      sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id),
    );
  });
});

describe("distrito y ficha de producto son EL MISMO balde", () => {
  // Se probaron separados y el equipo no trabajaba los de la mitad: con cinco
  // baldes, los del medio no los atendía nadie. Además, separados, las dos
  // tiendas se contradecían en el orden (en Aurela el link cerraba por encima
  // del distrito, en Kenku por debajo), así que no había un orden único que
  // fuera cierto en las dos. Unidos, sí: el orden es idéntico.
  it("puntúan igual, den el distrito o vengan de la ficha", () => {
    for (const profile of [AURELA, KENKU]) {
      expect(leadPriorityScore(interesPorLink(), profile, NOW)).toEqual(
        leadPriorityScore(interes(), profile, NOW),
      );
    }
  });

  it("en las dos tiendas van por encima de conversó y por debajo de carrito", () => {
    for (const profile of [AURELA, KENKU]) {
      const p = leadPriorityScore(interes(), profile, NOW);
      expect(p).toBeGreaterThan(leadPriorityScore(converso(), profile, NOW));
      expect(p).toBeLessThan(leadPriorityScore(carrito(), profile, NOW));
    }
  });

  it("un carrito con link sigue puntuando como carrito", () => {
    // El cascade pone carrito primero; si se invirtiera, un carrito armado
    // perdería su peso —el más alto que hay— por traer un link.
    const conAmbos = carrito({ first_inbound_text: "https://kenku.pe/products/x hola" });
    expect(leadPriorityScore(conAmbos, KENKU, NOW)).toEqual(
      leadPriorityScore(carrito(), KENKU, NOW),
    );
  });
});
