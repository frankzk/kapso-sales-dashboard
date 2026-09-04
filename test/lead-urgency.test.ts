import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GOLDEN_MINUTES, leadUrgency, tallyGolden } from "@/lib/lead-urgency";

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

  it("cuenta solo lo caro: carrito e interés", () => {
    const leads = [
      { id: "a", first_seen_at: minAgo(10) },
      { id: "b", first_seen_at: minAgo(20) },
    ];
    expect(tallyGolden(leads, seg("carrito"), NOW)).toEqual({ total: 2, carrito: 2, interes: 0 });
    expect(tallyGolden(leads, seg("interes"), NOW)).toEqual({ total: 2, carrito: 0, interes: 2 });
    // Conversó y frío también caen al pasar la hora, pero son 243 leads/día
    // contra 168 de los otros dos: meterlos aquí convertiría el aviso en ruido.
    expect(tallyGolden(leads, seg("converso"), NOW)).toEqual({ total: 0, carrito: 0, interes: 0 });
    expect(tallyGolden(leads, seg("frio"), NOW)).toEqual({ total: 0, carrito: 0, interes: 0 });
  });

  it("solo cuenta los que están DENTRO de la hora", () => {
    const leads = [
      { id: "dentro", first_seen_at: minAgo(5) },
      { id: "fuera", first_seen_at: minAgo(300) },
      { id: "viejo", first_seen_at: minAgo(60 * 24 * 3) },
      { id: "sin-fecha", first_seen_at: null },
    ];
    expect(tallyGolden(leads, seg("carrito"), NOW)).toEqual({ total: 1, carrito: 1, interes: 0 });
  });

  it("separa los dos segmentos", () => {
    const leads = [
      { id: "c1", first_seen_at: minAgo(5) },
      { id: "c2", first_seen_at: minAgo(6) },
      { id: "i1", first_seen_at: minAgo(7) },
    ];
    const bySeg = (l: { id: string }) => (l.id.startsWith("c") ? "carrito" : "interes");
    expect(tallyGolden(leads, bySeg, NOW)).toEqual({ total: 3, carrito: 2, interes: 1 });
  });

  it("una cola vacía da cero, no revienta", () => {
    expect(tallyGolden([], seg("carrito"), NOW)).toEqual({ total: 0, carrito: 0, interes: 0 });
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
    expect(src).toContain("tallyGolden(facets.except(\"seg\", \"golden\"), leadSegment, now)");
    expect(src).toContain("en hora dorada");
    // Y se puede filtrar por él: sin esto el aviso informa pero no lleva a
    // ninguna parte.
    expect(src).toContain("golden: matchGolden");
    expect(src).toContain("setGoldenOnly");
  });
});
