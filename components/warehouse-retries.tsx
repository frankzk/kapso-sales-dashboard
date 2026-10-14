"use client";

// Almacén · «Reintentos por salir» (fase 1, entrega 1c; MOM §9.5).
//
// Las cajas de «En curso · Por reprogramar Lima» que salen hoy (lo vencido
// incluido) o mañana, cada una con lo que Kapta dice que se haga con ella,
// dónde debería estar y qué está mal. Es una tarjeta aparte, debajo de la
// estación: no es la cola de armado (§6.2) y sus cifras no entran en «Por
// empacar» ni en el pendiente de la Mesa de despacho.
//
// Solo lee. Todo llega armado del servidor (lib/warehouse-retries.ts): aquí se
// reparte en «Hoy» y «Mañana» y en sus apartados, sin recalcular nada. Lo único
// que se puede hacer es abrir la ficha, imprimir el rótulo de la misma salida y
// actualizar; el escáner sigue siendo el de la estación.
//
// Se lee después de montar la estación, nunca al pintar en servidor (mientras
// llega, esqueleto). Se relee al volver a la pestaña si pasaron 5 minutos o
// cambió el día de Lima, y con «Actualizar». Nunca tras cada escaneo de armado:
// esa cola es otra.

import { useEffect, useRef } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton, Skeleton, opsButtonClass, type BadgeTone } from "@/components/ops-ui";
import { OrderLink } from "@/components/order-link";
import { limaClock } from "@/lib/grupo-gf-courier";
import {
  BOX_ACTION_LABEL,
  HANDOFF_GROUP,
  HANDOFF_NOTE,
  REPRO_NO_LO_QUIERE_CHIP,
  RETRY_EMPTY_HOY,
  RETRY_EMPTY_MANANA,
  RETRY_ERROR,
  RETRY_HELP,
  RETRY_HOY_HELP,
  RETRY_LABELS_MAX,
  RETRY_MANANA_HELP,
  RETRY_OVERDUE,
  handoffSalidaLine,
  retryLabelsHref,
  type BoxAction,
  type RetryBucket,
  type RetryChip,
  type RetryGroup,
  type WarehouseHandoffRow,
  type WarehouseRetriesData,
  type WarehouseRetryRow,
} from "@/lib/warehouse-retries";

/** Al volver a la pestaña se relee si la lista tiene 5 minutos o más. */
const RETRY_STALE_MS = 5 * 60_000;

/** Los apartados de cada zona, en el orden en que se recorren. */
export const RETRY_GROUP_LABEL: Record<RetryGroup, string> = {
  con_aviso: "Con aviso",
  anaquel: "Al anaquel",
  fuera: "Todavía fuera",
};

/** En «Mañana», primero lo que se prepara la noche anterior (`RETRY_MANANA_HELP`). */
export const RETRY_PREPARE_TONIGHT = "Prepárala hoy";

/**
 * La chapa de la acción con su tono: lo que se deja igual en neutro, lo que
 * pide rearmar o reimprimir en ámbar, la caja nueva en celeste y lo que se
 * desarma para no salir en rojo.
 */
const ACTION_TONE: Record<BoxAction, BadgeTone> = {
  mantener: "neutral",
  reimprimir_misma_salida: "warn",
  salida_nueva_rearmar: "warn",
  desarmar_rearmar: "warn",
  caja_nueva_stock: "info",
  desarmar_cerrar: "crit",
};

export type RetryZoneGroupKey = RetryGroup | "preparala";

export interface RetryZoneGroup {
  key: RetryZoneGroupKey;
  label: string;
  rows: WarehouseRetryRow[];
}

/**
 * Los apartados de una zona, en el orden del servidor. En «Mañana», «Prepárala
 * hoy» va primero con lo que se prepara la noche anterior y no tiene aviso que
 * resolver antes («Al anaquel»); lo que tiene aviso se queda en «Con aviso»,
 * con su chapa de la noche anterior, porque primero hay que resolverlo.
 */
