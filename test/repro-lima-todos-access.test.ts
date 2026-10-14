// «Todos» de Repro Lima · la lectura (lib/repro-lima-todos-access.ts; MOM §9.5,
// 14-10-2026). Con un cliente de servicio falso (`rpc: vi.fn()`): la RPC recibe
// justo las tiendas del alcance y el día de Lima; un error o un fallo de red
// devuelven null (la tarjeta no aparece) y dejan la línea del log; las filas de
// tiendas fuera del alcance no cuentan. Solo lee: nunca toca una tabla.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { limaClock } from "@/lib/grupo-gf-courier";
import type { ReproScope } from "@/lib/repro-lima-access";
import { loadLimaOpenCounts } from "@/lib/repro-lima-todos-access";

type Admin = Parameters<typeof loadLimaOpenCounts>[0];

const STORE_A = "11111111-1111-4111-8111-111111111111";
const STORE_B = "22222222-2222-4222-8222-222222222222";
const STORE_OUT = "99999999-9999-4999-8999-999999999999";

const scope: ReproScope = { userId: "u-daysi", storeIds: new Set([STORE_A, STORE_B]) };

/** 22:30 del 14-10 en Lima, ya 15-10 en UTC: el día que cuenta es el de Lima. */
const NOW = new Date("2026-10-15T03:30:00Z");

function fakeAdmin(rpc: ReturnType<typeof vi.fn>) {
  const from = vi.fn(() => {
    throw new Error("«Todos» no lee tablas");
  });
  return { admin: { rpc, from } as unknown as Admin, from };
}

/** Una fila tal como la devuelve PostgREST: snake_case, bigint como texto o número. */
function rpcRow(storeId: string, stage: string, substage: string | null, total: number | string, over7: number | string = 0, over30: number | string = 0) {
  return { store_id: storeId, macro_stage: stage, macro_substage: substage, total, over_7: over7, over_30: over30 };
}

