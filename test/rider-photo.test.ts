import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHOTO_AS_IS_BYTES, PHOTO_MAX_SIDE, PHOTO_UPLOAD_LIMIT, canUploadAsIs, decodeResize, fitWithin, readImageSize } from "@/lib/photo-resize";

// La foto del motorizado (30-09-2026): a Roy le salía «Memoria insuficiente
// para completar la operación anterior» al volver de la cámara, y no podía
// adjuntar una captura de Yape ni una foto ya tomada.

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("tamaño de la foto que se sube", () => {
  it("una foto de 12 MP baja a 1600 px por el lado mayor, sin deformarse", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(4032, 1908)).toEqual({ width: 1600, height: 757 });
  });

  it("nunca agranda una foto chica ni acepta medidas vacías", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 600)).toEqual({ width: 0, height: 0 });
    expect(fitWithin(Number.NaN, 600)).toEqual({ width: 0, height: 0 });
  });

  it("solo un JPEG ya chico y liviano se sube sin volver a codificar", () => {
    expect(canUploadAsIs({ size: 300_000, type: "image/jpeg" }, { width: 1200, height: 900 })).toBe(true);
    expect(canUploadAsIs({ size: PHOTO_AS_IS_BYTES + 1, type: "image/jpeg" }, { width: 1200, height: 900 })).toBe(false);
    expect(canUploadAsIs({ size: 300_000, type: "image/jpeg" }, { width: PHOTO_MAX_SIDE + 1, height: 900 })).toBe(false);
    // Una captura de Yape es PNG: se re-codifica a JPEG, que pesa mucho menos.
    expect(canUploadAsIs({ size: 200_000, type: "image/png" }, { width: 1080, height: 1600 })).toBe(false);
  });

  it("el límite queda por debajo del corte de 4,5 MB de Vercel", () => {
    expect(PHOTO_UPLOAD_LIMIT).toBeLessThan(4.5 * 1024 * 1024);
  });
});

describe("medidas de la foto sin decodificarla", () => {
  const bytes = (...parts: Array<number[] | string>) =>
    new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
  const be16 = (n: number) => [(n >> 8) & 255, n & 255];
  const be32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];

  it("PNG: el IHDR", () => {
    const png = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(1080), be32(2400), [8, 6, 0, 0, 0]);
    expect(readImageSize(png)).toEqual({ width: 1080, height: 2400 });
  });

  it("JPEG: salta el EXIF y lee el SOF, también el progresivo", () => {
    const app1 = [0xff, 0xe1, ...be16(2 + 6), ..."Exif\0\0".split("").map((c) => c.charCodeAt(0))];
    const sof = (marker: number) => [0xff, marker, ...be16(17), 8, ...be16(3000), ...be16(4000), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    expect(readImageSize(bytes([0xff, 0xd8], app1, sof(0xc0)))).toEqual({ width: 4000, height: 3000 });
    expect(readImageSize(bytes([0xff, 0xd8], app1, sof(0xc2)))).toEqual({ width: 4000, height: 3000 });
    // El DHT (C4) no es un SOF aunque caiga en el rango.
    const dht = [0xff, 0xc4, ...be16(4), 0, 0];
    expect(readImageSize(bytes([0xff, 0xd8], dht, sof(0xc0)))).toEqual({ width: 4000, height: 3000 });
    // Sin SOF antes de los datos: no se adivina.
    expect(readImageSize(bytes([0xff, 0xd8], app1, [0xff, 0xda, 0, 4, 0, 0]))).toBeNull();
  });

  it("WebP: VP8X, VP8 y VP8L", () => {
    const riff = (chunk: string, data: number[]) => bytes("RIFF", be32(0), "WEBP", chunk, be32(data.length), data);
    expect(readImageSize(riff("VP8X", [0, 0, 0, 0, ...[1599 & 255, 1599 >> 8, 0], ...[899 & 255, 899 >> 8, 0]]))).toEqual({ width: 1600, height: 900 });
    expect(readImageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 1920 & 255, 1920 >> 8, 1080 & 255, 1080 >> 8]))).toEqual({ width: 1920, height: 1080 });
    const bits = (799) | (599 << 14);
    expect(readImageSize(riff("VP8L", [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0]))).toEqual({ width: 800, height: 600 });
  });

  it("lo que no reconoce no lo adivina", () => {
    expect(readImageSize(bytes("GIF89a", [1, 0, 1, 0]))).toBeNull();
    expect(readImageSize(new Uint8Array(0))).toBeNull();
  });

  it("decodifica reducida por el lado mayor, y entera si ya es chica", () => {
    expect(decodeResize({ width: 4000, height: 3000 })).toEqual({ resizeWidth: PHOTO_MAX_SIDE });
    expect(decodeResize({ width: 3000, height: 4000 })).toEqual({ resizeHeight: PHOTO_MAX_SIDE });
    expect(decodeResize({ width: 1080, height: 1600 })).toEqual({});
    expect(decodeResize(null)).toEqual({});
  });
});

