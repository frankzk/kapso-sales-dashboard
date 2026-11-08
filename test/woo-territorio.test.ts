import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WOO_TERRITORIO_META_KEY,
  territorioForOrder,
  territorioRegion,
  wooTerritorio,
  type WooTerritorio,
} from "@/lib/woo-territorio";
import { NARROW_VERSION_BUMP, narrowVersionFilter, recomputeOrderMaster, reconcileOrderMaster } from "@/lib/order-master";
import { MOM_RESOLUTION_VERSION } from "@/lib/order-macro-stage";

// La provincia de un pedido de la web sale del ubigeo que la clienta eligió en
// el formulario (`_cod_territorio`, 08-11-2026, MOM §38.6), no del nombre del
// distrito en `peru_districts`, donde «ayacucho → CORACORA» y «puno → San Roman»
// aprendidos a mano mandaron semanas a los pedidos de esos distritos a la
// provincia de otro sitio.

const AYACUCHO = { codigo: "050101", region: "Ayacucho", provincia: "Huamanga", distrito: "Ayacucho" };

function raw(value: unknown, extra: Record<string, unknown> = {}) {
  return {
    shipping_address: { address1: "Jr. Lima 123", city: "Ayacucho", province: "Ayacucho", ...extra },
    woo: {
      meta_data: [
        { id: 31, key: "_order_number", value: "KP900001" },
        { id: 36, key: WOO_TERRITORIO_META_KEY, value },
      ],
    },
  };
}

describe("wooTerritorio: leer el ubigeo del formulario con desconfianza", () => {
  it("el objeto que manda COD Core", () => {
    expect(wooTerritorio(raw(AYACUCHO))).toEqual({
      code: "050101",
      department: "Ayacucho",
      province: "Huamanga",
      district: "Ayacucho",
    });
  });

  it("también como texto JSON, y con espacios de sobra", () => {
    const t = wooTerritorio(raw(JSON.stringify({ ...AYACUCHO, provincia: "  Huamanga " })));
    expect(t?.province).toBe("Huamanga");
  });

  it("un código numérico recupera el cero; uno mal formado se descarta sin tumbar el resto", () => {
    expect(wooTerritorio(raw({ ...AYACUCHO, codigo: 50101 }))?.code).toBe("050101");
    expect(wooTerritorio(raw({ ...AYACUCHO, codigo: "5-01" }))).toMatchObject({ code: null, province: "Huamanga" });
    expect(wooTerritorio(raw({ ...AYACUCHO, codigo: undefined }))).toMatchObject({ code: null, province: "Huamanga" });
  });

  it("sin meta, sin clave, raro o a medias: null", () => {
    expect(wooTerritorio(null)).toBeNull();
    expect(wooTerritorio("texto")).toBeNull();
    expect(wooTerritorio({ shipping_address: { city: "Ayacucho" } })).toBeNull();
    expect(wooTerritorio({ woo: { meta_data: "no es una lista" } })).toBeNull();
    expect(wooTerritorio({ woo: { meta_data: [null, 3, { key: "_otra", value: AYACUCHO }] } })).toBeNull();
    expect(wooTerritorio(raw("{ roto"))).toBeNull();
    expect(wooTerritorio(raw(["Ayacucho"]))).toBeNull();
    expect(wooTerritorio(raw({ ...AYACUCHO, provincia: "" }))).toBeNull();
    expect(wooTerritorio(raw({ ...AYACUCHO, distrito: null }))).toBeNull();
    expect(wooTerritorio(raw({ ...AYACUCHO, region: 5 }))).toBeNull();
  });

  it("un ubigeo que se contradice no es «el que eligió»", () => {
    // Departamento que no existe.
    expect(wooTerritorio(raw({ ...AYACUCHO, region: "Huamanga" }))).toBeNull();
    // Provincia que se llama como OTRO departamento.
    expect(wooTerritorio(raw({ ...AYACUCHO, provincia: "Arequipa" }))).toBeNull();
    // En Lima, solo sus provincias.
    expect(wooTerritorio(raw({ codigo: "150104", region: "Lima", provincia: "Huaraz", distrito: "Barranco" }))).toBeNull();
    // El código es de otro departamento (04 = Arequipa).
    expect(wooTerritorio(raw({ ...AYACUCHO, codigo: "040101" }))).toBeNull();
    // Callao (07) no es Lima (15) para el código.
    expect(wooTerritorio(raw({ codigo: "150101", region: "Callao", provincia: "Callao", distrito: "Callao" }))).toBeNull();
  });

  it("si la clave viene dos veces manda la última", () => {
    const t = wooTerritorio({
      woo: {
        meta_data: [
          { key: WOO_TERRITORIO_META_KEY, value: { ...AYACUCHO, provincia: "Huanta", distrito: "Huanta", codigo: "050401" } },
          { key: WOO_TERRITORIO_META_KEY, value: AYACUCHO },
        ],
      },
    });
    expect(t?.province).toBe("Huamanga");
  });
});

