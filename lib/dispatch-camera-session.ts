import type { IScannerControls } from "@zxing/browser";

const START_TIMEOUT_MS = 15000;

export class CameraSessionError extends Error {}

/** Each opening owns its stream; a late permission/play result cannot clear a newer one. */
export function startDispatchCamera(video: HTMLVideoElement, events: {
  onScan: (value: string) => void;
  onReady: () => void;
  onError: (error: unknown) => void;
}) {
  let stopped = false;
  let stream: MediaStream | null = null;
  let controls: IScannerControls | null = null;

  const stop = () => {
    stopped = true;
    clearTimeout(timeout);
    controls?.stop();
    controls = null;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.removeEventListener("ended", interrupted);
      track.stop();
    }
    if (video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
    stream = null;
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    stop();
    events.onError(error);
  };
  const interrupted = () => fail(new CameraSessionError("La cámara se interrumpió. Pulsa «Reiniciar cámara» para continuar."));
  const timeout = setTimeout(() => fail(new CameraSessionError("La cámara no inició. Revisa el permiso y pulsa «Reiniciar cámara».")), START_TIMEOUT_MS);

  void (async () => {
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      if (stopped) return;
      // 1280×720 ideal (19-11-2026): con la resolución por defecto (640×480 en
      // muchos teléfonos) un QR chico o lejano no se lee; el navegador baja si
      // la cámara no da más.
      const acquired = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      if (stopped) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", interrupted));
      video.srcObject = stream;
      await video.play();
      if (stopped) return;
      // We own playback and cleanup. ZXing only decodes: its stream helpers
      // unconditionally clear the video when an older session finishes stopping.
      controls = new BrowserQRCodeReader(undefined, {
        delayBetweenScanAttempts: 100,
        delayBetweenScanSuccess: 100,
      }).scan(video, (result) => {
        if (!stopped && result) events.onScan(result.getText());
      }, (error) => {
        if (error) fail(error);
      });
      if (stopped) { controls.stop(); return; }
      clearTimeout(timeout);
      events.onReady();
    } catch (error) {
      fail(error);
    }
  })();

  /** La linterna del teléfono (19-11-2026, la luz del almacén): solo si la cámara la tiene. */
  const torchTrack = () => stream?.getVideoTracks()[0] ?? null;
  const torchSupported = () => {
    try {
      const caps = torchTrack()?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      return Boolean(caps?.torch);
    } catch {
      return false;
    }
  };
  const setTorch = async (on: boolean): Promise<boolean> => {
    const track = torchTrack();
    if (!track) return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  };

  return { stop, torchSupported, setTorch };
}
