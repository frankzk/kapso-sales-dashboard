import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// La sincronización completa con la API de Aliclik simulada: lo que importa es
// QUÉ columnas llegan al upsert de `aliclik_skus` cuando la pasada de agencia
// falla, porque solo las columnas enviadas se sobrescriben.

const api = vi.hoisted(() => ({
  agencyFails: false,
}));

vi.mock("@/lib/aliclik", () => ({
  listAllProducts: async (_opts: unknown, p: { isAgency?: boolean }) => {
    if (p.isAgency && api.agencyFails) {
      return { ok: false, error: "Aliclik respondió HTTP 502.", status: 502 };
    }
    return {
      ok: true,
      data: [
        {
          id: 1,
          name: "Fat-Burn Shorts",
          skus: [
            {
              sku: "FB-L",
              ean: "111",
              stockVirtual: 121,
              warehouseId: 7,
              warehouseName: "GRUPO GF",
              ...(p.isAgency ? { formatTimeAgency: "13:00" } : {}),
            },
          ],
        },
      ],
    };
  },
  listAgencies: async () => ({ ok: true, data: [] }),
  listPackageSizes: async () => ({ ok: true, data: [] }),
}));

import { syncAliclikCatalog } from "@/lib/aliclik-catalog";

/** Admin falso: guarda cada upsert y responde vacío a las lecturas. */
function fakeAdmin() {
  const upserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const read = {
    select: () => read,
    eq: () => read,
    gte: () => read,
    order: () => read,
    range: async () => ({ data: [], error: null }),
  };
  const admin = {
    from: (table: string) => ({
      ...read,
      upsert: async (rows: Record<string, unknown>[]) => {
        upserts.push({ table, rows });
        return { error: null, count: 0 };
      },
    }),
  };
  return { admin: admin as unknown as SupabaseClient, upserts };
}

describe("syncAliclikCatalog — pasada de agencia", () => {
  beforeEach(() => {
    api.agencyFails = false;
  });

  it("si la pasada de agencia falla, el upsert no toca la elegibilidad y avisa", async () => {
    api.agencyFails = true;
    const { admin, upserts } = fakeAdmin();

    const report = await syncAliclikCatalog("store-1", { apiToken: "t" }, admin);

    const skus = upserts.find((u) => u.table === "aliclik_skus");
    expect(skus?.rows).toHaveLength(1);
    expect(skus!.rows[0]).not.toHaveProperty("is_agency_eligible");
    expect(skus!.rows[0]).not.toHaveProperty("format_time_agency");
    expect(skus!.rows[0]).toMatchObject({ ean: "111", stock_virtual: 121, store_id: "store-1" });
    // El catálogo normal sí se guardó: el sync no se da por fallido...
    expect(report.ok).toBe(true);
    // ...pero el aviso dice qué pasó con la elegibilidad.
    expect(report.errors.join(" ")).toMatch(/agencia.*se conserva la elegibilidad/i);
  });

  it("con la pasada de agencia completa, la elegibilidad se escribe", async () => {
    const { admin, upserts } = fakeAdmin();

    const report = await syncAliclikCatalog("store-1", { apiToken: "t" }, admin);

    const skus = upserts.find((u) => u.table === "aliclik_skus");
    expect(skus!.rows[0]).toMatchObject({ ean: "111", is_agency_eligible: true, format_time_agency: "13:00" });
    expect(report.errors).toEqual([]);
  });
});
