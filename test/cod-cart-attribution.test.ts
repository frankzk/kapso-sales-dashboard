import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  atribuyePedidoWeb,
  construyeCatalogo,
  decodeUtm,
  idsEnUtm,
  nombreDePista,
  normalizaNombreAnuncio,
  type AnuncioMeta,
  type UtmPedido,
} from "@/lib/cod-cart-attribution";

const vacio: UtmPedido = {
  utmId: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
};

const anuncio = (over: Partial<AnuncioMeta> & { adId: string }): AnuncioMeta => ({
  adsetId: null,
  campaignId: null,
  adName: null,
  ...over,
});

describe("decodificar lo que viaja en la URL", () => {
  it("el + es espacio y el resto va escapado", () => {
    expect(decodeUtm("CBO+Ethiopian+%7C+0903")).toBe("CBO Ethiopian | 0903");
    expect(decodeUtm("KC+ETHIOPIAN+3107+%2828%29")).toBe("KC ETHIOPIAN 3107 (28)");
    expect(decodeUtm("CostCap+Black+Seed+Oil+%2F+19.03")).toBe("CostCap Black Seed Oil / 19.03");
  });

  // Sale en los datos reales (%C3%B1 = ñ), y por eso no vale una tabla de
  // reemplazos: hacen falta los dos bytes juntos.
  it("también el UTF-8 de dos bytes", () => {
    expect(decodeUtm("Espa%C3%B1a")).toBe("España");
  });

  // Un pedido con la URL mal formada no puede tumbar el panel entero.
  it("una secuencia rota devuelve lo que había en vez de reventar", () => {
    expect(() => decodeUtm("100%+natural")).not.toThrow();
    expect(decodeUtm("100%+natural")).toBe("100% natural");
  });

  it("nulo y vacío no son un caso especial", () => {
    expect(decodeUtm(null)).toBe("");
    expect(decodeUtm(undefined)).toBe("");
  });
});

describe("los ids que cita un pedido", () => {
  // Los ids de Meta miden 17-18 dígitos. Sin ese suelo, cada número suelto de un
  // nombre de anuncio («KC ETHIOPIAN 3107 (28)») entraría como candidato: no
  // casaría con nada, pero `getMetaAdCatalog` los mete en un `in (…)` para
  // buscarlos en `meta_ads`, y esa lista se llenaría de basura en cada carga.
  it("un número corto de un nombre no es un id", () => {
    expect(
      idsEnUtm({
        ...vacio,
        utmSource: "CBO+KC+Ethiopian+3107",
        utmMedium: "KC+ETHIOPIAN+3107+%2828%29",
      }),
    ).toEqual([]);
  });

  it("los recoge en el orden en que aparecen y sin repetir", () => {
    expect(
      idsEnUtm({
        ...vacio,
        utmId: "120247729650300267",
        utmMedium: "CBO+7-days-nail---120247729650390267",
        utmTerm: "120247729650390267",
      }),
    ).toEqual(["120247729650300267", "120247729650390267"]);
  });
});

describe("el nombre del anuncio que lleva una pista", () => {
  // Shopify escribe `{{ad.name}}---{{ad.id}}` en algunas plantillas.
  it("se le quita el id que algunas plantillas le pegan detrás", () => {
    expect(nombreDePista("7-days-nail+0706+fk+-+Copia---120247729950880267"))
      .toBe("7-days-nail 0706 fk - copia");
  });

  // El id va AL FINAL, que es como Shopify escribe `{{ad.name}}---{{ad.id}}`.
  // No se ha visto ninguna plantilla que pegue algo detrás —las 115 que traen
  // `---` lo llevan terminal—, pero las plantillas las configura cada cuenta a
  // mano y ya difieren entre ellas: sin anclar, un sufijo de más se comería
  // media cola del nombre y el anuncio dejaría de reconocerse.
  it("solo se quita el id si está al final", () => {
    expect(nombreDePista("Creativo+A---120247729950880267+Reels"))
      .toBe("creativo a---120247729950880267 reels");
  });

  // El mismo creativo llega con y sin extensión según la plantilla.
  it("la extensión del vídeo no cuenta", () => {
    expect(normalizaNombreAnuncio("GC ETHIOPIAN (23) 1808 .mp4"))
      .toBe(nombreDePista("GC+ETHIOPIAN+%2823%29+1808+"));
  });

  it("ignora acentos y mayúsculas", () => {
    expect(normalizaNombreAnuncio("Pulsera Cobre PANAMÁ")).toBe("pulsera cobre panama");
  });
});

