import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";
import Link from "next/link";
import { cn } from "@/components/ui";
import { CARD_ZONE, SECTION_CARD, SectionHead, Skeleton } from "@/components/ops-ui";
import { opsButtonClass } from "@/components/ops-styles";
import { MomIndicators } from "@/components/mom-indicators";
import { IconChevronRight } from "@/components/icons";
import type { MomOwnerAlert, MomOwnerKpiKey, MomOwnerSummary } from "@/lib/mom-owner-summary";

// La operación del MOM en Consolidado (DESIGN.md › Consolidado): arriba las
// excepciones que esperan a alguien, cada una abre su cola del Master; debajo,
// los cinco indicadores de cierre y entrega con su periodo fijo.

const KPI_ROWS: Array<{ key: MomOwnerKpiKey; label: string; detail: string }> = [
  {
    key: "province_confirmation",
    label: "Confirmación Provincia COD",
    detail: "Pedidos creados que llegaron a confirmación",
  },
  {
    key: "agency_advance",
    label: "Adelanto de Agencia",
    detail: `Pedidos Agencia con ${ADELANTO_MINIMO_LABEL} validados`,
  },
  {
    key: "aliclik_delivery",
    label: "Entrega Aliclik",
    detail: "Salidas entregadas sobre salidas despachadas",
  },
  {
    key: "lima_delivery",
    label: "Entrega Lima total",
    detail: "Pedidos entregados sobre pedidos despachados",
  },
  {
    key: "agency_full_payment",
    label: "Pago completo de Agencia",
    detail: "Pedidos Shalom u Olva pagados por completo",
  },
];

function generatedLabel(value: string): string {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * Una excepción: lo que espera acción se lava en `crit` con la cifra en su
 * tono; en cero queda blanca con «Al día» en `ok-fg`. Toda la celda es el
 * enlace a la cola.
 */
function ExceptionCell({ alert }: { alert: MomOwnerAlert }) {
  const open = alert.count > 0;
  return (
    <li className="flex min-w-0">
      <Link
        href={alert.href}
        className={cn(
          "group flex min-h-[88px] w-full min-w-0 flex-col gap-1.5 px-4 py-3 transition-colors",
          open ? "bg-crit-wash hover:bg-crit-bg" : "bg-white hover:bg-wash",
        )}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold leading-5 text-ink-900">{alert.label}</span>
            <span className="mt-0.5 block text-pretty text-xs leading-4 text-ink-600">{alert.description}</span>
          </span>
          <span className={cn("text-xl font-semibold leading-7 tabular-nums", open ? "text-crit-fg" : "text-ink-500")}>
            {alert.count.toLocaleString("es-PE")}
          </span>
        </span>
        <span className={cn("mt-auto inline-flex items-center gap-1 text-xs font-medium", open ? "text-crit-fg" : "text-ok-fg")}>
          {open ? (
            <>
              Abrir la cola
              <IconChevronRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </>
          ) : (
            "Al día"
          )}
        </span>
      </Link>
    </li>
  );
}

export function MomOwnerSummaryPanel({ summary }: { summary: MomOwnerSummary }) {
  const pending = summary.alerts.filter((a) => a.count > 0).length;
  return (
    <section aria-labelledby="mom-operacion" className={SECTION_CARD}>
      <SectionHead
        id="mom-operacion"
        title="Operación"
        help={
          <>
            {pending
              ? `${pending} ${pending === 1 ? "excepción espera" : "excepciones esperan"} acción`
              : "Ninguna excepción espera acción"}
            {"\u00a0· "}actualizado {generatedLabel(summary.generatedAt)}
          </>
        }
        aside={
          <Link href="/dashboard/pedidos" className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11")}>
            Abrir Master de Pedidos
          </Link>
        }
      />
      <ul
        aria-label="Excepciones que requieren acción"
        className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line sm:grid-cols-2 xl:grid-cols-4"
      >
        {summary.alerts.map((alert) => (
          <ExceptionCell key={alert.key} alert={alert} />
        ))}
      </ul>
      <div className={cn(CARD_ZONE, "mt-4")}>
        <MomIndicators periods={summary.periods} rows={KPI_ROWS} />
      </div>
    </section>
  );
}

export function MomOwnerSummarySkeleton() {
  return (
    <section aria-label="Cargando la operación" className={SECTION_CARD}>
      <Skeleton className="h-5 w-32" />
      <Skeleton className="mt-2 h-4 w-72" />
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-[88px]" />
        ))}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((item) => (
          <Skeleton key={item} className="h-24" />
        ))}
      </div>
    </section>
  );
}
