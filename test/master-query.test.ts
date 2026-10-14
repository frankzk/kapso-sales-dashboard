import { describe, expect, it } from "vitest";
import { buildMasterQuery, hasQueryFilters, masterQueueHref, parseMasterQuery } from "@/lib/master-query";
import { MASTER_PATH } from "@/lib/order-drawer-href";
import { emptyFilters } from "@/lib/order-master-filters";

const parse = (qs: string) => parseMasterQuery(new URLSearchParams(qs));

describe("parseMasterQuery", () => {
  it("una URL vacía da el listado sin filtrar", () => {
    const q = parse("");
    expect(hasQueryFilters(q.filters)).toBe(false);
    expect(q.sortKey).toBe("created");
    expect(q.page).toBe(1);
  });

  it("lee las multi-selección separadas por coma", () => {
    const q = parse("d=Lince,Ate&c=aliclik");
    expect([...q.filters.districts]).toEqual(["Lince", "Ate"]);
    expect([...q.filters.couriers]).toEqual(["aliclik"]);
  });

  it("descarta una fecha a medias en vez de filtrar por algo raro", () => {
    expect(parse("cf=2026-07-01").filters.createdFrom).toBe("2026-07-01");
    expect(parse("cf=24/07").filters.createdFrom).toBe("");
    expect(parse("cf=2026-7-1").filters.createdFrom).toBe("");
  });

  it("una URL manipulada no rompe: lo que no entiende lo ignora", () => {
    // Es la pantalla de trabajo diaria: un enlace viejo o tocado a mano tiene
    // que dar un listado sensato, no un error.
    const q = parse("s=inventado&pg=-3&sd=abc&wc=quizas");
    expect(q.sortKey).toBe("created");
    expect(q.page).toBe(1);
    expect(q.filters.staleDays).toBe(0);
    expect(q.filters.withComments).toBe(false);
  });

  it("las banderas solo se activan con 1", () => {
    expect(parse("wc=1&mc=1").filters.withComments).toBe(true);
    expect(parse("wc=1&mc=1").filters.multiCourier).toBe(true);
    expect(parse("wc=0").filters.withComments).toBe(false);
  });

  it("acepta también un objeto de searchParams, como los da Next", () => {
    const q = parseMasterQuery({ d: "Lince", s: "movement", pg: "3" });
    expect([...q.filters.districts]).toEqual(["Lince"]);
    expect(q.sortKey).toBe("movement");
    expect(q.page).toBe(3);
  });
});

describe("buildMasterQuery", () => {
  it("una vista sin filtrar deja la URL limpia", () => {
    const qs = buildMasterQuery({ filters: emptyFilters(), sortKey: "created", page: 1 });
    expect(qs.toString()).toBe("");
  });

  it("ida y vuelta: lo que se escribe se vuelve a leer igual", () => {
    const f = emptyFilters();
    f.districts = new Set(["Lince", "Ate"]);
    f.couriers = new Set(["aliclik"]);
    f.createdFrom = "2026-07-01";
    f.createdTo = "2026-07-24";
    f.withComments = true;
    f.staleDays = 5;
    f.search = "KP124";
    f.confirmationDue = "hoy";

    const qs = buildMasterQuery({ filters: f, sortKey: "movement", page: 4 });
    const back = parseMasterQuery(qs);

    expect([...back.filters.districts]).toEqual(["Lince", "Ate"]);
    expect([...back.filters.couriers]).toEqual(["aliclik"]);
    expect(back.filters.createdFrom).toBe("2026-07-01");
    expect(back.filters.createdTo).toBe("2026-07-24");
    expect(back.filters.withComments).toBe(true);
    expect(back.filters.staleDays).toBe(5);
    expect(back.filters.search).toBe("KP124");
    expect(back.filters.confirmationDue).toBe("hoy");
    expect(back.sortKey).toBe("movement");
    expect(back.page).toBe(4);
  });

  it("no escribe lo que está por defecto", () => {
    const f = emptyFilters();
    f.districts = new Set(["Lince"]);
    const qs = buildMasterQuery({ filters: f, sortKey: "created", page: 1 });
    expect(qs.toString()).toBe("d=Lince");
  });

  it("un conjunto vacío no deja un parámetro colgando", () => {
    const f = emptyFilters();
    f.districts = new Set();
    expect(buildMasterQuery({ filters: f, sortKey: "created", page: 1 }).has("d")).toBe(false);
  });
});

describe("hasQueryFilters", () => {
  it("distingue tener filtros de no tenerlos", () => {
    expect(hasQueryFilters(emptyFilters())).toBe(false);
    const f = emptyFilters();
    f.expiringSoon = true;
    expect(hasQueryFilters(f)).toBe(true);
    const g = emptyFilters();
    g.search = "  ";
    expect(hasQueryFilters(g)).toBe(false); // espacios no son un filtro
    const h = emptyFilters();
    h.confirmationDue = "vencido";
    expect(hasQueryFilters(h)).toBe(true);
  });
});

describe("masterQueueHref", () => {
  const STORE = "11111111-1111-4111-8111-111111111111";
  const split = (href: string) => new URLSearchParams(href.slice(href.indexOf("?") + 1));

  it("escribe la etapa, la subetapa, la cobertura y la tienda", () => {
    const href = masterQueueHref({ view: "en_curso", substage: "en_transito", coverages: ["lima"], storeIds: [STORE] });
    const params = split(href);
    expect(params.get("view")).toBe("en_curso");
    expect(params.get("substage")).toBe("en_transito");
    expect(params.get("cv")).toBe("lima");
    expect(params.get("st")).toBe(STORE);
  });

  it("abre el Master de Pedidos", () => {
    const href = masterQueueHref({ view: "por_cerrar", coverages: ["lima"] });
    expect(href.startsWith(`${MASTER_PATH}?`)).toBe(true);
  });

  it("ida y vuelta: parseMasterQuery lee la misma cobertura y las mismas tiendas", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const q = parseMasterQuery(split(masterQueueHref({ view: "preparacion", coverages: ["lima"], storeIds: [STORE, other] })));
    expect([...q.filters.coverages]).toEqual(["lima"]);
    expect([...q.filters.stores]).toEqual([STORE, other]);
    expect(q.sortKey).toBe("created");
    expect(q.page).toBe(1);
    expect(hasQueryFilters({ ...q.filters, coverages: new Set(), stores: new Set() })).toBe(false);
  });

  it("sin subetapa no escribe el parámetro, y sin tienda tampoco", () => {
    const params = split(masterQueueHref({ view: "por_despachar", substage: null, coverages: ["lima"] }));
    expect(params.has("substage")).toBe(false);
    expect(params.has("st")).toBe(false);
    expect(params.get("view")).toBe("por_despachar");
    expect(split(masterQueueHref({ view: "por_despachar" })).has("substage")).toBe(false);
  });
});