describe("territorioRegion: el departamento como lo guarda Kapta (las dos Limas)", () => {
  const t = (over: Partial<WooTerritorio>): WooTerritorio => ({
    code: null,
    department: "Lima",
    province: "Lima",
    district: "Barranco",
    ...over,
  });

  it("Lima Metropolitana por el código 1501 o por la provincia Lima", () => {
    expect(territorioRegion(t({ code: "150104" }))).toBe("Lima (provincia)");
    expect(territorioRegion(t({}))).toBe("Lima (provincia)");
  });

  it("el resto del departamento de Lima, y el Callao", () => {
    expect(territorioRegion(t({ code: "150501", province: "Cañete", district: "San Vicente de Cañete" }))).toBe(
      "Lima (departamento)",
    );
    expect(territorioRegion(t({ province: "Huaral", district: "Huaral" }))).toBe("Lima (departamento)");
    expect(territorioRegion(t({ code: "070101", department: "Callao", province: "Callao", district: "Callao" }))).toBe("Callao");
  });

  it("los demás, con su grafía canónica", () => {
    expect(territorioRegion({ code: "120101", department: "Junin", province: "Huancayo", district: "Huancayo" })).toBe("Junín");
    expect(territorioRegion({ code: "050101", department: "Ayacucho", province: "Huamanga", district: "Ayacucho" })).toBe("Ayacucho");
  });
});

describe("territorioForOrder: el ubigeo vale mientras siga siendo el del pedido", () => {
  const t = wooTerritorio(raw(AYACUCHO))!;

  it("mismo departamento y mismo distrito (sin tildes ni mayúsculas): vale", () => {
    expect(territorioForOrder(t, { region: "Ayacucho", district: "AYACUCHO" })).toBe(t);
    expect(territorioForOrder(t, { region: null, district: null })).toBe(t);
  });

  it("la guarda del departamento: otro departamento, no vale", () => {
    expect(territorioForOrder(t, { region: "Lima (provincia)", district: "Ayacucho" })).toBeNull();
  });

  it("el equipo corrigió el distrito: la provincia del ubigeo es de otro lugar, no vale", () => {
    expect(territorioForOrder(t, { region: "Ayacucho", district: "Carmen Alto" })).toBeNull();
  });

  it("un «departamento» que no se reconoce no contradice nada", () => {
    expect(territorioForOrder(t, { region: "Huamanga", district: "Ayacucho" })).toBe(t);
  });

  it("sin ubigeo, null", () => {
    expect(territorioForOrder(null, { region: "Ayacucho", district: "Ayacucho" })).toBeNull();
  });
});

// ── El Master, de punta a punta (stub de Supabase, convención del repo) ─────

interface Tables {
  orders?: any[];
  shipments?: any[];
  order_events?: any[];
  peru_districts?: any[];
  order_geo_overrides?: any[];
}

