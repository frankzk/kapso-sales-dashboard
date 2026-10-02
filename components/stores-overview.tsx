// Tiendas: la lista de tiendas conectadas y las anomalías de ingesta, con el
// lenguaje del mundo de operación (DESIGN.md). Componente de servidor: no
// importa funciones de módulos "use client" (ver components/ops-styles.ts).

import Link from "next/link";
import { cn } from "@/components/ui";
import { Badge, type BadgeTone } from "@/components/ops-ui";
import { opsButtonClass } from "@/components/ops-styles";
import { IconChevronDown, IconPlus, IconStore } from "@/components/icons";
import { STORE_STATUS_LABEL, type StoreStatus } from "@/lib/store-settings";
import type { AnomalyReport, AnomalyReportRow } from "@/lib/ingest-anomalies";
import type { StoreSummary } from "@/lib/types";

const CARD = "rounded-lg bg-white shadow-control ring-1 ring-line";
const NUM = new Intl.NumberFormat("es-PE");
const WHEN = new Intl.DateTimeFormat("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" });

const STATUS_TONE: Record<StoreStatus, BadgeTone> = {
  active: "ok",
  paused: "warn",
  disabled: "neutral",
};

function StatusBadge({ status }: { status: string }) {
  const known = status in STORE_STATUS_LABEL ? (status as StoreStatus) : null;
  return <Badge tone={known ? STATUS_TONE[known] : "neutral"}>{known ? STORE_STATUS_LABEL[known] : status}</Badge>;
}

export function StoresOverview({ stores, anomalies }: { stores: StoreSummary[]; anomalies: AnomalyReport }) {
  return (
    <div className="mx-auto max-w-[76rem] space-y-12">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Tiendas</h1>
          {/* Sin tiendas no se dice «0 conectadas»: ya lo dice la tarjeta de abajo. */}
          {stores.length > 0 && (
            <p className="mt-1 text-sm text-ink-500">
              {stores.length === 1 ? "1 tienda conectada" : `${NUM.format(stores.length)} tiendas conectadas`} a Shopify
            </p>
          )}
        </div>
        <Link href="/dashboard/stores/new" className={opsButtonClass("primary", "md", "pointer-coarse:h-11")}>
          <IconPlus />
          Conectar tienda
        </Link>
      </header>

      {stores.length ? <StoreList stores={stores} /> : <NoStores />}

      <Anomalies report={anomalies} />
    </div>
  );
}

/* ── Tiendas ─────────────────────────────────────────────────────────────── */

// La última columna tiene ancho fijo, no `auto`: la cabecera no lleva botón,
// y con `auto` las columnas flexibles se repartían distinto en la cabecera y
// en las filas.
const STORE_COLS = "sm:grid-cols-[minmax(0,1.6fr)_5rem_minmax(0,1fr)_8rem_6rem]";

