import { describe, it, expect } from "vitest";
import {
  buildSwaypGuideInput,
  buildContenido,
  esCiudadPorApiSwayp,
  parseSenders,
  PLACEHOLDER_NIT,
  type SwaypSender,
} from "@/lib/swayp-guide";

const SENDER: SwaypSender = {
  nombre: "Kenku",
  nit: "20600000000",
  direccion: "Av. Ejercito 123",
  telefono: "959000000",
  email: "ventas@kenku.pe",
};

const senders = { arequipa: SENDER, cusco: SENDER };

const base = {
  city: "arequipa",
  district: "Yanahuara",
  customerName: "Juan Pérez",
  customerPhone: "959111222",
  address1: "Calle Misti 100",
  reference: "Frente al parque",
  lineItems: [{ title: "Cápsulas X", quantity: 2 }],
  codAmount: 129,
  senders,
};

describe("buildContenido", () => {
  it("uses Swayp's «cantidad x producto» notation", () => {
    expect(buildContenido([{ title: "Camiseta", quantity: 2 }, { title: "Pantalón", quantity: 1 }]))
      .toBe("2 x Camiseta, 1 x Pantalón");
  });

  it("floors quantity at 1 and drops blank titles", () => {
    expect(buildContenido([{ title: "X", quantity: 0 }, { title: "  ", quantity: 3 }])).toBe("1 x X");
  });
});

