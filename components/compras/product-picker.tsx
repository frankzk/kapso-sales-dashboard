"use client";

// El selector de «Agregar producto» (MOM §45.1): busca por nombre o SKU (sin
// tildes: «bóxer» = «boxer») en el catálogo VIVO de cada tienda de la
// organización (WooCommerce o Shopify) y, para los SKU que ya no están en
// ninguno, en lo conocido por el historial (`buildProductPicker`), los más
// pedidos primero. Elegir uno llena nombre, SKU y la tienda de donde salió.
// Una variante sin SKU sale marcada «Sin SKU». Es un combobox ARIA: flechas,
// Enter y Escape.

import { useId, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { Badge } from "@/components/ops-ui";
import { IconSearch } from "@/components/icons";
import { searchProductPicker, type PickerProduct } from "@/lib/compras-ia";
import { FIELD } from "@/components/compras/header-form";

export function ProductPicker({
  products,
  storeName,
  onPick,
  autoFocus = false,
}: {
  products: PickerProduct[];
  storeName: Map<string, string>;
  onPick: (p: PickerProduct) => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchProductPicker(products, query, 8), [products, query]);

  const choose = (p: PickerProduct | undefined) => {
    if (!p) return;
    onPick(p);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <label htmlFor={`${id}-q`} className="mb-1.5 block text-[13px] font-medium leading-5 text-ink-700">
        Producto de las tiendas
      </label>
      <div className="relative">
        <IconSearch aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
        <input
          ref={input}
          id={`${id}-q`}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${id}-o${active}` : undefined}
          autoComplete="off"
          autoFocus={autoFocus}
          className={cn(FIELD, "pl-9")}
          placeholder="Busca por nombre o SKU"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && open) {
              e.preventDefault();
              choose(results[active]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label="Productos de las tiendas"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg bg-white p-1 shadow-pop"
        >
          {results.length ? (
            results.map((p, i) => (
              <li
                key={p.key}
                id={`${id}-o${i}`}
                role="option"
                aria-selected={i === active}
                // `onMouseDown`: elegir antes de que el campo pierda el foco y cierre la lista.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(p);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex cursor-pointer items-start justify-between gap-3 rounded-md px-2.5 py-2 pointer-coarse:min-h-11",
                  i === active ? "bg-wash" : "",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm leading-5 text-ink-900">{p.name ?? p.sku}</span>
                  <span className="block truncate text-[13px] leading-5 text-ink-500">
                    {p.sku ? <span className="font-mono text-xs text-ink-700">{p.sku}</span> : <Badge tone="warn">Sin SKU</Badge>}
                    {" · "}
                    {p.storeId ? (storeName.get(p.storeId) ?? "Una tienda") : "Tienda por elegir"}
                  </span>
                </span>
                {p.orderCount > 0 && (
                  <span className="shrink-0 text-[13px] leading-5 tabular-nums text-ink-500">
                    {p.orderCount.toLocaleString("es-PE")} pedido{p.orderCount === 1 ? "" : "s"}
                  </span>
                )}
              </li>
            ))
          ) : (
            <li className="px-2.5 py-2 text-[13px] leading-5 text-ink-500">
              Ningún producto de las tiendas coincide. Si es nuevo, elige «Producto nuevo».
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
