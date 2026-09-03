import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalProductHandles,
  hasProductLink,
  leadProductHandle,
  productLabel,
} from "@/lib/leads";

/**
 * Filtrar la cola POR PRODUCTO.
 *
 * De dónde sale el dato: el 32 % de los leads sin llamar (602 de 1.902) llegan
 * desde la ficha de un producto, con la URL prellenada en su primer mensaje:
 *
 *   "https://kenku.pe/products/hgh-crecimiento-optimo-… Tengo una consulta"
 *
 * Y se concentran: 190 esperando por el aceite de semilla negra, 74 por HGH, 55
 * por el suplemento de hígado. Eso es una tanda de llamadas con el mismo
 * argumentario, no 190 conversaciones distintas — pero solo si la pantalla deja
 * juntarlas.
 */

describe("qué producto abrió el cliente", () => {
  it("saca el handle del link que trae su primer mensaje", () => {
    expect(
      leadProductHandle("https://kenku.pe/products/hgh-crecimiento-optimo-y-desarrollo-fisico-120-capsulas Tengo una consulta"),
    ).toBe("hgh-crecimiento-optimo-y-desarrollo-fisico-120-capsulas");
  });

  it("corta en la variante y en la ruta: la ficha es una, la talla es otra cosa", () => {
    expect(leadProductHandle("https://aurela.pe/products/softflex?variant=4423")).toBe("softflex");
    expect(leadProductHandle("https://aurela.pe/products/softflex/reviews")).toBe("softflex");
  });

  it("normaliza a minúsculas: el mismo producto no puede contar dos veces", () => {
    expect(leadProductHandle("https://kenku.pe/products/SoftFlex")).toBe("softflex");
  });

  it("sin link no inventa producto", () => {
    expect(leadProductHandle("Hola buen día")).toBeNull();
    expect(leadProductHandle(null)).toBeNull();
    expect(leadProductHandle("https://kenku.pe/collections/ofertas")).toBeNull();
  });

  it("va de la mano con el segmento: si hay link, hay producto", () => {
    // `hasProductLink` decide el segmento «📍 Distrito o producto» y esta función
    // decide el filtro. Si divergieran, el chip diría 732 y el desplegable
    // sumaría otra cosa, y no habría forma de saber cuál miente. Medido contra
    // producción: de 4.887 leads con link, los 4.887 dan handle.
    for (const texto of [
      "https://kenku.pe/products/nattokinase-mejora-la-circulacion-arterial-90-capsulas Tengo una consulta",
      "mira esto https://aurela.pe/products/pelador-de-verduras-y-abridor",
      "https://kenku.pe/products/superhuman?utm_source=ig",
    ]) {
      expect(hasProductLink(texto), texto).toBe(true);
      expect(leadProductHandle(texto), texto).not.toBeNull();
    }
  });
});

