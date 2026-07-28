import { describe, it, expect, vi } from "vitest";
import { createDeadline, unlimitedDeadline } from "@/lib/deadline";
import { mapWithConcurrency, orderByStaleness, summarizeRun, logRunSummary } from "@/lib/sync-schedule";
import { runStoreSync } from "@/lib/ingest";
import { encrypt, generateEncryptionKey } from "@/lib/crypto";
import { makeFakeAdmin } from "./helpers/fake-supabase";

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

describe("summarizeRun · la línea que deja rastro en los logs", () => {
  // El resumen es la ÚNICA señal observable de que el presupuesto funciona:
  // `partial` y `remainingMs` van en el cuerpo de la respuesta, y de un cron
  // Vercel solo guarda estado y duración. Si esta línea se rompe, volvemos a
  // quedarnos esperando a que aparezca (o no) un timeout, que tarda semanas.
  const ok = { storeId: "a", partial: false, skipped: [], errors: [] };
  const summary = (over: Partial<Parameters<typeof summarizeRun>[0]> = {}) =>
    summarizeRun({
      budgetMs: 280_000,
      elapsedMs: 0,
      remainingMs: 280_000,
      stores: 1,
      yapeAlerts: 0,
      reports: [ok],
      ...over,
    });

  it("headroomPct dice cuánto margen sobró — 0% es rozar el techo", () => {
    expect(summary({ elapsedMs: 140_000, remainingMs: 140_000 }).headroomPct).toBe(50);
    expect(summary({ elapsedMs: 280_000, remainingMs: 0 }).headroomPct).toBe(0);
  });

  it("junta las etapas saltadas de todas las tiendas, sin repetir", () => {
    const s = summary({
      stores: 2,
      remainingMs: 5_000,
      reports: [
        { storeId: "a", partial: true, skipped: ["leads", "metaAds"], errors: [] },
        { storeId: "b", partial: true, skipped: ["leads"], errors: [] },
      ],
    });
    expect(s.skipped).toEqual(["leads", "metaAds"]);
    expect(s.partial).toBe(true);
    // El detalle por tienda se conserva: sin él no se sabe A QUIÉN le falta tiempo.
    expect(s.perStore.map((p) => p.store)).toEqual(["a", "b"]);
  });

  it("una tienda que revienta cuenta como error aunque no traiga reporte", () => {
    // `mapWithConcurrency` devuelve `{ storeId, error }` para las que lanzaron.
    const s = summary({ reports: [{ storeId: "a", error: "boom" }] });
    expect(s.errorCount).toBe(1);
    expect(s.perStore[0]!.errors).toEqual(["boom"]);
    expect(s.partial).toBe(false);
  });

  it("recorta los errores largos para que la línea siga siendo legible", () => {
    const s = summary({ reports: [{ storeId: "a", errors: ["x".repeat(5_000)] }] });
    expect(s.perStore[0]!.errors[0]!.length).toBe(201); // 200 + el carácter de recorte
  });

  it("el texto de los errores NO se repite fuera de perStore", () => {
    // Una línea de log que la plataforma corta a la mitad deja de ser JSON
    // parseable. El contador arriba, el texto una sola vez abajo.
    const s = summary({
      stores: 2,
      reports: [
        { storeId: "a", errors: ["y".repeat(5_000)] },
        { storeId: "b", errors: ["y".repeat(5_000)] },
      ],
    });
    expect(s.errorCount).toBe(2);
    expect(JSON.stringify(s).length).toBeLessThan(1_000);
  });

  it("sale en una sola línea de JSON: los logs se filtran, no se leen a ojo", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logRunSummary(summary());
      const line = spy.mock.calls[0]![0] as string;
      expect(line).not.toContain("\n");
      expect(JSON.parse(line).tag).toBe("cron/sync");
    } finally {
      spy.mockRestore();
    }
  });

  it("un fallo escribiendo el log no tumba la corrida", () => {
    // La corrida ya terminó bien cuando se llama a esto. Perder el log es malo;
    // convertir un éxito en un 500 por un log es peor.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout roto");
    });
    try {
      expect(() => logRunSummary(summary())).not.toThrow();
    } finally {
      spy.mockRestore();
    }
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

  // Fake mínimo pero completo: además de la tienda tiene que servir la lectura
  // de `sync_state`, porque el cierre de la corrida consulta la deuda de rollup
  // aunque no se haya ingerido nada — una corrida sin presupuesto todavía debe
  // poder saldar lo que dejó pendiente una anterior.
  const admin = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        match: self,
        upsert: self,
        single: async () => (table === "stores" ? { data: storeRow, error: null } : { data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      });
      return chain;
    },
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

