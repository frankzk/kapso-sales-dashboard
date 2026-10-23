// Las fotos de producto de WhatsApp, copiadas a Storage antes del cierre de
// Shopify (MOM §39, 23-10-2026): la ruta de cada copia y quién la puede usar
// (lib/product-photos.ts) y la pasada que copia (lib/product-photos-copy.ts).
//
// Lo que se fija aquí: que lo guardado es el MISMO JPG que /api/wa-image sirve
// en vivo; que una segunda pasada no baja ni sube nada; que una URL nueva se
// copia en otra ruta sin tocar la vieja; que nada se pisa ni se borra; que la
// pasada respeta su presupuesto y los topes de Storage; que `dry` solo cuenta;
// y que una tienda que Shopify todavía sirve elige foto como siempre, y una que
// ya no (sin token, o desde el cierre la que pasa a WooCommerce) solo con
// copia. Sin red: Storage, el CDN y la fila de la tienda son falsos.

import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SHOPIFY_SHUTDOWN_AT } from "@/lib/invoicing/shopify-cutoff";
import {
  PRODUCT_PHOTO_BUCKET,
  PRODUCT_PHOTO_DOWNLOAD_TIMEOUT_MS,
  PRODUCT_PHOTO_LIST_TIMEOUT_MS,
  isCopyableProductPhoto,
  photoSourceTag,
  productPhotoName,
  productPhotoPath,
  productPhotosThatLoad,
  readStoredPhoto,
  shopifyGoneForStore,
  storedPhotoNames,
} from "@/lib/product-photos";
import {
  PRODUCT_PHOTO_COPY_BUDGET_MS,
  PRODUCT_PHOTO_COPY_MAX_DURATION_S,
  PRODUCT_PHOTO_FETCH_TIMEOUT_MS,
  PRODUCT_PHOTO_MAX_SOURCE_BYTES,
  PRODUCT_PHOTO_UPLOAD_TIMEOUT_MS,
  copyProductPhotos,
  fetchProductPhotoJpeg,
  toWhatsappJpeg,
} from "@/lib/product-photos-copy";

const KENKU = "4c6522f9-c775-4be3-95b0-160a3c16d27a";
const AURELA = "9b1f7c3e-2d4a-4e5b-8c6d-7e8f9a0b1c2d";
const CUTOFF = Date.parse(SHOPIFY_SHUTDOWN_AT);
const ANTES = CUTOFF - 3600_000;
const DESPUES = CUTOFF + 3600_000;

const cdn = (name: string) => `https://cdn.shopify.com/s/files/1/0001/files/${name}?v=1`;

/** Un Storage en memoria con lo que usa la copia. */
function fakeStorage(opts: {
  objects?: Record<string, Uint8Array>;
  listError?: boolean;
  /** El listado no ve lo que ya está (otra pasada lo subió recién). */
  staleList?: boolean;
  /** Storage devuelve como mucho esto por página, aunque se le pida más. */
  pageCap?: number;
  uploadError?: boolean;
  /** La subida no contesta nunca. */
  uploadHangs?: boolean;
  downloadThrows?: boolean;
  bucket?: boolean;
} = {}) {
  const objects = new Map<string, Uint8Array>(Object.entries(opts.objects ?? {}));
  const calls = {
    list: [] as string[],
    /** El tercer argumento de cada `list` y `download` (la señal del tope). */
    listParams: [] as unknown[],
    downloadParams: [] as unknown[],
    upload: [] as { bucket: string; path: string; opts: Record<string, unknown> }[],
    download: [] as string[],
    createBucket: [] as unknown[][],
    updateBucket: [] as unknown[][],
    remove: 0,
  };
  const storage = {
    createBucket: async (...args: unknown[]) => {
      calls.createBucket.push(args);
      return { data: null, error: null };
    },
    updateBucket: async (...args: unknown[]) => {
      calls.updateBucket.push(args);
      return { data: null, error: null };
    },
    getBucket: async (name: string) =>
      opts.bucket === false ? { data: null, error: { message: "Bucket not found" } } : { data: { id: name }, error: null },
    from: (bucket: string) => ({
      list: async (prefix: string, o: { limit: number; offset: number }, params?: unknown) => {
        calls.list.push(prefix);
        calls.listParams.push(params);
        if (opts.listError) return { data: null, error: { message: "boom" } };
        if (opts.staleList) return { data: [], error: null };
        const names = [...objects.keys()]
          .filter((k) => k.startsWith(`${prefix}/`))
          .map((k) => k.slice(prefix.length + 1))
          .sort();
        const limit = Math.min(o.limit, opts.pageCap ?? o.limit);
        return { data: names.slice(o.offset, o.offset + limit).map((name) => ({ name, id: `id-${name}` })), error: null };
      },
      upload: async (path: string, body: Uint8Array, o: Record<string, unknown>) => {
        calls.upload.push({ bucket, path, opts: o });
        if (opts.uploadHangs) return new Promise(() => {});
        if (objects.has(path) && !o.upsert) return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
        if (opts.uploadError) return { data: null, error: { statusCode: "500", message: "boom" } };
        objects.set(path, new Uint8Array(body));
        return { data: { path }, error: null };
      },
      download: async (path: string, _o?: unknown, params?: unknown) => {
        calls.download.push(path);
        calls.downloadParams.push(params);
        if (opts.downloadThrows) throw new Error("storage caído");
        const b = objects.get(path);
        return b ? { data: new Blob([new Uint8Array(b)]), error: null } : { data: null, error: { message: "Object not found" } };
      },
      remove: async () => {
        calls.remove += 1;
        return { data: [], error: null };
      },
    }),
  };
  return { storage, objects, calls };
}

