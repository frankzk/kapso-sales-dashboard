import { describe, it, expect } from "vitest";
import {
  leadPriorityScore,
  scoringProfileFor,
  sortLeadsByPriority,
  weightForAge,
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

  // El desgaste es "2% por DÍA", y se cuenta por días enteros. En continuo, una
  // hora movía el puntaje un 0,08% —ruido— pero ese ruido desempataba dentro de
  // un tramo y lo hacía al revés del vencimiento. Si esto volviera al continuo,
  // el desempate por vencimiento dejaría de aplicarse sin que nada más falle.
  it("la frescura se cuenta por días enteros, no en continuo", () => {
    const aLasDos = leadPriorityScore(
      { cart_item_count: 1, first_seen_at: daysAgo(0), last_interaction_at: new Date(NOW - 2 * 3_600_000).toISOString() },
      KENKU,
      NOW,
    );
    const aLasVeinte = leadPriorityScore(
      { cart_item_count: 1, first_seen_at: daysAgo(0), last_interaction_at: new Date(NOW - 20 * 3_600_000).toISOString() },
      KENKU,
      NOW,
    );
    // Mismo día ⇒ mismo factor. Idénticos, no "parecidos".
    expect(aLasVeinte).toBe(aLasDos);
    // Y cruzar el día sí baja: el castigo de la cola larga sigue existiendo.
    const alDiaSiguiente = leadPriorityScore(
      { cart_item_count: 1, first_seen_at: daysAgo(0), last_interaction_at: daysAgo(1) },
      KENKU,
      NOW,
    );
    expect(alDiaSiguiente).toBeLessThan(aLasDos);
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

  // `interes` TAMBIÉN decae (remedido 2026-09 sobre el balde entero y las dos
  // tiendas: Kenku 27,6 → 14,5 → 12,9 → 4,7; Aurela 17,0 → 6,9 → 6,0 → 4,4).
  // Antes este test afirmaba lo contrario apoyado en una medición de UNA fuente
  // de UNA tienda.
  it("interés también pierde peso al pasar la primera hora", () => {
    const fresco = leadPriorityScore({ district: "Ate", first_seen_at: hoursAgo(0.2) }, KENKU, NOW);
    const deHoras = leadPriorityScore({ district: "Ate", first_seen_at: hoursAgo(12) }, KENKU, NOW);
    expect(fresco).toBeGreaterThan(deHoras);
    expect(fresco).toBeCloseTo(16, 0); // tramo <1h de Kenku
    expect(deHoras).toBeCloseTo(8, 0); // tramo 6-24h
  });

  // CONVERSÓ Y FRÍO TAMBIÉN DECAEN (2026-09-12). Antes este test afirmaba lo
  // contrario, y no porque se hubiera medido que no: es que no se había medido.
  // Sin tramos el peso es plano, no hay bono de ticket y el desgaste diario corre
  // sobre `last_interaction_at` —que no es la edad del lead—, así que los 1.245
  // fríos «sin llamar» puntuaban EXACTAMENTE IGUAL y el orden lo terminaba
  // decidiendo el desempate por vencimiento: el más viejo primero, uno de 39 días
  // por delante del de esa mañana. Medido, es al revés.
  it("conversó pierde peso al pasar la primera hora, en las DOS tiendas", () => {
    const fresco = leadPriorityScore({ inbound_count: 3, first_seen_at: hoursAgo(0.2) }, KENKU, NOW);
    const deHoras = leadPriorityScore({ inbound_count: 3, first_seen_at: hoursAgo(12) }, KENKU, NOW);
    expect(fresco).toBeGreaterThan(deHoras);
    expect(fresco).toBeCloseTo(4, 1); // tramo <1h de Kenku
    expect(deHoras).toBeCloseTo(1.5, 1); // tramo 6-24h
    // Aurela con su propia escala: 3,45% en la primera hora contra 1,80% después.
    // La caída es del mismo signo en las dos, que es lo que sostiene la regla.
    const frescoA = leadPriorityScore({ inbound_count: 3, first_seen_at: hoursAgo(0.2) }, AURELA, NOW);
    const deHorasA = leadPriorityScore({ inbound_count: 3, first_seen_at: hoursAgo(3) }, AURELA, NOW);
    expect(frescoA).toBeGreaterThan(deHorasA * 1.5);
  });

  it("frío también, en la tienda donde hay muestra", () => {
    const fresco = leadPriorityScore({ first_seen_at: hoursAgo(0.2) }, KENKU, NOW);
    const deHoras = leadPriorityScore({ first_seen_at: hoursAgo(12) }, KENKU, NOW);
    expect(fresco).toBeGreaterThan(deHoras);
    expect(fresco).toBeCloseTo(1, 1);
    expect(deHoras).toBeCloseTo(0.45, 2);
  });

  // El control de que no se pasó de rosca, del lado de abajo de la escala: un
  // frío recién llegado (2,49%) SÍ pasa a un conversó de más de un día (1,85%) y
  // NO pasa a uno de 1-6h (2,94%). Es la comparación que obligó a bajar el último
  // tramo de conversó a 0,9 en vez de dejarlo en 1.
  it("un frío recién llegado pasa a un conversó de días, pero no a uno de horas", () => {
    const frioFresco = leadPriorityScore({ first_seen_at: hoursAgo(0.2) }, KENKU, NOW);
    const conversoViejo = leadPriorityScore(
      { inbound_count: 3, first_seen_at: hoursAgo(72), last_interaction_at: hoursAgo(0.2) },
      KENKU,
      NOW,
    );
    const conversoDeHoras = leadPriorityScore(
      { inbound_count: 3, first_seen_at: hoursAgo(3) },
      KENKU,
      NOW,
    );
    expect(frioFresco).toBeGreaterThan(conversoViejo);
    expect(frioFresco).toBeLessThan(conversoDeHoras);
  });

  // LOS TRAMOS QUE LA MUESTRA NO SEPARA COMPARTEN PESO, y eso es una decisión,
  // no un descuido: partirlos sería inventar la diferencia. Frío de Kenku 6-24h
  // contra +1d: 1,05% y 1,15%. Conversó 1-6h contra 6-24h: 2,94% y 2,65%.
  it("los tramos indistinguibles pesan igual, no se parten por si acaso", () => {
    const mismaFrescura = { last_interaction_at: hoursAgo(1) };
    const frio12 = leadPriorityScore({ ...mismaFrescura, first_seen_at: hoursAgo(12) }, KENKU, NOW);
    const frio48 = leadPriorityScore({ ...mismaFrescura, first_seen_at: hoursAgo(48) }, KENKU, NOW);
    expect(frio12).toBe(frio48);

    const conv3 = leadPriorityScore(
      { ...mismaFrescura, inbound_count: 3, first_seen_at: hoursAgo(3) },
      KENKU,
      NOW,
    );
    const conv12 = leadPriorityScore(
      { ...mismaFrescura, inbound_count: 3, first_seen_at: hoursAgo(12) },
      KENKU,
      NOW,
    );
    expect(conv3).toBe(conv12);
  });

  // En Aurela el conversó se cae a plomo pasado el día: 1,80% entre 1 y 24 horas
  // contra 0,35% después. Es la caída más fuerte de las cuatro tablas y la que
  // hace que ahí valga más un conversó de la mañana que veinte de la semana.
  it("en Aurela el conversó de más de un día se desploma", () => {
    const mismaFrescura = { inbound_count: 3, last_interaction_at: hoursAgo(1) };
    const deHoras = leadPriorityScore({ ...mismaFrescura, first_seen_at: hoursAgo(3) }, AURELA, NOW);
    const deDias = leadPriorityScore({ ...mismaFrescura, first_seen_at: hoursAgo(48) }, AURELA, NOW);
    expect(deDias).toBeLessThan(deHoras / 4);
  });

  // DENTRO DE «+1 DÍA» EMPATAN, y es lo correcto: medido sobre 90 días, un
  // conversó de 1-3 días cierra 2,11% y uno de 3-7 días 2,12%; un frío 1,15% y
  // 0,58%. El salto de «+7 días» (15% y 6,9%) son 33 y 29 llamadas de leads que
  // alguien eligió a mano — selección, no señal. Partir ahí pondría lo más muerto
  // de la cola en cabeza.
  it("dos leads viejos del mismo balde empatan: la muestra no los separa", () => {
    const dosDias = leadPriorityScore(
      { first_seen_at: hoursAgo(48), last_interaction_at: hoursAgo(1) },
      KENKU,
      NOW,
    );
    const ochoDias = leadPriorityScore(
      { first_seen_at: hoursAgo(192), last_interaction_at: hoursAgo(1) },
      KENKU,
      NOW,
    );
    expect(dosDias).toBe(ochoDias);
  });

  // Y del lado de arriba: el conversó más fresco NO puede subir por encima del
  // `interes` de más de un día, que lo gana medido (Aurela 6,37% contra 3,45%).
  // Es lo que obliga a normalizar por el MEJOR tramo y no por el promedio del
  // balde: contra el promedio, ese conversó salía por encima.
  it("el conversó más fresco no se sube por encima de un interés de días", () => {
    const conversoFresco = leadPriorityScore(
      { inbound_count: 3, first_seen_at: hoursAgo(0.2) },
      AURELA,
      NOW,
    );
    const interesViejo = leadPriorityScore(
      { district: "Ate", first_seen_at: hoursAgo(72), last_interaction_at: hoursAgo(0.2) },
      AURELA,
      NOW,
    );
    expect(conversoFresco).toBeLessThan(interesViejo);
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

  // Antes esto exigía el DOBLE, y esa ventaja era un artefacto: `interes` tenía
  // un peso plano que le aplicaba a un lead de diez minutos la tasa media de un
  // balde donde la mitad tiene días. Medido a igualdad de edad, la ventaja del
  // carrito en la primera hora es de ~1,4× (39,9% contra 27,6% en Kenku), no de
  // 2×. Sigue ganando —que es lo que sostiene la cascada— pero por lo que mide.
  it("pero un carrito FRESCO sigue por encima de un interés igual de fresco", () => {
    for (const profile of [AURELA, KENKU]) {
      const carritoFresco = leadPriorityScore(carritoDe(0.2), profile, NOW);
      const interesFresco = leadPriorityScore({ district: "Ate", first_seen_at: hoursAgo(0.2) }, profile, NOW);
      expect(carritoFresco).toBeGreaterThan(interesFresco);
    }
    // Y la ventaja es la medida, no la que daba el peso plano.
    expect(
      leadPriorityScore(carritoDe(0.2), KENKU, NOW) /
        leadPriorityScore({ district: "Ate", first_seen_at: hoursAgo(0.2) }, KENKU, NOW),
    ).toBeCloseTo(1.5, 1);
  });

  // La consecuencia BUSCADA de darle tramos a `interes`, y la razón de haberlo
  // hecho: en Kenku un interés recién llegado cierra 27,6% y un carrito de 6-24h
  // cierra 24,9%. Con el peso plano el carrito viejo ganaba siempre.
  it("en Kenku un interés recién llegado pasa a un carrito de medio día", () => {
    const interesFresco = leadPriorityScore({ district: "Ate", first_seen_at: hoursAgo(0.2) }, KENKU, NOW);
    expect(interesFresco).toBeGreaterThan(leadPriorityScore(carritoDe(12), KENKU, NOW));
  });

  // Y el control de que no se pasó de rosca: en Aurela la misma comparación se
  // mide al revés (interés <1h 17,0% contra carrito 6-24h 19,9%), y los pesos la
  // respetan. Si el método hubiera inflado `interes`, esto fallaría.
  it("en Aurela NO lo pasa, porque ahí se mide al revés", () => {
    const interesFresco = leadPriorityScore({ district: "Ate", first_seen_at: hoursAgo(0.2) }, AURELA, NOW);
    expect(interesFresco).toBeLessThan(leadPriorityScore(carritoDe(12), AURELA, NOW));
  });

  it("una tienda sin tramos medidos usa su peso promedio, no una curva inventada", () => {
    const nueva = scoringProfileFor("Tienda Nueva");
    const recien = leadPriorityScore(carritoDe(0.2), nueva, NOW);
    const viejo = leadPriorityScore({ cart_item_count: 1, first_seen_at: hoursAgo(12) }, nueva, NOW);
    // Los dos alrededor del promedio (17): sin tramos medidos no hay escalón.
    expect(Math.abs(recien - nueva.segment.carrito)).toBeLessThan(0.2);
    expect(Math.abs(viejo - nueva.segment.carrito)).toBeLessThan(0.2);
  });

  it("weightForAge: sin tramos o sin antigüedad cae al respaldo", () => {
    expect(weightForAge(null, 0.5, 14)).toBe(14);
    expect(weightForAge(KENKU.byAge.carrito, null, 14)).toBe(14);
    expect(weightForAge(KENKU.byAge.carrito, Number.NaN, 14)).toBe(14);
    expect(weightForAge(KENKU.byAge.carrito, -5, 14)).toBe(24); // negativo → tramo más fresco
  });

  // Un segmento sin tabla no debe heredar la de otro: si `byAge` se indexara mal
  // (p. ej. cayendo siempre a `carrito`), un frío recién llegado puntuaría 44.
  // El frío de Aurela es hoy el único balde sin tramos, y a propósito: 5 cierres
  // en 1.274 llamadas, con CERO en el tramo de <1h. No hay gradiente que copiar.
  it("weightForAge: un segmento sin tabla usa su peso plano", () => {
    expect(AURELA.byAge.frio).toBeUndefined();
    expect(weightForAge(AURELA.byAge.frio, 0.2, AURELA.segment.frio)).toBe(AURELA.segment.frio);
    expect(leadPriorityScore({ first_seen_at: hoursAgo(0.2) }, AURELA, NOW)).toBe(
      AURELA.segment.frio,
    );
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

  it("empates estables: mismo puntaje y misma edad mantienen siempre el mismo orden", () => {
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

  // Dentro de un tramo el puntaje empata (son escalones planos: un carrito de 7 h
  // y uno de 23 cierran igual). Antes desempataba el resto decimal de `freshness`
  // y lo hacía al revés: en la cola real, cinco carritos de S/99 del mismo tramo
  // salían 12,2 · 13,0 · 14,2 · 15,2 · 15,7 h, con el más cerca de cruzar a
  // "+24 h" en último lugar.
  describe("desempate por vencimiento más próximo", () => {
    const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
    const mismoTramo = (id: string, h: number) => ({
      id,
      cart_item_count: 1,
      cart_value: 99,
      first_seen_at: hoursAgo(h),
      last_interaction_at: hoursAgo(h),
    });

    it("a igual puntaje llama primero al más viejo", () => {
      // Las cinco edades reales de la cola, con su `id` a la contra a propósito:
      // ordenadas por id darían 14,2 · 15,2 · 12,9 · 12,1 · 15,7.
      const rows = [
        mismoTramo("a", 14.2),
        mismoTramo("b", 15.2),
        mismoTramo("c", 12.9),
        mismoTramo("d", 12.1),
        mismoTramo("e", 15.7),
      ];
      expect(sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id)).toEqual([
        "e", // 15,7 h — el más cerca de caer a +24h
        "b", // 15,2
        "a", // 14,2
        "c", // 12,9
        "d", // 12,1
      ]);
    });

    // El desempate mide la EDAD (desde que entró), no cuánto hace que el cliente
    // escribió. Son relojes distintos y en producción divergen mucho: estas cinco
    // filas reales tienen 12-16 h de edad pero 1,6-4,4 h desde la última
    // interacción, y ordenarlas por uno u otro da resultados DISTINTOS. El
    // acantilado está medido sobre la edad, así que es el que manda.
    it("desempata por la edad, no por cuándo escribió el cliente", () => {
      const real = (id: string, edad: number, ultima: number) => ({
        id,
        cart_item_count: 1,
        cart_value: 99,
        first_seen_at: hoursAgo(edad),
        last_interaction_at: hoursAgo(ultima),
      });
      const rows = [
        real("junior", 12.158, 1.638),
        real("t2w", 12.97, 2.692),
        real("l342", 14.226, 4.42),
        real("l157", 15.233, 4.415),
        real("l728", 15.743, 4.415),
      ];
      // Por edad: 15,7 · 15,2 · 14,2 · 13,0 · 12,2
      expect(sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id)).toEqual([
        "l728",
        "l157",
        "l342",
        "t2w",
        "junior",
      ]);
      // Por última interacción habría salido l342 primero (4,42 h) — es el orden
      // que NO queremos, y el único que separa las dos reglas.
      expect(sortLeadsByPriority(rows, KENKU, NOW)[0]!.id).not.toBe("l342");
    });

    it("no invierte el puntaje: el ticket sigue mandando sobre la edad", () => {
      const caroYNuevo = { ...mismoTramo("caro", 7), cart_value: 300 };
      const baratoYViejo = mismoTramo("barato", 23);
      expect(sortLeadsByPriority([baratoYViejo, caroYNuevo], KENKU, NOW).map((r) => r.id)).toEqual([
        "caro",
        "barato",
      ]);
    });

    it("ni el tramo: un carrito fresco va antes que uno a punto de vencer", () => {
      const fresco = mismoTramo("fresco", 0.2);
      const porVencer = mismoTramo("porVencer", 23.9);
      expect(sortLeadsByPriority([porVencer, fresco], KENKU, NOW).map((r) => r.id)).toEqual([
        "fresco",
        "porVencer",
      ]);
    });

    // Dos leads sin fecha no pueden compararse por vencimiento: caen al `id`,
    // que al menos es determinista. (Uno sin fecha contra uno con fecha nunca
    // llega a empatar: el primero usa el peso plano y el segundo un tramo, y no
    // coinciden en ninguna tienda medida — por eso no se prueba ese caso, que
    // sería inventar una situación que el código no puede alcanzar.)
    it("dos leads sin fecha se ordenan determinísticamente, no al azar", () => {
      const rows = [
        { id: "zzz", cart_item_count: 1 },
        { id: "aaa", cart_item_count: 1 },
      ];
      expect(sortLeadsByPriority(rows, KENKU, NOW).map((r) => r.id)).toEqual(["aaa", "zzz"]);
    });
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
