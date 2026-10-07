// /api/wa-image (0233): la foto del producto siempre sale en JPG, porque Meta
// no acepta WebP en la cabecera de una plantilla.

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ imageUrl: null as string | null }));

vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: state.imageUrl ? { image_url: state.imageUrl } : null, error: null });
      return q;
    },
  }),
}));

import { GET } from "@/app/api/wa-image/[storeId]/[file]/route";

const STORE = "4c6522f9-c775-4be3-95b0-160a3c16d27a";
const call = (storeId: string, file: string) =>
  GET(new Request("https://x") as never, { params: Promise.resolve({ storeId, file }) });

let source: Buffer;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(source))));
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/wa-image", () => {
  it.each([
    ["WebP", () => sharp({ create: { width: 1200, height: 900, channels: 3, background: "#cc3355" } }).webp().toBuffer()],
    ["PNG transparente", () => sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()],
  ])("%s → JPG de 800 px como máximo", async (_, make) => {
    source = await make();
    state.imageUrl = "https://cdn.shopify.com/s/files/1/x/files/foto.webp?v=1";
    const res = await call(STORE, "8898494464220.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeLessThanOrEqual(800);
  });

  it("no es un proxy abierto: solo fotos del catálogo, de cdn.shopify.com", async () => {
    state.imageUrl = "https://otro-sitio.com/foto.jpg";
    expect((await call(STORE, "1.jpg")).status).toBe(404);
    state.imageUrl = null;
    expect((await call(STORE, "1.jpg")).status).toBe(404);
  });

  it("rechaza tienda o archivo con otra forma", async () => {
    state.imageUrl = "https://cdn.shopify.com/s/files/1/x/foto.jpg";
    expect((await call("no-es-uuid", "1.jpg")).status).toBe(404);
    expect((await call(STORE, "../secreto.jpg")).status).toBe(404);
    expect((await call(STORE, "1.png")).status).toBe(404);
  });
});
