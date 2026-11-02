import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  firstAliclikUbigeo,
  learnedDistrictFits,
  limaProvinceTrusted,
  ubigeoProvinceFor,
} from "@/lib/district-learning";
import { recomputeOrderMaster } from "@/lib/order-master";
import { MOM_RESOLUTION_VERSION } from "@/lib/order-macro-stage";
import {
  departmentFromCapitalProvince,
  departmentKey,
  isKnownDepartment,
  isLimaOrCallaoProvince,
  normalizeDepartment,
  orderDepartmentKey,
  pinInLimaMetro,
} from "@/lib/peru-departamentos";
import { deriveFenixCoverageCity } from "@/lib/shipments";
import {
  isLimaSwaypDestination,
  swaypDestinationContradiction,
  swaypDestinationRefusal,
} from "@/lib/swayp-destination-guard";

/**
 * #KP142611 (02-11-2026, pedido del owner). Un pedido de provincia COD de La
 * Victoria, CHICLAYO, llegó del bot antiguo de Kapso con «Chiclayo» donde
 * Shopify pone el departamento. Con «la victoria → lima» aprendido, el Master
 * resolvió provincia «lima», la salida la copió y la guía de reenvío de Swayp
 * salió a La Victoria de LIMA. MOM §19.0 y §19.0.2.
 */

const PIN_CHICLAYO = { latitude: -6.83, longitude: -79.83 };
const PIN_HUARAZ = { latitude: -9.527, longitude: -77.528 };
const PIN_MIRAFLORES = { latitude: -12.1211, longitude: -77.0297 };
const LIMA_LEARNED = { province: "lima", department: "Lima" };
const UBIGEO_CHICLAYO = { district: "La Victoria", province: "Chiclayo", department: "Lambayeque" };

describe("la provincia capital escrita como departamento", () => {
  it("se lee como su departamento solo para juzgar, sin tocar cómo se muestra", () => {
    expect(departmentFromCapitalProvince("Chiclayo")).toBe("Lambayeque");
    expect(departmentFromCapitalProvince("HUARAZ")).toBe("Áncash");
    expect(departmentFromCapitalProvince("Mariscal  Nieto")).toBe("Moquegua");
    expect(orderDepartmentKey("Chiclayo")).toBe("lambayeque");
    expect(orderDepartmentKey("Huaraz")).toBe("ancash");
    expect(orderDepartmentKey("Lima (provincia)")).toBe("lima");
    // Las guardas de antes no cambian: «Chiclayo» sigue sin ser un departamento.
    expect(isKnownDepartment("Chiclayo")).toBe(false);
    expect(departmentKey("Chiclayo")).toBeNull();
    expect(normalizeDepartment("Chiclayo")).toBe("Chiclayo");
  });

  it("lo ambiguo no se mapea: Bellavista es del Callao y de San Martín", () => {
    expect(departmentFromCapitalProvince("Bellavista")).toBeNull();
    expect(orderDepartmentKey("Bellavista")).toBeNull();
    expect(orderDepartmentKey("Av Mariátegui mercado orizonte")).toBeNull();
  });

  it("provincias de Lima/Callao", () => {
    expect(isLimaOrCallaoProvince("lima")).toBe(true);
    expect(isLimaOrCallaoProvince("LIMA")).toBe(true);
    expect(isLimaOrCallaoProvince("Callao")).toBe(true);
    expect(isLimaOrCallaoProvince("Cañete")).toBe(false);
    expect(isLimaOrCallaoProvince("Chiclayo")).toBe(false);
    expect(isLimaOrCallaoProvince(null)).toBe(false);
  });
});

describe("pinInLimaMetro: la caja conservadora", () => {
  it("dentro, fuera y sin pin", () => {
    expect(pinInLimaMetro(PIN_MIRAFLORES.latitude, PIN_MIRAFLORES.longitude)).toBe(true);
    expect(pinInLimaMetro(-11.87, -77.13)).toBe(true); // Ventanilla
    expect(pinInLimaMetro(-12.48, -76.8)).toBe(true); // Pucusana
    expect(pinInLimaMetro(PIN_CHICLAYO.latitude, PIN_CHICLAYO.longitude)).toBe(false);
    expect(pinInLimaMetro(PIN_HUARAZ.latitude, PIN_HUARAZ.longitude)).toBe(false);
    expect(pinInLimaMetro(null, -77)).toBeNull();
    expect(pinInLimaMetro(0, 0)).toBeNull();
  });
});

