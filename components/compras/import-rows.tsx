"use client";

// Las filas de la lista de Compras (MOM §45.2) en el mundo de operación
// (DESIGN.md): la tabla compacta desde 1280 px y la lista con hairlines por
// debajo, y «Ver más» al pie. La primera página la manda el servidor
// (`app/dashboard/compras/page.tsx`); «Ver más» pide la siguiente a
// `loadMoreImports`, desde la última fila mostrada (keyset) y con los mismos
// filtros de la URL, y la agrega debajo. Las cifras de arriba (tarjetas, tipo,
// proveedor) ya vienen contadas en la base: no cambian al cargar más.
//
// Sin «Montos de compras» las filas llegan sin `money` y la columna de costo no
// se dibuja. Una compra local lleva la chapa «Local» y su costo en soles.

import { useState, useTransition } from "react";
import Link from "next/link";
import { cn } from "@/components/ui";
import { Badge } from "@/components/ops-ui";
import { opsButtonClass } from "@/components/ops-styles";
import { IconCheck, IconX } from "@/components/icons";
import { fmtInt, fmtPen, fmtSplit, fmtUsd } from "@/components/compras/format";
import type { ImportListRow } from "@/lib/compras-server";
import { enrichImportRow, type EnrichedImportRow } from "@/lib/compras-list";
import { IMPORT_STATUS_LABEL, MISSING_FX, formatDmy, hasShipping, isActiveStatus, trackingPublicUrl } from "@/lib/compras";
import { importStatusTone } from "@/components/compras/chrome";
import { loadMoreImports } from "@/app/dashboard/compras/actions";

type Enriched = EnrichedImportRow;

/** Con qué filtros sigue «Ver más»: los mismos de la URL. */
export interface ImportRowsQuery {
  orgId: string;
  tab: string;
  proveedor: string | null;
  tipo: string | null;
}

