import { describe, it, expect } from "vitest";
import {
  selectFollowUpGuides,
  followUpKey,
  type FollowUpCandidate,
  type SelectFollowUpOpts,
} from "@/lib/aliclik-followup";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const DAY_MS = 86_400_000;

const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

const guide = (over: Partial<FollowUpCandidate> = {}): FollowUpCandidate => ({
  id: "s1",
  external_order_number: "ALC000123456789",
  guide_code: null,
  delivery_status: "en_ruta",
  last_report_at: daysAgo(20),
  created_at: daysAgo(25),
  ...over,
});

const opts = (over: Partial<SelectFollowUpOpts> = {}): SelectFollowUpOpts => ({
  scanned: new Set<string>(),
  limit: 40,
  maxSilenceMs: 60 * DAY_MS,
  now: NOW,
  ...over,
});

describe("selectFollowUpGuides — a quién se persigue", () => {
  it("persigue la guía viva que se cayó de la ventana de fechas", () => {
    const res = selectFollowUpGuides([guide()], opts());
    expect(res.due.map((g) => g.id)).toEqual(["s1"]);
    expect(res.deferred).toBe(0);
  });

  // El caso que motiva el módulo: un retorno tarda más que la ventana, así que
  // la guía deja de entrar en el barrido justo antes de resolverse.
  it("persigue una guía en retorno más vieja que el lookback", () => {
    const enRetorno = guide({ delivery_status: "en_ruta", last_report_at: daysAgo(30) });
    expect(selectFollowUpGuides([enRetorno], opts()).due).toHaveLength(1);
  });

  it.each(["entregado", "transferido"])("no persigue una guía %s", (estado) => {
    expect(selectFollowUpGuides([guide({ delivery_status: estado })], opts()).due).toEqual([]);
  });

  // ── Anuladas que todavía pueden volver ────────────────────────────────────
  // El paquete vuelve DESPUÉS de anularse, así que dejar de mirarlas al cerrar
  // era perderse justo el hecho que abre la recuperación (MOM §11). Antes
  // `anulado` era terminal y estas guías quedaban congeladas: el barrido las
  // soltaba y el Excel dejaba de traerlas poco después.

  it("SÍ persigue una anulada reciente: el retorno llega después del cierre", () => {
    const anulada = guide({ delivery_status: "anulado", last_report_at: daysAgo(8) });
    expect(selectFollowUpGuides([anulada], opts()).due.map((g) => g.id)).toEqual(["s1"]);
  });

  it("deja de perseguir la anulada que lleva más de tres semanas callada", () => {
    const vieja = guide({ delivery_status: "anulado", last_report_at: daysAgo(22) });
    const res = selectFollowUpGuides([vieja], opts());
    expect(res.due).toEqual([]);
    // Se cuenta como abandonada, no desaparece en silencio.
    expect(res.abandoned).toBe(1);
  });

  it("el borde de las tres semanas todavía cuenta como perseguible", () => {
    const justo = guide({ delivery_status: "anulado", last_report_at: daysAgo(20) });
    expect(selectFollowUpGuides([justo], opts()).due).toHaveLength(1);
  });

  it("una anulada NO hereda los 60 días de silencio de una viva", () => {
    // Mismo silencio, distinto desenlace: la viva sigue en cola, la anulada ya
    // no. Es la diferencia que introduce la ventana propia.
    const silencio = { last_report_at: daysAgo(30) };
    expect(selectFollowUpGuides([guide({ ...silencio, delivery_status: "en_ruta" })], opts()).due)
      .toHaveLength(1);
    expect(selectFollowUpGuides([guide({ ...silencio, delivery_status: "anulado" })], opts()).due)
      .toEqual([]);
  });

  it("un maxSilenceMs más corto que la ventana manda sobre ella", () => {
    // La ventana de retorno acorta, nunca alarga: si la config global es más
    // estricta, gana la global.
    const anulada = guide({ delivery_status: "anulado", last_report_at: daysAgo(8) });
    expect(selectFollowUpGuides([anulada], opts({ maxSilenceMs: 5 * DAY_MS })).due).toEqual([]);
  });

  it("no persigue lo que el barrido por fechas acaba de ver", () => {
    const res = selectFollowUpGuides([guide()], opts({ scanned: new Set(["ALC000123456789"]) }));
    expect(res.due).toEqual([]);
  });

  // Las guías que entraron por Excel no tienen orderNumber, pero SÍ guide_code, y
  // es el mismo identificador: se persiguen igual. Son la mayoría del universo.
  it("persigue una guía del Excel usando su guide_code", () => {
    const excel = guide({ external_order_number: null, guide_code: "AUR5X836431268256" });
    const res = selectFollowUpGuides([excel], opts());
    expect(res.due).toEqual([excel]);
  });

  it("ignora la guía sin ningún identificador con el que preguntar", () => {
    const res = selectFollowUpGuides(
      [guide({ external_order_number: null, guide_code: null })],
      opts(),
    );
    expect(res.due).toEqual([]);
    expect(res.deferred).toBe(0);
  });

  it("ignora identificadores en blanco por ambos campos", () => {
    const res = selectFollowUpGuides(
      [guide({ external_order_number: "   ", guide_code: "  " })],
      opts(),
    );
    expect(res.due).toEqual([]);
  });

  // El barrido por fechas anota lo que ya visitó. Como orderNumber y guide_code
  // son el mismo valor, una guía del Excel recién barrida no se vuelve a pedir.
  it("no repite una guía del Excel que el barrido acaba de ver", () => {
    const excel = guide({ external_order_number: null, guide_code: "AUR5X1" });
    const res = selectFollowUpGuides([excel], opts({ scanned: new Set(["AUR5X1"]) }));
    expect(res.due).toEqual([]);
  });
});