describe("limaProvinceTrusted: el homónimo de Lima contra la evidencia del pedido", () => {
  it("#KP142611: La Victoria con el pin en Chiclayo no es Lima", () => {
    expect(limaProvinceTrusted("La Victoria", { region: "Chiclayo", ...PIN_CHICLAYO })).toBe(false);
  });

  it("sin pin, el ubigeo de la primera guía de Aliclik decide", () => {
    expect(limaProvinceTrusted("La Victoria", { region: "Chiclayo", ubigeoDepartment: "Lambayeque" })).toBe(false);
    expect(limaProvinceTrusted("La Victoria", { region: null, ubigeoDepartment: "LIMA" })).toBe(true);
  });

  it("sin pin ni ubigeo, la provincia capital se lee como departamento", () => {
    expect(limaProvinceTrusted("La Victoria", { region: "Chiclayo" })).toBe(false);
    expect(limaProvinceTrusted("Independencia", { region: "Huaraz" })).toBe(false);
  });

  it("Huaraz / Independencia con el pin en Huaraz", () => {
    expect(limaProvinceTrusted("Independencia", { region: "Huaraz", ...PIN_HUARAZ })).toBe(false);
    expect(limaProvinceTrusted("Independencia", { region: "Lima", ...PIN_HUARAZ })).toBe(false);
  });

  it("una región que no es departamento: el homónimo no toma Lima, el resto sí", () => {
    expect(limaProvinceTrusted("La Victoria", { region: "Av Mariátegui mercado orizonte" })).toBe(false);
    expect(limaProvinceTrusted("Comas", { region: "Av Mariátegui mercado orizonte" })).toBe(true);
    expect(limaProvinceTrusted("La Victoria", { region: "La Molina, Lima" })).toBe(true);
    expect(limaProvinceTrusted("La Victoria", { region: "HUACHIPA" })).toBe(true);
    // …y un pin dentro de Lima lo arregla todo.
    expect(limaProvinceTrusted("La Victoria", { region: "Chiclayo", ...PIN_MIRAFLORES })).toBe(true);
  });

  it("los pedidos normales de Lima siguen igual", () => {
    expect(limaProvinceTrusted("Miraflores", { region: "Lima (provincia)", ...PIN_MIRAFLORES })).toBe(true);
    expect(limaProvinceTrusted("La Victoria", { region: "Lima" })).toBe(true);
    expect(limaProvinceTrusted("Miraflores", { region: null })).toBe(true);
  });

  it("fuera de Lima Metropolitana no se juzga", () => {
    expect(limaProvinceTrusted("Huaraz", { region: "Lima", ...PIN_HUARAZ })).toBe(true);
    // Lo de antes sigue igual.
    expect(learnedDistrictFits(LIMA_LEARNED, null, "Miraflores")).toBe(LIMA_LEARNED);
  });
});

describe("el ubigeo de la primera guía de Aliclik", () => {
  const events = [
    {
      kind: "guide_registered",
      courier: "aliclik",
      occurred_at: "2026-10-25T10:00:00Z",
      payload: { ubigeo: { district: "LA VICTORIA", province: "LIMA", department: "LIMA" } },
    },
    {
      kind: "guide_registered",
      courier: "aliclik",
      occurred_at: "2026-10-19T10:00:00Z",
      payload: { ubigeo: UBIGEO_CHICLAYO },
    },
    { kind: "guide_registered", courier: "fenix", occurred_at: "2026-10-01T10:00:00Z", payload: null },
  ];

  it("se toma la primera, no la última", () => {
    expect(firstAliclikUbigeo(events)).toEqual(UBIGEO_CHICLAYO);
    expect(firstAliclikUbigeo([])).toBeNull();
  });

  it("su provincia solo vale si no es Lima y casa con el pedido", () => {
    expect(ubigeoProvinceFor(UBIGEO_CHICLAYO, "Chiclayo")).toBe("Chiclayo");
    expect(ubigeoProvinceFor(UBIGEO_CHICLAYO, "Arequipa")).toBeNull();
    expect(ubigeoProvinceFor({ district: null, province: "LIMA", department: "LIMA" }, null)).toBeNull();
  });
});