describe("la cámara ya no sale de Chrome", () => {
  const capture = read("components/photo-capture.tsx");
  const camera = read("components/photo-camera.tsx");
  const scan = read("components/scan-action.tsx");

  it("ningún campo de foto abre la app de cámara de Android (`capture`)", () => {
    expect(capture).not.toMatch(/\scapture=/);
    expect(scan).not.toMatch(/\scapture=/);
    expect(read("components/rider-route.tsx")).not.toMatch(/\scapture=/);
  });

  it("«Cámara» abre la cámara DENTRO de la página y la apaga al tomar la foto", () => {
    expect(camera).toContain("navigator.mediaDevices.getUserMedia(");
    expect(camera).toContain('facingMode: { ideal: "environment" }');
    const shoot = camera.slice(camera.indexOf("async function shoot()"), camera.indexOf("return (\n    <div role=\"dialog\""));
    expect(shoot).toContain("fitWithin(video.videoWidth, video.videoHeight)");
    expect(shoot).toContain('canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY)');
    expect(shoot.indexOf("stop();")).toBeLessThan(shoot.indexOf("onCapture(photo)"));
    // Se descarga solo cuando se usa.
    expect(capture).toContain('lazy(() => import("@/components/photo-camera")');
  });

  it("«Galería» deja elegir una captura o una foto ya tomada, y la reduce antes de subir", () => {
    expect(capture).toContain('type="file"');
    expect(capture).toContain('accept="image/*"');
    expect(capture).toContain("await send(await shrink(file))");
    // Medidas desde la cabecera: un JPEG chico sube sin decodificarse, y uno
    // grande se decodifica YA reducido (revisión del 30-09-2026).
    expect(capture).toContain("readImageSize(new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer()))");
    expect(capture).toContain("if (size && canUploadAsIs(file, size)) return file;");
    expect(capture).toContain("...decodeResize(size)");
  });

  it("un error de subida va en un aviso, no pintando el campo (DESIGN.md)", () => {
    expect(capture).toContain('<Banner tone="crit" role="alert" title={failure.title}');
    expect(capture).not.toContain("ring-crit");
  });

  it("si la subida falla, «Reintentar» manda la misma foto sin tomarla otra vez", () => {
    expect(capture).toContain("pending.current = photo;");
    expect(capture).toContain("Reintentar la subida");
  });

  it("el gesto de foto del escáner usa el mismo campo", () => {
    expect(scan).toContain('if (plan.gesture === "photo") {\n    return (\n      <PhotoCapture');
  });

  it("el servidor ya no promete una reducción que el navegador no hacía", () => {
    const route = read("app/api/reparto/foto/route.ts");
    expect(route).not.toContain("el navegador ya las reduce antes de subirlas");
  });
});

describe("la pantalla del motorizado no carga código del servidor", () => {
  it("importa las piezas livianas del cuaderno, no los módulos que arrastran Shopify", () => {
    const rider = read("components/rider-route.tsx");
    expect(rider).toContain('from "@/lib/sheets/monto"');
    expect(rider).toContain('from "@/lib/sheets/payment-methods"');
    expect(rider).not.toContain('from "@/lib/sheets/rider-cuaderno"');
    expect(rider).not.toContain('from "@/lib/sheets/templates"');
    expect(read("lib/sheets/stop-bridge.ts")).toContain('import { normalizeAlias } from "./alias";');
    for (const tiny of ["lib/sheets/alias.ts", "lib/sheets/monto.ts", "lib/sheets/payment-methods.ts", "lib/photo-resize.ts", "lib/rider-contact.ts"]) {
      expect(read(tiny)).not.toMatch(/^import /m);
    }
  });

  it("el escáner de QR se descarga al tocarlo", () => {
    expect(read("components/rider-route.tsx")).toContain('const ScanAction = lazy(() => import("@/components/scan-action")');
  });

  it("el nombre de la tienda se lee solo con id y nombre", () => {
    const access = read("lib/routes-access.ts");
    expect(access).toContain('createAdminSupabase().from("stores").select("id,name")');
  });
});
