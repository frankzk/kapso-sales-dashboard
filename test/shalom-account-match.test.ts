import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkListingContract,
  codigoKey,
  collectListingPages,
  LISTING_WINDOW_DAYS,
  listingFromDate,
  CONTRACT_MIN_AGREEMENT,
  CONTRACT_MIN_COMPARED,
  COTEJO_HORAS_LIMA,
  COVERAGE_MIN,
  listingCoverage,
  listingCodes,
  listingPickupCodes,
  matchShalomListing,
  planCodeFixes,
  planKeyBackfill,
  readListingGuide,
  readListingPickupCode,
  shareAName,
  usableListingKey,
  WINDOW_AFTER_DAYS,
  WINDOW_BEFORE_DAYS,
  type CodeCheckCandidate,
  type CotejoShalomOrder,
  type KeyBackfillCandidate,
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

// 12-10-2026, 01:12 UTC: Cotejar Shalom vinculó 7 guías (#KP131631 … #KP138154)
// sin clave. El listado trae `pickup_code`, pero nadie había comprobado que
// fuera la clave de verdad. Se comprueba como el destinatario: contra las
// claves que Kapta mandó al crear por API.
describe("la clave de recojo del listado", () => {
  // Claves válidas y distintas: ni repetidas ni escaleras.
  const CLAVES = ["4821", "5937", "7046", "8152", "2968", "6083", "3719", "9405", "1586", "6274", "4093", "8530"];
  const listado = CLAVES.map((_, i) => guia({ guia: `9810${String(i).padStart(4, "0")}`, document: `4100${String(i).padStart(4, "0")}` }));
  const conocidas: KnownApiGuide[] = listado.map((g, i) => ({
    guideCode: g.guia,
    document: g.document,
    phone: g.phone,
    pickupCode: CLAVES[i]!,
  }));
  const clavesDelListado = (claves: readonly string[]) => new Map(listado.map((g, i) => [g.guia, claves[i]!]));

  it("se lee tal como viene; si viniera como número, con sus 4 cifras", () => {
    expect(readListingPickupCode(" 4821 ")).toBe("4821");
    expect(readListingPickupCode(482)).toBe("0482");
    expect(readListingPickupCode(4821)).toBe("4821");
    expect(readListingPickupCode(48210)).toBeNull();
    expect(readListingPickupCode("")).toBeNull();
    expect(readListingPickupCode(null)).toBeNull();
    expect(readListingPickupCode(undefined)).toBeNull();
  });

  it("la misma guía dos veces con claves distintas no da ninguna", () => {
    const m = listingPickupCodes([
      { id: 1, guia: "98100000", pickup_code: "4821" },
      { id: 2, guia: "98100001", pickup_code: "5937" },
      { id: 3, guia: "98100001", pickup_code: "7046" },
      { id: 4, guia: "98100002", pickup_code: "8152" },
      { id: 5, guia: "98100002" },
      { id: 6, guia: "98100003" },
    ]);
    expect([...m.entries()]).toEqual([["98100000", "4821"]]);
  });

  it("coincide con las claves que Kapta mandó: se puede usar", () => {
    const c = checkListingContract(listado, conocidas, clavesDelListado(CLAVES));
    expect(c.clave).toEqual({ comparadas: CLAVES.length, coinciden: CLAVES.length, confiable: true });
  });

  it("no coincide: el campo no es la clave y no se usa", () => {
    const otras = CLAVES.map((_, i) => CLAVES[(i + 1) % CLAVES.length]!);
    const c = checkListingContract(listado, conocidas, clavesDelListado(otras));
    expect(c.clave).toEqual({ comparadas: CLAVES.length, coinciden: 0, confiable: false });
    // El destinatario no depende de la clave.
    expect(c.documento.confiable).toBe(true);
  });

  it("una clave cambiada después no tumba la comprobación; dos de doce sí", () => {
    const una = CLAVES.map((k, i) => (i === 0 ? "1357" : k));
    expect(checkListingContract(listado, conocidas, clavesDelListado(una)).clave.confiable).toBe(true);
    const dos = CLAVES.map((k, i) => (i < 2 ? "1357" : k));
    expect(checkListingContract(listado, conocidas, clavesDelListado(dos)).clave.confiable).toBe(false);
  });

  it("sin muestra suficiente no se fía, aunque todas coincidan", () => {
    const pocas = conocidas.slice(0, CONTRACT_MIN_COMPARED - 1);
    expect(checkListingContract(listado, pocas, clavesDelListado(CLAVES)).clave).toEqual({
      comparadas: CONTRACT_MIN_COMPARED - 1,
      coinciden: CONTRACT_MIN_COMPARED - 1,
      confiable: false,
    });
    // Si el listado no trae el campo, no hay nada que comparar.
    expect(checkListingContract(listado, conocidas).clave).toEqual({ comparadas: 0, coinciden: 0, confiable: false });
    // Y una clave de Kapta que no se pudo descifrar no cuenta.
    const sinDescifrar = conocidas.map((k) => ({ ...k, pickupCode: null }));
    expect(checkListingContract(listado, sinDescifrar, clavesDelListado(CLAVES)).clave.comparadas).toBe(0);
  });

  it("de la comprobación solo salen cuentas, nunca una clave", () => {
    const iguales = JSON.stringify(checkListingContract(listado, conocidas, clavesDelListado(CLAVES)));
    const distintas = JSON.stringify(checkListingContract(listado, conocidas, clavesDelListado([...CLAVES].reverse())));
    for (const k of CLAVES) {
      expect(iguales).not.toContain(k);
      expect(distintas).not.toContain(k);
    }
  });

  it("se usa solo si esta lectura la comprobó y tiene forma de clave", () => {
    expect(usableListingKey("4821", true)).toBe("4821");
    expect(usableListingKey(" 4821 ", true)).toBe("4821");
    expect(usableListingKey("4821", false)).toBeNull();
    for (const mala of ["1111", "1234", "482", "48210", "48a1", "", null, undefined]) {
      expect(usableListingKey(mala, true)).toBeNull();
    }
    // Una clave que ya emitió Shalom no se rechaza por parecer un año: es el
    // mismo criterio que «Ya la creé en Shalom Pro».
    expect(usableListingKey("1965", true)).toBe("1965");
  });

  describe("las claves que faltan en las guías manuales", () => {
    const keys = new Map([
      ["93000002", "7391"],
      ["93000003", "9157"],
      ["93000004", "2648"],
      ["93000005", "1111"],
      ["93000006", "3825"],
      ["93000007", "6429"],
    ]);
    const salida = (over: Partial<KeyBackfillCandidate> = {}): KeyBackfillCandidate => ({
      orderId: "o-sin-clave",
      storeId: "kenku",
      shipmentId: "s-1",
      guideCode: "93000002",
      createdVia: "shalom_pro_manual",
      live: true,
      hasKey: false,
      ...over,
    });

    it("la guía manual viva sin clave recibe la del listado", () => {
      expect(planKeyBackfill([salida()], keys, true)).toEqual([
        { orderId: "o-sin-clave", storeId: "kenku", shipmentId: "s-1", guideCode: "93000002", pickupCode: "7391" },
      ]);
    });

    it("si la clave del listado no se comprobó, no se pone ninguna", () => {
      expect(planKeyBackfill([salida()], keys, false)).toEqual([]);
    });

    it("solo las manuales, solo vivas, solo sin clave, solo con formato de clave y con la guía en el listado", () => {
      const plan = planKeyBackfill(
        [
          salida({ orderId: "o-api", shipmentId: "s-api", guideCode: "93000003", createdVia: "shalom_pro_api" }),
          salida({ orderId: "o-attested", shipmentId: "s-att", guideCode: "93000003", createdVia: "status_attested" }),
          salida({ orderId: "o-entregada", shipmentId: "s-ent", guideCode: "93000004", live: false }),
          salida({ orderId: "o-con-clave", shipmentId: "s-con", guideCode: "93000006", hasKey: true }),
          salida({ orderId: "o-mala", shipmentId: "s-mala", guideCode: "93000005" }),
          salida({ orderId: "o-fuera", shipmentId: "s-fuera", guideCode: "93999999" }),
          salida({ orderId: "o-ok", shipmentId: "s-ok", guideCode: " 93000007 " }),
        ],
        keys,
        true,
      );
      expect(plan.map((p) => p.orderId)).toEqual(["o-ok"]);
      expect(plan[0]).toMatchObject({ guideCode: "93000007", pickupCode: "6429" });
    });

    it("la clave que ya tiene el pedido no se pisa", () => {
      expect(planKeyBackfill([salida({ hasKey: true })], keys, true)).toEqual([]);
    });

    it("dos guías manuales vivas en el mismo pedido: no se adivina de cuál es la clave", () => {
      const dos = [salida(), salida({ shipmentId: "s-2", guideCode: "93000006" })];
      expect(planKeyBackfill(dos, keys, true)).toEqual([]);
    });
  });
});

