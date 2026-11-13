"use client";

// «Pago de diferencia» (MOM §44): los pedidos de Agencia que esperan en la
// sucursal a que la clienta pague lo que falta, con la última gestión del
// equipo. Primero lo que nadie gestionó hoy. Un clic abre la ficha en Operar,
// donde se registra la gestión (comentario con foto §43, WhatsApp, llamada).

import { useMemo, useRef, useState, type MouseEvent } from "react";
import { Badge, OpsButton, StatusCard, type BadgeTone } from "@/components/ops-ui";
import { OrderLink, useOpenOrderDrawer } from "@/components/order-link";
import {
  PAGO_DIFERENCIA_FILTER_LABEL,
  PAGO_DIFERENCIA_GROUPS,
  PAGO_DIFERENCIA_GROUP_LABEL,
  PAGO_DIFERENCIA_OLVA_WARN_DAYS,
  PAGO_DIFERENCIA_RETURN_CRIT_DAYS,
  PAGO_DIFERENCIA_RETURN_WARN_DAYS,
  RETORNO_OVERDUE_DAYS,
  agencyArrivalMessage,
  filterPagoDiferencia,
  isPagoDiferenciaCobro,
  type PagoDiferenciaFilter,
  type PagoDiferenciaGroup,
  type PagoDiferenciaRow,
} from "@/lib/pago-diferencia";
import { cn } from "@/components/ui";

const PAGE = 50;
const FILTERS: PagoDiferenciaFilter[] = ["por_gestionar", "gestionados_hoy", "sin_gestion", "todos"];

/**
 * Las pestañas: los tres grupos por cobrar, «Todos», que los suma (owner,
 * 10-11-2026), y aparte (13-11-2026) «Por retornar» —los de En agencia que la
 * agencia está por devolver: los urgentes por llamar— y «Retornados» —ya los
 * devolvió: no se cobran, se reciben—.
 */
type GroupTab = PagoDiferenciaGroup | "todos" | "por_retornar";
const TABS: readonly GroupTab[] = [...PAGO_DIFERENCIA_GROUPS, "todos", "por_retornar", "retornando"];
const TAB_LABEL: Record<GroupTab, string> = { ...PAGO_DIFERENCIA_GROUP_LABEL, todos: "Todos", por_retornar: "Por retornar" };

/** ¿La fila va en esa pestaña? */
function inTab(r: PagoDiferenciaRow, tab: GroupTab): boolean {
  if (tab === "todos") return isPagoDiferenciaCobro(r.group);
  if (tab === "por_retornar") return r.porRetornar;
  return r.group === tab;
}

const GROUP_HINT: Record<GroupTab, string> = {
  todos: "Los tres grupos juntos: en agencia, en camino y recogidos sin pago.",
  en_agencia: "El paquete ya está en la sucursal: la clave de recojo no se libera hasta validar el pago.",
  en_camino: "Todavía viaja o recién llegó a la agencia: se puede pedir la diferencia antes de que esté disponible.",
  recogido_sin_pago: "La clienta ya lo recogió y falta parte del pago: queda por cobrar.",
  por_retornar: `Urgentes por llamar: en la agencia hace ${PAGO_DIFERENCIA_RETURN_WARN_DAYS} días o más (Shalom los devuelve a los ~38 días; algunos antes de los 20) u Olva vence en ${PAGO_DIFERENCIA_OLVA_WARN_DAYS} días o menos. Copia el mensaje, mándalo y llama hoy.`,
  retornando: `Nadie lo recogió ni pagó la diferencia y la agencia lo devolvió: viene de vuelta a Lima. Se recibe en Almacén → Devoluciones; con ${RETORNO_OVERDUE_DAYS} días o más ya debería haber llegado: búscalo o reclámalo al courier.`,
};

