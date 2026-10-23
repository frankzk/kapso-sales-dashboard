// Las rutas de las fotos de producto (MOM §39, 23-10-2026): el cron que las
// copia a Storage (app/api/cron/product-photos/route.ts), su lugar en
// vercel.json, y que el espejo diario (app/api/cron/shopify-product-images)
// no toque una tienda sin token — el 28-10 se vacía el de Kenku y Aurela.
// La pasada misma se prueba en test/product-photos.test.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductPhotoCopyReport } from "@/lib/product-photos-copy";

const KENKU = "4c6522f9-c775-4be3-95b0-160a3c16d27a";

const mocks = vi.hoisted(() => ({
  admin: null as unknown,
  report: null as unknown,
  throws: null as unknown,
  creds: null as unknown,
}));

vi.mock("@/lib/db", () => ({ createAdminSupabase: vi.fn(() => mocks.admin) }));
vi.mock("@/lib/product-photos-copy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/product-photos-copy")>();
  return {
    ...actual,
    copyProductPhotos: vi.fn(async () => {
      if (mocks.throws) throw mocks.throws;
      return mocks.report;
    }),
  };
});
vi.mock("@/lib/ingest", () => ({ getStoreCreds: vi.fn(async () => mocks.creds) }));
vi.mock("@/lib/shopify-product-images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shopify-product-images")>();
  return { ...actual, syncShopifyProductImages: vi.fn(actual.syncShopifyProductImages) };
});

const route = await import("@/app/api/cron/product-photos/route");
const {
  copyProductPhotos,
  PRODUCT_PHOTO_COPY_MAX_DURATION_S,
  PRODUCT_PHOTO_COPY_BUDGET_MS,
  PRODUCT_PHOTO_FETCH_TIMEOUT_MS,
  PRODUCT_PHOTO_UPLOAD_TIMEOUT_MS,
} = await import("@/lib/product-photos-copy");
const mirrorRoute = await import("@/app/api/cron/shopify-product-images/route");
const { syncShopifyProductImages } = await import("@/lib/shopify-product-images");

function report(over: Partial<ProductPhotoCopyReport> = {}): ProductPhotoCopyReport {
  return {
    ok: true,
    dry: false,
    ms: 12_000,
    filas: 3,
    guardadas: 1,
    copiadas: 2,
    fallidas: 0,
    pendientes: 0,
    agotado: false,
    stores: [{ storeId: KENKU, filas: 3, guardadas: 1, copiadas: 2, fallidas: 0, motivos: {}, pendientes: 0 }],
    errors: [],
    ...over,
  };
}

const req = (path: string, q = "", auth: string | null = "Bearer cron") =>
  new NextRequest(`https://kapta.test${path}${q}`, { headers: auth ? { authorization: auth } : {} });

describe("/api/cron/product-photos", () => {
  const call = (q = "", auth: string | null = "Bearer cron") => route.GET(req("/api/cron/product-photos", q, auth));

  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "cron");
    vi.stubEnv("VERCEL_ENV", "production");
    mocks.admin = { soy: "admin" };
    mocks.report = report();
    mocks.throws = null;
    vi.mocked(copyProductPhotos).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("corre en Node, sin caché y con 120 s, por GET y por POST", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(PRODUCT_PHOTO_COPY_MAX_DURATION_S);
    // Una copia que empieza al borde del presupuesto: su descarga y su subida.
    expect(PRODUCT_PHOTO_COPY_BUDGET_MS + PRODUCT_PHOTO_FETCH_TIMEOUT_MS + PRODUCT_PHOTO_UPLOAD_TIMEOUT_MS).toBeLessThan(
      route.maxDuration * 1000,
    );
    expect(route.POST).toBe(route.GET);
  });

  it("sin el secreto del cron: 401 y no corre", async () => {
    expect((await call("", null)).status).toBe(401);
    expect((await call("", "Bearer otro")).status).toBe(401);
    expect(copyProductPhotos).not.toHaveBeenCalled();
  });

  it("fuera de producción no copia; con ?dry=1 sí corre, solo contando", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await (await call()).json()).toEqual({ skipped: "not_production" });
    expect(copyProductPhotos).not.toHaveBeenCalled();
    mocks.report = report({ dry: true, copiadas: 0, pendientes: 2 });
    const dry = await call("?dry=1");
    expect(dry.status).toBe(200);
    expect(copyProductPhotos).toHaveBeenCalledWith(mocks.admin, { dry: true });
  });

  it("?storeId: solo un uuid", async () => {
    expect((await call(`?storeId=${KENKU}`)).status).toBe(200);
    expect(copyProductPhotos).toHaveBeenLastCalledWith(mocks.admin, { dry: false, storeId: KENKU });
    for (const bad of ["abc", `${KENKU}x`, ""]) expect((await call(`?storeId=${bad}`)).status, bad).toBe(400);
  });

  it("una sola línea de log con el reporte, sin URLs; con errores, 502", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ok = await call();
    expect(ok.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line.startsWith("[product-photos] ")).toBe(true);
    expect(JSON.parse(line.slice("[product-photos] ".length))).toEqual(mocks.report);
    expect(line).not.toContain("cdn.shopify.com");

    mocks.report = report({ ok: false, errors: ["Storage rechazó alguna subida."] });
    expect((await call()).status).toBe(502);
  });

  it("si la pasada revienta: 500 sin el mensaje", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.throws = new Error("duplicate key value violates … (store_id)=(secreto)");
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secreto");
    expect(String(log.mock.calls[0]![0])).not.toContain("secreto");
  });
});

