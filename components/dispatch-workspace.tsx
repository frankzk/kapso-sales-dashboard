"use client";

import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { DispatchScanner } from "@/components/dispatch-scanner";
import { DispatchCamera } from "@/components/dispatch-camera";
import { createScanQueue } from "@/lib/scan-queue";
import { GfBoxAddPackages } from "@/components/gf-box-add-packages";
import { cn } from "@/components/ui";
import { Badge, Banner, CHECKBOX, FIELD, OpsButton, type BadgeTone } from "@/components/ops-ui";
import { IconCheckCircle, IconChevronDown, IconPlus, IconSearch } from "@/components/icons";
import { isCourierTbd } from "@/lib/shipment-output";
import { courierKey } from "@/lib/dispatch";
import {
  addShipmentsToManifest,
  cancelDispatchManifest,
  createDispatchManifest,
  handOverToCourier,
  loadDispatchWorkspace,
  removeManifestItem,
  scanManifestItem,
  type DispatchActionResult,
} from "@/app/dashboard/pedidos/despacho/actions";
import {
  DISPATCH_STATE_LABELS,
  activeDispatchItems,
  dispatchProgress,
  needsRiderCheck,
  routeDay,
  routeDayLong,
  routeName,
  routeNameLong,
  type DispatchManifestState,
} from "@/lib/dispatch";
import type {
  DispatchManifest,
  DispatchManifestItem,
  DispatchRider,
  DispatchShipment,
  DispatchWorkspaceData,
} from "@/lib/dispatch-access";
import {
  courierLabelFor,
  routeChoiceByValue,
  routeChoices,
} from "@/lib/couriers/catalog";
import { routeKindForCourier } from "@/lib/dispatch-routing";
import type { StoreSummary } from "@/lib/types";
import { nextDispatchMode } from "@/lib/courier-flow";

/**
 * Los tres momentos de una RUTA, en orden (MOM Fase 2).
 *
 * `build` es el que faltaba: antes la ruta se CONSTRUÍA escaneando en el cotejo
 * de oficina, así que no había forma de decidir en la computadora qué va con
 * quién y después verificarlo. Ahora se decide aquí y el cotejo solo confirma.
 *
 * Armar la caja NO es un paso de esta pantalla: vive en /dashboard/pedidos/almacen.
 * Mezclarlo aquí obligaba al almacén a entrar por la mesa de despacho y le
 * escondía su propia cola de pendientes.
 */
type Mode = "build" | "office" | "pickup";

/** ¿El paquete ya pasó por el escaneo de almacén? */
function isArmed(shipment: { preparation_state: string } | null | undefined): boolean {
  return shipment?.preparation_state === "listo_despacho";
}

/**
 * Título y subtítulo de una ruta.
 *
 * El título es QUIÉN se lleva la caja. Cuando no hay una persona concreta —Urpi,
 * Aliclik, una agencia— quien se la lleva ES el courier, y el subtítulo lo dice.
 * La versión anterior ponía "Sin motorizado" de título: no nombraba nada y
 * dejaba la tarjeta sin identidad justo donde se elige entre varias rutas.
 */
function routeHeading(manifest: DispatchManifest): { title: string; subtitle: string } {
  const who = manifest.received_by ?? manifest.driver_name;
  const courier = courierLabelFor(manifest.courier);
  return who ? { title: who, subtitle: `${courier}${manifest.courier === "propio" ? ` · Carga ${manifest.load_number ?? 1}` : ""}` } : { title: courier, subtitle: "Courier" };
}

/** Estado de la caja como chapa del mundo de operación. */
const STATE_BADGE: Record<DispatchManifestState, BadgeTone> = {
  draft: "neutral",
  office_check: "warn",
  ready_for_pickup: "info",
  pickup_check: "info",
  in_custody: "ok",
  cancelled: "crit",
};

/** Enlace con forma de botón secundario (`OpsButton`), para navegar o descargar. */
const LINK_SECONDARY = "inline-flex h-9 pointer-coarse:h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 text-sm font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong transition-colors duration-150 hover:bg-wash hover:text-ink-900";