export function ImportRows({
  rows: firstRows,
  next: firstNext,
  total,
  query,
  canMoney,
  today,
}: {
  /** Lo que ya se muestra: la primera página, o todas las activas (sin «Ver más»). */
  rows: ImportListRow[];
  /** El cursor de la página siguiente; null si no hay más. */
  next: string | null;
  /** Cuántas hay con estos filtros (contadas en la base). */
  total: number;
  /** Sin él no hay «Ver más» (la lista ya está completa). */
  query: ImportRowsQuery | null;
  canMoney: boolean;
  today: string;
}) {
  const [more, setMore] = useState<ImportListRow[]>([]);
  const [next, setNext] = useState<string | null>(firstNext);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const seen = new Set<string>();
  const rows = [...firstRows, ...more].filter((r) => (seen.has(r.imp.id) ? false : (seen.add(r.imp.id), true)));
  const enriched = rows.map((r) => enrichImportRow(r, today));

  const loadMore = () => {
    if (!query || !next) return;
    setError(null);
    start(async () => {
      const res = await loadMoreImports({ ...query, cursor: next });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setMore((cur) => [...cur, ...res.rows]);
      setNext(res.next);
    });
  };

  return (
    <>
      <ImportTable rows={enriched} canMoney={canMoney} />
      <ul className="divide-y divide-line border-t border-line xl:hidden">
        {enriched.map((e) => (
          <ImportListItem key={e.row.imp.id} e={e} canMoney={canMoney} />
        ))}
      </ul>
      {query && (next || rows.length < total) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line px-4 py-3 sm:px-5">
          <p className="text-[13px] leading-5 tabular-nums text-ink-500" aria-live="polite">
            Se muestran {fmtInt(rows.length)} de {fmtInt(Math.max(total, rows.length))}
            {error ? <span className="font-medium text-crit-fg"> · {error}</span> : null}
          </p>
          {next && (
            <button type="button" className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11")} disabled={pending} onClick={loadMore}>
              {pending ? "Cargando…" : "Ver más"}
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/** El costo y el saldo en la moneda de la compra: USD la importación, soles la compra local. */
function moneyView(row: ImportListRow): { total: string; pending: number | null; fmt: (n: number) => string; zero: boolean } | null {
  const m = row.money;
  if (!m) return null;
  if (row.imp.kind === "local" && m.totalPen !== null) {
    return { total: fmtPen(m.totalPen), pending: m.pendingPen, fmt: fmtPen, zero: !(m.totalPen > 0) };
  }
  // Costos en soles sin tipo de cambio: cada moneda por separado, nunca una suma a medias.
  return { total: m.totalUsd !== null ? fmtUsd(m.totalUsd) : fmtSplit(m.total), pending: m.pendingUsd, fmt: fmtUsd, zero: !((m.totalUsd ?? 0) > 0) };
}

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
  // Una compra local no tiene guía (MOM §45.12).
  if (!hasShipping(imp.kind)) return <span className="text-ink-500">Entrega el laboratorio</span>;
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
  const v = moneyView(row);
  if (!v) return <span className="text-ink-300">—</span>;
  return (
    <>
      <p className="whitespace-nowrap text-sm leading-5 tabular-nums text-ink-900">{v.total}</p>
      <p className={cn("text-[13px] leading-5 tabular-nums", v.pending === null || v.pending > 0 ? "font-medium text-warn-fg" : "text-ink-500")}>
        {v.pending === null ? MISSING_FX : v.pending > 0 ? `Falta ${v.fmt(v.pending)}` : v.zero ? "Sin costos" : "Pagado"}
      </p>
    </>
  );
}

/** La chapa del tipo: solo la compra local la lleva (la importación es lo de siempre). */
function KindBadge({ row }: { row: ImportListRow }) {
  return row.imp.kind === "local" ? <Badge tone="info">Local</Badge> : null;
}

const TH = "sticky top-0 z-[1] border-y border-line bg-white py-2 pr-3 text-left text-xs font-semibold text-ink-600";

function ImportTable({ rows, canMoney }: { rows: Enriched[]; canMoney: boolean }) {
  return (
    <table className="hidden w-full table-fixed text-left xl:table">
      <thead>
        <tr>
          <th className={cn(TH, "w-[13%] pl-5")}>Compra</th>
          <th className={cn(TH, "w-[15%]")}>Proveedor</th>
          <th className={TH}>Productos</th>
          <th className={cn(TH, "w-[17%]")}>Estado</th>
          <th className={cn(TH, "w-[10%]")}>Llegada</th>
          <th className={cn(TH, "w-[9%]")}>Checklist</th>
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
                <span className="flex flex-wrap items-center gap-1.5">
                  <Link href={`/dashboard/compras/${imp.id}`} className="font-mono text-[13px] font-medium leading-5 text-brand-700 hover:underline">
                    {imp.code}
                  </Link>
                  <KindBadge row={e.row} />
                </span>
                <p className="flex text-[13px] leading-5 text-ink-500">
                  <Tracking row={e.row} />
                </p>
              </td>
              <td className="py-2.5 pr-3">
                <p className="line-clamp-2 text-sm leading-5 text-ink-900">{e.row.supplierName ?? <span className="text-ink-500">Sin proveedor</span>}</p>
                {imp.platform_order && <p className="truncate text-[13px] leading-5 text-ink-500">{imp.kind === "local" ? "Orden" : "Alibaba"} {imp.platform_order}</p>}
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
                  {e.checklist.tracking !== null && <Check ok={e.checklist.tracking} label="Tracking" />}
                  {e.codes.applies && <Check ok={!e.codes.missing.length} label={`Códigos ${e.codes.filled}/3`} />}
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
  const missing = [
    !e.checklist.invoice && "Falta factura",
    e.checklist.tracking === false && "Falta tracking",
    e.codes.applies && e.codes.missing.length > 0 && `Códigos ${e.codes.filled}/3`,
  ].filter(Boolean) as string[];
  const money = canMoney ? moneyView(e.row) : null;
  return (
    <li className="relative px-4 py-3 transition-colors duration-150 hover:bg-wash sm:px-5">
      <div className="flex items-start justify-between gap-3">
        {/* Todo el renglón abre el detalle; el enlace del tracking queda por encima. */}
        <Link href={`/dashboard/compras/${imp.id}`} className="font-mono text-[13px] font-medium leading-5 text-brand-700 after:absolute after:inset-0">
          {imp.code}
        </Link>
        <span className="flex shrink-0 gap-1">
          <KindBadge row={e.row} />
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
      {money && (
        <p className="text-[13px] leading-5 tabular-nums text-ink-700">
          {money.total}
          {money.pending === null ? (
            <span className="font-medium text-warn-fg"> · {MISSING_FX.toLowerCase()}</span>
          ) : money.pending > 0 ? (
            <span className="font-medium text-warn-fg"> · falta {money.fmt(money.pending)}</span>
          ) : !money.zero ? (
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
