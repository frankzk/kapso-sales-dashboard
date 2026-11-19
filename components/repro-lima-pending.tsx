"use client";

// La lista de Repro Lima (MOM §9.5): una sola, con el flujo y la Agenda de
// arriba como filtros (owner, 15-11-2026). Cada fila dice de un vistazo el pedido, la
// clienta (teléfono y dirección), qué pasa (la etapa, el courier y su último
// estado, el fallo, el acuerdo y la última nota), el próximo paso, la fecha
// agendada y «Agendar» y «Atender».
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { approveAliclikRetry, dismissAliclikRetry } from "@/app/dashboard/pedidos/repro-lima/retry-actions";
import { Badge, CHECKBOX, ChoiceChip, OpsButton, choiceChipClass } from "@/components/ops-ui";
import { OrderLink } from "@/components/order-link";
import { CallButton, ClaimBadge, FailureLine, ReproRowChips, phoneLabel } from "@/components/repro-lima-panel";
import { STUCK_OWNER_TONE } from "@/components/lima-stuck-tray";
import type { ReproRow } from "@/lib/repro-lima-access";
import { pendingFilters, pendingGroup, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { agendaDayText, agendaOriginLine, callDue, classifyLimaRows, courierNowText, courierRouteText, limaNextStep, type LimaRowClass } from "@/lib/repro-lima-blocks";
import { programDayLabel } from "@/lib/dispatch-day";
import { LIMA_STUCK_OWNER_LABEL, limaStuckRule, type LimaStuckItem } from "@/lib/lima-stuck";
import { macroStageLabel, macroSubstageLabel } from "@/lib/order-macro-stage";
import { riderSuggestionText } from "@/lib/lima-rider-suggest";
import { telHref } from "@/lib/rider-contact";
import { loadPriorOrderCounts } from "@/app/dashboard/pedidos/repro-lima/prior-counts-actions";
import { priorCountsLabel, type PriorCounts } from "@/lib/customer-prior-counts";
import { limaHistoryText } from "@/lib/lima-block-details";
import { limaNeedsReview } from "@/lib/lima-situations";

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

/**
 * «Qué pasa»: el courier con su último estado, el fallo o la situación, el
 * acuerdo y la caja (las chapas de Repro Lima) y la nota de la última llamada.
 * La etapa va debajo del código (`StageBadges`).
 */
/** La etapa del Master y su subetapa: debajo del código del pedido (owner, 16-11-2026). */
function StageBadges({ row, cls }: { row: LimaPendingOrder; cls?: LimaRowClass }) {
  return <div className="flex flex-wrap gap-1">{cls?.step === "nuevos" && <Badge tone="fuchsia" title="Primera salida pendiente, sin llamada ni guía de courier.">Nuevo</Badge>}<Badge tone="brand">{macroStageLabel(row.stage)}</Badge><Badge wrap>{row.substage ? macroSubstageLabel(row.substage) : "Sin subetapa"}</Badge></div>;
}

function WhatHappens({ row, repro, today }: { row: LimaPendingOrder; repro?: ReproRow; today: string }) {
  const courier = courierNowText(row);
  // El motorizado que llevaría su distrito (17-11-2026), mientras GF Courier no asigne a nadie.
  // El servidor solo la deja con guía de GF Courier sin motorizado (`shownRiderSuggestion`), y el filtro «Motorizado» la usa sin asignado.
  const suggested = row.suggestedRiders?.length ? riderSuggestionText(row.suggestedRiders) : null;
  // El que GF Courier ya asignó (17-11-2026): manda sobre la sugerencia.
  const assigned = row.gfAssigned ?? null;
  return (
    <div className="space-y-1.5">
      {courier && <p className="break-words text-sm font-medium leading-5 text-ink-900">{courier}</p>}
      <p className="break-words text-xs leading-5 text-ink-500">{limaHistoryText(row)}</p>
      {limaNeedsReview(row) ? <Badge tone="warn" wrap>Revisar posible cierre: salió con varios couriers</Badge> : null}
      {assigned && (
        <p className="text-[13px] leading-5 text-ink-600" title="El motorizado que GF Courier asignó a esta guía, según su aviso.">
          Asignado: <span className="font-medium text-ink-900">{assigned.rider}</span>{assigned.day && <span className="text-ink-500"> · ruta del {assigned.day}</span>}
        </p>
      )}
      {!assigned && suggested && (
        <p className="text-[13px] leading-5 text-ink-600" title="Quién llevó la mayoría de entregas de este distrito en los últimos 30 días. GF Courier asigna el motorizado; esto es una sugerencia.">
          Sugerido: <span className="font-medium text-ink-900">{suggested}</span> <span className="text-ink-500">· por su distrito</span>
        </p>
      )}
      {repro ? <FailureLine row={repro} /> : <p className="text-[13px] leading-5 text-ink-600">{pendingGroup(row, today).label}</p>}
      {repro && <div className="flex flex-wrap gap-1"><ReproRowChips row={repro} today={today} /></div>}
      {repro?.lastCall?.note && <p className="break-words text-xs leading-5 text-ink-500">Última nota: {repro.lastCall.note}</p>}
    </div>
  );
}

function days(n: number): string {
  return `${n.toLocaleString("es-PE")} ${n === 1 ? "día" : "días"}`;
}

/**
 * «Próximo paso»: un trabado (§9.6) lo dice con su regla, su responsable y sus
 * días; si no, lo que toca por su tarea, su día o su courier. Un reintento por
 * Aliclik lleva aquí «Aprobar».
 */
function NextStep({ row, repro, cls, stuck, today, now }: { row: LimaPendingOrder; repro?: ReproRow; cls: LimaRowClass; stuck?: LimaStuckItem; today: string; now?: Date }) {
  const rule = stuck ? limaStuckRule(stuck.reason) : null;
  return (
    <div className="space-y-1">
      {stuck && rule ? (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone="warn" wrap>{`Trabado · ${days(stuck.daysStuck)}`}</Badge>
            <Badge tone={STUCK_OWNER_TONE[stuck.owner]}>{LIMA_STUCK_OWNER_LABEL[stuck.owner]}</Badge>
          </div>
          <p className="text-sm font-medium leading-5 text-ink-900">{rule.label}</p>
          {stuck.detail && <p className="break-words text-xs text-ink-500">{stuck.detail}</p>}
          <p className="text-[13px] leading-5 text-ink-700">{rule.action}</p>
        </>
      ) : (
        // La llamada pedida cuya hora ya llegó va en rojo (owner, 15-11-2026).
        <p className={cn("text-sm leading-5", cls.task === "llamar_despues" && callDue(repro, now ?? new Date()) ? "font-medium text-warn-fg" : "text-ink-900")}>{limaNextStep(row, repro, cls, today, now)}</p>
      )}
      {repro?.retryChain && <RetryChainNote orderId={row.orderId} chain={repro.retryChain} />}
    </div>
  );
}

/** «Fecha agendada»: el día de la Agenda y de dónde sale; con el courier y sin día por delante, la fecha de su ruta. */
function AgendaCell({ row, cls, repro, today }: { row: LimaPendingOrder; cls: LimaRowClass; repro?: ReproRow; today: string }) {
  if (cls.needsToday) return <div><p className="text-sm font-medium text-brand-700">Gestionar hoy</p><p className="text-xs text-ink-500">Provincia a Lima · sin fecha de despacho</p></div>;
  // Ruta vencida sin reporte (owner, 15-11-2026): el día en que salió, como un no entregado.
  if (cls.noReport) {
    return (
      <div>
        <p className="whitespace-nowrap text-sm font-medium tabular-nums text-warn-fg">{cls.routeDay ? `Salió ${programDayLabel(cls.routeDay)}` : "Salió a ruta"}</p>
        <p className="whitespace-nowrap text-xs text-ink-500">Sin reporte</p>
      </div>
    );
  }
  // Con el courier y sin día por delante: la fecha de la ruta del courier (owner, 15-11-2026).
  const route = !cls.agenda ? courierRouteText(row, cls, today) : null;
  if (route) {
    return (
      <div>
        <p className={cn("whitespace-nowrap text-sm font-medium tabular-nums", route.overdue ? "text-warn-fg" : "text-ink-900")}>{route.day}</p>
        <p className="whitespace-nowrap text-xs text-ink-500">{route.detail}</p>
      </div>
    );
  }
  const overdue = Boolean(cls.agendaDay && cls.agendaDay < today);
  const origin = cls.agendaOrigin;
  return (
    <div>
      <p className={cn("text-sm font-medium tabular-nums", overdue ? "text-warn-fg" : cls.agendaDay ? "text-ink-900" : "text-ink-500")}>{agendaDayText(cls.agendaDay, today)}</p>
      {origin && <p className="text-xs text-ink-500">{agendaOriginLine(origin, row, repro?.agreement?.courierName)}</p>}
    </div>
  );
}

/**
 * La cadena de reintentos por Aliclik (MOM §9.5, 03-11-2026): qué intento toca,
 * con qué transporte y si el paquete ya está en la oficina. No se llama: la
 * guía se crea desde la ficha con ese transporte.
 */
function RetryChainNote({ orderId, chain }: { orderId: string; chain: NonNullable<ReproRow["retryChain"]> }) {
  const transport = chain.next === "autoecom" ? "AUTOECOM" : "ALIDRIVER";
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const run = (action: () => Promise<{ error?: string; notice?: string; done?: boolean }>) => {
    setMessage(null);
    start(async () => {
      const result = await action();
      setMessage(result.error ? { ok: false, text: result.error } : { ok: true, text: result.notice ?? "Listo." });
      if (result.done) {
        setDismissing(false);
        router.refresh();
      }
    });
  };
  return (
    <div className="space-y-1">
      <Badge tone="brand" wrap>{`Reintento Aliclik ${chain.attempt} de ${chain.of} · ${transport}`}</Badge>
      <p className="text-xs text-ink-500">{chain.failedText}</p>
      <p className={chain.ready ? "text-xs text-ink-500" : "text-xs text-warn-fg"}>
        {!chain.ready ? "Falló hoy: el reintento se aprueba desde mañana." : chain.inOffice ? "Paquete en oficina." : "El paquete aún no vuelve a oficina."}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <OpsButton
          size="sm"
          variant="primary"
          disabled={pending || !chain.ready}
          onClick={() => run(() => approveAliclikRetry(orderId))}
          className="pointer-coarse:h-11"
        >
          {pending && !dismissing ? "Creando guía…" : `Aprobar · ${transport}`}
        </OpsButton>
        <OpsButton size="sm" disabled={pending} onClick={() => setDismissing((v) => !v)} className="pointer-coarse:h-11">
          A Repro Lima
        </OpsButton>
        <OrderLink orderId={orderId} section="operar" className="text-xs font-medium text-brand-700 hover:underline">
          Abrir ficha
        </OrderLink>
      </div>
      {dismissing && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); run(() => dismissAliclikRetry(orderId, reason)); }}
        >
          <label className="sr-only" htmlFor={`retry-why-${orderId}`}>Por qué pasa a Repro Lima</label>
          <input
            id={`retry-why-${orderId}`}
            value={reason}
            maxLength={500}
            placeholder="Por qué pasa a Repro Lima"
            onChange={(e) => setReason(e.target.value)}
            className="h-8 min-w-48 flex-1 rounded-md bg-white px-2 text-xs ring-1 ring-inset ring-line-strong pointer-coarse:h-11"
          />
          <OpsButton size="sm" type="submit" disabled={pending || reason.trim().length < 3} className="pointer-coarse:h-11">
            {pending ? "Guardando…" : "Pasar"}
          </OpsButton>
        </form>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-xs text-ok-fg" : "text-xs text-crit-fg"}>{message.text}</p>
      )}
    </div>
  );
}

