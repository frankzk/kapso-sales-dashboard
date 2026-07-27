import { describe, it, expect, vi } from "vitest";
import { createDeadline, unlimitedDeadline } from "@/lib/deadline";
import { mapWithConcurrency, orderByStaleness } from "@/lib/sync-schedule";
import { runStoreSync } from "@/lib/ingest";
import { encrypt, generateEncryptionKey } from "@/lib/crypto";

// Guarda del presupuesto de tiempo del cron de sincronización.
//
// POR QUÉ EXISTE ESTE TEST. `/api/cron/sync` llevaba semanas muriendo a los 300
// segundos: dos tiendas de ~3 minutos cada una, sincronizadas EN SERIE dentro de
// una sola invocación. Cuando Vercel mata la función no queda reporte ni log de
// cierre, solo "Task timed out after 300 seconds" sin decir dónde fue — el peor
// error posible de diagnosticar.
//
// Lo que se protege aquí es la propiedad que lo arregla: quedarse sin tiempo
// tiene que ser una salida ORDENADA (etapas anotadas, reporte devuelto, cero
// llamadas de red de más), no una muerte súbita.

// A nivel de módulo, no en un `beforeAll`: los `describe` se evalúan antes que
// los hooks, y el cuerpo de uno de ellos ya llama a `encrypt`.
process.env.ENCRYPTION_KEY = generateEncryptionKey();

describe("createDeadline · el presupuesto de una corrida", () => {
  it("descuenta el tiempo que pasa", () => {
    let now = 1_000;
    const d = createDeadline(60_000, () => now);
    expect(d.remainingMs()).toBe(60_000);
    now += 25_000;
    expect(d.remainingMs()).toBe(35_000);
  });

  it("no devuelve tiempo negativo cuando se pasa de la raya", () => {
    let now = 0;
    const d = createDeadline(10_000, () => now);
    now = 999_999;
    expect(d.remainingMs()).toBe(0);
    expect(d.expired()).toBe(true);
  });

  it("una etapa que cuesta justo lo que queda NO cabe", () => {
    // La estimación de coste siempre se queda corta antes que larga, así que el
    // empate se resuelve en contra de arrancar la etapa.
    let now = 0;
    const d = createDeadline(30_000, () => now);
    expect(d.hasRoomFor(29_999)).toBe(true);
    expect(d.hasRoomFor(30_000)).toBe(false);
  });

  it("el presupuesto ilimitado deja pasar todo — es lo que usan las rutas sin techo", () => {
    const d = unlimitedDeadline();
    expect(d.hasRoomFor(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(d.expired()).toBe(false);
  });
});

describe("orderByStaleness · a quién le toca primero cuando no alcanza para todas", () => {
  const admin = (rows: { store_id: string; last_run_at: string | null }[]) =>
    ({
      from: () => ({ select: () => ({ in: async () => ({ data: rows }) }) }),
    }) as any;

  it("pone primera a la tienda cuya última sincronización es más vieja", async () => {
    const out = await orderByStaleness(
      admin([
        { store_id: "reciente", last_run_at: "2026-07-27T17:45:00Z" },
        { store_id: "atrasada", last_run_at: "2026-07-27T16:00:00Z" },
      ]),
      ["reciente", "atrasada"],
    );
    expect(out).toEqual(["atrasada", "reciente"]);
  });

  it("compara por la etapa MÁS reciente de cada tienda, no por la primera que llegue", async () => {
    // `sync_state` tiene una fila por fuente (shopify, kapso, leads…). Lo que
    // mide cuán atrasada está una tienda es su fila más nueva.
    const out = await orderByStaleness(
      admin([
        { store_id: "a", last_run_at: "2026-07-27T10:00:00Z" },
        { store_id: "a", last_run_at: "2026-07-27T18:00:00Z" },
        { store_id: "b", last_run_at: "2026-07-27T12:00:00Z" },
      ]),
      ["a", "b"],
    );
    expect(out).toEqual(["b", "a"]);
  });

  it("una tienda que nunca se ha sincronizado va la primera de todas", async () => {
    const out = await orderByStaleness(
      admin([{ store_id: "vieja", last_run_at: "2020-01-01T00:00:00Z" }]),
      ["vieja", "nueva"],
    );
    expect(out).toEqual(["nueva", "vieja"]);
  });

  it("con una sola tienda no consulta nada", async () => {
    const from = vi.fn();
    const out = await orderByStaleness({ from } as any, ["sola"]);
    expect(out).toEqual(["sola"]);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("mapWithConcurrency", () => {
  it("respeta el tope de tareas en vuelo", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBe(2);
  });

  it("conserva el orden de los resultados aunque terminen desordenados", async () => {
    const out = await mapWithConcurrency([30, 1, 20, 2], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 1, 20, 2]);
  });

  it("no se cuelga con la lista vacía", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe("runStoreSync · corrida sin presupuesto", () => {
  const storeRow = {
    id: "store-1",
    org_id: "org-1",
    name: "Tienda",
    shopify_domain: "t.myshopify.com",
    shopify_token_enc: encrypt("shpat_token"),
    kapso_api_key_enc: encrypt("kapso_key"),
    status: "active",
    timezone: "America/Lima",
  };

  const admin = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => (table === "stores" ? { data: storeRow, error: null } : { data: null, error: null }),
        }),
      }),
    }),
  } as any;

  it("sale ordenada: anota las etapas, marca parcial y NO toca la red", async () => {
    // Una corrida a la que ya no le queda tiempo no debe empezar nada. Si algo
    // llamase a `fetch` aquí, sería justo el trabajo que acaba matando la
    // función pasados los 300 s.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("no debería salir a la red sin presupuesto");
    });
    try {
      const report = await runStoreSync("store-1", admin, {
        deadline: createDeadline(0, () => 0),
      });

      expect(report.partial).toBe(true);
      expect(report.errors).toEqual([]);
      // Las etapas caras de ingesta quedan anotadas para la corrida siguiente.
      expect(report.skipped).toEqual(
        expect.arrayContaining(["shopify", "shopify_all", "shopify_drafts", "kapso", "leads"]),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("sin deadline se comporta como antes: no salta ni anota nada", async () => {
    // Las otras rutas que llaman al sync (callback de Shopify, Ajustes) no pasan
    // presupuesto, y no deben cambiar de comportamiento.
    const report = await runStoreSync("desconocida", {
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: { message: "x" } }) }) }),
      }),
    } as any);
    expect(report.partial).toBe(false);
    expect(report.skipped).toEqual([]);
  });
});
