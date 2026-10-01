import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDispatchCamera } from "@/lib/dispatch-camera-session";

const scan = vi.hoisted(() => vi.fn());
vi.mock("@zxing/browser", () => ({ BrowserQRCodeReader: class { scan = scan; } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function media() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}
function preview() {
  return { srcObject: null, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() } as unknown as HTMLVideoElement;
}
const events = () => ({ onScan: vi.fn(), onReady: vi.fn(), onError: vi.fn() });
const flush = () => vi.dynamicImportSettled();
let getUserMedia: ReturnType<typeof vi.fn>;
const sessions: ReturnType<typeof startDispatchCamera>[] = [];
function start(video: HTMLVideoElement, callbacks: Parameters<typeof startDispatchCamera>[1] = events()) {
  const session = startDispatchCamera(video, callbacks);
  sessions.push(session);
  return session;
}

beforeEach(() => {
  vi.useFakeTimers();
  getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  scan.mockReset().mockImplementation(() => ({ stop: vi.fn() }));
});
afterEach(() => {
  sessions.splice(0).forEach((session) => session.stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dispatch camera session", () => {
  it("keeps the stream alive for consecutive scans and releases it on close", async () => {
    const { stream, track } = media();
    getUserMedia.mockResolvedValue(stream);
    const video = preview();
    const callbacks = events();
    const session = start(video, callbacks);
    await flush();
    const decode = scan.mock.calls[0]![1];
    decode({ getText: () => "A" });
    decode({ getText: () => "B" });
    expect(callbacks.onScan.mock.calls).toEqual([["A"], ["B"]]);
    expect(callbacks.onReady).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
    session.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    decode({ getText: () => "late" });
    expect(callbacks.onScan).toHaveBeenCalledTimes(2);
  });

  it("discards permission granted after closing without touching the reopened camera", async () => {
    const permission = deferred<MediaStream>();
    const old = media();
    const next = media();
    getUserMedia.mockReturnValueOnce(permission.promise).mockResolvedValueOnce(next.stream);
    const video = preview();
    const callbacks = events();
    const first = start(video, callbacks);
    await flush();
    first.stop();
    start(video);
    await flush();
    permission.resolve(old.stream);
    await flush();
    expect(old.track.stop).toHaveBeenCalledOnce();
    expect(next.track.stop).not.toHaveBeenCalled();
    expect(video.srcObject).toBe(next.stream);
    expect(callbacks.onReady).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledOnce();
  });

  it("releases a stream even if playback is still pending when closed", async () => {
    const playing = deferred<void>();
    const old = media();
    const next = media();
    getUserMedia.mockResolvedValueOnce(old.stream).mockResolvedValueOnce(next.stream);
    const video = preview();
    vi.mocked(video.play).mockReturnValueOnce(playing.promise);
    const first = start(video);
    await flush();
    first.stop();
    expect(old.track.stop).toHaveBeenCalledOnce();
    start(video);
    await flush();
    playing.resolve();
    await flush();
    first.stop();
    expect(video.srcObject).toBe(next.stream);
    expect(next.track.stop).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledOnce();
  });

  it("reports denied permission without starting the decoder", async () => {
    const error = new DOMException("denied", "NotAllowedError");
    getUserMedia.mockRejectedValue(error);
    const callbacks = events();
    start(preview(), callbacks);
    await flush();
    expect(callbacks.onError).toHaveBeenCalledWith(error);
    expect(scan).not.toHaveBeenCalled();
  });

  it("releases the camera when playback fails", async () => {
    const { stream, track } = media();
    getUserMedia.mockResolvedValue(stream);
    const video = preview();
    vi.mocked(video.play).mockRejectedValue(new Error("play failed"));
    const callbacks = events();
    start(video, callbacks);
    await flush();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(callbacks.onError).toHaveBeenCalledOnce();
  });

  it("shows recovery when the device ends the video track", async () => {
    const { stream, track } = media();
    getUserMedia.mockResolvedValue(stream);
    const callbacks = events();
    start(preview(), callbacks);
    await flush();
    track.dispatchEvent(new Event("ended"));
    expect(callbacks.onError.mock.calls[0]![0].message).toContain("Reiniciar cámara");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("times out a stalled opening and releases any late stream", async () => {
    const permission = deferred<MediaStream>();
    const { stream, track } = media();
    getUserMedia.mockReturnValue(permission.promise);
    const callbacks = events();
    start(preview(), callbacks);
    await flush();
    await vi.advanceTimersByTimeAsync(15000);
    expect(callbacks.onError.mock.calls[0]![0].message).toContain("no inició");
    permission.resolve(stream);
    await flush();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(callbacks.onReady).not.toHaveBeenCalled();
  });

  it("can stop on the very first synchronous decoded frame", async () => {
    const { stream, track } = media();
    getUserMedia.mockResolvedValue(stream);
    const controls = { stop: vi.fn() };
    scan.mockImplementation((_video, decode) => { decode({ getText: () => "first" }); return controls; });
    const callbacks = events();
    const session = start(preview(), { ...callbacks, onScan: () => session.stop() });
    await flush();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(controls.stop).toHaveBeenCalledOnce();
    expect(callbacks.onReady).not.toHaveBeenCalled();
  });
});
