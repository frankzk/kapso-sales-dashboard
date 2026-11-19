"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { cameraErrorMessage } from "@/lib/camera-error";
import { CameraSessionError, startDispatchCamera } from "@/lib/dispatch-camera-session";
import { scanFeedbackVibration, scanProgressDone, scanProgressText, type ScanProgress, type ScanStatusTone } from "@/lib/scan-progress";
import { playScanNotes, primeScanSound, scanResultNotes, SCAN_READ_NOTES } from "@/lib/scan-sound";
import { readScanVoicePref, scanVerdictWord, scanVoiceText, speakScan, writeScanVoicePref } from "@/lib/scan-voice";
import { cn } from "@/components/ui";

/** Un mismo QR leído dos veces seguidas en menos de esto se ignora. */
const REPEAT_MS = 2500;
/** Con todo confirmado, la cámara se cierra sola tras este tiempo. */
const AUTO_CLOSE_MS = 1000;
/** Lo que dura el resultado grande encima del visor. */
const VERDICT_MS = 2200;

/**
 * El resultado grande encima del visor y el color del marco (19-11-2026: «mi
 * tía escanea y no logra ver bien»): se ve donde se está mirando el QR, sin
 * leer el aviso de arriba.
 */
const VERDICT_CLASS: Record<ScanStatusTone, { badge: string; frame: string }> = {
  ok: { badge: "bg-emerald-600 text-white", frame: "border-emerald-400" },
  warn: { badge: "bg-amber-400 text-amber-950", frame: "border-amber-300" },
  neutral: { badge: "bg-slate-700 text-white", frame: "border-white/90" },
  crit: { badge: "bg-red-600 text-white", frame: "border-red-500" },
};

/** `status.tone` explícito (05-11-2026); sin él, el color de siempre por `ok` / `warn`. */
const STATUS_TONE_CLASS: Record<ScanStatusTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  neutral: "border-slate-200 bg-slate-50 text-slate-800",
  crit: "border-red-200 bg-red-50 text-red-800",
};

const EXTRA_LINE_TONE: Record<"ok" | "warn" | "neutral", string> = {
  ok: "text-emerald-800",
  warn: "text-amber-900",
  neutral: "text-slate-600",
};

