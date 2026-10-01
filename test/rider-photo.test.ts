import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHOTO_AS_IS_BYTES, PHOTO_MAX_SIDE, PHOTO_UPLOAD_LIMIT, canUploadAsIs, fitWithin } from "@/lib/photo-resize";

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
    expect(capture).toContain("canUploadAsIs(file, bitmap)");
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
