"use client";

// Paso 1 «Agregar pedidos» de la caja de Grupo GF, dentro del panel (MOM
// §29.14): el mismo gesto de Despacho del día acotado a ESTA caja. Cada
// escaneo toma el pedido si hace falta, lo mete en la caja de este motorizado
// y este día, sin cotejarlo (`scanAssignToRider`: la verificación es aparte); con 0187 también
// readmite un paquete que el motorizado rechazó. No hay motorizado que
// elegir: la caja ya es de uno. Antes aquí solo había un enlace a otra
// página.

import { useEffect, useEffectEvent, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { ScanAction } from "@/components/scan-action";
import { moveManifestItem, scanAssignToRider, type ScanAssignLine } from "@/app/dashboard/courier/actions";
import { programDayLabel } from "@/lib/dispatch-day";
import type { DispatchManifest } from "@/lib/dispatch-access";

function money(value: number): string {
  return `S/ ${value.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Arreglo de una fila con aviso («Mover», «Asignar igual», «Autorizar»): botón secundario pequeño. */
const AMEND = "inline-flex h-7 shrink-0 items-center rounded-md bg-white px-2 text-xs font-semibold text-ink-700 shadow-control ring-1 ring-inset ring-line-strong hover:bg-wash hover:text-ink-900 disabled:opacity-50";

function presentation(l: ScanAssignLine, riderName: string): { text: string; textClass: string; rowClass: string } {
  switch (l.status) {
    case "procesando":
      return { text: "Asignando…", textClass: "text-ink-500", rowClass: "bg-wash" };
    case "asignado":
      return { text: `En la caja de ${l.riderName ?? riderName}`, textClass: "text-ok-fg", rowClass: "bg-ok-wash" };
    case "ya_en_caja":
      return { text: "Ya estaba", textClass: "text-warn-fg", rowClass: "bg-warn-wash" };
    case "en_otra_caja":
      return { text: `En la caja de ${l.riderName ?? "otro"} → Mover`, textClass: "text-warn-fg", rowClass: "bg-warn-wash" };
    case "bloqueado_efectivo":
      return { text: "Límite de efectivo → Autorizar", textClass: "text-warn-fg", rowClass: "bg-warn-wash" };
    case "programado_otro_dia":
      return { text: `Programado ${l.programmedFor ? programDayLabel(l.programmedFor) : "otro día"} → Asignar igual`, textClass: "text-warn-fg", rowClass: "bg-warn-wash" };
    case "no_elegible":
      return { text: l.message ? `No elegible: ${l.message.replace(/\.$/, "")}` : "No elegible", textClass: "text-crit-fg", rowClass: "bg-crit-wash" };
    default:
      return { text: "QR desconocido", textClass: "text-crit-fg", rowClass: "bg-crit-wash" };
  }
}

export function GfBoxAddPackages({ manifest, canManage, refresh, onBusy }: {
  manifest: DispatchManifest;
  canManage: boolean;
  refresh: (preferId?: string | null) => Promise<void>;
  onBusy?: (busy: boolean) => void;
}) {
  const [lines, setLines] = useState<ScanAssignLine[]>([]);
  const [overrideCash, setOverrideCash] = useState(false);
  const [pending, start] = useTransition();
  const [pendingScans, setPendingScans] = useState(0);
  const [confirmedIds, setConfirmedIds] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [refreshedRevision, setRefreshedRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const busy = pending || pendingScans > 0;
  const unsettled = busy || revision > refreshedRevision;
  useEffect(() => { onBusy?.(unsettled); }, [unsettled, onBusy]);
  const refreshBox = useEffectEvent(async (savedRevision: number) => {
    setRefreshing(true);
    try { await refresh(manifest.id); setRefreshError(null); }
    catch { setRefreshError("Los pedidos se guardaron, pero no se pudo actualizar la caja. Vuelve a abrirla para actualizarla."); }
    finally { setRefreshedRevision(savedRevision); setRefreshing(false); }
  });
  useEffect(() => {
    // Una pausa entre paquetes no termina la tanda de cámara. La recarga
    // completa espera a «Listo» y a que respondan todas las lecturas.
    if (busy || cameraOpen || refreshing || revision === refreshedRevision) return;
    const timer = window.setTimeout(() => {
      void refreshBox(revision);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [busy, cameraOpen, refreshing, revision, refreshedRevision]);
  const riderName = manifest.driver_name ?? "el motorizado";
  const riderId = manifest.rider_id ?? null;

  if (!canManage) return <p className="p-5 text-sm text-ink-600">Tu rol no organiza rutas: puedes mirar, no agregar.</p>;
  if (!riderId) return <p className="p-5 text-sm text-ink-600">Esta caja no tiene motorizado asignado; se agrega desde Despacho del día.</p>;
  if (manifest.state === "cancelled") return <p className="p-5 text-sm text-ink-600">Esta caja está cancelada.</p>;

  const push = (line: ScanAssignLine) => {
    setLines((cur) => [line, ...cur.filter((l) => l.code !== line.code)].slice(0, 30));
    if (line.status === "asignado" || line.status === "ya_en_caja") {
      const id = line.shipmentId ?? line.orderId ?? line.code;
      setConfirmedIds((current) => current.includes(id) ? current : [...current, id]);
      setRevision((current) => current + 1);
    }
  };

  return (
    <div className="space-y-3 p-4 sm:p-5">
      <ScanAction
        context="supervisor_asignacion"
        compact
        continuous
        look="ops"
        disabled={pending}
        assign={{ orgId: manifest.org_id, riderId, scheduledFor: manifest.route_date, overrideCash }}
        progress={{ done: confirmedIds.length, label: `${confirmedIds.length} confirmados en esta tanda` }}
        onPendingCountChange={setPendingScans}
        onCameraOpenChange={setCameraOpen}
        onPending={(code) => push({ code, status: "procesando", orderId: null, orderName: null, shipmentId: null, manifestId: manifest.id, riderName, amount: null, message: "Asignando…" })}
        onResult={(r) => { if (r.line) push(r.line); }}
      />
      <p className="text-[13px] text-ink-500">Cada escaneo toma el pedido y lo pone en esta caja. Después se verifica en «Verificar caja».</p>
      {refreshError && <p role="alert" className="text-sm text-crit-fg">{refreshError}</p>}
      {lines.length > 0 && (
        <ul className="max-h-72 divide-y divide-line overflow-auto rounded-lg ring-1 ring-line" aria-live="polite">
          {lines.map((l, i) => {
            const r = presentation(l, riderName);
            return (
              <li key={`${l.code}:${i}`} className={cn("flex items-center gap-2 px-3 py-2 text-sm", r.rowClass)} title={[l.message, l.cashWarning].filter(Boolean).join(" · ")}>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold text-ink-900">{l.orderName ?? l.code}</span>
                  <span className={cn("ml-2 text-xs font-medium", r.textClass)}>{r.text}</span>
                </span>
                {l.amount != null && <span className="shrink-0 text-xs tabular-nums text-ink-600">{money(l.amount)}</span>}
                {l.status === "en_otra_caja" && l.manifestId && l.shipmentId && (
                  <button type="button" disabled={busy} onClick={() => start(async () => {
                    const res = await moveManifestItem(manifest.org_id, l.manifestId!, l.shipmentId!, riderId, `Escaneado en la caja de ${riderName}`);
                    push({ ...l, status: res.error ? "no_elegible" : "asignado", riderName, message: res.error ?? "" });
                  })} className={AMEND}>Mover</button>
                )}
                {l.status === "programado_otro_dia" && (
                  <button type="button" disabled={busy} onClick={() => start(async () => {
                    push(await scanAssignToRider(manifest.org_id, riderId, l.code, { overrideCash, scheduledFor: manifest.route_date, confirmProgrammed: true }));
                  })} title={l.message} className={AMEND}>Asignar igual</button>
                )}
                {l.status === "bloqueado_efectivo" && !overrideCash && (
                  <button type="button" onClick={() => setOverrideCash(true)} title="Autoriza superar el límite de efectivo de la ruta y vuelve a escanear" className={AMEND}>Autorizar</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {overrideCash && <p className="text-[13px] text-warn-fg">Límite de efectivo autorizado para esta caja.</p>}
    </div>
  );
}
