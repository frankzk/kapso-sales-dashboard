"use client";

import { useState, type ReactNode } from "react";
import { Badge, ChoiceChip, OpsButton, choiceChipClass } from "@/components/ops-ui";
import { OrderLink } from "@/components/order-link";
import { CallButton, ClaimBadge, FailureLine, ReproRowChips, phoneLabel } from "@/components/repro-lima-sheet";
import type { ReproRow } from "@/lib/repro-lima-access";
import { pendingFilters, pendingGroup, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { macroStageLabel, macroSubstageLabel } from "@/lib/order-macro-stage";
import { reproCourierName } from "@/lib/repro-lima";
import { programDayLabel } from "@/lib/dispatch-day";
import { soles, telHref } from "@/lib/rider-contact";

export function LimaPendingFilters({ rows, hidden, onToggle, onReset }: {
  rows: readonly LimaPendingOrder[]; hidden: ReadonlySet<string>;
  onToggle: (keys: string[]) => void; onReset: () => void;
}) {
  const groups = pendingFilters(rows);
  const allActive = groups.every((group) => group.children.every((child) => !hidden.has(child.key)));
  return (
    <div role="group" aria-label="Macroestados y subetapas que se muestran" className="space-y-2">
      <p className="sr-only">Todos activos al entrar. Desmarca lo que quieras ocultar.</p>
      <div role="group" aria-label="Macroestado" className="flex flex-wrap items-center gap-1.5">
        <span className="w-full text-[13px] font-medium text-ink-600 sm:mr-1 sm:w-20">Macroestado</span>
        <ChoiceChip label="Todos" count={rows.length} active={allActive} onClick={onReset} title="Mostrar todos los macroestados y subetapas" />
        {groups.map((group) => {
          const keys = group.children.map((c) => c.key);
          const checked = keys.every((key) => !hidden.has(key));
          const mixed = !checked && keys.some((key) => !hidden.has(key));
          return (
            <button
              key={group.stage}
              type="button"
              aria-pressed={mixed ? "mixed" : checked}
              onClick={() => onToggle(keys)}
              title={mixed ? `${group.label}: selección parcial. Mostrar todas sus subetapas.` : `${checked ? "Ocultar" : "Mostrar"} ${group.label}`}
              className={choiceChipClass(checked || mixed)}
            >
              {mixed && <span aria-hidden="true">−</span>}
              {group.label}
              <span className="tabular-nums">{group.count.toLocaleString("es-PE")}</span>
            </button>
          );
        })}
      </div>
      <div role="group" aria-label="Subetapa" className="flex flex-wrap items-center gap-1.5">
        <span className="w-full text-[13px] font-medium text-ink-600 sm:mr-1 sm:w-20">Subetapa</span>
        {groups.flatMap((group) => group.children.map((child) => (
          <ChoiceChip
            key={child.key}
            label={child.label}
            count={child.count}
            active={!hidden.has(child.key)}
            onClick={() => onToggle([child.key])}
            title={`${group.label} · ${child.label}`}
          />
        )))}
      </div>
    </div>
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
      {!repro && row.programmedFor && <Badge tone={row.programmedFor < today ? "warn" : "info"} wrap>{`Programado ${programDayLabel(row.programmedFor)}${row.programmedFor < today ? " · vencido" : ""}`}</Badge>}
    </div>
  );
}

function PendingDate({ row }: { row: LimaPendingOrder }) {
  const label = row.createdAt && Number.isFinite(Date.parse(row.createdAt))
    ? new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(row.createdAt)) : null;
  return label ? <p className="text-xs tabular-nums text-ink-500">Creado {label}</p> : null;
}

/** Atender siempre abre la gestión. El código abre la ficha del pedido. */
export function LimaPendingList({ rows, reproRows, today, renderActions, emptyText }: {
  rows: readonly LimaPendingOrder[]; reproRows: readonly ReproRow[]; today: string;
  renderActions: (row: LimaPendingOrder, compact: boolean) => ReactNode;
  emptyText?: string;
}) {
  const [limit, setLimit] = useState(100);
  const cases = new Map(reproRows.map((r) => [r.orderId, r]));
  const visible = rows.slice(0, limit);
  const action = (row: LimaPendingOrder, compact: boolean) => renderActions(row, compact);
  if (!rows.length) return <div className="border-t border-line px-4 py-12 text-center text-sm text-ink-500">{emptyText ?? "No hay pedidos con estos filtros. Activa otros macroestados o quita la búsqueda."}</div>;
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