let errorSpy: MockInstance<typeof console.error>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe("loadLimaOpenCounts", () => {
  it("la RPC recibe justo las tiendas del alcance y el día de Lima", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const { admin, from } = fakeAdmin(rpc);
    const result = await loadLimaOpenCounts(admin, scope, NOW);

    expect(limaClock(NOW).day).toBe("2026-10-14");
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0]!;
    expect(name).toBe("order_master_lima_open_counts");
    expect(Object.keys(args).sort()).toEqual(["p_store_ids", "p_today"]);
    expect([...args.p_store_ids].sort()).toEqual([STORE_A, STORE_B]);
    expect(Array.isArray(args.p_store_ids)).toBe(true);
    expect(args.p_today).toBe(limaClock(NOW).day);
    expect(args.p_today).not.toBe(NOW.toISOString().slice(0, 10));

    expect(result).toEqual({ today: "2026-10-14", rows: [] });
    expect(from).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("sin `now`, cuenta con el día de Lima de este momento", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
      const result = await loadLimaOpenCounts(fakeAdmin(rpc).admin, scope);
      expect(rpc.mock.calls[0]![1].p_today).toBe("2026-10-14");
      expect(result?.today).toBe("2026-10-14");
    } finally {
      vi.useRealTimers();
    }
  });

  it("devuelve las filas tipadas, con el bigint de texto como número", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        rpcRow(STORE_A, "por_despachar", "listo_para_asignar", "1094", "948", "351"),
        rpcRow(STORE_B, "por_cerrar", "pendiente_liquidacion", 12, 11, 3),
      ],
      error: null,
    });
    const result = await loadLimaOpenCounts(fakeAdmin(rpc).admin, scope, NOW);
    expect(result).toEqual({
      today: "2026-10-14",
      rows: [
        { storeId: STORE_A, stage: "por_despachar", substage: "listo_para_asignar", total: 1094, over7: 948, over30: 351 },
        { storeId: STORE_B, stage: "por_cerrar", substage: "pendiente_liquidacion", total: 12, over7: 11, over30: 3 },
      ],
    });
  });

  it("las filas de tiendas fuera del alcance no cuentan", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        rpcRow(STORE_A, "preparacion", "por_generar_rotulo", 5, 4, 1),
        rpcRow(STORE_OUT, "preparacion", "por_generar_rotulo", 700, 700, 700),
        rpcRow(STORE_OUT, "en_curso", "en_transito", 3),
        rpcRow(STORE_B, "en_curso", "en_reparto", 2, 1, 0),
      ],
      error: null,
    });
    const result = await loadLimaOpenCounts(fakeAdmin(rpc).admin, scope, NOW);
    expect(result).not.toBeNull();
    expect(result!.rows.map((r) => r.storeId)).toEqual([STORE_A, STORE_B]);
    expect(result!.rows.some((r) => r.storeId === STORE_OUT)).toBe(false);
    expect(result!.rows.reduce((sum, r) => sum + r.total, 0)).toBe(7);
  });

  it("un error (por ejemplo, sin la migración 0256) devuelve null y deja la línea del log", async () => {
    const message = "Could not find the function public.order_master_lima_open_counts(p_store_ids, p_today) in the schema cache";
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message } });
    const { admin, from } = fakeAdmin(rpc);
    await expect(loadLimaOpenCounts(admin, scope, NOW)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("repro-lima: conteo de Todos", "PGRST202", message);
    expect(from).not.toHaveBeenCalled();
  });

  it("un error con filas no devuelve filas a medias", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [rpcRow(STORE_A, "preparacion", "por_armar", 1)],
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    });
    await expect(loadLimaOpenCounts(fakeAdmin(rpc).admin, scope, NOW)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("repro-lima: conteo de Todos", "57014", "canceling statement due to statement timeout");
  });

  it("si la llamada lanza, devuelve null y lo deja en el log; nunca propaga", async () => {
    const rejected = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(loadLimaOpenCounts(fakeAdmin(rejected).admin, scope, NOW)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenLastCalledWith("repro-lima: conteo de Todos", "fetch failed");

    const thrown = vi.fn(() => {
      throw new TypeError("admin.rpc is not a function");
    });
    await expect(loadLimaOpenCounts(fakeAdmin(thrown).admin, scope, NOW)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenLastCalledWith("repro-lima: conteo de Todos", "admin.rpc is not a function");

    const odd = vi.fn().mockRejectedValue("sin red");
    await expect(loadLimaOpenCounts(fakeAdmin(odd).admin, scope, NOW)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenLastCalledWith("repro-lima: conteo de Todos", "sin red");
  });

  it("una respuesta que no es una lista deja «Todos» en cero, sin inventar filas", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(loadLimaOpenCounts(fakeAdmin(rpc).admin, scope, NOW)).resolves.toEqual({ today: "2026-10-14", rows: [] });
  });
});

describe("el módulo de la lectura", () => {
  const src = readFileSync(resolve(process.cwd(), "lib/repro-lima-todos-access.ts"), "utf8");

  it("solo importa tipos del acceso de Repro Lima y no relee los hechos de cada pedido", () => {
    expect(src).toContain('import type { ReproScope } from "@/lib/repro-lima-access";');
    expect(src).not.toMatch(/import \{[^}]*\} from "@\/lib\/repro-lima-access"/);
    expect(src).toContain('import type { createAdminSupabase } from "@/lib/db";');
    expect(src).toContain('import { limaClock } from "@/lib/grupo-gf-courier";');
    expect(src).not.toContain("loadReproFacts");
    expect(src).not.toContain("loadReproLima(");
  });

  it("solo lee: una RPC y ninguna escritura", () => {
    expect(src).toContain('rpc("order_master_lima_open_counts"');
    expect(src.match(/\.rpc\(/g)).toHaveLength(1);
    for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".from("]) {
      expect(src).not.toContain(write);
    }
  });
});
