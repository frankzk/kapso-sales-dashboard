// La foto que el celular no puede achicar (08-10-2026): la captura del Yape de
// #KP139761 que Roy no podía adjuntar («No se pudo leer esa foto y pesa
// demasiado para subirla»), aunque había subido otras 79 sin problema. Ahora
// sube entera directo a Storage y la reduce el servidor.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PHOTO_DIRECT_LIMIT, imageKind } from "@/lib/photo-resize";

const state = vi.hoisted(() => ({
  stored: new Map<string, Uint8Array>(),
  signed: [] as string[],
  removed: [] as string[],
  stopVisible: true,
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
      createSignedUploadUrl: async (path: string) => {
        state.signed.push(path);
        return { data: { path, token: "tok" }, error: null };
      },
      download: async (path: string) => {
        const b = state.stored.get(path);
        return b ? { data: new Blob([b as BlobPart]), error: null } : { data: null, error: { message: "no" } };
      },
      upload: async (path: string, blob: Blob) => {
        state.stored.set(path, new Uint8Array(await blob.arrayBuffer()));
        return { error: null };
      },
      remove: async (paths: string[]) => {
        state.removed.push(...paths);
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
        q.maybeSingle = async () => ({ data: state.stopVisible ? { id: "stop-1", route_id: "route-1" } : null });
        return q;
      },
    }),
  };
});

import { POST } from "@/app/api/reparto/foto/route";

const call = (body: Record<string, unknown>) =>
  POST(
    new Request("https://x/api/reparto/foto", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );

beforeEach(() => {
  state.stored.clear();
  state.signed = [];
  state.removed = [];
  state.stopVisible = true;
});

describe("el formato por los primeros bytes", () => {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  it.each([
    ["jpeg", [0xff, 0xd8, 0xff, 0xe1]],
    ["png", [0x89, ...ascii("PNG"), 0x0d, 0x0a]],
    ["webp", [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]],
    ["heic", [0, 0, 0, 0x18, ...ascii("ftypheic")]],
    ["heic", [0, 0, 0, 0x18, ...ascii("ftypmif1")]],
    ["avif", [0, 0, 0, 0x18, ...ascii("ftypavif")]],
    ["otro", [1, 2, 3, 4]],
  ])("%s", (kind, bytes) => {
    expect(imageKind(new Uint8Array(bytes))).toBe(kind);
  });
});

describe("subida directa: firmar y reducir", () => {
  it("firmar da una ruta de ESTA parada, marcada como original", async () => {
    const res = await call({ action: "firmar", stopId: "stop-1", kind: "yape", type: "image/jpeg", size: 9_000_000 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { path: string; token: string };
    expect(json.path).toMatch(/^route-1\/stop-1\/yape-original-\d+-[0-9a-f]{8}\.jpg$/);
    expect(json.token).toBe("tok");
  });

  it("más de 25 MB no se firma", async () => {
    const res = await call({ action: "firmar", stopId: "stop-1", kind: "yape", type: "image/jpeg", size: PHOTO_DIRECT_LIMIT + 1 });
    expect(res.status).toBe(413);
    expect(state.signed).toEqual([]);
  });

  it("una parada ajena no se firma", async () => {
    state.stopVisible = false;
    expect((await call({ action: "firmar", stopId: "otra", kind: "yape", type: "image/jpeg", size: 100 })).status).toBe(403);
  });

  it("una foto de 50 MP queda en JPEG de 1600 px y el original se borra", async () => {
    const original = "route-1/stop-1/yape-original-1-abcd1234.jpg";
    state.stored.set(
      original,
      new Uint8Array(await sharp({ create: { width: 8160, height: 6120, channels: 3, background: "#3a7" } }).jpeg().toBuffer()),
    );
    const res = await call({ action: "reducir", stopId: "stop-1", kind: "yape", path: original });
    const json = (await res.json()) as { path: string; reduced: boolean };
    expect(json.reduced).toBe(true);
    expect(json.path).toMatch(/^route-1\/stop-1\/yape-[0-9a-f]{16}\.jpg$/);
    const meta = await sharp(Buffer.from(state.stored.get(json.path)!)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
    expect(state.removed).toEqual([original]);
  });

  it("un HEIC que el servidor no abre queda tal cual: la evidencia no se pierde", async () => {
    const original = "route-1/stop-1/yape-original-1-abcd1234.heic";
    state.stored.set(original, new Uint8Array([0, 0, 0, 0x18, ...[..."ftypheic"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]));
    const json = (await (await call({ action: "reducir", stopId: "stop-1", kind: "yape", path: original })).json()) as { path: string; reduced: boolean };
    expect(json).toMatchObject({ path: original, reduced: false });
    expect(state.removed).toEqual([]);
  });

  it("solo reduce un original de ESTA parada", async () => {
    for (const path of ["route-1/otra/yape-original-1.jpg", "route-1/stop-1/yape-abc.jpg", "route-1/stop-1/../x/yape-original-1.jpg"]) {
      expect((await call({ action: "reducir", stopId: "stop-1", kind: "yape", path })).status).toBe(403);
    }
  });
});

describe("la pantalla del motorizado", () => {
  const capture = readFileSync(resolve(process.cwd(), "components/photo-capture.tsx"), "utf8");

  it("ya no corta con «pesa demasiado»: la foto que no puede achicar va por la subida directa", () => {
    expect(capture).not.toContain("pesa demasiado para subirla");
    expect(capture).toContain("throw new NeedsDirectUpload()");
    expect(capture).toContain("if (error instanceof NeedsDirectUpload) return void sendDirect(file);");
  });

  it("una foto pesada que no abrió reducida no se abre entera en el celular", () => {
    const decode = capture.slice(capture.indexOf("async function decode("), capture.indexOf("async function shrink("));
    expect(decode).toContain("if (file.size > PHOTO_UPLOAD_LIMIT) return null;");
  });

  it("no carga el cliente de Supabase: la subida directa es un fetch", () => {
    expect(capture).not.toContain("supabase-browser");
    expect(capture).toContain("/storage/v1/object/upload/sign/delivery-proofs/");
  });
});
