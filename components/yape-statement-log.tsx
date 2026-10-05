// «Validar pagos › Estado de cuenta Yape»: cada reporte de movimientos que llegó
// por correo y los pagos que validó al cruzarlo (MOM §16.2). Se lee de arriba
// abajo: el reporte más reciente, abierto; los anteriores, plegados.

import type { ReactNode } from "react";
import { IconChevronDown } from "@/components/icons";
import { OrderLink } from "@/components/order-link";
import { PaymentReviewTabs } from "@/components/payment-review-tabs";
import { cn, EmptyState } from "@/components/ui";
import { paymentKindLabel } from "@/lib/payment-review";
import {
  limaDateTime,
  limaMovementTime,
  limaPeriod,
  statementRuleLabel,
  type StatementLog,
  type StatementLogEntry,
  type StatementLogMatch,
} from "@/lib/yape-statement/log";

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("es-PE")} ${n === 1 ? one : many}`;
}

function Chip({ tone, children }: { tone: "emerald" | "slate" | "amber" | "red"; children: ReactNode }) {
  const tones = {
    emerald: "bg-emerald-100 text-emerald-900",
    slate: "bg-slate-100 text-slate-700",
    amber: "bg-amber-100 text-amber-900",
    red: "bg-red-100 text-red-800",
  };
  return (
    <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-semibold", tones[tone])}>{children}</span>
  );
}

function MatchesTable({ matches }: { matches: StatementLogMatch[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-[11px] uppercase tracking-[0.08em] text-slate-400">
            <th className="py-2 pr-3 font-semibold">Pedido</th>
            <th className="py-2 pr-3 font-semibold">Tipo</th>
            <th className="py-2 pr-3 text-right font-semibold">Monto</th>
            <th className="py-2 pr-3 font-semibold">Pagó (según Yape)</th>
            <th className="py-2 pr-3 font-semibold">Hora del movimiento</th>
            <th className="py-2 font-semibold">Cómo cuadró</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {matches.map((match) => (
            <tr key={match.paymentId} className="align-top">
              <td className="py-2 pr-3">
                <OrderLink
                  orderId={match.orderId}
                  className="font-semibold text-slate-950 hover:text-brand-700 hover:underline"
                >
                  {match.orderName}
                </OrderLink>
                <p className="max-w-[16rem] truncate text-xs text-slate-500">{match.customerName || "Cliente sin nombre"}</p>
                {match.laterStatus && (
                  <span className="mt-1 inline-flex rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                    {match.laterStatus}
                  </span>
                )}
              </td>
              <td className="py-2 pr-3 text-slate-700">{paymentKindLabel(match.kind)}</td>
              <td className="py-2 pr-3 text-right font-semibold tabular-nums text-slate-950">
                S/ {match.amount.toFixed(2)}
              </td>
              <td className="py-2 pr-3 text-slate-700">{match.payer}</td>
              <td className="py-2 pr-3 tabular-nums text-slate-700">{limaMovementTime(match.movementAt)}</td>
              <td className="py-2 text-xs text-slate-500">{statementRuleLabel(match.rule)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatementCard({ entry, open }: { entry: StatementLogEntry; open: boolean }) {
  const period = limaPeriod(entry.periodFrom, entry.periodTo);
  const validated = entry.matches.length;
  return (
    <details open={open} className="group rounded-xl border border-slate-200 bg-white shadow-sm shadow-slate-900/[0.03]">
      <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-3 rounded-xl p-4 hover:bg-slate-50/70 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-950">
            Reporte recibido el {limaDateTime(entry.receivedAt ?? entry.processedAt)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            <span className="break-all">{entry.fileName}</span> · procesado el {limaDateTime(entry.processedAt)}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            {period ? `Movimientos del ${period}` : "Sin periodo legible"} ·{" "}
            {plural(entry.movements, "movimiento", "movimientos")}, {plural(entry.newMovements, "nuevo", "nuevos")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {entry.repeatOf && <Chip tone="slate">Correo ya procesado</Chip>}
          {!entry.finished && <Chip tone="amber">Sin terminar</Chip>}
          {entry.errors.length > 0 && <Chip tone="red">Con errores</Chip>}
          <Chip tone={validated ? "emerald" : "slate"}>{plural(validated, "validado", "validados")}</Chip>
          <IconChevronDown
            aria-hidden
            className="size-4 text-slate-400 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"
          />
        </div>
      </summary>

      <div className="border-t border-slate-100 px-4 pb-4 pt-3">
        {validated > 0 ? (
          <MatchesTable matches={entry.matches} />
        ) : (
          <p className="text-sm text-slate-600">
            {entry.repeatOf
              ? `Nada nuevo: es el mismo correo que se procesó el ${limaDateTime(entry.repeatOf)}, y lo que traía ya quedó validado entonces.`
              : "No validó ningún pago: ningún comprobante pendiente cuadró al 100 % con un movimiento de este reporte."}
          </p>
        )}

        {entry.leftPending > 0 && (
          <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p className="font-semibold">
              {plural(entry.leftPending, "comprobante pendiente", "comprobantes pendientes")} de ese periodo no
              {entry.leftPending === 1 ? " se validó solo" : " se validaron solos"}:
            </p>
            <ul className="mt-1 space-y-0.5">
              {entry.skipped.map((skip) => (
                <li key={skip.reason}>
                  <span className="inline-block min-w-6 font-semibold tabular-nums">{skip.count}</span> {skip.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        {(entry.courierTimesFilled > 0 || entry.unreadable > 0) && (
          <p className="mt-2 text-xs text-slate-500">
            {entry.courierTimesFilled > 0 &&
              `Antes de cruzar se leyó la hora de ${plural(entry.courierTimesFilled, "cobro del courier", "cobros del courier")}. `}
            {entry.unreadable > 0 &&
              `${plural(entry.unreadable, "fila del Excel no se pudo leer", "filas del Excel no se pudieron leer")}.`}
          </p>
        )}

        {entry.errors.length > 0 && (
          <ul className="mt-3 space-y-0.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
            {entry.errors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

export function YapeStatementLog({ log }: { log: StatementLog }) {
  const latest = log.entries[0];
  const validated = log.entries.reduce((sum, entry) => sum + entry.matches.length, 0);
  return (
    <div className="space-y-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-brand-700">Finanzas</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">Validación de pagos</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Cada reporte de movimientos que Yape Empresa manda por correo y los pagos que validó solo al cruzarlo con
          los comprobantes: mismo monto, mismo minuto y la clienta como pagadora (en el cobro del courier, el mismo
          canal).
        </p>
      </header>

      <PaymentReviewTabs active="estado-yape" />

      {latest ? (
        <>
          <p className="text-sm text-slate-600">
            Último reporte recibido el{" "}
            <strong className="font-semibold text-slate-900">
              {limaDateTime(latest.receivedAt ?? latest.processedAt)}
            </strong>{" "}
            · {plural(validated, "pago validado", "pagos validados")} en{" "}
            {plural(log.entries.length, "reporte", "reportes")}.
          </p>
          <div className="space-y-3">
            {log.entries.map((entry, index) => (
              <StatementCard key={entry.id} entry={entry} open={index === 0} />
            ))}
          </div>
          {log.truncated && (
            <p className="text-center text-xs text-slate-500">
              Se muestran los {log.entries.length} reportes más recientes.
            </p>
          )}
        </>
      ) : (
        <EmptyState title="Todavía no llegó ningún reporte">
          Cuando Yape mande «Te compartimos tus movimientos» al correo, el reporte aparecerá aquí con los pagos que
          validó.
        </EmptyState>
      )}
    </div>
  );
}
