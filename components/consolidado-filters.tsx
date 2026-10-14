"use client";

// El periodo y la tienda de Consolidado. Todo vive en la URL (`from`/`to`, y la
// tienda es la ruta `/dashboard/[storeId]`): el tablero se arma en el servidor,
// así que elegir es navegar. Mientras llega el tablero nuevo, el de ahora se
// queda en su sitio atenuado (`PendingDim`), sin saltos.

import { createContext, useCallback, useContext, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { ChoiceChip, choiceChipClass, FIELD_BOX, OpsButton } from "@/components/ops-ui";
import { ChoicePill } from "@/components/facet-pill";
import { IconChevronDown } from "@/components/icons";

export type PeriodLink = { label: string; href: string; active: boolean };

const NavContext = createContext<{ go: (href: string) => void; pending: boolean }>({
  go: () => {},
  pending: false,
});

/** Comparte la navegación entre los filtros y lo que se atenúa mientras carga. */
export function ConsolidadoNav({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = useCallback((href: string) => start(() => router.push(href, { scroll: false })), [router]);
  return <NavContext.Provider value={{ go, pending }}>{children}</NavContext.Provider>;
}

/** Lo que cambia con el periodo: se atenúa y no responde mientras llega el nuevo. */
export function PendingDim({ children, className }: { children: ReactNode; className?: string }) {
  const { pending } = useContext(NavContext);
  return (
    <div
      aria-busy={pending || undefined}
      className={cn("transition-opacity duration-150", pending && "pointer-events-none opacity-60", className)}
    >
      {children}
    </div>
  );
}

export function ConsolidadoFilters({
  basePath,
  range,
  periods,
  months,
  otherMonths,
  otherMonth,
  stores,
  store,
}: {
  /** `/dashboard` o `/dashboard/<tienda>`: adonde van las fechas libres. */
  basePath: string;
  range: { from: string; to: string };
  /** Hoy, Ayer, 7, 30 y 90 días. */
  periods: PeriodLink[];
  /** El mes en curso y el anterior. */
  months: PeriodLink[];
  /** «Otro mes…»: los que no caben como chip. */
  otherMonths: { month: string; label: string; href: string }[];
  /** El mes elegido en «Otro mes…», si el periodo es justo ese mes. */
  otherMonth: string | null;
  /** Una opción por tienda con su enlace (sin la de «todas»); vacío con una sola. */
  stores: { value: string; label: string; href: string }[];
  store: { value: string; allHref: string };
}) {
  const { go, pending } = useContext(NavContext);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* Días y meses son dos grupos que bajan enteros: la raya que los separa
          no queda colgando al final de un renglón en el teléfono. */}
      <div role="group" aria-label="Periodo" className="flex flex-wrap items-center gap-1.5">
        <span className="flex flex-wrap items-center gap-1.5">
          {periods.map((p) => (
            <ChoiceChip key={p.label} label={p.label} active={p.active} onClick={() => go(p.href)} />
          ))}
        </span>
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line-strong sm:block" />
        <span className="flex flex-wrap items-center gap-1.5">
          {months.map((m) => (
            <ChoiceChip key={m.label} label={m.label} active={m.active} onClick={() => go(m.href)} />
          ))}
          {otherMonths.length > 0 && (
            <label className="relative inline-flex">
              <span className="sr-only">Elegir otro mes</span>
              <select
                value={otherMonth ?? ""}
                onChange={(event) => {
                  const option = otherMonths.find((o) => o.month === event.target.value);
                  if (option) go(option.href);
                }}
                className={cn(choiceChipClass(Boolean(otherMonth)), "cursor-pointer appearance-none pr-8")}
              >
                <option value="" disabled>
                  Otro mes…
                </option>
                {otherMonths.map((o) => (
                  <option key={o.month} value={o.month}>
                    {o.label}
                  </option>
                ))}
              </select>
              <IconChevronDown
                aria-hidden
                className={cn(
                  "pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2",
                  otherMonth ? "text-brand-700" : "text-ink-500",
                )}
              />
            </label>
          )}
        </span>
      </div>
      <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 sm:w-auto 2xl:ml-auto">
        {pending && (
          <span role="status" className="text-[13px] text-ink-500">
            Actualizando…
          </span>
        )}
        {/* La clave reinicia lo escrito cuando el periodo cambia por otro lado. */}
        <FreeDates key={`${range.from}|${range.to}`} range={range} onApply={(r) => go(`${basePath}?${new URLSearchParams(r)}`)} />
        {stores.length > 1 && (
          <ChoicePill
            label="Tienda"
            allLabel="Todas las tiendas"
            allValue=""
            options={stores.map(({ value, label }) => ({ value, label }))}
            value={store.value}
            onChange={(next) => go(next ? (stores.find((s) => s.value === next)?.href ?? store.allHref) : store.allHref)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Desde / hasta: el rango que no está en los chips. Se aplica con el botón (o
 * Enter), no al tocar cada campo: escribir el año dígito a dígito pasa por
 * fechas válidas («0002-10-05») y cada una habría cargado el tablero entero.
 */
function FreeDates({
  range,
  onApply,
}: {
  range: { from: string; to: string };
  onApply: (r: { from: string; to: string }) => void;
}) {
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
  const dirty = from !== range.from || to !== range.to;
  // En el teléfono, las dos fechas lado a lado con su etiqueta encima; desde
  // 640 px, en línea con los chips.
  const field = cn(FIELD_BOX, "h-8 w-full px-2.5 tabular-nums pointer-coarse:h-11 sm:w-[9.25rem]");
  const label = "flex min-w-0 flex-col gap-1 text-[13px] font-medium text-ink-600 sm:flex-row sm:items-center sm:gap-1.5";
  return (
    <form
      aria-label="Fechas libres"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !dirty) return;
        onApply(from <= to ? { from, to } : { from: to, to: from });
      }}
      className="grid w-full grid-cols-2 items-end gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center"
    >
      <label className={label}>
        Desde
        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={field} />
      </label>
      <label className={label}>
        Hasta
        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={field} />
      </label>
      {dirty && (
        <OpsButton type="submit" size="sm" variant="primary" disabled={!valid} className="col-span-2 pointer-coarse:h-11 sm:col-span-1">
          Aplicar
        </OpsButton>
      )}
    </form>
  );
}