function StoreList({ stores }: { stores: StoreSummary[] }) {
  return (
    <section aria-label="Tiendas conectadas" className={CARD}>
      <div
        aria-hidden
        className={cn("hidden gap-x-4 px-4 py-2.5 text-xs font-semibold leading-4 text-ink-600 sm:grid sm:px-5", STORE_COLS)}
      >
        <span>Tienda</span>
        <span>Moneda</span>
        <span>Zona horaria</span>
        <span>Estado</span>
        <span />
      </div>
      <ul className="divide-y divide-line sm:border-t sm:border-line">
        {stores.map((s) => (
          <li
            key={s.id}
            className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5", STORE_COLS)}
          >
            <div className="min-w-0">
              <Link
                href={`/dashboard/${s.id}`}
                className="text-sm font-semibold leading-5 text-brand-700 hover:underline"
              >
                {s.name}
              </Link>
              <p className="truncate text-[13px] leading-5 text-ink-500">{s.shopify_domain}</p>
              {/* En el teléfono, moneda y zona van debajo del dominio. */}
              <p className="text-[13px] leading-5 text-ink-500 sm:hidden">
                {s.currency} · {s.timezone}
              </p>
            </div>
            <span className="hidden text-sm text-ink-700 sm:block">{s.currency}</span>
            <span className="hidden truncate text-sm text-ink-700 sm:block">{s.timezone}</span>
            <span className="col-start-2 row-start-1 justify-self-end sm:col-start-auto sm:row-start-auto sm:justify-self-start">
              <StatusBadge status={s.status} />
            </span>
            <Link
              href={`/dashboard/${s.id}/settings`}
              aria-label={`Ajustes de ${s.name}`}
              className={opsButtonClass("secondary", "sm", "col-span-2 justify-self-start pointer-coarse:h-11 sm:col-span-1 sm:justify-self-end")}
            >
              Ajustes
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NoStores() {
  return (
    <section className={cn(CARD, "flex flex-col items-start gap-3 px-5 py-6 sm:flex-row sm:items-center sm:justify-between")}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-wash text-ink-500 ring-1 ring-inset ring-line">
          <IconStore className="size-5" />
        </span>
        <div>
          <p className="text-sm font-semibold leading-5 text-ink-900">No hay tiendas conectadas</p>
          <p className="text-[13px] leading-5 text-ink-500">
            Conecta una tienda de Shopify para que sus pedidos lleguen al Master.
          </p>
        </div>
      </div>
      <Link href="/dashboard/stores/new" className={opsButtonClass("secondary", "md", "pointer-coarse:h-11")}>
        Conectar la primera
      </Link>
    </section>
  );
}

/* ── Anomalías de ingesta ────────────────────────────────────────────────── */

const ANOMALY_COLS = "sm:grid-cols-[8.5rem_minmax(0,1fr)_4rem_4rem_4.5rem_1.25rem]";

function Anomalies({ report }: { report: AnomalyReport }) {
  return (
    <section aria-labelledby="anomalias-title">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 flex-1 basis-80">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2 id="anomalias-title" className="text-base font-semibold leading-6 text-ink-900">
              Anomalías de ingesta
            </h2>
            <span className="text-sm text-ink-500">últimos 7 días</span>
          </div>
          <p className="mt-1 max-w-[68ch] text-sm leading-5 text-ink-500">
            Trabajo que la ingesta descartó: conversaciones, handoffs o pasos que no llegaron a convertirse en nada.{" "}
            <strong className="font-semibold text-ink-700">Lo que importa es el salto</strong>, no el nivel — un motivo
            con el mismo número todos los días es rutina conocida; uno que aparece de golpe es algo que empezó a fallar.
          </p>
        </div>
        <dl className="flex gap-6">
          <div>
            <dt className="text-[13px] font-medium leading-5 text-ink-600">Hoy</dt>
            <dd className="text-xl font-semibold leading-7 tabular-nums text-ink-900">{NUM.format(report.hoy)}</dd>
          </div>
          <div>
            <dt className="text-[13px] font-medium leading-5 text-ink-600">Ayer</dt>
            <dd className="text-xl font-semibold leading-7 tabular-nums text-ink-900">{NUM.format(report.ayer)}</dd>
          </div>
        </dl>
      </div>

      <div className={cn(CARD, "mt-4")}>
        {report.filas.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-500 sm:px-5">
            Sin descartes en los últimos 7 días: la ingesta convirtió todo lo que recibió.
          </p>
        ) : (
          <>
            <div
              aria-hidden
              className={cn("hidden gap-x-4 px-4 py-2.5 text-xs font-semibold leading-4 text-ink-600 sm:grid sm:px-5", ANOMALY_COLS)}
            >
              <span>Camino</span>
              <span>Motivo</span>
              <span className="text-right">Hoy</span>
              <span className="text-right">Ayer</span>
              <span className="text-right">7 días</span>
              <span />
            </div>
            <ul className="divide-y divide-line sm:border-t sm:border-line">
              {report.filas.map((r) => (
                <AnomalyItem key={`${r.source}|${r.reason}`} row={r} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Una anomalía. La fila entera abre su ejemplo: el primero del día, guardado
 * para poder reproducir el descarte.
 */
function AnomalyItem({ row: r }: { row: AnomalyReportRow }) {
  // La regla de siempre: algo hoy y nada ayer es lo que empezó a fallar.
  const nuevo = r.hoy > 0 && r.ayer === 0;
  const cells = (
    <>
      <span className="text-[13px] leading-5 text-ink-600 sm:text-sm sm:text-ink-700">{r.source}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="break-all text-sm font-medium leading-5 text-ink-900">{r.reason}</span>
        {nuevo && <Badge tone="warn">Nuevo hoy</Badge>}
      </span>
      {/* En el teléfono las tres cifras van en una línea, con su nombre. */}
      <span className="text-[13px] leading-5 tabular-nums text-ink-600 sm:hidden">
        Hoy <b className={cn("font-semibold", nuevo ? "text-warn-fg" : "text-ink-900")}>{NUM.format(r.hoy)}</b> · Ayer{" "}
        <b className="font-semibold text-ink-900">{NUM.format(r.ayer)}</b> · 7 días{" "}
        <b className="font-semibold text-ink-900">{NUM.format(r.total)}</b>
      </span>
      <span className={cn("hidden text-right text-sm tabular-nums sm:block", nuevo ? "font-semibold text-warn-fg" : "text-ink-900")}>
        {NUM.format(r.hoy)}
      </span>
      <span className="hidden text-right text-sm tabular-nums text-ink-700 sm:block">{NUM.format(r.ayer)}</span>
      <span className="hidden text-right text-sm tabular-nums text-ink-700 sm:block">{NUM.format(r.total)}</span>
    </>
  );
  const grid = cn("grid gap-x-4 gap-y-0.5 px-4 py-3 sm:items-center sm:px-5", ANOMALY_COLS);

  if (!r.sample) {
    return (
      <li className={grid}>
        {cells}
        <span className="hidden sm:block" />
      </li>
    );
  }
  return (
    <li>
      <details className="group">
        <summary
          className={cn(
            grid,
            "relative cursor-pointer list-none pr-10 transition-colors duration-150 hover:bg-wash sm:pr-5 [&::-webkit-details-marker]:hidden",
          )}
        >
          {cells}
          <IconChevronDown
            aria-hidden
            className="absolute right-4 top-3.5 size-4 text-ink-500 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none sm:static sm:justify-self-end"
          />
          <span className="sr-only">Ver ejemplo</span>
        </summary>
        <div className="px-4 pb-4 sm:px-5">
          <p className="text-[13px] leading-5 text-ink-500">
            Ejemplo (el primero del día) · visto por última vez{" "}
            <span className="tabular-nums">{WHEN.format(new Date(r.ultimaVez))}</span>
          </p>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-wash px-3 py-2 font-mono text-xs leading-5 text-ink-700 ring-1 ring-inset ring-line">
            {JSON.stringify(r.sample, null, 2)}
          </pre>
        </div>
      </details>
    </li>
  );
}