describe("a qué anuncio pertenece un pedido del carrito COD", () => {
  // Plantilla de «Aurela 8 ACC 2 usd», la única cuenta que manda ids en todos
  // los campos: 92,4% de sus pedidos resuelven a nivel de anuncio.
  it("un id de anuncio en las pistas manda sobre todo lo demás", () => {
    const catalogo = construyeCatalogo([
      anuncio({ adId: "120256069368300212", adsetId: "120254052482600212", campaignId: "120254052482990212", adName: "GC FEEL VIRGEN" }),
    ]);
    const res = atribuyePedidoWeb(
      {
        ...vacio,
        utmId: "120254052482990212",
        utmSource: "facebook",
        utmMedium: "paid",
        utmCampaign: "120254052482990212",
        utmContent: "120256069368300212",
        utmTerm: "120254052482600212",
      },
      catalogo,
    );
    expect(res).toEqual({
      adId: "120256069368300212",
      adsetId: "120254052482600212",
      campaignId: "120254052482990212",
      clase: "ad_id",
    });
  });

  // Plantilla de «Kenku Per 9»: el id del anuncio va detrás del nombre y ANTES
  // aparecen el del conjunto y el de la campaña. Coger el primer número que se
  // encuentre acreditaría al conjunto.
  it("entre varios ids se queda con el que es un anuncio, no con el primero", () => {
    const catalogo = construyeCatalogo([
      anuncio({ adId: "120247729950880267", adsetId: "120247729650390267", campaignId: "120247729650300267" }),
    ]);
    const res = atribuyePedidoWeb(
      {
        ...vacio,
        utmId: "120247729650300267",
        utmSource: "Facebook_Mobile_Reels",
        utmMedium: "CBO+7-days-nail+0706+fk---120247729650390267",
        utmCampaign: "CBO+7-days-nail+%7C+1006---120247729650300267",
        utmContent: "7-days-nail+0706+fk+-+Copia---120247729950880267",
        utmTerm: "120247729650390267",
      },
      catalogo,
    );
    expect(res?.adId).toBe("120247729950880267");
    expect(res?.clase).toBe("ad_id");
  });

  // `utm_id` es la CAMPAÑA: 525 de 592 casan con `campaign_id` y CERO con
  // `ad_id`. Un pedido cuya única señal es el `utm_id` llega hasta la campaña y
  // ahí se queda; devolverlo como anuncio dejaría el panel mal atribuido entero.
  it("utm_id define la campaña y NO llega a anuncio por sí solo", () => {
    const catalogo = construyeCatalogo([
      anuncio({ adId: "120256069368300212", campaignId: "120254052482990212" }),
    ]);
    const res = atribuyePedidoWeb({ ...vacio, utmId: "120254052482990212" }, catalogo);
    expect(res).toEqual({
      adId: null,
      adsetId: null,
      campaignId: "120254052482990212",
      clase: "campaign_id",
    });
  });

  // Plantilla de «Kenku Per 1» y «Kenku Per 10», que juntas son 253 pedidos y
  // S/45.326: mandan NOMBRES donde otras mandan ids. Sin esta regla, el 74% de
  // atribución a nivel de anuncio se queda en el 27%.
  it("sin id, el nombre del anuncio dentro de su campaña", () => {
    const catalogo = construyeCatalogo([
      anuncio({ adId: "a1", campaignId: "120238540415520658", adsetId: "s1", adName: "KC ETHIOPIAN 3107 (28)" }),
      anuncio({ adId: "a2", campaignId: "120238540415520658", adsetId: "s1", adName: "KC ETHIOPIAN 3107 (19)" }),
    ]);
    const res = atribuyePedidoWeb(
      {
        ...vacio,
        utmId: "120238540415520658",
        utmSource: "CBO+KC+Ethiopian+3107",
        utmMedium: "KC+ETHIOPIAN+3107+%2828%29",
        utmCampaign: "CBO+Ethiopian+%7C+0903",
        utmContent: "Facebook_Mobile_Reels",
      },
      catalogo,
    );
    expect(res).toEqual({ adId: "a1", adsetId: "s1", campaignId: "120238540415520658", clase: "ad_name" });
  });

  // Los nombres se repiten entre campañas. Buscar suelto acreditaría a la
  // campaña equivocada, que es peor que no acreditar.
  it("el nombre solo vale DENTRO de la campaña que dice utm_id", () => {
    const catalogo = construyeCatalogo([
      anuncio({ adId: "otra", campaignId: "999", adName: "KC ETHIOPIAN 3107 (28)" }),
    ]);
    const res = atribuyePedidoWeb(
      { ...vacio, utmId: "120238540415520658", utmMedium: "KC+ETHIOPIAN+3107+%2828%29" },
      construyeCatalogo([...catalogo.anuncios.values(), anuncio({ adId: "x", campaignId: "120238540415520658" })]),
    );
    expect(res?.adId).toBeNull();
    expect(res?.campaignId).toBe("120238540415520658");
  });

  // Meta deja duplicar un anuncio con el mismo nombre dentro de la campaña. Son
  // 73 pedidos de 592: acreditar a una de las dos creatividades a cara o cruz
  // es peor que quedarse en la campaña, porque se decide sobre esa fila.
  it("un nombre repetido en la campaña NO resuelve a ninguno de los dos", () => {
    const catalogo = construyeCatalogo([
      anuncio({ adId: "a1", campaignId: "c1", adName: "PULSERA COBRE" }),
      anuncio({ adId: "a2", campaignId: "c1", adName: "PULSERA COBRE" }),
    ]);
    const res = atribuyePedidoWeb({ ...vacio, utmId: "c1", utmMedium: "PULSERA+COBRE" }, catalogo);
    expect(res).toEqual({ adId: null, adsetId: null, campaignId: "c1", clase: "campaign_id" });
  });

  // «Ambiguo» tiene que significar DOS ANUNCIOS DISTINTOS con el mismo nombre,
  // no el mismo anuncio dos veces. El catálogo se arma juntando dos consultas
  // —por campaña y por id— y cruza al cliente como prop: si una fila repetida
  // contara como dos, un anuncio perfectamente identificable se volvería
  // ambiguo y su venta se caería de la tabla sin que nada lo dijera.
  it("el mismo anuncio repetido en el catálogo no lo vuelve ambiguo", () => {
    const repetido = { adId: "a1", adsetId: "s1", campaignId: "c1", adName: "PULSERA COBRE" };
    const catalogo = construyeCatalogo([repetido, { ...repetido }]);
    const res = atribuyePedidoWeb({ ...vacio, utmId: "c1", utmMedium: "PULSERA+COBRE" }, catalogo);
    expect(res?.adId).toBe("a1");
    expect(res?.clase).toBe("ad_name");
  });

  // El conjunto ya no distingue creatividad, pero sí público y puja.
  it("sin anuncio, el conjunto", () => {
    const catalogo = construyeCatalogo([
      anuncio({ adId: "a1", adsetId: "120246271708590658", campaignId: "120238540415520658" }),
    ]);
    const res = atribuyePedidoWeb(
      { ...vacio, utmId: "120238540415520658", utmTerm: "120246271708590658", utmMedium: "nombre+que+no+existe" },
      catalogo,
    );
    expect(res).toEqual({
      adId: null,
      adsetId: "120246271708590658",
      campaignId: "120238540415520658",
      clase: "adset_id",
    });
  });

  // Los pedidos de TikTok traen ids de 16 dígitos que entran en el rango y no
  // casan con nada. Y hay campañas que nunca se sincronizaron. Son 67 de 592 y
  // tienen que salir como lo que son: sin atribuir.
  it("lo que no se reconoce se queda sin atribuir, no se adivina", () => {
    const catalogo = construyeCatalogo([anuncio({ adId: "a1", campaignId: "c1" })]);
    expect(
      atribuyePedidoWeb(
        {
          ...vacio,
          utmId: "1873466038647842",
          utmSource: "tiktok",
          utmMedium: "paid",
          utmCampaign: "Drenaje+Linfatico++%7C+Sales20260717105021",
        },
        catalogo,
      ),
    ).toBeNull();
    expect(atribuyePedidoWeb(vacio, catalogo)).toBeNull();
  });

  it("un catálogo vacío no revienta", () => {
    expect(atribuyePedidoWeb({ ...vacio, utmId: "c1" }, construyeCatalogo([]))).toBeNull();
  });
});

