// La lista de importaciones (MOM §45) en el mundo de operación (DESIGN.md):
// el resumen y las píldoras de excepción, las pestañas como tarjetas de estado
// que filtran (The Cifras Navegan Rule), y la tarjeta de trabajo con las filas
// (`ImportRows`: la tabla compacta desde 1280 px y una lista con hairlines por
// debajo). La dibuja el servidor (`app/dashboard/compras/page.tsx`); sin
// «Montos de compras» las filas llegan sin `money` y la columna de costo no se
// dibuja.
//
// Por páginas (MOM §45.2): las cifras de las tarjetas, del tipo y de cada
// proveedor se cuentan en la base (`loadImportListCounts`), no sobre lo
// cargado. «Activas» y las píldoras de excepción se leen COMPLETAS (son las que
// están en curso: el resumen y las alertas las cuentan todas); «Recibidas»,
// «Canceladas» y «Todas» llegan de a 100 con «Ver más».
//
// Compras locales (MOM §45.12): la misma lista, con la chapa «Local», el filtro
// `?tipo=` y su costo en soles; no tienen guía ni aviso a la bodega.

import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/components/ui";
import { statusCardClass } from "@/components/ops-styles";
import { fmtInt, fmtPen, fmtUsd } from "@/components/compras/format";
import { AlertPills, KindPill, SupplierPill } from "@/components/compras/list-filters";
import { ComprasEmpty, IMPORT_ALERT_FILTERS, comprasListHref, type ImportAlertFilter } from "@/components/compras/chrome";
import { ImportRows } from "@/components/compras/import-rows";
import type { ImportListCounts, ImportListRow, SupplierRow } from "@/lib/compras-server";
import { enrichImportRow, matchesAlert } from "@/lib/compras-list";
import { IMPORT_TABS, inImportTab, type ImportKind, type ImportTab } from "@/lib/compras";

const TAB_HINT: Record<ImportTab, string> = {
  activas: "Ni llegaron completas ni se cancelaron (incluye las cotizaciones y las recibidas en parte)",
  recibidas: "Ya llegaron a la bodega de Lima",
  canceladas: "Canceladas",
  todas: "Todas las compras",
};

