import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  GOLDEN_MINUTES,
  countLeadUrgency,
  goldenBreakdown,
  leadUrgency,
  tallyGolden,
} from "@/lib/lead-urgency";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("leadUrgency: tramos", () => {
  it("los cortes están donde se midió el acantilado", () => {
    expect(leadUrgency(minAgo(0), NOW)!.tier).toBe("dorada");
    expect(leadUrgency(minAgo(59), NOW)!.tier).toBe("dorada");
    // Justo en la hora ya NO es dorada: el tramo medido es "< 1 h".
    expect(leadUrgency(minAgo(60), NOW)!.tier).toBe("tibia");
    expect(leadUrgency(minAgo(6 * 60 - 1), NOW)!.tier).toBe("tibia");
    expect(leadUrgency(minAgo(6 * 60), NOW)!.tier).toBe("enfriando");
    expect(leadUrgency(minAgo(24 * 60 - 1), NOW)!.tier).toBe("enfriando");
    expect(leadUrgency(minAgo(24 * 60), NOW)!.tier).toBe("fria");
  });

  it("GOLDEN_MINUTES es lo que decide el tramo dorado, no un número suelto", () => {
    expect(leadUrgency(minAgo(GOLDEN_MINUTES - 1), NOW)!.tier).toBe("dorada");
    expect(leadUrgency(minAgo(GOLDEN_MINUTES), NOW)!.tier).not.toBe("dorada");
  });
});

describe("leadUrgency: el contador va hacia abajo", () => {
  // Un contador ascendente ("hace 17 min") informa; uno descendente ("quedan 43")
  // empuja. Toda la razón de ser de la columna es la segunda.
  it("cuenta lo que QUEDA de hora dorada, no lo transcurrido", () => {
    expect(leadUrgency(minAgo(17), NOW)!.minutesLeft).toBe(43);
    expect(leadUrgency(minAgo(50), NOW)!.minutesLeft).toBe(10);
    expect(leadUrgency(minAgo(17), NOW)!.label).toBe("43 min");
  });

  it("nunca llega a cero: mientras esté dentro, queda al menos un minuto", () => {
    // Con 59,9 min el redondeo natural daría 0, y "0 min" se lee como vencido
    // justo en el instante en que todavía se puede llamar.
    const casi = leadUrgency(new Date(NOW - 59.9 * 60_000).toISOString(), NOW)!;
    expect(casi.tier).toBe("dorada");
    expect(casi.minutesLeft).toBe(1);
    expect(casi.label).toBe("1 min");
  });

  it("fuera de la hora dorada no hay cuenta regresiva que dar", () => {
    expect(leadUrgency(minAgo(90), NOW)!.minutesLeft).toBeNull();
    expect(leadUrgency(minAgo(5000), NOW)!.minutesLeft).toBeNull();
  });
});

describe("leadUrgency: etiquetas", () => {
  it("sube de unidad para caber en la columna", () => {
    expect(leadUrgency(minAgo(30), NOW)!.label).toBe("30 min");
    expect(leadUrgency(minAgo(2 * 60), NOW)!.label).toBe("2 h");
    expect(leadUrgency(minAgo(9 * 60), NOW)!.label).toBe("9 h");
    expect(leadUrgency(minAgo(5 * 24 * 60), NOW)!.label).toBe("5 d");
    expect(leadUrgency(minAgo(67 * 24 * 60), NOW)!.label).toBe("67 d");
  });
});

describe("leadUrgency: datos que faltan o vienen rotos", () => {
  it("sin fecha no se afirma urgencia", () => {
    expect(leadUrgency(null, NOW)).toBeNull();
    expect(leadUrgency(undefined, NOW)).toBeNull();
    expect(leadUrgency("", NOW)).toBeNull();
    expect(leadUrgency("no-es-fecha", NOW)).toBeNull();
  });

  it("una fecha del futuro cuenta como recién llegado, no como error", () => {
    const delFuturo = leadUrgency(new Date(NOW + 10 * 60_000).toISOString(), NOW)!;
    expect(delFuturo.tier).toBe("dorada");
    expect(delFuturo.ageMinutes).toBe(0);
    expect(delFuturo.minutesLeft).toBe(GOLDEN_MINUTES);
  });
});

