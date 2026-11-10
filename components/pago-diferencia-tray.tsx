"use client";

// «Pago de diferencia» (MOM §44): los pedidos de Agencia que esperan en la
// sucursal a que la clienta pague lo que falta, con la última gestión del
// equipo. Primero lo que nadie gestionó hoy. Un clic abre la ficha en Operar,
// donde se registra la gestión (comentario con foto §43, WhatsApp, llamada).

import { useMemo, useState, type MouseEvent } from "react";
import { Badge, OpsButton, StatusCard, type BadgeTone } from "@/components/ops-ui";
import { OrderLink, useOpenOrderDrawer } from "@/components/order-link";
import {
  PAGO_DIFERENCIA_FILTER_LABEL,
  PAGO_DIFERENCIA_GROUPS,
  PAGO_DIFERENCIA_GROUP_LABEL,
  filterPagoDiferencia,
  type PagoDiferenciaFilter,
  type PagoDiferenciaGroup,
  type PagoDiferenciaRow,
} from "@/lib/pago-diferencia";
import { cn } from "@/components/ui";

const PAGE = 50;
const FILTERS: PagoDiferenciaFilter[] = ["por_gestionar", "gestionados_hoy", "sin_gestion", "todos"];

/** Las pestañas: los tres grupos y «Todos», que los suma (owner, 10-11-2026). */
type GroupTab = PagoDiferenciaGroup | "todos";
const TABS: readonly GroupTab[] = [...PAGO_DIFERENCIA_GROUPS, "todos"];
const TAB_LABEL: Record<GroupTab, string> = { ...PAGO_DIFERENCIA_GROUP_LABEL, todos: "Todos" };

const GROUP_HINT: Record<GroupTab, string> = {
  todos: "Los tres grupos juntos: en agencia, en camino y recogidos sin pago.",
  en_agencia: "El paquete ya está en la sucursal: la clave de recojo no se libera hasta validar el pago.",
  en_camino: "Todavía viaja o recién llegó a la agencia: se puede pedir la diferencia antes de que esté disponible.",
  recogido_sin_pago: "La clienta ya lo recogió y falta parte del pago: queda por cobrar.",
};

const FILTER_HINT: Record<PagoDiferenciaFilter, string> = {
  por_gestionar: "Nadie registró una gestión hoy: comentario, WhatsApp por Chatby o llamada.",
  gestionados_hoy: "Alguien del equipo ya registró una gestión hoy.",
  sin_gestion: "Nunca tuvieron una gestión registrada en Kapta.",
  todos: "Todos los pedidos que esperan el pago de la diferencia.",
};