describe("buildSwaypGuideInput", () => {
  it("maps a complete shipment", () => {
    const r = buildSwaypGuideInput(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.ciudadRemitente).toBe("040101"); // bodega Arequipa
    expect(r.input.ciudadDestinatario).toBe("040126"); // Yanahuara
    expect(r.input.nombreDestinatario).toBe("Juan Pérez");
    expect(r.input.telefonoDestinatario).toBe("959111222");
    expect(r.input.direccionDestinatario).toBe("Calle Misti 100");
    // Swayp concatena este campo al final de la dirección SIN separador, así
    // que lo lleva incorporado (verificado sobre una guía real).
    expect(r.input.adicionalDireccion).toBe(" - Frente al parque");
    expect(r.input.contenido).toBe("2 x Cápsulas X");
    expect(r.input.valorRecaudo).toBe("129");
    expect(r.input.nitDestinatario).toBe(PLACEHOLDER_NIT);
    expect(r.input.telefonoRecogida).toBe(SENDER.telefono);
  });

  describe("idBusiness", () => {
    // La documentación lo marca obligatorio; el entorno de pruebas acepta la
    // guía sin él. Se manda cuando está configurado y se omite cuando no, en
    // vez de mandar un 0 que Swayp leería como un comercio.
    it("lo incluye cuando es un número positivo", () => {
      const r = buildSwaypGuideInput({ ...base, idBusiness: 69956 });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.input.idBusiness).toBe(69956);
    });

    it("lo omite —no lo manda vacío— cuando no está configurado", () => {
      for (const idBusiness of [null, undefined, 0, -1, Number.NaN]) {
        const r = buildSwaypGuideInput({ ...base, idBusiness });
        expect(r.ok, String(idBusiness)).toBe(true);
        if (r.ok) expect(r.input, String(idBusiness)).not.toHaveProperty("idBusiness");
      }
    });
  });

  it("refuses an inexact district — a cercado fallback would misroute the package", () => {
    const r = buildSwaypGuideInput({ ...base, district: "Distrito Inventado" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/distrito/i);
  });

  it("refuses a city with no warehouse configured", () => {
    const r = buildSwaypGuideInput({ ...base, city: "trujillo" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/bodega/i);
  });

  it("refuses a city outside Swayp coverage", () => {
    const r = buildSwaypGuideInput({ ...base, city: "lima", senders: { lima: SENDER } });
    expect(r.ok).toBe(false);
  });

  // SWAYP_SENDERS es la frontera entre «va por API» y «va por Excel», y no hay
  // otra: la reprogramación pide el número a Swayp y cae al código local cuando
  // esto falla. Hoy sólo Arequipa está habilitada. Si alguien hiciera opcional
  // la bodega, la frontera desaparecería en silencio y saldrían guías por API
  // de ciudades que Swayp no atiende.
  describe("SWAYP_SENDERS decide qué ciudades van por API", () => {
    const soloArequipa = { arequipa: SENDER };

    it("la ciudad configurada arma el payload", () => {
      expect(buildSwaypGuideInput({ ...base, city: "arequipa", senders: soloArequipa }).ok).toBe(true);
    });

    it("una ciudad de cobertura SIN bodega se rechaza, y dice cuál", () => {
      const r = buildSwaypGuideInput({ ...base, city: "cusco", district: "Cusco", senders: soloArequipa });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain("cusco");
      expect(r.error).toMatch(/bodega/i);
    });

    it("sin ninguna bodega configurada no sale nada por API", () => {
      expect(buildSwaypGuideInput({ ...base, city: "arequipa", senders: {} }).ok).toBe(false);
    });
  });

  /**
   * El aviso del drawer («el número lo emite Swayp» vs «con código local») sale
   * de `esCiudadPorApiSwayp`, y el botón de `buildSwaypGuideInput`. Son dos
   * funciones distintas leyendo la misma configuración: si se separan, la
   * pantalla promete una cosa y la acción hace otra —que es exactamente el bug
   * de la cobertura, la cola diciendo «Fenix Ok» sobre un envío que el botón
   * rechazaba—. Esto las ata.
   */
  describe("el aviso del drawer no puede contradecir al botón", () => {
    const ciudades = ["arequipa", "cusco", "puno", "trujillo", "lima", "tacna", "inventada"];

    it("si el aviso dice «por API», el payload no falla por ciudad ni por bodega", () => {
      for (const city of ciudades) {
        if (!esCiudadPorApiSwayp(city, senders)) continue;
        const r = buildSwaypGuideInput({ ...base, city, district: city });
        // Puede fallar por el envío concreto (distrito, dirección, teléfono),
        // pero NUNCA por las dos rejas que el aviso ya prometió.
        if (!r.ok) {
          expect(r.error, city).not.toMatch(/bodega/i);
          expect(r.error, city).not.toMatch(/no es una ciudad con cobertura/i);
        }
      }
    });

    it("si el aviso dice «código local», el payload falla por una de esas dos", () => {
      for (const city of ciudades) {
        if (esCiudadPorApiSwayp(city, senders)) continue;
        const r = buildSwaypGuideInput({ ...base, city, district: city });
        expect(r.ok, city).toBe(false);
        if (r.ok) continue;
        expect(r.error, city).toMatch(/bodega|no es una ciudad con cobertura/i);
      }
    });

    it("sin bodegas configuradas, ninguna ciudad va por API", () => {
      for (const city of ciudades) expect(esCiudadPorApiSwayp(city, {}), city).toBe(false);
    });

    it("una bodega configurada para una ciudad que Swayp no cubre NO va por API", () => {
      // Configurar Lima en el JSON no la habilita: el ubigeo de bodega manda.
      expect(esCiudadPorApiSwayp("lima", { lima: SENDER })).toBe(false);
    });
  });

  // #KP131632: el pedido no tenía dirección y la ciudad llegaba vacía. El motivo
  // salía «No hay bodega Swayp configurada para .», que no le dice nada a nadie.
  it("una ciudad vacía dice que falta el destino, no que falte la bodega", () => {
    const r = buildSwaypGuideInput({ ...base, city: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/destino/i);
    expect(r.error).not.toMatch(/bodega/i);
  });

  /**
   * Los productos van por CÓDIGO. Swayp acepta las dos formas y descarta la del
   * nombre: «tiende a ser inestable porque se busca por nombre y no por código».
   * Un nombre que deja de coincidir no da error, deja de descontar stock.
   */
  describe("productos: el mapa es el interruptor", () => {
    const conSku = [{ title: "Cándida Cleanse - Fórmula Ayurvédica (90 Cápsulas)", quantity: 2, sku: "765545233" }];
    const mapa = new Map([["765545233", { codbar: "AURE001", nombre: "CANDIDA CLEANSE" }]]);

    it("sin mapa manda el título, como hasta hoy", () => {
      // Una tienda que todavía no vinculó nada no deja de crear guías el día
      // del despliegue. Es el respaldo, no el camino: buscar por nombre es lo
      // que su propio desarrollador llama inestable.
      const r = buildSwaypGuideInput({ ...base, lineItems: conSku });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.input.contenido).toContain("Cándida Cleanse");
    });

    it("con mapa, `contenido` lleva el CÓDIGO y nada más", () => {
      // El formato que pidieron por escrito: «CANTIDAD X SKU». Sin paréntesis,
      // sin nombre: no conocemos la gramática de su buscador y texto de más
      // puede hacer que no encuentre el producto — sin error y sin descuento.
      const r = buildSwaypGuideInput({ ...base, lineItems: conSku, skuMap: mapa });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.input.contenido).toBe("2 x AURE001");
      expect(r.input.contenido).not.toMatch(/[()]/);
      expect(r.input.contenido).not.toMatch(/Cándida/);
    });

    it("y `observaciones` lleva LO MISMO en legible", () => {
      const r = buildSwaypGuideInput({ ...base, lineItems: conSku, skuMap: mapa });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.input.observaciones).toBe("2 x CANDIDA CLEANSE");
    });

    it("la nota del operador se conserva junto al resumen", () => {
      const r = buildSwaypGuideInput({
        ...base, lineItems: conSku, skuMap: mapa, observaciones: "Entregar por la tarde",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.input.observaciones).toContain("2 x CANDIDA CLEANSE");
      expect(r.input.observaciones).toContain("Entregar por la tarde");
    });

    it("NO se manda `productos[]` mientras Swayp no lo confirme", () => {
      // Un campo que quizá no procesan puede devolver 400 y dejar al envío sin
      // guía. Los códigos ya viajan en `contenido`.
      const r = buildSwaypGuideInput({ ...base, lineItems: conSku, skuMap: mapa });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.input).not.toHaveProperty("productos");
    });

    it("con mapa encendido, un producto sin vincular RECHAZA la guía y lo nombra", () => {
      const r = buildSwaypGuideInput({
        ...base,
        lineItems: [...conSku, { title: "Pulsera Magnética", quantity: 1, sku: "64565434" }],
        skuMap: mapa,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain("Pulsera Magnética");
      expect(r.error).toMatch(/cat[áa]logo/i);
    });
  });

  it("refuses an address shorter than the API's 5-character minimum", () => {
    const r = buildSwaypGuideInput({ ...base, address1: "Av." });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/dirección/i);
  });

  it("refuses a shipment with no name, phone or products", () => {
    expect(buildSwaypGuideInput({ ...base, customerName: "  " }).ok).toBe(false);
    expect(buildSwaypGuideInput({ ...base, customerPhone: null }).ok).toBe(false);
    expect(buildSwaypGuideInput({ ...base, lineItems: [] }).ok).toBe(false);
  });

  it("keeps valorDeclarado non-zero when there is no COD", () => {
    const r = buildSwaypGuideInput({ ...base, codAmount: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.valorRecaudo).toBe("0");
    expect(r.input.valorDeclarado).toBe("1");
  });

  it("omits the optional fields instead of sending empty strings", () => {
    const r = buildSwaypGuideInput({ ...base, reference: null, observaciones: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.adicionalDireccion).toBeUndefined();
    expect(r.input.observaciones).toBeUndefined();
    expect(r.input.fechaEntrega).toBeUndefined();
  });

  it("passes the dispatch date through as fechaEntrega", () => {
    const r = buildSwaypGuideInput({ ...base, dispatchDateIso: "2026-08-01T00:00:00.000Z" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.fechaEntrega).toBe("2026-08-01T00:00:00.000Z");
  });

  it("ships Puno out of the Juliaca warehouse (verified live)", () => {
    const r = buildSwaypGuideInput({
      ...base,
      city: "puno",
      district: "Puno",
      senders: { puno: SENDER },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.ciudadRemitente).toBe("211101");
    expect(r.input.ciudadDestinatario).toBe("210101");
  });
});

/**
 * `idWarehouse` importa desde que hay más de una bodega. Con una sola, Swayp la
 * deducía del ubigeo de origen; con cuatro ya no siempre — Juliaca y Puno
 * COMPARTEN bodega (211101), así que el ubigeo no las distingue. Sin el campo
 * elige Swayp, y si elige mal descuenta del inventario de otra ciudad.
 */
describe("idWarehouse", () => {
  const conBodega = { ...SENDER, idWarehouse: 132 };

  it("se manda cuando la ciudad lo tiene configurado", () => {
    const r = buildSwaypGuideInput({ ...base, senders: { arequipa: conBodega } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.idWarehouse).toBe(132);
  });

  it("se OMITE cuando no está, en vez de mandar 0", () => {
    // Un 0 Swayp lo leería como una bodega, no como «no sé».
    const r = buildSwaypGuideInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input).not.toHaveProperty("idWarehouse");
  });

  it("acepta el id como número o como cadena", () => {
    // En un JSON escrito a mano llega igual de fácil 132 que "132"; rechazar la
    // segunda forma no protege de nada.
    const p = parseSenders(JSON.stringify({ arequipa: { ...SENDER, idWarehouse: "132" } }));
    expect(p.arequipa?.idWarehouse).toBe(132);
  });

  it("un id inválido descarta esa ciudad entera, no manda basura", () => {
    for (const idWarehouse of [0, -1, 1.5, "abc", null]) {
      const p = parseSenders(JSON.stringify({ arequipa: { ...SENDER, idWarehouse } }));
      expect(p.arequipa, String(idWarehouse)).toBeUndefined();
    }
  });

  it("Juliaca y Puno comparten ubigeo de bodega pero pueden llevar ids distintos", () => {
    // Es el caso que justifica el campo: mismo 211101, dos entradas.
    const senders = {
      juliaca: { ...SENDER, idWarehouse: 211 },
      puno: { ...SENDER, idWarehouse: 211 },
    };
    const j = buildSwaypGuideInput({ ...base, city: "juliaca", district: "Juliaca", senders });
    const pu = buildSwaypGuideInput({ ...base, city: "puno", district: "Puno", senders });
    expect(j.ok && pu.ok).toBe(true);
    if (j.ok && pu.ok) {
      expect(j.input.ciudadRemitente).toBe(pu.input.ciudadRemitente); // misma bodega
      expect(j.input.ciudadDestinatario).not.toBe(pu.input.ciudadDestinatario); // distinto destino
    }
  });
});

describe("parseSenders", () => {
  it("parses a valid map", () => {
    const p = parseSenders(JSON.stringify({ arequipa: SENDER }));
    expect(p.arequipa?.nombre).toBe("Kenku");
  });

  /**
   * Una ciudad rota se cae SOLA. Antes `z.record` validaba el objeto entero: un
   * dedazo configurando Trujillo dejaba a Arequipa sin API y nadie relacionaba
   * una cosa con la otra. Con cuatro bodegas eso era cuestión de tiempo.
   */
  it("una ciudad inválida no se lleva por delante a las demás", () => {
    const p = parseSenders(
      JSON.stringify({
        arequipa: SENDER,
        trujillo: { nombre: "Kenku" }, // incompleta
        piura: SENDER,
      }),
    );
    expect(Object.keys(p).sort()).toEqual(["arequipa", "piura"]);
  });

  it("returns {} for blank, malformed JSON or an invalid shape", () => {
    // A config typo must not take down the shipments page — it only disables
    // API creation, which falls back to the manual flow.
    expect(parseSenders(undefined)).toEqual({});
    expect(parseSenders("")).toEqual({});
    expect(parseSenders("{not json")).toEqual({});
    // Con una sola ciudad y esa inválida, el resultado sigue siendo {} — pero
    // ahora porque se descartó ELLA, no porque tirase el objeto entero.
    expect(parseSenders(JSON.stringify({ arequipa: { nombre: "X" } }))).toEqual({});
    expect(parseSenders(JSON.stringify({ arequipa: { ...SENDER, direccion: "abc" } }))).toEqual({});
    expect(parseSenders(JSON.stringify([SENDER]))).toEqual({});
  });
});
