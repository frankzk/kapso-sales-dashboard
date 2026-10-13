import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resultadoDeControl, resumenDelBrazo } from "@/lib/swayp-pc-auto-access";
import {
  DEFAULT_PC_AUTO_SETTINGS,
  brazoDe,
  codigoDeNovedad,
  direccionConNumero,
  esRecojoEnAgencia,
  evaluarPorConfirmarAuto,
  frenoActivado,
  ordenDePasada,
  type PcAutoCandidate,
  type PorConfirmarAutoSettings,
} from "@/lib/swayp-por-confirmar-auto";

/**
 * Swayp automático desde Por confirmar, piloto A/B (MOM §11.13, 13-10-2026).
 * Las direcciones son las de los pedidos revisados con el owner el 12-10-2026.
 */

const S: PorConfirmarAutoSettings = { org_id: "org", ...DEFAULT_PC_AUTO_SETTINGS, enabled: true };
const NOW = new Date("2026-10-13T15:00:00Z");

function cand(over: {
  order?: Partial<PcAutoCandidate["order"]>;
  master?: Partial<PcAutoCandidate["master"]>;
  contacts?: PcAutoCandidate["contacts"];
  phoneHistory?: PcAutoCandidate["phoneHistory"];
  liveOutputs?: number;
  payments?: number;
} = {}): PcAutoCandidate {
  return {
    order: {
      id: "o-1",
      store_id: "st",
      name: "#KP1",
      created_at: "2026-10-12T20:00:00Z",
      cancelled_at: null,
      total_amount: 149,
      total_refunded: 0,
      currency: "PEN",
      financial_status: "pending",
      customer_phone: "51987654321",
      shopify_note: null,
      line_items: [{ title: "Cayenne Pepper", sku: "63603555", quantity: 1 } as never],
      ...over.order,
    },
    master: {
      macro_stage: "por_confirmar",
      macro_substage: "por_confirmar",
      coverage: "provincia_cod",
      swayp_availability: "ok",
      address: "Calle Melgar 104 Paucarpata",
      reference: "Óvalo Miguel Grau",
      district: "Arequipa",
      province: "Arequipa",
      region: "Arequipa",
      latitude: -16.4,
      longitude: -71.5,
      confirmation_next_contact_on: null,
      ...over.master,
    },
    contacts: over.contacts ?? [{ result: "sin_respuesta", note: null, occurred_at: "2026-10-12T22:00:00Z" }],
    liveOutputs: over.liveOutputs ?? 0,
    payments: over.payments ?? 0,
    phoneHistory: over.phoneHistory ?? [],
  };
}

describe("la dirección completa: calle con número, o manzana y lote", () => {
  it.each([
    "Av roma 785",
    "Calle Chicago 201 apima Paucarpata",
    "Asc alipio ponce vazqez mz b lot 3 cerro colorado",
    "El dorado mzn. D lote 1 tierra prometida",
    "Las palmeras 1etapa  lote E19",
    "Los olivos 104 departamento 101 Cayma",
    "Jr me Xico  352",
    "José María cano nro 116 C",
  ])("sí: %s", (a) => expect(direccionConNumero(a)).toBe(true));

  it.each([
    "Av las torres",
    "Calle santa barbara",
    "Av. 31 de octubre y esperanza",
    "Urb.buenos aires av. Benito calla",
    "Las dunas d2",
    "Urb. La Molina F16",
    "Ascn Jardines de CAYMA Mz A Lt",
    "",
  ])("no: «%s»", (a) => expect(direccionConNumero(a)).toBe(false));

  it("el recojo en agencia no es reparto a domicilio", () => {
    expect(esRecojoEnAgencia("Agencia shalom", null)).toBe(true);
    expect(esRecojoEnAgencia("Shalomm manzanilla", "Calle urbano")).toBe(true);
    expect(esRecojoEnAgencia("En Agencia Recojo shalom", null)).toBe(true);
    expect(esRecojoEnAgencia("Calle Melgar 104", "Óvalo Miguel Grau")).toBe(false);
  });
});

