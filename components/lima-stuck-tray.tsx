"use client";

// «Lima trabados» (MOM §9.6, 08-11-2026): los pedidos de Lima quietos en
// Preparación, Por despachar o En curso más de lo que deberían. Las cifras son
// por motivo y filtran la lista (The Cifras Navegan Rule); cada fila dice qué
// toca y de quién es, y abre la ficha del pedido. Solo lee: el motivo lo decide
// `limaStuck` (lib/lima-stuck.ts) con las filas que ya trae Repro Lima.
import { useMemo, useState, type MouseEvent } from "react";
import { Badge, OpsButton, StatusCard, type BadgeTone } from "@/components/ops-ui";
import { OrderLink, useOpenOrderDrawer } from "@/components/order-link";
import { macroStageLabel, macroSubstageLabel } from "@/lib/order-macro-stage";
import { programDayLabel } from "@/lib/dispatch-day";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";
import {
  LIMA_STUCK_OWNER_LABEL,
  LIMA_STUCK_RULES,
  limaStuckCounts,
  limaStuckItems,
  limaStuckRule,
  type LimaStuckItem,
  type LimaStuckOwner,
  type LimaStuckReason,
} from "@/lib/lima-stuck";

const OWNER_TONE: Record<LimaStuckOwner, BadgeTone> = { almacen: "teal", operaciones: "indigo", asesora: "orange" };
const PAGE = 50;

export type LimaStuckSelection = LimaStuckReason | "todos" | null;

function days(n: number): string {
  return `${n.toLocaleString("es-PE")} ${n === 1 ? "día" : "días"}`;
}

/** Un clic en la fila abre la ficha; el del enlace o un botón ya hacen lo suyo. */
function fromControl(event: MouseEvent): boolean {
  return Boolean((event.target as HTMLElement).closest("a,button"));
}