export function retryZoneGroups(rows: readonly WarehouseRetryRow[], bucket: RetryBucket): RetryZoneGroup[] {
  const inZone = rows.filter((row) => row.bucket === bucket);
  const tonight = new Set(bucket === "manana" ? inZone.filter((row) => row.nightBefore && row.group === "anaquel") : []);
  const groups: RetryZoneGroup[] = [];
  if (tonight.size) groups.push({ key: "preparala", label: RETRY_PREPARE_TONIGHT, rows: [...tonight] });
  for (const key of ["con_aviso", "anaquel", "fuera"] as const) {
    const list = inZone.filter((row) => row.group === key && !tonight.has(row));
    if (list.length) groups.push({ key, label: RETRY_GROUP_LABEL[key], rows: list });
  }
  return groups;
}

/**
 * La línea de la acción sin repetir la chapa: cuando los hechos cambiaron, la
 * línea es el nombre de la acción guardada, que ya dice la chapa.
 */
export function retryActionText(action: BoxAction | null, line: string | null): string | null {
  if (!line) return null;
  return action && line === BOX_ACTION_LABEL[action] ? null : line;
}

export interface RetryScanHint {
  tone: "info" | "crit";
  text: string;
}

/**
 * Lo que dice el escáner de la estación cuando la caja escaneada es de un
 * reintento listado: «Reintento de Lima · Hoy: Mantener — Mantener la caja…».
 * Solo busca en lo que ya está en pantalla; no pide nada al servidor. En rojo
 * lo que se desarma porque el cliente ya no lo quiere.
 */
export function retryScanHint(data: WarehouseRetriesData | null | undefined, orderId: string | null | undefined): RetryScanHint | null {
  if (!data || data.error || !orderId) return null;
  const row = data.rows.find((r) => r.orderId === orderId);
  if (row) {
    const crit = row.action === "desarmar_cerrar" || row.chips.some((chip) => chip.text === REPRO_NO_LO_QUIERE_CHIP);
    return { tone: crit ? "crit" : "info", text: scanHintText(row.bucket, row.action, retryActionText(row.action, row.actionLine)) };
  }
  const handoff = data.handoffs.find((h) => h.orderId === orderId);
  if (handoff) return { tone: "info", text: scanHintText(handoff.bucket, handoff.action, handoff.line) };
  return null;
}

function scanHintText(bucket: RetryBucket, action: BoxAction | null, line: string | null): string {
  const head = `Reintento de Lima · ${bucket === "hoy" ? "Hoy" : "Mañana"}`;
  const parts = [action ? BOX_ACTION_LABEL[action] : null, line].filter((part): part is string => Boolean(part));
  return parts.length ? `${head}: ${parts.join(" — ")}` : head;
}