describe("followUpKey — con qué se pregunta", () => {
  it("prefiere external_order_number cuando está", () => {
    expect(followUpKey(guide({ external_order_number: "ALC1", guide_code: "AUR5X1" }))).toBe("ALC1");
  });

  it("cae a guide_code cuando no hay orderNumber", () => {
    expect(followUpKey(guide({ external_order_number: null, guide_code: "AUR5X1" }))).toBe("AUR5X1");
  });

  it("trata el blanco como ausencia y sigue al respaldo", () => {
    expect(followUpKey(guide({ external_order_number: "  ", guide_code: "AUR5X1" }))).toBe("AUR5X1");
  });

  it("devuelve cadena vacía cuando no hay ninguno", () => {
    expect(followUpKey(guide({ external_order_number: null, guide_code: null }))).toBe("");
  });
});

describe("selectFollowUpGuides — topes", () => {
  it("abandona la guía que lleva demasiado tiempo callada", () => {
    const muda = guide({ last_report_at: daysAgo(90) });
    const res = selectFollowUpGuides([muda], opts());
    expect(res.due).toEqual([]);
    expect(res.abandoned).toBe(1);
  });

  it("mide el silencio desde created_at cuando no hubo reporte", () => {
    const vieja = guide({ last_report_at: null, created_at: daysAgo(90) });
    expect(selectFollowUpGuides([vieja], opts()).abandoned).toBe(1);

    const nueva = guide({ last_report_at: null, created_at: daysAgo(20) });
    expect(selectFollowUpGuides([nueva], opts()).due).toHaveLength(1);
  });

  it("una fecha ilegible no descarta la guía", () => {
    const rota = guide({ last_report_at: "no-es-una-fecha", created_at: null });
    const res = selectFollowUpGuides([rota], opts());
    expect(res.due).toHaveLength(1);
    expect(res.abandoned).toBe(0);
  });

  it("corta en el límite y reporta cuántas quedaron sin turno", () => {
    const muchas = Array.from({ length: 10 }, (_, i) =>
      guide({ id: `s${i}`, external_order_number: `ALC${i}`, last_report_at: daysAgo(20 + i) }),
    );
    const res = selectFollowUpGuides(muchas, opts({ limit: 4 }));
    expect(res.due).toHaveLength(4);
    expect(res.deferred).toBe(6);
  });

  it("con límite cero no consulta nada y todo queda diferido", () => {
    const res = selectFollowUpGuides([guide()], opts({ limit: 0 }));
    expect(res.due).toEqual([]);
    expect(res.deferred).toBe(1);
  });
});

describe("selectFollowUpGuides — orden de la cola", () => {
  // El orden es lo que garantiza que la cola rote: si siempre se atendiera a
  // las mismas, las de la cola nunca resolverían.
  it("atiende primero a la que lleva más tiempo sin hablar", () => {
    const reciente = guide({ id: "reciente", external_order_number: "ALC1", last_report_at: daysAgo(16) });
    const antigua = guide({ id: "antigua", external_order_number: "ALC2", last_report_at: daysAgo(40) });
    const media = guide({ id: "media", external_order_number: "ALC3", last_report_at: daysAgo(25) });

    const res = selectFollowUpGuides([reciente, antigua, media], opts());
    expect(res.due.map((g) => g.id)).toEqual(["antigua", "media", "reciente"]);
  });

  it("la que no tiene ninguna fecha va primero", () => {
    const sinFecha = guide({ id: "sin", external_order_number: "ALC1", last_report_at: null, created_at: null });
    const conFecha = guide({ id: "con", external_order_number: "ALC2", last_report_at: daysAgo(40) });

    const res = selectFollowUpGuides([conFecha, sinFecha], opts());
    expect(res.due.map((g) => g.id)).toEqual(["sin", "con"]);
  });

  it("el orden es estable entre pasadas con la misma señal", () => {
    const a = guide({ id: "b", external_order_number: "ALC1", last_report_at: daysAgo(20) });
    const b = guide({ id: "a", external_order_number: "ALC2", last_report_at: daysAgo(20) });
    expect(selectFollowUpGuides([a, b], opts()).due.map((g) => g.id)).toEqual(["a", "b"]);
  });
});

