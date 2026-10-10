import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkListingContract,
  collectListingPages,
  CONTRACT_MIN_AGREEMENT,
  CONTRACT_MIN_COMPARED,
  COTEJO_HORAS_LIMA,
  COVERAGE_MIN,
  listingCoverage,
  matchShalomListing,
  readListingGuide,
  shareAName,
  shouldRunShalomCotejo,
  WINDOW_AFTER_DAYS,
  WINDOW_BEFORE_DAYS,
  type CotejoShalomOrder,
  type KnownApiGuide,
  type ShalomListingGuide,
} from "@/lib/shalom/account-match";
import type { ShalomAccountOrder } from "@/lib/shalom/types";

// 10-10-2026: 30 pedidos pagados enteros en «Preparación · Por generar rótulo»
// sin ninguna salida. La guía se hizo a mano en pro.shalom.pe y nadie la
// registró en Kapta. Cotejar Shalom las vincula, pero SOLO lo que no admite
// duda: una guía en el pedido equivocado mueve el estado de otro pedido y le
// avisa a otra clienta.

const AMBOS = { documento: true, telefono: true };

function guia(over: Partial<ShalomListingGuide> = {}): ShalomListingGuide {
  return {
    guia: "92305268",
    codigo: "77PH",
    serie: "V872",
    listingId: 101363195,
    createdAt: "2026-08-24T15:00:00Z",
    document: "43320879",
    phone: "966342089",
    name: "DEYBY BRAHANIGAN ALEJO",
    ...over,
  };
}

function pedido(over: Partial<CotejoShalomOrder> = {}): CotejoShalomOrder {
  return {
    orderId: "o-1",
    storeId: "kenku",
    orderName: "#KP128612",
    createdAt: "2026-08-17T14:00:00Z",
    customerName: "Deyby Brahanigan Alejo hi",
    phone: "966342089",
    document: "43320879",
    candidate: true,
    ...over,
  };
}

const sinVincular = new Set<string>();

describe("leer una orden del listado de la cuenta", () => {
  it("toma guía, código, fecha y el destinatario normalizado", () => {
    const o: ShalomAccountOrder = {
      id: 101363195,
      guia: 92305268,
      codigo: " 77PH ",
      serie: "V872",
      created_at: "2026-08-24T15:00:00Z",
      receiver: { document: " 43320879 ", full_name: "DEYBY BRAHANIGAN", phone: 51966342089 },
    };
    expect(readListingGuide(o)).toEqual({
      guia: "92305268",
      codigo: "77PH",
      serie: "V872",
      listingId: 101363195,
      createdAt: "2026-08-24T15:00:00Z",
      document: "43320879",
      phone: "966342089",
      name: "DEYBY BRAHANIGAN",
    });
  });

  it("sin nombre completo, arma el nombre con sus partes", () => {
    const g = readListingGuide({ id: 1, guia: "1", receiver: { name: "Ana", last_name: "Quispe", sur_name: "Mamani" } });
    expect(g?.name).toBe("Ana Quispe Mamani");
  });

  it("sin número de guía no hay nada que vincular; sin destinatario, no hay con qué", () => {
    expect(readListingGuide({ id: 1, guia: "  " })).toBeNull();
    expect(readListingGuide({ id: 1, guia: "98001122" })).toMatchObject({ document: null, phone: null, name: null });
  });

  it("un documento corto o un teléfono incompleto no identifican a nadie", () => {
    const g = readListingGuide({ id: 1, guia: "9", receiver: { document: "1234", phone: "96634" } });
    expect(g).toMatchObject({ document: null, phone: null });
  });
});