describe("un link cortado no abre un producto nuevo", () => {
  // EL CASO REAL. `…-alta-potencia-60-softgels` tiene 1.349 leads y
  // `…-alta-potencia-60-softge` tiene 1: el mismo producto con la URL cortada a
  // media palabra. Dos entradas en el desplegable para lo mismo, y el contador
  // —que es para lo que sirve el filtro— mintiendo en las dos.
  const LARGO = "purely-nutrient-ethiopian-black-seed-oil-aceite-de-semilla-negra-etiope-alta-potencia-60-softgels";
  const CORTADO = "purely-nutrient-ethiopian-black-seed-oil-aceite-de-semilla-negra-etiope-alta-potencia-60-softge";

  it("el recorte se pliega en el handle completo", () => {
    const canon = canonicalProductHandles([LARGO, CORTADO]);
    expect(canon.get(CORTADO)).toBe(LARGO);
    expect(canon.get(LARGO)).toBe(LARGO);
  });

  it("PERO «superhuman» NO se pliega en «superhuman-focus-…»: son dos productos", () => {
    // Los dos existen en producción, con 5 y 2 leads. Plegar todo prefijo —que
    // es la regla obvia y la equivocada— los juntaría y el equipo llamaría a
    // cinco personas ofreciéndoles el producto que no preguntaron.
    const canon = canonicalProductHandles([
      "superhuman",
      "superhuman-focus-nootropico-natural-para-un-maximo-rendimiento-mental",
    ]);
    expect(canon.get("superhuman")).toBe("superhuman");
  });

  it("la frontera es el guion: palabra entera = otro producto, palabra partida = recorte", () => {
    expect(canonicalProductHandles(["pack", "pack-navideno"]).get("pack")).toBe("pack");
    expect(canonicalProductHandles(["packa", "packard"]).get("packa")).toBe("packard");
  });

  it("MANDA LA FRECUENCIA, NO LA LONGITUD", () => {
    // ESTO ES LO QUE CASI SE ROMPE, y estuvo mergeado. La primera versión
    // plegaba el corto dentro del largo dando por hecho que el largo es el
    // bueno. En producción está el contraejemplo:
    //
    //   …-60-softgels        1.349 leads  ← el handle de verdad
    //   …-60-softgelsKENKU10     1 lead   ← alguien pegó el cupón sin separador
    //
    // Con la regla vieja los 1.349 se mudaban al balde del typo: el desastre
    // exacto que la regla existía para evitar, por el lado que no se miró.
    const canon = canonicalProductHandles([
      ...Array<string>(1349).fill(LARGO),
      CORTADO,
      `${LARGO}kenku10`,
    ]);
    expect(canon.get(LARGO)).toBe(LARGO);
    expect(canon.get(CORTADO)).toBe(LARGO);
    expect(canon.get(`${LARGO}kenku10`)).toBe(LARGO);
  });

  it("una familia encadenada tiene UN solo ganador", () => {
    // `softge` ⊂ `softgels` ⊂ `softgelsKENKU10`: el primero y el último solo se
    // relacionan a través del de en medio. Resolver de a pares dejaba cadenas
    // que no cerraban —uno apuntando a otro que apunta a un tercero— y el
    // contador sumaba en dos baldes distintos.
    const canon = canonicalProductHandles(["fee", "feels", "feels", "feelsgood"]);
    expect(new Set(canon.values()).size).toBe(1);
    expect(canon.get("fee")).toBe("feels"); // el más votado, no el más largo
  });

  it("a igualdad de votos gana el largo: cortarse es el daño común", () => {
    // 494 mensajes llegaron recortados, 413 con link; pegar basura al final
    // pasó UNA vez. Cuando la frecuencia no dice nada, se apuesta a eso.
    const canon = canonicalProductHandles([CORTADO, LARGO]);
    expect(canon.get(CORTADO)).toBe(LARGO);
  });

  it("un handle solo se queda como está", () => {
    expect(canonicalProductHandles(["softflex"]).get("softflex")).toBe("softflex");
    expect(canonicalProductHandles([]).size).toBe(0);
  });
});

describe("la etiqueta se lee", () => {
  it("el handle se convierte en algo que una persona reconoce", () => {
    expect(productLabel("feel-virgin-gel-intimo-reafirmante")).toBe("Feel virgin gel intimo reafirmante");
    expect(productLabel("softflex")).toBe("Softflex");
  });

  it("no se rompe con un handle raro", () => {
    expect(productLabel("")).toBe("");
    expect(productLabel("---")).toBe("---");
  });
});

describe("el filtro es una faceta de verdad", () => {
  const source = readFileSync(resolve(process.cwd(), "components/leads.tsx"), "utf8");

  it("entra en facetItems, así que los contadores respetan la jerarquía", () => {
    // Filtrar DESPUÉS de facetear dejaría los contadores de Fuente, Número y
    // Ventana contando leads que el filtro de producto ya descartó: números que
    // no suman lo que muestran. Es el fallo que este repo repite.
    expect(source).toMatch(/facetItems\(leads, \{[^}]*prod: matchProd/s);
    expect(source).toContain('facets.except("prod")');
  });

  it("el producto se resuelve una vez sobre la cola entera", () => {
    // El plegado de recortes necesita ver todos los handles: resolverlo lead a
    // lead no podría saber que `…-60-softge` es `…-60-softgels`.
    expect(source).toContain("canonicalProductHandles(crudo.values())");
  });

  it("«Sin producto» existe: el resto tiene que estar para que la suma cuadre", () => {
    expect(source).toContain('label: "Sin producto"');
  });

  it("cuenta como filtro activo y se va con «limpiar»", () => {
    // Un filtro que no aparece en el badge es un filtro que alguien deja puesto
    // sin darse cuenta y luego jura que faltan leads.
    expect(source).toContain("(prodFilter.size > 0 ? 1 : 0)");
    expect(source).toContain("setProdFilter(new Set());");
  });
});