export function ImportListView({
  active: activeRows,
  page,
  counts,
  orgId,
  suppliers,
  supplierFilter,
  tab,
  alerta,
  tipo = null,
  canMoney,
  orgParam,
  today,
  emptyAction,
}: {
  /** TODAS las activas con el proveedor y el tipo (el resumen y las alertas las cuentan todas). */
  active: ImportListRow[];
  /** La primera página de la pestaña («Recibidas», «Canceladas», «Todas»); null en «Activas» o con una alerta. */
  page: { rows: ImportListRow[]; next: string | null } | null;
  /** Contadas en la base. */
  counts: ImportListCounts;
  orgId: string;
  suppliers: SupplierRow[];
  supplierFilter: SupplierRow | null;
  tab: ImportTab;
  alerta: ImportAlertFilter | null;
  /** `?tipo=`: solo importaciones o solo compras locales (MOM §45.12). */
  tipo?: ImportKind | null;
  canMoney: boolean;
  /** `org` de la URL cuando la persona ve más de una organización. */
  orgParam: string | null;
  today: string;
  /** «Nueva importación», para el estado vacío (solo con «Compras»). */
  emptyAction?: ReactNode;
}) {
  // El proveedor y el tipo ya los filtró la base.
  const kindCounts = counts.kinds;
  const active = activeRows.map((row) => enrichImportRow(row, today));
  const tabCounts = counts.tabs;
  const alertCounts: Record<ImportAlertFilter, number> = {
    avisar: active.filter((e) => e.alerts.notifyWarehouse).length,
    atrasadas: active.filter((e) => e.alerts.late).length,
    sin_novedades: active.filter((e) => e.alerts.stale).length,
  };
  // «Activas» o una alerta: de las activas, que ya están todas; si no, la página de la base.
  const fromActive = !page;
  const visibleRows = fromActive ? active.filter((e) => inImportTab(e.row.imp.status, tab) && matchesAlert(e, alerta)).map((e) => e.row) : page.rows;
  const visibleTotal = fromActive ? visibleRows.length : tabCounts[tab];
  // En camino, en USD: las que tienen costos en soles sin tipo de cambio no se
  // suman a medias. Una compra local toda en soles se suma en soles aparte.
  const inTransit = active.filter((e) => e.row.imp.status !== "cotizacion");
  const inTransitUsd = canMoney ? inTransit.reduce((a, e) => a + (e.row.money?.totalUsd ?? 0), 0) : null;
  const inTransitPen = canMoney
    ? inTransit.reduce((a, e) => a + (e.row.money && e.row.money.totalUsd === null && e.row.money.totalPen !== null ? e.row.money.totalPen : 0), 0)
    : 0;
  const inTransitWithoutFx = canMoney ? inTransit.filter((e) => e.row.money && e.row.money.totalUsd === null && e.row.money.totalPen === null).length : 0;
  const proveedor = supplierFilter?.id ?? null;
  const supplierOptions = suppliers
    .map((s) => ({ value: s.id, label: s.name, count: counts.suppliers[s.id] ?? 0 }))
    .filter((o) => o.count > 0 || o.value === proveedor);
  const filtered = Boolean(supplierFilter || alerta || tipo);
  const showKindPill = kindCounts.local > 0 || Boolean(tipo);
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
              <span className="font-semibold text-ink-900">{fmtUsd(inTransitUsd)}</span>
              {inTransitPen > 0 && (
                <>
                  {" + "}
                  <span className="font-semibold text-ink-900">{fmtPen(inTransitPen)}</span>
                </>
              )}{" "}
              en camino
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
            <AlertPills tab={tab} org={orgParam} proveedor={proveedor} alerta={alerta} tipo={tipo} counts={alertCounts} />
          </>
        )}
      </div>

      <nav aria-label="Importaciones por estado" className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        {IMPORT_TABS.map((t) => {
          const on = t.id === tab && !alerta;
          return (
            <Link
              key={t.id}
              href={comprasListHref({ tab: t.id, org: orgParam, proveedor, tipo })}
              aria-current={on ? "page" : undefined}
              title={TAB_HINT[t.id]}
              className={statusCardClass(on)}
              scroll={false}
            >
              <span className={cn("w-full truncate text-[13px] font-medium", on ? "text-brand-700" : "text-ink-600")}>{t.label}</span>
              <span className={cn("text-xl font-semibold leading-7 tabular-nums", on ? "text-brand-700" : "text-ink-900")}>{fmtInt(tabCounts[t.id])}</span>
            </Link>
          );
        })}
      </nav>

      <section aria-label={`Importaciones: ${alertLabel ?? tabLabel}`} className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            {showKindPill && <KindPill tab={tab} org={orgParam} proveedor={proveedor} alerta={alerta} tipo={tipo} counts={kindCounts} />}
            <SupplierPill tab={tab} org={orgParam} proveedor={proveedor} alerta={alerta} tipo={tipo} options={supplierOptions} />
            {filtered && (
              <Link href={comprasListHref({ tab, org: orgParam })} scroll={false} className="inline-flex h-8 items-center rounded-md px-2.5 text-[13px] font-semibold text-ink-600 transition-colors duration-150 hover:bg-wash hover:text-ink-900 pointer-coarse:h-11">
                Quitar filtros
              </Link>
            )}
          </div>
          <p className="text-[13px] leading-5 tabular-nums text-ink-500">
            {fmtInt(visibleTotal)} compra{visibleTotal === 1 ? "" : "s"}
            {alertLabel ? ` · ${alertLabel.toLowerCase()}` : ""} · las más recientes primero
          </p>
        </div>

        {!visibleRows.length ? (
          <div className="border-t border-line">
            {filtered ? (
              <ComprasEmpty title="Ninguna coincide con los filtros">
                {supplierFilter
                  ? `${supplierFilter.name} no tiene compras ${alertLabel ? `«${alertLabel.toLowerCase()}»` : `en «${tabLabel}»`}.`
                  : alertLabel
                    ? `Nada «${alertLabel.toLowerCase()}» por ahora.`
                    : `Sin ${tipo === "local" ? "compras locales" : "importaciones"} en «${tabLabel}».`}
              </ComprasEmpty>
            ) : !tabCounts.todas ? (
              <ComprasEmpty title="Todavía no hay compras" action={emptyAction}>
                {emptyAction
                  ? "Registra la primera con «Nueva compra»: una importación (proveedor, guía y llegada estimada) o una compra local a un laboratorio o maquila. Después agregas productos, documentos, costos, pagos y entregas en su detalle."
                  : "Cuando se registre una, aparecerá aquí."}
              </ComprasEmpty>
            ) : (
              <ComprasEmpty title={`Sin compras en «${tabLabel}»`}>{TAB_HINT[tab]}: ninguna por ahora.</ComprasEmpty>
            )}
          </div>
        ) : (
          <ImportRows
            // Otros filtros, otra lista: lo cargado con «Ver más» no se arrastra.
            key={`${tab}|${alerta ?? ""}|${proveedor ?? ""}|${tipo ?? ""}`}
            rows={visibleRows}
            next={page?.next ?? null}
            total={visibleTotal}
            query={page ? { orgId, tab, proveedor, tipo } : null}
            canMoney={canMoney}
            today={today}
          />
        )}
      </section>
    </div>
  );
}

