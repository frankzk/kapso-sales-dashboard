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
      const acquired = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } }, audio: false,
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
      controls = new BrowserQRCodeReader().scan(video, (result) => {
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

  return { stop };
}