const LIMA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" });
const LIMA_HOUR = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false });

function PendingDate({ row }: { row: LimaPendingOrder }) {
  if (!row.createdAt || !Number.isFinite(Date.parse(row.createdAt))) return null;
  const at = new Date(row.createdAt);
  // Lo de hoy con su hora (owner, 17-11-2026): se ve si entró antes o después del corte.
  const label = LIMA_DAY.format(at) === LIMA_DAY.format(new Date())
    ? `hoy ${LIMA_HOUR.format(at)}`
    : new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "2-digit" }).format(at);
  return <p className="text-xs tabular-nums text-ink-500">Creado {label}</p>;
}

/**
 * La dirección completa bajo el cliente (owner, 06-11-2026): con el distrito
 * solo no se sabía si el pedido podía salir sin llamar. Entera, sin cortar.
 */
function PendingAddress({ row }: { row: LimaPendingOrder }) {
  const district = row.district?.trim() || "Sin distrito";
  return (
    <div className="text-xs leading-5">
      <p className="break-words text-ink-700">{row.address ? `${row.address} · ${district}` : `Sin dirección · ${district}`}</p>
      {row.reference && <p className="break-words text-ink-500">Ref. {row.reference}</p>}
    </div>
  );
}

/**
 * Elegir varios: qué reintentos de Aliclik aprobar (owner, 06-11-2026) o, en
 * las demás listas, qué pedidos «Mover a…» otro día (owner, 15-11-2026). Una
 * casilla en cada fila que se puede elegir y, arriba, la de todas.
 */