function money(n: number | null): string {
  return n === null ? "—" : `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function days(n: number | null): string {
  if (n === null) return "—";
  return n === 1 ? "1 día" : `${n} días`;
}

function waitTone(n: number | null): BadgeTone {
  if (n === null) return "neutral";
  if (n >= 7) return "crit";
  if (n >= 3) return "warn";
  return "neutral";
}

function courierName(c: string | null): string {
  if (!c) return "—";
  return c === "shalom" ? "Shalom" : c === "olva" ? "Olva" : c.charAt(0).toUpperCase() + c.slice(1);
}

/** Un clic en un enlace o botón de la fila no abre la ficha dos veces. */
function fromControl(e: MouseEvent): boolean {
  return e.target instanceof Element && Boolean(e.target.closest("a, button"));
}

export function PagoDiferenciaTray({ rows, storeNames }: { rows: PagoDiferenciaRow[]; storeNames: Record<string, string> }) {
  const [group, setGroup] = useState<GroupTab>("en_agencia");
  const [filter, setFilter] = useState<PagoDiferenciaFilter>("por_gestionar");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const openDrawer = useOpenOrderDrawer();
  const open = (orderId: string) => openDrawer(orderId, "operar");

  const groupCounts = useMemo(
    () =>
      Object.fromEntries(TABS.map((g) => [g, g === "todos" ? rows.length : rows.filter((r) => r.group === g).length])) as Record<GroupTab, number>,
    [rows],
  );
  const inGroup = useMemo(() => (group === "todos" ? rows : rows.filter((r) => r.group === group)), [rows, group]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f, filterPagoDiferencia(inGroup, f).length])) as Record<PagoDiferenciaFilter, number>,
    [inGroup],
  );
  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    return filterPagoDiferencia(inGroup, filter).filter(
      (r) =>
        !q ||
        r.orderName.toLowerCase().includes(q) ||
        (r.customerName ?? "").toLowerCase().includes(q) ||
        (digits.length >= 4 && (r.customerPhone ?? "").replace(/\D/g, "").includes(digits)) ||
        (r.guideCode ?? "").toLowerCase().includes(q),
    );
  }, [inGroup, filter, query]);
  const visible = listed.slice(0, limit);
  const totalRemaining = inGroup.reduce((s, r) => s + (r.remaining ?? 0), 0);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Pago de diferencia</h1>
        <p className="max-w-[72ch] text-sm leading-6 text-ink-600">
          Pedidos de Agencia a los que les falta pagar la diferencia. Abre el pedido y registra cada gestión en
          «Comentario», con la captura como constancia: aquí se ve quién la hizo y cuándo.
        </p>
      </header>

      <div role="tablist" aria-label="Grupo" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((g) => (
          <button
            key={g}
            type="button"
            role="tab"
            aria-selected={group === g}
            onClick={() => {
              setGroup(g);
              setFilter("por_gestionar");
              setLimit(PAGE);
            }}
            className={cn(
              "-mb-px flex min-h-10 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors pointer-coarse:min-h-11",
              group === g ? "border-brand-600 text-brand-700" : "border-transparent text-ink-600 hover:text-ink-900",
            )}
          >
            {TAB_LABEL[g]}
            <Badge tone={group === g ? "brand" : "neutral"}>{groupCounts[g].toLocaleString("es-PE")}</Badge>
          </button>
        ))}
      </div>
      <p className="text-sm text-ink-700">
        {GROUP_HINT[group]}{" "}
        <span className="tabular-nums text-ink-500">
          {inGroup.length.toLocaleString("es-PE")} pedido{inGroup.length === 1 ? "" : "s"} · {money(totalRemaining)} por cobrar
        </span>
      </p>

      <div role="group" aria-label="Filtrar pedidos" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {FILTERS.map((f) => (
          <StatusCard
            key={f}
            label={PAGO_DIFERENCIA_FILTER_LABEL[f]}
            value={counts[f]}
            hint={FILTER_HINT[f]}
            active={filter === f}
            onClick={() => {
              setFilter(f);
              setLimit(PAGE);
            }}
          />
        ))}
      </div>

      <section className="rounded-lg bg-white shadow-control ring-1 ring-line" aria-label={PAGO_DIFERENCIA_FILTER_LABEL[filter]}>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <h2 className="text-sm font-semibold text-ink-900">{PAGO_DIFERENCIA_FILTER_LABEL[filter]}</h2>
          <Badge>{listed.length.toLocaleString("es-PE")}</Badge>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="Buscar pedido, cliente, celular o guía"
            aria-label="Buscar pedido, cliente, celular o guía"
            className="h-9 w-full rounded-md border border-line-strong bg-white px-3 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 sm:ml-auto sm:w-72 pointer-coarse:h-11"
          />
        </div>

        {listed.length === 0 ? (
          <p className="border-t border-line px-4 py-8 text-center text-sm text-ink-500">
            {inGroup.length === 0
              ? `No hay pedidos en «${TAB_LABEL[group]}».`
              : filter === "por_gestionar" && !query
                ? "Todos los pedidos ya tienen una gestión registrada hoy."
                : "Ningún pedido coincide con este filtro."}
          </p>
        ) : (
          <>
            <div className="hidden border-t border-line lg:block">
              <table className="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col className="w-[10rem]" />
                  <col className="w-[13rem]" />
                  <col className="w-[9rem]" />
                  <col className="w-[8.5rem]" />
                  <col />
                </colgroup>
                <thead>
                  <tr className="text-left text-xs font-semibold text-ink-600 [&>th]:border-b [&>th]:border-line">
                    <th className="px-4 py-2.5">Pedido</th>
                    <th className="px-3 py-2.5">Cliente</th>
                    <th className="px-3 py-2.5 text-right">Falta pagar</th>
                    <th className="px-3 py-2.5">{group === "en_agencia" ? "En agencia" : group === "en_camino" ? "Envío" : group === "recogido_sin_pago" ? "Recogido" : "Dónde está"}</th>
                    <th className="px-4 py-2.5">Última gestión</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr
                      key={r.orderId}
                      onClick={(e) => {
                        if (!fromControl(e)) open(r.orderId);
                      }}
                      className="cursor-pointer border-b border-line align-top last:border-b-0 hover:bg-wash"
                    >
                      <td className="px-4 py-3">
                        <OrderLink orderId={r.orderId} section="operar" className="block truncate font-semibold text-ink-900 hover:text-brand-700">
                          {r.orderName}
                        </OrderLink>
                        <p className="truncate text-xs text-ink-500">{storeNames[r.storeId] ?? "—"}</p>
                      </td>
                      <td className="px-3 py-3">
                        <p className="truncate text-ink-900" title={r.customerName ?? undefined}>{r.customerName ?? "Sin nombre"}</p>
                        <p className="truncate text-xs tabular-nums text-ink-500">{r.customerPhone ?? "Sin celular"}</p>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <Amount row={r} />
                      </td>
                      <td className="px-3 py-3">
                        <Agency row={r} showGroup={group === "todos"} />
                      </td>
                      <td className="px-4 py-3">
                        <LastGestion row={r} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="divide-y divide-line border-t border-line lg:hidden">
              {visible.map((r) => (
                <li
                  key={r.orderId}
                  onClick={(e) => {
                    if (!fromControl(e)) open(r.orderId);
                  }}
                  className="cursor-pointer space-y-2 px-4 py-3 hover:bg-wash"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <OrderLink orderId={r.orderId} section="operar" className="font-semibold text-ink-900 hover:text-brand-700">
                        {r.orderName}
                      </OrderLink>
                      <p className="text-sm text-ink-900">{r.customerName ?? "Sin nombre"}</p>
                      <p className="text-xs tabular-nums text-ink-500">{r.customerPhone ?? "Sin celular"}</p>
                    </div>
                    <Amount row={r} />
                  </div>
                  <Agency row={r} showGroup={group === "todos"} />
                  <LastGestion row={r} />
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-[13px] tabular-nums text-ink-500">
              <span>
                Mostrando {visible.length.toLocaleString("es-PE")} de {listed.length.toLocaleString("es-PE")} · primero lo
                que nadie gestionó hoy y lo que más espera
              </span>
              {visible.length < listed.length && (
                <OpsButton size="sm" onClick={() => setLimit((n) => n + PAGE)} className="pointer-coarse:h-11">
                  Mostrar {PAGE} más
                </OpsButton>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Amount({ row }: { row: PagoDiferenciaRow }) {
  return (
    <div className="text-right">
      <p className="font-semibold tabular-nums text-ink-900">{money(row.remaining)}</p>
      <p className="text-xs tabular-nums text-ink-500">
        pagó {money(row.paidValidated)} de {money(row.orderTotal)}
      </p>
      {row.paymentToValidate && (
        <p className="mt-1">
          <Badge tone="info">Pago por validar</Badge>
        </p>
      )}
    </div>
  );
}

function Agency({ row, showGroup = false }: { row: PagoDiferenciaRow; showGroup?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {/* En «Todos» se dice de qué grupo es cada pedido. */}
        {showGroup && !row.substage && <Badge tone="info">{PAGO_DIFERENCIA_GROUP_LABEL[row.group]}</Badge>}
        {row.substage && <Badge tone="info">{row.substage}</Badge>}
        <Badge tone={row.group === "en_agencia" ? waitTone(row.waitingDays) : "neutral"}>
          {row.group === "recogido_sin_pago" ? `hace ${days(row.waitingDays)}` : days(row.waitingDays)}
        </Badge>
        {row.expired && <Badge tone="crit">Plazo vencido</Badge>}
      </div>
      <p className="truncate text-xs text-ink-500" title={row.destination ?? undefined}>
        {courierName(row.courier)}
        {row.destination ? ` · ${row.destination}` : ""}
      </p>
      {row.guideCode && <p className="truncate font-mono text-xs text-ink-500">{row.guideCode}</p>}
    </div>
  );
}

function LastGestion({ row }: { row: PagoDiferenciaRow }) {
  const g = row.lastGestion;
  if (!g) {
    return (
      <div className="space-y-1">
        <Badge tone="warn">Sin gestión</Badge>
        <p className="text-xs text-ink-500">Nadie registró una gestión en Kapta.</p>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {row.gestionadoHoy ? <Badge tone="ok">Hoy</Badge> : null}
        <Badge>{g.commentType ?? g.channel}</Badge>
        {g.photoCount > 0 && (
          <Badge tone="brand">
            {g.photoCount} foto{g.photoCount === 1 ? "" : "s"}
          </Badge>
        )}
      </div>
      {g.note && <p className="line-clamp-2 break-words text-[13px] leading-5 text-ink-700">{g.note}</p>}
      <p className="text-xs tabular-nums text-ink-500">
        {when(g.at)} · {g.actorName ?? "alguien del equipo"}
        {row.gestionCount > 1 ? ` · ${row.gestionCount} gestiones` : ""}
      </p>
    </div>
  );
}
