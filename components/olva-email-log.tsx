"use client";

// «Cotejar Olva › Correos de Olva» (MOM §12): cada rótulo que Olva mandó por
// correo, por día de llegada, con lo que hizo al llegar y dónde está hoy su
// tracking. Las cifras filtran; lo que espera a una persona se vincula aquí
// mismo, con la acción de «Vincular a pedido».

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition, type FormEvent } from "react";
import { linkTrackingToOrder } from "@/app/dashboard/olva/actions";
import { OrderLink } from "@/components/order-link";
import { Badge, Banner, FIELD_BOX, OpsButton, StatusCard, type BadgeTone } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import {
  emailLogDayLabel,
  emailLogMoment,
  emailLogSince,
  groupEmailLogByDay,
  limaClock,
  type EmailLog,
  type EmailLogEntry,
  type EmailLogState,
} from "@/lib/olva/email-log";

type Filter = EmailLogState | "todos";

const CARDS: { id: Filter; label: string; hint: string }[] = [
  { id: "todos", label: "Todos", hint: "Cada rótulo que Olva mandó por correo." },
  {
    id: "vinculado",
    label: "Vinculados al llegar",
    hint: "El rótulo encontró su salida por el teléfono o el DNI y le puso el tracking.",
  },
  { id: "ya_vinculado", label: "Ya tenían tracking", hint: "Cuando llegó el correo, el tracking ya estaba en una salida." },
  {
    id: "despues",
    label: "Vinculados después",
    hint: "Llegó sin pareja y el tracking se puso después: a mano, por el cotejo del portal o por otro correo.",
  },
  {
    id: "pendiente",
    label: "Sin vincular",
    hint: "Su tracking todavía no está en ninguna salida: espera a que una persona diga de qué pedido es.",
  },
  { id: "ilegible", label: "Ilegibles", hint: "No se leyó el tracking del PDF." },
];

const BADGE: Record<EmailLogState, { tone: BadgeTone; label: string }> = {
  vinculado: { tone: "ok", label: "Vinculado al llegar" },
  ya_vinculado: { tone: "neutral", label: "Ya tenía tracking" },
  despues: { tone: "info", label: "Vinculado después" },
  pendiente: { tone: "warn", label: "Sin pareja" },
  ilegible: { tone: "crit", label: "Ilegible" },
};

