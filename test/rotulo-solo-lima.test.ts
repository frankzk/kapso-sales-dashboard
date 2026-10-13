import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { labelCreatesOutput, nonLimaLabelMessage } from "@/lib/labels/resolve-output";
import {
  COVERAGE_CHANGED_KIND,
  coverageChangeEvents,
  coverageChangeNote,
  recordCoverageChanges,
  type CoverageSnapshot,
} from "@/lib/coverage-change";

/**
 * EL CASO (13-10-2026). Mily seleccionó una tanda en el Master y pulsó
 * «Descargar rótulos». A los pedidos de Provincia COD sin guía —#KP141065 entre
 * ellos— les nació una salida «por definir» con un rótulo interno que no iba a
 * ningún lado: en provincia la caja viaja con el rótulo del courier. En la
 * pantalla se leía «Guía actual · Por_definir · pendiente», y la operadora
 * creyó que el sistema había generado una guía sola. Medido en 30 días: de
 * unas 4.200 guías de provincia y agencia, 19 pasaron por un rótulo interno.
 *
 * Y la pregunta del owner: el pedido MAL clasificado —«Provincia COD» que en
 * realidad es de Lima— se corrige por la vía de siempre y queda registrado.
 */

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

describe("solo Lima crea la salida interna", () => {
  it("Lima sí; provincia, agencia y lo desconocido no", () => {
    expect(labelCreatesOutput("lima")).toBe(true);
    for (const op of ["provincia_cod", "agencia", "desconocida", null, undefined, ""]) {
      expect(labelCreatesOutput(op), String(op)).toBe(false);
    }
  });

  it("el aviso nombra el pedido, la salida correcta y la puerta para el mal clasificado", () => {
    const m = nonLimaLabelMessage("#KP141065", "provincia_cod");
    expect(m).toContain("#KP141065 es de Provincia COD");
    expect(m).toContain("la caja viaja con el rótulo del courier");
    expect(m).toContain("Crea su guía desde el pedido");
    // Sin atajo para forzar el rótulo: la salida es corregir la ubicación.
    expect(m).toContain("corrige su ubicación");
    expect(m).toContain("el cambio queda registrado");
    expect(nonLimaLabelMessage(null, "agencia")).toMatch(/^Este pedido es de Agencia/);
  });

  it("en el servidor: la comprobación va DESPUÉS de releer las salidas y solo frena CREAR", () => {
    const src = read("app/dashboard/pedidos/actions.ts");
    const body = src.slice(src.indexOf("export async function resolveLabelsForOrders("), src.indexOf("// Salidas en lote"));
    const fresh = body.indexOf("decision = decideLabelAction(freshRows, decisionCtx);");
    const reuse = body.indexOf('if (decision.kind === "reuse") {');
    const gate = body.indexOf('if (decision.kind === "create" && !limaOrders.has(orderId)) {');
    const create = body.indexOf("const result = await createManualRouteOutput(orderId, {");
    expect(fresh).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(fresh);
    // Reimprimir una salida que ya está con la empresa no cambia: va antes.
    expect(reuse).toBeGreaterThan(-1);
    expect(reuse).toBeLessThan(gate);
    expect(gate).toBeLessThan(create);
    expect(body.slice(gate, gate + 400)).toContain("nonLimaLabelMessage(");
    expect(body).toContain("master.filter((row) => labelCreatesOutput(row.macro_operation))");
  });
});

