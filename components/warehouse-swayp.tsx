"use client";

// Almacén · «Swayp por salir · Lima» (fase 1, SOLO LECTURA; owner 03-11-2026).
//
// Las guías Swayp de Lima y Callao por día de despacho: cuántas hay, cuántas se
// armaron y CUÁL falta, con dónde está la caja física y quién creó la guía (las
// decisiones D1–D5 y las reglas R1–R11 están en lib/warehouse-swayp.ts). Toda
// guía Swayp nace `en_ruta` y sale de «Por armar» al instante, así que hasta
// ahora el almacén no la veía en ninguna lista: las asesoras creaban guías para
// mañana y nadie sabía cuál faltaba.
//
// Va entre la estación y «Reintentos por salir». Es otra lista: sus cifras no
// suman en «Por armar», ni en el número de Lima de «Por empacar», ni en
// «Entregas a couriers» (R9). La celda «Swayp · Lima» de ese marco también se
// pinta aquí (`WarehouseSwaypCell`), pero solo lleva a este apartado.
//
// Solo lee. Todo llega armado del servidor; aquí se reparte en zonas y listas y
// se filtra con las cifras («Las Cifras Navegan», DESIGN.md). Lo único que se
// recalcula es el tono de «Próximo», con el reloj del equipo, para que «Faltan
// 1 h 10 min para el corte» no se quede en la hora de la lectura. Lo que se
// puede hacer: imprimir el rótulo, abrir el pedido y actualizar. El escáner es
// el de la estación; nunca hay «marcar armada» a mano (R4).
//
// Se lee después de montar la estación, nunca al pintar en servidor (mientras
// llega, esqueleto). Se relee con «Actualizar», al volver a la pestaña y, con
// la pestaña visible de 16:00 a 21:30 de Lima, cada 5 minutos (R10): es la
// franja en que Swayp cierra su ruta y el turno noche arma el lote.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton, Skeleton, opsButtonClass, type BadgeTone } from "@/components/ops-ui";
import { IconChevronDown } from "@/components/icons";
import { OrderLink } from "@/components/order-link";
import { SwaypHandoverPanel } from "@/components/warehouse-swayp-handover";
import { openSwaypHandover } from "@/app/dashboard/pedidos/despacho/actions";
import { SWAYP_HANDOVER_BUTTON, SWAYP_HANDOVER_NO_PERMISSION } from "@/lib/swayp-handover";
import { limaClock } from "@/lib/grupo-gf-courier";
import {
  SWAYP_AUTO_REFRESH_MS,
  SWAYP_CELL_ERROR,
  SWAYP_CELL_TITLE,
  SWAYP_ERROR,
  SWAYP_FIGURE_LABEL,
  SWAYP_GUIDE_LINE,
  SWAYP_HELP,
  SWAYP_HOY_URGENT,
  SWAYP_READ_AT,
  SWAYP_REFRESH,
  SWAYP_REFRESH_ERROR,
  SWAYP_RETRY,
  SWAYP_REVISAR_HELP,
  SWAYP_REVISAR_TITLE,
  SWAYP_TITLE,
  swaypAutoRefreshActive,
  swaypCell,
  swaypHoyUrgent,
  swaypToneCounts,
  swaypZoneTone,
  type SwaypArmadaRow,
  type SwaypCounts,
  type SwaypFaltaRow,
  type SwaypRevisarRow,
  type SwaypSalioRow,
  type SwaypTone,
  type SwaypZone,
  type WarehouseSwaypData,
} from "@/lib/warehouse-swayp";

// ---------------------------------------------------------------------------
// Textos de la pantalla (los de las filas y las cifras vienen hechos del servidor)
// ---------------------------------------------------------------------------

/** Las listas de cada zona. */
export const SWAYP_LIST_LABEL = {
  faltan: "Faltan",
  armadas: "Armadas",
  salieron: "Salieron de la lista",
} as const;
export const SWAYP_SALIERON_HELP = "Ya no salen en este lote. Si alguna estaba armada, sácala del sitio de Swayp.";
export const SWAYP_PRINT_LABEL = "Imprimir rótulo";
export const SWAYP_OPEN_ORDER = "Abrir pedido";
export const SWAYP_LOADING = "Cargando «Swayp por salir»…";
/** La relectura falló pero hay un lote anterior: se sigue viendo, con su hora (también en la celda). */
export const SWAYP_STALE = (time: string): string => `Se ve lo leído a las ${time}.`;
/** El enlace de la cabecera con un lote que no se pudo actualizar. */
export const SWAYP_LINK_STALE = "sin actualizar";
/** Lo que dice un filtro que no deja nada. */
export const SWAYP_FILTER_EMPTY = {
  faltan: "No falta ninguna.",
  armadas: "Todavía no se armó ninguna.",
  agregadasTarde: "Ninguna se agregó después de las 17:00.",
} as const;