describe("vercel.json: la copia de las fotos de producto", () => {
  const crons = (
    JSON.parse(readFileSync(resolve(__dirname, "../vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }
  ).crons;

  it("corre cada hora, en el minuto 48", () => {
    expect(crons.filter((c) => c.path === "/api/cron/product-photos")).toEqual([
      { path: "/api/cron/product-photos", schedule: "48 * * * *" },
    ]);
  });

  it("no cae en el minuto de ningún barrido que corre cada hora o más seguido", () => {
    // Cada parte del minuto: `*`, `*/n`, `a-b`, `a-b/n` o un número.
    const minutesOf = (schedule: string): number[] => {
      const [minute, hour] = schedule.split(" ");
      if (hour !== "*" && !hour!.startsWith("*/")) return [];
      const out: number[] = [];
      for (const part of minute!.split(",")) {
        const [range, stepText] = part.split("/");
        const step = stepText === undefined ? 1 : Number(stepText);
        const [from, to] =
          range === "*" ? [0, 59] : range!.includes("-") ? range!.split("-").map(Number) : [Number(range), stepText ? 59 : Number(range)];
        for (let m = from!; m <= to!; m += step) out.push(m);
      }
      return out;
    };
    for (const c of crons.filter((x) => x.path !== "/api/cron/product-photos")) {
      expect(minutesOf(c.schedule), c.path).not.toContain(48);
    }
  });
});

describe("/api/cron/shopify-product-images: una tienda sin token ni se pregunta ni se toca", () => {
  const writes: { table: string; op: string }[] = [];
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "cron");
    writes.length = 0;
    vi.mocked(syncShopifyProductImages).mockClear();
    mocks.admin = {
      from(table: string) {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "gte", "not", "range", "order"]) q[m] = () => q;
        for (const op of ["upsert", "update", "delete", "insert"]) {
          q[op] = () => {
            writes.push({ table, op });
            return q;
          };
        }
        q.then = (res: (r: unknown) => unknown) =>
          Promise.resolve({ data: table === "stores" ? [{ id: KENKU }] : [], error: null }).then(res);
        return q;
      },
    };
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["sin credenciales", null],
    ["con el token vaciado (el 28-10)", { shopify_token: null, shopify_domain: "kenku.myshopify.com" }],
    ["sin dominio", { shopify_token: "shpat_x", shopify_domain: null }],
  ])("%s", async (_, creds) => {
    mocks.creds = creds;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const res = await mirrorRoute.GET(req("/api/cron/shopify-product-images"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, stores: 0, reports: [] });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(syncShopifyProductImages).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe("MOM §39 y DEPLOY.md", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const MOM = read("docs/mom/master-pedidos-v1.md");
  const DEPLOY = read("DEPLOY.md");
  const S39 = flat(MOM.slice(MOM.indexOf("## 39. Fotos de producto de WhatsApp")));

  it("el MOM tiene la sección, con sus partes en orden", () => {
    expect(MOM).toContain("## 39. Fotos de producto de WhatsApp para cuando Shopify ya no responde (23-10-2026)");
    const heads = [...MOM.matchAll(/^### 39\.(\d+) /gm)].map((m) => Number(m[1]));
    expect(heads).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("dice lo que el código hace: bucket privado, ruta con huella, cron, sin pisar ni borrar, y la regla desde el cierre", () => {
    expect(S39).toContain("Bucket **privado** `product-photos`");
    expect(S39).toContain("`<tienda>/<producto>-<huella>.jpg`");
    expect(S39).toContain("16 caracteres del sha256 de `image_url`");
    expect(S39).toContain("**Cada hora, en el minuto 48** (`48 * * * *`)");
    expect(S39).toContain("**Nada se pisa ni se borra.**");
    expect(S39).toContain("una foto **sin copia guardada para su URL actual cuenta como «sin foto»** (`productPhotosThatLoad`)");
    expect(S39).toContain("**una fila con foto conserva la que tenía**");
    expect(S39).toContain("**otra URL tampoco la reemplaza**");
    expect(S39).toContain("`conservados`");
  });

  it("la regla es por tienda: sin token a cualquier hora, y desde el cierre la que pasa a WooCommerce; las cliente no", () => {
    expect(S39).toContain("**Se decide por tienda** (`shopifyGoneForStore`");
    expect(S39).toContain("**sin token de Shopify, a cualquier hora**");
    expect(S39).toContain("**la tienda que pasa a WooCommerce** (§38: `platform = 'woocommerce'`, o su sitio ya guardado en `woo_site_url`)");
    expect(S39).toContain("las tiendas cliente siguen en Shopify (§35.10)");
  });

  it("Storage sin contestar no es «sin foto»: el recordatorio de recojo sin respaldo se reintenta", () => {
    expect(S39).toContain("sin respaldo, **se reintenta**");
    expect(S39).toContain("**se corta** con el error en el reporte");
    expect(flat(MOM)).toContain("sin respaldo la fila **se reintenta** (revisión del 23-10-2026)");
  });

  it("los topes de Storage están escritos", () => {
    expect(S39).toContain("**3 s de tope** (`PRODUCT_PHOTO_DOWNLOAD_TIMEOUT_MS`)");
    expect(S39).toContain("cada subida con 10 s (`PRODUCT_PHOTO_UPLOAD_TIMEOUT_MS`");
    expect(S39).toContain("**El listado lee hasta una página vacía**");
  });

  it("§12 y §34 apuntan a §39", () => {
    expect(flat(MOM)).toContain("desde el cierre de Shopify, solo la foto con su copia guardada en Kapta (§39)");
    expect(flat(MOM)).toContain("**una foto sin copia cuenta como «sin foto»** (§39)");
  });

  it("DEPLOY.md: la entrada del 23-10-2026, después de la 0275 y antes de la entrada de WooCommerce", () => {
    const title = "### 23-10-2026 · Las fotos de producto de WhatsApp, copiadas antes del cierre de Shopify (sin migración, MOM §39)";
    const a = DEPLOY.indexOf("### 23-10-2026 · La foto de los pedidos de Shopify para sus boletas (0275, MOM §35.10)");
    const b = DEPLOY.indexOf(title);
    const c = DEPLOY.indexOf("### 25-10-2026 · Entrada de pedidos de WooCommerce");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    const entry = flat(DEPLOY.slice(b, c));
    expect(entry).toContain("**Sin migración y sin variables de entorno nuevas.**");
    expect(entry).toContain("?dry=1");
    expect(entry).toContain("**Marcha atrás.**");
    // La consulta de progreso arma la misma ruta que `productPhotoPath`.
    expect(entry).toContain("left(encode(sha256(convert_to(p.image_url, 'UTF8')), 'hex'), 16) || '.jpg'");
    expect(flat(DEPLOY)).toContain("`/api/cron/product-photos` — cada hora, en el minuto 48.");
    // El corte del 27-10: WooCommerce conectado o el token vaciado.
    expect(entry).toContain("**El corte del 27-10.**");
    expect(entry).toContain("**WooCommerce conectado** (`woo_site_url` guardado o `platform = 'woocommerce'`) **o el token de Shopify vaciado**");
  });
});

describe("Ajustes: los productos «con foto» del recordatorio de reposición", () => {
  // La página es un componente de servidor con decenas de lecturas: se fija en
  // su fuente que `withImage` sale de la misma regla que decide el envío.
  const PAGE = readFileSync(resolve(process.cwd(), "app/dashboard/[storeId]/settings/page.tsx"), "utf8");

  it("pide la URL de la foto y la pasa por `productPhotosThatLoad`", () => {
    expect(PAGE).toMatch(/from\("shopify_product_images"\)\.select\("product_id,image_url"\)/);
    expect(PAGE).toMatch(/const restockWithImage =\s*\(await productPhotosThatLoad\(\s*admin,\s*storeId,\s*\(restockImages\.data/);
    expect(PAGE).toContain("withImage: restockWithImage.map((r) => String(r.product_id)),");
    expect(PAGE).not.toMatch(/withImage: \(\(restockImages\.data/);
  });
});
