// La lista de importaciones (MOM §45) en el mundo de operación (DESIGN.md):
// el resumen y las píldoras de excepción, las pestañas como tarjetas de estado
// que filtran (The Cifras Navegan Rule), y la tarjeta de trabajo con la tabla
// compacta desde 1280 px y una lista con hairlines por debajo. La dibuja el
// servidor (`app/dashboard/compras/page.tsx`); sin «Montos de compras» las
// filas llegan sin `money` y la columna de costo no se dibuja.

import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/components/ui";
import { Badge } from "@/components/ops-ui";
import { statusCardClass } from "@/components/ops-styles";
import { IconCheck, IconX } from "@/components/icons";
import { fmtInt, fmtSplit, fmtUsd } from "@/components/compras/format";
import { AlertPills, SupplierPill } from "@/components/compras/list-filters";
import { ComprasEmpty, IMPORT_ALERT_FILTERS, comprasListHref, importStatusTone, type ImportAlertFilter } from "@/components/compras/chrome";
import type { ImportListRow, SupplierRow } from "@/lib/compras-server";
import {
  IMPORT_STATUS_LABEL,
  IMPORT_TABS,
  MISSING_FX,
  formatDmy,
  importAlerts,
  importChecklist,
  inImportTab,
  isActiveStatus,
  trackingPublicUrl,
  type ImportTab,
} from "@/lib/compras";

type Enriched = {
  row: ImportListRow;
  alerts: ReturnType<typeof importAlerts>;
  checklist: { invoice: boolean; tracking: boolean };
};

const TAB_HINT: Record<ImportTab, string> = {
  activas: "Ni llegaron ni se cancelaron (incluye las cotizaciones)",
  recibidas: "Ya llegaron a la bodega de Lima",
  canceladas: "Canceladas",
  todas: "Todas las importaciones",
};

function matchesAlert(e: Enriched, alerta: ImportAlertFilter | null): boolean {
  if (!alerta) return true;
  if (!isActiveStatus(e.row.imp.status)) return false;
  if (alerta === "avisar") return e.alerts.notifyWarehouse;
  if (alerta === "atrasadas") return e.alerts.late;
  return e.alerts.stale;
}