interface MirrorRow {
  store_id: string;
  product_id: string;
  image_url: string | null;
}

/** El espejo `shopify_product_images` (solo la lectura de la copia) y Storage. */
function fakeAdmin(rows: MirrorRow[], storageOpts: Parameters<typeof fakeStorage>[0] = {}, opts: { readError?: boolean } = {}) {
  const st = fakeStorage(storageOpts);
  const reads: { filters: unknown[][] }[] = [];
  const admin = {
    storage: st.storage,
    from(table: string) {
      expect(table).toBe("shopify_product_images");
      const filters: unknown[][] = [];
      reads.push({ filters });
      const q: Record<string, unknown> = {};
      q.select = () => q;
      for (const m of ["not", "eq", "order"]) {
        q[m] = (...args: unknown[]) => {
          filters.push([m, ...args]);
          return q;
        };
      }
      q.range = async (from: number, to: number) => {
        if (opts.readError) return { data: null, error: { message: "boom" } };
        const store = filters.find((f) => f[0] === "eq" && f[1] === "store_id")?.[2];
        const data = rows
          .filter((r) => r.image_url !== null && (store === undefined || r.store_id === store))
          .slice(from, to + 1);
        return { data, error: null };
      };
      return q;
    },
  };
  return { admin: admin as never, ...st, reads };
}

/** Un CDN falso: por URL, los bytes o el código. Cuenta las descargas. */
function fakeCdn(byUrl: Record<string, Uint8Array | number>) {
  const hits: string[] = [];
  const fetchImpl = (async (url: string) => {
    hits.push(url);
    const v = byUrl[url];
    if (v === undefined) return new Response("nope", { status: 404 });
    if (typeof v === "number") return new Response("err", { status: v });
    return new Response(new Uint8Array(v));
  }) as unknown as typeof fetch;
  return { fetchImpl, hits };
}

const webp = (color: string, width = 1200) =>
  sharp({ create: { width, height: Math.round(width * 0.75), channels: 3, background: color } }).webp().toBuffer();
const transparentPng = () =>
  sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