// ── El Master, de punta a punta (stub de Supabase, convención del repo) ─────

interface Tables {
  orders?: any[];
  shipments?: any[];
  order_events?: any[];
  peru_districts?: any[];
}

function stubAdmin(tables: Tables, coverage: string) {
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
      const rows = ((args?.p_rows ?? []) as any[]).map((probe) => ({ order_id: probe.order_id, coverage }));
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return { admin: admin as any, upserts };
}

function order(address: Record<string, unknown>) {
  return {
    id: "order-1",
    store_id: "store-a",
    shopify_order_id: "9001",
    name: "#KP142611",
    created_at: "2026-10-18T10:00:00.000Z",
    cancelled_at: null,
    financial_status: "pending",
    shipping_mode: "cod",
    customer_phone: "51987654321",
    total_amount: 149.9,
    raw: { shippingAddress: { address1: "Calle 1", address2: null, name: "Ana", phone: "987654321", ...address } },
  };
}

async function master(tables: Tables, coverage: string) {
  const stub = stubAdmin(tables, coverage);
  await recomputeOrderMaster(stub.admin, ["order-1"], { now: "2026-11-02T12:00:00.000Z" });
  return stub.upserts[0]?.[0];
}

const LEARNED_LIMA = (district: string) => ({ district_key: district, province: "lima", department: "Lima" });

describe("recomputeOrderMaster: la provincia del homónimo", () => {
  it("#KP142611: región «Chiclayo», La Victoria, pin en Chiclayo → no es lima; con el ubigeo, Chiclayo", async () => {
    const tables: Tables = {
      orders: [order({ city: "La Victoria", province: "Chiclayo", ...PIN_CHICLAYO })],
      peru_districts: [LEARNED_LIMA("la victoria")],
      // La salida copió la provincia mal resuelta del Master.
      shipments: [{ id: "s-1", order_id: "order-1", courier: "aliclik", district: "La Victoria", province: "lima", region: "Chiclayo" }],
    };
    const sinUbigeo = await master(tables, "provincia_cod");
    expect(sinUbigeo.province).toBeNull();
    expect(sinUbigeo.region).toBe("Chiclayo");
    expect(sinUbigeo.macro_version).toBe(MOM_RESOLUTION_VERSION);

    const conUbigeo = await master(
      {
        ...tables,
        order_events: [
          {
            order_id: "order-1",
            kind: "guide_registered",
            courier: "aliclik",
            source: "aliclik",
            occurred_at: "2026-10-19T10:00:00.000Z",
            payload: { ubigeo: UBIGEO_CHICLAYO },
          },
        ],
      },
      "provincia_cod",
    );
    expect(conUbigeo.province).toBe("Chiclayo");
    // Y Swayp, derivando de ahí, iría a Chiclayo, no a Lima.
    expect(deriveFenixCoverageCity(conUbigeo.district, conUbigeo.province)).toBe("chiclayo");
  });

  it("Huaraz / Independencia con el pin en Huaraz → no es lima", async () => {
    const row = await master(
      {
        orders: [order({ city: "Independencia", province: "Huaraz", ...PIN_HUARAZ })],
        peru_districts: [LEARNED_LIMA("independencia")],
      },
      "provincia_cod",
    );
    expect(row.province).toBeNull();
    expect(row.region).toBe("Huaraz");
  });

  it("Miraflores con «Lima (provincia)» y el pin en Lima: igual que antes", async () => {
    const row = await master(
      {
        orders: [order({ city: "Miraflores", province: "Lima (provincia)", ...PIN_MIRAFLORES })],
        peru_districts: [LEARNED_LIMA("miraflores")],
      },
      "lima",
    );
    expect(row.province).toBe("lima");
    expect(row.region).toBe("Lima (provincia)");
  });

  it("La Victoria con «Lima» y sin pin: igual que antes", async () => {
    const row = await master(
      {
        orders: [order({ city: "La Victoria", province: "Lima" })],
        peru_districts: [LEARNED_LIMA("la victoria")],
      },
      "lima",
    );
    expect(row.province).toBe("lima");
  });

  it("sin región, sin pin: como siempre, lo aprendido vale (provincia y región)", async () => {
    const row = await master(
      {
        orders: [order({ city: "La Victoria", province: null })],
        peru_districts: [LEARNED_LIMA("la victoria")],
      },
      "lima",
    );
    expect(row.province).toBe("lima");
    expect(row.region).toBe("Lima");
  });

  it("la corrección manual manda sobre todo", async () => {
    const stub = stubAdmin(
      {
        orders: [order({ city: "La Victoria", province: "Chiclayo", ...PIN_CHICLAYO })],
        peru_districts: [LEARNED_LIMA("la victoria")],
      },
      "provincia_cod",
    );
    const from = stub.admin.from;
    stub.admin.from = (table: string) => {
      if (table !== "order_geo_overrides") return from(table);
      const b: any = {
        select: () => b,
        in: () =>
          Promise.resolve({
            data: [{ order_id: "order-1", region: "Lambayeque", province: "Chiclayo", district: "La Victoria" }],
            error: null,
          }),
      };
      return b;
    };
    await recomputeOrderMaster(stub.admin, ["order-1"], { now: "2026-11-02T12:00:00.000Z" });
    expect(stub.upserts[0]?.[0]?.province).toBe("Chiclayo");
  });
});

