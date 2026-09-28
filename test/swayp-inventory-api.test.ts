import { describe, expect, it } from "vitest";
import {
  diagnoseInventoryAccess,
  inventoryToEntradasByCity,
  isInventoryAuthError,
  listWarehouses,
  normalizeInventoryRow,
  searchInventory,
  SwaypInventoryError,
  type SwaypInventoryCreds,
} from "@/lib/swayp-inventory-api";

// El contrato de este API es reversado del panel; estas pruebas fijan el
// mapeo que dedujimos (availableAmount → disponible, barCode → codbar, el host
// y los headers) para que un cambio silencioso en el cliente salte acá y no en
// producción. NINGUNA prueba toca la red: `fetchImpl` es falso.

function fakeFetch(routes: Record<string, unknown>, seen?: { url: string; headers: Record<string, string>; body: unknown }[]) {
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
      idWarehouse: "w-tru",
      totalAmount: 5,
      reservedAmount: 2,
      availableAmount: 3,
      inTransitAmount: 1,
      returnAmount: 0,
    });
    expect(r).toMatchObject({ codbar: "AURE001", disponible: 3, enBodega: 5, reservado: 2, enTransito: 1 });
  });

  it("sin availableAmount, Disponible = total - reservado (lo mismo que el panel)", () => {
    const r = normalizeInventoryRow({ barCode: "AURE003", totalAmount: 76, reservedAmount: 1 });
    expect(r.disponible).toBe(75);
  });

  it("normaliza el codbar a mayúsculas y descarta valores no numéricos", () => {
    const r = normalizeInventoryRow({ barCode: " aure004 ", totalAmount: "x", availableAmount: "34" });
    expect(r.codbar).toBe("AURE004");
    expect(r.disponible).toBe(34);
  });
});

describe("searchInventory", () => {
  it("pega al host de inventario, con includeReturns y el idCompany en el cuerpo", async () => {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const rows = await searchInventory(
      creds(
        fakeFetch(
          {
            "inventory/search": [
              { barCode: "AURE001", name: "Candida", idWarehouse: "w-tru", totalAmount: 3, availableAmount: 3 },
              { barCode: "", name: "fila basura", totalAmount: 9 }, // sin codbar: se descarta
            ],
          },
          seen,
        ),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codbar).toBe("AURE001");
    const call = seen[0]!;
    expect(call.url).toContain("swayp-inventory-95701915666.us-central1.run.app");
    expect(call.url).toContain("includeReturns=true");
    expect(call.body).toMatchObject({ idCompany: "IsjvRm8cEqQBFP4r0TxF", codbar: "" });
    // Los headers de auth del panel viajan tal cual.
    expect(call.headers.Authorization).toBe("Bearer TOK123");
    expect(call.headers.email).toBe("fkc@monono.pe");
    expect(call.headers.user).toBe("20610091823");
    expect(call.headers["x-country"]).toBe("PE");
  });

  it("un 401 se reconoce como error de credencial", async () => {
    const fetch401 = (async () => ({ ok: false, status: 401, text: async () => "unauthorized" }) as Response) as unknown as typeof fetch;
    await expect(searchInventory(creds(fetch401))).rejects.toBeInstanceOf(SwaypInventoryError);
    const e = await searchInventory(creds(fetch401)).catch((x) => x);
    expect(isInventoryAuthError(e)).toBe(true);
  });
});

describe("listWarehouses", () => {
  it("lee id y nombre tolerando distintas claves y va al host del panel", async () => {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const ws = await listWarehouses(
      creds(
        fakeFetch(
          {
            "warehouses/byCompany": [
              { id: "w-tru", name: "BODEGA TRUJILLO" },
              { _id: "w-are", nombre: "Bodega Arequipa" },
              { id: "", name: "sin id: se ignora" },
            ],
          },
          seen,
        ),
      ),
    );
    expect(ws).toEqual([
      { id: "w-tru", name: "BODEGA TRUJILLO" },
      { id: "w-are", name: "Bodega Arequipa" },
    ]);
    expect(seen[0]!.url).toContain("us-central1-swayp-co.cloudfunctions.net");
  });
});

describe("diagnoseInventoryAccess", () => {
  it("reporta cada host por separado sin lanzar, distinguiendo el control", async () => {
    // Control (bags) OK en cloudfunctions, pero inventario 403 en run.app: el
    // caso que revela «token válido, host de inventario pide otra credencial».
    const fetchImpl = (async (url: string) => {
      if (url.includes("bags/partner")) return { ok: true, status: 200, text: async () => "[]" } as Response;
      if (url.includes("warehouses/byCompany")) return { ok: true, status: 200, text: async () => "[]" } as Response;
      return { ok: false, status: 403, text: async () => '{"message":"forbidden"}' } as Response;
    }) as unknown as typeof fetch;

    const probes = await diagnoseInventoryAccess(creds(fetchImpl));
    expect(probes).toHaveLength(3);
    expect(probes[0]!).toMatchObject({ ok: true, status: 200, method: "GET" });
    expect(probes[0]!.host).toContain("cloudfunctions.net");
    const inv = probes.find((p) => p.label.includes("inventory/search"))!;
    expect(inv).toMatchObject({ ok: false, status: 403 });
    expect(inv.host).toContain("run.app");
    expect(inv.body).toContain("forbidden");
  });

  it("un error de red queda como status 0, no rompe el diagnóstico", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const probes = await diagnoseInventoryAccess(creds(fetchImpl));
    expect(probes.every((p) => p.status === 0 && !p.ok)).toBe(true);
  });
});

describe("inventoryToEntradasByCity", () => {
  const warehouses = [
    { id: "w-tru", name: "BODEGA TRUJILLO" },
    { id: "w-are", name: "Bodega Arequipa" },
    { id: "w-cusco", name: "BODEGA CUSCO" }, // ciudad no mapeada
  ];

  it("agrupa por ciudad traduciendo idWarehouse → nombre → ciudad", () => {
    const { porCiudad, sinCiudad } = inventoryToEntradasByCity(
      [
        { codbar: "AURE001", nombre: "Candida", idWarehouse: "w-tru", disponible: 3, enBodega: 3, reservado: 0, enTransito: 0, enDevolucion: 0 },
        { codbar: "AURE003", nombre: "Ethiopian", idWarehouse: "w-are", disponible: 75, enBodega: 76, reservado: 1, enTransito: 6, enDevolucion: 6 },
        { codbar: "AURE009", nombre: "otro", idWarehouse: "w-cusco", disponible: 10, enBodega: 10, reservado: 0, enTransito: 0, enDevolucion: 0 },
      ],
      warehouses,
    );
    expect([...porCiudad.keys()].sort()).toEqual(["arequipa", "trujillo"]);
    expect(porCiudad.get("trujillo")).toEqual([
      { codbar: "AURE001", nombre: "Candida", bodega: "BODEGA TRUJILLO", disponible: 3 },
    ]);
    expect(porCiudad.get("arequipa")?.[0]!.disponible).toBe(75);
    // Cusco no se mezcla en ninguna ciudad: se informa aparte.
    expect(sinCiudad).toEqual([{ idWarehouse: "w-cusco", nombre: "BODEGA CUSCO", filas: 1 }]);
  });
});
