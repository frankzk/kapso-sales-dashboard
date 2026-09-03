import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claveAnuncio,
  declaracionVigente,
  fuerzaEvidencia,
  handleDeAnuncioPara,
  mapaAnuncioProducto,
  sugerenciaDeAnuncio,
  type AdDeclaration,
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

const decl = (over: Partial<AdDeclaration> = {}): AdDeclaration => ({
  store_id: "tienda-1",
  ad_id: "120248136956750056",
  product_handle: "beewax",
  valid_from: "-infinity",
  ...over,
});

describe("una declaración tiene fecha, y el lead toma la SUYA", () => {
  // EL CASO REAL. El anuncio 120248301757360056 de Kenku aparece con dos
  // titulares —«Tu café favorito, ahora saludable ☕» y «GC WIN ICE COFFEE
  // 2007 (11).mp4»— y sus leads escriben «Quiero más información del Gel de
  // Limpieza de Lengua». El creativo del café se reutilizó para otro producto.
  //
  // Con una declaración eterna ese anuncio no tiene respuesta buena: decir
  // «café» etiqueta mal a quien preguntó por el gel, decir «gel» etiqueta mal a
  // los del café — y hacia atrás, sobre leads ya trabajados.
  const cafe = decl({ product_handle: "mushroom-coffee", valid_from: "-infinity" });
  const gel = decl({ product_handle: "gel-limpieza-lengua", valid_from: "2026-08-01T00:00:00Z" });

  it("el que entró antes del cambio se queda con lo de antes", () => {
    expect(declaracionVigente([cafe, gel], "2026-07-15T10:00:00Z")?.product_handle).toBe(
      "mushroom-coffee",
    );
  });

  it("el que entró después toma lo nuevo", () => {
    expect(declaracionVigente([cafe, gel], "2026-08-20T10:00:00Z")?.product_handle).toBe(
      "gel-limpieza-lengua",
    );
  });

  it("el orden en que llegan las declaraciones no cambia el resultado", () => {
    // Vienen de una consulta; confiar en su orden sería confiar en un `order by`
    // que alguien puede quitar sin enterarse.
    expect(declaracionVigente([gel, cafe], "2026-07-15T10:00:00Z")?.product_handle).toBe(
      "mushroom-coffee",
    );
  });

  it("justo en el instante del cambio ya vale la nueva", () => {
    expect(declaracionVigente([cafe, gel], "2026-08-01T00:00:00Z")?.product_handle).toBe(
      "gel-limpieza-lengua",
    );
  });

  it("«desde siempre» cubre a todos mientras nadie diga que cambió", () => {
    // Es la primera declaración de cualquier anuncio: no cuesta poner fecha
    // porque no hay nada que fechar todavía.
    expect(declaracionVigente([cafe], "2020-01-01T00:00:00Z")?.product_handle).toBe(
      "mushroom-coffee",
    );
  });

  it("si TODAS empiezan después, no hay respuesta — y eso se dice", () => {
    // Nadie ha declarado qué vendía el anuncio entonces. «Sin producto» es la
    // verdad; heredar la primera hacia atrás sería inventarla.
    expect(declaracionVigente([gel], "2026-07-15T10:00:00Z")).toBeNull();
  });

  it("sin fecha de entrada no se adivina", () => {
    expect(declaracionVigente([cafe], null)).toBeNull();
    expect(declaracionVigente([cafe], "no es una fecha")).toBeNull();
  });

  it("una fecha ilegible NO se cuela como «desde siempre»", () => {
    // Tratarla como -infinity la haría ganar sobre las buenas y etiquetaría a
    // todo el mundo con ella: un dato roto mandando sobre los sanos.
    //
    // Va PRIMERA en la lista a propósito. Puesta después, el empate a -infinity
    // dejaba ganar a la buena por orden de llegada y la prueba pasaba aunque la
    // regla estuviera mal — un caso que no puede fallar no comprueba nada.
    const rota = decl({ product_handle: "basura", valid_from: "ayer por la tarde" });
    expect(declaracionVigente([rota, cafe], "2026-07-15T10:00:00Z")?.product_handle).toBe(
      "mushroom-coffee",
    );
  });

  it("handleDeAnuncioPara devuelve null cuando el anuncio no tiene nada", () => {
    expect(handleDeAnuncioPara([], "2026-07-15T10:00:00Z")).toBeNull();
    expect(handleDeAnuncioPara(undefined, "2026-07-15T10:00:00Z")).toBeNull();
  });
});