// 15-10-2026: #KP137651 se registró a mano con el código V929; el ticket decía
// D7MN. El rastreo pide número y código, así que Shalom la rechazó del 01-10 al
// 15-10 y la clienta no recibió ningún aviso con el paquete en la agencia.
describe("el código de la guía manual", () => {
  const CODIGOS = ["D7MN", "77PH", "Q2RT", "H8KD", "M4XZ", "B9TC", "P3WL", "K6VN", "R5JS", "T1GF", "W8AE", "Z2NB"];
  const listado = CODIGOS.map((codigo, i) => guia({ guia: `9820${String(i).padStart(4, "0")}`, codigo }));
  const conocidas: KnownApiGuide[] = listado.map((g, i) => ({
    guideCode: g.guia,
    document: g.document,
    phone: g.phone,
    codigo: CODIGOS[i]!,
  }));

  const manual = (over: Partial<CodeCheckCandidate> = {}): CodeCheckCandidate => ({
    orderId: "o-137651",
    storeId: "kenku",
    shipmentId: "s-137651",
    guideCode: "98130498",
    codigo: "V929",
    createdAt: "2026-10-01T22:46:15Z",
    ...over,
  });
  const desde = "2026-09-01T00:00:00Z";

  it("se compara como lo compara el rastreo: sin espacios y en mayúsculas", () => {
    expect(codigoKey(" d7mn ")).toBe("D7MN");
    expect(codigoKey("D7 MN")).toBe("D7MN");
    expect(codigoKey("")).toBeNull();
    expect(codigoKey(null)).toBeNull();
    expect(codigoKey("D7MN!")).toBeNull();
  });

  it("la misma guía dos veces con códigos distintos no da ninguno", () => {
    const m = listingCodes([
      guia({ guia: "98200000", codigo: "D7MN" }),
      guia({ guia: "98200001", codigo: "77PH" }),
      guia({ guia: "98200001", codigo: "Q2RT" }),
      guia({ guia: "98200002", codigo: null }),
    ]);
    expect([...m.entries()]).toEqual([["98200000", "D7MN"]]);
  });

  it("el código del listado se comprueba con el que devolvió la API al crear", () => {
    expect(checkListingContract(listado, conocidas).codigo).toEqual({
      comparadas: CODIGOS.length,
      coinciden: CODIGOS.length,
      confiable: true,
    });
    const cruzados = conocidas.map((k, i) => ({ ...k, codigo: CODIGOS[(i + 1) % CODIGOS.length]! }));
    expect(checkListingContract(listado, cruzados).codigo.confiable).toBe(false);
    // El destinatario no depende del código.
    expect(checkListingContract(listado, cruzados).documento.confiable).toBe(true);
    const pocas = conocidas.slice(0, CONTRACT_MIN_COMPARED - 1);
    expect(checkListingContract(listado, pocas).codigo.confiable).toBe(false);
  });

  it("#KP137651: V929 tecleado, D7MN en el listado → se corrige a D7MN", () => {
    const conLaGuia = [...listado, guia({ guia: "98130498", codigo: "D7MN" })];
    const plan = planCodeFixes([manual()], conLaGuia, { trusted: true, fromIso: desde });
    expect(plan.fixes).toEqual([{ candidate: manual(), codigo: "D7MN" }]);
    expect(plan.missing).toEqual([]);
  });

  it("sin el código comprobado en esta lectura no se toca nada", () => {
    const conLaGuia = [...listado, guia({ guia: "98130498", codigo: "D7MN" })];
    expect(planCodeFixes([manual()], conLaGuia, { trusted: false, fromIso: desde }).fixes).toEqual([]);
  });

  it("el mismo código escrito distinto no es un error; uno vacío se rellena", () => {
    const conLaGuia = [...listado, guia({ guia: "98130498", codigo: "D7MN" })];
    expect(planCodeFixes([manual({ codigo: " d7mn" })], conLaGuia, { trusted: true, fromIso: desde }).fixes).toEqual([]);
    expect(planCodeFixes([manual({ codigo: null })], conLaGuia, { trusted: true, fromIso: desde }).fixes).toEqual([
      { candidate: manual({ codigo: null }), codigo: "D7MN" },
    ]);
  });

  it("con dos códigos para la misma guía no se elige ninguno", () => {
    const dudoso = [...listado, guia({ guia: "98130498", codigo: "D7MN" }), guia({ guia: "98130498", codigo: "V929" })];
    const plan = planCodeFixes([manual()], dudoso, { trusted: true, fromIso: desde });
    expect(plan.fixes).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("una guía que el listado no trae se avisa, solo si el listado cubre su fecha", () => {
    // #KP137999: 98058249, registrada el 01-10, nunca apareció en el listado.
    const perdida = manual({ guideCode: "98058249", shipmentId: "s-137999", codigo: "AB12" });
    expect(planCodeFixes([perdida], listado, { trusted: true, fromIso: desde }).missing).toEqual([perdida]);
    // Aunque el código no se haya comprobado: el número no depende de eso.
    expect(planCodeFixes([perdida], listado, { trusted: false, fromIso: desde }).missing).toEqual([perdida]);
    // Registrada antes de lo que cubre el listado: su ausencia no dice nada.
    const vieja = manual({ guideCode: "98058249", createdAt: "2026-09-01T10:00:00Z" });
    expect(planCodeFixes([vieja], listado, { trusted: true, fromIso: desde }).missing).toEqual([]);
    const sinFecha = manual({ guideCode: "98058249", createdAt: null });
    expect(planCodeFixes([sinFecha], listado, { trusted: true, fromIso: desde }).missing).toEqual([]);
  });
});

describe("desde cuándo se pide el listado", () => {
  const DAY = 86_400_000;
  const now = Date.parse("2026-10-11T19:00:00Z");

  it("dos días antes del pedido más viejo, si cae dentro de lo que Shalom entrega", () => {
    expect(listingFromDate(Date.parse("2026-10-01T15:00:00Z"), now)).toBe("2026-09-29");
  });

  it("nunca antes de la ventana del listado (~45 días): pedirlo más atrás no trae nada", () => {
    // El 11-10-2026 se pidió desde el 19-08 y faltaron justo las 160 guías de
    // la API anteriores al 27-08: Shalom no las entrega.
    expect(LISTING_WINDOW_DAYS).toBe(44);
    expect(listingFromDate(Date.parse("2026-08-21T12:00:00Z"), now)).toBe(
      new Date(now - LISTING_WINDOW_DAYS * DAY).toISOString().slice(0, 10),
    );
  });

  it("sin pedidos con fecha, la ventana manda", () => {
    expect(listingFromDate(Number.POSITIVE_INFINITY, now)).toBe("2026-10-09");
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

  it("Shalom recorta la página por debajo de `perPage`: se siguen pidiendo páginas", async () => {
    // Lo que pasó el 10-10-2026: se pidieron 500 y llegaron 200. Medir el final
    // contra `perPage` daba el listado por entero en la página 1.
    const r = await collectListingPages(paginas(23, 4), { perPage: 10, maxPages: 10, deadlineMs: Date.now() + 60_000 });
    expect(r).toMatchObject({ completo: true, paginas: 6 });
    expect(r.orders).toHaveLength(23);
  });

  it("recortada y exacta: el final es la página vacía", async () => {
    const r = await collectListingPages(paginas(8, 4), { perPage: 10, maxPages: 10, deadlineMs: Date.now() + 60_000 });
    expect(r).toMatchObject({ completo: true, paginas: 3 });
    expect(r.orders).toHaveLength(8);
  });

  it("una sola página corta se confirma con la siguiente vacía", async () => {
    const r = await collectListingPages(paginas(3, 10), { perPage: 10, maxPages: 5, deadlineMs: Date.now() + 60_000 });
    expect(r).toMatchObject({ completo: true, paginas: 2 });
    expect(r.orders).toHaveLength(3);
  });

  it("de a tres a la vez lee lo mismo, en orden, y para en la página corta", async () => {
    const pedidas: number[] = [];
    let enVuelo = 0;
    let maxEnVuelo = 0;
    const lenta = async (page: number) => {
      pedidas.push(page);
      enVuelo += 1;
      maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
      await new Promise((r) => setTimeout(r, 5));
      enVuelo -= 1;
      return paginas(23, 4)(page);
    };
    const r = await collectListingPages(lenta, { perPage: 10, maxPages: 20, deadlineMs: Date.now() + 60_000, concurrency: 3 });
    expect(r).toMatchObject({ completo: true, paginas: 6 });
    expect(r.orders.map((o) => o.id)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(maxEnVuelo).toBe(3);
    // Dos tandas: 1-3 y 4-6. La 6 es la corta; no se pide una tercera tanda.
    expect([...pedidas].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("de a tres, la tanda que trae la vacía también cierra el listado", async () => {
    const r = await collectListingPages(paginas(12, 4), { perPage: 10, maxPages: 20, deadlineMs: Date.now() + 60_000, concurrency: 3 });
    expect(r).toMatchObject({ completo: true, paginas: 4 });
    expect(r.orders).toHaveLength(12);
  });

  it("de a tres, si una página falla, falla el listado (no se da por entero)", async () => {
    const falla = async (page: number) => {
      if (page === 2) throw new Error("No hubo respuesta de Shalom");
      return paginas(100, 10)(page);
    };
    await expect(
      collectListingPages(falla, { perPage: 10, maxPages: 20, deadlineMs: Date.now() + 60_000, concurrency: 3 }),
    ).rejects.toThrow("No hubo respuesta");
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

describe("una sola puerta para registrar una guía existente", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("el drawer y Cotejar Shalom registran por el mismo camino", () => {
    expect(read("app/dashboard/pedidos/shalom-actions.ts")).toContain("registerExistingShalomGuide(");
    const cotejo = read("lib/shalom/account-cotejo.ts");
    expect(cotejo).toContain("registerExistingShalomGuide(");
    // El cron no es una persona: no firma con nadie y no se inventa la clave.
    // La del listado entra solo si esta lectura la comprobó (12-10-2026).
    expect(cotejo).toContain("actor: null");
    expect(cotejo).toContain("onlyIfNew: true");
    expect(cotejo).toContain("usableListingKey(listingKeys.get(guide.guia), keyTrusted)");
  });

  it("registrar la clave no es darla: ni el drawer ni el cotejo escriben `key_shared` al guardarla", () => {
    // `key_shared` es «la clave salió hacia la clienta» y el retorno de §12 lo
    // lee como que pudo recogerla (lib/shalom/pickup-facts.ts).
    const facts = read("lib/shalom/pickup-facts.ts");
    expect(facts).toContain('const KEY_GIVEN_EVENTS = ["key_view", "key_shared"];');
    expect(read("lib/shalom/account-cotejo.ts")).toContain('KEY_REGISTERED_EVENT = "key_registered"');
    const acciones = read("app/dashboard/pedidos/payment-actions.ts");
    const setPickupKey = acciones.slice(acciones.indexOf("export async function setPickupKey"), acciones.indexOf("export async function revealPickupKey"));
    expect(setPickupKey).toContain('kind: "key_registered"');
    expect(setPickupKey).not.toContain('kind: "key_shared"');
  });

  it("el código del listado entra solo comprobado, y la guía desconocida se avisa una vez", () => {
    const cotejo = read("lib/shalom/account-cotejo.ts");
    expect(cotejo).toContain("planCodeFixes(waitingCode, guides, { trusted: codeTrusted, fromIso })");
    expect(cotejo).toContain('GUIDE_CHECK_EVENT = "guide_check"');
    // La escritura exige el código que se leyó: no pisa una corrección de otra persona.
    expect(cotejo).toContain('update.is("shalom_codigo", null) : update.eq("shalom_codigo", m.codigo)');
  });

  it("el rastreo pregunta primero por la que hace más que no contesta, al ritmo del cupo", () => {
    const rastreo = read("app/api/cron/shalom-reconcile/route.ts");
    expect(rastreo).toContain('.order("last_report_at", { ascending: true, nullsFirst: true })');
    expect(rastreo).not.toContain('.order("updated_at", { ascending: true })');
    expect(rastreo).toContain("if (isShalomRateLimited(err)) {");
    expect(rastreo).toContain("const espera = quota.waitFor(slice.length);");
    expect(rastreo).toContain("shalomTrackItem(g, SHALOM_ORIGIN.manual)");
    expect(rastreo).toContain("const TRACK_BUDGET_MS = 90_000;");
    expect(rastreo).toContain('"[shalom-reconcile]"');
  });

  it("el cotejo tiene cron propio, fuera del rastreo de media hora", () => {
    // Colgado del final de shalom-reconcile se quedaba sin tiempo para bajar el
    // listado (10-10-2026, 16:00): no vuelve ahí.
    expect(read("app/api/cron/shalom-cotejo/route.ts")).toContain("cotejarShalom(");
    expect(read("app/api/cron/shalom-reconcile/route.ts")).not.toContain("cotejarShalom(");
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

  it("y el código de la guía manual (15-10-2026)", () => {
    expect(mom).toContain("#### El código de la guía manual y el rastreo");
    expect(mom).toContain("`guide_check`");
    expect(mom).toContain("`codigosCorregidos`");
    expect(mom).toContain("`[shalom-reconcile]`");
    expect(mom).toContain("**120 guías de\n  una vez que se reponen a 2 por segundo**");
    expect(mom).toContain("El rastreo tiene **90 s** por pasada");
  });

  it("y la clave de recojo del listado (12-10-2026)", () => {
    expect(mom).toContain("**La clave de recojo del listado, solo si se comprueba**");
    expect(mom).toContain("`key_registered`");
    expect(mom).toContain("Clave de recojo tomada del listado de Shalom Pro (Cotejar Shalom).");
    expect(mom).toContain("`clavesRellenadas`");
  });
});
