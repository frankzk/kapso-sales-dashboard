// Owner, 21-11-2026: «Repro Lima anda cargando súper lento». Los lotes de 100 ids
// iban uno tras otro (15 por tabla con 1.417 pedidos) y la lectura de pendientes
// esperaba etapas que no dependían entre sí. La regla del negocio no cambia: solo
// cuánto se espera. Y queda una línea por carga en los logs para medirlo.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("Repro Lima carga sin esperas en fila", () => {
  const src = read("lib/repro-lima-pending-access.ts");
  const body = src.slice(src.indexOf("export async function loadLimaPending("));

  it("las salidas de Grupo GF y las guías por recoger van junto a las demás lecturas", () => {
    const wave = body.slice(body.indexOf("departureRows, pickupRows] = await Promise.all(["), body.indexOf("for (const d of departureRows)"));
    expect(wave).toContain("loadGfPlanFacts(");
    expect(wave).toContain('admin.rpc("gf_order_departures", { p_order_ids: batch })');
    expect(wave).toContain('.in("courier", ["aliclik", "gf_courier"])');
  });

  it("ningún lote se espera dentro de un bucle", () => {
    expect(body).not.toMatch(/for \(let offset[^\n]*\n[^\n]*await /);
    expect(src).toContain("return (await Promise.all(batches.map(read))).flat();");
  });

  it("los que nunca salieron y los reprogramados por GF se leen junto a los días de GF Courier", () => {
    const start = body.indexOf("const [gfPickups, gfAssigned, neverLeftRows, gfReschedules] = await Promise.all([");
    expect(start).toBeGreaterThan(-1);
    const last = body.slice(start, body.indexOf("]);", start));
    expect(last).toContain("inBatchesOf500(neverLeftCandidates,");
    // Reprogramado por GF tras la novedad (21-11-2026, #KP207270): en la misma espera, sin una más.
    expect(last).toContain("loadGfReschedules(admin, incidentGuides).catch(() => new Map<string, string>())");
  });

  it("cada carga deja su tiempo en los logs", () => {
    const page = read("app/dashboard/pedidos/repro-lima/page.tsx");
    expect(page).toContain('timed(times, "casos", loadReproLima(');
    expect(page).toContain('timed(times, "pendientes", loadLimaPending(');
    expect(page).toContain("console.info(`[repro-lima] carga ${JSON.stringify({ totalMs: Date.now() - started, ...times })}`);");
  });
});

