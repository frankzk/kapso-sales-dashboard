"use client";

import Link from "next/link";
import { FormEvent, KeyboardEvent, ReactNode, useCallback, useRef, useState } from "react";
import { DispatchCamera } from "@/components/dispatch-camera";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton } from "@/components/ops-ui";
import { IconCamera } from "@/components/icons";
import {
  receiveReturnedPackage,
  type DispatchActionResult,
} from "@/app/dashboard/pedidos/despacho/actions";
import { loadReturnsReception } from "@/app/dashboard/pedidos/devoluciones/actions";
import type { ReturnsReceptionData } from "@/lib/dispatch-access";
import { daysSince } from "@/lib/returns-reception";
import { shalomReturnSince } from "@/lib/shalom/returns";

/**
 * Recepción de devoluciones de Tanders y Shalom (MOM §9.4).
 *
 * La pregunta que contesta: ¿el courier me está devolviendo TODO lo que no
 * entregó? Cada courier dice qué devolvió —Tanders por su API, Shalom porque
 * sacó la caja de la agencia de destino («cambio de destino», MOM §12)—, y esta
 * pantalla registra qué llegó de verdad, escaneando la caja. Lo devuelto que
 * nadie escaneó es lo que falta recibir.
 *
 * Mismo gesto que el armado de la estación de almacén, otro contexto (MOM
 * §29.13): la pantalla declara qué significa escanear, el usuario solo escanea.
 * Un solo escáner para los dos couriers: quien tiene la caja en la mano no tiene
 * por qué elegir antes de quién es. Desde el 05-10-2026 también recibe lo que
 * vuelve de Grupo GF (`lib/gf-returns-scan.ts`).
 */
