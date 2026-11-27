// Fase 0 del plan de carga (owner, 25-11-2026: «es clave el tiempo de carga del sistema»): cada pantalla pesada
// deja una línea en los logs con lo que tardó en leer, como ya hacía Repro Lima. Sin eso no se puede decir cuánto
// mejoró un cambio. La línea lleva tiempos y conteos, nunca datos de pedidos ni de clientas.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pageLoadTimer, stageClock, stageTimed } from "@/lib/page-load-log";
import { panelPrefetchOrder, sanitizeDashboardPath } from "@/lib/client-performance";
import { DASHBOARD_ROUTES, DASHBOARD_SECTIONS, DASHBOARD_SUBSECTIONS, parseClientPerformanceMetric } from "@/lib/performance-metrics";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/** Un reloj a mano y las líneas escritas. */
function harness() {
  let clock = 1_000;
  const lines: string[] = [];
  return {
    advance: (ms: number) => { clock += ms; },
    lines,
    options: { now: () => clock, log: (line: string) => { lines.push(line); } },
  };
}

describe("la línea de carga", () => {
  it("lleva la pantalla, el total, cada lectura y los conteos", async () => {
    const h = harness();
    const load = pageLoadTimer("leads", h.options);
    let finish: (value: string) => void = () => undefined;
    const cola = load.timed("cola", new Promise<string>((done) => { finish = done; }));
    h.advance(300);
    finish("firma");
    expect(await cola).toBe("firma");
    h.advance(1_200);
    load.done({ filas: 2412 });
    expect(h.lines).toEqual(['[leads] carga {"totalMs":1500,"cola":300,"filas":2412}']);
  });

  it("es la misma forma que la de Repro Lima: se buscan juntas en los logs", () => {
    const h = harness();
    pageLoadTimer("pedidos", h.options).done();
    expect(h.lines[0]).toMatch(/^\[pedidos\] carga \{"totalMs":\d+\}$/);
    expect(read("app/dashboard/pedidos/repro-lima/page.tsx")).toContain("console.info(`[repro-lima] carga ${JSON.stringify({ totalMs: Date.now() - started, ...times })}`);");
  });

  it("una lectura que falla se mide igual y su error sigue saliendo", async () => {
    const h = harness();
    const load = pageLoadTimer("envios", h.options);
    let fail: (error: Error) => void = () => undefined;
    const broken = load.timed("guias", new Promise<never>((_, reject) => { fail = reject; }));
    h.advance(80);
    fail(new Error("sin base"));
    await expect(broken).rejects.toThrow("sin base");
    load.done();
    expect(h.lines).toEqual(['[envios] carga {"totalMs":80,"guias":80}']);
  });

  it("se escribe una sola vez y solo con números", () => {
    const h = harness();
    const load = pageLoadTimer("courier", h.options);
    load.done({ manifiestos: 3, raro: Number.NaN, texto: "Lima" as unknown as number });
    load.done({ manifiestos: 9 });
    expect(h.lines).toEqual(['[courier] carga {"totalMs":0,"manifiestos":3}']);
  });
});

