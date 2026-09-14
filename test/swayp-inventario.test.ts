import { describe, it, expect } from "vitest";
import {
  ciudadDeBodega,
  leerExcelSwayp,
  planearImportacion,
  resumenDelPlan,
  type FilaStock,
} from "@/lib/swayp-inventario";

/** Una fila del Excel real de Swayp, con sus columnas tal cual. */
function fila(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    "Código de barras": "AURE001",
    Nombre: "CANDIDA CLEANSE",
    Empresa: "No definida",
    Origen: "Bodega",
    Bodega: "BODEGA TRUJILLO",
    Ubicación: "",
    Disponible: "3",
    "En bodega": "3",
    Reservado: "0",
    "En tránsito": "0",
    Estado: "Bajo",
    "Stock mínimo": "0",
    Lote: "",
    Vencimiento: "",
    SKU: "6aa1920c942d7000f2db9ef9",
    ...over,
  };
}

function stock(over: Partial<FilaStock> = {}): FilaStock {
  return { id: "s1", city: "trujillo", product: "Cándida Cleanse", sku: "765545233", quantity: 3, ...over };
}

describe("el nombre de la bodega de Swayp se traduce a nuestra ciudad", () => {
  it("aguanta las tres formas que conviven en el panel", () => {
    expect(ciudadDeBodega("BODEGA TRUJILLO")).toBe("trujillo");
    expect(ciudadDeBodega("Bodega Arequipa")).toBe("arequipa");
    expect(ciudadDeBodega("BODEGA PIURA")).toBe("piura");
  });

  it("Juliaca-Puno cae en juliaca, NO en las dos", () => {
    // Una sola bodega física (ubigeo 211101). Escribir las mismas unidades en
    // `puno` haría que un frasco habilite dos guías en dos ciudades.
    expect(ciudadDeBodega("BODEGA JULIACA - PUNO")).toBe("juliaca");
    expect(ciudadDeBodega("bodega juliaca-puno")).toBe("juliaca");
  });

  it("una bodega que no conocemos devuelve null en vez de adivinar", () => {
    expect(ciudadDeBodega("BODEGA TACNA")).toBeNull();
    expect(ciudadDeBodega("")).toBeNull();
    expect(ciudadDeBodega(null)).toBeNull();
  });
});

describe("leer el Excel exportado", () => {
  it("toma Disponible, no En bodega", () => {
    // En bodega incluye lo reservado para guías ya emitidas: no se puede volver
    // a prometer. Hoy coinciden porque Reservado va en 0; el día que no, manda
    // la columna que responde «¿puedo crear otra guía?».
    const r = leerExcelSwayp([fila({ Disponible: "4", "En bodega": "9", Reservado: "5" })]);
    expect(r.entradas[0]!.disponible).toBe(4);
  });

  it("suma cuando Swayp parte una referencia en varias filas", () => {
    const r = leerExcelSwayp([
      fila({ Disponible: "3", Lote: "L1" }),
      fila({ Disponible: "4", Lote: "L2" }),
    ]);
    expect(r.entradas).toHaveLength(1);
    expect(r.entradas[0]!.disponible).toBe(7);
  });

  it("descarta y CUENTA la fila sin código de barras, no la adivina por nombre", () => {
    const r = leerExcelSwayp([fila(), fila({ "Código de barras": "" })]);
    expect(r.entradas).toHaveLength(1);
    expect(r.sinCodbar).toBe(1);
  });

  it("encuentra las columnas aunque cambien tildes o mayúsculas", () => {
    const r = leerExcelSwayp([
      { "CODIGO DE BARRAS": "aure007", bodega: "BODEGA PIURA", DISPONIBLE: "12", Nombre: "X" },
    ]);
    expect(r.entradas[0]).toMatchObject({ codbar: "AURE007", disponible: 12 });
    expect(r.bodegas).toEqual(["BODEGA PIURA"]);
  });

  it("una celda vacía o con basura es 0, no NaN", () => {
    expect(leerExcelSwayp([fila({ Disponible: "" })]).entradas[0]!.disponible).toBe(0);
    expect(leerExcelSwayp([fila({ Disponible: "—" })]).entradas[0]!.disponible).toBe(0);
  });
});

