"use client";

import { Fragment, useMemo, useState } from "react";
import {
  ACTIVITY_LABELS,
  OUTCOME_LABELS,
  PRODUCTIVITY_SECTIONS,
  activityMetric,
  type OperationsPerson,
  type ActivityMetric,
} from "@/lib/operations-productivity";
import { cn } from "./ui";
import { masterOrderHref } from "@/lib/order-drawer-href";

const nf = new Intl.NumberFormat("es-PE");
const areaName = Object.fromEntries(PRODUCTIVITY_SECTIONS);
const count = (n: number) => nf.format(n);
export function OperationsProductivityTable({
  people,
  metrics,
  currency,
  tz,
}: {
  people: OperationsPerson[];
  metrics: ActivityMetric[];
  currency: string;
  tz: string;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("actions");
  const [expanded, setExpanded] = useState<string | null>(null);
  const visible = useMemo(
    () =>
      people
        .filter((p) =>
          p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        )
        .sort((a, b) => {
          const m = metrics.find((v) => v.key === sort);
          return (
            (m
              ? activityMetric(b, m) - activityMetric(a, m)
              : sort === "orders"
                ? b.orders - a.orders
                : b.actions - a.actions) || a.name.localeCompare(b.name)
          );
        }),
    [people, query, sort, metrics],
  );
  const maximum = Math.max(1, ...visible.flatMap((p) => Object.values(p.heat)));
  const money = (n: number) =>
    new Intl.NumberFormat("es-PE", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  const date = (at: string) =>
    new Intl.DateTimeFormat("es-PE", {
      timeZone: tz,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(at));
  const active = people.filter((p) => p.actions > 0).length;
  return (
    <section
      aria-label="Actividad por persona"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <p className="text-[13px] text-ink-500">
          <strong className="font-medium text-ink-900">
            {count(active)}{" "}
            {active === 1 ? "persona con actividad" : "personas con actividad"}
          </strong>
          {people.length > active
            ? ` · ${people.length - active} sin actividad`
            : ""}{" "}
          · abre un nombre para ver sus registros
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            aria-label="Buscar persona"
            placeholder="Buscar persona"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 w-44 rounded-md border border-line-strong bg-white px-3 text-[13px] outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
          />
          <label className="flex items-center gap-2 text-xs text-ink-500">
            Ordenar por
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="h-9 rounded-md border border-line-strong bg-white px-2 text-[13px] text-ink-700 outline-none focus:ring-2 focus:ring-brand-600"
            >
              <option value="actions">Actividad</option>
              <option value="orders">Pedidos</option>
              {metrics.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="divide-y divide-line md:hidden">
        {visible.map((p) => (
          <article key={p.userId} className="px-4 py-4">
            <button
              type="button"
              aria-expanded={expanded === p.userId}
              aria-controls={`mobile-activity-${p.userId}`}
              onClick={() =>
                setExpanded(expanded === p.userId ? null : p.userId)
              }
              className="flex min-h-10 w-full items-center justify-between gap-3 text-left font-medium text-ink-900 outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              <span className="min-w-0 break-words">{p.name}</span>
              <span aria-hidden className="shrink-0 text-ink-500">
                {expanded === p.userId ? "⌄" : "›"}
              </span>
            </button>
            <p className="mb-3 text-xs text-ink-500">
              {p.lastAt
                ? `Última actividad: ${date(p.lastAt)}`
                : "Sin actividad registrada"}
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              {[
                { label: "Acciones", value: count(p.actions) },
                { label: "Pedidos", value: count(p.orders) },
                ...metrics.map((m) => ({
                  label: m.label,
                  value: m.amount
                    ? money(activityMetric(p, m))
                    : count(activityMetric(p, m)),
                })),
              ].map((m) => (
                <div key={m.label}>
                  <dt className="text-ink-500">{m.label}</dt>
                  <dd className="mt-0.5 text-sm font-medium tabular-nums text-ink-900">
                    {m.value}
                  </dd>
                </div>
              ))}
            </dl>
            {expanded === p.userId && (
              <div
                id={`mobile-activity-${p.userId}`}
                className="mt-4 border-t border-line pt-4"
              >
                <PersonActivityDetails person={p} date={date} money={money} />
              </div>
            )}
          </article>
        ))}
        {!visible.length && (
          <p className="px-4 py-8 text-sm text-ink-500">
            {query
              ? "No hay personas que coincidan con la búsqueda."
              : "Todavía no hay actividad registrada en este periodo. Elige otro periodo o tienda."}
          </p>
        )}
      </div>
      <div className="hidden overflow-auto md:block xl:max-h-[calc(100dvh-23rem)]">
        <table className="w-full min-w-[1000px] border-collapse text-[13px]">
          <caption className="sr-only">
            Acciones registradas por persona en el periodo. Las cifras se
            atribuyen al autor del registro.
          </caption>
          <thead className="sticky top-0 z-10 bg-white text-xs font-medium text-ink-500">
            <tr>
              <th
                scope="col"
                className="min-w-44 border-b border-line px-4 py-3 text-left"
              >
                Persona
              </th>
              <th
                scope="col"
                className="border-b border-line px-3 py-3 text-left"
              >
                <span title="Acciones por hora local en la franja habitual. El total incluye también las acciones fuera de esta franja. No mide presencia ni asistencia.">
                  Actividad por hora{" "}
                  <span className="font-normal">07–21 h</span>
                </span>
              </th>
              <th
                scope="col"
                className="border-b border-line px-3 py-3 text-right"
              >
                Acciones
              </th>
              <th
                scope="col"
                className="border-b border-line px-3 py-3 text-right"
              >
                Pedidos
              </th>
              {metrics.map((m) => (
                <th
                  key={m.key}
                  scope="col"
                  className="max-w-28 border-b border-line px-3 py-3 text-right"
                >
                  {m.label}
                </th>
              ))}
              <th
                scope="col"
                className="border-b border-line px-4 py-3 text-right"
              >
                Última actividad
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((p) => (
              <Fragment key={p.userId}>
                <tr
                  className={cn(
                    "hover:bg-wash",
                    expanded === p.userId && "bg-brand-50",
                  )}
                >
                  <th scope="row" className="px-4 py-5 text-left font-medium">
                    <button
                      type="button"
                      aria-expanded={expanded === p.userId}
                      aria-controls={`activity-${p.userId}`}
                      onClick={() =>
                        setExpanded(expanded === p.userId ? null : p.userId)
                      }
                      className="max-w-52 break-words text-left text-ink-900 outline-none hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      {p.name}
                      <span aria-hidden className="ml-2 text-ink-300">
                        {expanded === p.userId ? "⌄" : "›"}
                      </span>
                    </button>
                    {p.actions === 0 && (
                      <span className="mt-1 block text-xs font-normal text-ink-500">
                        Sin actividad registrada
                      </span>
                    )}
                  </th>
                  <td className="px-3 py-5">
                    <div
                      className="flex gap-0.5"
                      aria-label={`${p.actions} acciones en el periodo`}
                    >
                      {Array.from({ length: 15 }, (_, index) => {
                        const h = index + 7;
                        const n = p.heat[String(h)] ?? 0;
                        return (
                          <span
                            key={h}
                            title={`${String(h).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:59 · ${count(n)} acciones`}
                            className={cn(
                              "flex h-6 w-[17px] shrink-0 items-center justify-center rounded-[3px] text-[9px] tabular-nums",
                              !n
                                ? "bg-line text-ink-500"
                                : n / maximum > 0.6
                                  ? "bg-brand-600 text-white"
                                  : n / maximum > 0.25
                                    ? "bg-brand-100 text-brand-700"
                                    : "bg-brand-50 text-brand-700",
                            )}
                          >
                            {n > 0 ? (n > 99 ? "99+" : n) : ""}
                          </span>
                        );
                      })}
                    </div>
                    {Object.entries(p.heat).some(
                      ([h, n]) => (+h < 7 || +h > 21) && n > 0,
                    ) && (
                      <span className="mt-1 block text-[11px] text-ink-500">
                        {count(
                          Object.entries(p.heat).reduce(
                            (total, [h, n]) =>
                              total + (+h < 7 || +h > 21 ? n : 0),
                            0,
                          ),
                        )}{" "}
                        fuera de 07–21 h
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-5 text-right font-medium tabular-nums">
                    {count(p.actions)}
                  </td>
                  <td className="px-3 py-5 text-right tabular-nums">
                    {count(p.orders)}
                  </td>
                  {metrics.map((m) => (
                    <td
                      key={m.key}
                      className="px-3 py-5 text-right tabular-nums"
                    >
                      {m.amount
                        ? money(activityMetric(p, m))
                        : count(activityMetric(p, m))}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-4 py-5 text-right text-xs tabular-nums text-ink-500">
                    {p.lastAt ? date(p.lastAt) : "—"}
                  </td>
                </tr>
                {expanded === p.userId && (
                  <tr id={`activity-${p.userId}`}>
                    <td
                      colSpan={5 + metrics.length}
                      className="bg-wash px-4 py-4"
                    >
                      <PersonActivityDetails
                        person={p}
                        date={date}
                        money={money}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!visible.length && (
              <tr>
                <td
                  colSpan={5 + metrics.length}
                  className="px-4 py-12 text-center text-sm text-ink-500"
                >
                  {query
                    ? "No hay personas que coincidan con la búsqueda."
                    : "Todavía no hay actividad registrada en este periodo. Elige otro periodo o tienda."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-4 py-3 text-xs text-ink-500">
        Se cuentan hechos con autor, no aperturas de pantalla ni actividad
        automática. Un pedido puede haber sido gestionado por más de una
        persona.
      </p>
    </section>
  );
}

function PersonActivityDetails({
  person: p,
  date,
  money,
}: {
  person: OperationsPerson;
  date: (at: string) => string;
  money: (amount: number) => string;
}) {
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-600">
        <span>{count(p.actions)} acciones</span>
        <span>{count(p.orders)} pedidos distintos</span>
        {p.leads > 0 && <span>{count(p.leads)} leads distintos</span>}
        <span title="Tiempo entre acciones del mismo día; una pausa de más de 45 minutos corta el bloque. No es una medición de horas conectada.">
          {p.hours.toFixed(1)} h entre acciones
        </span>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {Object.entries(p.counts).map(([action, cell]) => (
          <span
            key={action}
            className="rounded-full border border-line-strong bg-white px-2.5 py-1 text-xs text-ink-600"
          >
            {ACTIVITY_LABELS[action] ?? action}{" "}
            <strong className="ml-1 font-medium tabular-nums text-ink-900">
              {count(cell.count)}
            </strong>
          </span>
        ))}
      </div>
      <p className="mb-2 text-xs font-medium text-ink-700">
        {p.actions > 50
          ? "Últimos 50 registros del periodo"
          : "Registros del periodo"}
      </p>
      {p.recent.length ? (
        <ul className="divide-y divide-line rounded-md border border-line bg-white">
          {p.recent.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-xs"
            >
              <time
                dateTime={e.at}
                className="w-28 shrink-0 tabular-nums text-ink-500"
              >
                {date(e.at)}
              </time>
              <span className="min-w-40 flex-1 text-ink-900">
                {ACTIVITY_LABELS[e.action] ?? e.action}
                {e.outcome && (
                  <span className="ml-2 text-ink-500">
                    {OUTCOME_LABELS[e.outcome] ?? e.outcome}
                  </span>
                )}
              </span>
              <span className="text-ink-500">{areaName[e.area] ?? e.area}</span>
              {e.orderId ? (
                <a
                  href={masterOrderHref(e.orderId, "historial")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {e.orderName ?? "Ver pedido"}
                  <span className="sr-only">, abre otra pestaña</span>
                </a>
              ) : (
                <span className="text-ink-500">
                  {e.leadId ? "Lead" : "Envío sin pedido vinculado"}
                </span>
              )}
              {e.amount > 0 && (
                <span className="w-24 text-right tabular-nums text-ink-700">
                  {money(e.amount)}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-2 text-xs text-ink-500">
          No hay acciones registradas para esta persona en el periodo.
        </p>
      )}
    </>
  );
}