const FILTER_HINT: Record<PagoDiferenciaFilter, string> = {
  por_gestionar: "Nadie registró una gestión hoy: comentario, WhatsApp por Chatby o llamada.",
  gestionados_hoy: "Alguien del equipo ya registró una gestión hoy.",
  sin_gestion: "Nunca tuvieron una gestión registrada en Kapta.",
  todos: "Todos los pedidos del grupo.",
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

/** En retorno: una semana es lo normal; desde `RETORNO_OVERDUE_DAYS` (15) hay que buscarlo. */
function retornoTone(n: number | null): BadgeTone {
  if (n === null) return "neutral";
  if (n >= RETORNO_OVERDUE_DAYS) return "crit";
  if (n >= 7) return "warn";
  return "info";
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
  const [group, setGroup] = useState<GroupTab>("todos");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const pickGroup = (g: GroupTab) => {
    setGroup(g);
    // En «Retornando» ya no se cobra: se ven todos, del que más tarda.
    setFilter(g === "retornando" ? "todos" : "por_gestionar");
    setLimit(PAGE);
  };
  const [filter, setFilter] = useState<PagoDiferenciaFilter>("por_gestionar");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const openDrawer = useOpenOrderDrawer();
  const open = (orderId: string) => openDrawer(orderId, "operar");

  const groupCounts = useMemo(
    () =>
      Object.fromEntries(
        TABS.map((g) => [g, rows.filter((r) => inTab(r, g)).length]),
      ) as Record<GroupTab, number>,
    [rows],
  );
  const inGroup = useMemo(() => rows.filter((r) => inTab(r, group)), [rows, group]);
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
      {/* Los grupos en control segmentado (DESIGN.md): las pestañas
          subrayadas de arriba son las vistas de la página. Las flechas
          mueven y eligen. */}
      <div
        role="tablist"
        aria-label="Grupo de pedidos"
        className="grid grid-cols-2 gap-0.5 rounded-lg bg-wash p-0.5 ring-1 ring-inset ring-line sm:inline-grid sm:grid-flow-col sm:grid-cols-none"
      >
        {TABS.map((g, i) => {
          const on = group === g;
          return (
            <button
              key={g}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => pickGroup(g)}
              onKeyDown={(e) => {
                const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = (i + step + TABS.length) % TABS.length;
                tabRefs.current[next]?.focus();
                pickGroup(TABS[next]!);
              }}
              className={cn(
                "flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-semibold outline-none transition-[background-color,color,box-shadow] duration-150 pointer-coarse:h-11",
                "focus-visible:ring-2 focus-visible:ring-brand-600",
                on ? "bg-white text-ink-900 shadow-control ring-1 ring-line" : "text-ink-500 hover:text-ink-900",
              )}
            >
              {TAB_LABEL[g]}
              <span
                className={cn(
                  "tabular-nums",
                  on ? "text-brand-700" : g === "por_retornar" && groupCounts[g] > 0 ? "font-bold text-crit-fg" : "text-ink-500",
                )}
              >
                {groupCounts[g].toLocaleString("es-PE")}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-sm text-ink-700">
        {GROUP_HINT[group]}{" "}
        <span className="tabular-nums text-ink-500">
          {inGroup.length.toLocaleString("es-PE")} pedido{inGroup.length === 1 ? "" : "s"} · {money(totalRemaining)}{" "}
          {group === "retornando" ? "que nunca se pagaron" : "por cobrar"}
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
                  <col className="w-[10.5rem]" />
                  <col />
                </colgroup>
                <thead>
                  <tr className="text-left text-xs font-semibold text-ink-600 [&>th]:border-b [&>th]:border-line">
                    <th className="px-4 py-2.5">Pedido</th>
                    <th className="px-3 py-2.5">Cliente</th>
                    <th className="px-3 py-2.5 text-right">Falta pagar</th>
                    <th className="px-3 py-2.5">{group === "en_agencia" || group === "por_retornar" ? "En agencia" : group === "en_camino" ? "Envío" : group === "recogido_sin_pago" ? "Recogido" : group === "retornando" ? "Retorno" : "Dónde está"}</th>
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
        <Badge tone={row.group === "en_agencia" ? waitTone(row.waitingDays) : row.group === "retornando" ? retornoTone(row.waitingDays) : "neutral"}>
          {row.group === "recogido_sin_pago"
            ? `hace ${days(row.waitingDays)}`
            : row.group === "retornando"
              ? `en retorno hace ${days(row.waitingDays)}`
              : days(row.waitingDays)}
        </Badge>
        {row.expired && <Badge tone="crit">Plazo vencido</Badge>}
        {row.group === "retornando" && (row.waitingDays ?? 0) >= RETORNO_OVERDUE_DAYS && (
          <Badge tone="crit">Ya debería estar en Lima</Badge>
        )}
        {row.porRetornar && (
          <Badge tone="crit">{(row.waitingDays ?? 0) >= PAGO_DIFERENCIA_RETURN_CRIT_DAYS ? "Se devuelve pronto" : "Por retornar"}</Badge>
        )}
      </div>
      <p className="truncate text-xs text-ink-500" title={row.destination ?? undefined}>
        {courierName(row.courier)}
        {row.destination ? ` · ${row.destination}` : ""}
      </p>
      {row.guideCode && <p className="truncate font-mono text-xs text-ink-500">{row.guideCode}</p>}
      {row.group === "en_agencia" && <CopyMessageButton row={row} />}
    </div>
  );
}

/**
 * «Copiar mensaje» (owner, 13-11-2026): el aviso «YA LLEGÓ a la agencia» con
 * la guía, el código, el producto y lo que falta, listo para pegar en WhatsApp.
 */
function CopyMessageButton({ row }: { row: PagoDiferenciaRow }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(agencyArrivalMessage(row));
          setState("copied");
        } catch {
          setState("error");
        }
        window.setTimeout(() => setState("idle"), 2000);
      }}
      className="inline-flex h-8 items-center rounded-md bg-white px-2.5 text-[13px] font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:h-11"
    >
      <span aria-live="polite">{state === "copied" ? "Copiado ✓" : state === "error" ? "No se pudo copiar" : "Copiar mensaje"}</span>
    </button>
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