/** Al volver a la pestaña se relee si lo que se ve tiene un minuto o más (o cambió el día de Lima). */
export const SWAYP_WAKE_STALE_MS = 60_000;
/** Cada cuánto se mira si toca la relectura sola (R10): la cuenta es la edad de lo leído. */
export const SWAYP_AUTO_TICK_MS = 60_000;

// ---------------------------------------------------------------------------
// Reglas puras de la pantalla
// ---------------------------------------------------------------------------

/** Lo que filtra cada cifra: «Programadas» enseña todo (las armadas, plegadas). */
export type SwaypFilter = keyof SwaypCounts;
export const SWAYP_FIGURES: readonly SwaypFilter[] = ["programadas", "armadas", "faltan", "agregadasTarde"];

export interface SwaypZoneView {
  /** null: el filtro no enseña esta lista. */
  faltan: SwaypFaltaRow[] | null;
  armadas: SwaypArmadaRow[] | null;
  /** Las armadas van plegadas: solo sin filtro («Programadas»). */
  armadasFolded: boolean;
  /** «Salieron», «Revisar» y el pie de provincia: solo sin filtro. */
  extras: boolean;
  /** Lo que se dice si el filtro no deja nada. */
  empty: string | null;
}

/**
 * Qué enseña una zona con la cifra elegida. Sin filtro, las faltas van
 * abiertas y enteras, sin tope (R5), y las armadas plegadas; «Faltan» y
 * «Armadas» dejan solo su lista; «Agregadas tarde», las tardías de las dos.
 */
export function swaypZoneView(zone: Pick<SwaypZone, "faltan" | "armadas">, filter: SwaypFilter): SwaypZoneView {
  if (filter === "faltan") {
    return { faltan: zone.faltan, armadas: null, armadasFolded: false, extras: false, empty: zone.faltan.length ? null : SWAYP_FILTER_EMPTY.faltan };
  }
  if (filter === "armadas") {
    return { faltan: null, armadas: zone.armadas, armadasFolded: false, extras: false, empty: zone.armadas.length ? null : SWAYP_FILTER_EMPTY.armadas };
  }
  if (filter === "agregadasTarde") {
    const faltan = zone.faltan.filter((row) => row.late);
    const armadas = zone.armadas.filter((row) => row.late);
    return { faltan, armadas, armadasFolded: false, extras: false, empty: faltan.length + armadas.length ? null : SWAYP_FILTER_EMPTY.agregadasTarde };
  }
  return { faltan: zone.faltan, armadas: zone.armadas, armadasFolded: true, extras: true, empty: null };
}

/**
 * La zona «Próximo» con el tono (y la celda) a la hora de `now`: el servidor
 * lo calculó a la hora de la lectura, y la cuenta atrás al corte de las 21:20
 * no puede quedarse ahí. Sin reloj todavía (antes de montar), la del servidor.
 */
export function swaypLiveZone(zone: SwaypZone, now: Date | null): SwaypZone {
  if (!now || zone.kind !== "proximo") return zone;
  const tone = swaypZoneTone({ ...swaypToneCounts(zone, zone.counts), day: zone.day }, now);
  if (zone.tone?.kind === tone.kind && zone.tone.text === tone.text) return zone;
  return { ...zone, tone, cell: swaypCell({ dayLabel: zone.dayLabel, counts: zone.counts, tone }) };
}

/**
 * Lo que dice el enlace de la cabecera de la estación: «falta 1», «faltan 2»,
 * «completo» o «sin guías» del próximo lote; delante, lo urgente de hoy («hoy:
 * 1 sin armar», que si no quedaba en la segunda zona), y detrás, si la última
 * relectura falló, «sin actualizar».
 */