describe("runStoreSync · el reparto del presupuesto cuando alcanza para algo", () => {
  // Los dos extremos ya están cubiertos arriba (presupuesto cero) y en las otras
  // rutas (sin presupuesto). Lo que se fija aquí es el medio, que es lo que de
  // verdad pasa en producción: alcanza para unas etapas y no para otras.
  //
  // Sin Kapso ni Meta en la tienda: así el reparto se ve solo entre las pasadas
  // caras de Shopify y las baratas del cierre, sin simular más red.
  const storeRow = {
    id: "store-1",
    org_id: "org-1",
    name: "Tienda",
    shopify_domain: "t.myshopify.com",
    shopify_token_enc: encrypt("shpat_token"),
    status: "active",
    timezone: "America/Lima",
  };

  // Reloj congelado: el presupuesto vale lo mismo en todas las guardas, así que
  // qué etapa cabe y cuál no lo decide su coste y nada más.
  const frozen = (budgetMs: number) => createDeadline(budgetMs, () => 0);

  it("las etapas caras caen primero; las baratas del cierre sobreviven", async () => {
    // 62 s: por encima de los 60 s que pide una etapa de 10 s (coste + reserva
    // de cierre), por debajo de los 95 s que pide una pasada de Shopify.
    const { admin, rpcCalls } = makeFakeAdmin(storeRow);
    const report = await runStoreSync("store-1", admin as never, { deadline: frozen(62_000) });

    expect(report.partial).toBe(true);
    expect(report.skipped).toEqual(["shopify", "shopify_all", "shopify_drafts"]);
    // Y lo que NO está en `skipped` es la otra mitad de la afirmación: las
    // etapas baratas y el cierre del Master sí corrieron.
    expect(report.skipped).not.toContain("order_master");
    expect(rpcCalls.some((c) => c.fn === "recompute_daily_rollups")).toBe(false); // nada que recalcular
  });

  it("con el presupuesto casi agotado se salta TODO menos el rollup", async () => {
    // Esta es la propiedad que sostiene el diseño entero. El rollup es la única
    // etapa sin guarda: tiene sitio reservado en TAIL_RESERVE_MS porque las
    // fechas afectadas no sobreviven a la corrida. Si alguien le añade un
    // `affords`, esos días se quedan con métricas viejas y en silencio — este
    // test es lo que lo impide.
    const { admin, writes, rpcCalls, cursors } = makeFakeAdmin(storeRow);
    // Deuda que dejó una corrida anterior que murió antes de llegar al rollup.
    cursors.set("rollup_pending", "2026-07-01..2026-07-02");

    // 25 s: no llega ni para la etapa más barata (10 s + 50 s de reserva) ni
    // para el cierre del Master (30 s).
    const report = await runStoreSync("store-1", admin as never, { deadline: frozen(25_000) });

    expect(report.partial).toBe(true);
    expect(report.skipped).toContain("order_master");
    expect(report.skipped).toEqual(
      expect.arrayContaining(["shopify", "shopify_drafts", "followups", "waves", "handoffs", "archive"]),
    );

    // Pero la deuda heredada SÍ se salda: el rollup corre igual y se limpia.
    expect(rpcCalls).toContainEqual({
      fn: "recompute_daily_rollups",
      args: { p_store_id: "store-1", p_from: "2026-07-01", p_to: "2026-07-02" },
    });
    const debts = writes.filter((w) => w.source === "rollup_pending");
    expect(debts[debts.length - 1]!.cursor).toBeNull();
  });
});
