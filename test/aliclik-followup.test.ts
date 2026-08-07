import { describe, it, expect } from "vitest";
import {
  selectFollowUpGuides,
  type FollowUpCandidate,
  type SelectFollowUpOpts,
} from "@/lib/aliclik-followup";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const DAY_MS = 86_400_000;

const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

const guide = (over: Partial<FollowUpCandidate> = {}): FollowUpCandidate => ({
  id: "s1",
  external_order_number: "ALC000123456789",
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

  it.each(["entregado", "anulado", "transferido"])("no persigue una guía %s", (estado) => {
    expect(selectFollowUpGuides([guide({ delivery_status: estado })], opts()).due).toEqual([]);
  });

  it("no persigue lo que el barrido por fechas acaba de ver", () => {
    const res = selectFollowUpGuides([guide()], opts({ scanned: new Set(["ALC000123456789"]) }));
    expect(res.due).toEqual([]);
  });

  // Las guías que entraron por Excel no tienen orderNumber: no hay forma de
  // preguntarle a Aliclik por ellas, así que no cuentan como pendientes.
  it("ignora las guías sin external_order_number", () => {
    const res = selectFollowUpGuides([guide({ external_order_number: null })], opts());
    expect(res.due).toEqual([]);
    expect(res.deferred).toBe(0);
  });

  it("ignora un external_order_number en blanco", () => {
    expect(selectFollowUpGuides([guide({ external_order_number: "   " })], opts()).due).toEqual([]);
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
