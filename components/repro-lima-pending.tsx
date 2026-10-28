"use client";

import { useState, type ReactNode } from "react";
import { Badge, OpsButton, opsButtonClass } from "@/components/ops-ui";
import { OrderLink } from "@/components/order-link";
import { CallButton, ClaimBadge, FailureLine, ReproRowChips, phoneLabel } from "@/components/repro-lima-sheet";
import type { ReproRow } from "@/lib/repro-lima-access";
import { pendingFilters, pendingGroup, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { macroStageLabel, macroSubstageLabel } from "@/lib/order-macro-stage";
import { reproCourierName } from "@/lib/repro-lima";
import { soles, telHref } from "@/lib/rider-contact";

export function LimaPendingFilters({ rows, hidden, onToggle, onReset }: {
  rows: readonly LimaPendingOrder[]; hidden: ReadonlySet<string>;
  onToggle: (keys: string[]) => void; onReset: () => void;
}) {
  const groups = pendingFilters(rows);
  return (
    <fieldset className="space-y-1 rounded-lg bg-white px-4 py-3 ring-1 ring-line">
      <legend className="sr-only">Macroestados y subetapas que se muestran</legend>
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <p className="text-xs text-ink-500">Todos activos al entrar. Desmarca lo que quieras ocultar.</p>
        <OpsButton size="sm" variant="ghost" disabled={!hidden.size} onClick={onReset}>Mostrar todos</OpsButton>
      </div>
      {groups.map((group) => {
        const keys = group.children.map((c) => c.key);
        const checked = keys.every((key) => !hidden.has(key));
        const mixed = !checked && keys.some((key) => !hidden.has(key));
        return (
          <div key={group.stage} className="flex flex-wrap items-center gap-x-3 border-t border-line py-1 first:border-t-0">
            <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm font-semibold text-ink-900 pointer-coarse:min-h-11">
              <input type="checkbox" checked={checked} ref={(el) => { if (el) el.indeterminate = mixed; }} onChange={() => onToggle(keys)} className="size-4 accent-brand-600" />
              {group.label} <span className="font-normal tabular-nums text-ink-500">{group.count.toLocaleString("es-PE")}</span>
            </label>
            <div className="flex flex-wrap items-center gap-x-3" role="group" aria-label={`Subetapas de ${group.label}`}>
              {group.children.map((child) => (
                <label key={child.key} className="flex min-h-9 cursor-pointer items-center gap-1.5 text-xs text-ink-600 pointer-coarse:min-h-11">
                  <input type="checkbox" checked={!hidden.has(child.key)} onChange={() => onToggle([child.key])} className="size-3.5 accent-brand-600" />
                  {child.label} <span className="tabular-nums text-ink-500">{child.count.toLocaleString("es-PE")}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

function PendingContext({ row, repro, today }: { row: LimaPendingOrder; repro?: ReproRow; today: string }) {
  if (repro) return <FailureLine row={repro} />;
  const group = pendingGroup(row, today);
  return <><p className="font-medium text-ink-700">{group.label}</p><p className="mt-1 text-xs text-ink-500">{group.detail}</p></>;
}

function PendingStage({ row, repro, today }: { row: LimaPendingOrder; repro?: ReproRow; today: string }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1"><Badge tone="brand">{macroStageLabel(row.stage)}</Badge><Badge wrap>{row.substage ? macroSubstageLabel(row.substage) : "Sin subetapa"}</Badge></div>
      {repro && <div className="flex flex-wrap gap-1"><ReproRowChips row={repro} today={today} /></div>}
    </div>
  );
}

function PendingDate({ row }: { row: LimaPendingOrder }) {
  const label = row.createdAt && Number.isFinite(Date.parse(row.createdAt))
    ? new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(row.createdAt)) : null;
  return label ? <p className="text-xs tabular-nums text-ink-500">Creado {label}</p> : null;
}

/** La lista amplia conserva la hoja del fallo; fuera de ella usa la ficha real
 * con sus permisos y guardas. No simula un episodio ni crea una segunda guía. */
export function LimaPendingList({ rows, reproRows, today, renderActions }: {
  rows: readonly LimaPendingOrder[]; reproRows: readonly ReproRow[]; today: string;
  renderActions: (row: ReproRow, compact: boolean) => ReactNode;
}) {
  const [limit, setLimit] = useState(100);
  const cases = new Map(reproRows.map((r) => [r.orderId, r]));
  const visible = rows.slice(0, limit);
  const action = (row: LimaPendingOrder, compact: boolean) => {
    const repro = cases.get(row.orderId);
    return repro ? renderActions(repro, compact) : (
      <OrderLink orderId={row.orderId} section="operar" className={opsButtonClass("secondary", compact ? "sm" : "md", "justify-center pointer-coarse:min-h-11")} title={`Gestionar ${row.orderName} sin salir de Repro Lima`}>Gestionar pedido</OrderLink>
    );
  };
  if (!rows.length) return <div className="border-t border-line px-4 py-12 text-center text-sm text-ink-500">No hay pedidos con estos filtros. Activa otros macroestados o quita la búsqueda.</div>;
  return (
    <>
      <div className="hidden max-h-[70vh] overflow-auto border-t border-line xl:block">
        <table className="w-full table-fixed border-collapse text-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-white [&_th]:shadow-[inset_0_-1px_0_var(--color-line)]">
          <colgroup><col className="w-[10.5rem]" /><col /><col /><col /><col className="w-[8.5rem]" /><col className="w-[10rem]" /></colgroup>
          <thead><tr className="text-left text-xs font-semibold text-ink-600"><th className="px-4 py-2.5">Pedido</th><th className="px-3 py-2.5">Cliente</th><th className="px-3 py-2.5">Gestión pendiente</th><th className="px-3 py-2.5">Estado y subetapa</th><th className="px-3 py-2.5 text-right">Venta</th><th className="px-4 py-2.5"><span className="sr-only">Acciones</span></th></tr></thead>
          <tbody>{visible.map((row) => {
            const repro = cases.get(row.orderId);
            return <tr key={row.orderId} className="border-b border-line align-top hover:bg-wash">
              <td className="px-4 py-3"><OrderLink orderId={row.orderId} className="block truncate font-semibold text-ink-900 hover:text-brand-700">{row.orderName}</OrderLink><p className="truncate text-xs text-ink-500">{row.storeName}</p><PendingDate row={row} />{repro && <ClaimBadge row={repro} />}</td>
              <td className="px-3 py-3"><p className="truncate text-ink-900" title={row.customerName}>{row.customerName}</p>{telHref(row.customerPhone) ? <a href={telHref(row.customerPhone)!} className="text-xs tabular-nums text-brand-700 hover:underline">{phoneLabel(row.customerPhone)}</a> : <p className="text-xs text-ink-500">Sin teléfono</p>}<p className="truncate text-xs text-ink-500">{row.district ?? "Sin distrito"}</p></td>
              <td className="px-3 py-3"><PendingContext row={row} repro={repro} today={today} /></td>
              <td className="px-3 py-3"><PendingStage row={row} repro={repro} today={today} /></td>
              <td className="px-3 py-3 text-right"><p className="font-semibold tabular-nums text-ink-900">{soles(row.orderTotal)}</p>{row.courier && <p className="text-xs text-ink-500">{reproCourierName(row.courier)}</p>}</td>
              <td className="px-4 py-3"><div className="flex flex-col gap-1.5">{action(row, true)}</div></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <ul className="divide-y divide-line border-t border-line xl:hidden">{visible.map((row) => {
        const repro = cases.get(row.orderId);
        return <li key={row.orderId} className="space-y-2 px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><OrderLink orderId={row.orderId} className="font-semibold text-ink-900 hover:text-brand-700">{row.orderName}</OrderLink><span className="text-xs text-ink-500">{row.storeName}</span></div>
          <PendingDate row={row} /><p className="text-sm text-ink-900">{row.customerName} · {row.district ?? "Sin distrito"} · {soles(row.orderTotal)}</p>
          <PendingContext row={row} repro={repro} today={today} /><PendingStage row={row} repro={repro} today={today} />
          {repro && <ClaimBadge row={repro} />}
          <div className="flex flex-wrap gap-2 [&>*]:grow"><CallButton phone={row.customerPhone} size="md" />{action(row, false)}</div>
        </li>;
      })}</ul>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-[13px] tabular-nums text-ink-500">
        <span>Mostrando {visible.length.toLocaleString("es-PE")} de {rows.length.toLocaleString("es-PE")} pedidos</span>
        {visible.length < rows.length && <OpsButton size="sm" onClick={() => setLimit((n) => n + 100)}>Mostrar 100 más</OpsButton>}
      </div>
    </>
  );
}