export function ReturnsReception({ initialData }: { initialData: ReturnsReceptionData }) {
  const [data, setData] = useState(initialData);
  const [scan, setScan] = useState("");
  const [returnGuide, setReturnGuide] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [staleError, setStaleError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const executeScan = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    setMessage(null);
    const result: DispatchActionResult = await receiveReturnedPackage(value, { returnGuide });
    setMessage({ tone: result.error ? "error" : "ok", text: result.error ?? result.notice ?? "Listo." });
    setScan("");
    // La guía de retorno es de ESTA caja: se limpia al recibirla, y se conserva
    // si el escaneo falló para no tener que volver a escribirla.
    if (!result.error) setReturnGuide("");
    const fresh = await loadReturnsReception();
    if ("data" in fresh) {
      setData(fresh.data);
      setStaleError(null);
    } else {
      setStaleError(fresh.error);
    }
    setBusy(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [busy, returnGuide]);

  function submitScan(event: FormEvent) {
    event.preventDefault();
    void executeScan(scan);
  }

  // El lector de la etiqueta de Shalom también termina en Enter: en el campo de
  // la guía de retorno, Enter pasa al escáner en vez de enviar sin caja.
  function returnGuideKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    inputRef.current?.focus();
  }

  const onCameraScan = useCallback((value: string) => {
    void executeScan(value);
  }, [executeScan]);

  const { tanders, shalom } = data;
  // El avance cuenta lo que cada courier DICE que devolvió: es contra eso contra
  // lo que se cuadra. Lo que Tanders aún trae de vuelta no entra en el total.
  const tandersDeclared = tanders.recibidas.length + tanders.faltan.length;
  const shalomDeclared = shalom.recibidas.length + shalom.porRecibir.length;

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 pb-24">
      <header>
        <Link href="/dashboard/pedidos/almacen" className="text-[13px] font-medium text-ink-500 hover:text-ink-900">← Almacén</Link>
        <h1 className="mt-1 text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Devoluciones</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-500">
          Escanea cada caja que vuelve al almacén, sea de Tanders, de Shalom o de Grupo GF. Lo que el courier devolvió y nadie escaneó es lo que falta recibir. Un «No entregado» de Grupo GF vuelve a «por asignar» para reprogramarlo.
        </p>
      </header>

      <section className="rounded-lg bg-white shadow-control ring-1 ring-line">
        {/* El escaneo es la tarea: el mismo gesto que el armado en Almacén. */}
        <div className="p-4 sm:p-6">
          <h2 className="text-base font-semibold leading-6 text-ink-900">Registrar caja devuelta</h2>
          <p className="mt-0.5 text-[13px] text-ink-600">
            Sirve el QR de la caja (el de Tanders o el de nuestra banda en el rótulo de Shalom), el nº de guía o el nº de pedido.
          </p>

          <form onSubmit={submitScan} className="mt-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">QR de la caja, nº de guía o nº de pedido</span>
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
                  placeholder="QR, guía o nº de pedido"
                  className="h-12 w-full rounded-md border-0 bg-white pl-11 pr-3 text-base font-medium text-ink-900 shadow-control ring-1 ring-inset ring-line-strong placeholder:font-normal placeholder:text-ink-500 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:bg-wash disabled:text-ink-500"
                />
              </label>
              <OpsButton size="lg" className="h-12" onClick={() => setCameraOpen(true)} disabled={busy}>
                <IconCamera aria-hidden />
                Abrir cámara
              </OpsButton>
              <OpsButton type="submit" variant="primary" size="lg" className="h-12 px-6" disabled={busy || !scan.trim()}>{busy ? "Procesando…" : "Recibir"}</OpsButton>
            </div>

            {/* Opcional y solo de Shalom: su etiqueta de retorno trae una guía
                nueva que el sistema no conoce. Se anota con la recepción. */}
            <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <label htmlFor="guia-retorno-shalom" className="shrink-0 text-[13px] font-medium text-ink-700">
                Guía de retorno de Shalom <span className="font-normal text-ink-500">(opcional)</span>
              </label>
              <input
                id="guia-retorno-shalom"
                value={returnGuide}
                onChange={(event) => setReturnGuide(event.target.value)}
                onKeyDown={returnGuideKeyDown}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="next"
                placeholder="Ej. 96908440"
                aria-describedby="guia-retorno-shalom-ayuda"
                className={cn(FIELD, "font-mono sm:w-44")}
              />
              <p id="guia-retorno-shalom-ayuda" className="text-xs text-ink-500">
                La de la etiqueta «cambio de destino». Anótala antes de escanear la caja.
              </p>
            </div>
          </form>
          {message && <Banner tone={message.tone === "error" ? "crit" : "ok"} role={message.tone === "error" ? "alert" : "status"} className="mt-4">{message.text}</Banner>}
          {staleError && (
            <Banner tone="warn" role="alert" className="mt-3" title="No se pudo actualizar el cuadre">
              Las cifras de abajo son las de antes del último escaneo.
              <span className="mt-0.5 block text-xs text-ink-500">{staleError}</span>
            </Banner>
          )}
        </div>
      </section>

      <CourierReturns
        courier="Shalom"
        description="Las que Shalom sacó de la agencia de destino para devolverlas (cambio de destino)."
        stats={
          <>
            <Stat label="Shalom las devolvió" value={shalomDeclared} />
            <Stat label="Recibidas en almacén" value={shalom.recibidas.length} tone={shalom.recibidas.length ? "ok" : undefined} />
            <Stat label="Por recibir" value={shalom.porRecibir.length} tone={shalom.porRecibir.length ? "warn" : undefined} />
          </>
        }
        pending={{
          title: "Por recibir",
          tone: shalom.porRecibir.length ? "warn" : "neutral",
          hint: "Shalom ya las devolvió y nadie las ha escaneado. Las más antiguas primero: una caja que no aparece tras días hay que ir a buscarla.",
          list: (
            <GuideList
              rows={shalom.porRecibir}
              empty="No hay cajas de Shalom pendientes de recibir."
              when={shalomReturnSince}
              whenLabel="devuelta por Shalom"
            />
          ),
          count: shalom.porRecibir.length,
        }}
        received={
          <GuideList rows={shalom.recibidas} empty="Todavía no se ha escaneado ninguna devolución de Shalom." when={(r) => r.received_at} whenLabel="recibida" />
        }
        receivedCount={shalom.recibidas.length}
      />

      <CourierReturns
        courier="Tanders"
        description="Lo que Tanders dio por devuelto o trae de vuelta, según su API."
        stats={
          <>
            <Stat label="Tanders dice que devolvió" value={tandersDeclared} />
            <Stat label="Recibidas en almacén" value={tanders.recibidas.length} tone={tanders.recibidas.length ? "ok" : undefined} />
            <Stat label="Faltan (te las debe)" value={tanders.faltan.length} tone={tanders.faltan.length ? "crit" : undefined} />
            <Stat label="Vienen en camino" value={tanders.enCamino.length} />
          </>
        }
        pending={{
          title: "Faltan por llegar",
          tone: tanders.faltan.length ? "crit" : "neutral",
          hint: "Tanders las dio por devueltas y nadie las ha escaneado. Las más antiguas primero: una caja que no aparece tras días no es un retraso.",
          list: (
            <GuideList rows={tanders.faltan} empty="Todo lo que Tanders dio por devuelto está en el almacén." when={(r) => r.returned_at} whenLabel="devuelta según Tanders" />
          ),
          count: tanders.faltan.length,
        }}
        received={
          <GuideList rows={tanders.recibidas} empty="Todavía no se ha escaneado ninguna devolución de Tanders." when={(r) => r.received_at} whenLabel="recibida" />
        }
        receivedCount={tanders.recibidas.length}
      />

      <DispatchCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onScan={onCameraScan}
        continuous
        progress={{
          done: tanders.recibidas.length + shalom.recibidas.length,
          total: tandersDeclared + shalomDeclared,
          verb: "Recibidas",
        }}
        status={message ? { ok: message.tone === "ok", text: message.text } : null}
      />
    </div>
  );
}