describe("el plan de importación", () => {
  const mapa = new Map([
    ["AURE001", ["765545233"]],
    ["AURE013", ["745675633"]],
  ]);
  /** Sin etiqueta conocida: lo que no tiene renglón sale huérfano. */
  const etiquetas = new Map<string, string>();

  it("ajusta el renglón que difiere y deja quieto el que ya coincide", () => {
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([fila({ Disponible: "3" }), fila({ "Código de barras": "AURE013", Disponible: "20" })])
        .entradas,
      [stock({ quantity: 3 }), stock({ id: "s2", sku: "745675633", product: "Shampoo Keratina", quantity: 13 })],
      mapa,
      etiquetas,
    );
    expect(plan.sinCambio).toBe(1);
    expect(plan.ajustes).toHaveLength(1);
    expect(plan.ajustes[0]).toMatchObject({ id: "s2", cantidadAnterior: 13, cantidadNueva: 20 });
  });

  it("LO QUE SOBRA DE NUESTRO LADO VA A CERO", () => {
    // Es el caso que motivó todo: nuestra tabla decía 25 unidades de Ethiopian
    // en Juliaca y esa bodega no tiene el producto. Un saldo fantasma autoriza
    // una guía que Swayp rebota con el pedido ya prometido al cliente.
    const plan = planearImportacion(
      "juliaca",
      leerExcelSwayp([fila({ Bodega: "BODEGA JULIACA - PUNO", Disponible: "3" })]).entradas,
      [stock({ city: "juliaca" }), stock({ id: "fantasma", sku: "PRUEBA-ETHIOPIAN", product: "Ethiopian", quantity: 25 })],
      mapa,
      etiquetas,
    );
    const cero = plan.ajustes.find((a) => a.id === "fantasma");
    expect(cero).toMatchObject({ cantidadAnterior: 25, cantidadNueva: 0 });
  });

  it("un renglón que ya estaba en 0 y tampoco vino no cuenta como ajuste", () => {
    const plan = planearImportacion(
      "trujillo",
      [],
      [stock({ id: "vacio", quantity: 0 })],
      mapa,
      etiquetas,
    );
    expect(plan.ajustes).toHaveLength(0);
    expect(plan.sinCambio).toBe(1);
  });

  it("distingue el codbar sin vincular del que no tiene renglón en esa ciudad", () => {
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([
        fila({ "Código de barras": "AURE026", Nombre: "CAYENNE PEPPER", Disponible: "30" }),
        fila({ "Código de barras": "AURE013", Disponible: "5" }),
      ]).entradas,
      [],
      mapa,
      etiquetas,
    );
    expect(plan.huerfanos).toEqual([
      { codbar: "AURE026", nombre: "CAYENNE PEPPER", bodega: "BODEGA TRUJILLO", disponible: 30, motivo: "sin_vinculo" },
      { codbar: "AURE013", nombre: "CANDIDA CLEANSE", bodega: "BODEGA TRUJILLO", disponible: 5, motivo: "sin_etiqueta" },
    ]);
  });

  it("empareja por código de barras, NUNCA por nombre", () => {
    // «SUPER HUMAN Ethiopian Black Seed Oil – Aceite…» contra «ETHIOPIAN OIL»:
    // los títulos de Shopify y los de Swayp no coinciden, y emparejar por texto
    // flojo inventa equivalencias.
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([fila({ Nombre: "CANDIDA CLEANSE" })]).entradas,
      [stock({ product: "CANDIDA CLEANSE", sku: "otro-sku", quantity: 99 })],
      mapa,
      etiquetas,
    );
    expect(plan.huerfanos[0]!.motivo).toBe("sin_etiqueta");
    // Y el nuestro, al no estar en el Excel, cae a 0 — no se "reconoce" por nombre.
    expect(plan.ajustes[0]).toMatchObject({ cantidadNueva: 0 });
  });

  it("da de alta lo que Swayp tiene y esta ciudad no tenía anotado", () => {
    // Lo descubrió el simulacro con el Excel real de Trujillo: AURE008 y
    // AURE014 existen allá con 34 unidades entre los dos y acá no había renglón
    // en esa ciudad. Sin esto, esas unidades se perdían en silencio.
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([fila({ "Código de barras": "AURE013", Disponible: "26" })]).entradas,
      [],
      mapa,
      new Map([["745675633", "Keratina + Romero + Ortiga + Biotina — Champú (220 ml)"]]),
    );
    expect(plan.huerfanos).toHaveLength(0);
    expect(plan.altas).toEqual([
      {
        sku: "745675633",
        product: "Keratina + Romero + Ortiga + Biotina — Champú (220 ml)",
        cantidad: 26,
        codbar: "AURE013",
      },
    ]);
  });

  it("el alta copia NUESTRA etiqueta, nunca el nombre corto de Swayp", () => {
    // `product` es lo que se cruza contra `shipments.product`. Un renglón
    // llamado «SHAMPOO KERATINA» no matchearía ninguna guía: sería stock que
    // existe y nunca se encuentra.
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([fila({ "Código de barras": "AURE013", Nombre: "SHAMPOO KERATINA", Disponible: "5" })])
        .entradas,
      [],
      mapa,
      new Map([["745675633", "Keratina + Romero + Ortiga + Biotina - Champú Nutritivo (220 ml) - IdeasLabCo™"]]),
    );
    expect(plan.altas[0]!.product).not.toBe("SHAMPOO KERATINA");
    expect(plan.altas[0]!.product).toContain("IdeasLabCo");
  });

  it("no toca ninguna ciudad que no sea la importada", () => {
    // Nuestra tabla cubre nueve ciudades y Swayp tiene cinco bodegas: Cusco,
    // Huancayo, Ica, Chiclayo y Chimbote se abastecen de otra forma.
    const filas = [stock({ city: "trujillo", quantity: 3 })];
    const plan = planearImportacion("trujillo", leerExcelSwayp([fila()]).entradas, filas, mapa, etiquetas);
    expect(plan.ajustes.every((a) => filas.some((f) => f.id === a.id))).toBe(true);
    expect(plan.ciudad).toBe("trujillo");
  });

  it("un mismo código de barras llega por dos tiendas y encuentra su renglón igual", () => {
    // Aurela y Kenku venden el mismo frasco con SKU de Shopify distinto, y el
    // mapa se guarda por tienda. El stock es de la organización: un renglón. Si
    // sólo se probara el primer SKU, el producto saldría huérfano la mitad de
    // las veces según qué tienda quedara primero.
    const dosTiendas = new Map([["AURE001", ["sku-aurela", "765545233"]]]);
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([fila({ Disponible: "8" })]).entradas,
      [stock({ sku: "765545233", quantity: 3 })],
      dosTiendas,
      etiquetas,
    );
    expect(plan.huerfanos).toHaveLength(0);
    expect(plan.ajustes[0]).toMatchObject({ cantidadAnterior: 3, cantidadNueva: 8 });
  });

  it("reporta los dos totales para poder comparar de un vistazo", () => {
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([fila({ Disponible: "116" })]).entradas,
      [stock({ quantity: 177 })],
      mapa,
      etiquetas,
    );
    expect(plan.totalSwayp).toBe(116);
    expect(plan.totalNuestro).toBe(177);
  });
});

