import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adProductDeclarado,
  claveAnuncio,
  fuerzaEvidencia,
  mapaAnuncioProducto,
  sugerenciaDeAnuncio,
  type AdProductRow,
} from "@/lib/ad-products";

/**
 * Qué producto vende cada anuncio de Meta.
 *
 * EL CASO REAL. El filtro «Producto» de la cola dejaba 1.294 leads en «Sin
 * producto». No era un fallo del filtro: 1.061 de esos 1.294 —el 82 %— vienen
 * de un anuncio. Tocan el anuncio, se les abre WhatsApp con un mensaje genérico
 * y nunca pasan por la ficha del producto. De ellos solo tenemos `ad_id`.
 *
 * El titular del anuncio no sirve como producto: cuatro anuncios de Beewax
 * llegan con tres titulares distintos, dos de ellos nombres de archivo de video
 * («beewax 1107 fk (6).mp4») y uno con «{{product.name}}» sin renderizar.
 *
 * Así que alguien lo declara, una vez por anuncio. Y la frontera que sostiene
 * todo esto es que una SUGERENCIA no es una DECLARACIÓN.
 */

const fila = (over: Partial<AdProductRow> = {}): AdProductRow => ({
  ad_id: "120248136956750056",
  store_id: "tienda-1",
  ...over,
});

describe("una sugerencia NO etiqueta leads", () => {
  it("con firma y handle, sí", () => {
    expect(
      adProductDeclarado(fila({ product_handle: "beewax", confirmed_at: "2026-09-02T10:00:00Z" })),
    ).toBe(true);
  });

  it("con sugerencia del 98 % pero sin firma, NO", () => {
    // ESTO ES EL CORAZÓN. La evidencia histórica es fuerte en unos anuncios
    // (98 %) y floja en otros (42 %), y quien llama no ve la diferencia: ve un
    // producto. Etiquetar sin firma convierte una conjetura en un hecho
    // invisible, y el 42 % manda a la asesora con el argumentario equivocado
    // más de la mitad de las veces sin que nadie pueda saberlo.
    expect(
      adProductDeclarado(fila({ suggested_label: "Beewax™", evidence_pct: 98, evidence_sample: 44 })),
    ).toBe(false);
  });

  it("firmado pero sin handle tampoco: sería etiquetar con nada", () => {
    // La base lo prohíbe con un CHECK, pero la pantalla lee filas que pudieron
    // escribirse antes. Un `confirmed_at` sin handle etiquetaría con vacío, que
    // es peor que no etiquetar porque no se ve.
    expect(adProductDeclarado(fila({ confirmed_at: "2026-09-02T10:00:00Z" }))).toBe(false);
    expect(
      adProductDeclarado(fila({ product_handle: "   ", confirmed_at: "2026-09-02T10:00:00Z" })),
    ).toBe(false);
  });
});

describe("el mapa que usa la cola", () => {
  it("solo deja entrar lo declarado", () => {
    const mapa = mapaAnuncioProducto([
      fila({ ad_id: "a1", product_handle: "beewax", confirmed_at: "2026-09-02T10:00:00Z" }),
      fila({ ad_id: "a2", suggested_label: "Nattokinase", evidence_pct: 42, evidence_sample: 24 }),
    ]);
    expect(mapa.get(claveAnuncio("tienda-1", "a1"))).toBe("beewax");
    expect(mapa.has(claveAnuncio("tienda-1", "a2"))).toBe(false);
  });

  it("normaliza el handle para que empate con el del link", () => {
    // Todo el objetivo es que un lead de anuncio y uno de ficha del mismo
    // producto caigan en el MISMO balde. Guardar «Beewax » cuando el link trae
    // «beewax» mostraría dos productos donde hay uno.
    const mapa = mapaAnuncioProducto([
      fila({ product_handle: "  BeeWax  ", confirmed_at: "2026-09-02T10:00:00Z" }),
    ]);
    expect([...mapa.values()]).toEqual(["beewax"]);
  });

  it("la clave lleva la tienda: dos tiendas no se pisan", () => {
    const mapa = mapaAnuncioProducto([
      fila({ store_id: "t1", ad_id: "a", product_handle: "uno", confirmed_at: "x" }),
      fila({ store_id: "t2", ad_id: "a", product_handle: "dos", confirmed_at: "x" }),
    ]);
    expect(mapa.get(claveAnuncio("t1", "a"))).toBe("uno");
    expect(mapa.get(claveAnuncio("t2", "a"))).toBe("dos");
  });
});

describe("qué tan firme es la sugerencia que se le muestra a quien firma", () => {
  it("un 98 % sobre 44 pedidos es fuerte", () => {
    expect(fuerzaEvidencia(fila({ suggested_label: "Beewax", evidence_pct: 98, evidence_sample: 44 })))
      .toBe("fuerte");
  });

  it("un 42 % es floja, y se dice", () => {
    // Existe en producción. Firmar un 98 % y firmar un 42 % no pueden verse
    // igual en pantalla, o la interfaz convierte el segundo en el primero.
    expect(fuerzaEvidencia(fila({ suggested_label: "Nattokinase", evidence_pct: 42, evidence_sample: 24 })))
      .toBe("dudosa");
  });

  it("con menos de cinco pedidos no hay evidencia, por alto que salga el %", () => {
    // Un anuncio con una sola venta da 100 % y no dice nada.
    expect(fuerzaEvidencia(fila({ suggested_label: "X", evidence_pct: 100, evidence_sample: 1 })))
      .toBe("ninguna");
  });

  it("sin sugerencia, ninguna", () => {
    expect(fuerzaEvidencia(fila({ evidence_pct: 90, evidence_sample: 30 }))).toBe("ninguna");
  });
});