describe("la ruta de cada copia", () => {
  it("es la tienda, el producto y la huella de la URL de origen", () => {
    const url = cdn("pulsera.webp");
    expect(photoSourceTag(url)).toMatch(/^[0-9a-f]{16}$/);
    expect(productPhotoPath(KENKU, "8898494464220", url)).toBe(`${KENKU}/8898494464220-${photoSourceTag(url)}.jpg`);
    expect(productPhotoPath(KENKU, "8898494464220", url)).toBe(`${KENKU}/${productPhotoName("8898494464220", url)}`);
  });

  it("la huella es el sha256 de la URL en UTF-8, en hex: la consulta de DEPLOY.md la arma igual en SQL", () => {
    // `left(encode(sha256(convert_to(image_url, 'UTF8')), 'hex'), 16)`
    const url = cdn("Sérum-uñas.webp");
    expect(photoSourceTag(url)).toBe(createHash("sha256").update(Buffer.from(url, "utf8")).digest("hex").slice(0, 16));
    expect(photoSourceTag("abc")).toBe("ba7816bf8f01cfea");
  });

  it("si la foto cambia en Shopify (otra URL), la ruta es otra", () => {
    const a = productPhotoPath(KENKU, "1", cdn("p.webp"));
    const b = productPhotoPath(KENKU, "1", cdn("p.webp").replace("v=1", "v=2"));
    expect(a).not.toBe(b);
    expect(productPhotoPath(KENKU, "1", cdn("p.webp"))).toBe(a);
  });

  it("solo se copia lo que /api/wa-image sirve: foto del CDN de Shopify e id numérico", () => {
    expect(isCopyableProductPhoto("123", cdn("x.jpg"))).toBe(true);
    expect(isCopyableProductPhoto("123", "https://otro-sitio.com/x.jpg")).toBe(false);
    expect(isCopyableProductPhoto("123", "http://cdn.shopify.com/x.jpg")).toBe(false);
    expect(isCopyableProductPhoto("123", null)).toBe(false);
    expect(isCopyableProductPhoto("../x", cdn("x.jpg"))).toBe(false);
    expect(isCopyableProductPhoto("gid://shopify/Product/1", cdn("x.jpg"))).toBe(false);
  });

  it("el bucket es `product-photos`", () => {
    expect(PRODUCT_PHOTO_BUCKET).toBe("product-photos");
  });
});