export function WarehouseRetries({
  data,
  onRefresh,
  busy,
}: {
  /** `null` mientras llega la primera lectura, que la estación pide al montar. */
  data: WarehouseRetriesData | null;
  onRefresh: () => Promise<void>;
  busy: boolean;
}) {
  // Cuándo llegó lo que se ve: cada respuesta nueva reinicia la cuenta.
  const loadedAt = useRef(0);
  useEffect(() => {
    loadedAt.current = Date.now();
  }, [data]);

  // Al volver a la pestaña: una lista de la mañana no sirve para la tarde, ni
  // la de ayer para hoy. Dos avisos seguidos (`visibilitychange` y `focus`)
  // piden una sola lectura: la estación no abre otra mientras hay una en curso.
  const today = data?.today ?? null;
  useEffect(() => {
    // Sin lista todavía, la primera lectura ya va en camino.
    if (!today) return;
    const onWake = () => {
      if (document.visibilityState !== "visible" || busy) return;
      const stale = Date.now() - loadedAt.current >= RETRY_STALE_MS || limaClock(new Date()).day !== today;
      if (!stale) return;
      loadedAt.current = Date.now();
      void onRefresh();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [busy, today, onRefresh]);

  return (
    <section id="reintentos" aria-labelledby="reintentos-titulo" aria-busy={busy || !data} className="scroll-mt-4 rounded-lg bg-white shadow-control ring-1 ring-line">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-6">
        <div className="min-w-0">
          <h2 id="reintentos-titulo" className="text-base font-semibold leading-6 text-ink-900">Reintentos por salir</h2>
          <p className="mt-0.5 max-w-2xl text-[13px] text-ink-600">{RETRY_HELP}</p>
        </div>
        {/* La primera lectura va sola: hasta que llega no hay nada que actualizar. */}
        {data && (
          <OpsButton onClick={() => void onRefresh()} disabled={busy} className="self-start pointer-coarse:h-11">
            {busy ? "Actualizando…" : "Actualizar"}
          </OpsButton>
        )}
      </div>

      {!data ? (
        <RetryZonesSkeleton />
      ) : data.error ? (
        // La estación de arriba sigue funcionando: solo esta parte no cargó.
        <div className="px-4 pb-4 sm:px-6 sm:pb-6">
          <Banner tone="crit" role="alert" title={RETRY_ERROR}>
            <OpsButton size="sm" onClick={() => void onRefresh()} disabled={busy} className="mt-2 pointer-coarse:h-11">
              Reintentar
            </OpsButton>
          </Banner>
        </div>
      ) : (
        <>
          {data.omitted > 0 && (
            <p className="px-4 pb-4 text-[13px] tabular-nums text-warn-fg sm:px-6">
              {`Hay ${data.omitted.toLocaleString("es-PE")} pedidos más con fecha hasta mañana fuera de este corte.`}
            </p>
          )}
          {/* Dos zonas sobre hairlines, como «Por armar | Armados hoy». */}
          <div className={cn("grid grid-cols-1 shadow-[inset_0_1px_0_var(--color-line)] transition-opacity duration-150 lg:grid-cols-2", busy && "opacity-60")}>
            <RetryZone
              bucket="hoy"
              title="Hoy"
              count={data.counts.hoy}
              subline={`${data.counts.hoyEnOficina.toLocaleString("es-PE")} en oficina · ${data.counts.hoyFuera.toLocaleString("es-PE")} fuera`}
              help={RETRY_HOY_HELP(data.cutoffLabel)}
              empty={RETRY_EMPTY_HOY}
              data={data}
            />
            <RetryZone
              bucket="manana"
              title="Mañana"
              count={data.counts.manana}
              subline={`${data.counts.mananaNoche.toLocaleString("es-PE")} ${data.counts.mananaNoche === 1 ? "se prepara" : "se preparan"} esta noche`}
              help={RETRY_MANANA_HELP}
              empty={RETRY_EMPTY_MANANA}
              data={data}
              className="shadow-[inset_0_1px_0_var(--color-line)] lg:shadow-[inset_1px_0_0_var(--color-line)]"
            />
          </div>
        </>
      )}
    </section>
  );
}

/** Mientras llega la primera lectura: las dos zonas, con su título, en esqueleto sobre `wash`. */
function RetryZonesSkeleton() {
  return (
    <>
      <p role="status" className="sr-only">Cargando los reintentos…</p>
      <div aria-hidden className="grid grid-cols-1 shadow-[inset_0_1px_0_var(--color-line)] lg:grid-cols-2">
        {["Hoy", "Mañana"].map((title, index) => (
          <div key={title} className={cn("min-w-0 p-4 sm:p-6", index > 0 && "shadow-[inset_0_1px_0_var(--color-line)] lg:shadow-[inset_1px_0_0_var(--color-line)]")}>
            <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
            <div className="mt-4 space-y-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Una zona («Hoy» o «Mañana»): su cifra en la chapa del título, los apartados y lo que ya está en «Por armar». */
function RetryZone({
  bucket,
  title,
  count,
  subline,
  help,
  empty,
  data,
  className,
}: {
  bucket: RetryBucket;
  title: string;
  count: number;
  subline: string;
  help: string;
  empty: string;
  data: WarehouseRetriesData;
  className?: string;
}) {
  const groups = retryZoneGroups(data.rows, bucket);
  const handoffs = data.handoffs.filter((handoff) => handoff.bucket === bucket);
  return (
    <div className={cn("min-w-0 p-4 sm:p-6", className)}>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        <Badge tone={bucket === "hoy" && count ? "warn" : "neutral"} className="tabular-nums">{count.toLocaleString("es-PE")}</Badge>
      </div>
      {count > 0 && <p className="mt-0.5 text-[13px] tabular-nums text-ink-700">{subline}</p>}
      <p className="mt-0.5 text-xs text-ink-500">{help}</p>

      <div className="mt-4 space-y-5">
        {groups.length ? (
          groups.map((group) => (
            <RetryGroupList key={group.key} group={group} showStore={data.showStore} />
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-line-strong py-10 text-center text-sm text-ink-500">{empty}</div>
        )}

        {handoffs.length > 0 && (
          <section>
            {/* No llevan cifra: las cuenta «Por armar». */}
            <h4 className="text-sm font-semibold text-ink-600">{HANDOFF_GROUP}</h4>
            <p className="mt-0.5 text-xs text-ink-500">{HANDOFF_NOTE}</p>
            <ul className="mt-2 divide-y divide-line rounded-lg ring-1 ring-line">
              {handoffs.map((handoff) => (
                <HandoffRow key={handoff.orderId} handoff={handoff} showStore={data.showStore} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function RetryGroupList({ group, showStore }: { group: RetryZoneGroup; showStore: boolean }) {
  // La tanda de rótulos de lo que se prepara esta noche: con uno solo basta el de la fila.
  const labelIds = group.key === "preparala" ? group.rows.flatMap((row) => (row.label ? [row.label.shipmentId] : [])) : [];
  const batch = Math.min(labelIds.length, RETRY_LABELS_MAX);
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink-900">{group.label}</h4>
        <Badge tone={group.key === "con_aviso" ? "warn" : "neutral"} className="tabular-nums">{group.rows.length.toLocaleString("es-PE")}</Badge>
        {batch >= 2 && (
          <a href={retryLabelsHref(labelIds)} target="_blank" rel="noreferrer" className={opsButtonClass("secondary", "sm", "ml-auto tabular-nums pointer-coarse:h-11")}>
            {`Imprimir los ${batch.toLocaleString("es-PE")} rótulos`}
          </a>
        )}
      </div>
      <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
        {group.rows.map((row) => (
          <RetryRow key={row.orderId} row={row} showStore={showStore} />
        ))}
      </ul>
    </section>
  );
}

/** «Hoy» o «Mañana»; lo vencido, en rojo con el día que era. */
function DayBadge({ bucket, dayLabel, overdue }: { bucket: RetryBucket; dayLabel: string; overdue: RetryChip | null }) {
  if (overdue) return <Badge tone="crit" wrap>{overdue.text}</Badge>;
  return <Badge title={dayLabel}>{bucket === "hoy" ? "Hoy" : "Mañana"}</Badge>;
}

/**
 * Una caja: cuál es (pedido, día, courier y cliente), qué hacer con ella, por
 * qué, dónde está y qué está mal. Cada renglón parte en líneas a 360 px.
 */
function RetryRow({ row, showStore }: { row: WarehouseRetryRow; showStore: boolean }) {
  // La chapa del vencido va en el primer renglón: no se repite con las demás.
  const overdueText = RETRY_OVERDUE(row.dayLabel);
  const overdue = row.overdue ? row.chips.find((chip) => chip.text === overdueText) ?? { tone: "crit" as const, text: overdueText } : null;
  const chips = row.chips.filter((chip) => chip.text !== overdueText);
  const line = retryActionText(row.action, row.actionLine);
  const why = [
    row.changesText ? `Cambió: ${row.changesText}` : null,
    row.decidedLine,
    row.programReason ? `Motivo: «${row.programReason}»` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="min-w-0 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <OrderLink orderId={row.orderId} className="font-mono text-xs font-semibold text-ink-900 hover:text-brand-700 hover:underline">{row.orderName}</OrderLink>
        <DayBadge bucket={row.bucket} dayLabel={row.dayLabel} overdue={overdue} />
        <span className="text-xs text-ink-500">{row.courierName}</span>
      </div>
      <p className="mt-0.5 text-xs text-ink-500">{customerLine(row, showStore)}</p>

      {(row.action || line) && (
        <div className="mt-1.5 flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
          {row.action && <Badge tone={ACTION_TONE[row.action]} wrap>{BOX_ACTION_LABEL[row.action]}</Badge>}
          {/* Sin acción, la línea es el problema de la tabla: se lee en ámbar. */}
          {line && <p className={cn("min-w-0 text-[13px]", row.action ? "text-ink-700" : "text-warn-fg")}>{line}</p>}
        </div>
      )}
      {why && <p className="mt-1 text-xs text-ink-600">{why}</p>}
      <p className="mt-1 text-xs text-ink-600">
        {row.boxLabel}
        {row.whereLine && <> · <span className="font-medium text-ink-900">{row.whereLine}</span></>}
      </p>
      {chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {chips.map((chip, index) => (
            <Badge key={`${index}:${chip.text}`} tone={chip.tone} wrap>{chip.text}</Badge>
          ))}
        </div>
      )}
      {row.label && (
        <a
          href={retryLabelsHref([row.label.shipmentId])}
          target="_blank"
          rel="noreferrer"
          className={opsButtonClass("secondary", "sm", "mt-2 pointer-coarse:h-11")}
        >
          Imprimir rótulo
          {row.label.code && <span className="font-mono text-xs font-normal text-ink-500">{row.label.code}</span>}
        </a>
      )}
    </li>
  );
}

/**
 * Un acuerdo cuya salida nueva ya está en «Por armar»: el pedido salió de la
 * etapa, pero la caja vieja sigue en el estante y alguien tiene que saber qué
 * hacer con ella. Sin cifra y sin rótulo: la salida nueva se arma en la cola.
 */
function HandoffRow({ handoff, showStore }: { handoff: WarehouseHandoffRow; showStore: boolean }) {
  const salida = handoffSalidaLine(handoff.salida);
  return (
    <li className="min-w-0 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <OrderLink orderId={handoff.orderId} className="font-mono text-xs font-semibold text-ink-900 hover:text-brand-700 hover:underline">{handoff.orderName}</OrderLink>
        <DayBadge bucket={handoff.bucket} dayLabel={handoff.dayLabel} overdue={handoff.overdue ? { tone: "crit", text: RETRY_OVERDUE(handoff.dayLabel) } : null} />
        <span className="text-xs text-ink-500">{handoff.courierName}</span>
      </div>
      <p className="mt-0.5 text-xs text-ink-500">{customerLine(handoff, showStore)}</p>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
        <Badge tone={ACTION_TONE[handoff.action]} wrap>{BOX_ACTION_LABEL[handoff.action]}</Badge>
        <p className="min-w-0 text-[13px] text-ink-700">{handoff.line}</p>
      </div>
      {salida && <p className={cn("mt-1 text-xs tabular-nums", handoff.salida?.armed ? "text-ok-fg" : "text-ink-600")}>{salida}</p>}
    </li>
  );
}

/** Cliente · distrito, y la tienda si hay más de una a la vista. */
function customerLine(row: Pick<WarehouseRetryRow, "customerName" | "district" | "storeName">, showStore: boolean): string {
  return [row.customerName, row.district ?? "Sin distrito", showStore ? row.storeName : null].filter(Boolean).join(" · ");
}