describe("la sugerencia se calcula sobre TÍTULOS, no sobre handles", () => {
  it("devuelve el título más comprado con su porcentaje y su muestra", () => {
    const s = sugerenciaDeAnuncio([
      { title: "Beewax™ - Cera de abeja" },
      { title: "Beewax™ - Cera de abeja" },
      { title: "Beewax™ - Cera de abeja" },
      { title: "Otra cosa" },
    ]);
    expect(s).toEqual({ label: "beewax™ - cera de abeja", pct: 75, sample: 4 });
  });

  it("NO intenta convertir el título en handle", () => {
    // Los pedidos guardan «Nails Repairing – Sérum Tea Tree Ginger para Uñas» y
    // el link guarda `nails-repairing-suero-reparador-de-unas`: el mismo
    // producto escrito distinto. Emparejarlos sería la conjetura que esta tabla
    // existe para evitar, así que la sugerencia se queda en título y la persona
    // elige el handle.
    const s = sugerenciaDeAnuncio([{ title: "Nails Repairing – Sérum Tea Tree Ginger" }]);
    expect(s?.label).toBe("nails repairing – sérum tea tree ginger");
    expect(s?.label).not.toMatch(/^[a-z0-9-]+$/); // no es un handle, y no lo finge
  });

  it("un empate se resuelve igual todas las veces", () => {
    // Una sugerencia que baila entre refrescos no se puede revisar: la persona
    // vuelve a la pantalla y ve otra cosa sin que nada haya cambiado.
    const compras = [{ title: "bbb" }, { title: "aaa" }];
    expect(sugerenciaDeAnuncio(compras)?.label).toBe("aaa");
    expect(sugerenciaDeAnuncio([...compras].reverse())?.label).toBe("aaa");
  });

  it("sin compras no inventa", () => {
    expect(sugerenciaDeAnuncio([])).toBeNull();
    expect(sugerenciaDeAnuncio([{ title: "   " }])).toBeNull();
  });
});

describe("las piezas que sostienen la regla en el código", () => {
  const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

  it("la consulta de la cola pide SOLO filas firmadas", () => {
    // Si trajera todas y filtrara después, cualquier descuido en el filtro
    // convertiría las sugerencias en etiquetas sin que nadie lo note.
    const source = read("lib/ad-products-access.ts");
    const start = source.indexOf("export async function getAdProductMap(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain('.not("confirmed_at", "is", null)');
  });

  it("recalcular sugerencias no toca lo firmado", () => {
    // Quien firmó vio la evidencia de entonces y decidió. Una sugerencia nueva
    // no puede quitarle la firma por la espalda.
    const source = read("lib/ad-products-access.ts");
    const start = source.indexOf("export async function recomputeAdSuggestions(");
    const body = source.slice(start);
    expect(body).not.toContain("product_handle:");
    expect(body).not.toContain("confirmed_at:");
  });

  it("la base impide firmar sin decir qué producto", () => {
    expect(read("db/migrations/0139_ad_products.sql")).toContain(
      "check (confirmed_at is null or coalesce(trim(product_handle), '') <> '')",
    );
  });

  it("declarar tiene permiso propio: cambia cómo se lee la cola entera", () => {
    expect(read("lib/permissions.ts")).toContain('"leads.map_ads"');
    const actions = read("app/dashboard/leads/anuncios/actions.ts");
    expect(actions).toContain('perms.can("leads.map_ads")');
  });

  it("la cola pregunta en orden: lo último, luego lo primero, luego el anuncio", () => {
    // El orden es la regla entera:
    //   1. `last_product_handle` — lo ÚLTIMO que enlazó, o sea lo que consulta
    //      AHORA. Es un hecho suyo y es reciente.
    //   2. el link del primer mensaje — el mismo hecho, más viejo. Queda de
    //      respaldo para leads que todavía no se resincronizaron.
    //   3. lo declarado para su anuncio — un hecho de la tienda sobre el
    //      anuncio en general, no sobre esta persona.
    // Invertirlo dejaría a quien vuelve por otro producto etiquetado con el de
    // la primera vez, que es el fallo que esto vino a arreglar.
    const source = read("components/leads.tsx");
    expect(source).toMatch(
      /\(l\.last_product_handle \?\? ""\)\.trim\(\) \|\|\s*leadProductHandle\(l\.first_inbound_text\) \|\|\s*\(l\.ad_id \? \(adProducts/,
    );
  });

  it("el último producto se escribe SIN el candado de escritura única", () => {
    // `first_inbound_text` se escribe con `.is(..., null)` a propósito: el
    // primer mensaje no cambia. Copiar ese candado acá era el bug — quien
    // vuelve por otro producto se quedaba con el de junio para siempre.
    const source = read("lib/leads-ingest.ts");
    const start = source.indexOf("if (sig.last_product_handle) {");
    const body = source.slice(start, source.indexOf("\n    }", start));
    expect(body).toContain("last_product_handle: sig.last_product_handle");
    expect(body).not.toContain(".is(");
  });
});