// ── La guarda de Swayp ───────────────────────────────────────────────────────

const MENSAJE_FINAL = "Revisa la ubicación del pedido (Corregir ubicación) antes de crear la guía.";

describe("swaypDestinationContradiction: Lima para un pedido que no es de Lima", () => {
  it("#KP142611: La Victoria + «lima» copiado sale a Lima y se rechaza", () => {
    const city = deriveFenixCoverageCity("La Victoria", "lima");
    expect(city).toBe("lima");
    const r = swaypDestinationContradiction(city, { coverage: "provincia_cod", region: "Chiclayo", ...PIN_CHICLAYO });
    expect(r).toBe(
      "Destino contradictorio: la guía Swayp saldría a Lima, pero el pedido es de Chiclayo (Lambayeque), Provincia COD. " +
        MENSAJE_FINAL,
    );
  });

  it("cada señal basta sola", () => {
    expect(swaypDestinationContradiction("lima", { coverage: "agencia" })).toContain("el pedido es de Agencia.");
    expect(swaypDestinationContradiction("lima", { region: "Arequipa" })).toContain("el pedido es de Arequipa.");
    expect(swaypDestinationContradiction("callao", { region: "Huaraz" })).toContain("el pedido es de Huaraz (Áncash).");
    expect(swaypDestinationContradiction("lima", { coverage: "lima", region: "Lima", ...PIN_HUARAZ })).toContain(
      "el pedido es de una ubicación fuera de Lima (-9.53, -77.53).",
    );
  });

  it("una guía de provincia para un pedido de provincia sigue saliendo (Chiclayo es ciudad Fenix)", () => {
    const city = deriveFenixCoverageCity("La Victoria", "Chiclayo");
    expect(city).toBe("chiclayo");
    expect(isLimaSwaypDestination(city)).toBe(false);
    expect(swaypDestinationContradiction(city, { coverage: "provincia_cod", region: "Chiclayo", ...PIN_CHICLAYO })).toBeNull();
  });

  it("los pedidos de Lima siguen saliendo", () => {
    expect(
      swaypDestinationContradiction("lima", { coverage: "lima", region: "Lima (provincia)", ...PIN_MIRAFLORES }),
    ).toBeNull();
    expect(swaypDestinationContradiction("lima", { coverage: "lima", region: "Lima", latitude: null, longitude: null })).toBeNull();
    expect(swaypDestinationContradiction("lima", null)).toBeNull();
  });
});