export function swaypHeaderLinkText(
  zone: Pick<SwaypZone, "counts">,
  opts: { hoy?: Pick<SwaypZone, "kind" | "faltan"> | null; stale?: boolean } = {},
): string {
  const { programadas, faltan } = zone.counts;
  const next = faltan > 0
    ? faltan === 1 ? "falta 1" : `faltan ${faltan.toLocaleString("es-PE")}`
    : programadas > 0 ? "completo" : "sin guías";
  const urgent = swaypHoyUrgent(opts.hoy);
  const parts = [urgent > 0 ? SWAYP_HOY_URGENT(urgent).toLowerCase() : null, next, opts.stale ? SWAYP_LINK_STALE : null];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Lo que identifica una lectura del servidor. La copia local de un escaneo
 * (`applySwaypScan`) conserva `nowIso`: no es una lectura nueva y no reinicia
 * la cuenta de la relectura (antes, cada escaneo la reiniciaba y, con el turno
 * noche escaneando cada pocos minutos, la lista no se releía nunca).
 */
export function swaypReadKey(data: Pick<WarehouseSwaypData, "nowIso" | "error"> | null): string | null {
  return data ? `${data.nowIso}|${data.error ?? ""}` : null;
}

/** Lo que `watchSwaypRefresh` necesita del navegador (en las pruebas, un doble). */
export interface SwaypRefreshEnv {
  win: Pick<Window, "addEventListener" | "removeEventListener"> & {
    setInterval: (handler: () => void, ms: number) => unknown;
    clearInterval: (id: never) => void;
  };
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
  clock: () => Date;
}

/**
 * Cuándo se relee sola (R10), sin pantalla: lo instala el apartado después de
 * montar y devuelve la limpieza.
 * - Al volver a la pestaña (`visibilitychange` y `focus`, que llegan seguidos y
 *   piden una sola lectura: la estación no abre otra mientras hay una en curso),
 *   si lo leído tiene un minuto o más o cambió el día de Lima.
 * - Cada minuto se mira: con la pestaña visible, de 16:00 a 21:30 de Lima,
 *   cuando lo leído tiene 5 minutos; y a cualquier hora si cambió el día de
 *   Lima (la estación pasa la noche abierta: el miércoles «Mañana · miércoles»
 *   y «Hoy · martes» serían falsos, y el escáner apartaría cajas del jueves).
 * `readAt` es cuándo llegó del servidor lo que se ve; se adelanta al pedir.
 */
export function watchSwaypRefresh(
  env: SwaypRefreshEnv,
  opts: { today: string; busy: boolean; readAt: { current: number }; onRefresh: () => void },
): () => void {
  const refresh = (now: Date) => {
    opts.readAt.current = now.getTime();
    opts.onRefresh();
  };
  const idle = () => env.doc.visibilityState === "visible" && !opts.busy;
  const onWake = () => {
    if (!idle()) return;
    const now = env.clock();
    if (now.getTime() - opts.readAt.current >= SWAYP_WAKE_STALE_MS || limaClock(now).day !== opts.today) refresh(now);
  };
  const id = env.win.setInterval(() => {
    if (!idle()) return;
    const now = env.clock();
    if (limaClock(now).day !== opts.today) return refresh(now);
    if (!swaypAutoRefreshActive(now)) return;
    if (now.getTime() - opts.readAt.current < SWAYP_AUTO_REFRESH_MS) return;
    refresh(now);
  }, SWAYP_AUTO_TICK_MS);
  env.win.addEventListener("focus", onWake);
  env.doc.addEventListener("visibilitychange", onWake);
  return () => {
    env.win.clearInterval(id as never);
    env.win.removeEventListener("focus", onWake);
    env.doc.removeEventListener("visibilitychange", onWake);
  };
}

/** El tono de una frase en su par de aviso (`Banner`); el neutro va sin lavado. */
const TONE_BANNER: Record<Exclude<SwaypTone["kind"], "neutral">, "ok" | "warn" | "crit"> = { ok: "ok", warn: "warn", crit: "crit" };

// ---------------------------------------------------------------------------
// El apartado
// ---------------------------------------------------------------------------

export function WarehouseSwayp({
  data,
  onRefresh,
  busy,
  stale = false,
  now,
}: {
  /** `null` mientras llega la primera lectura, que la estación pide al montar. */
  data: WarehouseSwaypData | null;
  onRefresh: () => Promise<unknown>;
  busy: boolean;
  /** La última relectura falló y se sigue viendo la anterior. */
  stale?: boolean;
  /** El reloj de la estación (se resuelve después de montar y cambia cada minuto). */
  now: Date | null;
}) {
  // Cuándo llegó del servidor lo que se ve: solo una lectura nueva reinicia la
  // cuenta, no la copia local de un escaneo (`swaypReadKey`).
  const readAt = useRef(0);
  const readKey = swaypReadKey(data);
  useEffect(() => {
    readAt.current = Date.now();
  }, [readKey]);

  // Al volver a la pestaña y la relectura sola (R10), ver `watchSwaypRefresh`.
  const today = data?.today ?? null;
  useEffect(() => {
    // Sin lista todavía, la primera lectura ya va en camino.
    if (!today) return;
    return watchSwaypRefresh(
      { win: window, doc: document, clock: () => new Date() },
      { today, busy, readAt, onRefresh: () => void onRefresh() },
    );
  }, [busy, today, onRefresh]);

  const proximo = useMemo(() => (data && !data.error ? swaypLiveZone(data.proximo, now) : null), [data, now]);
  const hoy = data && !data.error ? data.hoy : null;

  // «Entregar a Swayp» (fase 3): abrir concilia la entrega con el lote y relee;
  // el panel se pinta con la zona «Hoy» ya releída.
  const [handoverId, setHandoverId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  /**
   * Relee después de escribir. La estación no lanza una segunda lectura si ya
   * hay una en vuelo (devuelve null), y esa pudo salir ANTES de la escritura
   * (la de despertar o la automática): se espera a que termine y se pide otra.
   */
  const refreshAfterWrite = useCallback(async (): Promise<unknown> => {
    for (let attempt = 0; attempt < SWAYP_WRITE_REREAD_TRIES; attempt += 1) {
      const lot = await onRefresh();
      if (lot) return lot;
      await new Promise((done) => setTimeout(done, SWAYP_WRITE_REREAD_WAIT_MS));
    }
    return null;
  }, [onRefresh]);
  async function openHandover() {
    setOpening(true);
    setOpenError(null);
    try {
      const result = await openSwaypHandover();
      if (result.error) setOpenError(result.error);
      const lot = (await refreshAfterWrite()) as WarehouseSwaypData | null;
      if (result.error || !result.manifestId) return;
      if (lot?.hoy?.entrega?.manifestId !== result.manifestId) {
        setOpenError(SWAYP_HANDOVER_READ_ERROR);
        return;
      }
      setHandoverId(result.manifestId);
    } catch {
      setOpenError("No pudimos abrir la entrega. Revisa la conexión y vuelve a intentarlo.");
    } finally {
      setOpening(false);
    }
  }
  function closeHandover() {
    setHandoverId(null);
    // Cerrada la entrega el botón ya no está: el foco vuelve al título del apartado.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) document.getElementById("swayp-titulo")?.focus();
    });
  }
  const handover: SwaypHandoverControl = { can: data?.canHandover ?? false, opening, error: openError, onOpen: () => void openHandover() };

  return (
    <>
    <section id="swayp" aria-labelledby="swayp-titulo" aria-busy={busy || !data} className="scroll-mt-4 rounded-lg bg-white shadow-control ring-1 ring-line">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-6">
        <div className="min-w-0">
          <h2 id="swayp-titulo" className="text-base font-semibold leading-6 text-ink-900" tabIndex={-1} style={{ outline: "none" }}>{SWAYP_TITLE}</h2>
          <p className="mt-0.5 max-w-2xl text-[13px] text-ink-600">{SWAYP_HELP}</p>
        </div>
        {/* La primera lectura va sola: hasta que llega no hay nada que actualizar. */}
        {data && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 self-start">
            {!data.error && <p className="text-xs tabular-nums text-ink-500">{SWAYP_READ_AT(data.leidoAt)}</p>}
            <OpsButton onClick={() => void onRefresh()} disabled={busy} className="pointer-coarse:h-11">
              {busy ? "Actualizando…" : SWAYP_REFRESH}
            </OpsButton>
          </div>
        )}
      </div>

      {!data ? (
        <SwaypSkeleton />
      ) : data.error || !proximo ? (
        // La estación de arriba sigue funcionando: solo esta parte no cargó.
        <div className="px-4 pb-4 sm:px-6 sm:pb-6">
          <Banner tone="crit" role="alert" title={SWAYP_ERROR}>
            <OpsButton size="sm" onClick={() => void onRefresh()} disabled={busy} className="mt-2 pointer-coarse:h-11">
              {SWAYP_RETRY}
            </OpsButton>
          </Banner>
        </div>
      ) : (
        <>
          {stale && (
            <div className="px-4 pb-4 sm:px-6">
              <Banner tone="warn" role="alert" title={SWAYP_REFRESH_ERROR}>
                <p>{SWAYP_STALE(data.leidoAt)}</p>
                <OpsButton size="sm" onClick={() => void onRefresh()} disabled={busy} className="mt-2 pointer-coarse:h-11">
                  {SWAYP_RETRY}
                </OpsButton>
              </Banner>
            </div>
          )}
          {/* Dos zonas sobre hairlines, como «Por armar | Armados hoy»: primero
              el lote que se arma; «Hoy» es para cuadrar. El domingo no hay «Hoy». */}
          <div className={cn("grid grid-cols-1 shadow-[inset_0_1px_0_var(--color-line)] transition-opacity duration-150", hoy && "xl:grid-cols-2", busy && "opacity-60")}>
            <SwaypZoneBlock key={`proximo:${proximo.day}`} zone={proximo} showStore={data.showStore} />
            {hoy && (
              <SwaypZoneBlock
                key={`hoy:${hoy.day}`}
                zone={hoy}
                showStore={data.showStore}
                handover={handover}
                className="shadow-[inset_0_1px_0_var(--color-line)] xl:shadow-[inset_1px_0_0_var(--color-line)]"
              />
            )}
          </div>
        </>
      )}
    </section>
    {/* Fuera de la sección: su `aria-busy` de cada relectura no frena lo que anuncia el contador. */}
    {handoverId && hoy?.entrega && hoy.entrega.manifestId === handoverId && (
      <SwaypHandoverPanel zone={hoy} manifestId={handoverId} onClose={closeHandover} onChanged={refreshAfterWrite} />
    )}
    </>
  );
}

