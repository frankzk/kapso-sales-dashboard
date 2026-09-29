import { describe, expect, it } from "vitest";
import {
  ciudadDeWarehouse,
  diagnoseInventoryAccess,
  fetchInventoryByCity,
  groupInventoryByCity,
  isInventoryAuthError,
  listWarehouses,
  normalizeInventoryRow,
  searchInventory,
  SwaypInventoryError,
  type SwaypInventoryCreds,
  type SwaypWarehouse,
} from "@/lib/swayp-inventory-api";

// El contrato de este API es reversado del panel; estas pruebas fijan el mapeo
// que dedujimos (availableAmount → disponible, barCode → codbar, el host de
// cloudfunctions, los headers) para que un cambio silencioso salte acá y no en
// producción. NINGUNA prueba toca la red: `fetchImpl` es falso.

function fakeFetch(
  routes: Record<string, unknown>,
  seen?: { url: string; headers: Record<string, string>; body: unknown }[],
) {
  return (async (url: string, init: RequestInit) => {
    seen?.push({
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, text: async () => "no route" } as Response;
    return { ok: true, status: 200, json: async () => routes[key] } as Response;
  }) as unknown as typeof fetch;
}

const creds = (fetchImpl: typeof fetch): SwaypInventoryCreds => ({
  token: "TOK123",
  email: "fkc@monono.pe",
  user: "20610091823",
  idCompany: "IsjvRm8cEqQBFP4r0TxF",
  country: "PE",
  fetchImpl,
});

describe("normalizeInventoryRow", () => {
  it("Disponible es availableAmount cuando viene", () => {
    const r = normalizeInventoryRow({
      barCode: "aure001",
      name: "Candida Cleanse",
      totalAmount: 5,
      reservedAmount: 2,
      availableAmount: 3,
    });
    expect(r).toMatchObject({ codbar: "AURE001", disponible: 3, enBodega: 5, reservado: 2 });
  });

  it("sin availableAmount, Disponible = total - reservado", () => {
    expect(normalizeInventoryRow({ barCode: "AURE003", totalAmount: 76, reservedAmount: 1 }).disponible).toBe(75);
  });
});

describe("ciudadDeWarehouse", () => {
  it("resuelve por nombre cuando lo hay", () => {
    expect(ciudadDeWarehouse({ name: "BODEGA TRUJILLO" })).toBe("trujillo");
  });

  it("con nombre vacío, resuelve por el código INEI de ciudad", () => {
    // Arequipa cercado = 040101 (la respuesta real trae nombre vacío + ese código).
    expect(ciudadDeWarehouse({ name: "", ciudad: "040101" })).toBe("arequipa");
  });

  it("Puno (210101) se sirve desde Juliaca", () => {
    expect(ciudadDeWarehouse({ ciudad: "210101" })).toBe("juliaca");
  });

  it("último recurso: rastrea la ciudad dentro de la dirección", () => {
    expect(ciudadDeWarehouse({ name: "", ciudad: "", direccion: "Av. Ejército 1015, Cayma, Arequipa" })).toBe(
      "arequipa",
    );
  });

  it("null cuando ninguna pista sirve", () => {
    expect(ciudadDeWarehouse({ name: "BODEGA CUSCO" })).toBeNull();
  });
});

describe("listWarehouses", () => {
  it("lee idBodega y resuelve la ciudad aunque el nombre venga vacío", async () => {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const ws = await listWarehouses(
      creds(
        fakeFetch(
          {
            "warehouses/byCompany": [
              { idBodega: "194", nombre: "", ciudad: "040101", direccion: "Av. Ejército 1015, Cayma, Arequipa" },
              { idBodega: "200", nombre: "BODEGA TRUJILLO", ciudad: "130101", direccion: "" },
              { idBodega: "300", nombre: "", ciudad: "999999", direccion: "Parque industrial s/n" }, // no mapea
            ],
          },
          seen,
        ),
      ),
    );
    expect(ws).toEqual([
      { id: "194", name: "", ciudadInei: "040101", direccion: "Av. Ejército 1015, Cayma, Arequipa", city: "arequipa" },
      { id: "200", name: "BODEGA TRUJILLO", ciudadInei: "130101", direccion: "", city: "trujillo" },
      { id: "300", name: "", ciudadInei: "999999", direccion: "Parque industrial s/n", city: null },
    ]);
    // Va al host de cloudfunctions, no a run.app.
    expect(seen[0]!.url).toContain("us-central1-swayp-co.cloudfunctions.net");
  });
});

describe("searchInventory", () => {
  it("pega a inventory/search EN CLOUDFUNCTIONS (no run.app), con headers de navegador", async () => {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const rows = await searchInventory(
      creds(
        fakeFetch(
          { "inventory/go/inventory/search": [{ barCode: "AURE001", availableAmount: 3, name: "Candida" }] },
          seen,
        ),
      ),
      { warehouse: "194" },
    );
    expect(rows).toHaveLength(1);
    const call = seen[0]!;
    expect(call.url).toContain("us-central1-swayp-co.cloudfunctions.net");
    expect(call.url).not.toContain("run.app");
    expect(call.url).toContain("v1/inventory/go/inventory/search?includeReturns=true");
    expect(call.body).toMatchObject({ warehouse: "194", codbar: "", idCompany: "IsjvRm8cEqQBFP4r0TxF" });
    expect(call.headers.Authorization).toBe("Bearer TOK123");
    expect(call.headers.Origin).toBe("https://ce.swayp.co");
    expect(call.headers["User-Agent"]).toContain("Chrome");
  });

  it("un 401 se reconoce como error de credencial", async () => {
    const fetch401 = (async () => ({ ok: false, status: 401, text: async () => "unauthorized" }) as Response) as unknown as typeof fetch;
    const e = await searchInventory(creds(fetch401)).catch((x) => x);
    expect(e).toBeInstanceOf(SwaypInventoryError);
    expect(isInventoryAuthError(e)).toBe(true);
  });
});

const WAREHOUSES: SwaypWarehouse[] = [
  { id: "194", name: "", ciudadInei: "040101", direccion: "…Arequipa", city: "arequipa" },
  { id: "200", name: "BODEGA TRUJILLO", ciudadInei: "130101", direccion: "", city: "trujillo" },
  { id: "300", name: "", ciudadInei: "080101", direccion: "Parque industrial", city: null },
];

describe("groupInventoryByCity", () => {
  it("reparte por idWarehouse, suma lotes del mismo codbar y aparta lo que no mapea", () => {
    const rows = [
      { barCode: "AURE003", availableAmount: 70, name: "Ethiopian", idWarehouse: "194" },
      { barCode: "AURE003", availableAmount: 5, name: "Ethiopian", idWarehouse: "194" }, // otro lote
      { barCode: "AURE001", availableAmount: 3, name: "Candida", idWarehouse: "200" },
      { barCode: "AURE001", availableAmount: 9, name: "Candida", idWarehouse: "300" }, // ciudad sin mapear
      { barCode: "AURE001", availableAmount: 1, name: "Candida", idWarehouse: "999" }, // bodega fuera de la lista
      { barCode: "AURE001", availableAmount: 1, name: "Candida", idWarehouse: "999" },
    ].map(normalizeInventoryRow);

    const { porCiudad, sinCiudad } = groupInventoryByCity(rows, WAREHOUSES);
    expect([...porCiudad.keys()].sort()).toEqual(["arequipa", "trujillo"]);
    expect(porCiudad.get("arequipa")).toEqual([
      { codbar: "AURE003", nombre: "Ethiopian", bodega: "arequipa", disponible: 75 },
    ]);
    expect(porCiudad.get("trujillo")).toEqual([
      { codbar: "AURE001", nombre: "Candida", bodega: "BODEGA TRUJILLO", disponible: 3 },
    ]);
    expect(sinCiudad).toEqual([
      { idWarehouse: "300", nombre: "", ciudadInei: "080101", direccion: "Parque industrial", filas: 1 },
      { idWarehouse: "999", nombre: "", ciudadInei: "", direccion: "", filas: 2 },
    ]);
  });
});

describe("fetchInventoryByCity", () => {
  it("lee TODO en una sola llamada (warehouse vacío) y agrupa por ciudad", async () => {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const { porCiudad, totalFilas, muestra } = await fetchInventoryByCity(
      creds(
        fakeFetch(
          {
            "inventory/go/inventory/search": [
              { barCode: "AURE003", availableAmount: 75, name: "Ethiopian", idWarehouse: "194" },
              { barCode: "AURE001", availableAmount: 3, name: "Candida", idWarehouse: "200" },
            ],
          },
          seen,
        ),
      ),
      WAREHOUSES,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toMatchObject({ warehouse: "" });
    expect(totalFilas).toBe(2);
    expect(muestra).toHaveLength(2);
    expect(porCiudad.get("arequipa")?.[0]!.disponible).toBe(75);
    expect(porCiudad.get("trujillo")?.[0]!.disponible).toBe(3);
  });
});

describe("diagnoseInventoryAccess", () => {
  it("reporta bodegas e inventario por separado, ambos en cloudfunctions", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("warehouses/byCompany")) return { ok: true, status: 200, text: async () => "[]" } as Response;
      return { ok: false, status: 401, text: async () => '{"message":"Invalid or missing API Key"}' } as Response;
    }) as unknown as typeof fetch;

    const probes = await diagnoseInventoryAccess(creds(fetchImpl));
    expect(probes).toHaveLength(2);
    expect(probes[0]!).toMatchObject({ ok: true, status: 200 });
    expect(probes[0]!.host).toContain("cloudfunctions.net");
    const inv = probes.find((p) => p.label.includes("inventory/search"))!;
    expect(inv.host).toContain("cloudfunctions.net");
    expect(inv.host).not.toContain("run.app");
  });

  it("un error de red queda como status 0, no rompe el diagnóstico", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const probes = await diagnoseInventoryAccess(creds(fetchImpl));
    expect(probes.every((p) => p.status === 0 && !p.ok)).toBe(true);
  });
});
