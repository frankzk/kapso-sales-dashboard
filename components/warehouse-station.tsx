"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DispatchCamera } from "@/components/dispatch-camera";
import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton } from "@/components/ops-ui";
import { IconCamera, IconSearch } from "@/components/icons";
import { markShipmentReady, type DispatchActionResult } from "@/app/dashboard/pedidos/despacho/actions";
import { loadWarehouseStation } from "@/app/dashboard/pedidos/almacen/actions";
import { OPERATION_LABELS } from "@/lib/dispatch-routing";
import {
  buildWarehouseQueue,
  warehousePanels,
  type WarehousePanel,
  type WarehouseQueueEntry,
  type WarehouseQueueGroup,
} from "@/lib/warehouse-queue";
import {
  formatMinutes,
  shiftTone,
  warehouseShiftStatus,
  type ShiftTone,
  type WarehouseShiftStatus,
} from "@/lib/warehouse-shift";
import type {
  DispatchShipment,
  WarehouseShipment,
  WarehouseStationData,
} from "@/lib/dispatch-access";
import type { StoreSummary } from "@/lib/types";

/**
 * La estación de almacén.
 *
 * Vive aparte de la Mesa de despacho a propósito: quien arma cajas no gestiona
 * rutas ni couriers, y la mesa no necesita el escáner de armado para asignar y
 * cotejar. Antes el armado era el paso 1 de una pantalla de cuatro pasos, así
 * que el almacén tenía que entrar por la puerta de despacho y no tenía dónde
 * ver su propia cola: sabía lo que ya había armado, nunca lo que le faltaba.
 */
