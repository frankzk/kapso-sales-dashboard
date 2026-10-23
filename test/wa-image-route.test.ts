// /api/wa-image (0233): la foto del producto siempre sale en JPG, porque Meta
// no acepta WebP en la cabecera de una plantilla.
//
// Desde el 23-10-2026 (MOM §39) la sirve primero de la copia guardada en
// Storage, y solo sin copia la baja en vivo del CDN de Shopify: el 28-10-2026
// Shopify cierra Kenku y Aurela y su CDN deja de servirlas.

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productPhotoPath } from "@/lib/product-photos";
import { toWhatsappJpeg } from "@/lib/product-photos-copy";

const state = vi.hoisted(() => ({
  imageUrl: null as string | null,
  stored: new Map<string, Uint8Array>(),
  downloads: [] as { bucket: string; path: string; signal?: unknown }[],
  storeFilters: [] as unknown[],
  storageDown: false,
}));

vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, v: unknown) => {
        if (col === "store_id") state.storeFilters.push(v);
        return q;
      };
      q.maybeSingle = async () => ({ data: state.imageUrl ? { image_url: state.imageUrl } : null, error: null });
      return q;
    },
    storage: {
      from: (bucket: string) => ({
        download: async (path: string, _o?: unknown, params?: { signal?: unknown }) => {
          state.downloads.push({ bucket, path, signal: params?.signal });
          if (state.storageDown) throw new Error("storage caído");
          const b = state.stored.get(path);
          return b ? { data: new Blob([new Uint8Array(b)]), error: null } : { data: null, error: { message: "Object not found" } };
        },
      }),
    },
  }),
}));

import { GET } from "@/app/api/wa-image/[storeId]/[file]/route";

const STORE = "4c6522f9-c775-4be3-95b0-160a3c16d27a";
const call = (storeId: string, file: string) =>
  GET(new Request("https://x") as never, { params: Promise.resolve({ storeId, file }) });

let source: Buffer;
let cdnStatus = 200;
const fetchMock = vi.fn(async () => (cdnStatus === 200 ? new Response(new Uint8Array(source)) : new Response("x", { status: cdnStatus })));
beforeEach(() => {
  cdnStatus = 200;
  state.stored.clear();
  state.downloads.length = 0;
  state.storeFilters.length = 0;
  state.storageDown = false;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const headersOf = (res: Response) => ({
  "content-type": res.headers.get("content-type"),
  "cache-control": res.headers.get("cache-control"),
  "content-length": res.headers.get("content-length"),
});

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
    // Ni siquiera mira Storage por una foto que no es del catálogo.
    expect(state.downloads).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechaza tienda o archivo con otra forma", async () => {
    state.imageUrl = "https://cdn.shopify.com/s/files/1/x/foto.jpg";
    expect((await call("no-es-uuid", "1.jpg")).status).toBe(404);
    expect((await call(STORE, "../secreto.jpg")).status).toBe(404);
    expect((await call(STORE, "1.png")).status).toBe(404);
  });
});

describe("GET /api/wa-image con la copia guardada (MOM §39)", () => {
  const URL_A = "https://cdn.shopify.com/s/files/1/x/files/foto.webp?v=1";

  it("sirve la copia guardada sin ir al CDN, con las mismas cabeceras que en vivo", async () => {
    source = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#3355cc" } }).webp().toBuffer();
    state.imageUrl = URL_A;
    const live = await call(STORE, "8898494464220.jpg");
    const liveBytes = Buffer.from(await live.arrayBuffer());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // La copia es el MISMO JPG que la ruta sirve en vivo.
    const copia = await toWhatsappJpeg(source);
    expect(copia.equals(liveBytes)).toBe(true);
    state.stored.set(productPhotoPath(STORE, "8898494464220", URL_A), new Uint8Array(copia));
    fetchMock.mockClear();

    const res = await call(STORE, "8898494464220.jpg");
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Buffer.from(await res.arrayBuffer()).equals(copia)).toBe(true);
    expect(headersOf(res)).toEqual(headersOf(live));
    expect(headersOf(res)).toEqual({
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=86400, s-maxage=604800",
      "content-length": String(copia.length),
    });
    expect(state.downloads.at(-1)).toMatchObject({ bucket: "product-photos", path: productPhotoPath(STORE, "8898494464220", URL_A) });
    // Con su tope: un Storage lento no le quita a Meta el tiempo del CDN.
    expect(state.downloads.at(-1)!.signal).toBeInstanceOf(AbortSignal);
  });

  it("un id de tienda en mayúsculas encuentra la misma copia (la carpeta va en minúsculas)", async () => {
    state.imageUrl = URL_A;
    state.stored.set(productPhotoPath(STORE, "111", URL_A), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const res = await call(STORE.toUpperCase(), "111.jpg");
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.storeFilters).toEqual([STORE]);
  });

  it("con el CDN de Shopify caído, la copia sigue saliendo; sin copia, 502 como siempre", async () => {
    state.imageUrl = URL_A;
    cdnStatus = 404;
    expect((await call(STORE, "111.jpg")).status).toBe(502);
    state.stored.set(productPhotoPath(STORE, "111", URL_A), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const res = await call(STORE, "111.jpg");
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("la copia de una URL vieja no se sirve: si la foto cambió, va al CDN por la nueva", async () => {
    source = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#00aa00" } }).png().toBuffer();
    state.stored.set(productPhotoPath(STORE, "111", URL_A), new Uint8Array([1, 2, 3]));
    state.imageUrl = URL_A.replace("v=1", "v=2");
    const res = await call(STORE, "111.jpg");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(state.imageUrl, expect.anything());
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).format).toBe("jpeg");
  });

  it("la copia es por tienda: la de otra tienda con el mismo producto no se sirve", async () => {
    const OTRA = "9b1f7c3e-2d4a-4e5b-8c6d-7e8f9a0b1c2d";
    source = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#000" } }).png().toBuffer();
    state.stored.set(productPhotoPath(OTRA, "111", URL_A), new Uint8Array([1, 2, 3]));
    state.imageUrl = URL_A;
    await call(STORE, "111.jpg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("si Storage no responde, cae al CDN en vez de fallar", async () => {
    source = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).png().toBuffer();
    state.imageUrl = URL_A;
    state.storageDown = true;
    const res = await call(STORE, "111.jpg");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
