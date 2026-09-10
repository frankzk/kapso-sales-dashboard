// Los productos de una guía Swayp, por CÓDIGO y no por nombre.
//
// Swayp acepta las dos formas y ellos mismos descartan una:
//
//   productos: [{ codbar, cantidad, nombre }]   ← estructurada
//   contenido: "2 x NOMBRE EXACTO"              ← «tiende a ser inestable
//                                                  porque se busca por nombre
//                                                  y no por código»
//
// Buscar por nombre ata el descuento de stock a que su catálogo y el nuestro
// escriban igual un producto. Cambian una tilde y las guías dejan de descontar
// sin error, sin aviso y sin forma de notarlo hasta que el inventario no cuadre.
//
// Todo acá es PURO: el llamador trae el mapa de la base y hace la llamada.

/** Una línea del pedido, tal y como viene en `orders.line_items`. */
export interface OrderLine {
  sku?: string | null;
  title?: string | null;
  quantity?: number | null;
}

/** Un ítem de `productos[]` en el payload de Swayp. */
export interface SwaypProducto {
  codbar: string;
  cantidad: number;
  nombre: string;
}

export type BuildProductosResult =
  | { ok: true; productos: SwaypProducto[] }
  /** `faltan` son los TÍTULOS, no los SKU: es lo que la operadora reconoce. */
  | { ok: false; faltan: string[] };

/**
 * Normaliza un SKU para buscarlo en el mapa.
 *
 * La misma normalización que guarda la migración 0151. Sin ella, «ABC » y «abc»
 * serían dos entradas para el mismo producto y una de las dos nunca se
 * encontraría — un fallo silencioso que acabaría en una guía sin descuento de
 * stock.
 */
export function normalizeSku(sku: string | null | undefined): string {
  return (sku ?? "").trim().toUpperCase();
}

/**
 * Traduce las líneas del pedido a `productos[]`, o dice cuáles no puede.
 *
 * NO ADIVINA. Un producto sin mapeo no se manda con el codbar vacío ni se
 * aproxima por nombre: se devuelve como faltante y el llamador cae al Excel. La
 * alternativa —mandarlo igual— haría que unas guías descuenten stock y otras no,
 * sin que nadie lo note hasta que el inventario de Swayp no cuadre con el real.
 * Es la misma regla que el ubigeo: un dato aproximado es peor que ninguno,
 * porque el aproximado no avisa.
 *
 * Una línea SIN SKU también falta. Ocurre —hay pedidos así en la base— y sin SKU
 * no hay nada que buscar en el mapa.
 *
 * Las cantidades se AGRUPAN por codbar: dos líneas del mismo producto (dos
 * variantes que mapean al mismo código) tienen que llegar como una sola de
 * cantidad 2, no como dos de 1. Swayp descuenta por ítem.
 */
export function buildProductos(
  lines: OrderLine[],
  map: Map<string, { codbar: string; nombre?: string | null }>,
): BuildProductosResult {
  const faltan: string[] = [];
  const porCodbar = new Map<string, SwaypProducto>();

  for (const line of lines) {
    const titulo = (line.title ?? "").trim();
    const hit = map.get(normalizeSku(line.sku));
    if (!hit?.codbar) {
      faltan.push(titulo || (line.sku ?? "").trim() || "(producto sin nombre)");
      continue;
    }
    // Al menos 1: un pedido con cantidad 0 o nula sigue siendo un paquete que
    // sale, y mandar 0 le diría a Swayp que no descuente nada.
    const cantidad = Math.max(1, Math.trunc(line.quantity ?? 1) || 1);
    const previo = porCodbar.get(hit.codbar);
    if (previo) {
      previo.cantidad += cantidad;
    } else {
      porCodbar.set(hit.codbar, {
        codbar: hit.codbar,
        cantidad,
        // El nombre es informativo —Swayp lee el codbar—, pero se manda el suyo
        // cuando lo tenemos: así su panel muestra lo mismo que su catálogo.
        nombre: (hit.nombre ?? "").trim() || titulo || hit.codbar,
      });
    }
  }

  if (faltan.length) return { ok: false, faltan };
  // Un pedido sin líneas no tiene nada que declarar; que lo diga el llamador con
  // su propio mensaje, no un `productos: []` que Swayp aceptaría en silencio.
  if (!porCodbar.size) return { ok: false, faltan: ["(el pedido no tiene productos)"] };
  return { ok: true, productos: [...porCodbar.values()] };
}

/**
 * `contenido`: lo que Swayp PARSEA. Solo cantidad y código.
 *
 * Es el formato que pidieron —«CANTIDAD X SKU … con el match exacto del sku»—
 * y no lleva nada más a propósito. No conocemos la gramática de su buscador, y
 * si le sobra texto hay dos desenlaces: lo tolera, o no encuentra el producto y
 * no descuenta stock. No hay un tercero donde falle ruidosamente. Un paréntesis
 * de más es exactamente lo que un parser hecho a mano no contempla.
 *
 * El nombre legible va en `observaciones`, que nadie parsea.
 */
export function contenidoDeProductos(productos: SwaypProducto[]): string {
  return productos.map((p) => `${p.cantidad} x ${p.codbar}`).join(", ");
}

/**
 * `observaciones`: la MISMA información, para que la lea una persona.
 *
 * Usa el nombre de Swayp cuando el mapeo lo guardó —«CANDIDA CLEANSE», corto y
 * el que su almacén reconoce— y cae a nuestro título solo si no hay otro. Es
 * también la razón de que el campo «Nombre en Swayp» de la pantalla de Catálogo
 * valga la pena rellenar: sin él acá acaba un título de Shopify de 200
 * caracteres.
 */
export function resumenLegible(productos: SwaypProducto[]): string {
  return productos.map((p) => `${p.cantidad} x ${p.nombre}`).join(", ");
}

/**
 * Junta el resumen de productos con la nota del operador, recortando si hace
 * falta.
 *
 * EL RECORTE. No sabemos el límite de `observaciones` en Swayp, y nuestros
 * títulos de Shopify llegan a 200 caracteres cada uno: tres productos sin
 * nombre corto pasarían de 600. Si el campo tuviera tope, la API rechazaría la
 * guía entera y el envío caería al Excel — perder una guía por un texto de
 * cortesía sería un mal negocio. Se recorta lo prescindible y se conserva lo
 * que decide algo, que es el `contenido`.
 */
export const OBSERVACIONES_MAX = 500;

export function juntaObservaciones(...partes: (string | null | undefined)[]): string | null {
  const texto = partes.map((p) => (p ?? "").trim()).filter(Boolean).join(" · ");
  if (!texto) return null;
  return texto.length <= OBSERVACIONES_MAX ? texto : `${texto.slice(0, OBSERVACIONES_MAX - 1)}…`;
}
