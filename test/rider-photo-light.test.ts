// Fotos del motorizado siempre livianas (09-10-2026). Desde el 01-10 la foto
// típica pesa 130 KB, pero de 1 a 4 por ruta llegaban enteras (1–1,7 MB): las
// que el celular no tuvo memoria para achicar. Ahora:
//   1. el servidor reduce la que llega pesada antes de guardarla;
//   2. la que no subió por falta de señal se vuelve a mandar sola.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PHOTO_AS_IS_BYTES } from "@/lib/photo-resize";
import { retryableStatus, retryDelayMs, uploadTimeoutMs } from "@/lib/photo-retry";

const state = vi.hoisted(() => ({
  stored: new Map<string, { bytes: Uint8Array; type: string }>(),
}));

vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "roy" }) }));
vi.mock("@/lib/permissions-access", () => ({
  getMasterPermissions: async () => ({ can: (p: string) => p === "routes.deliver" }),
}));
vi.mock("@/lib/route-report-access", () => ({ routeReportAccess: async () => ({ delegated: false }) }));
vi.mock("@/lib/db", () => {
  const storage = {
    createBucket: async () => ({}),
    updateBucket: async () => ({}),
    from: () => ({
      upload: async (path: string, blob: Blob) => {
        state.stored.set(path, { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type });
        return { error: null };
      },
    }),
  };
  return {
    createAdminSupabase: () => ({ storage }),
    createServerSupabase: async () => ({
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) q[m] = () => q;
        q.maybeSingle = async () => ({ data: { id: "stop-1", route_id: "route-1" } });
        return q;
      },
    }),
  };
});

import { POST } from "@/app/api/reparto/foto/route";

async function send(bytes: Uint8Array, type: string, kind = "yape") {
  const fd = new FormData();
  fd.append("file", new File([bytes as BlobPart], "foto", { type }));
  fd.append("stopId", "stop-1");
  fd.append("kind", kind);
  const res = await POST(new Request("https://x/api/reparto/foto", { method: "POST", body: fd }) as never);
  expect(res.status).toBe(200);
  const { path } = (await res.json()) as { path: string };
  return { path, ...state.stored.get(path)! };
}

/** Una foto «con grano»: el ruido no se comprime y la hace pesar de verdad. */
async function noisyJpeg(width: number, height: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer());
}

beforeEach(() => state.stored.clear());

describe("1. el servidor reduce la foto que llega pesada", () => {
  it("una foto entera de 12 MP (la que el celular no pudo achicar) se guarda en JPEG de 1600 px", async () => {
    const original = new Uint8Array(await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#3a7" } }).jpeg().toBuffer());
    const saved = await send(original, "image/jpeg");
    expect(saved.path).toMatch(/^route-1\/stop-1\/yape-[0-9a-f]{16}\.jpg$/);
    expect(saved.type).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(saved.bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([1600, 1200]);
  });

  it("una de 1600 px pero de más de 600 KB baja de peso", async () => {
    const original = await noisyJpeg(1600, 1200);
    expect(original.length).toBeGreaterThan(PHOTO_AS_IS_BYTES);
    const saved = await send(original, "image/jpeg", "entrega");
    expect(saved.bytes.length).toBeLessThan(original.length);
    expect(saved.path).toMatch(/\/entrega-[0-9a-f]{16}\.jpg$/);
  });

  it("una captura PNG alta (1080×2400) queda en JPEG de 1600 px de alto", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 1080, height: 2400, channels: 3, background: "#742284" } }).png().toBuffer());
    const saved = await send(png, "image/png");
    expect(saved.path).toMatch(/\.jpg$/);
    const meta = await sharp(Buffer.from(saved.bytes)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 720, 1600]);
  });

  it("la que el teléfono ya achicó (130 KB, 1600 px) se guarda tal cual, sin volver a comprimirla", async () => {
    const light = new Uint8Array(await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#eee" } }).jpeg({ quality: 72 }).toBuffer());
    const saved = await send(light, "image/jpeg");
    expect(Buffer.from(saved.bytes).equals(Buffer.from(light))).toBe(true);
  });

  it("un HEIC que el servidor no abre se guarda tal cual, como .heic: la evidencia no se pierde", async () => {
    const heic = new Uint8Array([0, 0, 0, 0x18, ...[..."ftypheic"].map((c) => c.charCodeAt(0)), ...new Array(64).fill(7)]);
    const saved = await send(heic, "image/heic");
    expect(saved.path).toMatch(/\.heic$/);
    expect(saved.type).toBe("image/heic");
    expect(Buffer.from(saved.bytes).equals(Buffer.from(heic))).toBe(true);
  });

  it("una foto rota se guarda tal cual en vez de perderse", async () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(700 * 1024).fill(1)]);
    const saved = await send(broken, "image/jpeg");
    expect(saved.bytes.length).toBe(broken.length);
  });
});