function guardAdmin(result: { data: unknown; error: { message: string } | null }) {
  const reads: string[] = [];
  const admin = {
    from(table: string) {
      reads.push(table);
      const b: any = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve(result) };
      return b;
    },
  };
  return { admin: admin as any, reads };
}

describe("swaypDestinationRefusal: lee la fila del Master", () => {
  it("rechaza con la fila del #KP142611", async () => {
    const { admin, reads } = guardAdmin({
      data: { coverage: "provincia_cod", region: "Chiclayo", ...PIN_CHICLAYO },
      error: null,
    });
    expect(await swaypDestinationRefusal(admin, "order-1", "lima")).toMatch(/^Destino contradictorio/);
    expect(reads).toEqual(["order_master"]);
  });

  it("un destino de provincia no lee nada", async () => {
    const { admin, reads } = guardAdmin({ data: null, error: null });
    expect(await swaypDestinationRefusal(admin, "order-1", "chiclayo")).toBeNull();
    expect(reads).toEqual([]);
  });

  it("si no puede leer, no deja pasar la guía a Lima", async () => {
    const { admin } = guardAdmin({ data: null, error: { message: "timeout" } });
    expect(await swaypDestinationRefusal(admin, "order-1", "lima")).toContain("No se pudo comprobar el destino");
  });

  it("sin fila del Master no hay con qué juzgar", async () => {
    const { admin } = guardAdmin({ data: null, error: null });
    expect(await swaypDestinationRefusal(admin, "order-1", "lima")).toBeNull();
  });
});

describe("la guarda está en cada punto que crea una guía Swayp", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

  it("reenvío/reprogramación, guía directa y la última puerta de la API", () => {
    const reenvio = read("lib/swayp-reenvio.ts");
    const api = reenvio.slice(reenvio.indexOf("export async function createFenixGuideViaApi"));
    expect(api.slice(0, api.indexOf("buildSwaypGuideInput("))).toContain(
      "swaypDestinationRefusal(args.admin, args.orderId, args.city)",
    );
    const repro = reenvio.slice(reenvio.indexOf("export async function swaypGuideForReprogram"));
    expect(repro.slice(0, repro.indexOf("evaluateDirectFenixStock("))).toContain(
      "swaypDestinationRefusal(admin, order.id, city)",
    );
    const directa = read("lib/swayp-directa.ts");
    expect(directa.slice(0, directa.indexOf("createFenixGuideViaApi({"))).toContain(
      "swaypDestinationRefusal(admin, order.id, city)",
    );
    // Los automáticos pasan por createFenixGuideViaApi / emitirGuiaSwaypDirecta.
    expect(read("lib/swayp-auto-server.ts")).toContain("createFenixGuideViaApi(");
    expect(read("lib/swayp-por-confirmar-auto-server.ts")).toContain("emitirGuiaSwaypDirecta(");
  });

  it("el Master usa la guarda del homónimo", () => {
    const om = read("lib/order-master.ts");
    expect(om).toContain("limaProvinceTrusted(district, {");
    expect(om).toContain("firstAliclikUbigeo(orderEvents)");
  });
});

describe("MOM y versión", () => {
  it("el MOM cuenta las dos reglas y la versión sube", () => {
    const mom = readFileSync(resolve(__dirname, "../docs/mom/master-pedidos-v1.md"), "utf8");
    expect(mom).toContain("**El homónimo de Lima contra el pin y la región (02-11-2026, owner, #KP142611,");
    expect(mom).toContain("**Una guía Swayp a Lima para un pedido que no es de Lima no se crea");
    expect(mom).toContain("`limaProvinceTrusted`");
    expect(mom).toContain("`lib/swayp-destination-guard.ts`");
    expect(MOM_RESOLUTION_VERSION).toBe("mom-v1.36");
  });
});