/** Lo que espera a una persona dice por qué. */
function badgeFor(entry: EmailLogEntry): { tone: BadgeTone; label: string } {
  if (entry.state !== "pendiente") return BADGE[entry.state];
  if (entry.outcome === "sugerido") return { tone: "warn", label: "Pedido sugerido" };
  if (entry.outcome === "ambiguo") return { tone: "warn", label: "Varias salidas" };
  return BADGE.pendiente;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("es-PE")} ${n === 1 ? one : many}`;
}

/** Sin correos en tres días es más probable un escenario de Make parado que tres días sin envíos. */
const QUIET_MS = 72 * 3_600_000;

// Una columna en el teléfono; desde `lg`, a quién iba a la izquierda y qué
// pasó a la derecha; desde `xl`, la tabla de cinco columnas.
const GRID =
  "lg:grid-cols-[3rem_minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-x-5 xl:grid-cols-[3.5rem_9.5rem_minmax(0,1fr)_minmax(0,1.35fr)_15.5rem]";
/** Junta dos celdas solo en `lg`; en el teléfono y en `xl` cada una es su propia celda. */
const PAIR = "contents lg:flex lg:min-w-0 lg:flex-col lg:gap-1.5 xl:contents";

export function OlvaEmailLog({ log, editableOrgIds }: { log: EmailLog; editableOrgIds: string[] }) {
  const [filter, setFilter] = useState<Filter>("todos");
  const shown = useMemo(
    () => (filter === "todos" ? log.entries : log.entries.filter((e) => e.state === filter)),
    [log.entries, filter],
  );
  const days = useMemo(() => groupEmailLogByDay(shown), [shown]);
  const canEdit = (entry: EmailLogEntry) =>
    entry.orgId ? editableOrgIds.includes(entry.orgId) : editableOrgIds.length > 0;

  if (!log.entries.length) {
    return (
      <div className="rounded-lg bg-white px-6 py-12 text-center shadow-control ring-1 ring-line">
        <p className="text-sm font-semibold text-ink-900">Todavía no llegó ningún correo de Olva</p>
        <p className="mx-auto mt-1 max-w-[52ch] text-[13px] text-ink-500">
          Cuando Olva mande «Registro exitoso» con el rótulo en PDF, el escenario de Make lo pasa a Kapta y aparece aquí
          con el pedido que encontró.
        </p>
      </div>
    );
  }

  const last = log.lastReceivedAt;
  const quiet = last ? Date.now() - Date.parse(last) > QUIET_MS : false;
  const counts: Record<Filter, number> = { todos: log.entries.length, ...log.counts };

  return (
    <div className="space-y-4">
      <p className="text-[13px] tabular-nums text-ink-500">
        Último correo: <strong className="font-semibold text-ink-900">{last ? emailLogMoment(last) : "—"}</strong>
        {log.firstReceivedAt && (
          <>
            {" "}
            · {plural(log.entries.length, "rótulo", "rótulos")} en {plural(log.emails, "correo", "correos")} {emailLogSince(log.firstReceivedAt)}
          </>
        )}
        {log.truncated && " (los más recientes)"}.
      </p>

      {quiet && last && (
        <Banner tone="warn" title={`No llega ningún correo de Olva desde ${emailLogMoment(last)}`}>
          Si se registraron envíos en estos días, revisa el escenario de Make que vigila el buzón de Outlook.
        </Banner>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {CARDS.map((card) => (
          <StatusCard
            key={card.id}
            label={card.label}
            hint={card.hint}
            value={counts[card.id]}
            active={filter === card.id}
            onClick={() => setFilter(filter === card.id ? "todos" : card.id)}
          />
        ))}
      </div>

      <section aria-label="Correos recibidos" className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
        <div
          aria-hidden
          className={cn(
            "hidden border-b border-line px-4 py-2 text-xs font-semibold leading-4 text-ink-600 xl:grid",
            GRID,
          )}
        >
          <span>Llegó</span>
          <span>Envío</span>
          <span>Destinatario</span>
          <span>Resultado</span>
          <span>Pedido</span>
        </div>

        {days.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-6">
            <p className="text-sm text-ink-500">
              Ningún rótulo en «{CARDS.find((c) => c.id === filter)?.label}».
            </p>
            <OpsButton variant="ghost" size="sm" onClick={() => setFilter("todos")}>
              Ver todos
            </OpsButton>
          </div>
        ) : (
          days.map((day, index) => {
            const matched = day.entries.filter((e) => e.state === "vinculado").length;
            return (
              <div key={day.day}>
                <h2
                  className={cn(
                    "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 bg-wash px-4 py-2 text-[13px]",
                    index > 0 && "border-t border-line",
                  )}
                >
                  <span className="font-semibold text-ink-900">{emailLogDayLabel(day.day)}</span>
                  <span className="font-normal tabular-nums text-ink-500">
                    {plural(day.entries.length, "rótulo", "rótulos")}
                    {filter === "todos" && ` · ${plural(matched, "vinculado al llegar", "vinculados al llegar")}`}
                  </span>
                </h2>
                <ul className="divide-y divide-line border-t border-line">
                  {day.entries.map((entry) => (
                    <EmailRow key={entry.id} entry={entry} canEdit={canEdit(entry)} />
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </section>

      {log.truncated && (
        <p className="text-center text-[13px] text-ink-500">Se muestran los {log.entries.length} rótulos más recientes.</p>
      )}
    </div>
  );
}

function EmailRow({ entry, canEdit }: { entry: EmailLogEntry; canEdit: boolean }) {
  const badge = badgeFor(entry);
  const resolved = entry.state === "ya_vinculado" || entry.state === "despues";
  return (
    <li
      className={cn(
        "grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-3 transition-colors duration-150 hover:bg-wash/60",
        GRID,
      )}
    >
      <time dateTime={entry.receivedAt} className="row-span-4 pt-px text-[13px] tabular-nums text-ink-500 lg:row-span-1">
        {limaClock(entry.receivedAt)}
      </time>

      <div className={PAIR}>
        <div className="min-w-0">
          {entry.tracking ? (
            <p className="font-mono text-[13px] font-medium leading-5 text-ink-900">{entry.tracking}</p>
          ) : (
            <p className="text-[13px] font-medium leading-5 text-ink-500">Sin tracking</p>
          )}
          {entry.registro ? (
            <p className="text-xs tabular-nums leading-4 text-ink-500">
              Reg. {entry.registro}
              {entry.part && ` · rótulo ${entry.part}`}
            </p>
          ) : entry.subject ? (
            <p className="truncate text-xs leading-4 text-ink-500" title={entry.subject}>
              {entry.subject}
            </p>
          ) : null}
        </div>

        <div className="min-w-0">
          <p className="truncate text-sm leading-5 text-ink-900" title={entry.recipient ?? undefined}>
            {entry.recipient ?? <span className="text-ink-500">Sin leer</span>}
          </p>
          {entry.address && (
            <p className="truncate text-[13px] leading-5 text-ink-500" title={entry.address}>
              {entry.address}
            </p>
          )}
        </div>
      </div>

      <div className={PAIR}>
        <div className="min-w-0 space-y-0.5">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {resolved && entry.how ? (
            <p className="text-[13px] leading-5 text-ink-600">{entry.how}</p>
          ) : entry.note && entry.state !== "despues" ? (
            <p className="text-[13px] leading-5 text-ink-600">{entry.note}</p>
          ) : null}
          {entry.state === "despues" && entry.note && (
            <p className="text-[13px] leading-5 text-ink-500">Al llegar: {entry.note}</p>
          )}
          {entry.later && <p className="text-[13px] leading-5 text-warn-fg">{entry.later}</p>}
        </div>

        <div className="min-w-0 empty:hidden xl:empty:block">
          {entry.order ? (
            <OrderName order={entry.order} />
          ) : entry.state === "pendiente" && entry.tracking ? (
            canEdit ? (
              <EmailLinker tracking={entry.tracking} suggested={entry.suggested?.name ?? null} />
            ) : entry.suggested ? (
              <p className="text-[13px] text-ink-500">
                Sugerido: <OrderName order={entry.suggested} />
              </p>
            ) : null
          ) : null}
        </div>
      </div>
    </li>
  );
}

function OrderName({ order }: { order: { id: string | null; name: string } }) {
  if (!order.id) return <span className="text-sm font-semibold text-ink-900">{order.name}</span>;
  return (
    <OrderLink
      orderId={order.id}
      className="text-sm font-semibold text-brand-700 underline-offset-2 hover:underline"
    >
      {order.name}
    </OrderLink>
  );
}

/**
 * «Vincular a pedido» para el correo que espera a una persona: la misma acción
 * que el cotejo del portal. Con pedido sugerido, el campo ya viene con él.
 */
function EmailLinker({ tracking, suggested }: { tracking: string; suggested: string | null }) {
  const router = useRouter();
  const inputId = useId();
  const [order, setOrder] = useState((suggested ?? "").replace(/^#/, ""));
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!order.trim() || pending) return;
    startTransition(async () => {
      const res = await linkTrackingToOrder(tracking, order);
      setResult(res);
      if (res.ok) router.refresh();
    });
  };
  return (
    <div className="space-y-1">
      <form onSubmit={submit} className="flex items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          Número del pedido del envío {tracking}
        </label>
        <input
          id={inputId}
          value={order}
          onChange={(e) => setOrder(e.target.value)}
          placeholder="KP136585"
          autoComplete="off"
          spellCheck={false}
          className={cn(FIELD_BOX, "h-8 w-28 px-2.5 text-[13px] uppercase tabular-nums pointer-coarse:h-11")}
        />
        <OpsButton type="submit" size="sm" disabled={pending || !order.trim()} className="pointer-coarse:h-11">
          {pending ? "Vinculando…" : "Vincular"}
        </OpsButton>
      </form>
      {suggested && !result && <p className="text-xs text-ink-500">Sugerido por el teléfono del rótulo.</p>}
      {result && (
        <p role="status" className={cn("text-xs", result.ok ? "text-ok-fg" : "text-crit-fg")}>
          {result.message}
        </p>
      )}
    </div>
  );
}