describe("Cotejar Shalom — qué se vincula", () => {
  it("MISMO DNI y una sola guía posible: se vincula", () => {
    const [r] = matchShalomListing([guia()], [pedido()], sinVincular, AMBOS);
    expect(r).toMatchObject({ kind: "vincular", via: "dni", guide: { guia: "92305268" } });
  });

  it("el DNI basta aunque el nombre de Shalom sea otro: quien recoge puede ser un familiar", () => {
    const [r] = matchShalomListing(
      [guia({ name: "ROSA ALEJO QUISPE", phone: null })],
      [pedido({ customerName: "Deyby" })],
      sinVincular,
      AMBOS,
    );
    expect(r).toMatchObject({ kind: "vincular", via: "dni" });
  });

  it("sin DNI apuntado: mismo celular y un nombre en común", () => {
    const [r] = matchShalomListing(
      [guia({ document: "00907119", name: "NILDA ROJAS PEZO" })],
      [pedido({ document: null, customerName: "Nilda Nilda", phone: "966342089" })],
      sinVincular,
      AMBOS,
    );
    expect(r).toMatchObject({ kind: "vincular", via: "telefono" });
  });

  it("mismo celular sin ningún nombre en común: a revisar, no se adivina", () => {
    const [r] = matchShalomListing(
      [guia({ document: "00907119", name: "JORGE PEZO" })],
      [pedido({ document: null, customerName: "Nilda Nilda" })],
      sinVincular,
      AMBOS,
    );
    expect(r).toMatchObject({ kind: "ambiguo", reason: expect.stringContaining("JORGE PEZO") });
  });

  it("mismo celular y apellido, pero OTRO DNI: es otra persona", () => {
    const [r] = matchShalomListing(
      [guia({ document: "11112222", name: "ROSA BRAHANIGAN" })],
      [pedido()],
      sinVincular,
      AMBOS,
    );
    expect(r).toMatchObject({ kind: "ambiguo", reason: expect.stringContaining("otro DNI") });
  });

  it("«de» o «la» no son un nombre en común", () => {
    expect(shareAName("Edgar suclli la", "MARIA DE LA CRUZ")).toBe(false);
    expect(shareAName("Edgar suclli la", "EDGAR SUCLLI HUAMAN")).toBe(true);
  });

  it("dos guías de Shalom con el DNI del pedido: a revisar", () => {
    const [r] = matchShalomListing(
      [guia(), guia({ guia: "92305999", createdAt: "2026-08-30T15:00:00Z" })],
      [pedido()],
      sinVincular,
      AMBOS,
    );
    expect(r).toMatchObject({ kind: "ambiguo", guias: ["92305268", "92305999"] });
  });

  it("otra guía «parecida» (mismo celular, otro nombre) también basta para dudar", () => {
    const [r] = matchShalomListing(
      [guia(), guia({ guia: "92305999", document: null, name: "JUAN PEREZ" })],
      [pedido()],
      sinVincular,
      AMBOS,
    );
    expect(r).toMatchObject({ kind: "ambiguo" });
  });

  it("una guía que ya está en una salida de Kapta no se toca", () => {
    const [r] = matchShalomListing([guia()], [pedido()], new Set(["92305268"]), AMBOS);
    expect(r).toMatchObject({ kind: "sin_pareja" });
  });

  it("y no le quita la pareja a la otra guía, que sigue siendo única", () => {
    const [r] = matchShalomListing(
      [guia({ guia: "90000001", createdAt: "2026-08-18T15:00:00Z" }), guia()],
      [pedido()],
      new Set(["90000001"]),
      AMBOS,
    );
    expect(r).toMatchObject({ kind: "vincular", guide: { guia: "92305268" } });
  });

  it("otro pedido de la misma clienta en la ventana de la guía: no se adivina de cuál es", () => {
    const [r] = matchShalomListing(
      [guia()],
      [
        pedido(),
        pedido({ orderId: "o-2", orderName: "#KP128700", createdAt: "2026-08-20T10:00:00Z", document: null, candidate: false }),
      ],
      sinVincular,
      AMBOS,
    );
    expect(r).toMatchObject({ kind: "ambiguo", reason: expect.stringContaining("#KP128700") });
  });

  it("vale también si ese otro pedido está cerrado o anulado: sigue pudiendo ser el dueño", () => {
    const [r] = matchShalomListing(
      [guia()],
      [pedido(), pedido({ orderId: "o-2", orderName: "#KP128000", phone: null, candidate: false })],
      sinVincular,
      AMBOS,
    );
    expect(r).toMatchObject({ kind: "ambiguo" });
  });

  it("un pedido viejo de la misma clienta, fuera de la ventana, no estorba", () => {
    const [r] = matchShalomListing(
      [guia()],
      [pedido(), pedido({ orderId: "o-2", orderName: "#KP120000", createdAt: "2026-05-01T10:00:00Z", candidate: false })],
      sinVincular,
      AMBOS,
    );
    expect(r).toMatchObject({ kind: "vincular" });
  });

  it("dos pedidos parados de la misma clienta y una guía: ninguno se la lleva", () => {
    const out = matchShalomListing(
      [guia()],
      [pedido(), pedido({ orderId: "o-2", orderName: "#KP128613", createdAt: "2026-08-18T10:00:00Z" })],
      sinVincular,
      AMBOS,
    );
    expect(out.map((o) => o.kind)).toEqual(["ambiguo", "ambiguo"]);
  });

  it("la guía tiene que caer en la ventana del pedido", () => {
    const antes = guia({ createdAt: "2026-08-14T15:00:00Z" });
    const despues = guia({ createdAt: new Date(Date.parse("2026-08-17T14:00:00Z") + (WINDOW_AFTER_DAYS + 1) * 86_400_000).toISOString() });
    expect(matchShalomListing([antes], [pedido()], sinVincular, AMBOS)[0]).toMatchObject({ kind: "sin_pareja" });
    expect(matchShalomListing([despues], [pedido()], sinVincular, AMBOS)[0]).toMatchObject({ kind: "sin_pareja" });
  });

  it("una guía sin fecha no se puede poner en ninguna ventana: a revisar", () => {
    const [r] = matchShalomListing([guia({ createdAt: null })], [pedido()], sinVincular, AMBOS);
    expect(r).toMatchObject({ kind: "ambiguo", reason: expect.stringContaining("no trae fecha") });
  });

  it("si el DNI del listado no se pudo comprobar, el mismo DNI no vincula", () => {
    const [r] = matchShalomListing([guia({ phone: null })], [pedido()], sinVincular, { documento: false, telefono: true });
    expect(r).toMatchObject({ kind: "ambiguo" });
  });

  it("si el celular del listado no se pudo comprobar, solo queda el DNI", () => {
    const sinDni = matchShalomListing(
      [guia({ document: null })],
      [pedido({ document: null })],
      sinVincular,
      { documento: true, telefono: false },
    );
    expect(sinDni[0]).toMatchObject({ kind: "ambiguo" });
    const conDni = matchShalomListing([guia()], [pedido()], sinVincular, { documento: true, telefono: false });
    expect(conDni[0]).toMatchObject({ kind: "vincular", via: "dni" });
  });

  it("un pedido sin DNI ni celular no tiene con qué cotejarse", () => {
    const [r] = matchShalomListing([guia()], [pedido({ document: null, phone: null })], sinVincular, AMBOS);
    expect(r).toMatchObject({ kind: "sin_pareja" });
  });

  it("solo devuelve resultado para los candidatos, no para los que solo pueden estorbar", () => {
    const out = matchShalomListing(
      [guia()],
      [pedido(), pedido({ orderId: "o-9", orderName: "#KP999", phone: "911111111", document: "99999999", candidate: false })],
      sinVincular,
      AMBOS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.order.orderId).toBe("o-1");
  });
});