export function ImportListView({
  rows: allRows,
  suppliers,
  supplierFilter,
  tab,
  alerta,
  canMoney,
  orgParam,
  today,
  emptyAction,
}: {
  rows: ImportListRow[];
  suppliers: SupplierRow[];
  supplierFilter: SupplierRow | null;
  tab: ImportTab;
  alerta: ImportAlertFilter | null;
  canMoney: boolean;
  /** `org` de la URL cuando la persona ve más de una organización. */
  orgParam: string | null;
  today: string;
  /** «Nueva importación», para el estado vacío (solo con «Compras»). */
  emptyAction?: ReactNode;
}) {
  const rows = supplierFilter ? allRows.filter((r) => r.imp.supplier_id === supplierFilter.id) : allRows;
  const enriched: Enriched[] = rows.map((row) => ({
    row,
    alerts: importAlerts(
      { status: row.imp.status, eta: row.imp.eta, reportedAt: row.imp.reported_to_warehouse_at, lastMovementAt: row.lastMovementAt },
      today,
    ),
    checklist: importChecklist(row.docKinds, row.imp.tracking_number),
  }));
  const active = enriched.filter((e) => isActiveStatus(e.row.imp.status));
  const counts = Object.fromEntries(IMPORT_TABS.map((t) => [t.id, enriched.filter((e) => inImportTab(e.row.imp.status, t.id)).length])) as Record<ImportTab, number>;
  const alertCounts: Record<ImportAlertFilter, number> = {
    avisar: active.filter((e) => e.alerts.notifyWarehouse).length,
    atrasadas: active.filter((e) => e.alerts.late).length,
    sin_novedades: active.filter((e) => e.alerts.stale).length,
  };
  const visible = enriched.filter((e) => inImportTab(e.row.imp.status, tab) && matchesAlert(e, alerta));
  // En camino, en USD: las que tienen costos en soles sin tipo de cambio no se suman a medias (se cuentan aparte).
  const inTransit = active.filter((e) => e.row.imp.status !== "cotizacion");
  const inTransitUsd = canMoney ? inTransit.reduce((a, e) => a + (e.row.money?.totalUsd ?? 0), 0) : null;
  const inTransitWithoutFx = canMoney ? inTransit.filter((e) => e.row.money && e.row.money.totalUsd === null).length : 0;
  const proveedor = supplierFilter?.id ?? null;
  const supplierOptions = suppliers
    .map((s) => ({ value: s.id, label: s.name, count: allRows.filter((r) => r.imp.supplier_id === s.id).length }))
    .filter((o) => o.count > 0 || o.value === proveedor);
  const filtered = Boolean(supplierFilter || alerta);
  const alertLabel = alerta ? IMPORT_ALERT_FILTERS.find((f) => f.id === alerta)?.label : null;
  const tabLabel = IMPORT_TABS.find((t) => t.id === tab)?.label ?? "";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <p className="text-[13px] leading-5 tabular-nums text-ink-600">
          <span className="font-semibold text-ink-900">{fmtInt(active.length)}</span> activa{active.length === 1 ? "" : "s"}
          {inTransitUsd !== null && (
            <>
              {" · "}
              <span className="font-semibold text-ink-900">{fmtUsd(inTransitUsd)}</span> en camino
              {inTransitWithoutFx > 0 && (
                <span className="font-medium text-warn-fg">
                  {" "}
                  ({inTransitWithoutFx} sin tipo de cambio)
                </span>
              )}
            </>
          )}
        </p>
        {active.length > 0 && (
          <>
            <span aria-hidden className="hidden h-4 w-px bg-line-strong sm:block" />
            <AlertPills tab={tab} org={orgParam} proveedor={proveedor} alerta={alerta} counts={alertCounts} />
          </>
        )}
      </div>

      <nav aria-label="Importaciones por estado" className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        {IMPORT_TABS.map((t) => {
          const on = t.id === tab && !alerta;
          return (
            <Link
              key={t.id}
              href={comprasListHref({ tab: t.id, org: orgParam, proveedor })}
              aria-current={on ? "page" : undefined}
              title={TAB_HINT[t.id]}
              className={statusCardClass(on)}
              scroll={false}
            >
              <span className={cn("w-full truncate text-[13px] font-medium", on ? "text-brand-700" : "text-ink-600")}>{t.label}</span>
              <span className={cn("text-xl font-semibold leading-7 tabular-nums", on ? "text-brand-700" : "text-ink-900")}>{fmtInt(counts[t.id])}</span>
            </Link>
          );
        })}
      </nav>

      <section aria-label={`Importaciones: ${alertLabel ?? tabLabel}`} className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <SupplierPill tab={tab} org={orgParam} proveedor={proveedor} alerta={alerta} options={supplierOptions} />
            {filtered && (
              <Link href={comprasListHref({ tab, org: orgParam })} scroll={false} className="inline-flex h-8 items-center rounded-md px-2.5 text-[13px] font-semibold text-ink-600 transition-colors duration-150 hover:bg-wash hover:text-ink-900 pointer-coarse:h-11">
                Quitar filtros
              </Link>
            )}
          </div>
          <p className="text-[13px] leading-5 tabular-nums text-ink-500">
            {fmtInt(visible.length)} importaci{visible.length === 1 ? "ón" : "ones"}
            {alertLabel ? ` · ${alertLabel.toLowerCase()}` : ""} · las más recientes primero
          </p>
        </div>

        {!visible.length ? (
          <div className="border-t border-line">
            {filtered ? (
              <ComprasEmpty title="Ninguna coincide con los filtros">
                {supplierFilter ? `${supplierFilter.name} no tiene importaciones ${alertLabel ? `«${alertLabel.toLowerCase()}»` : `en «${tabLabel}»`}.` : `Nada «${alertLabel?.toLowerCase()}» por ahora.`}
              </ComprasEmpty>
            ) : !allRows.length ? (
              <ComprasEmpty title="Todavía no hay importaciones" action={emptyAction}>
                {emptyAction
                  ? "Registra la primera con «Nueva importación»: proveedor, guía y llegada estimada. Después agregas productos, documentos, costos y pagos en su detalle."
                  : "Cuando se registre una, aparecerá aquí."}
              </ComprasEmpty>
            ) : (
              <ComprasEmpty title={`Sin importaciones en «${tabLabel}»`}>{TAB_HINT[tab]}: ninguna por ahora.</ComprasEmpty>
            )}
          </div>
        ) : (
          <>
            <ImportTable rows={visible} canMoney={canMoney} />
            <ul className="divide-y divide-line border-t border-line xl:hidden">
              {visible.map((e) => (
                <ImportListItem key={e.row.imp.id} e={e} canMoney={canMoney} />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function arrival(e: Enriched): { date: string; note: string; tone: "crit" | "warn" | "muted" } {
  const { imp } = e.row;
  if (imp.arrived_on) return { date: formatDmy(imp.arrived_on), note: "Llegó", tone: "muted" };
  if (!imp.eta) return { date: "—", note: "Sin llegada estimada", tone: "muted" };
  const days = e.alerts.daysToEta;
  if (!isActiveStatus(imp.status) || days == null) return { date: formatDmy(imp.eta), note: "Estimada", tone: "muted" };
  if (e.alerts.late) return { date: formatDmy(imp.eta), note: `${fmtInt(-days)} d de atraso`, tone: "crit" };
  if (days === 0) return { date: formatDmy(imp.eta), note: "Llega hoy", tone: e.alerts.notifyWarehouse ? "warn" : "muted" };
  return { date: formatDmy(imp.eta), note: `En ${fmtInt(days)} d`, tone: e.alerts.notifyWarehouse ? "warn" : "muted" };
}

const NOTE_TONE = { crit: "font-medium text-crit-fg", warn: "font-medium text-warn-fg", muted: "text-ink-500" } as const;

function AlertBadges({ e }: { e: Enriched }) {
  const { alerts, row } = e;
  const active = isActiveStatus(row.imp.status);
  if (!active) return null;
  const items: { key: string; tone: "warn" | "crit"; label: string }[] = [];
  if (alerts.late) items.push({ key: "late", tone: "crit", label: "Atrasada" });
  if (alerts.notifyWarehouse) items.push({ key: "notify", tone: "warn", label: "Avisar a la bodega" });
  if (alerts.stale) items.push({ key: "stale", tone: "warn", label: `Sin novedades ${fmtInt(alerts.daysSinceMovement)} d` });
  if (!items.length) return null;
  return (
    <>
      {items.map((b) => (
        <Badge key={b.key} tone={b.tone}>
          {b.label}
        </Badge>
      ))}
    </>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[13px] leading-5", ok ? "text-ink-700" : "text-ink-500")}>
      {ok ? <IconCheck aria-hidden className="size-3.5 text-ok-fg" strokeWidth={2.4} /> : <IconX aria-hidden className="size-3.5 text-ink-300" strokeWidth={2.4} />}
      <span>
        <span className="sr-only">{ok ? "Con " : "Falta "}</span>
        {label}
      </span>
    </span>
  );
}

function Tracking({ row }: { row: ImportListRow }) {
  const { imp } = row;
  if (!imp.tracking_number) return <span className="text-ink-500">Sin guía</span>;
  const link = trackingPublicUrl({ carrier: imp.carrier, trackingNumber: imp.tracking_number, trackingUrl: imp.tracking_url });
  return (
    <span className="min-w-0 truncate">
      {imp.carrier ? `${imp.carrier} ` : ""}
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="relative z-[1] font-mono text-xs text-brand-700 hover:underline">
          {imp.tracking_number}
        </a>
      ) : (
        <span className="font-mono text-xs">{imp.tracking_number}</span>
      )}
    </span>
  );
}

function itemsLine(row: ImportListRow): string {
  if (!row.items.length) return "Sin productos";
  return `${row.items.slice(0, 3).map((it) => `${fmtInt(it.qty)} × ${it.name}`).join(" · ")}${row.items.length > 3 ? ` · +${row.items.length - 3}` : ""}`;
}

function Money({ row }: { row: ImportListRow }) {
  if (!row.money) return <span className="text-ink-300">—</span>;
  const { totalUsd, pendingUsd, total } = row.money;
  return (
    <>
      {/* Costos en soles sin tipo de cambio: cada moneda por separado, nunca una suma a medias. */}
      <p className={cn("text-sm leading-5 tabular-nums text-ink-900", totalUsd !== null && "whitespace-nowrap")}>{totalUsd !== null ? fmtUsd(totalUsd) : fmtSplit(total)}</p>
      <p className={cn("text-[13px] leading-5 tabular-nums", pendingUsd === null || pendingUsd > 0 ? "font-medium text-warn-fg" : "text-ink-500")}>
        {pendingUsd === null ? MISSING_FX : pendingUsd > 0 ? `Falta ${fmtUsd(pendingUsd)}` : (totalUsd ?? 0) > 0 ? "Pagado" : "Sin costos"}
      </p>
    </>
  );
}

const TH = "sticky top-0 z-[1] border-y border-line bg-white py-2 pr-3 text-left text-xs font-semibold text-ink-600";

function ImportTable({ rows, canMoney }: { rows: Enriched[]; canMoney: boolean }) {
  return (
    <table className="hidden w-full table-fixed text-left xl:table">
      <thead>
        <tr>
          <th className={cn(TH, "w-[13%] pl-5")}>Importación</th>
          <th className={cn(TH, "w-[15%]")}>Proveedor</th>
          <th className={TH}>Productos</th>
          <th className={cn(TH, "w-[17%]")}>Estado</th>
          <th className={cn(TH, "w-[10%]")}>Llegada</th>
          <th className={cn(TH, "w-[9%]")}>Documentos</th>
          {canMoney && <th className={cn(TH, "w-[14%] pr-5 text-right")}>Costo total</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => {
          const { imp } = e.row;
          const a = arrival(e);
          return (
            <tr key={imp.id} className="border-b border-line align-top transition-colors duration-150 last:border-0 hover:bg-wash">
              <td className="py-2.5 pl-5 pr-3">
                <Link href={`/dashboard/compras/${imp.id}`} className="font-mono text-[13px] font-medium leading-5 text-brand-700 hover:underline">
                  {imp.code}
                </Link>
                <p className="flex text-[13px] leading-5 text-ink-500">
                  <Tracking row={e.row} />
                </p>
              </td>
              <td className="py-2.5 pr-3">
                <p className="line-clamp-2 text-sm leading-5 text-ink-900">{e.row.supplierName ?? <span className="text-ink-500">Sin proveedor</span>}</p>
                {imp.platform_order && <p className="truncate text-[13px] leading-5 text-ink-500">Orden {imp.platform_order}</p>}
              </td>
              <td className="py-2.5 pr-3">
                <p className="text-sm leading-5 tabular-nums text-ink-900">
                  {fmtInt(e.row.units)} u.{" "}
                  <span className="text-ink-500">
                    · {e.row.items.length} producto{e.row.items.length === 1 ? "" : "s"}
                  </span>
                </p>
                <p className="truncate text-[13px] leading-5 text-ink-500" title={itemsLine(e.row)}>
                  {itemsLine(e.row)}
                </p>
              </td>
              <td className="py-2.5 pr-3">
                <div className="flex flex-wrap gap-1">
                  <Badge tone={importStatusTone(imp.status)}>{IMPORT_STATUS_LABEL[imp.status]}</Badge>
                  <AlertBadges e={e} />
                </div>
                {imp.reported_to_warehouse_at && isActiveStatus(imp.status) && <p className="mt-1 text-[13px] leading-5 text-ok-fg">Bodega avisada</p>}
              </td>
              <td className="py-2.5 pr-3">
                <p className="text-sm leading-5 tabular-nums text-ink-900">{a.date}</p>
                <p className={cn("text-[13px] leading-5 tabular-nums", NOTE_TONE[a.tone])}>{a.note}</p>
              </td>
              <td className="py-2.5 pr-3">
                <div className="grid">
                  <Check ok={e.checklist.invoice} label="Factura" />
                  <Check ok={e.checklist.tracking} label="Tracking" />
                </div>
              </td>
              {canMoney && (
                <td className="py-2.5 pr-5 text-right">
                  <Money row={e.row} />
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ImportListItem({ e, canMoney }: { e: Enriched; canMoney: boolean }) {
  const { imp } = e.row;
  const a = arrival(e);
  const missing = [!e.checklist.invoice && "Falta factura", !e.checklist.tracking && "Falta tracking"].filter(Boolean) as string[];
  return (
    <li className="relative px-4 py-3 transition-colors duration-150 hover:bg-wash sm:px-5">
      <div className="flex items-start justify-between gap-3">
        {/* Todo el renglón abre el detalle; el enlace del tracking queda por encima. */}
        <Link href={`/dashboard/compras/${imp.id}`} className="font-mono text-[13px] font-medium leading-5 text-brand-700 after:absolute after:inset-0">
          {imp.code}
        </Link>
        <span className="shrink-0">
          <Badge tone={importStatusTone(imp.status)}>{IMPORT_STATUS_LABEL[imp.status]}</Badge>
        </span>
      </div>
      <p className="mt-0.5 truncate text-sm leading-5 text-ink-900">
        {e.row.supplierName ?? "Sin proveedor"}
        <span className="tabular-nums text-ink-500"> · {fmtInt(e.row.units)} u.</span>
      </p>
      <p className="truncate text-[13px] leading-5 text-ink-500">{itemsLine(e.row)}</p>
      <p className="mt-1 text-[13px] leading-5 tabular-nums text-ink-700">
        {imp.arrived_on ? (
          `Llegó ${a.date}`
        ) : imp.eta ? (
          <>
            Llegada {a.date}
            {a.note !== "Estimada" && (
              <>
                {" · "}
                <span className={NOTE_TONE[a.tone]}>{a.note}</span>
              </>
            )}
          </>
        ) : (
          <span className="text-ink-500">Sin llegada estimada</span>
        )}
      </p>
      {canMoney && e.row.money && (
        <p className="text-[13px] leading-5 tabular-nums text-ink-700">
          {e.row.money.totalUsd !== null ? fmtUsd(e.row.money.totalUsd) : fmtSplit(e.row.money.total)}
          {e.row.money.pendingUsd === null ? (
            <span className="font-medium text-warn-fg"> · {MISSING_FX.toLowerCase()}</span>
          ) : e.row.money.pendingUsd > 0 ? (
            <span className="font-medium text-warn-fg"> · falta {fmtUsd(e.row.money.pendingUsd)}</span>
          ) : (e.row.money.totalUsd ?? 0) > 0 ? (
            <span className="text-ink-500"> · pagado</span>
          ) : null}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <AlertBadges e={e} />
        {missing.map((m) => (
          <Badge key={m}>{m}</Badge>
        ))}
        <span className="flex min-w-0 text-[13px] leading-5 text-ink-500">
          <Tracking row={e.row} />
        </span>
      </div>
    </li>
  );
}