function todayLima(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function packageCode(shipment: DispatchShipment | null): string {
  return shipment?.output_code ?? shipment?.guide_code ?? "Salida sin código";
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DispatchWorkspace({
  initialData,
  initialSelectedId,
  stores,
  riders,
  canPrepare,
  canManage,
  canPickup,
  surface = "warehouse",
}: {
  initialData: DispatchWorkspaceData;
  initialSelectedId?: string | null;
  stores: StoreSummary[];
  riders: DispatchRider[];
  canPrepare: boolean;
  canManage: boolean;
  canPickup: boolean;
  surface?: "warehouse" | "gf";
}) {
  const scopeData = (value: DispatchWorkspaceData): DispatchWorkspaceData => ({ ...value,
    manifests: value.manifests.filter((manifest) => (courierKey(manifest.courier) === "propio") === (surface === "gf")),
    assignableShipments: value.assignableShipments.filter((shipment) => surface === "gf" ? courierKey(shipment.courier) === "propio" : courierKey(shipment.courier) !== "propio"),
  });
  const [data, setData] = useState(() => scopeData(initialData));
  const initialManifest = data.manifests.find((manifest) => manifest.id === initialSelectedId)
    ?? data.manifests.find((manifest) => !["in_custody", "cancelled"].includes(manifest.state)) ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(
    initialManifest?.id ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const activeManifests = data.manifests.filter((manifest) => manifest.state !== "cancelled");
  const storeName = useMemo(() => new Map(stores.map((store) => [store.id, store.name])), [stores]);

  async function refresh(preferId?: string | null) {
    const fresh = await loadDispatchWorkspace(preferId ?? selectedId);
    setData(scopeData(fresh));
    if (preferId) setSelectedId(preferId);
  }

  function showResult(result: DispatchActionResult) {
    setMessage({ tone: result.error ? "error" : "ok", text: result.error ?? result.notice ?? "Listo." });
  }

  const stats = useMemo(() => {
    const active = data.manifests.filter((m) => !["in_custody", "cancelled"].includes(m.state));
    return {
      ready: data.assignableShipments.filter(isArmed).length,
      // El pendiente de almacén lo define el almacén: aquí solo se informa.
      pending: data.warehousePending,
      routes: active.length,
      officeReady: active.filter((m) => m.state === "ready_for_pickup").length,
      transferred: data.manifests.filter((m) => m.state === "in_custody" && m.route_date === todayLima()).length,
    };
  }, [data]);

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 pb-12">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <Link href={surface === "gf" ? "/dashboard/courier?tab=routes" : "/dashboard/pedidos/almacen"} className="text-[13px] font-medium text-ink-500 hover:text-ink-900">{surface === "gf" ? "← Grupo GF Courier · Rutas" : "← Almacén"}</Link>
          <h1 className="mt-1 text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">{surface === "gf" ? "Verificar y recibir" : "Entregas a couriers"}</h1>
          <p className="mt-1 hidden max-w-2xl text-sm text-ink-500 sm:block">{surface === "gf" ? "Verifica la caja y luego registra la recepción del motorizado. La custodia cambia al recibir el 100 %." : "Primero se asigna la ruta, después se coteja. La custodia cambia solo cuando el motorizado recibe el 100 % — o, si no hay motorizado, cuando se anota quién recoge."}</p>
        </div>
        <div className={cn("items-center gap-2", surface === "gf" ? "hidden sm:flex" : "flex")}>
          {canPrepare && (
            <Link href="/dashboard/pedidos/almacen" className={LINK_SECONDARY}>Ir al Almacén</Link>
          )}
          {canManage && surface !== "gf" && (
            <OpsButton variant="primary" onClick={() => setShowCreate(true)}><IconPlus aria-hidden />Nueva ruta</OpsButton>
          )}
          {surface === "gf" && <Link href="/dashboard/courier" className={LINK_SECONDARY}>Tomar y asignar pedidos</Link>}
        </div>
      </header>

      {/* El día de la mesa en una línea de cifras: informan, no filtran, así
          que van en un solo marco con hairlines y no en tarjetas (DESIGN.md). */}
      <dl className="hidden grid-cols-2 gap-px overflow-hidden rounded-lg bg-line shadow-control ring-1 ring-line sm:grid lg:grid-cols-4">
        <Metric label="Armados sin ruta" value={stats.ready} />
        <Metric label="Por armar en almacén" value={stats.pending} />
        <Metric label="Listas para recojo" value={stats.officeReady} />
        <Metric label="Entregadas hoy" value={stats.transferred} />
      </dl>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside inert={busy} className="order-2 space-y-3 xl:order-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink-900">Rutas recientes</h2>
            <Badge className="tabular-nums">{activeManifests.length}</Badge>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
            {activeManifests.length ? activeManifests.map((manifest) => (
              <ManifestCard
                key={manifest.id}
                manifest={manifest}
                active={selectedId === manifest.id}
                onClick={() => { setMessage(null); setSelectedId(manifest.id); }}
              />
            )) : <div className="rounded-lg border border-dashed border-line-strong p-6 text-center text-sm text-ink-500">Aún no hay rutas. Crea una para comenzar.</div>}
          </div>
        </aside>

        <div className="order-1 min-w-0 xl:order-2">
          {/* La clave reinicia el paso al cambiar de caja: cada una arranca en
              el paso que le toca. */}
          <DispatchBoxPanel
            key={selectedId ?? "none"}
            data={data}
            manifestId={selectedId}
            manifests={activeManifests}
            canManage={canManage}
            canPickup={canPickup}
            surface={surface}
            storeName={storeName}
            refresh={refresh}
            onSelect={(id) => { setMessage(null); setSelectedId(id); }}
            onBusy={setBusy}
            message={message}
            setMessage={setMessage}
          />
        </div>
      </div>

      {showCreate && <CreateManifestModal riders={riders} onClose={() => setShowCreate(false)} onCreated={async (result) => { showResult(result); if (result.manifestId) { await refresh(result.manifestId); setSelectedId(result.manifestId); } setShowCreate(false); }} />}
    </div>
  );
}

/**
 * Los tres pasos de UNA caja: agregar, verificar, recibir.
 *
 * Es lo que la mesa de despacho enseña a la derecha de «Rutas recientes» y lo
 * que la pestaña Rutas de Grupo GF Courier abre en el panel lateral
 * (`courier-box-drawer.tsx`, MOM §29.14). El panel no sabe de listas ni de
 * KPIs: recibe los datos, la caja elegida y cómo refrescar.
 */
export function DispatchBoxPanel({
  data,
  manifestId,
  manifests,
  canManage,
  canPickup,
  surface = "warehouse",
  storeName,
  refresh,
  onSelect,
  onBusy,
  message: outerMessage,
  setMessage: setOuterMessage,
  showTarget = true,
}: {
  data: DispatchWorkspaceData;
  manifestId: string | null;
  /** Cajas entre las que se puede cambiar; con una sola no hay selector. */
  manifests: DispatchManifest[];
  canManage: boolean;
  canPickup: boolean;
  surface?: "warehouse" | "gf";
  storeName: Map<string, string>;
  refresh: (preferId?: string | null) => Promise<void>;
  onSelect?: (id: string) => void;
  onBusy?: (busy: boolean) => void;
  /** Mensaje compartido con quien monta el panel (la mesa lo usa al crear rutas). */
  message?: { tone: "ok" | "error"; text: string } | null;
  setMessage?: (value: { tone: "ok" | "error"; text: string } | null) => void;
  /** El bloque «Caja seleccionada»; sobra cuando el panel ya lleva cabecera propia. */
  showTarget?: boolean;
}) {
  const selected = useMemo(
    () => data.manifests.find((manifest) => manifest.id === manifestId) ?? null,
    [data.manifests, manifestId],
  );
  function modeForAccess(manifest: DispatchManifest | null): Mode {
    const next = nextDispatchMode(manifest, canManage);
    return next === "pickup" && !canPickup && canManage ? "office" : next;
  }
  const [mode, setMode] = useState<Mode>(() => modeForAccess(selected));
  const [cameraOpen, setCameraOpen] = useState(false);
  const [pendingScans, setPendingScans] = useState(0);
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [scanQueue] = useState(() => createScanQueue(setPendingScans));
  const busy = pendingScans > 0 || assignmentBusy;
  const [lastCaptured, setLastCaptured] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Record<string, string[]>>({});
  const [failedReads, setFailedReads] = useState<Record<string, string>>({});
  const needsRefresh = useRef(false);
  const [ownMessage, setOwnMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const message = outerMessage === undefined ? ownMessage : outerMessage;
  const setMessage = setOuterMessage ?? setOwnMessage;
  const closeCamera = useCallback(() => setCameraOpen(false), []);
  useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);
  const refreshAfterScans = useEffectEvent(async () => {
    try { await refresh(manifestId); }
    catch { setMessage({ tone: "error", text: "Las lecturas respondieron, pero no se pudo actualizar la caja. Revisa la conexión y vuelve a abrirla." }); }
  });
  useEffect(() => {
    if (pendingScans || !needsRefresh.current) return;
    const timer = window.setTimeout(() => {
      needsRefresh.current = false;
      void refreshAfterScans();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [pendingScans, manifestId]);

  function showResult(result: DispatchActionResult) {
    setMessage({ tone: result.error ? "error" : "ok", text: result.error ?? result.notice ?? "Listo." });
  }

  function executeScan(raw: string) {
    const value = raw.trim();
    if (!value) return;
    if (!selected) { showResult({ error: "Elige una ruta antes de escanear." }); return; }
    const target = selected.id;
    const stage = mode === "office" ? "office" : "pickup";
    const recordFailure = (error?: string) => setFailedReads((current) => {
      const next = { ...current };
      const key = `${target}:${stage}:${value.toLowerCase()}`;
      if (error) next[key] = `${value}: ${error}`;
      else delete next[key];
      return next;
    });
    const accepted = scanQueue.enqueue({
      key: `${target}:${stage}:${value.toLowerCase()}`,
      run: async () => {
        // Verification only checks a package already assigned to this box.
        const result = await scanManifestItem(target, value, stage);
        recordFailure(result.error);
        showResult({ ...result, notice: result.notice ? `${value}: ${result.notice}` : undefined, error: result.error ? `${value}: ${result.error}` : undefined });
        if (!result.error && result.shipment) {
          const shipmentId = result.shipment.id;
          const key = `${target}:${stage}`;
          setConfirmed((current) => ({ ...current, [key]: [...new Set([...(current[key] ?? []), shipmentId])] }));
        }
      },
      onError: () => {
        const error = "No se pudo confirmar. Revisa la conexión y vuelve a escanear el mismo paquete; no se duplicará.";
        recordFailure(error);
        setMessage({ tone: "error", text: `${value}: ${error}` });
      },
    });
    if (accepted) {
      needsRefresh.current = true;
      setLastCaptured(value);
    }
  }

  const progress = selected ? dispatchProgress(selected.items) : null;
  const scanStage = mode === "office" ? "office" : "pickup";
  const confirmedHere = new Set(confirmed[`${manifestId}:${scanStage}`] ?? []);
  const scanIssues = Object.entries(failedReads).filter(([key]) => key.startsWith(`${manifestId}:${scanStage}:`)).map(([, text]) => text);
  const confirmedCount = selected ? activeDispatchItems(selected.items).filter((item) =>
    (scanStage === "office" ? item.office_checked_at : item.pickup_checked_at) || confirmedHere.has(item.shipment_id),
  ).length : 0;
  const checkComplete = selected?.state !== "cancelled" && !!progress && (mode === "office" ? progress.officeComplete : progress.pickupComplete);
  // Con la carga ya en custodia, el cotejo de oficina se cierra (la caja ya
  // salió), pero el de recojo sigue abierto si el modo del proveedor no es
  // «exigir» (0185): es el respaldo cuando el motorizado no puede confirmar
  // desde su teléfono. El servidor (`scanManifestItem`) aplica la misma regla.
  const pickupMode = selected ? (data.pickupModeByOrg?.[selected.org_id] ?? "exigir") : "exigir";
  const custodyPickupOpen = !!selected && selected.state === "in_custody" && pickupMode !== "exigir";
  const scanAllowed = !!selected && selected.state !== "cancelled"
    && (mode === "office"
      ? canManage && selected.state !== "in_custody"
      : canPickup && !!progress?.officeComplete && (selected.state !== "in_custody" || custodyPickupOpen));
  const pickupPending = progress ? progress.total - progress.pickupChecked : 0;
  // Dentro del panel lateral de Rutas (sin «Caja seleccionada») la hoja ya es
  // la superficie; en la mesa de almacén la sección es la tarjeta de trabajo.
  const onPage = showTarget;
  const scanner = (key: string) => (
    <DispatchScanner key={key} look="ops" busy={false} disabled={!scanAllowed} onScan={executeScan} onCamera={() => setCameraOpen(true)} />
  );

  return (
    <div className="min-w-0 space-y-4">
          <div inert={busy} className="grid grid-cols-3 gap-0.5 rounded-lg bg-wash p-0.5 ring-1 ring-inset ring-line">
            <ModeButton active={mode === "build"} disabled={!canManage} onClick={() => setMode("build")} number="1" label="Agregar pedidos" />
            <ModeButton active={mode === "office"} disabled={!canManage} onClick={() => setMode("office")} number="2" label="Verificar caja" />
            <ModeButton active={mode === "pickup"} disabled={!canPickup || (!!selected && !needsRiderCheck(selected.kind))} onClick={() => setMode("pickup")} number="3" label="Recibir carga" />
          </div>

          <section className={cn("rounded-lg ring-1 ring-line", onPage && "bg-white shadow-control")}>
            <div className="p-4 shadow-[inset_0_-1px_0_var(--color-line)] sm:p-5">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div>
                  <h2 className="text-base font-semibold leading-6 text-ink-900">{MODE_TITLES[mode]}</h2>
                  <p className="mt-0.5 max-w-[60ch] text-[13px] leading-5 text-ink-600">{surface === "gf" && mode === "build" ? "Escanea un paquete tras otro para agregarlos a esta caja. Después confirma su contenido en «Verificar caja»." : MODE_HINTS[mode]}</p>
                </div>
                {/* En el panel de Rutas la cabecera ya lleva la situación de la ruta. */}
                {selected && onPage && <Badge tone={STATE_BADGE[selected.state]} className="shrink-0 self-start">{DISPATCH_STATE_LABELS[selected.state]}</Badge>}
              </div>

              {selected && showTarget && (
                <RouteTarget mode={mode} disabled={busy} manifest={selected} manifests={manifests} onSelect={(id) => { setMessage(null); onSelect?.(id); }} />
              )}
              {surface === "gf" && selected && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-600">
                <span className="tabular-nums">{activeDispatchItems(selected.items).length} paquete{activeDispatchItems(selected.items).length === 1 ? "" : "s"} en esta carga</span>
                {selected.state === "in_custody" && pickupMode === "exigir" && <Link href="/dashboard/courier" className="font-medium text-brand-700 hover:underline">Agregar una carga a la misma ruta →</Link>}
              </div>}

              {mode !== "build" && checkComplete && selected ? (
                <Banner tone="ok" role="status" className="mt-4" title={`${mode === "office" ? "Caja verificada" : "Carga recibida"} · ${progress?.total} de ${progress?.total}`}>
                  <p>{selected.state === "in_custody"
                    ? (progress?.pickupComplete
                      ? "La entrega de esta carga quedó registrada."
                      : `La caja ya salió con ${selected.driver_name ?? "el motorizado"}; ${pickupPending} sin confirmar. Se confirman en «Recibir carga».`)
                    : needsRiderCheck(selected.kind) ? "Oficina terminó. Falta que el motorizado reciba cada paquete." : "Oficina terminó. Registra quién recoge para entregar al courier."}</p>
                  {mode === "office" && selected.state !== "in_custody" && needsRiderCheck(selected.kind) && (canPickup ?
                    <OpsButton variant="primary" className="mt-3" onClick={() => { setMode("pickup"); setMessage(null); }}>Continuar a recepción</OpsButton>
                    : <p className="mt-1 font-medium text-ink-900">El motorizado continúa desde su acceso a Reparto.</p>)}
                </Banner>
              ) : mode !== "build" && (
                <>
                  {mode === "pickup" && selected && !progress?.officeComplete && <Banner tone="warn" className="mt-4">Primero completa la verificación de oficina.</Banner>}
                  {/* Con la caja ya en poder del motorizado, confirmar por él es
                      un respaldo: va DEBAJO de la lista, con su propio título,
                      y no como el gesto principal del paso. */}
                  {!(mode === "pickup" && custodyPickupOpen) && scanner(`${manifestId}:${mode}`)}
                </>
              )}
              {message && <Banner tone={message.tone === "error" ? "crit" : "ok"} role={message.tone === "error" ? "alert" : "status"} className="mt-4">{message.text}</Banner>}
              {!cameraOpen && pendingScans > 0 && <p role="status" className="mt-2 text-sm text-ink-600">{pendingScans} lecturas por confirmar. Puedes seguir escaneando.</p>}
              {!cameraOpen && scanIssues.map((text) => <p key={text} role="alert" className="mt-2 text-sm text-red-700">{text}</p>)}
            </div>

            {mode === "build" ? (
              surface === "gf" ? (
                selected
                  ? <GfBoxAddPackages key={selected.id} manifest={selected} canManage={canManage} refresh={refresh} onBusy={setAssignmentBusy} />
                  : <p className="p-5 text-sm text-ink-600">Elige una caja.</p>
              ) : selected ? (
                <BuildRoute
                  // Cambiar de ruta descarta la selección: arrastrarla al
                  // destino nuevo es exactamente el cruce que hay que evitar.
                  key={selected.id}
                  manifest={selected}
                  shipments={data.assignableShipments}
                  storeName={storeName}
                  onAdded={async (result) => { showResult(result); await refresh(selected.id); }}
                />
              ) : (
                <div className="p-12 text-center text-sm text-ink-500">Elige una ruta de la lista o crea una nueva.</div>
              )
            ) : selected ? (
              <>
                <ManifestDetail manifest={selected} mode={mode} canManage={canManage} onChanged={() => refresh(selected.id)} showResult={showResult} />
                {mode === "pickup" && custodyPickupOpen && (
                  <div className="p-4 shadow-[inset_0_1px_0_var(--color-line)] sm:p-5">
                    <p className="text-sm font-semibold text-ink-900">Confirmar por {selected.driver_name ?? "el motorizado"}</p>
                    <p className="mt-0.5 text-[13px] text-ink-600">
                      {pickupPending > 0
                        ? `${pickupPending} paquete${pickupPending === 1 ? "" : "s"} sin confirmar. Si no puede hacerlo desde su teléfono, escanea aquí los que sí lleva; queda registrado con tu usuario.`
                        : "Todos los paquetes están confirmados."}
                    </p>
                    {pickupPending > 0 && scanner(`${manifestId}:${mode}:custodia`)}
                  </div>
                )}
              </>
            ) : (
              <div className="p-12 text-center text-sm text-ink-500">Elige una ruta de la lista o crea una nueva.</div>
            )}
          </section>

      {/* Cámara en serie, como al asignar: queda abierta tras cada lectura y
          debajo dice cuántos van («Verificados 3 de 4 · faltan 1»). Se cierra
          con «Listo» o sola al completar la caja. */}
      <DispatchCamera
        open={cameraOpen}
        onClose={closeCamera}
        onScan={executeScan}
        continuous
        progress={progress ? { done: confirmedCount, total: progress.total, verb: mode === "office" ? "Verificados" : "Recibidos" } : undefined}
        status={message ? { ok: message.tone !== "error", text: message.text } : null}
        pending={pendingScans}
        lastCaptured={lastCaptured}
        issues={scanIssues}
      />
    </div>
  );
}

/**
 * A qué ruta se está trabajando, imposible de confundir.
 *
 * La ruta se elige en una lista lateral que en el celular queda MUY lejos del
 * botón —y debajo, hay que bajar a buscarla—, así que era fácil asignar los
 * paquetes de Roy a la ruta de Yhoni sin notarlo. Este bloque repite el destino
 * pegado a la acción e incluye su propio selector para no depender de la lista.
 */
function RouteTarget({
  mode,
  disabled,
  manifest,
  manifests,
  onSelect,
}: {
  mode: Mode;
  disabled: boolean;
  manifest: DispatchManifest;
  manifests: DispatchManifest[];
  onSelect: (id: string) => void;
}) {
  const rider = needsRiderCheck(manifest.kind);
  const { title, subtitle } = routeHeading(manifest);
  const progress = dispatchProgress(manifest.items);
  const packages = progress.total;
  const officeChecked = progress.officeChecked;
  const officeComplete = progress.officeComplete;
  // El destino elegido lleva el lenguaje de la selección (velo y anillo
  // azul): es lo que no se puede confundir al asignar.
  return (
    <div className="mt-4 rounded-lg bg-brand-50/60 p-3 ring-2 ring-inset ring-brand-600 sm:p-4">
      <p className="text-[13px] font-medium text-ink-600">
        {mode === "build" ? (rider ? "Estás asignando a la ruta de" : "Estás preparando la entrega de") : "Caja seleccionada"}
      </p>
      {/* Quién se lleva la caja y qué día: es lo único que distingue dos rutas
          del mismo día. Debajo, de qué se trata esa ruta. */}
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-base font-semibold text-ink-900">{title}</span>
        <span className="text-[13px] font-medium tabular-nums text-ink-600">
          {routeDayLong(manifest.route_date)}
        </span>
      </div>
      <p className="mt-0.5 text-[13px] text-ink-600">{subtitle}</p>

      {/* Urpi carga los pedidos en SU sistema desde SU Excel. El archivo sale de
          aquí para no volver a escribir a mano lo que ya está en la ruta.
          Exporta lo que la ruta tiene AHORA: si el cotejo retira un paquete,
          Urpi no puede quedarse esperando una caja que no sale. */}
      {courierKey(manifest.courier) === "urpi" && packages > 0 && (
        <div className="mt-3">
          <a href={`/api/despacho/${manifest.id}/urpi`} className={LINK_SECONDARY}>
            Excel para Urpi <Badge className="tabular-nums">{packages} {packages === 1 ? "paquete" : "paquetes"}</Badge>
          </a>
          {!officeComplete && (
            <p className="mt-1.5 text-[13px] text-warn-fg">
              El cotejo de oficina va {officeChecked} de {packages}: el archivo puede cambiar si
              se retira algún paquete.
            </p>
          )}
        </div>
      )}
      {manifests.length > 1 && (
        <details className="group mt-2">
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold text-brand-700 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <IconChevronDown aria-hidden className="size-4 -rotate-90 transition-transform group-open:rotate-0" />
            Cambiar de caja
          </summary>
          <label className="mt-1 block">
            <span className="sr-only">Cambiar de ruta</span>
            <select
              disabled={disabled}
              value={manifest.id}
              onChange={(event) => onSelect(event.target.value)}
              className={cn(FIELD, "sm:max-w-md")}
            >
              {manifests.map((option) => (
                <option key={option.id} value={option.id}>
                  {routeName(option)}{option.courier === "propio" ? ` · Carga ${option.load_number ?? 1}` : ""}
                </option>
              ))}
            </select>
          </label>
        </details>
      )}
    </div>
  );
}

const MODE_TITLES: Record<Mode, string> = {
  build: "Asignar paquetes a la ruta",
  office: "Cotejo de oficina",
  pickup: "Cotejo del motorizado",
};

const MODE_HINTS: Record<Mode, string> = {
  build:
    "Decide aquí qué va con quién, sin escanear. Almacén puede seguir armando: el cotejo verificará después que cada caja entró de verdad.",
  office: "Escanea los paquetes de esta caja. Un paquete de otra ruta no se agrega.",
  pickup: "El propio motorizado escanea cada paquete que recibe. Al llegar al 100 %, la custodia cambia automáticamente.",
};

/** Una cifra del día de la mesa: etiqueta y número, dentro del marco común. */
function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white px-4 py-3">
      <dt className="text-[13px] text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold leading-7 tabular-nums text-ink-900">{value.toLocaleString("es-PE")}</dd>
    </div>
  );
}

function ModeButton({ active, disabled, onClick, number, label }: { active: boolean; disabled: boolean; onClick: () => void; number: string; label: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-md px-2 text-[13px] font-semibold transition-[background-color,color,box-shadow] duration-150",
        active ? "bg-white text-ink-900 shadow-control ring-1 ring-line" : "text-ink-600 hover:text-ink-900",
        disabled && "cursor-not-allowed opacity-40 hover:text-ink-600",
      )}
    >
      <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-xs tabular-nums", active ? "bg-brand-600 text-white" : "bg-line text-ink-600")}>{number}</span>
      {/* En el teléfono basta el verbo: «Agregar», «Verificar», «Recibir». */}
      <span aria-hidden className="truncate sm:hidden">{label.split(" ")[0]}</span>
      <span className="sr-only sm:not-sr-only sm:truncate">{label}</span>
    </button>
  );
}

function ManifestCard({ manifest, active, onClick }: { manifest: DispatchManifest; active: boolean; onClick: () => void }) {
  const progress = dispatchProgress(manifest.items);
  const rider = needsRiderCheck(manifest.kind);
  // Sin segundo cotejo, el avance de la tarjeta es el de oficina: si no, una
  // entrega a Aliclik se veía siempre en 0 % por esperar un escaneo imposible.
  const completed = manifest.state === "in_custody"
    ? progress.total
    : rider ? progress.pickupChecked : progress.officeChecked;
  const percent = manifest.state === "in_custody" ? 100 : progress.total ? Math.round((completed / progress.total) * 100) : 0;
  // El título es QUIÉN se lleva la caja, y cuando no hay una persona concreta
  // —Urpi, Aliclik, una agencia— el courier ES quien se la lleva. Decir
  // "Sin motorizado" no nombraba nada y dejaba la tarjeta sin identidad.
  const { title, subtitle } = routeHeading(manifest);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "w-full rounded-lg bg-white p-3.5 text-left shadow-control transition-shadow",
        active ? "ring-2 ring-inset ring-brand-600" : "ring-1 ring-inset ring-line hover:ring-line-strong",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={cn("min-w-0 truncate text-sm font-semibold", active ? "text-brand-700" : "text-ink-900")}>{title}</p>
        <span className="shrink-0 text-[13px] font-medium tabular-nums text-ink-500">{routeDay(manifest.route_date)}</span>
      </div>
      <p className="mt-0.5 truncate text-[13px] text-ink-500">{subtitle}</p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
        <div className={cn("h-full rounded-full", percent === 100 ? "bg-ok-fg" : "bg-brand-600")} style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Badge tone={STATE_BADGE[manifest.state]}>{DISPATCH_STATE_LABELS[manifest.state]}</Badge>
        <span className="text-xs tabular-nums text-ink-500">{completed}/{progress.total}</span>
      </div>
    </button>
  );
}

