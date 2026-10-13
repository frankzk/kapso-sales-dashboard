// Lo que Ajustes muestra del recordatorio de reposición (MOM §34). Puro y sin
// dependencias de servidor: lo importa el componente del navegador. El envío y
// la respuesta viven en lib/restock-reminder.ts.

/** Lo que dura una unidad cuando el dueño todavía no lo dijo: un frasco, un
 *  mes. Solo es el valor que aparece escrito al activar un producto. */
export const RESTOCK_DEFAULT_DAYS = 30;

/** Desde cuándo se miran las ventas para listar productos en Ajustes. */
export const RESTOCK_CATALOG_DAYS = 90;

/** Desde cuándo se cuentan los resultados en Ajustes. */
export const RESTOCK_RESULTS_DAYS = 60;

/** Por debajo de esto el grupo de control no alcanza para comparar. */
export const RESTOCK_MIN_CONTROL = 30;

/** Una fila de `restock_product_catalog`. */
export interface RestockCatalogRow {
  product_key: string;
  title: string | null;
  pedidos: number;
  unidades: number;
}

/** Una fila de `restock_products`. */
export interface RestockProductRow {
  product_key: string;
  shopify_title: string;
  short_name: string;
  days_per_unit: number;
}

/** Una fila de `restock_results`. */
export interface RestockResultRow {
  arm: string;
  clientas: number;
  respondieron: number;
  compraron: number;
  entregados: number;
}

export interface RestockListItem {
  key: string;
  title: string;
  pedidos: number;
  unidades: number;
  /** null = no recibe recordatorio. */
  config: { shortName: string; days: number } | null;
}

/**
 * La lista de Ajustes: primero los productos que ya reciben recordatorio
 * (aunque no se hayan vendido en los últimos 90 días), después los vendidos,
 * de más a menos pedidos. Pura.
 */
export function restockProductList(catalog: RestockCatalogRow[], products: RestockProductRow[]): RestockListItem[] {
  const byKey = new Map(products.map((p) => [p.product_key, p]));
  const seen = new Set<string>();
  const items: RestockListItem[] = [];
  for (const c of catalog) {
    seen.add(c.product_key);
    const p = byKey.get(c.product_key);
    items.push({
      key: c.product_key,
      title: c.title ?? p?.shopify_title ?? c.product_key,
      pedidos: c.pedidos,
      unidades: c.unidades,
      config: p ? { shortName: p.short_name, days: p.days_per_unit } : null,
    });
  }
  for (const p of products) {
    if (seen.has(p.product_key)) continue;
    items.push({
      key: p.product_key,
      title: p.shopify_title,
      pedidos: 0,
      unidades: 0,
      config: { shortName: p.short_name, days: p.days_per_unit },
    });
  }
  const on = items.filter((i) => i.config);
  const off = items.filter((i) => !i.config);
  return [...on, ...off];
}

/**
 * Un nombre corto para el mensaje a partir del título de Shopify, que suele
 * ser una frase entera: «SUPER HUMAN Ethiopian Black Seed Oil – Aceite de…
 * (60 Cápsulas)» → lo de antes del primer guion o paréntesis. Es solo una
 * sugerencia: el dueño lo corrige antes de activar. Pura.
 */
export function suggestShortName(title: string): string {
  const head = title.split(/\s[–—-]\s|\s\(|™|®/)[0] ?? title;
  const clean = head.replace(/\s+/g, " ").trim();
  return (clean || title.trim()).slice(0, 60);
}

export interface RestockArmSummary {
  clientas: number;
  respondieron: number;
  compraron: number;
  entregados: number;
  /** compraron ÷ clientas. */
  tasa: number;
}

export interface RestockSummary {
  enviado: RestockArmSummary;
  control: RestockArmSummary;
  veredicto: string;
}

function arm(rows: RestockResultRow[], name: string): RestockArmSummary {
  const r = rows.find((x) => x.arm === name);
  const clientas = r?.clientas ?? 0;
  const compraron = r?.compraron ?? 0;
  return {
    clientas,
    respondieron: r?.respondieron ?? 0,
    compraron,
    entregados: r?.entregados ?? 0,
    tasa: clientas > 0 ? compraron / clientas : 0,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * El resultado en una frase. Lo que importa no es cuántas compraron con el
 * recordatorio sino cuántas MÁS que el grupo de control, que no lo recibió:
 * la diferencia es lo que el recordatorio vende. Pura.
 */
export function restockResultsSummary(rows: RestockResultRow[]): RestockSummary {
  const enviado = arm(rows, "enviado");
  const control = arm(rows, "control");
  let veredicto: string;
  if (enviado.clientas === 0) {
    veredicto = "Todavía no salió ningún recordatorio.";
  } else if (control.clientas < RESTOCK_MIN_CONTROL) {
    veredicto = `Todavía hay pocas clientas en el grupo de control (${control.clientas}) para comparar. Hacen falta al menos ${RESTOCK_MIN_CONTROL}.`;
  } else {
    const diff = enviado.tasa - control.tasa;
    const pts = Math.abs(diff * 100).toFixed(1);
    veredicto =
      diff > 0
        ? `Con recordatorio compra el ${pct(enviado.tasa)}; sin él, el ${pct(control.tasa)}. El recordatorio suma ${pts} puntos.`
        : `Con recordatorio compra el ${pct(enviado.tasa)}; sin él, el ${pct(control.tasa)}. Por ahora no vende más que no enviarlo.`;
  }
  return { enviado, control, veredicto };
}