export function DispatchCamera({
  open,
  onClose,
  onScan,
  continuous = false,
  progress,
  status,
  statusAction = null,
  pending = 0,
  lastCaptured,
  issues = [],
  title = "Escanear QR",
  hint,
  extraLines,
  feedback = null,
  bigVerdict = false,
}: {
  open: boolean;
  onClose: () => void;
  onScan: (value: string) => void;
  /**
   * Escaneo continuo: tras cada lectura la cámara sigue abierta leyendo el
   * siguiente paquete; se cierra con «Listo» o sola cuando `progress` llega
   * al total. Sin esto, la primera lectura cierra la cámara (comportamiento
   * de siempre).
   */
  continuous?: boolean;
  /** Avance bajo el visor: «Confirmados X de N · faltan Y». */
  progress?: ScanProgress;
  /**
   * Última lectura: qué pasó con el código anterior, sin cerrar la cámara.
   * `warn`: se puede resolver aquí mismo con `statusAction` (ámbar).
   */
  status?: {
    ok: boolean;
    text: string;
    warn?: boolean;
    /** Color explícito (Devoluciones: nueva, repetida, aviso, error); manda sobre `ok` / `warn`. */
    tone?: ScanStatusTone;
    /** Debajo del texto, más pequeño: el aviso completo del servidor. */
    detail?: string | null;
  } | null;
  /**
   * Arreglo de la última lectura dentro del aviso, sin cerrar la cámara:
   * «Mover a esta caja» un paquete que está en la caja de otro (26-10-2026).
   */
  statusAction?: { label: string; busy?: boolean; busyLabel?: string; onClick: () => void } | null;
  /** Read locally, but not yet confirmed by the server. */
  pending?: number;
  lastCaptured?: string | null;
  /** Failed saves remain visible even if a later package succeeds. */
  issues?: string[];
  /** Qué se está haciendo y con qué caja: «Verificar caja · Roy». */
  title?: string;
  /** Debajo del título; sin él, cómo apuntar. */
  hint?: string;
  /**
   * Líneas bajo el avance, más pequeñas (Devoluciones, 05-11-2026: «Grupo GF: …»
   * y «Tanders y Shalom (pendientes históricos): …»). No cuentan para el cierre
   * automático: ese solo lo decide `progress` con su total.
   */
  extraLines?: readonly { text: string; tone?: "ok" | "warn" | "neutral" }[];
  /**
   * El resultado de la última lectura para vibrar distinto (repetida, error).
   * `key` cambia una vez por resultado: así no vuelve a vibrar en cada render.
   */
  feedback?: { key: string | number; tone: ScanStatusTone } | null;
  /**
   * Devoluciones (19-11-2026): con cada resultado, la palabra grande
   * («RECIBIDA», «REPETIDA», «ERROR») encima del visor, el marco de su color y,
   * con «Voz» prendida, el teléfono la dice en voz alta (`lib/scan-voice.ts`).
   */
  bigVerdict?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Parent callbacks change after every scan; they must not reopen the camera.
  const scanLatest = useEffectEvent((value: string) => onScan(value));
  const closeLatest = useEffectEvent(() => onClose());
  const finished = Boolean(continuous && pending === 0 && issues.length === 0 && progress && scanProgressDone(progress));
  useEffect(() => {
    if (!open || !finished) return;
    const t = window.setTimeout(() => closeLatest(), AUTO_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open, finished]);
  // Mejor esfuerzo: sin vibración (iOS, escritorio) o si el navegador la
  // rechaza, no pasa nada. Vibra una vez por resultado: reabrir la cámara con
  // el mismo último resultado (o uno que llegó con la cámara cerrada) no vuelve
  // a vibrar, porque su `key` ya se vio.
  const feedbackKey = feedback?.key ?? null;
  const feedbackTone = feedback?.tone ?? null;
  const feedbackSeen = useRef(feedbackKey);
  const [voiceOn, setVoiceOn] = useState(() => (bigVerdict && typeof window !== "undefined" ? readScanVoicePref() : false));
  const [verdict, setVerdict] = useState<{ key: string | number; tone: ScanStatusTone } | null>(null);
  useEffect(() => {
    if (!verdict) return;
    const t = window.setTimeout(() => setVerdict(null), VERDICT_MS);
    return () => window.clearTimeout(t);
  }, [verdict]);
  useEffect(() => {
    if (feedbackKey === feedbackSeen.current) return;
    feedbackSeen.current = feedbackKey;
    if (!open || feedbackKey == null || !feedbackTone) return;
    if (bigVerdict) {
      setVerdict({ key: feedbackKey, tone: feedbackTone });
      if (voiceOn) speakScan(scanVoiceText(feedbackTone));
    }
    // El tono del resultado (13-11-2026), además de la vibración.
    playScanNotes(scanResultNotes(feedbackTone));
    const pattern = scanFeedbackVibration(feedbackTone);
    if (!pattern) return;
    try {
      if (typeof window.navigator.vibrate === "function") window.navigator.vibrate(pattern);
    } catch {
      // sin vibración
    }
  }, [open, feedbackKey, feedbackTone, bigVerdict, voiceOn]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const sessionRef = useRef<ReturnType<typeof startDispatchCamera> | null>(null);
  const [torch, setTorchState] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });
  useEffect(() => {
    if (!open) return;
    const visibility = () => setPageVisible(document.visibilityState !== "hidden");
    const restored = (event: PageTransitionEvent) => { if (event.persisted) setAttempt((value) => value + 1); };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pageshow", restored);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pageshow", restored);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    primeScanSound();
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus({ preventScroll: true }); };
  }, [open]);

  useEffect(() => {
    if (!open || !pageVisible) return;
    setError(null);
    setStarting(true);
    if (!videoRef.current) return;
    let handled = false;
    let last: { code: string; at: number } | null = null;
    const session = startDispatchCamera(videoRef.current, {
      onScan: (text) => {
        if (handled) return;
        if (continuous) {
          const now = Date.now();
          if (last && last.code === text && now - last.at < REPEAT_MS) return;
          last = { code: text, at: now };
        } else {
          handled = true;
          session.stop();
        }
        window.navigator.vibrate?.(80);
        playScanNotes(SCAN_READ_NOTES);
        scanLatest(text);
        if (!continuous) closeLatest();
      },
      onReady: () => {
        setStarting(false);
        setTorchState({ supported: session.torchSupported(), on: false });
      },
      onError: (err) => {
        console.error("[dispatch-camera] cámara interrumpida", err);
        setStarting(false);
        setError(err instanceof CameraSessionError ? err.message : cameraErrorMessage(err, window.isSecureContext));
      },
    });
    sessionRef.current = session;
    return () => {
      session.stop();
      if (sessionRef.current === session) sessionRef.current = null;
      setTorchState({ supported: false, on: false });
    };
  }, [open, continuous, attempt, pageVisible]);

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="dispatch-camera-title" onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/70 p-0 sm:items-center sm:p-6">
      <div className="max-h-[95dvh] w-full overflow-y-auto rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <p id="dispatch-camera-title" className="font-semibold text-slate-950">{title}</p>
            <p className="text-xs text-slate-500">{hint ?? (continuous ? "Apunta a cada rótulo; la cámara sigue abierta hasta que termines." : "Apunta al rótulo hasta que vibre el lector.")}</p>
          </div>
          {bigVerdict && (
            <button
              type="button"
              aria-pressed={voiceOn}
              onClick={() => {
                const next = !voiceOn;
                setVoiceOn(next);
                writeScanVoicePref(next);
                if (next) speakScan("Voz prendida");
              }}
              className={cn("mr-2 min-h-10 shrink-0 rounded-lg border px-3 text-sm font-semibold", voiceOn ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-slate-300 text-slate-700")}
            >
              {voiceOn ? "Voz: sí" : "Voz: no"}
            </button>
          )}
          {continuous
            ? <button ref={closeRef} type="button" onClick={onClose} className="min-h-10 shrink-0 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800">Listo</button>
            : <button ref={closeRef} type="button" onClick={onClose} className="grid size-12 shrink-0 place-items-center rounded-full bg-slate-100 text-lg" aria-label="Cerrar cámara">×</button>}
        </div>
        <div role="status" aria-live="polite" aria-atomic="true" className={cn(
          "sticky top-0 z-10 border-b px-5 py-3 text-base font-semibold leading-snug break-words",
          status ? (status.tone ? STATUS_TONE_CLASS[status.tone] : status.warn ? "border-amber-200 bg-amber-50 text-amber-900" : status.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-800") : "border-slate-200 bg-slate-50 text-slate-600",
        )}>
          {bigVerdict && status?.tone && <p className="text-[32px] font-black leading-none tracking-tight">{scanVerdictWord(status.tone)}</p>}
          {bigVerdict && status?.tone ? <p className="mt-1 text-lg font-semibold leading-snug">{status.text}</p> : (status?.text ?? (pending > 0 ? "Lectura recibida" : "Apunta al QR del pedido para escanear."))}
          {status?.detail && <p className="mt-1 text-sm font-normal">{status.detail}</p>}
          {status && statusAction && (
            <button
              type="button"
              disabled={statusAction.busy}
              onClick={statusAction.onClick}
              className="mt-2 flex min-h-11 w-full items-center justify-center rounded-lg border border-amber-300 bg-white px-4 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60 sm:w-auto"
            >
              {statusAction.busy ? (statusAction.busyLabel ?? "Un momento…") : statusAction.label}
            </button>
          )}
          {pending > 0 && <p className="mt-1 text-sm font-medium text-slate-700">
            {lastCaptured ? `Leído: ${lastCaptured}. ` : ""}{pending} por confirmar. Puedes seguir escaneando.
          </p>}
          {issues.length > 0 && <div className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-800">
            <p className="font-semibold">{issues.length} sin confirmar · vuelve a escanear</p>
            <ul className="mt-1 max-h-24 overflow-y-auto font-normal">
              {issues.map((text) => <li key={text} className="py-1">{text}</li>)}
            </ul>
          </div>}
        </div>
        {error && <p role="alert" className="bg-red-50 px-5 py-3 text-sm text-red-700">{error}</p>}
        <div className="relative aspect-[4/3] max-h-[60dvh] overflow-hidden bg-slate-950">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          <div className={cn(
            "pointer-events-none absolute inset-[16%] rounded-3xl shadow-[0_0_0_999px_rgba(2,6,23,.28)] transition-colors",
            verdict ? cn("border-[6px]", VERDICT_CLASS[verdict.tone].frame) : "border-2 border-white/90",
          )} />
          {verdict && (
            <p aria-hidden="true" className={cn(
              "pointer-events-none absolute inset-x-4 bottom-4 rounded-2xl px-4 py-3 text-center text-[40px] font-black leading-none tracking-tight shadow-lg",
              VERDICT_CLASS[verdict.tone].badge,
            )}>
              {scanVerdictWord(verdict.tone)}
            </p>
          )}
          {starting && <p role="status" className="absolute inset-0 grid place-items-center bg-slate-950/80 text-sm font-medium text-white">Abriendo cámara…</p>}
        </div>
        {continuous && progress && (
          <div className="px-5 py-3" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-sm">
              {/* 20 px: se lee de un vistazo con la pistola en la mano. */}
              <span className={cn("text-[20px] leading-tight", finished ? "font-semibold text-emerald-700" : "font-medium text-slate-800")}>{scanProgressText(progress)}</span>
              {progress.total != null && <span className="text-xs tabular-nums text-slate-500">{Math.min(progress.done, progress.total)}/{progress.total}</span>}
            </div>
            {progress.total != null && (
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0}%` }} />
              </div>
            )}
            {extraLines && extraLines.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm leading-snug break-words">
                {extraLines.map((line) => <li key={line.text} className={EXTRA_LINE_TONE[line.tone ?? "neutral"]}>{line.text}</li>)}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2 px-5 pb-3 pt-2">
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Reiniciar cámara</button>
          {/* La linterna, si la cámara la tiene (19-11-2026: el almacén con poca luz). */}
          {torch.supported && (
            <button
              type="button"
              aria-pressed={torch.on}
              onClick={async () => {
                const next = !torch.on;
                if (await sessionRef.current?.setTorch(next)) setTorchState((cur) => ({ ...cur, on: next }));
              }}
              className={cn("min-h-11 rounded-lg border px-4 text-sm font-semibold", torch.on ? "border-amber-300 bg-amber-100 text-amber-950" : "border-slate-300 text-slate-700 hover:bg-slate-50")}
            >
              {torch.on ? "Linterna: sí" : "Linterna"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