describe("el mapa que usa la cola", () => {
  it("agrupa las declaraciones por tienda y anuncio", () => {
    const mapa = mapaAnuncioProducto([
      decl({ ad_id: "a1", product_handle: "cafe" }),
      decl({ ad_id: "a1", product_handle: "gel", valid_from: "2026-08-01T00:00:00Z" }),
      decl({ ad_id: "a2", product_handle: "beewax" }),
    ]);
    expect(mapa.get(claveAnuncio("tienda-1", "a1"))).toHaveLength(2);
    expect(mapa.get(claveAnuncio("tienda-1", "a2"))).toHaveLength(1);
  });

  it("normaliza el handle para que empate con el del link", () => {
    // Todo el objetivo es que un lead de anuncio y uno de ficha del mismo
    // producto caigan en el MISMO balde. Guardar «Beewax » cuando el link trae
    // «beewax» mostraría dos productos donde hay uno.
    const mapa = mapaAnuncioProducto([decl({ product_handle: "  BeeWax  " })]);
    expect(mapa.get(claveAnuncio("tienda-1", "120248136956750056"))![0]!.product_handle).toBe(
      "beewax",
    );
  });

  it("una declaración sin producto no entra: no dice nada", () => {
    expect(mapaAnuncioProducto([decl({ product_handle: "   " })]).size).toBe(0);
  });

  it("la clave lleva la tienda: dos tiendas no se pisan", () => {
    const mapa = mapaAnuncioProducto([
      decl({ store_id: "t1", ad_id: "a", product_handle: "uno" }),
      decl({ store_id: "t2", ad_id: "a", product_handle: "dos" }),
    ]);
    expect(mapa.get(claveAnuncio("t1", "a"))![0]!.product_handle).toBe("uno");
    expect(mapa.get(claveAnuncio("t2", "a"))![0]!.product_handle).toBe("dos");
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

  it("la cola resuelve con la fecha de entrada DEL LEAD", () => {
    // Pasarle `Date.now()` en vez de `first_seen_at` haría que todos tomaran la
    // declaración de hoy: el bug que la fecha vino a arreglar, reintroducido
    // por la puerta de al lado.
    const source = read("components/leads.tsx");
    expect(source).toContain("l.first_seen_at,");
  });

  it("la cola lee las DECLARACIONES, no la tabla de sugerencias", () => {
    // Las dos tablas existen para no confundirse: `ad_products` guarda lo que el
    // histórico sugiere, y eso no etiqueta a nadie. Si la cola leyera de ahí,
    // las sugerencias volverían a ser etiquetas sin que nadie lo note.
    const source = read("lib/ad-products-access.ts");
    const start = source.indexOf("export async function getAdProductMap(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain('.from("ad_product_declarations")');
    expect(body).not.toContain('.from("ad_products")');
  });

  it("devuelve TODOS los periodos, no solo el último", () => {
    // Quién gana depende del lead. Quedarse con el último aquí volvería a
    // reescribir el pasado, que es justo lo que la fecha vino a impedir.
    const source = read("lib/ad-products-access.ts");
    const start = source.indexOf("export async function getAdProductMap(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).not.toMatch(/\.limit\(1\)|maybeSingle\(\)/);
  });

  it("recalcular sugerencias no toca ninguna declaración", () => {
    // Quien declaró vio la evidencia de entonces y decidió. Una sugerencia
    // nueva no puede quitarle la declaración por la espalda — y ahora ni
    // siquiera escribe en la misma tabla.
    const source = read("lib/ad-products-access.ts");
    const start = source.indexOf("export async function recomputeAdSuggestions(");
    const body = source.slice(start);
    expect(body).not.toContain("product_handle");
    expect(body).not.toContain("ad_product_declarations");
  });

  it("la base impide una declaración sin producto", () => {
    expect(read("db/migrations/0142_ad_product_declarations.sql")).toContain(
      "check (length(trim(product_handle)) > 0)",
    );
  });

  it("y dos periodos del mismo anuncio no pueden empezar a la vez", () => {
    // Sin eso habría dos candidatos empatados y el desempate silencioso es peor
    // que el error: nadie sabría cuál está etiquetando.
    expect(read("db/migrations/0142_ad_product_declarations.sql")).toContain(
      "ad_product_declarations_periodo_uniq",
    );
  });

  it("declarar tiene permiso propio: cambia cómo se lee la cola entera", () => {
    expect(read("lib/permissions.ts")).toContain('"leads.map_ads"');
    const actions = read("app/dashboard/leads/anuncios/actions.ts");
    expect(actions).toContain('perms.can("leads.map_ads")');
  });

  it("la cola pregunta en orden, de lo más reciente y más suyo a lo más general", () => {
    // El orden es la regla entera:
    //   1. `last_product_handle` — lo ÚLTIMO que enlazó, o sea lo que consulta
    //      AHORA. Es un hecho suyo y es reciente.
    //   2. `cart_product_handle` — su carrito, o lo que estaba mirando. También
    //      suyo, y posterior a la apertura de la conversación.
    //   3. el link del primer mensaje — el mismo tipo de hecho, más viejo.
    //      Queda de respaldo para leads que todavía no se resincronizaron.
    //   4. lo declarado para su anuncio, vigente el día que entró — un hecho de
    //      la tienda sobre el anuncio, no sobre esta persona.
    // Invertirlo dejaría a quien vuelve por otro producto etiquetado con el de
    // la primera vez, que es el fallo que esto vino a arreglar.
    const source = read("components/leads.tsx");
    expect(source).toMatch(
      /\(l\.last_product_handle \?\? ""\)\.trim\(\) \|\|[\s\S]{0,400}?\(l\.cart_product_handle \?\? ""\)\.trim\(\) \|\|\s*leadProductHandle\(l\.first_inbound_text\) \|\|\s*\(l\.ad_id\s*\?\s*handleDeAnuncioPara\(/,
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
