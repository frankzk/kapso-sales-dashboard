"use client";

// Los cinco indicadores del MOM en una franja de celdas, con su periodo en
// chips. Antes eran una tabla de 900 px con los cinco periodos a la vez, que en
// el teléfono se desplazaba de lado; ahora se elige el periodo y cada celda
// lleva la tasa, su «n de m» y una barra de proporción.

import { useState } from "react";
import { cn } from "@/components/ui";
import { ChoiceChip } from "@/components/ops-ui";
import { FIGURE_FRAME, pctText } from "@/components/figures";
import type { MomOwnerKpiKey, MomOwnerPeriodKey, MomOwnerPeriodSummary } from "@/lib/mom-owner-summary";

/** Los nombres cortos de los periodos fijos del MOM, para los chips. */
const CHIP: Record<MomOwnerPeriodKey, string> = {
  today: "Hoy",
  yesterday: "Ayer",
  last7: "7 días",
  month: "Este mes",
  previous_month: "Mes anterior",
};

const nf = new Intl.NumberFormat("es-PE");

export function MomIndicators({
  periods,
  rows,
}: {
  periods: MomOwnerPeriodSummary[];
  rows: { key: MomOwnerKpiKey; label: string; detail: string }[];
}) {
  // Siete días por defecto: hoy está a medias por la mañana y el mes mezcla
  // semanas que ya no se pueden corregir.
  const [key, setKey] = useState<MomOwnerPeriodKey>(periods.some((p) => p.key === "last7") ? "last7" : (periods[0]?.key ?? "last7"));
  const period = periods.find((p) => p.key === key) ?? periods[0];
  if (!period) return null;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 id="mom-indicadores" className="text-sm font-semibold leading-5 text-ink-900">
            Cierre y entregas
          </h3>
          <p className="text-[13px] leading-5 text-ink-500">
            Periodos fijos del Master, aparte del periodo de ventas. Cada tasa con su numerador y denominador.
          </p>
        </div>
        <div role="group" aria-label="Periodo de los indicadores" className="flex flex-wrap gap-1.5">
          {periods.map((p) => (
            <ChoiceChip key={p.key} label={CHIP[p.key] ?? p.label} active={p.key === key} onClick={() => setKey(p.key)} />
          ))}
        </div>
      </div>
      <dl aria-labelledby="mom-indicadores" className={cn(FIGURE_FRAME, "mt-3 grid-cols-1 shadow-none sm:grid-cols-2 lg:grid-cols-5")}>
        {rows.map((row, i) => {
          const value = period.kpis[row.key];
          const rate = value?.rate ?? null;
          return (
            <div
              key={row.key}
              className={cn("flex min-w-0 flex-col bg-white px-4 py-3", i === rows.length - 1 && rows.length % 2 === 1 && "sm:col-span-2 lg:col-span-1")}
            >
              <dt className="text-[13px] font-medium leading-5 text-ink-600" title={row.detail}>
                {row.label}
              </dt>
              <dd className={cn("mt-0.5 text-xl font-semibold leading-7 tabular-nums", rate == null ? "text-ink-500" : "text-ink-900")}>
                {rate == null ? "Sin datos" : pctText(rate)}
              </dd>
              <dd className="mt-auto pt-2">
                <span aria-hidden className="block h-1 rounded-full bg-line">
                  {rate != null && (
                    <span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.max(rate > 0 ? 2 : 0, Math.min(100, rate * 100))}%` }} />
                  )}
                </span>
                <span className="mt-1.5 block text-xs leading-4 text-ink-500">
                  <span className="tabular-nums">
                    {nf.format(value?.numerator ?? 0)} de {nf.format(value?.denominator ?? 0)}
                  </span>
                  {"\u00a0· "}
                  {row.detail.charAt(0).toLowerCase() + row.detail.slice(1)}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