describe("antes de creerse el listado", () => {
  const listado = Array.from({ length: 20 }, (_, i) =>
    guia({ guia: `9800${String(i).padStart(4, "0")}`, document: `4000${String(i).padStart(4, "0")}`, phone: `91000${String(i).padStart(4, "0")}` }),
  );
  const conocidas: KnownApiGuide[] = listado.map((g) => ({ guideCode: g.guia, document: g.document, phone: g.phone }));

  it("el destinatario es el destinatario si coincide con las guías creadas por API", () => {
    const c = checkListingContract(listado, conocidas);
    expect(c.documento).toEqual({ comparadas: 20, coinciden: 20, confiable: true });
    expect(c.telefono.confiable).toBe(true);
  });

  it("si el «destinatario» fuera el remitente, no coincide con nadie y no se usa", () => {
    const remitente = listado.map((g) => ({ ...g, document: "20601234567", phone: "930555309" }));
    const c = checkListingContract(remitente, conocidas);
    expect(c.documento.confiable).toBe(false);
    expect(c.telefono.confiable).toBe(false);
  });

  it("si el listado no trae destinatario, no hay nada que comparar", () => {
    const vacio = listado.map((g) => ({ ...g, document: null, phone: null }));
    expect(checkListingContract(vacio, conocidas).documento).toEqual({ comparadas: 0, coinciden: 0, confiable: false });
  });

  it("con pocas guías conocidas no hay muestra para fiarse", () => {
    const pocas = conocidas.slice(0, CONTRACT_MIN_COMPARED - 1);
    expect(checkListingContract(listado, pocas).documento.confiable).toBe(false);
  });

  it("un DNI corregido después de crear la guía no tumba la comprobación; muchos sí", () => {
    const uno = conocidas.map((k, i) => (i === 0 ? { ...k, document: "12345678" } : k));
    expect(checkListingContract(listado, uno).documento.confiable).toBe(true);
    const tres = conocidas.map((k, i) => (i < 3 ? { ...k, document: "12345678" } : k));
    expect(checkListingContract(listado, tres).documento.confiable).toBe(false);
  });

  it("el listado está entero si trae las guías de la API del periodo", () => {
    const codes = listado.map((g) => g.guia);
    expect(listingCoverage(listado, codes)).toEqual({ esperadas: 20, encontradas: 20, completo: true });
    expect(listingCoverage(listado.slice(0, 15), codes).completo).toBe(false);
    // Sin ninguna guía con la que medir, no se da por entero.
    expect(listingCoverage(listado, []).completo).toBe(false);
  });
});