function stubAdmin(tables: Tables) {
  const upserts: any[][] = [];
  const admin = {
    from(table: string) {
      const rows: any[] = (tables as Record<string, any[]>)[table] ?? [];
      let mutation = false;
      const builder: any = {
        select: () => builder,
        in: () => (mutation ? builder : Promise.resolve({ data: rows, error: null })),
        eq: () => builder,
        order: () => builder,
        range: () => builder,
        limit: () => Promise.resolve({ data: rows, error: null }),
        upsert(batch: any[]) {
          upserts.push(batch);
          return Promise.resolve({ data: null, error: null });
        },
        update() {
          mutation = true;
          return builder;
        },
      };
      return builder;
    },
    rpc(fn: string, args: any) {
      if (fn !== "order_coverage_batch") return Promise.resolve({ data: null, error: null });
      const rows = ((args?.p_rows ?? []) as any[]).map((probe) => ({ order_id: probe.order_id, coverage: "provincia_cod" }));
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return { admin: admin as any, upserts };
}

function wooOrder(orderRaw: unknown) {
  return {
    id: "order-1",
    store_id: "store-a",
    shopify_order_id: "wc-kp-900001",
    name: "#KP900001",
    created_at: "2026-11-07T10:00:00.000Z",
    cancelled_at: null,
    financial_status: "pending",
    shipping_mode: "cod",
    customer_phone: "51987654321",
    total_amount: 149.9,
    raw: orderRaw,
  };
}

async function master(tables: Tables) {
  const stub = stubAdmin(tables);
  await recomputeOrderMaster(stub.admin, ["order-1"], { now: "2026-11-08T12:00:00.000Z" });
  return stub.upserts[0]?.[0];
}

// La fila aprendida mal que se corrigió a mano el 08-11-2026.
const CORACORA = { district_key: "ayacucho", province: "CORACORA", department: "Ayacucho" };

describe("recomputeOrderMaster: corrección manual > ubigeo del formulario > lo demás", () => {
  it("con «ayacucho → CORACORA» aprendido, el pedido de la web sale Huamanga", async () => {
    const row = await master({ orders: [wooOrder(raw(AYACUCHO))], peru_districts: [CORACORA] });
    expect(row).toMatchObject({ district: "Ayacucho", province: "Huamanga", region: "Ayacucho", geo_source: "shopify" });
    expect(row.macro_version).toBe(MOM_RESOLUTION_VERSION);
  });

  it("también manda sobre la provincia de una guía (que pudo copiar la del Master)", async () => {
    const row = await master({
      orders: [wooOrder(raw(AYACUCHO))],
      peru_districts: [CORACORA],
      shipments: [{ id: "s-1", order_id: "order-1", courier: "aliclik", district: "Ayacucho", province: "CORACORA", region: "Ayacucho" }],
    });
    expect(row.province).toBe("Huamanga");
  });

  it("Lima Metropolitana: «Lima (provincia)», provincia Lima", async () => {
    const row = await master({
      orders: [
        wooOrder(
          raw(
            { codigo: "150104", region: "Lima", provincia: "Lima", distrito: "Barranco" },
            { city: "Barranco", province: "Lima (provincia)" },
          ),
        ),
      ],
      peru_districts: [{ district_key: "barranco", province: "arequipa", department: "Arequipa" }],
    });
    expect(row).toMatchObject({ district: "Barranco", province: "Lima", region: "Lima (provincia)" });
  });

  it("la corrección manual del equipo sigue mandando", async () => {
    const row = await master({
      orders: [wooOrder(raw(AYACUCHO))],
      order_geo_overrides: [{ order_id: "order-1", region: "Ayacucho", province: "Huanta", district: "Ayacucho" }],
    });
    expect(row).toMatchObject({ province: "Huanta", geo_source: "manual" });
  });

  it("una corrección con solo el distrito, que es otro: la provincia no sale del ubigeo", async () => {
    const row = await master({
      orders: [wooOrder(raw(AYACUCHO))],
      peru_districts: [{ district_key: "carmen alto", province: "Huamanga", department: "Ayacucho" }],
      order_geo_overrides: [{ order_id: "order-1", region: null, province: null, district: "Carmen Alto" }],
    });
    // Sale del distrito corregido (lo aprendido de Carmen Alto), no de Ayacucho.
    expect(row).toMatchObject({ district: "Carmen Alto", province: "Huamanga", geo_source: "manual" });
    const sinCatalogo = await master({
      orders: [wooOrder(raw({ ...AYACUCHO, provincia: "Huanta", distrito: "Ayacucho", codigo: null }))],
      order_geo_overrides: [{ order_id: "order-1", region: null, province: null, district: "Carmen Alto" }],
    });
    expect(sinCatalogo.province).toBeNull();
  });

  it("la dirección dice otro departamento: el ubigeo no se usa (guarda del departamento)", async () => {
    const row = await master({
      orders: [wooOrder(raw(AYACUCHO, { province: "Lima (provincia)" }))],
      peru_districts: [CORACORA],
    });
    expect(row.province).not.toBe("Huamanga");
    expect(row.region).toBe("Lima (provincia)");
  });

  it("un pedido sin `_cod_territorio` (Shopify, o la web antes de COD Core) sale como antes", async () => {
    const row = await master({
      orders: [wooOrder({ shipping_address: { address1: "Jr. Lima 123", city: "Ayacucho", province: "Ayacucho" } })],
      peru_districts: [{ district_key: "ayacucho", province: "Huamanga", department: "Ayacucho" }],
    });
    expect(row).toMatchObject({ province: "Huamanga", geo_source: "ubigeo" });
  });
});

// ── Cómo se recalcula lo ya guardado: la subida acotada ─────────────────────

describe("NARROW_VERSION_BUMP: mom-v1.40 solo recalcula los pedidos de WooCommerce", () => {
  it("es la versión vigente, sobre la anterior, para los `wc-…`", () => {
    expect(MOM_RESOLUTION_VERSION).toBe("mom-v1.40");
    expect(NARROW_VERSION_BUMP).toEqual({ version: "mom-v1.40", previous: "mom-v1.39", idPrefix: "wc-" });
  });

  it("el filtro: todo lo que no sea v1.40 ni v1.39, y las v1.39 de WooCommerce", () => {
    expect(narrowVersionFilter("mom-v1.40")).toBe(
      'macro_version.not.in.("mom-v1.40","mom-v1.39"),and(macro_version.eq."mom-v1.39",shopify_order_id.like.wc-%)',
    );
  });

  it("se apaga sola en la próxima subida: con mom-v1.41 vuelve la regla de siempre", () => {
    expect(narrowVersionFilter("mom-v1.41")).toBeNull();
    expect(narrowVersionFilter("mom-v1.40", { version: "mom-v1.40", previous: "mom-v1.40", idPrefix: "wc-" })).toBeNull();
  });

  it("la puerta de versión del barrido usa ese filtro, con el mismo tope por tienda", async () => {
    const calls: { table: string; method: string; args: unknown[] }[] = [];
    // La primera lectura de `orders` (los candidatos) trae un pedido para que el
    // barrido llegue a la puerta de versión; todo lo demás vuelve vacío.
    let candidates = [{ id: "order-1" }];
    const admin: any = {
      from(table: string) {
        const data = table === "orders" ? candidates : [];
        if (table === "orders") candidates = [];
        const builder: any = new Proxy(
          {},
          {
            get(_t, method: string) {
              if (method === "then") {
                return (resolveFn: (v: unknown) => void) => resolveFn({ data, error: null });
              }
              return (...args: unknown[]) => {
                calls.push({ table, method, args });
                return builder;
              };
            },
          },
        );
        return builder;
      },
      rpc: () => Promise.resolve({ data: [], error: null }),
    };
    await reconcileOrderMaster(admin, ["store-a"]);
    const versionDoor = calls.filter((c) => c.table === "order_master" && (c.method === "or" || c.method === "neq"));
    expect(versionDoor).toEqual([{ table: "order_master", method: "or", args: [narrowVersionFilter(MOM_RESOLUTION_VERSION)] }]);
    expect(calls.some((c) => c.table === "order_master" && c.method === "limit" && c.args[0] === 250)).toBe(true);
  });
});

describe("MOM y DEPLOY lo cuentan", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8").replace(/\s+/g, " ");

  it("el MOM describe la prioridad y la subida acotada", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    for (const text of [
      "#### La provincia que eligió la clienta en la web (08-11-2026, `mom-v1.40`)",
      "1. **La corrección manual del equipo** (`order_geo_overrides`, «Corregir ubicación»). Manda siempre.",
      "2. **El ubigeo que eligió la clienta en la web** (`_cod_territorio`).",
      "`wooTerritorio`",
      "`territorioForOrder`",
      "`NARROW_VERSION_BUMP`",
    ]) {
      expect(mom.includes(text), text).toBe(true);
    }
  });

  it("DEPLOY.md abre con la entrada", () => {
    const deploy = readFileSync(resolve(__dirname, "../DEPLOY.md"), "utf8");
    const title =
      "### 08-11-2026 · Ubicación: la provincia de la web (ubigeo del formulario) manda y Kapta ya no aprende provincias equivocadas (sin migración, MOM §38.6 y §19.0.1)";
    expect(deploy.indexOf(title)).toBeGreaterThan(0);
    expect(deploy.indexOf(title)).toBeLessThan(deploy.indexOf("### 08-11-2026 · Distrito por revisar"));
  });
});