// Owner, 25-11-2026: «ve analizando más de Repro Lima para que quede con carga rápida». Medido ese día: cada
// carga hacía unas 260 consultas pequeñas (cada tabla de a 100 pedidos, 12 lotes con 1.184 pedidos) y tardaba
// 2,3 a 3,6 s. Lo que se esperaba era la fila de consultas, no la base. Ninguna regla cambia: se lee lo mismo.
describe("Repro Lima lee cada tabla en la cuarta parte de las consultas", () => {
  const pending = read("lib/repro-lima-pending-access.ts");
  const program = read("lib/repro-lima-program.ts");
  const access = read("lib/repro-lima-access.ts");
  const flow = read("lib/courier-flow.ts");

  it("los lotes anchos son de 400 ids y un lote cortado por el servidor se parte y se relee", () => {
    expect(flow).toContain("export const COURIER_ROWS_WIDE_BATCH = 400;");
    expect(flow).toContain("const cut = counted ? result.count! > rows.length : rows.length >= COURIER_ROWS_SAFE_RESPONSE;");
    // Un conteo que no es un número de verdad no desactiva la guarda.
    expect(flow).toContain('const counted = typeof result.count === "number" && Number.isFinite(result.count);');
    // Un solo id que no cabe no se devuelve a medias.
    expect(flow).toContain("if (batch.length === 1) throw new Error(");
  });

  it("toda lectura por lotes anchos pide el conteo exacto: sin él no se nota un corte", () => {
    // Cada llamada a la lectura ancha que arma su consulta ahí mismo: del nombre hasta el primer `.in(`.
    const wideReads = (src: string) => [...src.matchAll(/courierRowsByIdsWide(?:<[^(]*>)?\([^]*?\.in\(/g)]
      .map((match) => match[0]).filter((call) => call.includes("admin.from("));
    // En los hechos son dos: el envoltorio `byIds` (hasta su primera lectura) y las rutas.
    for (const [name, src, count] of [["pendientes", pending, 8], ["hechos", program, 2]] as const) {
      const reads = wideReads(src);
      expect(reads.length, name).toBe(count);
      for (const call of reads) expect(call, name).toContain(", EXACT)");
      expect(src, name).toContain('const EXACT = { count: "exact" } as const;');
    }
    // Las ocho lecturas de hechos van por `byIds`, que es la lectura ancha.
    expect(program).toContain("(await courierRowsByIdsWide(ids, read as (chunk: string[]) =>");
    const facts = program.slice(program.indexOf("const [orderRows, orderBase, shipments, stops, programs, events, cases, requests] = await Promise.all(["), program.indexOf("// Tienda → organización → proveedor."));
    expect(facts.match(/byIds</g)?.length).toBe(8);
    expect(facts.match(/, EXACT\)/g)?.length).toBe(8);
  });

  it("las lecturas que ya paginan dentro de cada lote solo ensanchan el lote", () => {
    // Ahí no hay tope que valga: cada lote se lee página por página hasta agotarlo.
    expect(read("lib/lima-management-access.ts")).toContain(".then((data) => ({ data, error: null })), COURIER_ROWS_WIDE_BATCH);");
    expect(read("lib/lima-route-history-access.ts").match(/\.then\(\(data\) => \(\{ data, error: null \}\)\), COURIER_ROWS_WIDE_BATCH\);/g)?.length).toBe(3);
    expect(access).toContain(".then((data) => ({ data, error: null })), COURIER_ROWS_WIDE_BATCH);");
    expect(pending).toContain(".order(\"id\").range(from, to) as unknown as Read<GuideOrigin>).then((data) => ({ data, error: null })), COURIER_ROWS_WIDE_BATCH),");
  });

  it("los pedidos de la etapa no esperan sus páginas en fila", () => {
    const wave = pending.slice(pending.indexOf("const [orders, stores, programs] = await Promise.all(["));
    expect(wave.slice(0, wave.indexOf("]);"))).toContain("allCourierRowsCounted<PendingMasterRow>(");
    // Solo la primera página pide el conteo: con él, una página fuera de rango sería un error.
    expect(wave.slice(0, wave.indexOf("]);"))).toContain("allCourierRowsCounted<PendingMasterRow>((from, to, counted) =>");
    expect(wave.slice(0, wave.indexOf("]);"))).toContain("dispatch_scheduled_on,dispatch_courier\", counted ? EXACT : undefined)");
    const stage = access.slice(access.indexOf("// Oleada 1: la etapa, los casos abiertos, las tiendas y el proveedor."));
    expect(stage.slice(0, stage.indexOf("courierRowsByIds(storeIds"))).toContain("allCourierRowsCounted<ReproOrderRow>(");
    expect(stage.slice(0, stage.indexOf("courierRowsByIds(storeIds"))).toContain('.select(REPRO_ORDER_COLUMNS, counted ? { count: "exact" } : undefined)');
    expect(read("lib/courier-flow.ts")).toContain("const result = await fetchPage(index * size, index * size + size - 1, index === 0);");
    // El orden de las páginas sigue fijo: sin él, dos páginas pedidas a la vez podrían repetir o saltar filas.
    expect(wave.slice(0, wave.indexOf("]);"))).toContain('.order("order_created_at", { ascending: false, nullsFirst: false }).order("order_id")');
    expect(stage.slice(0, stage.indexOf("courierRowsByIds(storeIds"))).toContain('return query.order("order_id").range(from, to)');
  });

  it("las cajas vigentes de Grupo GF, el proveedor y las salidas van en una sola espera", () => {
    const plan = pending.slice(pending.indexOf("async function loadGfPlanFacts("), pending.indexOf("async function loadCourierDetails("));
    const first = plan.slice(plan.indexOf("const [boxed, providerRows, shipments] = await Promise.all(["));
    expect(first.indexOf("ordersInCurrentGfBoxes(admin, inCurso, today),")).toBeGreaterThan(-1);
    // Sin candidatos el proveedor no cuenta, igual que cuando no se leía.
    expect(plan).toContain("const providers = { data: candidates.length ? providerRows.data : [] };");
    // El historial de rutas reportadas ya no hace fila al final.
    expect(plan).toContain("const [requests, items, agreements, tariffs, events, guideOrigins, reportedHistory] = await Promise.all([");
    expect(plan).not.toContain("await loadLimaReportedHistory(");
    expect(plan.indexOf("loadLimaReportedHistory(admin, historyIds),")).toBeGreaterThan(plan.indexOf("const historyIds = operational.filter("));
  });
});

describe("MOM §9.5 cuenta cómo se lee", () => {
  it("lotes de 400, nunca una lista a medias, y ninguna regla cambia", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    for (const text of [
      "**Cuánto tarda cada lectura (owner, 25-11-2026: «que Repro Lima quede con carga rápida»).**",
      "**Cada tabla se lee de a 400 pedidos**: la cuarta parte de las consultas.",
      "**Nunca una lista a medias.** Cada tanda pide a la base cuántas filas hay; si llegaron menos (el servidor corta una respuesta muy grande sin avisar), la tanda se parte en dos y se vuelve a leer.",
      "**Los pedidos de la etapa no esperan sus páginas en fila**",
      "No cambia qué se lee ni ninguna regla: la lista, los conteos y lo que se puede hacer con cada pedido son los mismos.",
    ]) expect(mom).toContain(text);
    // Los 400 del MOM son los del código.
    expect(read("lib/courier-flow.ts")).toContain("export const COURIER_ROWS_WIDE_BATCH = 400;");
  });
});