export function WarehouseStation({
  initialData,
  stores,
}: {
  initialData: WarehouseStationData;
  stores: StoreSummary[];
}) {
  const [data, setData] = useState(initialData);
  const [scan, setScan] = useState("");
  const [query, setQuery] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const storeName = useMemo(() => new Map(stores.map((store) => [store.id, store.name])), [stores]);

  const executeScan = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    setMessage(null);
    const result: DispatchActionResult = await markShipmentReady(value);
    setMessage({ tone: result.error ? "error" : "ok", text: result.error ?? result.notice ?? "Listo." });
    setScan("");
    setData(await loadWarehouseStation());
    setBusy(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [busy]);

  function submitScan(event: FormEvent) {
    event.preventDefault();
    void executeScan(scan);
  }

  const onCameraScan = useCallback((value: string) => {
    void executeScan(value);
  }, [executeScan]);

  const needle = query.trim().toLowerCase();
  const pending = needle ? data.pending.filter((s) => matches(s, needle)) : data.pending;
  const queue = useMemo(() => buildWarehouseQueue(pending), [pending]);
  const blocked = needle ? data.blocked.filter((b) => matches(b.shipment, needle)) : data.blocked;

  // El panel cuenta SIEMPRE la cola entera: buscar una caja concreta no puede
  // bajar el número que el turno tiene que dejar en cero.
  const panels = useMemo(() => warehousePanels(buildWarehouseQueue(data.pending)), [data.pending]);

  // La hora se resuelve DESPUÉS de montar, nunca al renderizar en servidor: el
  // corte depende del reloj, y pintarlo en las dos partes daría hidrataciones
  // distintas. Se refresca cada minuto para que la cuenta atrás no mienta en una
  // pantalla que pasa el turno entero abierta.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const shift = useMemo(() => (now ? warehouseShiftStatus(now) : null), [now]);

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 pb-24">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <Link href="/dashboard/pedidos" className="text-[13px] font-medium text-ink-500 hover:text-ink-900">← Master de Pedidos</Link>
          <h1 className="mt-1 text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Almacén</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">Escanea el rótulo cuando el pedido esté completo, rotulado y dentro de su caja. Eso lo deja listo para despacho; la ruta se decide después, en la mesa.</p>
        </div>
        <nav aria-label="Otras pantallas del almacén" className="flex flex-wrap gap-2">
          <Link href="/dashboard/pedidos/despacho" className={LINK_SECONDARY}>Entregas a couriers <span aria-hidden className="text-ink-500">→</span></Link>
          <Link href="/dashboard/courier/rutas" className={LINK_SECONDARY}>Cajas de Grupo GF <span aria-hidden className="text-ink-500">→</span></Link>
          <Link href="/dashboard/pedidos/devoluciones" className={LINK_SECONDARY}>Devoluciones <span aria-hidden className="text-ink-500">→</span></Link>
        </nav>
      </header>

      <section className="rounded-lg bg-white shadow-control ring-1 ring-line">
        {/* El escaneo es la tarea: va arriba, con el campo grande y enfocado. */}
        <div className="p-4 sm:p-6">
          <h2 className="text-base font-semibold leading-6 text-ink-900">Dejar paquete listo</h2>
          <p className="mt-0.5 text-[13px] text-ink-600">Sirve el QR, el código de barras del pedido, el código de salida o la guía.</p>

          <form onSubmit={submitScan} className="mt-4 flex flex-col gap-2 sm:flex-row">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Código QR, guía o número de pedido</span>
              <svg aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-ink-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 9v6M11 9v6M14 9v6M17 9v6" /></svg>
              <input
                ref={inputRef}
                autoFocus
                value={scan}
                onChange={(event) => setScan(event.target.value)}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="go"
                placeholder="Escanea el rótulo o escribe la guía"
                className="h-12 w-full rounded-md border-0 bg-white pl-11 pr-3 text-base font-medium text-ink-900 shadow-control ring-1 ring-inset ring-line-strong placeholder:font-normal placeholder:text-ink-500 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:bg-wash disabled:text-ink-500"
              />
            </label>
            <OpsButton size="lg" className="h-12" onClick={() => setCameraOpen(true)} disabled={busy}>
              <IconCamera aria-hidden />
              Abrir cámara
            </OpsButton>
            <OpsButton type="submit" variant="primary" size="lg" className="h-12 px-6" disabled={busy || !scan.trim()}>{busy ? "Procesando…" : "Confirmar"}</OpsButton>
          </form>
          {message && <Banner tone={message.tone === "error" ? "crit" : "ok"} role={message.tone === "error" ? "alert" : "status"} className="mt-4">{message.text}</Banner>}
        </div>

        <div className="p-4 shadow-[inset_0_1px_0_var(--color-line)] sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-sm font-semibold text-ink-900">Por empacar</h3>
            <p className="text-xs text-ink-500">Cuenta la cola completa, no lo que filtre el buscador.</p>
          </div>
          {/* Un marco con una celda por operación: el estado lo dice el lavado
              de cada celda (en cero, cerca del corte, corte vencido). */}
          <div className="mt-3 grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line sm:grid-cols-3">
            {panels.map((panel) => (
              <OperationPanel
                key={panel.operation}
                panel={panel}
                shift={panel.operation === "lima" ? shift : null}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 shadow-[inset_0_1px_0_var(--color-line)] xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 p-4 sm:p-6">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">Por armar</h3>
                <p className="mt-0.5 text-xs text-ink-500">En el orden de prioridad del almacén: Lima, agencia y al final provincia.</p>
              </div>
              <Badge tone={data.pending.length ? "warn" : "neutral"} className="shrink-0 tabular-nums">{data.pending.length.toLocaleString("es-PE")}</Badge>
            </div>
            {data.pending.length > 8 && (
              <label className="relative mb-4 block">
                <span className="sr-only">Buscar paquete por armar</span>
                <IconSearch aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por código, pedido, cliente o distrito" className="block h-9 pointer-coarse:h-11 w-full rounded-md border-0 bg-white pl-9 pr-3 text-sm text-ink-900 shadow-control ring-1 ring-inset ring-line-strong placeholder:text-ink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" />
              </label>
            )}
            {queue.groups.length ? (
              <div className="space-y-5">
                {queue.groups.map((group) => (
                  <QueueGroup key={group.operation} group={group} storeName={storeName} />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-line-strong py-12 text-center text-sm text-ink-500">
                {needle ? `Nada por armar coincide con «${query.trim()}».` : "No queda nada por armar. Buen trabajo."}
              </div>
            )}
            {data.pendingOmitted > 0 && <p className="mt-3 text-[13px] text-warn-fg">Hay {data.pendingOmitted} salidas más por armar fuera de este corte.</p>}

            {blocked.length > 0 && (
              <div className="mt-6">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-ink-900">No se pueden armar</h4>
                  <Badge tone="crit" className="tabular-nums">{blocked.length}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-ink-500">Siguen contadas en el Master porque el pedido sigue vivo, pero esta caja concreta ya no se empaca: necesita una salida nueva o ya salió.</p>
                <ul className="mt-2 divide-y divide-line rounded-lg ring-1 ring-line">
                  {blocked.slice(0, 12).map(({ shipment, reason }) => (
                    <li key={shipment.id} className="min-w-0 px-3 py-2">
                      <p className="truncate font-mono text-xs font-semibold text-ink-900">{packageCode(shipment)}</p>
                      <p className="truncate text-xs text-ink-500">{shipment.order_name} · <span className="text-crit-fg">{reason}</span></p>
                    </li>
                  ))}
                </ul>
                {blocked.length > 12 && <p className="mt-2 text-xs text-ink-500">y {blocked.length - 12} más.</p>}
              </div>
            )}
          </div>

          <div className="min-w-0 p-4 shadow-[inset_0_1px_0_var(--color-line)] sm:p-6 xl:shadow-[inset_1px_0_0_var(--color-line)]">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink-900">Armados hoy</h3>
              <Badge tone={data.armedToday.length ? "ok" : "neutral"} className="tabular-nums">{data.armedToday.length.toLocaleString("es-PE")}</Badge>
            </div>
            {data.armedToday.length ? (
              <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
                {data.armedToday.slice(0, 30).map((shipment) => (
                  <li key={shipment.id} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate font-mono text-xs font-semibold text-ink-900">{packageCode(shipment)}</p>
                      <span className="shrink-0 text-xs tabular-nums text-ink-500">{fmtTime(shipment.ready_at)}</span>
                    </div>
                    <p className="truncate text-xs text-ink-600">{shipment.customer_name ?? "Cliente"} · {shipment.district ?? shipment.province ?? "Sin distrito"}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-lg border border-dashed border-line-strong py-12 text-center text-sm text-ink-500">Escanea un paquete terminado y aparecerá aquí.</div>
            )}
          </div>
        </div>
      </section>

      <DispatchCamera open={cameraOpen} onClose={() => setCameraOpen(false)} onScan={onCameraScan} />
    </div>
  );
}

/** Enlace con forma de botón secundario (`OpsButton`). */
const LINK_SECONDARY = "inline-flex h-9 pointer-coarse:h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 text-sm font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong transition-colors duration-150 hover:bg-wash hover:text-ink-900";

/**
 * Un recuadro por operación: cuánto falta empacar y qué lo cierra.
 *
 * El cero se dibuja distinto a propósito. Lo que el almacén necesita ver de un
 * vistazo al cerrar el turno es si Lima quedó limpia, y eso no se lee bien en un
 * número más de una lista: se lee en que el recuadro cambie de estado.
 */
function OperationPanel({
  panel,
  shift,
}: {
  panel: WarehousePanel;
  /** Solo Lima rinde cuentas al corte del turno; el resto va sin él. */
  shift: WarehouseShiftStatus | null;
}) {
  const done = panel.total === 0;
  const tone = shift ? shiftTone(shift, panel.total) : "normal";
  const fg = done ? "text-ok-fg" : tone === "vencido" ? "text-crit-fg" : null;
  return (
    <div
      className={cn(
        "min-w-0 px-4 py-3.5",
        done ? "bg-ok-wash" : tone === "vencido" ? "bg-crit-wash" : tone === "cerca" ? "bg-warn-wash" : "bg-white",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={cn("text-[13px] font-semibold", fg ?? "text-ink-700")}>
          {OPERATION_LABELS[panel.operation] ?? panel.operation}
        </p>
        {panel.stalled > 0 && <Badge tone="warn" className="shrink-0 tabular-nums">{panel.stalled} detenidas</Badge>}
      </div>
      <p className={cn("mt-1 text-[28px] font-semibold leading-9 tabular-nums", fg ?? "text-ink-900")}>
        {panel.total.toLocaleString("es-PE")}
      </p>
      <p className={cn("text-xs", fg ?? "text-ink-600")}>
        {done ? "En cero. Nada por empacar." : panelHint(panel.closer)}
      </p>
      {shift && <p className={cn("mt-1.5 text-xs tabular-nums", shiftLineClass(tone, done))}>{shiftLine(shift, tone, done)}</p>}
    </div>
  );
}

/** Qué cierra las cajas que quedan, dicho en una línea. */
function panelHint(closer: WarehousePanel["closer"]): string {
  if (closer === "courier") return "Empácalas; las cierra el reporte del courier.";
  if (closer === "mixto") return "Unas las cierra tu escaneo y otras el courier.";
  return "Por empacar y escanear aquí.";
}

/**
 * El renglón del turno.
 *
 * Nombra siempre el turno además de la hora: el corte de las 10:20 es del turno
 * mañana y el de las 21:20 del de noche, y sin decirlo el rojo no señala a nadie.
 */
function shiftLine(shift: WarehouseShiftStatus, tone: ShiftTone, done: boolean): string {
  if (tone === "vencido" && shift.missed) {
    const { shift: turno, minutes } = shift.missed;
    return `${turno.label}: el corte de las ${turno.cutoff} pasó hace ${formatMinutes(minutes)}.`;
  }
  if (!shift.next) return "";
  const { shift: turno, minutes } = shift.next;
  if (done) return `Siguiente corte ${turno.cutoff} · ${turno.label.toLowerCase()}.`;
  if (tone === "cerca") return `${turno.label}: faltan ${formatMinutes(minutes)} para el corte de las ${turno.cutoff}.`;
  return `Siguiente corte ${turno.cutoff} · ${turno.label.toLowerCase()}.`;
}

function shiftLineClass(tone: ShiftTone, done: boolean): string {
  if (done) return "text-ok-fg";
  if (tone === "vencido") return "font-semibold text-crit-fg";
  if (tone === "cerca") return "font-semibold text-warn-fg";
  return "text-ink-500";
}

const GROUP_LIMIT = 24;

/**
 * Un bloque por operación, en la prioridad de almacén del MOM §6.2.
 *
 * El encabezado dice de una vez cuánto falta y —cuando el grupo no lo cierra el
 * lector— quién lo cierra. Provincia COD sigue apareciendo porque la caja SÍ se
 * empaca aquí; lo que cambia es que ya no se lee como pendiente de escanear.
 */
function QueueGroup({
  group,
  storeName,
}: {
  group: WarehouseQueueGroup<WarehouseShipment>;
  storeName: Map<string, string>;
}) {
  const byCourier = group.waitingOnCourier === group.entries.length;
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink-900">{OPERATION_LABELS[group.operation] ?? group.operation}</h4>
        <Badge className="tabular-nums">{group.entries.length}</Badge>
        {byCourier && <Badge tone="info" wrap>Las cierra el courier con su reporte, no tu escaneo</Badge>}
        {group.stalled > 0 && <Badge tone="warn" className="tabular-nums">{group.stalled} detenidas</Badge>}
      </div>
      <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
        {group.entries.slice(0, GROUP_LIMIT).map((entry) => (
          <PendingRow key={entry.shipment.id} entry={entry} storeName={storeName} courierNote={!byCourier} />
        ))}
      </ul>
      {group.entries.length > GROUP_LIMIT && (
        <p className="mt-2 text-xs text-ink-500">Se muestran {GROUP_LIMIT} de {group.entries.length}. Usa el buscador para llegar a una concreta.</p>
      )}
    </section>
  );
}

/** Una caja por armar: código, a quién va y qué lleva; la detenida, sobre ámbar y con su chapa. */
function PendingRow({
  entry,
  storeName,
  courierNote,
}: {
  entry: WarehouseQueueEntry<WarehouseShipment>;
  storeName: Map<string, string>;
  /** Si todo el grupo lo cierra el courier, la chapa del grupo ya lo dice. */
  courierNote: boolean;
}) {
  const { shipment, closer, ageDays, stalled } = entry;
  return (
    <li className={cn("flex items-start gap-3 px-3 py-2.5", stalled && "bg-warn-wash")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate font-mono text-xs font-semibold text-ink-900">{packageCode(shipment)}</p>
          {stalled && <Badge tone="warn">Detenida</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-ink-700">{shipment.customer_name ?? "Cliente"} · {shipment.district ?? shipment.province ?? "Sin distrito"}</p>
        <p className="truncate text-xs text-ink-500">
          {shipment.order_name} · {storeName.get(shipment.store_id) ?? "Tienda"}
          {shipment.product && <> · {shipment.product}</>}
        </p>
        {courierNote && closer === "courier" && (
          <p className="mt-0.5 text-xs text-info-fg">Empácala; sale de la cola cuando {courierLabel(shipment.courier)} la reporte preparada.</p>
        )}
      </div>
      <span className={cn("shrink-0 text-xs font-medium tabular-nums", stalled ? "text-warn-fg" : "text-ink-500")}>{ageLabel(ageDays)}</span>
    </li>
  );
}

function ageLabel(days: number): string {
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  return `hace ${days} días`;
}

function courierLabel(courier: string | null): string {
  return courier === "aliclik" ? "Aliclik" : (courier ?? "el courier");
}

function matches(shipment: WarehouseShipment, needle: string): boolean {
  return [
    shipment.output_code,
    shipment.guide_code,
    shipment.order_name,
    shipment.customer_name,
    shipment.district,
    shipment.province,
  ].some((field) => (field ?? "").toLowerCase().includes(needle));
}

function packageCode(shipment: DispatchShipment): string {
  return shipment.output_code ?? shipment.guide_code ?? "Salida sin código";
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
  });
}