describe("bajar el listado entero", () => {
  const orden = (id: number): ShalomAccountOrder => ({ id, guia: String(90000000 + id) });
  const paginas = (total: number, perPage: number) => async (page: number) =>
    Array.from({ length: Math.max(0, Math.min(perPage, total - (page - 1) * perPage)) }, (_, i) => orden((page - 1) * perPage + i + 1));

  it("pide páginas hasta que una viene corta", async () => {
    const r = await collectListingPages(paginas(23, 10), { perPage: 10, maxPages: 5, deadlineMs: Date.now() + 60_000 });
    expect(r).toMatchObject({ completo: true, paginas: 3 });
    expect(r.orders).toHaveLength(23);
  });

  it("una página exacta y la siguiente vacía también es el final", async () => {
    const r = await collectListingPages(paginas(20, 10), { perPage: 10, maxPages: 5, deadlineMs: Date.now() + 60_000 });
    expect(r).toMatchObject({ completo: true, paginas: 3 });
    expect(r.orders).toHaveLength(20);
  });

  it("si el wrapper ignora `page` y repite, el listado NO está entero", async () => {
    const r = await collectListingPages(async () => Array.from({ length: 10 }, (_, i) => orden(i)), {
      perPage: 10,
      maxPages: 5,
      deadlineMs: Date.now() + 60_000,
    });
    expect(r).toMatchObject({ completo: false, motivo: expect.stringContaining("no pagina") });
  });

  it("con más páginas que el tope, tampoco", async () => {
    const r = await collectListingPages(paginas(100, 10), { perPage: 10, maxPages: 3, deadlineMs: Date.now() + 60_000 });
    expect(r.completo).toBe(false);
  });

  it("sin tiempo no se pide la siguiente página", async () => {
    let t = 0;
    const r = await collectListingPages(paginas(100, 10), {
      perPage: 10,
      maxPages: 10,
      deadlineMs: 10_000,
      now: () => (t += 3_000),
    });
    expect(r).toMatchObject({ completo: false, motivo: expect.stringContaining("tiempo") });
  });
});

describe("cuándo coteja el cron", () => {
  it("cuatro veces al día, en la pasada en punto de Lima", () => {
    expect(shouldRunShalomCotejo(new Date("2026-10-10T13:00:00Z"), false)).toBe(true); // 08:00 Lima
    expect(shouldRunShalomCotejo(new Date("2026-10-11T01:00:00Z"), false)).toBe(true); // 20:00 Lima
    expect(shouldRunShalomCotejo(new Date("2026-10-10T13:30:00Z"), false)).toBe(false);
    expect(shouldRunShalomCotejo(new Date("2026-10-10T14:00:00Z"), false)).toBe(false);
  });

  it("`?cotejar=1` lo fuerza", () => {
    expect(shouldRunShalomCotejo(new Date("2026-10-10T14:00:00Z"), true)).toBe(true);
  });
});

describe("una sola puerta para registrar una guía existente", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("el drawer y Cotejar Shalom registran por el mismo camino", () => {
    expect(read("app/dashboard/pedidos/shalom-actions.ts")).toContain("registerExistingShalomGuide(");
    const cotejo = read("lib/shalom/account-cotejo.ts");
    expect(cotejo).toContain("registerExistingShalomGuide(");
    // El cron no es una persona: no firma con nadie y no se inventa la clave.
    expect(cotejo).toContain("actor: null");
    expect(cotejo).toContain("onlyIfNew: true");
    expect(cotejo).not.toContain("pickupCode:");
  });

  it("el cron de Shalom corre el cotejo", () => {
    expect(read("app/api/cron/shalom-reconcile/route.ts")).toContain("cotejarShalom(");
  });
});

describe("el MOM dice lo mismo que el código (§12, Cotejar Shalom)", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const mom = read("docs/mom/master-pedidos-v1.md");

  it("documenta la regla con sus números", () => {
    expect(mom).toContain("#### Cotejar Shalom: la guía hecha a mano que nadie registró");
    expect(mom).toContain(`**${WINDOW_BEFORE_DAYS} día antes y`);
    expect(mom).toContain(`${WINDOW_AFTER_DAYS} días después**`);
    expect(mom).toContain(`al menos el ${Math.round(COVERAGE_MIN * 100)} %`);
    expect(CONTRACT_MIN_AGREEMENT).toBe(0.9);
    expect(mom).toContain("nueve de cada diez, con diez como mínimo");
    expect(CONTRACT_MIN_COMPARED).toBe(10);
    expect([...COTEJO_HORAS_LIMA]).toEqual([8, 12, 16, 20]);
    expect(mom).toContain("la pasada de las 8, 12, 16 y 20 h de Lima");
  });

  it("y el tope por pasada", () => {
    expect(read("lib/shalom/account-cotejo.ts")).toContain("MAX_LINKS_PER_RUN = 10;");
    expect(mom).toContain("**Tope de 10 guías por pasada**");
  });
});