describe("2. la subida que no salió por la señal se reintenta sola", () => {
  it("espera 3, 6, 12 y 24 s, y después cada 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(retryDelayMs)).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000, 30_000]);
    expect(retryDelayMs(0)).toBe(3_000);
  });

  it("una subida colgada se corta: un minuto más lo que tardaría a 25 KB/s", () => {
    expect(uploadTimeoutMs(0)).toBe(60_000);
    expect(uploadTimeoutMs(150 * 1024)).toBeCloseTo(66_144, 0);
    expect(uploadTimeoutMs(4 * 1024 * 1024)).toBeLessThan(4 * 60_000);
  });

  it("solo se reintenta lo que se arregla solo: caída del servidor, tiempo agotado, demasiadas peticiones", () => {
    for (const s of [500, 502, 503, 504, 408, 429]) expect(retryableStatus(s)).toBe(true);
    // Sin permiso, ruta cerrada, foto muy grande o que no es foto: reintentar no lo cambia.
    for (const s of [400, 401, 403, 404, 413, 415]) expect(retryableStatus(s)).toBe(false);
  });

  const capture = readFileSync(resolve(process.cwd(), "components/photo-capture.tsx"), "utf8");

  it("sin respuesta o con el servidor caído no sale error: queda esperando y se reintenta sola", () => {
    expect(capture).toContain("throw new RetryLater(true);");
    expect(capture).toContain("if (retryableStatus(res.status)) throw new RetryLater(false);");
    expect(capture.match(/if \(error instanceof RetryLater\) waitAndRetry\(error\);/g)).toHaveLength(2);
    expect(capture).toContain("La foto se subirá sola en cuanto se pueda. No cierres esta pantalla.");
  });

  it("el reintento salta con la espera, al volver la señal y al volver a la pantalla", () => {
    const effect = capture.slice(capture.indexOf('if (phase !== "waiting") return;'), capture.indexOf("}, [phase, attempt]);"));
    expect(effect).toContain("window.setTimeout(go, retryDelayMs(attempt))");
    expect(effect).toContain('window.addEventListener("online", go)');
    expect(effect).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(effect).toContain("window.clearTimeout(timer)");
  });

  it("una foto nueva deja sin efecto la vieja que seguía reintentando: la vieja no gana", () => {
    // Galería y cámara invalidan lo pendiente antes de mandar la nueva…
    expect(capture).toContain("async function fromGallery(file: File) {\n    supersede();");
    expect(capture).toContain("onCapture={(photo) => { setCameraOpen(false); supersede(); void send(photo); }}");
    // …y lo que vuelve de una subida ya invalidada se descarta, sin tocar la parada.
    expect(capture.match(/if \(mine !== ticket\.current\) return;/g)).toHaveLength(4);
  });

  it("el reintento no se encima a una subida en curso, y ninguna va sin tope de tiempo", () => {
    expect(capture.match(/if \(again && inFlight\.current\) return;/g)).toHaveLength(2);
    // Un solo `fetch`: el de `request`, con su tope.
    expect(capture.match(/\bfetch\(/g)).toHaveLength(1);
    expect(capture).toContain("setTimeout(() => abort.abort(), uploadTimeoutMs(bytes))");
  });

  it("la subida directa no vuelve a subir la foto entera si ya llegó: solo pide reducirla", () => {
    expect(capture).toContain("if (!progress.uploaded) {");
    expect(capture).toContain('{ action: "reducir", stopId, kind, path: progress.uploaded }');
  });
});