describe("tallyGolden", () => {
  const seg = (s: string) => () => s;
  const cero = { total: 0, carrito: 0, interes: 0, converso: 0, frio: 0 };

  // El total tiene que ser el de la hora ENTERA, no el de los segmentos caros:
  // es el mismo número que muestra el chip «Hora dorada», y si difirieran la
  // barra enseñaría dos cifras contradictorias (pasó: decía 5 y 8).
  it("cuenta los cuatro segmentos", () => {
    const leads = [
      { id: "a", first_seen_at: minAgo(10) },
      { id: "b", first_seen_at: minAgo(20) },
    ];
    expect(tallyGolden(leads, seg("carrito"), NOW)).toEqual({ ...cero, total: 2, carrito: 2 });
    expect(tallyGolden(leads, seg("interes"), NOW)).toEqual({ ...cero, total: 2, interes: 2 });
    // Conversó y frío NO se esconden: dentro de la primera hora cierran 16,7% y
    // 11,3% en Kenku, por encima de un interés de 6-24 h (12,9%).
    expect(tallyGolden(leads, seg("converso"), NOW)).toEqual({ ...cero, total: 2, converso: 2 });
    expect(tallyGolden(leads, seg("frio"), NOW)).toEqual({ ...cero, total: 2, frio: 2 });
  });

  it("el total siempre es la suma del desglose", () => {
    const leads = [
      { id: "c1", first_seen_at: minAgo(5) },
      { id: "i1", first_seen_at: minAgo(6) },
      { id: "i2", first_seen_at: minAgo(7) },
      { id: "v1", first_seen_at: minAgo(8) },
      { id: "f1", first_seen_at: minAgo(9) },
    ];
    const bySeg = (l: { id: string }) =>
      ({ c: "carrito", i: "interes", v: "converso", f: "frio" })[l.id[0]!]!;
    const t = tallyGolden(leads, bySeg, NOW);
    expect(t).toEqual({ total: 5, carrito: 1, interes: 2, converso: 1, frio: 1 });
    expect(t.carrito + t.interes + t.converso + t.frio).toBe(t.total);
  });

  it("solo cuenta los que están DENTRO de la hora", () => {
    const leads = [
      { id: "dentro", first_seen_at: minAgo(5) },
      { id: "fuera", first_seen_at: minAgo(300) },
      { id: "viejo", first_seen_at: minAgo(60 * 24 * 3) },
      { id: "sin-fecha", first_seen_at: null },
    ];
    expect(tallyGolden(leads, seg("carrito"), NOW)).toEqual({ ...cero, total: 1, carrito: 1 });
  });

  it("un segmento desconocido suma al total pero no al desglose", () => {
    // Si apareciera un segmento nuevo, el aviso seguiría contándolo (existe y
    // está en la hora) sin inventarle un balde. Perder la fila del total sería
    // peor: volvería el desajuste con el chip.
    const t = tallyGolden([{ first_seen_at: minAgo(5) }], seg("otro"), NOW);
    expect(t.total).toBe(1);
    expect(t.carrito + t.interes + t.converso + t.frio).toBe(0);
  });

  it("una cola vacía da cero, no revienta", () => {
    expect(tallyGolden([], seg("carrito"), NOW)).toEqual(cero);
  });
});

describe("goldenBreakdown", () => {
  it("omite los ceros y respeta el orden de prioridad", () => {
    expect(goldenBreakdown({ total: 8, carrito: 0, interes: 5, converso: 2, frio: 1 })).toEqual([
      { label: "de interés", count: 5 },
      { label: "conversó", count: 2 },
      { label: "frío", count: 1 },
    ]);
  });

  it("lo que se pinta siempre suma el total", () => {
    const t = { total: 8, carrito: 0, interes: 5, converso: 2, frio: 1 };
    expect(goldenBreakdown(t).reduce((a, b) => a + b.count, 0)).toBe(t.total);
  });

  it("carrito va primero cuando lo hay", () => {
    expect(goldenBreakdown({ total: 4, carrito: 3, interes: 1, converso: 0, frio: 0 })).toEqual([
      { label: "con carrito", count: 3 },
      { label: "de interés", count: 1 },
    ]);
  });
});

describe("countLeadUrgency", () => {
  it("reparte la cola en los cuatro tramos", () => {
    const leads = [
      { first_seen_at: minAgo(5) },
      { first_seen_at: minAgo(40) },
      { first_seen_at: minAgo(120) },
      { first_seen_at: minAgo(10 * 60) },
      { first_seen_at: minAgo(3 * 24 * 60) },
      { first_seen_at: minAgo(30 * 24 * 60) },
    ];
    expect(countLeadUrgency(leads, NOW)).toEqual({
      dorada: 2,
      tibia: 1,
      enfriando: 1,
      fria: 2,
      sin_dato: 0,
    });
  });

  // "Todos" del chip tiene que cuadrar con la suma de sus opciones. Sin un balde
  // para los que no tienen fecha, los números no sumarían y el filtro mentiría.
  it("los que no tienen fecha se cuentan aparte, no se pierden", () => {
    const leads = [{ first_seen_at: minAgo(5) }, { first_seen_at: null }, { first_seen_at: "roto" }];
    const c = countLeadUrgency(leads, NOW);
    expect(c.sin_dato).toBe(2);
    expect(c.dorada + c.tibia + c.enfriando + c.fria + c.sin_dato).toBe(leads.length);
  });
});

