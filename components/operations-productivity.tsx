import { Figure } from "./figures";
import { ProductivityFilters } from "./productivity-filters";
import { ProductivityTabs } from "./productivity-tabs";
import { OperationsProductivityTable } from "./operations-productivity-table";
import {
  SECTION_DESCRIPTIONS,
  SECTION_METRICS,
  productivityHref,
  type OperationsData,
  type ProductivitySection,
} from "@/lib/operations-productivity";
import { localDayPreset, localPresetRange } from "@/lib/productivity";
import { recentMonths, type MonthView } from "@/lib/productivity-month";
import type { DateRange } from "@/lib/access";
import type { StoreSummary } from "@/lib/types";

export function OperationsProductivityBoard({
  data,
  section,
  range,
  month,
  stores,
  storeId,
  tz,
  currency,
  solo,
}: {
  data: OperationsData;
  section: Exclude<ProductivitySection, "leads">;
  range: DateRange;
  month: MonthView | null;
  stores: StoreSummary[];
  storeId: string | null;
  tz: string;
  currency: string;
  solo: boolean;
}) {
  const number = (n: number) => new Intl.NumberFormat("es-PE").format(n);
  const months = recentMonths(tz);
  const href = (
    r = range,
    s = storeId,
    m: string | null = month?.month ?? null,
  ) => productivityHref(section, r, s, m);
  const presets = [
    { label: "Hoy", range: localDayPreset(0, tz) },
    { label: "Ayer", range: localDayPreset(1, tz) },
    ...[7, 30, 90].map((n) => ({
      label: `${n} días`,
      range: localPresetRange(n, tz),
    })),
  ];
  const day = (s: string) =>
    new Intl.DateTimeFormat("es-PE", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${s}T12:00:00Z`));
  const time = new Intl.DateTimeFormat("es-PE", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(data.asOf));
  return (
    <div className="flex flex-col gap-4 xl:min-h-[calc(100dvh-3rem)]">
      <header className="flex shrink-0 flex-col gap-3">
        <div>
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">
            {solo ? "Mi productividad" : "Productividad del equipo"}
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {SECTION_DESCRIPTIONS[section]}
          </p>
        </div>
        <ProductivityTabs
          section={section}
          range={range}
          store={storeId}
          month={month?.month}
        />
        <ProductivityFilters
          periods={presets.map((p) => ({
            label: p.label,
            href: href(p.range, storeId, null),
            active:
              !month && range.from === p.range.from && range.to === p.range.to,
          }))}
          months={months
            .slice(0, 2)
            .map((m, i) => ({
              label: i === 0 ? "Este mes" : m.label.split(" ")[0]!,
              href: href(range, storeId, m.month),
              active: month?.month === m.month,
            }))}
          otherMonths={months
            .slice(2)
            .map((m) => ({ ...m, href: href(range, storeId, m.month) }))}
          otherMonth={
            month && !months.slice(0, 2).some((m) => m.month === month.month)
              ? month.month
              : null
          }
          stores={stores.map((s) => ({
            value: s.id,
            label: s.name,
            href: href(range, s.id),
          }))}
          store={{ value: storeId ?? "", allHref: href(range, null) }}
          sources={[]}
          source={{ value: "", allHref: href() }}
          showSource={false}
        />
      </header>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-ink-500">
        <span>
          {month?.label ??
            (range.from === range.to
              ? day(range.from)
              : `${day(range.from)} al ${day(range.to)}`)}{" "}
          · hora de la tienda
        </span>
        <span>Datos al {time}</span>
      </div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line shadow-control ring-1 ring-line lg:grid-cols-4">
        <Figure
          label="Acciones registradas"
          value={number(data.totals.actions)}
          sub="hechos con autor y fecha"
        />
        <Figure
          label="Pedidos distintos"
          value={number(data.totals.orders)}
          sub="sin duplicar entre personas"
        />
        <Figure
          label={
            section === "resumen" ? "Leads distintos" : "Personas con actividad"
          }
          value={number(
            section === "resumen" ? data.totals.leads : data.totals.people,
          )}
          sub={section === "resumen" ? "gestión comercial" : "en este periodo"}
        />
        <Figure
          label={section === "resumen" ? "Personas con actividad" : "Tiendas"}
          value={number(
            section === "resumen"
              ? data.totals.people
              : storeId
                ? 1
                : stores.length,
          )}
          sub={solo ? "solo tus registros" : "según tus accesos"}
        />
      </dl>
      {section === "diferencia" && (
        <p className="rounded-md border border-line bg-white px-3 py-2 text-xs leading-5 text-ink-600">
          Registrar un comprobante no significa que el pago esté validado. Esta
          pestaña incluye diferencias y gestión de cobranza identificada;
          Validación de pagos incluye también esos comprobantes.
        </p>
      )}
      {data.totals.unclassifiedContacts > 0 && (
        <details className="rounded-md border border-line bg-white px-3 py-2 text-xs text-ink-600">
          <summary className="cursor-pointer font-medium">
            {number(data.totals.unclassifiedContacts)} contactos históricos sin
            sección registrada
          </summary>
          <p className="mt-2 max-w-[75ch] leading-5">
            Se conservan en Master como actividad general. No se asignan a
            cobranza usando el estado actual del pedido. Las gestiones nuevas
            guardan la etapa y el courier que tenía el pedido al registrar la
            acción.
          </p>
        </details>
      )}
      <OperationsProductivityTable
        key={`${section}|${range.from}|${range.to}|${storeId ?? ""}`}
        people={data.people}
        metrics={SECTION_METRICS[section]}
        currency={currency}
        tz={tz}
      />
      <details className="text-xs text-ink-500">
        <summary className="cursor-pointer font-medium">
          Cómo se cuentan las cifras
        </summary>
        <div className="mt-2 max-w-[80ch] space-y-2 leading-5">
          <p>
            El autor del hecho conserva el crédito aunque después cambie la
            responsable del pedido. Confirmados cuenta pedidos con confirmación
            humana registrada, también la confirmación verbal de agencia que
            todavía puede necesitar pago.
          </p>
          <p>
            Una reprogramación requiere una fecha registrada. Repro Provincia
            cuenta la gestión del envío y Repro Lima la llamada o el acuerdo,
            sin volver a sumar sus eventos técnicos. Las aperturas, reservas,
            sincronizaciones y acciones automáticas quedan fuera.
          </p>
          <p>
            Las validaciones muestran pagos positivos que siguen validados y su
            última validación humana registrada. El monto validado es el de esos
            comprobantes, no el ingreso atribuido de una venta. Las horas entre
            acciones son una estimación del registro, no presencia ni
            asistencia.
          </p>
        </div>
      </details>
    </div>
  );
}