/**
 * Asignar paquetes a la ruta sin escanear: el paso 2.
 *
 * Muestra si almacén ya armó cada caja, pero no lo exige — la ruta se planifica
 * antes de que el almacén termine. Lo que sí se marca es el desajuste de
 * courier, porque una salida ya comprometida con otro no puede cambiarse aquí.
 */
function BuildRoute({
  manifest,
  shipments,
  storeName,
  onAdded,
}: {
  manifest: DispatchManifest;
  shipments: DispatchShipment[];
  storeName: Map<string, string>;
  onAdded: (result: DispatchActionResult) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [onlyMatching, setOnlyMatching] = useState(true);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);

  const matches = useCallback(
    (shipment: DispatchShipment) =>
      isCourierTbd(shipment.courier) ||
      courierKey(shipment.courier) === courierKey(manifest.courier),
    [manifest.courier],
  );
  const visible = useMemo(() => {
    const base = onlyMatching ? shipments.filter(matches) : shipments;
    const needle = query.trim().toLowerCase();
    if (!needle) return base;
    // Se busca por lo que la persona tiene a mano: el código del rótulo, el
    // pedido, el cliente o el distrito. Con cientos de paquetes, desplazarse
    // deja de ser una forma de encontrar nada.
    return base.filter((shipment) =>
      [
        shipment.output_code,
        shipment.guide_code,
        shipment.order_name,
        shipment.customer_name,
        shipment.customer_phone,
        shipment.district,
        shipment.province,
      ]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle)),
    );
  }, [shipments, onlyMatching, matches, query]);

  function toggle(id: string) {
    setConfirming(false);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const closed = ["in_custody", "cancelled"].includes(manifest.state);
  const shown = visible.slice(0, 60);
  const allShownPicked = shown.length > 0 && shown.every((s) => picked.has(s.id));

  return (
    <div className="p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink-900">Paquetes sin ruta <span className="font-medium tabular-nums text-ink-500">{visible.length}</span></h3>
        <label className="flex items-center gap-2 text-[13px] text-ink-700">
          <input type="checkbox" checked={onlyMatching} onChange={(e) => setOnlyMatching(e.target.checked)} className={CHECKBOX} />
          Solo los que pueden ir con {courierLabelFor(manifest.courier)}
        </label>
      </div>

      {!closed && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Buscar paquete</span>
            <IconSearch aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por código, pedido, cliente o distrito"
              className={cn(FIELD, "pl-9")}
            />
          </label>
          {shown.length > 0 && (
            <OpsButton
              onClick={() => {
                setConfirming(false);
                setPicked((prev) => {
                  const next = new Set(prev);
                  for (const shipment of shown) {
                    if (allShownPicked) next.delete(shipment.id);
                    else next.add(shipment.id);
                  }
                  return next;
                });
              }}
            >
              {allShownPicked ? "Quitar selección" : `Seleccionar ${shown.length}`}
            </OpsButton>
          )}
        </div>
      )}

      {closed ? (
        <div className="rounded-lg border border-dashed border-line-strong py-10 text-center text-sm text-ink-500">Esta ruta ya está cerrada.</div>
      ) : visible.length ? (
        <>
          <ul className="divide-y divide-line rounded-lg ring-1 ring-line">
            {shown.map((shipment) => (
              <li key={shipment.id}>
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors",
                    picked.has(shipment.id) ? "bg-brand-50/60" : "hover:bg-wash",
                  )}
                >
                  <input type="checkbox" checked={picked.has(shipment.id)} onChange={() => toggle(shipment.id)} className={cn(CHECKBOX, "mt-0.5")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-xs font-semibold text-ink-900">{packageCode(shipment)}</span>
                      <Badge>{isCourierTbd(shipment.courier) ? "Por definir" : courierLabelFor(shipment.courier)}</Badge>
                      <Badge tone={isArmed(shipment) ? "ok" : "warn"}>{isArmed(shipment) ? "Armado en almacén" : "Almacén aún no lo escaneó"}</Badge>
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-ink-700">{shipment.customer_name ?? "Cliente"} · {shipment.district ?? shipment.province ?? "Sin distrito"}</span>
                    <span className="block truncate text-xs tabular-nums text-ink-500">{shipment.order_name} · {storeName.get(shipment.store_id) ?? "Tienda"}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {visible.length > 60 && <p className="mt-2 text-xs text-ink-500">Se muestran 60 de {visible.length}. Afina la búsqueda o asigna estos y vuelve por el resto.</p>}

          {/* Barra pegada al pie: con la lista larga, el destino y el botón se
              quedaban arriba y fuera de vista, que es justo cuando uno asigna a
              la ruta equivocada. */}
          {picked.size > 0 && (
            <div className="sticky bottom-4 z-10 mt-4">
              {confirming ? (
                <div className="rounded-lg bg-white p-4 shadow-pop">
                  <p className="text-sm text-ink-700 sm:text-base">
                    Vas a asignar{" "}
                    <strong className="font-semibold text-ink-900">
                      {picked.size} paquete{picked.size === 1 ? "" : "s"}
                    </strong>{" "}
                    a la ruta de{" "}
                    <strong className="font-semibold text-ink-900">{routeNameLong(manifest)}</strong>.
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <OpsButton
                      variant="primary"
                      size="lg"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        const result = await addShipmentsToManifest(manifest.id, [...picked]);
                        setPicked(new Set());
                        setConfirming(false);
                        await onAdded(result);
                        setBusy(false);
                      }}
                    >
                      {busy ? "Asignando…" : "Sí, asignar"}
                    </OpsButton>
                    <OpsButton size="lg" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                      Cancelar
                    </OpsButton>
                  </div>
                </div>
              ) : (
                <OpsButton variant="primary" size="lg" className="w-full whitespace-normal py-3 text-left sm:text-center" onClick={() => setConfirming(true)}>
                  Asignar {picked.size} paquete{picked.size === 1 ? "" : "s"} a la ruta de{" "}
                  {routeNameLong(manifest)}
                </OpsButton>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-line-strong py-10 text-center text-sm text-ink-500">
          {query.trim()
            ? `Ningún paquete coincide con «${query.trim()}».`
            : `No hay paquetes libres ${onlyMatching ? `para ${courierLabelFor(manifest.courier)}` : ""}.`}
        </div>
      )}
    </div>
  );
}

/** Cierre de una entrega al courier: no hay motorizado, hay quien recoge. */
function HandOverPanel({ manifest, onDone }: { manifest: DispatchManifest; onDone: (r: DispatchActionResult) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const progress = dispatchProgress(manifest.items);
  if (!progress.officeComplete) {
    return (
      <p className="rounded-lg bg-wash px-4 py-3 text-[13px] text-ink-600">
        Completa el cotejo de oficina (<span className="tabular-nums">{progress.officeChecked} de {progress.total}</span>) y anota aquí quién recoge.
      </p>
    );
  }
  return (
    <div className="rounded-lg p-4 ring-1 ring-line">
      <p className="text-sm font-semibold text-ink-900">¿Quién recoge?</p>
      <p className="mt-0.5 text-[13px] text-ink-500">
        Esta ruta no tiene motorizado que coteje. El nombre de quien se lleva las cajas es la única prueba de la entrega.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre y DNI de quien recoge" aria-label="Nombre y DNI de quien recoge" className={cn(FIELD, "flex-1")} />
        <OpsButton
          variant="primary"
          disabled={busy || name.trim().length < 3}
          onClick={async () => { setBusy(true); await onDone(await handOverToCourier(manifest.id, name)); setBusy(false); }}
        >
          {busy ? "Cerrando…" : "Entregar al courier"}
        </OpsButton>
      </div>
    </div>
  );
}

function ManifestDetail({ manifest, mode, canManage, onChanged, showResult }: { manifest: DispatchManifest; mode: Mode; canManage: boolean; onChanged: () => Promise<void>; showResult: (r: DispatchActionResult) => void }) {
  const [query, setQuery] = useState("");
  const active = activeDispatchItems(manifest.items);
  const removed = manifest.items.filter((item) => !!item.removed_at);
  const progress = dispatchProgress(manifest.items);
  const checked = mode === "office" ? progress.officeChecked : progress.pickupChecked;
  // Una ruta de cien paquetes no se revisa desplazándose. El buscador sirve
  // sobre todo para el final del cotejo: encontrar los pocos que faltan.
  const needle = query.trim().toLowerCase();
  const shownItems = needle
    ? active.filter((item) =>
        [
          item.shipment?.output_code,
          item.shipment?.guide_code,
          item.shipment?.order_name,
          item.shipment?.customer_name,
          item.shipment?.district,
          item.shipment?.province,
        ]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle)),
      )
    : active;
  return <OpsManifestDetail manifest={manifest} mode={mode} canManage={canManage} onChanged={onChanged} showResult={showResult} active={active} removed={removed} checked={checked} total={progress.total} query={query} setQuery={setQuery} shownItems={shownItems} needle={needle} />;
}

/**
 * El contenido de la caja (mesa y panel de Rutas): una barra de avance, una lista
 * con hairlines (no una tarjeta por paquete) y las correcciones plegadas.
 */
function OpsManifestDetail({ manifest, mode, canManage, onChanged, showResult, active, removed, checked, total, query, setQuery, shownItems, needle }: {
  manifest: DispatchManifest;
  mode: Mode;
  canManage: boolean;
  onChanged: () => Promise<void>;
  showResult: (r: DispatchActionResult) => void;
  active: DispatchManifestItem[];
  removed: DispatchManifestItem[];
  checked: number;
  total: number;
  query: string;
  setQuery: (value: string) => void;
  shownItems: DispatchManifestItem[];
  needle: string;
}) {
  const pct = total ? Math.round((checked / total) * 100) : 0;
  const label = mode === "office" ? "Cotejo de oficina" : "Recepción del motorizado";
  return <div className="space-y-4 p-4 sm:p-5">
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium text-ink-700">{mode === "office" ? "Paquetes verificados" : "Paquetes recibidos"}</span>
        <span className="font-semibold tabular-nums text-ink-900">{checked} de {total}</span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={checked} className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
        <div className={cn("h-full rounded-full transition-[width] duration-300", checked === total && total > 0 ? "bg-ok-fg" : "bg-brand-600")} style={{ width: `${pct}%` }} />
      </div>
    </div>
    {!needsRiderCheck(manifest.kind) && manifest.state !== "in_custody" && canManage && <HandOverPanel manifest={manifest} onDone={async (r) => { showResult(r); await onChanged(); }} />}
    {active.length > 8 && <label className="block text-[13px] font-medium text-ink-700">
      Buscar en esta caja
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Código, cliente o distrito" className={cn(FIELD, "mt-1")} />
    </label>}
    {shownItems.length
      ? <ul className="divide-y divide-line rounded-lg ring-1 ring-line">{shownItems.map((item) =>
          <OpsPackageRow key={item.id} item={item} mode={mode} canRemove={false} onRemoved={async () => {}} />)}</ul>
      : <p className="py-4 text-sm text-ink-600">{needle ? `Ningún paquete coincide con «${query.trim()}».` : "Aún no hay paquetes asignados. Agrégalos antes de verificar esta caja."}</p>}
    {removed.length > 0 && <details className="group">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold text-ink-700 hover:text-ink-900 [&::-webkit-details-marker]:hidden">
        <IconChevronDown aria-hidden className="size-4 -rotate-90 text-ink-500 transition-transform group-open:rotate-0" />
        Paquetes retirados <span className="font-medium tabular-nums text-ink-500">{removed.length}</span>
      </summary>
      <ul className="mt-1 space-y-1 pl-5.5">{removed.map((item) => <li key={item.id} className="text-[13px] text-ink-600"><span className="font-mono text-xs font-medium text-ink-900">{packageCode(item.shipment)}</span> · {item.removal_reason}</li>)}</ul>
    </details>}
    {canManage && !["in_custody", "cancelled"].includes(manifest.state) && <details className="group">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold text-ink-700 hover:text-ink-900 [&::-webkit-details-marker]:hidden">
        <IconChevronDown aria-hidden className="size-4 -rotate-90 text-ink-500 transition-transform group-open:rotate-0" />
        Corregir contenido de la caja
      </summary>
      <p className="mb-3 mt-1 text-[13px] text-ink-600">Retirar un paquete o cancelar requiere un motivo y queda en el historial.</p>
      <ul className="divide-y divide-line rounded-lg ring-1 ring-line">{active.map((item) => <OpsPackageRow key={item.id} item={item} mode={mode} canRemove onRemoved={async (reason) => { showResult(await removeManifestItem(manifest.id, item.shipment_id, reason)); await onChanged(); }} />)}</ul>
      <OpsButton variant="danger" className="mt-3" onClick={async () => { const reason = window.prompt("Motivo de cancelación de la ruta"); if (!reason) return; showResult(await cancelDispatchManifest(manifest.id, reason)); await onChanged(); }}>Cancelar esta ruta</OpsButton>
    </details>}
  </div>;
}

/** Un paquete de la caja: verificado con el check verde, pendiente con el hueco discontinuo. */
function OpsPackageRow({ item, mode, canRemove, onRemoved }: { item: DispatchManifestItem; mode: Mode; canRemove: boolean; onRemoved: (reason: string) => Promise<void> }) {
  const checked = mode === "office" ? item.office_checked_at : item.pickup_checked_at;
  const [removing, setRemoving] = useState(false);
  return <li className="flex items-center gap-3 px-3 py-2.5">
    {checked
      ? <IconCheckCircle role="img" aria-label="Verificado" className="size-5 shrink-0 text-ok-fg" />
      : <span role="img" aria-label="Pendiente" className="size-5 shrink-0 rounded-full border-[1.5px] border-dashed border-ink-300" />}
    <div className="min-w-0 flex-1">
      <p className="truncate font-mono text-xs font-medium text-ink-900">{packageCode(item.shipment)}</p>
      <p className="truncate text-[13px] leading-5 text-ink-600">{item.shipment?.customer_name ?? "Cliente"} · {item.shipment?.district ?? item.shipment?.province ?? "Sin distrito"}</p>
    </div>
    {canRemove && <OpsButton variant="danger" size="sm" disabled={removing} onClick={async () => { const reason = window.prompt("¿Por qué se retira este paquete de la ruta?"); if (!reason) return; setRemoving(true); try { await onRemoved(reason); } finally { setRemoving(false); } }}>{removing ? "Retirando…" : "Retirar"}</OpsButton>}
  </li>;
}

function CreateManifestModal({ riders, onClose, onCreated }: { riders: DispatchRider[]; onClose: () => void; onCreated: (result: DispatchActionResult) => void }) {
  const [selection, setSelection] = useState("");
  const [routeDate, setRouteDate] = useState(todayLima());
  const [busy, setBusy] = useState(false);

  const { couriers } = useMemo(() => routeChoices(riders), [riders]);
  const choice = useMemo(() => routeChoiceByValue(riders, selection), [riders, selection]);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-ink-900/30 p-0 sm:items-center sm:p-6" onClick={() => { if (!busy) onClose(); }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="nueva-ruta-titulo"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape" && !busy) onClose(); }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!choice) return;
          setBusy(true);
          onCreated(
            await createDispatchManifest({
              courier: choice.courier,
              routeDate,
              riderId: choice.riderId ?? undefined,
            }),
          );
          setBusy(false);
        }}
        className="w-full rounded-t-lg bg-white p-5 shadow-pop sm:max-w-lg sm:rounded-lg sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="nueva-ruta-titulo" className="text-lg font-semibold leading-7 text-ink-900">Nueva ruta</h2>
            <p className="mt-0.5 text-[13px] text-ink-500">Una entrega diaria por courier. Los motorizados de Grupo GF se organizan en su módulo.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Cerrar" className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 disabled:opacity-50">
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="mt-5 grid gap-4">
          {/* Un solo desplegable: los motorizados propios agrupados bajo su
              cabecera y, debajo, los couriers. Elegir dos veces —courier y
              luego motorizado— era decir una sola cosa en dos pasos. */}
          <Field label="Sale con">
            <select
              required
              autoFocus
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
              className={FIELD}
            >
              <option value="">Elige con quién sale</option>
              <optgroup label="Couriers">
                {couriers.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label="Fecha de la ruta">
            <input required type="date" value={routeDate} onChange={(e) => setRouteDate(e.target.value)} className={FIELD} />
          </Field>
        </div>
        {choice && (
          <Banner tone="info" className="mt-4">
            {needsRiderCheck(routeKindForCourier(choice.courier))
              ? "Ruta de reparto: la cierra el cotejo del motorizado, escaneando lo que recibe."
              : "Entrega al courier: no hay motorizado que coteje, así que se cierra anotando quién recoge las cajas."}
          </Banner>
        )}
        <OpsButton type="submit" variant="primary" size="lg" disabled={busy || !choice} className="mt-6 w-full">
          {busy ? "Creando…" : "Crear ruta"}
        </OpsButton>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[13px] font-medium text-ink-700">{label}</span>{children}</label>;
}