describe("las cuatro pantallas dejan su línea", () => {
  const pages = {
    leads: read("app/dashboard/leads/page.tsx"),
    pedidos: read("app/dashboard/pedidos/page.tsx"),
    courier: read("app/dashboard/courier/page.tsx"),
    envios: read("app/dashboard/envios/page.tsx"),
  };

  it("cada una abre su medición con su nombre y la cierra con conteos", () => {
    for (const [screen, src] of Object.entries(pages)) {
      expect(src, screen).toContain('import { pageLoadTimer } from "@/lib/page-load-log";');
      expect(src, screen).toContain(`const load = pageLoadTimer("${screen}");`);
      expect(src.match(/load\.done\(\{/g)?.length, screen).toBe(1);
    }
    // `tope: 1` solo cuando la lectura llegó a las 20.000 filas (27-11-2026): un número fijo, nada del lead.
    expect(pages.leads).toContain("load.done({ filas: leads.length, ...(queueCapped ? { tope: 1 } : {}) });");
    expect(pages.pedidos).toContain("load.done({ filas: pageData.rows.length });");
    expect(pages.envios).toContain("load.done({ filas: shipments.length });");
    expect(pages.courier).toContain("load.done({ manifiestos: dispatch.manifests.length, devolucionesPendientes: pendingReturns.length });");
  });

  it("mide las lecturas que el análisis señaló como caras", () => {
    for (const label of ["cola", "reparto", "lista", "productos", "coberturaAnterior"]) expect(pages.leads).toContain(`load.timed("${label}", `);
    // Leer la cola y reconocer el producto de cada lead iban en un solo tiempo (25-11-2026).
    expect(pages.leads).toContain('const readPromise = load.timed("lista", getStoreLeadsRead(scope, view, leadsViewLimit(view)));');
    expect(pages.leads).toContain('.then(({ rows }) => load.timed("productos", withProductOpeners(createAdminSupabase(), rows)));');
    for (const label of ["contadores", "pagina", "filtros", "agencias", "confirmacion", "productos", "comprobantes", "pagadoSinAviso", "distritos", "sinUbicacion"]) {
      expect(pages.pedidos).toContain(`load.timed("${label}", `);
    }
    for (const label of ["tarifario", "despacho", "rutas", "devoluciones"]) expect(pages.courier).toContain(`load.timed("${label}", `);
    for (const label of ["contadores", "guias", "reprogramacion", "equipo"]) expect(pages.envios).toContain(`load.timed("${label}", `);
  });

  it("la línea no lleva nada de un pedido ni de una clienta: solo `.length`", () => {
    for (const [screen, src] of Object.entries(pages)) {
      // El aviso del tope de Leads es un número fijo, no un dato: se quita antes de mirar el resto.
      const done = src.slice(src.indexOf("load.done({"), src.indexOf("});", src.indexOf("load.done({")))
        .replace(", ...(queueCapped ? { tope: 1 } : {})", "");
      for (const value of done.split(",").map((part) => part.split(":")[1]?.trim()).filter(Boolean)) {
        expect(value!.replace(/\s*\}?$/, ""), `${screen}: ${value}`).toMatch(/\.length$/);
      }
    }
  });
});

describe("el navegador mide Repro Lima y Courier por separado", () => {
  it("Repro Lima ya no se cuenta como «pedidos», ni Courier como «other»", () => {
    expect(DASHBOARD_SUBSECTIONS).toEqual(["pedidos/repro-lima"]);
    expect(DASHBOARD_SECTIONS).toContain("courier");
    expect(sanitizeDashboardPath("/dashboard/pedidos/repro-lima?ficha=un-id&seccion=reprolima")).toBe("/dashboard/pedidos/repro-lima");
    expect(sanitizeDashboardPath("/dashboard/pedidos?abrir=un-id")).toBe("/dashboard/pedidos");
    expect(sanitizeDashboardPath("/dashboard/courier?tab=rutas")).toBe("/dashboard/courier");
    // Lo que no está en la lista sigue reduciéndose a su sección: nada con ids sale del navegador.
    expect(sanitizeDashboardPath("/dashboard/courier/rutas/4c6522f9-c775")).toBe("/dashboard/courier");
    expect(sanitizeDashboardPath("/dashboard/pedidos/4c6522f9-c775")).toBe("/dashboard/pedidos");
  });

  it("el servidor acepta lo que el navegador manda", () => {
    for (const route of ["/dashboard/pedidos/repro-lima", "/dashboard/courier"]) {
      expect(DASHBOARD_ROUTES).toContain(route);
      expect(parseClientPerformanceMetric({ name: "dashboard:navigation", durationMs: 10, from: "/dashboard/pedidos", to: route })).not.toBeNull();
    }
    expect(parseClientPerformanceMetric({ name: "dashboard:navigation", durationMs: 10, to: "/dashboard/pedidos/otra-cosa" })).toBeNull();
  });

  it("Repro Lima precarga lo mismo que «pedidos»: medir aparte no cambia lo que se pide", () => {
    expect(panelPrefetchOrder("/dashboard/pedidos/repro-lima?ficha=x", false)).toEqual(panelPrefetchOrder("/dashboard/pedidos", false));
    expect(panelPrefetchOrder("/dashboard/pedidos/repro-lima", true)).toEqual(panelPrefetchOrder("/dashboard/pedidos", true));
  });
});

// Owner, 25-11-2026: «que Repro Lima quede con carga rápida». Con los lotes anchos bajó de 2,3–3,6 s a
// 1,6–2,3 s, menos de lo estimado: `casos` y `pendientes` solos no dicen cuál de sus esperas en fila pesa.
describe("las etapas en fila de una lectura", () => {
  it("cada marca anota lo que pasó desde la anterior", () => {
    let clock = 1_000;
    const times: Record<string, number> = {};
    const mark = stageClock(times, () => clock);
    clock += 120;
    mark("c.etapa");
    clock += 900;
    mark("c.hechos");
    mark("c.llamadas");
    expect(times).toEqual({ "c.etapa": 120, "c.hechos": 900, "c.llamadas": 0 });
  });

  it("sin dónde anotar no hace nada: las demás lecturas no miden", async () => {
    const mark = stageClock(undefined);
    expect(() => mark("c.etapa")).not.toThrow();
    expect(await stageTimed(undefined, "p.gf", Promise.resolve(7))).toBe(7);
    await expect(stageTimed(undefined, "p.gf", Promise.reject(new Error("caído")))).rejects.toThrow("caído");
  });

  it("una lectura que va a la vez que otras deja su propio tiempo, también si falla", async () => {
    let clock = 0;
    const times: Record<string, number> = {};
    let finish: (value: string) => void = () => undefined;
    const pending = stageTimed(times, "p.gestion", new Promise<string>((resolve) => { finish = resolve; }), () => clock);
    clock = 340;
    finish("ok");
    expect(await pending).toBe("ok");
    expect(times).toEqual({ "p.gestion": 340 });
    await expect(stageTimed(times, "p.gf", Promise.reject(new Error("caído")), () => clock)).rejects.toThrow("caído");
    expect(times["p.gf"]).toBe(0);
  });

  it("Repro Lima pasa su medición a las dos lecturas, y cada una marca sus esperas", () => {
    const page = read("app/dashboard/pedidos/repro-lima/page.tsx");
    expect(page).toContain('timed(times, "casos", loadReproLima(createAdminSupabase(), scope, new Date(), { attention: true, times })),');
    expect(page).toContain('timed(times, "pendientes", loadLimaPending(createAdminSupabase(), scope, new Date(), times)),');
    // La línea es la misma: los tiempos nuevos entran por `times`.
    expect(page).toContain("console.info(`[repro-lima] carga ${JSON.stringify({ totalMs: Date.now() - started, ...times })}`);");
    const marks = (path: string) => [...read(path).matchAll(/(?:mark|stageTimed)\((?:times, )?"([cp]\.[a-zA-Z.]+)"/g)].map((m) => m[1]);
    expect(marks("lib/repro-lima-access.ts")).toEqual(["c.etapa", "c.filtro", "c.hechos", "c.llamadas"]);
    expect(marks("lib/repro-lima-program.ts")).toEqual(["c.hechos.tablas", "c.hechos.rutas", "c.hechos.armado"]);
    expect(marks("lib/repro-lima-pending-access.ts")).toEqual(["p.gf.salidas", "p.gf.detalle", "p.gf.cajas", "p.etapa", "p.gf", "p.courier", "p.gestion", "p.lecturas", "p.gfDias"]);
    // Solo la pantalla mide: los hechos de un solo pedido no reciben `times`.
    expect(read("lib/repro-lima-program.ts")).toContain("const mark = stageClock(opts.times);");
  });
});