/**
 * El cuadre de un courier: la línea de cifras y, debajo, lo que falta frente a
 * lo recibido. «Falta» solo se tiñe si hay algo que reclamar.
 */
function CourierReturns({
  courier,
  description,
  stats,
  pending,
  received,
  receivedCount,
}: {
  courier: string;
  description: string;
  stats: ReactNode;
  pending: { title: string; tone: "crit" | "warn" | "neutral"; hint: string; list: ReactNode; count: number };
  received: ReactNode;
  receivedCount: number;
}) {
  return (
    <section aria-labelledby={`devoluciones-${courier}`} className="rounded-lg bg-white shadow-control ring-1 ring-line">
      <div className="p-4 sm:p-6">
        <h2 id={`devoluciones-${courier}`} className="text-base font-semibold leading-6 text-ink-900">{courier}</h2>
        <p className="mt-0.5 text-[13px] text-ink-600">{description}</p>
        {/* Una fila de cifras iguales desde `sm`; en el teléfono, de dos en dos, y
            la impar del final ocupa la fila entera en vez de dejar un hueco gris. */}
        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line max-sm:[&>*:last-child:nth-child(odd)]:col-span-2 sm:grid-flow-col sm:auto-cols-fr sm:grid-cols-none">
          {stats}
        </dl>
      </div>

      <div className="grid grid-cols-1 shadow-[inset_0_1px_0_var(--color-line)] lg:grid-cols-2">
        <div className="min-w-0 p-4 sm:p-6">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-ink-900">{pending.title}</h3>
            <Badge tone={pending.tone} className="tabular-nums">{pending.count}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-ink-500">{pending.hint}</p>
          {pending.list}
        </div>
        <div className="min-w-0 p-4 shadow-[inset_0_1px_0_var(--color-line)] sm:p-6 lg:shadow-[inset_1px_0_0_var(--color-line)]">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-ink-900">Recibidas</h3>
            <Badge tone={receivedCount ? "ok" : "neutral"} className="tabular-nums">{receivedCount}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-ink-500">Confirmadas por alguien con la caja en la mano.</p>
          {received}
        </div>
      </div>
    </section>
  );
}

const STAT_TONE = {
  ok: { cell: "bg-white", label: "text-ink-500", value: "text-ok-fg" },
  warn: { cell: "bg-warn-wash", label: "font-medium text-warn-fg", value: "text-warn-fg" },
  crit: { cell: "bg-crit-wash", label: "font-medium text-crit-fg", value: "text-crit-fg" },
  none: { cell: "bg-white", label: "text-ink-500", value: "text-ink-900" },
};

/** Una cifra del cuadre; el tono tiñe el número y, si hay algo pendiente, la celda. */
function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "crit" }) {
  const t = STAT_TONE[tone ?? "none"];
  return (
    <div className={cn("min-w-0 px-4 py-3", t.cell)}>
      <dt className={cn("text-[13px]", t.label)}>{label}</dt>
      <dd className={cn("mt-0.5 text-xl font-semibold leading-7 tabular-nums", t.value)}>{value.toLocaleString("es-PE")}</dd>
    </div>
  );
}

function GuideList<Row extends { id: string; order_name: string | null; guide_code: string | null }>({
  rows,
  empty,
  when,
  whenLabel,
}: {
  rows: Row[];
  empty: string;
  when: (row: Row) => string | null;
  whenLabel: string;
}) {
  if (!rows.length) {
    return <div className="mt-3 rounded-lg border border-dashed border-line-strong py-8 text-center text-sm text-ink-500">{empty}</div>;
  }
  return (
    <ul className="mt-3 max-h-[28rem] divide-y divide-line overflow-y-auto rounded-lg ring-1 ring-line">
      {rows.map((row) => {
        const days = daysSince(when(row));
        return (
          <li key={row.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
            {/* El pedido y la guía se leen enteros; la antigüedad es la que parte línea. */}
            <div className="shrink-0">
              <p className="text-sm font-semibold tabular-nums text-ink-900">{row.order_name ?? "—"}</p>
              <p className="font-mono text-xs text-ink-500">{row.guide_code}</p>
            </div>
            <span className="min-w-0 pt-0.5 text-right text-xs text-pretty tabular-nums text-ink-500">
              {days == null ? "" : days === 0 ? `${whenLabel} hoy` : `${whenLabel} hace ${days} día${days === 1 ? "" : "s"}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