// La regla puede estar bien pensada y no llegar a ninguna parte. Estas guardas
// leen el fuente para probar que llega a las dos pantallas y a la base.
describe("el arreglo llega al código que corre", () => {
  const lee = (ruta: string) => readFileSync(new URL(`../${ruta}`, import.meta.url), "utf8");
  const access = lee("lib/access.ts");
  const consolidado = lee("app/dashboard/page.tsx");
  const porTienda = lee("app/dashboard/[storeId]/page.tsx");
  const panel = lee("components/executive-dashboard.tsx");
  const migracion = lee("db/migrations/0156_orders_utm_meta.sql");

  // Leer `raw` para filtrar 30 días tardaba 2.953 ms y tocaba 30.304 buffers
  // por carga del tablero. La 0155 existe por esta misma clase de lectura.
  it("lee la columna generada y NUNCA el raw", () => {
    const bloque = access.slice(
      access.indexOf("export async function getWebAdOrders"),
      access.indexOf("export async function getMetaAdCatalog"),
    );
    expect(bloque).toContain('.not("utm_meta", "is", null)');
    expect(bloque).not.toContain("note_attributes");
    expect(bloque).not.toMatch(/select\([^)]*\braw\b/);
  });

  // Ni uno de los 591 pedidos del carrito COD lleva la etiqueta `kapso`, que es
  // la que filtra `getOrders`. Ponerla aquí devolvería siempre cero.
  it("no filtra por la etiqueta kapso, que estos pedidos no llevan", () => {
    const bloque = access.slice(
      access.indexOf("export async function getWebAdOrders"),
      access.indexOf("export async function getMetaAdCatalog"),
    );
    expect(bloque).not.toContain('contains("tags"');
  });

  it("las dos pantallas los cargan y se los pasan al panel", () => {
    for (const pagina of [consolidado, porTienda]) {
      expect(pagina).toContain("getWebAdOrders(");
      expect(pagina).toContain("getMetaAdCatalog(");
      expect(pagina).toContain("webAdOrders={webAdOrders}");
      expect(pagina).toContain("metaAdCatalog={metaAdCatalog}");
    }
  });

  // Sin esto el ROAS ENTREGADO de un anuncio que vende por la web saldría en
  // cero, y el panel diría que entrega nada de lo que vende.
  it("la entrega se consulta también para los pedidos web", () => {
    for (const pagina of [consolidado, porTienda]) {
      const bloque = pagina.slice(pagina.indexOf("getCampaignDeliveryOutcomes(["));
      expect(bloque.slice(0, 260)).toContain("w.order.id");
    }
  });

  it("el panel se los pasa al cálculo y enseña lo que quedó sin anuncio", () => {
    expect(panel).toContain("webAdOrders ?? []");
    expect(panel).toContain("metaAdCatalog ?? []");
    expect(panel).toContain("webNoAtribuido(");
    expect(panel).toContain("webSuelto.pedidos > 0");
  });

  it("la columna es generada y almacenada, y su índice es parcial", () => {
    const sinComentarios = migracion.replace(/^--.*$/gm, "");
    expect(sinComentarios).toMatch(/utm_meta\s+jsonb\s+generated\s+always\s+as/i);
    expect(sinComentarios).toContain("stored");
    expect(sinComentarios).toMatch(/create index[\s\S]*where utm_meta is not null/i);
  });
});