describe("la pasada de copia", () => {
  it("copia cada foto que falta, como el MISMO JPG que /api/wa-image sirve en vivo, en un bucket privado", async () => {
    const a = await webp("#cc3355");
    const b = await transparentPng();
    const rows: MirrorRow[] = [
      { store_id: KENKU, product_id: "111", image_url: cdn("a.webp") },
      { store_id: AURELA, product_id: "222", image_url: cdn("b.png") },
      // Sin foto: no hay nada que copiar.
      { store_id: KENKU, product_id: "333", image_url: null },
    ];
    const h = fakeAdmin(rows);
    const cdnFake = fakeCdn({ [cdn("a.webp")]: a, [cdn("b.png")]: b });
    const r = await copyProductPhotos(h.admin, { fetchImpl: cdnFake.fetchImpl });

    expect(r).toMatchObject({ ok: true, dry: false, filas: 2, guardadas: 0, copiadas: 2, fallidas: 0, pendientes: 0, agotado: false });
    expect(r.errors).toEqual([]);
    const pathA = productPhotoPath(KENKU, "111", cdn("a.webp"));
    const pathB = productPhotoPath(AURELA, "222", cdn("b.png"));
    expect([...h.objects.keys()].sort()).toEqual([pathA, pathB].sort());
    expect(Buffer.from(h.objects.get(pathA)!).equals(await toWhatsappJpeg(a))).toBe(true);
    expect(Buffer.from(h.objects.get(pathB)!).equals(await toWhatsappJpeg(b))).toBe(true);
    const meta = await sharp(Buffer.from(h.objects.get(pathA)!)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(800);
    // Sin `upsert`: una copia nunca se pisa.
    for (const u of h.calls.upload) {
      expect(u.bucket).toBe("product-photos");
      expect(u.opts).toMatchObject({ contentType: "image/jpeg", upsert: false });
    }
    // Privado, como los demás buckets del repositorio.
    expect(h.calls.createBucket).toEqual([["product-photos", { public: false }]]);
    expect(h.calls.updateBucket).toEqual([["product-photos", { public: false }]]);
    expect(h.calls.remove).toBe(0);
  });

  it("es idempotente: lo ya copiado no se baja ni se sube otra vez", async () => {
    const rows: MirrorRow[] = [
      { store_id: KENKU, product_id: "111", image_url: cdn("a.webp") },
      { store_id: KENKU, product_id: "112", image_url: cdn("c.webp") },
    ];
    const h = fakeAdmin(rows);
    const cdnFake = fakeCdn({ [cdn("a.webp")]: await webp("#123456"), [cdn("c.webp")]: await webp("#654321") });
    expect((await copyProductPhotos(h.admin, { fetchImpl: cdnFake.fetchImpl })).copiadas).toBe(2);
    const before = new Map(h.objects);
    cdnFake.hits.length = 0;
    h.calls.upload.length = 0;
    h.calls.list.length = 0;

    const again = await copyProductPhotos(h.admin, { fetchImpl: cdnFake.fetchImpl });
    expect(again).toMatchObject({ ok: true, filas: 2, guardadas: 2, copiadas: 0, fallidas: 0, pendientes: 0 });
    expect(cdnFake.hits).toEqual([]);
    expect(h.calls.upload).toEqual([]);
    expect(h.objects).toEqual(before);
    // Una lectura del espejo y el listado de la tienda (la página con los
    // nombres y la vacía que dice que no hay más): nada más.
    expect(h.calls.list).toEqual([KENKU, KENKU]);
    expect(h.reads).toHaveLength(2);
  });

  it("si la URL cambia, se copia de nuevo en otra ruta; la copia vieja queda y nada se borra", async () => {
    const rows: MirrorRow[] = [{ store_id: KENKU, product_id: "111", image_url: cdn("a.webp") }];
    const h = fakeAdmin(rows);
    const nueva = cdn("a.webp").replace("v=1", "v=2");
    const cdnFake = fakeCdn({ [cdn("a.webp")]: await webp("#ff0000"), [nueva]: await webp("#00ff00", 600) });
    await copyProductPhotos(h.admin, { fetchImpl: cdnFake.fetchImpl });
    const vieja = productPhotoPath(KENKU, "111", cdn("a.webp"));
    expect(h.objects.has(vieja)).toBe(true);

    rows[0]!.image_url = nueva;
    cdnFake.hits.length = 0;
    const r = await copyProductPhotos(h.admin, { fetchImpl: cdnFake.fetchImpl });
    expect(r).toMatchObject({ filas: 1, guardadas: 0, copiadas: 1 });
    expect(cdnFake.hits).toEqual([nueva]);
    const path = productPhotoPath(KENKU, "111", nueva);
    expect(path).not.toBe(vieja);
    expect((await sharp(Buffer.from(h.objects.get(path)!)).metadata()).width).toBe(600);
    expect(h.objects.has(vieja)).toBe(true);
    expect(h.calls.remove).toBe(0);
  });

  it("una foto que el CDN no da se cuenta y se reintenta, sin poner el cron en rojo", async () => {
    const rows: MirrorRow[] = [
      { store_id: KENKU, product_id: "111", image_url: cdn("borrada.webp") },
      { store_id: KENKU, product_id: "112", image_url: cdn("lenta.webp") },
      { store_id: KENKU, product_id: "113", image_url: cdn("bien.webp") },
    ];
    const h = fakeAdmin(rows);
    const cdnFake = fakeCdn({ [cdn("lenta.webp")]: 503, [cdn("bien.webp")]: await webp("#abcdef") });
    const r = await copyProductPhotos(h.admin, { fetchImpl: cdnFake.fetchImpl });
    expect(r).toMatchObject({ ok: true, filas: 3, copiadas: 1, fallidas: 2, pendientes: 2 });
    expect(r.stores[0]!.motivos).toEqual({ http_404: 1, http_503: 1 });
    // La próxima pasada vuelve a intentar las dos que faltan, y solo esas.
    cdnFake.hits.length = 0;
    await copyProductPhotos(h.admin, { fetchImpl: cdnFake.fetchImpl });
    expect(cdnFake.hits.sort()).toEqual([cdn("borrada.webp"), cdn("lenta.webp")].sort());
  });

  it("una subida que Storage rechaza sí pone el cron en rojo", async () => {
    const h = fakeAdmin([{ store_id: KENKU, product_id: "111", image_url: cdn("a.webp") }], { uploadError: true });
    const r = await copyProductPhotos(h.admin, { fetchImpl: fakeCdn({ [cdn("a.webp")]: await webp("#111111") }).fetchImpl });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ copiadas: 0, fallidas: 1, pendientes: 1 });
    expect(r.stores[0]!.motivos).toEqual({ subida: 1 });
    expect(r.errors).toEqual(["Storage rechazó alguna subida."]);
  });

  it("nunca pisa una copia: si otra pasada la subió antes, cuenta como guardada", async () => {
    const url = cdn("a.webp");
    const path = productPhotoPath(KENKU, "111", url);
    const original = new Uint8Array([1, 2, 3]);
    const h = fakeAdmin([{ store_id: KENKU, product_id: "111", image_url: url }], { objects: { [path]: original }, staleList: true });
    const r = await copyProductPhotos(h.admin, { fetchImpl: fakeCdn({ [url]: await webp("#222222") }).fetchImpl });
    expect(r).toMatchObject({ ok: true, guardadas: 1, copiadas: 0, fallidas: 0 });
    expect(h.objects.get(path)).toEqual(original);
  });

  it("respeta su presupuesto: no empieza copias pasado el tiempo y lo que no cupo queda pendiente", async () => {
    const rows: MirrorRow[] = ["1", "2", "3", "4"].map((id) => ({ store_id: KENKU, product_id: id, image_url: cdn(`${id}.webp`) }));
    const h = fakeAdmin(rows);
    const bytes = await webp("#333333", 100);
    let t = 0;
    const slow = (async () => {
      t += 60_000; // cada descarga «tarda» un minuto
      return new Response(new Uint8Array(bytes));
    }) as unknown as typeof fetch;
    const r = await copyProductPhotos(h.admin, { fetchImpl: slow, now: () => t, budgetMs: 90_000, concurrency: 1 });
    expect(r).toMatchObject({ ok: true, filas: 4, copiadas: 2, pendientes: 2, agotado: true });
    // La hora siguiente sigue con lo que faltó.
    t = 0;
    const r2 = await copyProductPhotos(h.admin, { fetchImpl: slow, now: () => t, budgetMs: 90_000, concurrency: 1 });
    expect(r2).toMatchObject({ guardadas: 2, copiadas: 2, pendientes: 0, agotado: false });
  });

  it("cabe en la ruta: presupuesto + una descarga + una subida < maxDuration", () => {
    expect(PRODUCT_PHOTO_COPY_BUDGET_MS + PRODUCT_PHOTO_FETCH_TIMEOUT_MS + PRODUCT_PHOTO_UPLOAD_TIMEOUT_MS).toBeLessThan(
      PRODUCT_PHOTO_COPY_MAX_DURATION_S * 1000,
    );
  });

  it("una subida colgada no retiene la pasada: cuenta como fallida, en rojo, y el reporte sale", async () => {
    const url = cdn("a.webp");
    const h = fakeAdmin([{ store_id: KENKU, product_id: "111", image_url: url }], { uploadHangs: true });
    const r = await copyProductPhotos(h.admin, { fetchImpl: fakeCdn({ [url]: await webp("#555555") }).fetchImpl, uploadTimeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, copiadas: 0, fallidas: 1, pendientes: 1 });
    expect(r.stores[0]!.motivos).toEqual({ subida: 1 });
  });

  it("una foto que el CDN dice más grande que el tope ni se baja", async () => {
    let read = false;
    let cancelled = false;
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(PRODUCT_PHOTO_MAX_SOURCE_BYTES + 1) }),
      body: { cancel: async () => void (cancelled = true) },
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    })) as unknown as typeof fetch;
    expect(await fetchProductPhotoJpeg(cdn("enorme.webp"), fetchImpl)).toEqual({ ok: false, reason: "grande" });
    expect(read).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("`dry` solo cuenta: no crea el bucket, no baja ni sube nada", async () => {
    const url = cdn("a.webp");
    const rows: MirrorRow[] = [
      { store_id: KENKU, product_id: "111", image_url: url },
      { store_id: KENKU, product_id: "112", image_url: cdn("b.webp") },
    ];
    const h = fakeAdmin(rows, { objects: { [productPhotoPath(KENKU, "111", url)]: new Uint8Array([9]) } });
    const cdnFake = fakeCdn({});
    const r = await copyProductPhotos(h.admin, { dry: true, fetchImpl: cdnFake.fetchImpl });
    expect(r).toMatchObject({ ok: true, dry: true, filas: 2, guardadas: 1, copiadas: 0, pendientes: 1 });
    expect(r.sinBucket).toBeUndefined();
    expect(cdnFake.hits).toEqual([]);
    expect(h.calls.upload).toEqual([]);
    expect(h.calls.createBucket).toEqual([]);
  });

  it("`dry` antes de la primera pasada (sin bucket): todo pendiente, sin error", async () => {
    const h = fakeAdmin([{ store_id: KENKU, product_id: "111", image_url: cdn("a.webp") }], { bucket: false, listError: true });
    const r = await copyProductPhotos(h.admin, { dry: true });
    expect(r).toMatchObject({ ok: true, sinBucket: true, filas: 1, guardadas: 0, pendientes: 1 });
    expect(h.calls.list).toEqual([]);
  });

  it("`storeId`: solo esa tienda", async () => {
    const rows: MirrorRow[] = [
      { store_id: KENKU, product_id: "111", image_url: cdn("a.webp") },
      { store_id: AURELA, product_id: "222", image_url: cdn("b.webp") },
    ];
    const h = fakeAdmin(rows);
    const r = await copyProductPhotos(h.admin, { dry: true, storeId: AURELA });
    expect(r.stores.map((s) => s.storeId)).toEqual([AURELA]);
    expect(h.reads[0]!.filters).toContainEqual(["eq", "store_id", AURELA]);
  });

  it("si no se puede leer la carpeta de una tienda, no copia nada de ella y avisa", async () => {
    const h = fakeAdmin([{ store_id: KENKU, product_id: "111", image_url: cdn("a.webp") }], { listError: true });
    const cdnFake = fakeCdn({ [cdn("a.webp")]: await webp("#444444") });
    const r = await copyProductPhotos(h.admin, { fetchImpl: cdnFake.fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.stores[0]).toMatchObject({ error: "bucket", pendientes: 1, copiadas: 0 });
    expect(cdnFake.hits).toEqual([]);
  });

  it("si no se puede leer el espejo: rojo y sin copiar, sin el mensaje de la base", async () => {
    const h = fakeAdmin([], {}, { readError: true });
    const r = await copyProductPhotos(h.admin);
    expect(r).toMatchObject({ ok: false, filas: 0, stores: [] });
    expect(r.errors).toEqual(["No se pudo leer el espejo de fotos."]);
    expect(h.calls.createBucket).toEqual([]);
  });

  it("el reporte no lleva URLs", async () => {
    const h = fakeAdmin([{ store_id: KENKU, product_id: "111", image_url: cdn("a.webp") }]);
    const r = await copyProductPhotos(h.admin, { fetchImpl: fakeCdn({}).fetchImpl });
    expect(JSON.stringify(r)).not.toContain("cdn.shopify.com");
  });
});