describe("el cambio de cobertura queda registrado", () => {
  const before: CoverageSnapshot[] = [
    { order_id: "a", store_id: "s", coverage: "provincia_cod" },
    { order_id: "b", store_id: "s", coverage: "agencia" },
    { order_id: "c", store_id: "s", coverage: "lima" },
  ];

  it("un evento por pedido que cambió, con el antes, el después y la causa", () => {
    const after: CoverageSnapshot[] = [
      { order_id: "a", store_id: "s", coverage: "lima" },
      { order_id: "b", store_id: "s", coverage: "agencia" },
      // «c» no se volvió a leer: no se inventa un después.
    ];
    const events = coverageChangeEvents(before, after, {
      cause: "ubicacion_corregida", actor: "mily", reason: "Es San Juan de Lurigancho", occurredAt: "2026-10-13T15:00:00Z",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: COVERAGE_CHANGED_KIND, order_id: "a", store_id: "s", actor: "mily", source: "manual",
      reason: "Es San Juan de Lurigancho",
      note: "Cobertura: Provincia COD → Lima · ubicación corregida.",
      payload: { from: "provincia_cod", to: "lima", cause: "ubicacion_corregida" },
    });
  });

  it("la nota dice las tres causas en castellano", () => {
    expect(coverageChangeNote("lima", "agencia", "ubicacion_restaurada")).toBe(
      "Cobertura: Lima → Agencia · corrección de ubicación retirada.",
    );
    expect(coverageChangeNote(null, "provincia_cod", "decision_distrito")).toBe(
      "Cobertura: sin cobertura → Provincia COD · decisión de cobertura del distrito.",
    );
  });

  it("relee después del recálculo y escribe solo los que cambiaron", async () => {
    const inserted: unknown[] = [];
    const admin = {
      from: (table: string) => ({
        select: () => ({
          in: async () => ({ data: table === "order_master" ? [{ order_id: "a", store_id: "s", coverage: "lima" }, { order_id: "b", store_id: "s", coverage: "agencia" }] : [], error: null }),
        }),
        insert: async (rows: unknown[]) => { inserted.push(...rows); return { error: null }; },
      }),
    };
    const out = await recordCoverageChanges(admin as never, before.slice(0, 2), { cause: "decision_distrito", actor: "admin" });
    expect(out).toEqual({ changed: [{ order_id: "a", from: "provincia_cod", to: "lima" }], error: null });
    expect(inserted).toHaveLength(1);
  });

  it("si no puede releer, no inventa nada y lo dice", async () => {
    const admin = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: "timeout" } }) }) }) };
    const out = await recordCoverageChanges(admin as never, before, { cause: "ubicacion_corregida", actor: "x" });
    expect(out.changed).toEqual([]);
    expect(out.error).toContain("timeout");
  });

  it("las cuatro acciones humanas que mueven la cobertura lo registran", () => {
    const pedidos = read("app/dashboard/pedidos/actions.ts");
    const geo = pedidos.slice(pedidos.indexOf("export async function updateOrderGeo("), pedidos.indexOf("export async function loadOrderGeo("));
    expect(geo).toContain('cause: "ubicacion_corregida"');
    // El «antes» es la fila que ya se leyó al autorizar, no una lectura nueva.
    expect(geo).toContain("coverage: ctx.row.coverage ?? null");
    expect(geo.indexOf("recomputeOrderMasterSafe(admin, [orderId])")).toBeLessThan(geo.indexOf("recordCoverageChanges("));
    const clear = pedidos.slice(pedidos.indexOf("export async function clearOrderGeo("));
    expect(clear.slice(0, 2000)).toContain('cause: "ubicacion_restaurada"');

    const settings = read("app/dashboard/[storeId]/settings/actions.ts");
    const district = settings.slice(settings.indexOf("async function recomputeDistrictOrders("), settings.indexOf("export async function saveDistrictCoverage("));
    expect(district).toContain('.select("order_id,store_id,coverage")');
    expect(district).toContain('cause: "decision_distrito"');

    const aliclik = read("app/dashboard/pedidos/aliclik-actions.ts");
    expect(aliclik).toContain('cause: "decision_distrito"');
  });

  it("se ve en Actividad", () => {
    expect(read("components/order-master-shared.tsx")).toContain('coverage_changed: "Cobertura cambiada"');
  });
});

describe("el MOM lo dice", () => {
  const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
  it("§28: fuera de Lima el rótulo no crea salida", () => {
    expect(mom).toContain("**Fuera de Lima el rótulo no crea salida (13-10-2026, decisión del owner).**");
    expect(mom).toContain("**Solo cambia CREAR.**");
  });
  it("§19.0.1: el cambio de cobertura queda registrado", () => {
    expect(mom).toContain("el hecho `coverage_changed` con el antes, el después y la causa");
  });
});