export interface LimaRowSelection {
  selectable: (row: LimaPendingOrder) => boolean;
  selected: ReadonlySet<string>;
  onToggle: (orderId: string) => void;
  onToggleAll: (orderIds: string[], on: boolean) => void;
  /** Para qué se elige: «aprobar» o «mover». */
  purpose?: "aprobar" | "mover";
}

function SelectBox({ row, selection }: { row: LimaPendingOrder; selection: LimaRowSelection }) {
  if (!selection.selectable(row)) return null;
  return (
    <input
      type="checkbox"
      className={cn(CHECKBOX, "pointer-coarse:size-5")}
      checked={selection.selected.has(row.orderId)}
      onChange={() => selection.onToggle(row.orderId)}
      aria-label={`Elegir ${row.orderName} para ${selection.purpose === "mover" ? "programarlo" : "aprobar"}`}
    />
  );
}

function allLabel(selection: LimaRowSelection, count: number): string {
  return selection.purpose === "mover" ? `Elegir los ${count} que se pueden programar` : `Elegir los ${count} listos`;
}

function allAria(selection: LimaRowSelection, count: number): string {
  return selection.purpose === "mover" ? `Elegir los ${count} que se pueden programar` : `Elegir los ${count} listos para aprobar`;
}

/**
 * ¿Tuvo pedidos antes? (owner, 13-11-2026; MOM §8.1): los conteos de las filas
 * que se ven, leídos después de dibujar la tabla. Se piden solo los que faltan;
 * un fallo deja la fila sin etiqueta, nunca con «Primer pedido» inventado.
 */