// La urgencia puede estar perfectamente calculada y no pintarse: es exactamente
// lo que pasaba antes, con `leadPriorityScore` ordenando por la hora dorada
// mientras la fila mostraba la ventana de WhatsApp. Estas guardas leen el fuente
// para probar que el cálculo LLEGA a la pantalla.
describe("la fila usa la urgencia, no la ventana de 24h", () => {
  const src = readFileSync(new URL("../components/leads.tsx", import.meta.url), "utf8");

  it("el acento lateral lo pinta la urgencia", () => {
    expect(src).toContain("inset 3px 0 0 ${ud.accent}");
    // La ventana ya no manda el acento: si volviera, un lead de 12 minutos y uno
    // de 67 días se pintarían otra vez del mismo verde.
    expect(src).not.toContain("inset 3px 0 0 ${wd.accent}");
  });

  it("la columna muestra la edad", () => {
    expect(src).toContain("leadUrgency(lead.first_seen_at, now)");
    expect(src).toContain("urgency?.label");
    expect(src).toContain(">\n                Edad\n              </span>");
  });

  it("la ventana de 24h solo se nombra cuando limita algo", () => {
    expect(src).toContain('state === "cerrada" ? "sin ventana"');
  });

  it("el aviso de hora dorada se pinta con el conteo real", () => {
    expect(src).toContain('tallyGolden(facets.except("seg", "edad"), leadSegment, now)');
    expect(src).toContain("en hora dorada");
    // Y se puede filtrar por él: sin esto el aviso informa pero no lleva a
    // ninguna parte.
    expect(src).toContain("edad: matchEdad");
    expect(src).toContain('setEdadFilter("dorada")');
  });

  // El fallo que originó esto: el aviso decía 5 (solo carrito e interés) y su
  // botón decía 8 (la hora entera, desde `edadCounts`). Dos cifras que no cuadran
  // en la misma barra. Las dos tienen que salir del MISMO conteo.
  it("el número del aviso y el de su botón salen del mismo conteo", () => {
    expect(src).toContain("{goldenTally.total} {goldenTally.total === 1 ? \"lead\" : \"leads\"}");
    expect(src).toContain("`Ver estos ${goldenTally.total}`");
    // Y en particular el botón NO puede volver a leer el contador del chip, que
    // se calcula sobre otra base faceteada.
    expect(src).not.toContain("Ver la última hora (${edadCounts.dorada})");
  });

  // El aviso cuenta la hora entera SIN mirar el chip de segmento (por eso su base
  // es `except("seg","edad")`). Si al filtrar quedara un segmento activo, la lista
  // mostraría menos filas que el número del botón — el mismo desajuste otra vez,
  // solo que un clic más tarde.
  it("al filtrar por la hora dorada se limpia el segmento", () => {
    const boton = src.slice(src.indexOf("Ver estos ${goldenTally.total}") - 900);
    expect(boton).toContain('setEdadFilter("dorada");');
    expect(boton).toContain("setSegFilter(null);");
  });

  // El chip vive en su propio eje. Si alguien lo metiera dentro de "Ventana"
  // —que es la petición natural, y lo que se pidió— el filtro mediría el reloj
  // equivocado: de los 7 leads con mensaje entrante hace menos de una hora, solo
  // 4 tenían menos de una hora de vida.
  it("la edad es un eje propio, separado de la ventana de 24h", () => {
    expect(src).toContain('label="Edad"');
    expect(src).toContain('label="Ventana"');
    // El predicado de edad mira `first_seen_at`, no el último entrante.
    expect(src).toContain('leadUrgency(l.first_seen_at, now)?.tier === edadFilter');
    // Y la barra pone Edad antes que Ventana: cuál mirar primero se enseña con
    // el orden.
    expect(src.indexOf('label="Edad"')).toBeLessThan(src.indexOf('label="Ventana"'));
  });

  it("los contadores del chip salen de su propia base faceteada", () => {
    expect(src).toContain('const edadBase = facets.except("edad");');
    expect(src).toContain("countLeadUrgency(edadBase, now)");
  });
});