describe("el resumen que lee la persona", () => {
  const mapa = new Map([["AURE001", ["765545233"]]]);
  const etiquetas = new Map<string, string>();

  it("dice cuántos bajan y cuántos suben, no sólo cuántos cambian", () => {
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([fila({ Disponible: "1" })]).entradas,
      [stock({ quantity: 10 })],
      mapa,
      etiquetas,
    );
    expect(resumenDelPlan(plan)).toContain("1 a la baja");
    expect(resumenDelPlan(plan)).toContain("10 → 1 unidades");
  });

  it("nombra los huérfanos en vez de contarlos", () => {
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([fila({ "Código de barras": "AURE026", Disponible: "30" })]).entradas,
      [],
      mapa,
      etiquetas,
    );
    const texto = resumenDelPlan(plan);
    expect(texto).toContain("AURE026");
    expect(texto).toContain("Catálogo de productos");
  });

  it("cuando no hay nada que hacer, lo dice y no finge trabajo", () => {
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([fila({ Disponible: "3" })]).entradas,
      [stock({ quantity: 3 })],
      mapa,
      etiquetas,
    );
    expect(resumenDelPlan(plan)).toContain("ya coincidía con Swayp");
  });

  it("singular con un solo renglón", () => {
    const plan = planearImportacion(
      "trujillo",
      leerExcelSwayp([fila({ Disponible: "5" })]).entradas,
      [stock({ quantity: 3 })],
      mapa,
      etiquetas,
    );
    expect(resumenDelPlan(plan)).toContain("1 renglón ajustado");
    expect(resumenDelPlan(plan)).not.toContain("renglones ajustados");
  });
});
