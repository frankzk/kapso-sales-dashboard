"use client";

// El gesto único (MOM §29.13): un solo componente para escanear o fotografiar,
// que decide qué acción de servidor llama y qué evento deja según `context`.
// La pantalla elige el contexto; el usuario solo hace el gesto.
//
//   oficina_cotejo        → scanManifestItem(…, "office")   → office_checked
//   motorizado_recepcion  → receiveMyGfPackage(…) con caja   → pickup_checked
//                           confirmMyGfPickup(…) sin caja    → pickup_checked («Lo llevo», 0185)
//   motorizado_entrega    → PhotoCapture → /api/reparto/foto → evidencia de la parada
//   supervisor_retiro     → lookup + removeManifestItem(…)  → package_removed

import { useEffect, useEffectEvent, useState } from "react";
import { DispatchScanner } from "@/components/dispatch-scanner";
import { PhotoCapture } from "@/components/photo-capture";
import { DispatchCamera } from "@/components/dispatch-camera";
import { scanActionPlan, type ScanContext } from "@/lib/scan-action";
import { lookupDispatchShipment, removeManifestItem, scanManifestItem } from "@/app/dashboard/pedidos/despacho/actions";
import { confirmMyGfPickup, receiveMyGfPackage } from "@/app/reparto/receive";
import { scanAssignToRider, type ScanAssignLine } from "@/app/dashboard/courier/actions";
import type { ScanProgress } from "@/lib/scan-progress";
import { createScanQueue } from "@/lib/scan-queue";

export interface ScanActionResult {
  error?: string;
  notice?: string;
  /** Solo en `motorizado_entrega`: la ruta de la foto ya subida. */
  path?: string;
  /** Solo en `supervisor_asignacion`: la línea con el resultado del QR. */
  line?: ScanAssignLine;
}

interface Props {
  context: ScanContext;
  /** Caja sobre la que se coteja, recibe o retira. */
  manifestId?: string;
  /** Solo en `motorizado_recepcion` sin caja: el ítem que se confirma («Lo llevo»). */
  itemId?: string | null;
  /** Parada a la que pertenece la foto. */
  stopId?: string;
  /** `entrega` (foto de la entrega) o `yape` (captura del pago). */
  photoKind?: "entrega" | "yape";
  /** Ruta actual de la foto, para mostrar «lista» y permitir cambiarla. */
  photoPath?: string | null;
  label?: string;
  disabled?: boolean;
  onResult: (result: ScanActionResult) => void;
  /** Solo en `supervisor_asignacion`. */
  assign?: { orgId: string; riderId: string; scheduledFor?: string | null; overrideCash?: boolean };
  /** Sin motorizado elegido, el QR se acumula en una bandeja en vez de ejecutarse. */
  onQueue?: (code: string) => void;
  /** Solo en `supervisor_asignacion`: el QR se leyó; su resultado llega después por `onResult`. */
  onPending?: (code: string) => void;
  /** Incluye la lectura en curso y las que esperan; permite refrescar al vaciar la cola. */
  onPendingCountChange?: (count: number) => void;
  onCameraOpenChange?: (open: boolean) => void;
  /** Primera vista mínima: sin párrafo de ayuda (va al `title` del botón), campo siempre visible. */
  compact?: boolean;
  /** La cámara sigue abierta tras cada lectura (QR en serie) y enseña `progress`. */
  continuous?: boolean;
  progress?: ScanProgress;
  /** «ops»: el mundo de operación de Despacho del día. */
  look?: "default" | "ops";
}

/**
 * Lo que no entró en la caja se dice como error (rojo y pitido en la cámara);
 * «programado para otro día» también: espera que alguien confirme.
 */
function lineNeedsAttention(line: ScanAssignLine): boolean {
  return ["desconocido", "no_elegible", "bloqueado_efectivo", "programado_otro_dia"].includes(line.status);
}