/** Cuántas veces y cada cuánto se reintenta la relectura tras escribir, si ya había una en vuelo. */
const SWAYP_WRITE_REREAD_TRIES = 20;
const SWAYP_WRITE_REREAD_WAIT_MS = 200;
const SWAYP_HANDOVER_READ_ERROR = "Abrimos la entrega pero no pudimos leerla: toca «Actualizar» y vuelve a abrirla.";

interface SwaypHandoverControl {
  /** `dispatch.manage`: Yohalis, Mildred y Yelitza (E1). */
  can: boolean;
  opening: boolean;
  error: string | null;
  onOpen: () => void;
}

const NOTE_TONE: Record<"neutral" | "warn" | "crit" | "ok", string> = {
  neutral: "text-ink-500",
  ok: "font-medium text-ok-fg",
  warn: "font-medium text-warn-fg",
  crit: "font-semibold text-crit-fg",
};

/**
 * El botón de la entrega en «Hoy»: mientras no se cierra (o no se marca «Swayp
 * no vino»), con permiso de Despacho; sin permiso, quién la cierra.
 */
function SwaypHandoverButton({ zone, handover }: { zone: SwaypZone; handover: SwaypHandoverControl }) {
  const state = zone.entrega?.state ?? null;
  if (state === "cerrada" || state === "no_vino") return null;
  if (!handover.can) return <p className="mt-2 text-xs text-ink-500">{SWAYP_HANDOVER_NO_PERMISSION}</p>;
  return (
    <div className="mt-3">
      <OpsButton variant="primary" onClick={handover.onOpen} disabled={handover.opening} className="w-full pointer-coarse:h-11 sm:w-auto">
        {handover.opening ? "Abriendo…" : SWAYP_HANDOVER_BUTTON(zone.shortLabel)}
      </OpsButton>
      {handover.error && <p role="alert" className="mt-2 text-[13px] font-medium text-crit-fg">{handover.error}</p>}
    </div>
  );
}

