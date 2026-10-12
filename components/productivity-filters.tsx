"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { cn } from "@/components/ui";
import { ChoiceChip, choiceChipClass } from "@/components/ops-ui";
import { ChoicePill } from "@/components/facet-pill";
import { IconChevronDown } from "@/components/icons";

export type PeriodLink = { label: string; href: string; active: boolean };

/**
 * El periodo, la tienda y la fuente de Productividad. Todo vive en la URL
 * (`from`/`to` o `mes`, `store`, `src`): el tablero se arma en el servidor, así
 * que elegir es navegar. El periodo, que se cambia a diario, va en chips; la
 * tienda y la fuente, en las píldoras del Master, que cierran al elegir.
 */
export function ProductivityFilters({
  periods,
  months,
  otherMonths,
  otherMonth,
  stores,
  store,
  sources,
  source,
}: {
  periods: PeriodLink[];
  /** El mes en curso y el anterior, los que se miran a diario. */
  months: PeriodLink[];
  /** «Otro mes…»: los meses que no caben como chip. */
  otherMonths: { month: string; label: string; href: string }[];
  /** El mes elegido en «Otro mes…», si el que se mira no tiene chip. */
  otherMonth: string | null;
  /** Una opción por tienda (sin la de «todas»), con su enlace; vacío con una sola tienda. */
  stores: { value: string; label: string; href: string }[];
  store: { value: string; allHref: string };
  sources: { value: string; label: string; href: string }[];
  source: { value: string; allHref: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = (href: string) => start(() => router.push(href, { scroll: false }));

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-busy={pending || undefined}>
      {/* Días y meses son dos grupos que bajan enteros: la raya que los separa
          no queda nunca colgando al final de un renglón en el teléfono. */}
      <div role="group" aria-label="Periodo" className="flex flex-wrap items-center gap-1.5">
        <span className="flex flex-wrap items-center gap-1.5">
          {periods.map((p) => (
            <ChoiceChip key={p.label} label={p.label} active={p.active} onClick={() => go(p.href)} />
          ))}
        </span>
        {months.length > 0 && <span aria-hidden className="mx-1 hidden h-5 w-px bg-line-strong sm:block" />}
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
      <div className="flex flex-wrap items-center gap-2 xl:ml-auto">
        {pending && (
          <span role="status" className="text-[13px] text-ink-500">
            Actualizando…
          </span>
        )}
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
        <ChoicePill
          label="Fuente"
          allLabel="Todas las fuentes"
          allValue=""
          options={sources.map(({ value, label }) => ({ value, label }))}
          value={source.value}
          onChange={(next) => go(next ? (sources.find((s) => s.value === next)?.href ?? source.allHref) : source.allHref)}
        />
      </div>
    </div>
  );
}
