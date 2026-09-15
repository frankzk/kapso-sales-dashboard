import { cn } from "@/components/ui";
import { lineSubtotal, totalUnits, totalsWorthShowing, type OrderTotals } from "@/lib/order-totals";
import type { OrderLineItem } from "@/lib/types";

/**
 * QUÉ LLEVA EL PEDIDO, EN UNA SOLA FORMA PARA TODA LA APLICACIÓN.
 *
 * Este bloque existía dos veces y las dos eran pobres: en el Master de Pedidos
 * era el título y un «×1» en una cápsula gris, sin variante, sin precio y sin
 * suma; en el cajón de Envíos, lo mismo más el SKU. Para responder «¿cuánto se
 * cobra y por qué?» —la pregunta que se hace mientras se confirma un pedido por
 * teléfono— había que abrir el admin de Shopify en otra pestaña.
 *
 * La variante, el SKU y el precio ESTABAN en el dato desde siempre
 * (`OrderLineItem`); la pantalla no los pintaba. Medido el 14-09-2026 sobre
 * 15.726 ítems de 60 días: precio 100%, SKU 99,5%, variante 17,9%. Por eso la
 * variante es un detalle que aparece cuando existe y no una línea fija que
 * quedaría vacía en cuatro de cada cinco filas.
 *
 * LA MINIATURA viene del espejo `shopify_product_images` (migración 0164):
 * Shopify no manda imagen en el line item —0 de 15.726— así que se espeja el
 * catálogo aparte y se adjunta al leer el pedido. Cuando no hay foto, la fila
 * degrada a la inicial del producto sin cambiar de forma.
 */

/** Todos los pedidos son PEN (19.553 de 19.553 en 90 días). */
function soles(value: number | null): string {
  if (value == null) return "—";
  return `S/ ${value.toFixed(2)}`;
}

/**
 * La miniatura, y su respaldo.
 *
 * La foto viene del espejo `shopify_product_images` (migración 0164), porque
 * Shopify no la manda en el line item del pedido. Tres casos distintos caen en
 * el mismo respaldo y está bien: un producto sin foto de catálogo, uno borrado
 * del catálogo, y uno que el cron todavía no espejó.
 *
 * El respaldo no es un icono genérico repetido: lleva la inicial del producto,
 * así que dos líneas se distinguen de un vistazo aunque ninguna tenga imagen —
 * que es exactamente para lo que sirve una miniatura en una lista.
 */
function Thumb({ title, src }: { title: string; src?: string | null }) {
  const initial = title.trim().charAt(0).toUpperCase() || "?";
  if (src) {
    return (
      // Sin `next/image` a propósito: exigiría declarar el dominio del CDN de
      // Shopify en la configuración, y acá no hay nada que optimizar —la imagen
      // ya viene servida y se pinta a 44 px.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        // La foto REPITE el título que está al lado; anunciarla sería leerlo dos
        // veces. Decorativa para el lector de pantalla, útil para el ojo.
        alt=""
        loading="lazy"
        className="h-11 w-11 shrink-0 rounded-lg border border-slate-200 bg-white object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-sm font-semibold text-slate-500"
    >
      {initial}
    </span>
  );
}

export function OrderLineItems({
  items,
  /**
   * Los importes ya leídos de `orders.raw` en el servidor. Se pasan resueltos y
   * no en crudo a propósito: el payload de Shopify pesa decenas de kB por
   * pedido y no tiene por qué cruzar al navegador para mostrar cuatro cifras.
   * Sin totales, la lista se pinta igual y el bloque de sumas no aparece.
   */
  totals,
  className,
}: {
  items: OrderLineItem[];
  totals?: OrderTotals | null;
  className?: string;
}) {
  if (items.length === 0) {
    return (
      <p className={cn("text-xs text-slate-500", className)}>
        Shopify no devolvió productos para este pedido.
      </p>
    );
  }

  const units = totalUnits(items);
  const showTotals = !!totals && totalsWorthShowing(totals, items.length);

  return (
    <div className={className}>
      <ul className="divide-y divide-slate-100">
        {items.map((item, index) => {
          const linea = lineSubtotal(item);
          return (
            <li
              key={`${item.variant_id ?? item.sku ?? item.title}-${index}`}
              className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0"
            >
              <Thumb title={item.title || "?"} src={item.image_url} />

              <div className="min-w-0 flex-1">
                <p className="text-sm leading-5 text-slate-800">
                  {item.title || "Producto sin nombre"}
                </p>
                {/* La variante manda sobre el SKU: es lo que distingue dos
                    líneas del mismo producto, y lo que se le lee a la clienta
                    por teléfono para confirmar que se le manda lo que pidió. */}
                {item.variant_title && (
                  <p className="mt-0.5 text-xs font-medium text-slate-600">{item.variant_title}</p>
                )}
                {item.sku && (
                  <p className="mt-0.5 font-mono text-xs text-slate-500">{item.sku}</p>
                )}
              </div>

              {/* El importe de la línea a la derecha y en cifras tabulares:
                  varias líneas se comparan leyendo hacia abajo. */}
              <div className="shrink-0 text-right tabular-nums">
                <p className="text-sm font-medium text-slate-800">{soles(linea)}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {item.price == null
                    ? `${item.quantity} u.`
                    : `${soles(item.price)} × ${item.quantity}`}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      {showTotals && totals && (
        <dl className="mt-2.5 space-y-1 border-t border-slate-200 pt-2.5 text-sm tabular-nums">
          <Row label={`Subtotal · ${units} ${units === 1 ? "unidad" : "unidades"}`} value={soles(totals.subtotal)} />
          {/* Un descuento en cero no se dibuja; uno aplicado sí, y en su signo. */}
          {totals.discounts != null && totals.discounts > 0 && (
            <Row label="Descuento" value={`− ${soles(totals.discounts)}`} tone="emerald" />
          )}
          {totals.shipping != null && (
            <Row
              label="Envío"
              value={totals.shipping === 0 ? "Gratis" : soles(totals.shipping)}
            />
          )}
          <Row label="Total" value={soles(totals.total)} strong />
        </dl>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "emerald";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cn("text-xs", strong ? "font-semibold text-slate-800" : "text-slate-500")}>
        {label}
      </dt>
      <dd
        className={cn(
          strong ? "text-sm font-semibold text-slate-900" : "text-xs",
          tone === "emerald" ? "text-emerald-700" : strong ? "" : "text-slate-700",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