describe("leer lo guardado", () => {
  it("los nombres de la carpeta de una tienda; null si Storage no responde", async () => {
    const { storage } = fakeStorage({ objects: { [`${KENKU}/1-a.jpg`]: new Uint8Array([1]), [`${AURELA}/2-b.jpg`]: new Uint8Array([1]) } });
    expect(await storedPhotoNames({ storage } as never, KENKU)).toEqual(new Set(["1-a.jpg"]));
    const broken = fakeStorage({ listError: true });
    expect(await storedPhotoNames({ storage: broken.storage } as never, KENKU)).toBeNull();
  });

  it("lee hasta una página vacía: si Storage da menos por página que lo pedido, no se pierde nada", async () => {
    const objects = Object.fromEntries(["1", "2", "3", "4", "5"].map((id) => [`${KENKU}/${id}-x.jpg`, new Uint8Array([1])]));
    const { storage, calls } = fakeStorage({ objects, pageCap: 2 });
    expect(await storedPhotoNames({ storage } as never, KENKU)).toEqual(new Set(["1-x.jpg", "2-x.jpg", "3-x.jpg", "4-x.jpg", "5-x.jpg"]));
    // 2 + 2 + 1, y la vacía.
    expect(calls.list).toHaveLength(4);
  });

  it("una carpeta sin fin es «no se pudo leer», no una lista a medias", async () => {
    const objects = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`${KENKU}/${i}-x.jpg`, new Uint8Array([1])]));
    const { storage } = fakeStorage({ objects, pageCap: 1 });
    expect(await storedPhotoNames({ storage } as never, KENKU)).toBeNull();
  });

  it("cada llamada a Storage lleva su tope: un Storage colgado no traba un envío ni la ruta", async () => {
    const { storage, calls } = fakeStorage({ objects: { [`${KENKU}/1-a.jpg`]: new Uint8Array([1]) } });
    await storedPhotoNames({ storage } as never, KENKU);
    await readStoredPhoto({ storage } as never, `${KENKU}/1-a.jpg`);
    expect(calls.listParams.length).toBeGreaterThan(0);
    for (const p of [...calls.listParams, ...calls.downloadParams]) {
      expect((p as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    }
    expect(PRODUCT_PHOTO_LIST_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    // La ruta prueba la copia y después el CDN (10 s): la copia tarda poco o nada.
    expect(PRODUCT_PHOTO_DOWNLOAD_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  });

  it("una lectura cortada por su tope es `null`", async () => {
    const storage = {
      from: () => ({
        download: async () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
        list: async () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
      }),
    };
    expect(await readStoredPhoto({ storage } as never, "x/1.jpg")).toBeNull();
    expect(await storedPhotoNames({ storage } as never, KENKU)).toBeNull();
  });

  it("una copia vacía o un Storage caído es `null`, nunca un error", async () => {
    const { storage } = fakeStorage({ objects: { "x/1.jpg": new Uint8Array([7, 8]), "x/2.jpg": new Uint8Array([]) } });
    expect(await readStoredPhoto({ storage } as never, "x/1.jpg")).toEqual(new Uint8Array([7, 8]));
    expect(await readStoredPhoto({ storage } as never, "x/2.jpg")).toBeNull();
    expect(await readStoredPhoto({ storage } as never, "x/3.jpg")).toBeNull();
    const down = fakeStorage({ downloadThrows: true });
    expect(await readStoredPhoto({ storage: down.storage } as never, "x/1.jpg")).toBeNull();
  });
});

/** La fila de `stores` que mira `shopifyGoneForStore`. */
type StoreRow = { shopify_token_enc?: string | null; platform?: string; woo_site_url?: string | null } | null;
/** Kenku y Aurela: token de Shopify y WooCommerce ya conectado (§38). */
const PASA_A_WOO: StoreRow = { shopify_token_enc: "enc:token", platform: "shopify", woo_site_url: "https://kenku.pe" };
/** Una tienda cliente: sigue en Shopify (§35.10). */
const CLIENTE: StoreRow = { shopify_token_enc: "enc:token", platform: "shopify", woo_site_url: null };

/**
 * La fila de la tienda y Storage. `pre0274`: las columnas de WooCommerce no
 * existen y pedirlas da error. `storeError`: la base no contesta.
 */
function storeAdmin(
  row: StoreRow,
  storageOpts: Parameters<typeof fakeStorage>[0] = {},
  opts: { pre0274?: boolean; storeError?: boolean } = {},
) {
  const st = fakeStorage(storageOpts);
  const selects: string[] = [];
  const admin = {
    storage: st.storage,
    from(table: string) {
      expect(table).toBe("stores");
      let columns = "";
      const q: Record<string, unknown> = {};
      q.select = (c: string) => {
        columns = c;
        selects.push(c);
        return q;
      };
      q.eq = (col: string, v: unknown) => {
        expect([col, v]).toEqual(["id", KENKU]);
        return q;
      };
      q.maybeSingle = async () => {
        if (opts.storeError) return { data: null, error: { message: "boom" } };
        if (opts.pre0274 && columns.includes("woo_site_url")) return { data: null, error: { code: "42703", message: "column does not exist" } };
        if (!row) return { data: null, error: null };
        const out: Record<string, unknown> = {};
        for (const c of columns.split(",")) if (c in row) out[c] = (row as Record<string, unknown>)[c];
        return { data: out, error: null };
      };
      return q;
    },
  };
  return { admin: admin as never, ...st, selects };
}

describe("¿Shopify ya no sirve las fotos de esta tienda? (`shopifyGoneForStore`)", () => {
  it.each([
    // [caso, fila, antes del cierre, desde el cierre]
    ["Kenku o Aurela, con WooCommerce conectado", PASA_A_WOO, false, true],
    ["ya en WooCommerce (`platform`)", { ...CLIENTE, platform: "woocommerce" }, false, true],
    ["una tienda cliente, que sigue en Shopify", CLIENTE, false, false],
    ["sin token (Shopify cerró antes: se vacía el token)", { ...CLIENTE, shopify_token_enc: null }, true, true],
    ["con el token en blanco", { ...PASA_A_WOO, shopify_token_enc: "  " }, true, true],
    ["sin la fila de la tienda", null, false, true],
  ] as [string, StoreRow, boolean, boolean][])("%s", async (_, row, antes, despues) => {
    expect(await shopifyGoneForStore(storeAdmin(row).admin, KENKU, ANTES)).toBe(antes);
    expect(await shopifyGoneForStore(storeAdmin(row).admin, KENKU, CUTOFF)).toBe(despues);
  });

  it("si la base no contesta: antes del cierre no (lo de siempre); desde el cierre sí (solo copias)", async () => {
    expect(await shopifyGoneForStore(storeAdmin(PASA_A_WOO, {}, { storeError: true }).admin, KENKU, ANTES)).toBe(false);
    expect(await shopifyGoneForStore(storeAdmin(CLIENTE, {}, { storeError: true }).admin, KENKU, DESPUES)).toBe(true);
    expect(await shopifyGoneForStore({} as never, KENKU, ANTES)).toBe(false);
  });

  it("antes de la 0274 (sin columnas de WooCommerce) cuenta solo el token", async () => {
    const h = storeAdmin(PASA_A_WOO, {}, { pre0274: true });
    expect(await shopifyGoneForStore(h.admin, KENKU, DESPUES)).toBe(false);
    expect(h.selects).toEqual(["shopify_token_enc,platform,woo_site_url", "shopify_token_enc"]);
    const sinToken = storeAdmin({ shopify_token_enc: null }, {}, { pre0274: true });
    expect(await shopifyGoneForStore(sinToken.admin, KENKU, ANTES)).toBe(true);
  });

  it("no lee los demás secretos de la tienda", async () => {
    const h = storeAdmin(PASA_A_WOO);
    await shopifyGoneForStore(h.admin, KENKU, DESPUES);
    expect(h.selects).toEqual(["shopify_token_enc,platform,woo_site_url"]);
  });
});

describe("qué fotos puede usar una cabecera (`productPhotosThatLoad`)", () => {
  const conCopia = { product_id: "111", catalog_title: "Sérum", image_url: cdn("a.webp") };
  const sinCopia = { product_id: "112", catalog_title: "Pulsera", image_url: cdn("b.webp") };
  const objects = { [productPhotoPath(KENKU, "111", cdn("a.webp"))]: new Uint8Array([1]) };

  it("antes del cierre, con Shopify vivo, todas, sin preguntarle a Storage (como siempre)", async () => {
    const h = storeAdmin(PASA_A_WOO, { objects });
    const rows = [conCopia, sinCopia, { product_id: "113", catalog_title: "X" }];
    expect(await productPhotosThatLoad(h.admin, KENKU, rows, ANTES)).toBe(rows);
    expect(h.calls.list).toEqual([]);
  });

  it("desde el cierre (28-10-2026 00:00 UTC, sin margen), en Kenku y Aurela solo las que tienen su copia", async () => {
    const h = storeAdmin(PASA_A_WOO, { objects });
    expect(await productPhotosThatLoad(h.admin, KENKU, [conCopia, sinCopia], CUTOFF)).toEqual([conCopia]);
    expect(await productPhotosThatLoad(h.admin, KENKU, [conCopia, sinCopia], DESPUES)).toEqual([conCopia]);
    // Un milisegundo antes, todavía como siempre.
    expect(await productPhotosThatLoad(h.admin, KENKU, [conCopia, sinCopia], CUTOFF - 1)).toEqual([conCopia, sinCopia]);
  });

  it("una tienda cliente sigue en Shopify: desde el cierre, todas, sin mirar Storage", async () => {
    const h = storeAdmin(CLIENTE, { objects, listError: true });
    const rows = [conCopia, sinCopia];
    expect(await productPhotosThatLoad(h.admin, KENKU, rows, DESPUES)).toBe(rows);
    expect(h.calls.list).toEqual([]);
  });

  it("sin token de Shopify, solo copias a cualquier hora: si Shopify cierra antes, se vacía el token", async () => {
    const h = storeAdmin({ ...PASA_A_WOO, shopify_token_enc: null }, { objects });
    expect(await productPhotosThatLoad(h.admin, KENKU, [conCopia, sinCopia], ANTES)).toEqual([conCopia]);
  });

  it("la copia de una URL vieja no cuenta: la foto cambió y la nueva no está copiada", async () => {
    const h = storeAdmin(PASA_A_WOO, { objects });
    const cambiada = { ...conCopia, image_url: cdn("a.webp").replace("v=1", "v=2") };
    expect(await productPhotosThatLoad(h.admin, KENKU, [cambiada], DESPUES)).toEqual([]);
  });

  it("la copia es de su tienda: la de otra no cuenta", async () => {
    const h = storeAdmin(PASA_A_WOO, { objects: { [productPhotoPath(AURELA, "111", cdn("a.webp"))]: new Uint8Array([1]) } });
    expect(await productPhotosThatLoad(h.admin, KENKU, [conCopia], DESPUES)).toEqual([]);
  });

  it("si Storage no responde, `null`: ni «con foto» ni «sin foto», decide quien llama", async () => {
    const h = storeAdmin(PASA_A_WOO, { objects, listError: true });
    expect(await productPhotosThatLoad(h.admin, KENKU, [conCopia], DESPUES)).toBeNull();
  });

  it("sin filas, ni pregunta", async () => {
    expect(await productPhotosThatLoad({} as never, KENKU, [], DESPUES)).toEqual([]);
  });
});