function usePriorCounts(orderIds: readonly string[]): ReadonlyMap<string, PriorCounts> {
  const [counts, setCounts] = useState<ReadonlyMap<string, PriorCounts>>(() => new Map());
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set());
  const key = orderIds.join(",");
  useEffect(() => {
    const missing = orderIds.filter((id) => !asked.has(id));
    if (!missing.length) return;
    setAsked((prev) => new Set([...prev, ...missing]));
    // Sin «alive»: cada resultado va por pedido, así que guardarlo aunque la
    // lista haya cambiado no pisa nada, y descartarlo dejaría esas filas sin
    // etiqueta para siempre (ya constan como pedidas).
    loadPriorOrderCounts(missing)
      .then((res) => {
        if ("counts" in res) setCounts((prev) => new Map([...prev, ...Object.entries(res.counts)]));
      })
      .catch(() => undefined);
    // `key` resume la lista de ids; `asked` no se vuelve a leer como dependencia
    // para no pedir dos veces lo mismo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return counts;
}

/** La etiqueta bajo el cliente: «Primer pedido» o «3 pedidos más · 2 recibidos». */
function PriorCountsTag({ counts }: { counts: PriorCounts | undefined }) {
  if (!counts) return null;
  const label = priorCountsLabel(counts);
  return (
    <div className="mt-1">
      <Badge tone={label.tone} className="tabular-nums" title={label.title}>{label.text}</Badge>
    </div>
  );
}

/**
 * La única lista. «Atender» siempre abre la gestión y el código, la ficha del
 * pedido. Sin `classes` se clasifica aquí (la pantalla las pasa ya hechas).
 */
export function LimaPendingList({ rows, reproRows, today, now, classes, stuck, renderActions, emptyText, selection }: {
  rows: readonly LimaPendingOrder[]; reproRows: readonly ReproRow[]; today: string;
  /** La hora de Lima para «Llamar hoy 15:00». */
  now?: Date;
  /** El paso, el día y el courier de cada fila (`classifyLimaRows`). */
  classes?: ReadonlyMap<string, LimaRowClass>;
  /** Los trabados del equipo (§9.6), por pedido. */
  stuck?: ReadonlyMap<string, LimaStuckItem>;
  renderActions: (row: LimaPendingOrder, compact: boolean) => ReactNode;
  emptyText?: string;
  selection?: LimaRowSelection;
}) {
  const [limit, setLimit] = useState(100);
  const cases = useMemo(() => new Map(reproRows.map((r) => [r.orderId, r])), [reproRows]);
  const own = useMemo(() => classes ?? classifyLimaRows(rows, reproRows, today), [classes, rows, reproRows, today]);
  const visible = rows.slice(0, limit);
  const priors = usePriorCounts(visible.map((row) => row.orderId));
  const action = (row: LimaPendingOrder, compact: boolean) => renderActions(row, compact);
  const selectableIds = selection ? rows.filter((row) => selection.selectable(row)).map((row) => row.orderId) : [];
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selection!.selected.has(id));
  const someSelected = !allSelected && selectableIds.some((id) => selection!.selected.has(id));
  if (!rows.length) return <div className="border-t border-line px-4 py-12 text-center text-sm text-ink-500">{emptyText ?? "No hay pedidos con estos filtros. Activa otros macroestados o quita la búsqueda."}</div>;
  return (
    <>
      <div className="hidden border-t border-line xl:block">
        <table className="w-full table-fixed border-collapse text-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-wash [&_th]:shadow-[inset_0_-1px_0_var(--color-line),inset_0_1px_0_var(--color-line)]">
          <colgroup>{selection && <col className="w-10" />}<col className="w-[10rem]" /><col className="w-[15%]" /><col /><col className="w-[8.5rem]" /><col className="w-[22%]" /><col className="w-[9rem]" /></colgroup>
          <thead><tr className="text-left text-xs font-semibold text-ink-500">{selection && (
            <th className="py-2.5 pl-4 pr-0">
              {selectableIds.length > 0 && (
                <input
                  type="checkbox"
                  className={CHECKBOX}
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected; }}
                  onChange={() => selection.onToggleAll(selectableIds, !allSelected)}
                  aria-label={allSelected ? "Quitar todos" : allAria(selection, selectableIds.length)}
                  title={allSelected ? "Quitar todos" : allLabel(selection, selectableIds.length)}
                />
              )}
            </th>
          )}<th className="px-4 py-2.5">Pedido</th><th className="px-3 py-2.5">Cliente</th><th className="px-3 py-2.5">Qué pasa</th><th className="px-3 py-2.5">Fecha agendada</th><th className="px-3 py-2.5">Próximo paso</th><th className="px-4 py-2.5"><span className="sr-only">Acciones</span></th></tr></thead>
          <tbody>{visible.map((row) => {
            const repro = cases.get(row.orderId);
            const cls = own.get(row.orderId);
            return <tr key={row.orderId} className={cn("border-b border-line align-top transition-colors hover:bg-wash/70", selection?.selected.has(row.orderId) && "bg-brand-50/60")}>
              {selection && <td className="py-4 pl-4 pr-0"><SelectBox row={row} selection={selection} /></td>}
              <td className="space-y-1 px-4 py-4"><OrderLink orderId={row.orderId} className="block truncate font-semibold text-ink-900 hover:text-brand-700">{row.orderName}</OrderLink><StageBadges row={row} cls={cls} /><PendingDate row={row} />{repro && <ClaimBadge row={repro} />}</td>
              <td className="space-y-0.5 px-3 py-4"><p className="truncate font-medium text-ink-900" title={row.customerName}>{row.customerName}</p>{telHref(row.customerPhone) ? <a href={telHref(row.customerPhone)!} className="text-[13px] tabular-nums text-brand-700 hover:underline">{phoneLabel(row.customerPhone)}</a> : <p className="text-xs text-ink-500">Sin teléfono</p>}<PriorCountsTag counts={priors.get(row.orderId)} /><PendingAddress row={row} /></td>
              <td className="px-3 py-4"><WhatHappens row={row} repro={repro} today={today} /></td>
              <td className="px-3 py-4">{cls && <AgendaCell row={row} cls={cls} repro={repro} today={today} />}</td>
              <td className="px-3 py-4">{cls && <NextStep row={row} repro={repro} cls={cls} stuck={stuck?.get(row.orderId)} today={today} now={now} />}</td>
              <td className="px-4 py-4"><div className="flex flex-col gap-1.5">{action(row, true)}</div></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {selection && selectableIds.length > 0 && (
        <label className="flex min-h-11 items-center gap-2 border-t border-line px-4 text-[13px] font-medium text-ink-700 xl:hidden">
          <input
            type="checkbox"
            className={cn(CHECKBOX, "pointer-coarse:size-5")}
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = someSelected; }}
            onChange={() => selection.onToggleAll(selectableIds, !allSelected)}
          />
          {allSelected ? "Quitar todos" : allLabel(selection, selectableIds.length)}
        </label>
      )}
      <ul className="divide-y divide-line border-t border-line xl:hidden">{visible.map((row) => {
        const repro = cases.get(row.orderId);
        const cls = own.get(row.orderId);
        return <li key={row.orderId} className="space-y-2 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="flex items-center gap-2">{selection && <SelectBox row={row} selection={selection} />}<OrderLink orderId={row.orderId} className="font-semibold text-ink-900 hover:text-brand-700">{row.orderName}</OrderLink></span></div>
          <StageBadges row={row} cls={cls} /><PendingDate row={row} /><p className="text-sm text-ink-900">{row.customerName}</p><PriorCountsTag counts={priors.get(row.orderId)} /><PendingAddress row={row} />
          <WhatHappens row={row} repro={repro} today={today} />
          {cls && (
            <div className="grid gap-2 border-t border-line pt-2 sm:grid-cols-[auto_minmax(0,1fr)]">
              <AgendaCell row={row} cls={cls} repro={repro} today={today} />
              <NextStep row={row} repro={repro} cls={cls} stuck={stuck?.get(row.orderId)} today={today} now={now} />
            </div>
          )}
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
