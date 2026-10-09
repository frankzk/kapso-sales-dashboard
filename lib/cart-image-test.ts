// Prueba A/B del mensaje 1 de carrito abandonado con la foto del producto
// (0233, docs/carritos-secuencia-whatsapp.md). PURO Y TESTEADO.
//
// QUIÉN ENTRA. Solo los carritos cuyo producto tiene foto en el espejo de
// catálogo (`shopify_product_images`). Se decide ANTES del sorteo: si «sin
// foto» cayera en un brazo, los dos grupos dejarían de ser comparables.
//
// EL SORTEO. 50/50 por un hash del `draft_order_gid`: el mismo carrito cae
// siempre en el mismo brazo aunque el cron lo vea dos veces, y no depende de
// la hora ni del orden de la corrida.
//
// LA FOTO. Los carritos COD (Releasit) llegan sin `product_id` —verificado en
// los envíos de setiembre y octubre de 2026— pero con el título del producto,
// que casa con `catalog_title` en el 99 % de los casos. Si algún día llega el
// `product_id`, manda ese.

export type CartImageVariant = "imagen" | "control";

/** FNV-1a de 32 bits: estable, sin dependencias y bien repartido para un 50/50. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** El brazo de un carrito: siempre el mismo para el mismo `draft_order_gid`. */
export function cartImageVariant(draftOrderGid: string): CartImageVariant {
  return fnv1a(draftOrderGid) % 2 === 0 ? "imagen" : "control";
}

export interface CatalogImage {
  product_id: string;
  catalog_title: string | null;
}

function titleKey(title: string | null | undefined): string {
  return String(title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * El producto (con foto) del primer artículo del carrito, o null si no se
 * encuentra: entonces el carrito queda fuera de la prueba.
 */
export function cartProductWithImage(
  lineItems: { product_id?: string | number | null; title?: string | null }[] | null | undefined,
  catalog: CatalogImage[],
): string | null {
  const first = (lineItems ?? [])[0];
  if (!first) return null;
  const ids = new Set(catalog.map((c) => c.product_id));
  const pid = first.product_id == null ? "" : String(first.product_id).trim();
  if (pid && ids.has(pid)) return pid;
  const key = titleKey(first.title);
  if (!key) return null;
  return catalog.find((c) => titleKey(c.catalog_title) === key)?.product_id ?? null;
}

/**
 * La foto que se manda a Meta: pasa por /api/wa-image, que la entrega en JPG
 * (Meta no acepta WebP y el 45 % de las fotos de catálogo lo son).
 */
export function waImageUrl(siteUrl: string, storeId: string, productId: string): string {
  return `${siteUrl.replace(/\/$/, "")}/api/wa-image/${storeId}/${productId}.jpg`;
}

/** Una fila de `cart_image_test_results` (0233). */
export interface ImageTestRow {
  variant: CartImageVariant;
  carritos: number;
  convertidos: number;
  bot: number;
  bot_asistido: number;
  asesora: number;
  ventas: number;
}

export interface ImageTestArm extends ImageTestRow {
  /** Convertidos / carritos, 0..1. */
  tasa: number;
}

export interface ImageTestSummary {
  imagen: ImageTestArm;
  control: ImageTestArm;
  /** Puntos porcentuales: imagen − control. */
  diferencia: number;
  /** Prueba de dos proporciones, bilateral. */
  pValue: number | null;
  /** Qué se puede decir hoy, en una frase. */
  veredicto: string;
}

/** Mínimo de carritos por brazo antes de leer nada: con menos, el azar manda. */
export const IMAGE_TEST_MIN_PER_ARM = 300;

/** Φ(x) por la aproximación de Abramowitz-Stegun (error < 7.5e-8). */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function arm(rows: ImageTestRow[], variant: CartImageVariant): ImageTestArm {
  const r = rows.find((x) => x.variant === variant);
  const base = r ?? { variant, carritos: 0, convertidos: 0, bot: 0, bot_asistido: 0, asesora: 0, ventas: 0 };
  const n = Number(base.carritos) || 0;
  const k = Number(base.convertidos) || 0;
  return {
    variant,
    carritos: n,
    convertidos: k,
    bot: Number(base.bot) || 0,
    bot_asistido: Number(base.bot_asistido) || 0,
    asesora: Number(base.asesora) || 0,
    ventas: Number(base.ventas) || 0,
    tasa: n ? k / n : 0,
  };
}

/**
 * Lo que dice la prueba hoy. PURA. Con menos de `IMAGE_TEST_MIN_PER_ARM`
 * carritos por brazo no se concluye; después, una diferencia cuenta solo si
 * p < 0.05 (prueba de dos proporciones).
 */
export function imageTestSummary(rows: ImageTestRow[]): ImageTestSummary {
  const imagen = arm(rows, "imagen");
  const control = arm(rows, "control");
  const diferencia = (imagen.tasa - control.tasa) * 100;
  let pValue: number | null = null;
  if (imagen.carritos && control.carritos) {
    const pooled = (imagen.convertidos + control.convertidos) / (imagen.carritos + control.carritos);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / imagen.carritos + 1 / control.carritos));
    pValue = se > 0 ? 2 * (1 - normalCdf(Math.abs(imagen.tasa - control.tasa) / se)) : 1;
  }
  const pts = `${Math.abs(diferencia).toFixed(1)} puntos`;
  let veredicto: string;
  if (imagen.carritos < IMAGE_TEST_MIN_PER_ARM || control.carritos < IMAGE_TEST_MIN_PER_ARM) {
    const falta = Math.max(IMAGE_TEST_MIN_PER_ARM - imagen.carritos, IMAGE_TEST_MIN_PER_ARM - control.carritos, 0);
    veredicto = `Aún es pronto: faltan unos ${falta} carritos por grupo para empezar a leerla.`;
  } else if (pValue !== null && pValue < 0.05) {
    veredicto = diferencia > 0
      ? `Con foto cierra ${pts} más, y no es casualidad.`
      : `Con foto cierra ${pts} menos, y no es casualidad.`;
  } else {
    veredicto = `Todavía no hay diferencia clara (${diferencia >= 0 ? "+" : "−"}${pts}); puede ser casualidad.`;
  }
  return { imagen, control, diferencia, pValue, veredicto };
}