export function ScanAction({ context, manifestId, itemId, stopId, photoKind = "entrega", photoPath = null, label, disabled = false, onResult, assign, onQueue, onPending, onPendingCountChange, onCameraOpenChange, compact = false, continuous = false, progress, look = "default" }: Props) {
  const plan = scanActionPlan(context);
  const [pending, setPending] = useState(0);
  const reportPendingCount = useEffectEvent((count: number) => onPendingCountChange?.(count));
  useEffect(() => { reportPendingCount(pending); }, [pending]);
  const [scanQueue] = useState(() => createScanQueue(setPending));
  const [lastCaptured, setLastCaptured] = useState<{ scope: string; code: string } | null>(null);
  const [failedReads, setFailedReads] = useState<Record<string, string>>({});
  const scanScope = JSON.stringify([context, manifestId, itemId, assign]);
  const scanIssues = Object.entries(failedReads).filter(([key]) => key.startsWith(`${scanScope}:`)).map(([, text]) => text);
  const busy = pending > 0;
  const [cameraOpen, setCameraOpen] = useState(false);
  const reportCameraOpen = useEffectEvent((open: boolean) => onCameraOpenChange?.(open));
  useEffect(() => { reportCameraOpen(cameraOpen); }, [cameraOpen]);
  // Última lectura, para decirla dentro de la cámara sin cerrarla.
  const [lastRead, setLastRead] = useState<{ scope: string; result: { ok: boolean; text: string } } | null>(null);
  const reportResult = (r: ScanActionResult, code: string) => {
    setFailedReads((current) => {
      const next = { ...current };
      const key = `${scanScope}:${code.toLowerCase()}`;
      if (r.error) next[key] = `${code}: ${r.error}`;
      else delete next[key];
      return next;
    });
    if (continuous) setLastRead(r.error ? { scope: scanScope, result: { ok: false, text: r.error } } : r.notice ? { scope: scanScope, result: { ok: true, text: `✓ ${r.notice}` } } : null);
    onResult(r);
  };
  function execute(raw: string) {
    const code = raw.trim();
    if (!code || disabled) return;
    // Capture context and target in this job, rather than borrowing the target
    // from the first request while another QR waits for its turn.
    const accepted = scanQueue.enqueue({
      key: `${scanScope}:${code.toLowerCase()}`,
      run: () => processScan(code),
      onError: () => {
        const error = "No se pudo confirmar. Reintenta el mismo código; no se duplicará.";
        reportResult({ error, ...(context === "supervisor_asignacion" && assign?.riderId ? {
          line: { code, status: "no_elegible" as const, orderId: null, orderName: null, shipmentId: null, manifestId: null, riderName: null, amount: null, message: error },
        } : {}) }, code);
      },
    });
    if (accepted) {
      setLastCaptured({ scope: scanScope, code });
      if (context === "supervisor_asignacion" && assign?.riderId) onPending?.(code);
    }
  }

  async function processScan(code: string) {
    const report = (result: ScanActionResult) => reportResult(result, code);
    if (context === "oficina_cotejo") {
      if (!manifestId) return report({ error: "Falta la caja." });
      const r = await scanManifestItem(manifestId, code, "office");
      report({ error: r.error, notice: r.notice });
    } else if (context === "motorizado_recepcion") {
      // Con caja: «Recibir mi caja» (modo exigir). Sin caja: «Lo llevo» sobre
      // la ruta ya en custodia (modo confirmar), acotado al ítem si se dio.
      if (manifestId) report(await receiveMyGfPackage(manifestId, code));
      else report(await confirmMyGfPickup({ itemId: itemId ?? null, code }));
    } else if (context === "supervisor_asignacion") {
      if (!assign?.riderId) {
        if (onQueue) { onQueue(code); report({ notice: `${code} guardado en la bandeja. Elige motorizado para asignarlo.` }); }
        else report({ error: "Elige un motorizado antes de escanear." });
        return;
      }
      const line = await scanAssignToRider(assign.orgId, assign.riderId, code, { overrideCash: assign.overrideCash, scheduledFor: assign.scheduledFor ?? null });
      report({ line, notice: line.message, error: lineNeedsAttention(line) ? line.message : undefined });
    } else if (context === "supervisor_retiro") {
      if (!manifestId) return report({ error: "Falta la caja." });
      const found = await lookupDispatchShipment(code);
      if (found.error || !found.shipment) return report({ error: found.error ?? "Paquete no encontrado." });
      const reason = window.prompt(`¿Por qué se retira ${found.shipment.order_name ?? found.shipment.guide_code} de la caja?`);
      if (!reason) return report({});
      const r = await removeManifestItem(manifestId, found.shipment.id, reason);
      report({ error: r.error, notice: r.notice });
    }
  }

  // La foto (entrega, Yape, rechazo) es su propio campo: cámara dentro de la
  // página, galería y foto reducida antes de subir (30-09-2026).
  if (plan.gesture === "photo") {
    return (
      <PhotoCapture
        stopId={stopId}
        kind={photoKind}
        label={label ?? plan.label}
        photoPath={photoPath}
        disabled={disabled}
        onResult={onResult}
      />
    );
  }

  return (
    <div>
      {!compact && <p className="mt-3 text-xs text-slate-500">{plan.hint}</p>}
      <DispatchScanner busy={busy && !continuous} disabled={disabled} onScan={execute} onCamera={() => setCameraOpen(true)} compact={compact} buttonLabel={compact ? (label ?? "Escanear") : undefined} hint={plan.hint} look={look} />
      {!cameraOpen && pending > 0 && <p role="status" className="mt-2 text-sm text-slate-600">{pending} lecturas por confirmar. Puedes seguir escaneando.</p>}
      {!cameraOpen && scanIssues.map((text) => <p key={text} role="alert" className="mt-2 text-sm text-red-700">{text}</p>)}
      <DispatchCamera
        open={cameraOpen}
        onClose={() => { setCameraOpen(false); setLastRead(null); }}
        onScan={(value) => void execute(value)}
        continuous={continuous}
        progress={progress}
        status={lastRead?.scope === scanScope ? lastRead.result : null}
        pending={pending}
        lastCaptured={lastCaptured?.scope === scanScope ? lastCaptured.code : null}
        issues={scanIssues}
      />
    </div>
  );
}
