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

import { useRef, useState } from "react";
import { DispatchScanner } from "@/components/dispatch-scanner";
import { PhotoCapture } from "@/components/photo-capture";
import { DispatchCamera } from "@/components/dispatch-camera";
import { scanActionPlan, type ScanContext } from "@/lib/scan-action";
import { lookupDispatchShipment, removeManifestItem, scanManifestItem } from "@/app/dashboard/pedidos/despacho/actions";
import { confirmMyGfPickup, receiveMyGfPackage } from "@/app/reparto/receive";
import { scanAssignToRider, type ScanAssignLine } from "@/app/dashboard/courier/actions";
import type { ScanProgress } from "@/lib/scan-progress";

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

export function ScanAction({ context, manifestId, itemId, stopId, photoKind = "entrega", photoPath = null, label, disabled = false, onResult, assign, onQueue, onPending, compact = false, continuous = false, progress, look = "default" }: Props) {
  const plan = scanActionPlan(context);
  const [busy, setBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  // Última lectura, para decirla dentro de la cámara sin cerrarla.
  const [lastRead, setLastRead] = useState<{ ok: boolean; text: string } | null>(null);
  const report = (r: ScanActionResult) => {
    if (continuous) setLastRead(r.error ? { ok: false, text: r.error } : r.notice ? { ok: true, text: `✓ ${r.notice}` } : null);
    onResult(r);
  };
  const inFlight = useRef(false);

  // Asignar por QR no descarta lecturas: cada QR entra a una cola, se anuncia
  // al instante (`onPending`) y se procesa en orden. Antes, mientras el
  // servidor respondía (varios segundos), los QR siguientes se perdían.
  const assignQueue = useRef<string[]>([]);
  const draining = useRef(false);
  async function drainAssign() {
    if (draining.current) return;
    draining.current = true;
    try {
      while (assignQueue.current.length) {
        const code = assignQueue.current[0]!;
        try {
          const line = await scanAssignToRider(assign!.orgId, assign!.riderId, code, { overrideCash: assign!.overrideCash, scheduledFor: assign!.scheduledFor ?? null });
          report({ line, notice: line.message, error: lineNeedsAttention(line) ? line.message : undefined });
        } catch {
          report({
            line: { code, status: "no_elegible", orderId: null, orderName: null, shipmentId: null, manifestId: null, riderName: null, amount: null, message: "No se pudo registrar. Reintenta el mismo código; no se duplicará." },
            error: "No se pudo registrar. Reintenta el mismo código; no se duplicará.",
          });
        } finally {
          assignQueue.current.shift();
        }
      }
    } finally {
      draining.current = false;
    }
  }

  async function execute(code: string) {
    if (context === "supervisor_asignacion" && assign?.riderId && code.trim()) {
      const clean = code.trim();
      if (assignQueue.current.some((c) => c.toLowerCase() === clean.toLowerCase())) return;
      assignQueue.current.push(clean);
      onPending?.(clean);
      void drainAssign();
      return;
    }
    if (inFlight.current || !code.trim()) return;
    inFlight.current = true;
    setBusy(true);
    try {
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
          if (onQueue) onQueue(code);
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
    } catch {
      report({ error: "No se pudo registrar. Reintenta el mismo código; no se duplicará." });
    } finally {
      inFlight.current = false;
      setBusy(false);
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
      <DispatchScanner busy={busy} disabled={disabled} onScan={(code) => void execute(code)} onCamera={() => setCameraOpen(true)} compact={compact} buttonLabel={compact ? (label ?? "Escanear") : undefined} hint={plan.hint} look={look} />
      <DispatchCamera
        open={cameraOpen}
        onClose={() => { setCameraOpen(false); setLastRead(null); }}
        onScan={(value) => void execute(value)}
        continuous={continuous}
        progress={progress}
        status={lastRead}
      />
    </div>
  );
}