describe("quién sale solo", () => {
  it("un pedido fresco, con una llamada sin respuesta, dirección completa y Swayp ok", () => {
    const v = evaluarPorConfirmarAuto(cand(), S, NOW);
    expect(v.eligible).toBe(true);
  });

  it.each([
    ["stage", { master: { macro_substage: "volver_a_contactar" } }],
    ["stage", { master: { macro_substage: "swayp_no_entrego" } }],
    ["stage", { master: { macro_stage: "por_despachar" } }],
    ["not_provincia_cod", { master: { coverage: "lima_cod" } }],
    ["not_swayp_ok", { master: { swayp_availability: "sin_stock" } }],
    ["old_order", { order: { created_at: "2026-10-11T12:00:00Z" } }],
    ["invalid_order", { order: { cancelled_at: "2026-10-12T21:00:00Z" } }],
    ["no_attempt", { contacts: [] }],
    ["agency", { master: { address: "Agencia shalom", reference: "Agencia shalom" } }],
    ["address", { master: { address: "Av las torres" } }],
    ["phone", { order: { customer_phone: "123" } }],
    ["amount", { order: { total_amount: 447 } }],
    ["payment", { payments: 1 }],
    ["live_output", { liveOutputs: 1 }],
  ] as const)("no sale: %s", (reason, over) => {
    expect(evaluarPorConfirmarAuto(cand(over as never), S, NOW)).toEqual({ eligible: false, reason });
  });

  it("tres llamadas sin respuesta es demasiado: quien no contesta, no le contesta a Swayp", () => {
    const tres = ["sin_respuesta", "se_deja_mensaje", "sin_respuesta"].map((result, i) => ({
      result,
      note: null,
      occurred_at: `2026-10-12T2${i}:00:00Z`,
    }));
    expect(evaluarPorConfirmarAuto(cand({ contacts: tres }), S, NOW)).toEqual({
      eligible: false,
      reason: "too_many_unanswered",
    });
    expect(evaluarPorConfirmarAuto(cand({ contacts: tres.slice(0, 2) }), S, NOW).eligible).toBe(true);
  });

  it("una fecha para volver a contactar se respeta", () => {
    const v = evaluarPorConfirmarAuto(cand({ master: { confirmation_next_contact_on: "2026-10-14" } }), S, NOW);
    expect(v).toEqual({ eligible: false, reason: "scheduled" });
  });

  it("un teléfono que rechazó antes, o una nota que dice que no, no sale", () => {
    const rechazo = { id: "o-0", created_at: "2026-09-01T00:00:00Z", cancelled_at: null, delivered: false, rejected: true, open: false, line_items: [] };
    expect(evaluarPorConfirmarAuto(cand({ phoneHistory: [rechazo] }), S, NOW).reason).toBe("rejection");
    const nota = [{ result: "sin_respuesta", note: "dijo que ya no lo quiere", occurred_at: "2026-10-12T22:00:00Z" }];
    expect(evaluarPorConfirmarAuto(cand({ contacts: nota }), S, NOW).reason).toBe("rejection");
  });

  it("el mismo producto vivo o recién entregado al mismo teléfono es un duplicado", () => {
    const otro = {
      id: "o-0",
      created_at: "2026-10-01T00:00:00Z",
      cancelled_at: null,
      delivered: true,
      rejected: false,
      open: false,
      line_items: [{ title: "Cayenne Pepper", sku: "63603555", quantity: 1 } as never],
    };
    expect(evaluarPorConfirmarAuto(cand({ phoneHistory: [otro] }), S, NOW).reason).toBe("duplicate");
  });

  it("quien ya compró y recibió otro producto va primero", () => {
    const previo = { id: "o-0", created_at: "2026-08-01T00:00:00Z", cancelled_at: null, delivered: true, rejected: false, open: false, line_items: [{ title: "Otro", sku: "X", quantity: 1 } as never] };
    const v = evaluarPorConfirmarAuto(cand({ phoneHistory: [previo] }), S, NOW);
    expect(v.eligible && v.recompra).toBe(true);
    const lista = [
      { id: "a", recompra: false, createdAt: "2026-10-12T10:00:00Z" },
      { id: "b", recompra: true, createdAt: "2026-10-12T20:00:00Z" },
      { id: "c", recompra: false, createdAt: "2026-10-12T08:00:00Z" },
    ].sort(ordenDePasada);
    expect(lista.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("el piloto A/B", () => {
  it("el brazo es fijo para cada pedido", () => {
    expect(brazoDe("c34857a8-b06d-4934-b490-dbd60b00341b")).toBe(brazoDe("c34857a8-b06d-4934-b490-dbd60b00341b"));
  });

  it("y reparte más o menos la mitad a cada lado", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const swayp = ids.filter((id) => brazoDe(id) === "swayp").length;
    expect(swayp).toBeGreaterThan(900);
    expect(swayp).toBeLessThan(1100);
  });

  it("el freno no actúa con pocos casos y sí cuando la entrega cae", () => {
    const caso = (entregado: boolean, i: number) => ({ entregado, resolvedAt: `2026-10-${String(10 + (i % 15)).padStart(2, "0")}T00:00:00Z` });
    expect(frenoActivado(Array.from({ length: 10 }, (_, i) => caso(false, i)), S).frena).toBe(false);
    const malos = Array.from({ length: 20 }, (_, i) => caso(i < 6, i)); // 30 %
    expect(frenoActivado(malos, S)).toMatchObject({ frena: true, casos: 20 });
    const buenos = Array.from({ length: 20 }, (_, i) => caso(i < 8, i)); // 40 %
    expect(frenoActivado(buenos, S).frena).toBe(false);
  });

  it("lee el código de novedad de Swayp", () => {
    expect(codigoDeNovedad("Swayp · Bodega no despacho mercancía (20)")).toBe(20);
    expect(codigoDeNovedad(null)).toBeNull();
  });
});

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("la comparación de los brazos", () => {
  it("cuenta entregados, no entregados y en curso", () => {
    expect(resumenDelBrazo(["entregado", "no_entregado", "en_curso", "entregado"])).toEqual({
      total: 4,
      entregados: 2,
      noEntregados: 1,
      enCurso: 1,
    });
  });

  it("el control se mide por el Master: entregado por quien sea, o cerrado sin entrega", () => {
    expect(resultadoDeControl({ delivered_courier: "aliclik", macro_stage: "por_cerrar" })).toBe("entregado");
    expect(resultadoDeControl({ delivered_courier: null, macro_stage: "finalizado" })).toBe("no_entregado");
    expect(resultadoDeControl({ delivered_courier: null, macro_stage: "por_confirmar", cancelled_at: "2026-10-12" })).toBe("no_entregado");
    expect(resultadoDeControl({ delivered_courier: null, macro_stage: "en_curso" })).toBe("en_curso");
  });
});

describe("las garantías del runner", () => {
  const server = read("lib/swayp-por-confirmar-auto-server.ts");

  it("emite por el mismo camino que el botón, marcado como desde Por confirmar", () => {
    expect(server).toContain("await emitirGuiaSwaypDirecta(admin, {");
    expect(server).toContain('origen: "por_confirmar",');
    expect(server).toContain("actorId: null,");
  });

  it("el control pasa las mismas comprobaciones de red y no emite", () => {
    const control = server.indexOf('} else if (v.arm === "control") {');
    const stock = server.indexOf('reason = "no_stock";');
    const emite = server.indexOf("await emitirGuiaSwaypDirecta(admin, {");
    expect(stock).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(stock);
    expect(emite).toBeGreaterThan(control);
  });

  it("el freno se mira antes de emitir y apaga la configuración", () => {
    expect(server.indexOf("frenoActivado(")).toBeLessThan(server.indexOf("await emitirGuiaSwaypDirecta("));
    expect(server).toContain("enabled: false,");
  });

  it("la simulación no escribe nada", () => {
    expect(server).toContain("if (!dry) {");
    expect(server.match(/if \(!dry\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("el cron corre solo en producción, a las 6:30 p. m. de Lima", () => {
    expect(read("app/api/cron/swayp-pc-auto/route.ts")).toContain('if (process.env.VERCEL_ENV !== "production")');
    const cron = JSON.parse(read("vercel.json")).crons.find((c: { path: string }) => c.path === "/api/cron/swayp-pc-auto");
    expect(cron?.schedule).toBe("30 23 * * *");
  });

  it("nace apagado y solo lo cambia quien administra tiendas", () => {
    expect(read("db/migrations/0253_swayp_pc_auto.sql")).toContain("enabled           boolean not null default false,");
    expect(read("app/dashboard/pedidos/swayp-desde-confirmar/actions.ts")).toContain('hasOrgPermission(orgId, "stores.manage")');
  });

  it("el panel de cliente no importa la política ni el servidor", () => {
    const panel = read("components/swayp-pc-auto-panel.tsx");
    expect(panel).not.toContain('from "@/lib/swayp-por-confirmar-auto"');
    expect(panel).not.toContain('from "@/lib/swayp-por-confirmar-auto-server"');
    expect(panel).toContain('import type { PcAutoBrazo, PcAutoResumen } from "@/lib/swayp-pc-auto-access";');
  });

  it("el MOM lo documenta", () => {
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("### 11.13 Swayp automático desde Por confirmar, piloto A/B (13-10-2026)");
  });
});