describe("selectFollowUpGuides — prioridad de las que esperan devolución", () => {
  // El estado que le falta a estas guías es el ÚNICO que abre la recuperación
  // (MOM §11.1). Una viva releída tarde solo se ve desactualizada; una
  // devolución leída tarde puede caerse de la ventana de frescura y perder la
  // venta. Antes competían en igualdad y perdían: al cambiar de estado quedan
  // entre las MENOS calladas, o sea al final de una cola ordenada por silencio.

  const viva = (id: string, dias: number) =>
    guide({ id, delivery_status: "en_ruta", last_report_at: daysAgo(dias) });
  const anulada = (id: string, dias: number) =>
    guide({ id, delivery_status: "anulado", last_report_at: daysAgo(dias) });

  it("una anulada reciente entra aunque haya vivas mucho más calladas", () => {
    // Sin reserva, las 10 vivas de 30 días copaban la pasada y la anulada de
    // ayer —la que puede haber vuelto— se quedaba fuera.
    const vivas = Array.from({ length: 10 }, (_, i) => viva(`viva${i}`, 30));
    const res = selectFollowUpGuides([...vivas, anulada("recien", 1)], opts({ limit: 4 }));
    expect(res.due.map((g) => g.id)).toContain("recien");
  });

  it("TO_RETURN cuenta como que espera devolución, aunque siga en ruta", () => {
    const enRetorno = guide({
      id: "volviendo",
      delivery_status: "en_ruta",
      last_report_at: daysAgo(1),
      reported_status: "CANCEL · TO_RETURN · CONFIRMED",
    });
    const vivas = Array.from({ length: 10 }, (_, i) => viva(`v${i}`, 30));
    const res = selectFollowUpGuides([...vivas, enRetorno], opts({ limit: 4 }));
    expect(res.due.map((g) => g.id)).toContain("volviendo");
  });

  it("es una RESERVA, no una precedencia: las vivas nunca se quedan sin turno", () => {
    // Con orden estricto, 100 anuladas dejarían a las vivas sin releerse
    // durante horas. La mitad de cada pasada sigue siendo suya.
    const anuladas = Array.from({ length: 100 }, (_, i) => anulada(`a${i}`, 2));
    const vivas = Array.from({ length: 100 }, (_, i) => viva(`v${i}`, 40));
    const res = selectFollowUpGuides([...anuladas, ...vivas], opts({ limit: 10 }));
    expect(res.due.filter((g) => g.id.startsWith("v"))).toHaveLength(5);
    expect(res.due.filter((g) => g.id.startsWith("a"))).toHaveLength(5);
  });

  it("sin guías en devolución la pasada entera es para las vivas", () => {
    // El comportamiento anterior a este cambio, intacto.
    const vivas = Array.from({ length: 10 }, (_, i) => viva(`v${i}`, 30));
    expect(selectFollowUpGuides(vivas, opts({ limit: 4 })).due).toHaveLength(4);
  });

  it("sin vivas, la reserva sobrante se la quedan las que esperan devolución", () => {
    const anuladas = Array.from({ length: 10 }, (_, i) => anulada(`a${i}`, 2));
    expect(selectFollowUpGuides(anuladas, opts({ limit: 4 })).due).toHaveLength(4);
  });

  it("dentro de cada familia sigue mandando la más callada primero", () => {
    const res = selectFollowUpGuides(
      [anulada("nueva", 1), anulada("vieja", 15), viva("viva", 30)],
      opts({ limit: 2 }),
    );
    // La reserva es 1 (ceil(2 * 0.5)) y se la lleva la anulada más callada.
    expect(res.due.map((g) => g.id)).toEqual(["vieja", "viva"]);
  });

  it("no se pierde ninguna: lo que no entra queda diferido", () => {
    const anuladas = Array.from({ length: 6 }, (_, i) => anulada(`a${i}`, 2));
    const vivas = Array.from({ length: 6 }, (_, i) => viva(`v${i}`, 30));
    const res = selectFollowUpGuides([...anuladas, ...vivas], opts({ limit: 4 }));
    expect(res.due).toHaveLength(4);
    expect(res.deferred).toBe(8);
  });
});