export function LimaStuckTray({ rows, today, selected, onSelect }: {
  /** Las filas de Repro Lima con sus filtros puestos (tienda, búsqueda, canal…). */
  rows: readonly LimaPendingOrder[];
  /** Día de Lima (`limaClock(now).day`). */
  today: string;
  /** El motivo elegido, «todos», o null con la lista cerrada. */
  selected: LimaStuckSelection;
  onSelect: (next: LimaStuckSelection) => void;
}) {
  const items = useMemo(() => limaStuckItems(rows, today), [rows, today]);
  const counts = useMemo(() => limaStuckCounts(items), [items]);
  const byId = useMemo(() => new Map(rows.map((row) => [row.orderId, row])), [rows]);
  const owners = useMemo(() => {
    const out: Record<LimaStuckOwner, number> = { almacen: 0, operaciones: 0, asesora: 0 };
    for (const item of items) out[item.owner] += 1;
    return out;
  }, [items]);
  const listed = selected === null ? [] : selected === "todos" ? items : items.filter((item) => item.reason === selected);
  const [limit, setLimit] = useState(PAGE);
  const visible = listed.slice(0, limit);
  const openDrawer = useOpenOrderDrawer();
  const open = (orderId: string) => openDrawer(orderId, "operar");
  const reasons = LIMA_STUCK_RULES.filter((rule) => counts[rule.reason] > 0 || rule.reason === selected);

  return (
    <section aria-labelledby="lima-stuck-title" className="space-y-3 rounded-lg bg-white p-4 shadow-control ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id="lima-stuck-title" className="text-sm font-semibold text-ink-900">Lima trabados</h3>
        <Badge tone={items.length ? "warn" : "ok"}>{items.length ? `${items.length.toLocaleString("es-PE")} trabados` : "Ninguno"}</Badge>
        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <OpsButton size="sm" onClick={() => { setLimit(PAGE); onSelect(selected === null ? "todos" : null); }} className="pointer-coarse:h-11" aria-expanded={selected !== null}>
              {selected === null ? "Ver la lista" : "Ocultar la lista"}
            </OpsButton>
          </div>
        )}
      </div>
      <p className="text-sm text-ink-700" aria-live="polite">
        {items.length
          ? <>Quietos en Preparación, Por despachar o En curso más de lo que deberían.{" "}
            <span className="text-ink-500">
              {(Object.keys(owners) as LimaStuckOwner[]).filter((o) => owners[o] > 0).map((o) => `${LIMA_STUCK_OWNER_LABEL[o]} ${owners[o].toLocaleString("es-PE")}`).join(" · ")}.
              {" "}Los días cuentan de lunes a sábado; Por reprogramar y el cierre tienen su propia cola.
            </span></>
          : "Ningún pedido de Lima está trabado en Preparación, Por despachar o En curso con estos filtros."}
      </p>

      {reasons.length > 0 && (
        <div role="group" aria-label="Trabados por motivo" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5 [&>button>span:first-child]:whitespace-normal [&>button>span:last-child]:mt-auto">
          {reasons.map((rule) => (
            <StatusCard
              key={rule.reason}
              label={rule.label}
              value={counts[rule.reason]}
              hint={`${rule.hint} Siguiente paso (${LIMA_STUCK_OWNER_LABEL[rule.owner]}): ${rule.action}`}
              active={selected === rule.reason}
              onClick={() => { setLimit(PAGE); onSelect(selected === rule.reason ? "todos" : rule.reason); }}
            />
          ))}
        </div>
      )}

      {selected !== null && (
        listed.length === 0
          ? <p className="-mx-4 border-t border-line px-4 pt-6 pb-2 text-center text-sm text-ink-500">No hay pedidos trabados por este motivo con estos filtros.</p>
          : (
            <div className="-mx-4 -mb-4">
              <div className="hidden border-t border-line xl:block">
                <table className="w-full table-fixed border-collapse text-sm [&_th]:bg-white [&_th]:shadow-[inset_0_-1px_0_var(--color-line)]">
                  <colgroup><col className="w-[9.5rem]" /><col /><col className="w-[8rem]" /><col className="w-[11rem]" /><col className="w-[6.5rem]" /><col /><col /></colgroup>
                  <thead>
                    <tr className="text-left text-xs font-semibold text-ink-600">
                      <th className="px-4 py-2.5">Pedido</th><th className="px-3 py-2.5">Cliente</th><th className="px-3 py-2.5">Courier</th>
                      <th className="px-3 py-2.5">Estado</th><th className="px-3 py-2.5 text-right">Trabado</th><th className="px-3 py-2.5">Motivo</th><th className="px-4 py-2.5">Siguiente paso</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((item) => {
                      const row = byId.get(item.orderId)!;
                      return (
                        <tr key={item.orderId} onClick={(e) => { if (!fromControl(e)) open(item.orderId); }} className="cursor-pointer border-b border-line align-top last:border-b-0 hover:bg-wash">
                          <td className="px-4 py-3"><OrderLink orderId={item.orderId} section="operar" className="block truncate font-semibold text-ink-900 hover:text-brand-700">{row.orderName}</OrderLink><p className="truncate text-xs text-ink-500">{row.storeName}</p></td>
                          <td className="px-3 py-3"><p className="truncate text-ink-900" title={row.customerName}>{row.customerName}</p><p className="truncate text-xs text-ink-500">{row.district?.trim() || "Sin distrito"}</p></td>
                          <td className="px-3 py-3 text-ink-700">{item.courier ?? "—"}</td>
                          <td className="px-3 py-3"><StageBadges row={row} /></td>
                          <td className="px-3 py-3 text-right"><p className="font-semibold tabular-nums text-ink-900">{days(item.daysStuck)}</p><p className="text-xs tabular-nums text-ink-500">desde {programDayLabel(item.since)}</p></td>
                          <td className="px-3 py-3"><Reason item={item} /></td>
                          <td className="px-4 py-3"><NextStep item={item} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-line border-t border-line xl:hidden">
                {visible.map((item) => {
                  const row = byId.get(item.orderId)!;
                  return (
                    <li key={item.orderId} onClick={(e) => { if (!fromControl(e)) open(item.orderId); }} className="cursor-pointer space-y-2 px-4 py-3 hover:bg-wash">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <OrderLink orderId={item.orderId} section="operar" className="font-semibold text-ink-900 hover:text-brand-700">{row.orderName}</OrderLink>
                        <span className="text-[13px] font-semibold tabular-nums text-ink-900">{days(item.daysStuck)}</span>
                      </div>
                      <p className="text-sm text-ink-900">{row.customerName} · <span className="text-ink-500">{item.courier ?? "Sin courier"}</span></p>
                      <StageBadges row={row} />
                      <Reason item={item} />
                      <NextStep item={item} />
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-[13px] tabular-nums text-ink-500">
                <span>Mostrando {visible.length.toLocaleString("es-PE")} de {listed.length.toLocaleString("es-PE")} trabados · lo que más lleva primero</span>
                {visible.length < listed.length && <OpsButton size="sm" onClick={() => setLimit((n) => n + PAGE)} className="pointer-coarse:h-11">Mostrar {PAGE} más</OpsButton>}
              </div>
            </div>
          )
      )}
    </section>
  );
}

function StageBadges({ row }: { row: LimaPendingOrder }) {
  return (
    <div className="flex flex-wrap gap-1">
      <Badge tone="brand">{macroStageLabel(row.stage)}</Badge>
      <Badge wrap>{row.substage ? macroSubstageLabel(row.substage) : "Sin subetapa"}</Badge>
    </div>
  );
}

function Reason({ item }: { item: LimaStuckItem }) {
  return (
    <div>
      <p className="font-medium text-ink-900">{limaStuckRule(item.reason).label}</p>
      {item.detail && <p className="mt-0.5 break-words text-xs text-ink-500">{item.detail}</p>}
    </div>
  );
}

function NextStep({ item }: { item: LimaStuckItem }) {
  return (
    <div className="space-y-1">
      <Badge tone={OWNER_TONE[item.owner]}>{LIMA_STUCK_OWNER_LABEL[item.owner]}</Badge>
      <p className="text-[13px] text-ink-700">{limaStuckRule(item.reason).action}</p>
    </div>
  );
}