/** Mientras llega la primera lectura: las dos zonas en esqueleto sobre `wash`. Sin fecha: el reloj aún no está. */
function SwaypSkeleton() {
  return (
    <>
      <p role="status" className="sr-only">{SWAYP_LOADING}</p>
      <div aria-hidden className="grid grid-cols-1 shadow-[inset_0_1px_0_var(--color-line)] xl:grid-cols-2">
        {["Próximo despacho", "Hoy"].map((title, index) => (
          <div key={title} className={cn("min-w-0 p-4 sm:p-6", index > 0 && "shadow-[inset_0_1px_0_var(--color-line)] xl:shadow-[inset_1px_0_0_var(--color-line)]")}>
            <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
            <Skeleton className="mt-3 h-14" />
            <div className="mt-4 space-y-2">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Una zona: su título, la cabecera-frase (se entiende sin colores), el tono de
 * la víspera, las cifras que filtran y las listas. Vacía, solo la frase.
 */
function SwaypZoneBlock({ zone, showStore, handover, className }: { zone: SwaypZone; showStore: boolean; handover?: SwaypHandoverControl; className?: string }) {
  const [chosen, setChosen] = useState<SwaypFilter>("programadas");
  const headingId = useId();
  const hasLot = zone.counts.programadas > 0;
  const filter = hasLot ? chosen : "programadas";
  const view = swaypZoneView(zone, filter);
  // Rojo con el turno cerrado («Próximo») o con una de hoy sin armar que sigue aquí («Hoy»).
  const crit = zone.tone?.kind === "crit" || swaypHoyUrgent(zone) > 0;
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0 p-4 sm:p-6", className)}>
      <h3 id={headingId} className="text-sm font-semibold text-ink-900">{zone.title}</h3>
      {hasLot ? (
        <>
          <p className="mt-0.5 text-sm font-medium tabular-nums text-ink-900">{zone.headline}</p>
          {zone.note && <p className={cn("mt-0.5 text-xs tabular-nums", NOTE_TONE[zone.entrega?.statusTone ?? "neutral"])}>{zone.note}</p>}
          {zone.tone && <SwaypToneLine tone={zone.tone} />}
          {zone.kind === "hoy" && handover && <SwaypHandoverButton zone={zone} handover={handover} />}
          <SwaypFigures zone={zone} filter={filter} onFilter={setChosen} crit={crit} />
        </>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-sm text-ink-500">{zone.empty}</div>
      )}

      <div className="mt-4 space-y-5 empty:hidden">
        {view.empty && (
          <div className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-sm text-ink-500">{view.empty}</div>
        )}
        {view.faltan && view.faltan.length > 0 && <SwaypFaltanList rows={view.faltan} crit={crit} />}
        {view.armadas && view.armadas.length > 0 && <SwaypArmadasList rows={view.armadas} folded={view.armadasFolded} />}
        {view.extras && zone.salieron.length > 0 && <SwaypSalieronList rows={zone.salieron} showStore={showStore} />}
        {view.extras && zone.revisar.length > 0 && <SwaypRevisarList rows={zone.revisar} showStore={showStore} />}
        {view.extras && zone.provincia.text && <p className="text-xs tabular-nums text-ink-500">{zone.provincia.text}</p>}
      </div>
    </section>
  );
}

/** El tono, siempre con su frase: neutro en tinta; ok, ámbar y crítico en su aviso. */
function SwaypToneLine({ tone }: { tone: SwaypTone }) {
  if (tone.kind === "neutral") return <p className="mt-1 text-[13px] text-ink-600">{tone.text}</p>;
  return <Banner tone={TONE_BANNER[tone.kind]} title={tone.text} className="mt-2" />;
}

/**
 * Las cifras de la zona en un marco de celdas: cada una es un botón que filtra
 * las listas («Las Cifras Navegan»), la elegida con el anillo azul de 2 px.
 * Tocar la elegida vuelve a «Programadas». El foco va por dentro de la celda:
 * el marco recorta lo que sale de él (el patrón de «Cómo van las ventas»).
 */
function SwaypFigures({ zone, filter, onFilter, crit }: { zone: SwaypZone; filter: SwaypFilter; onFilter: (filter: SwaypFilter) => void; crit: boolean }) {
  return (
    <div role="group" aria-label={`Cifras de ${zone.title}`} className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line sm:grid-cols-4">
      {SWAYP_FIGURES.map((key) => {
        const active = filter === key;
        const value = zone.counts[key];
        const tone = key === "faltan" && value > 0 ? (crit ? "text-crit-fg" : "text-warn-fg") : "text-ink-900";
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onFilter(active ? "programadas" : key)}
            className={cn(
              "relative flex min-w-0 flex-col items-start bg-white px-3 py-2 text-left transition-colors duration-150 hover:bg-wash",
              "outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600",
              active && "z-10 ring-2 ring-inset ring-brand-600 hover:bg-white",
            )}
          >
            <span className={cn("text-[13px] font-medium leading-5", active ? "text-brand-700" : "text-ink-600")}>{SWAYP_FIGURE_LABEL[key]}</span>
            <span className={cn("text-xl font-semibold leading-7 tabular-nums", active ? "text-brand-700" : tone)}>{value.toLocaleString("es-PE")}</span>
          </button>
        );
      })}
    </div>
  );
}

function ListHead({ title, count, tone = "neutral", help }: { title: string; count: number; tone?: BadgeTone; help?: string }) {
  return (
    <div className="mb-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink-900">{title}</h4>
        <Badge tone={tone} className="tabular-nums">{count.toLocaleString("es-PE")}</Badge>
      </div>
      {help && <p className="mt-0.5 text-xs text-ink-500">{help}</p>}
    </div>
  );
}

/** Las faltas: siempre abiertas, enteras y con nombre (R5). */
function SwaypFaltanList({ rows, crit }: { rows: SwaypFaltaRow[]; crit: boolean }) {
  return (
    <section>
      <ListHead title={SWAYP_LIST_LABEL.faltan} count={rows.length} tone={crit ? "crit" : "warn"} />
      <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
        {rows.map((row) => (
          <SwaypFaltaItem key={row.shipmentId} row={row} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Una FALTA: cuál es (salida y guía), a quién va, de qué pedido, quién creó la
 * guía y cuándo, y dónde está la caja (R11). En «Hoy», además, qué dice Swayp y
 * qué hacer con la que no se armó. Cada renglón parte en líneas a 360 px.
 */
function SwaypFaltaItem({ row }: { row: SwaypFaltaRow }) {
  return (
    <li className="min-w-0 break-words px-3 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <p className="min-w-0 font-mono text-xs font-semibold text-ink-900">{row.title}</p>
        {row.chips.map((chip, index) => (
          <Badge key={`${index}:${chip.text}`} tone={chip.tone} wrap className="tabular-nums">{chip.text}</Badge>
        ))}
      </div>
      <p className="mt-1 text-sm text-ink-700">{row.customerLine}</p>
      <p className="mt-0.5 text-xs text-ink-500">{row.orderLine}</p>
      <p className="mt-0.5 text-xs tabular-nums text-ink-600">{row.createdLine}</p>
      {row.swaypLine && <p className="mt-0.5 text-xs tabular-nums text-ink-600">{row.swaypLine}</p>}
      {/* Si Swayp ya la tomó no hay «dónde está la caja»: solo qué hacer. */}
      {row.where && <p className="mt-1.5 text-[13px] font-medium text-ink-900">{row.where.text}</p>}
      {row.actionLine && (
        <p className={cn("mt-1 text-[13px] font-semibold", row.actionLine.kind === "crit" ? "text-crit-fg" : "text-warn-fg")}>{row.actionLine.text}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <a href={row.labelHref} target="_blank" rel="noreferrer" className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11")}>
          {SWAYP_PRINT_LABEL}
        </a>
        {row.orderId && (
          <OrderLink orderId={row.orderId} className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11")}>
            {SWAYP_OPEN_ORDER}
          </OrderLink>
        )}
      </div>
    </li>
  );
}

/** Las armadas: plegadas sin filtro (lo que hay que mirar son las faltas), abiertas con su cifra elegida. */
function SwaypArmadasList({ rows, folded }: { rows: SwaypArmadaRow[]; folded: boolean }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const shown = !folded || open;
  const badge = <Badge tone="ok" className="tabular-nums">{rows.length.toLocaleString("es-PE")}</Badge>;
  return (
    <section>
      {folded ? (
        <h4 className="text-sm font-semibold text-ink-900">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex min-h-9 items-center gap-2 rounded-md text-left hover:text-ink-700 pointer-coarse:min-h-11"
          >
            <IconChevronDown aria-hidden className={cn("size-4 shrink-0 text-ink-500 transition-transform duration-150", open && "rotate-180")} />
            {SWAYP_LIST_LABEL.armadas}
            {badge}
          </button>
        </h4>
      ) : (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-ink-900">{SWAYP_LIST_LABEL.armadas}</h4>
          {badge}
        </div>
      )}
      <ul id={listId} hidden={!shown} className={cn("divide-y divide-line rounded-lg ring-1 ring-line", folded && "mt-1")}>
        {rows.map((row) => (
          <SwaypArmadaItem key={row.shipmentId} row={row} />
        ))}
      </ul>
    </section>
  );
}

/** Una armada en una línea: «KP202022-S01 · armada lunes 2 nov 17:19 · quién · cliente · distrito». */
function SwaypArmadaItem({ row }: { row: SwaypArmadaRow }) {
  // La línea empieza por el código: va en monoespaciada, como en el resto del almacén.
  const rest = row.line.startsWith(row.code) ? row.line.slice(row.code.length) : ` · ${row.line}`;
  return (
    <li className="min-w-0 break-words px-3 py-2">
      <p className="text-xs tabular-nums text-ink-700">
        <span className="font-mono font-semibold text-ink-900">{row.code}</span>
        {rest}
      </p>
      {row.chips.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {row.chips.map((chip, index) => (
            <Badge key={`${index}:${chip.text}`} tone={chip.tone} wrap className="tabular-nums">{chip.text}</Badge>
          ))}
        </div>
      )}
      {row.swaypLine && <p className="mt-0.5 text-xs tabular-nums text-ink-600">{row.swaypLine}</p>}
      {row.handoverLine && <p className={cn("mt-0.5 text-[13px] tabular-nums", NOTE_TONE[row.handoverLine.kind])}>{row.handoverLine.text}</p>}
    </li>
  );
}

/** Lo que salió de la lista, con su motivo (R8): nunca desaparece en silencio. */
function SwaypSalieronList({ rows, showStore }: { rows: SwaypSalioRow[]; showStore: boolean }) {
  return (
    <section>
      <ListHead title={SWAYP_LIST_LABEL.salieron} count={rows.length} help={SWAYP_SALIERON_HELP} />
      <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
        {rows.map((row) => (
          <li key={row.shipmentId} className="min-w-0 break-words px-3 py-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className="min-w-0 font-mono text-xs font-semibold text-ink-900">{SWAYP_GUIDE_LINE(row.code, row.guideCode)}</p>
              <Badge tone={row.reason === "fecha_cambiada" ? "warn" : "crit"} wrap className="tabular-nums">{row.text}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-ink-500">{metaLine(row, showStore)}</p>
            {row.armedText && <p className="mt-1 text-[13px] font-semibold text-crit-fg">{row.armedText}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Ni Lima ni provincia (R1): se listan para revisar la dirección y no cuentan. */
function SwaypRevisarList({ rows, showStore }: { rows: SwaypRevisarRow[]; showStore: boolean }) {
  return (
    <section>
      <ListHead title={SWAYP_REVISAR_TITLE} count={rows.length} tone="warn" help={SWAYP_REVISAR_HELP} />
      <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
        {rows.map((row) => (
          <li key={row.shipmentId} className="min-w-0 break-words px-3 py-2.5">
            <p className="font-mono text-xs font-semibold text-ink-900">{SWAYP_GUIDE_LINE(row.code, row.guideCode)}</p>
            <p className="mt-0.5 text-xs text-ink-500">{metaLine(row, showStore)}</p>
            <p className="mt-0.5 text-[13px] text-warn-fg">{row.text}</p>
            {row.orderId && (
              <OrderLink orderId={row.orderId} className={opsButtonClass("secondary", "sm", "mt-2 pointer-coarse:h-11")}>
                {SWAYP_OPEN_ORDER}
              </OrderLink>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Cliente · distrito · pedido, y la tienda si hay más de una a la vista. */
function metaLine(row: Pick<SwaypSalioRow, "customerName" | "district" | "orderName" | "storeName">, showStore: boolean): string {
  return [row.customerName, row.district, row.orderName, showStore ? row.storeName : null].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// La celda «Swayp · Lima» del marco «Por empacar»
// ---------------------------------------------------------------------------

const CELL_WASH: Record<SwaypTone["kind"], string> = {
  neutral: "bg-white hover:bg-wash",
  ok: "bg-ok-wash",
  warn: "bg-warn-wash",
  crit: "bg-crit-wash",
};

/**
 * La celda del lote del próximo día de despacho, junto a Lima, Agencia y
 * Provincia COD. No suma al número de Lima (R9): es otra cuenta, la de las
 * guías Swayp, y toda la celda lleva al apartado. El estado lo dice el lavado,
 * como en las demás, y siempre con su frase; sobre un lavado nada va en gris.
 * Lo urgente de hoy (salidas de hoy sin armar que siguen aquí) sube a la celda
 * en rojo, porque «Hoy» queda debajo o al lado de «Próximo». Si la última
 * relectura falló, la celda dice desde qué hora no se actualiza.
 */
export function WarehouseSwaypCell({
  data,
  now,
  stale = false,
  className,
}: {
  data: WarehouseSwaypData | null;
  now: Date | null;
  stale?: boolean;
  /** Cuántas columnas ocupa en el marco (la estación rellena la última fila). */
  className?: string;
}) {
  const zone = useMemo(() => (data && !data.error ? swaypLiveZone(data.proximo, now) : null), [data, now]);
  const cell = zone?.cell ?? null;
  const urgent = data && !data.error ? swaypHoyUrgent(data.hoy) : 0;
  const toneKind = cell?.tone?.kind ?? "neutral";
  const kind = urgent > 0 ? "crit" : toneKind;
  const washed = kind !== "neutral";
  const fg = kind === "ok" ? "text-ok-fg" : kind === "crit" ? "text-crit-fg" : null;
  // El renglón del tono de «Próximo» en su color; si el lavado es otro (lo urgente de hoy), en tinta.
  const toneClass = toneKind !== kind
    ? "text-ink-900"
    : kind === "neutral" ? "text-ink-500" : kind === "warn" ? "font-semibold text-warn-fg" : cn("font-semibold", fg);
  return (
    <a
      href="#swayp"
      className={cn(
        "group relative block min-w-0 px-4 py-3.5 transition-colors duration-150",
        "outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600",
        CELL_WASH[kind],
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={cn("text-[13px] font-semibold group-hover:underline", fg ?? (washed ? "text-ink-900" : "text-ink-700"))}>{SWAYP_CELL_TITLE}</p>
        <span aria-hidden className={cn("text-[13px]", fg ?? (washed ? "text-ink-900" : "text-ink-500"))}>↓</span>
      </div>
      {!data ? (
        <>
          <span className="sr-only">Cargando</span>
          <Skeleton className="mt-1 h-9 w-24" />
          <Skeleton className="mt-1 h-4 w-44 max-w-full" />
        </>
      ) : !cell ? (
        <p className="mt-1 text-sm font-semibold text-crit-fg">{SWAYP_CELL_ERROR}</p>
      ) : (
        <>
          <p className={cn("mt-1 text-[28px] font-semibold leading-9 tabular-nums", fg ?? "text-ink-900")}>{cell.big}</p>
          <p className={cn("text-xs tabular-nums", fg ?? (washed ? "text-ink-700" : "text-ink-600"))}>{cell.sub}</p>
          {cell.tone && <p className={cn("mt-1.5 text-xs tabular-nums", toneClass)}>{cell.tone.text}</p>}
          {urgent > 0 && <p className="mt-1 text-xs font-semibold tabular-nums text-crit-fg">{SWAYP_HOY_URGENT(urgent)}</p>}
          {stale && <p className={cn("mt-1 text-xs tabular-nums", washed ? "text-ink-900" : "text-ink-600")}>{SWAYP_STALE(data.leidoAt)}</p>}
        </>
      )}
    </a>
  );
}
