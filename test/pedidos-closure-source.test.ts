// Auditoría del atraso de Lima (14-10-2026): las tres correcciones de la Mesa
// de cierre y del lote del Master, en el código. Las reglas están probadas en
// test/pedidos-closure-blocks.test.ts, test/pedidos-logistics-cost.test.ts y
// test/pedidos-bulk-status-guard.test.ts, y ejecutadas en el servidor y en la
// Mesa en test/pedidos-closure-behavior.test.ts; aquí, que el servidor y la
// pantalla las usen y no una copia.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const actions = read("app/dashboard/pedidos/actions.ts");
const desk = read("components/order-closure-desk.tsx");
const master = read("lib/order-master.ts");

/** El cuerpo de una función exportada, hasta la siguiente al mismo nivel. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("(A) conciliar liquidación con la tarifa que falta", () => {
  const closure = body(actions, "export async function registerClosureAction(");

  it("el servidor decide sobre el costo recalculado ahora, con la regla compartida", () => {
    expect(closure).toContain("freshLogisticsCost(admin, orderId)");
    expect(closure).toContain("liquidationCostBlock(");
    // La guarda vieja solo miraba null y dejaba pasar el S/ 0 de una tarifa ausente.
    expect(actions).not.toContain("Falta el costo logístico. Regístralo en Costos antes de cerrar la liquidación.");
    expect(closure).not.toMatch(/logistics_cost == null\)/);
  });

  it("el Master guarda null cuando falta la tarifa, no el total parcial", () => {
    expect(master).toContain("logistics_cost: logistics.cost,");
    expect(master).toContain("masterLogisticsCost(tariffs, {");
    expect(master).not.toMatch(/computeLogisticsCost\(tariffs, \{[\s\S]{0,600}\}\)\.total/);
  });

  it("el respaldo sin recálculo usa la misma regla de la fila que la Mesa, con el permiso de Costos y el del Tarifario", () => {
    expect(flat(closure)).toContain(
      'liquidationCostBlock({ ...(fresh ?? logisticsCostFactsFromRow(ctx.row)), canManageCosts: perms.can("costs.manage"), canManageLogistics: perms.can("logistics.manage"), })',
    );
  });

  it("la Mesa avisa antes del clic y deja guardar para que el servidor recalcule", () => {
    // El courier y el día, con la regla del recálculo (logisticsCostFactsFromRow).
    expect(desk).toContain("{ ...logisticsCostFactsFromRow(row), tarifario: costTariffGap ?? null }");
    expect(flat(desk)).toContain(
      "liquidationCostBlock({ ...costFacts, canManageCosts: permissions.canManageCosts, canManageLogistics: permissions.canManageLogistics, })",
    );
    expect(desk).toContain('data-closure-block="tarifa-faltante"');
    // Costos, o el Tarifario para Grupo GF (mom-v1.31): `costTariffScreen`.
    expect(desk).toContain("href={costScreen.href}");
    // El enlace solo cuando una tarifa lo arregla y quien mira puede cargarla.
    expect(desk).toContain("const costNeedsTariff = Boolean(costFacts && costBlockNeedsTariff(costFacts));");
    expect(flat(desk)).toContain(
      'const costLink = costNeedsTariff && (costScreen.permission === "logistics.manage" ? permissions.canManageLogistics : permissions.canManageCosts);',
    );
    expect(flat(desk)).toContain(
      "Al guardar se vuelve a calcular el costo: si la tarifa ya está cargada y rige el día del pedido, se concilia.",
    );
    // «Conciliar liquidación» no se esconde por la fila: subir una tarifa no
    // recalcula el pedido, y esconderlo dejaría el cierre sin salida.
    expect(desk).not.toMatch(/costBlock[^\n]*next\.push\("liquidation_close"\)/);
  });
});

describe("(C) finalizar con la ruta de Grupo GF abierta", () => {
  const closure = body(actions, "export async function registerClosureAction(");

  it("el servidor explica que la cierra la ruta, o que estando anulado en Shopify no lo hará", () => {
    expect(closure).toContain("activeOutputs(shipmentRows).length");
    expect(closure).toContain("gfOpenRouteBlock(shipmentRows, deliveries, { cancelledInShopify })");
    expect(closure).toContain("gfBlock ? gfOpenRouteError(gfBlock) : ACTIVE_OUTPUTS_ERROR");
    // La anulación se lee como la lee la puerta: `orders.cancelled_at`.
    expect(actions).toContain('admin.from("orders").select("cancelled_at").eq("id", orderId).maybeSingle()');
    expect(actions).toContain('.select("id,route_id,shipment_id,status,reported_at,delivery_routes(route_date,status)")');
    expect(actions).toContain("pickLatestStop(");
  });

  it("la Mesa oculta «Finalizar expediente» y lleva a «Reparto y liquidación»", () => {
    expect(desk).toContain("gfOpenRouteBlock(guides, gfDeliveries ?? [], { cancelledInShopify })");
    expect(flat(desk)).toMatch(/permissions\.canFinalize && !gfRouteOpen \) \{ next\.push\("finalize"\);/);
    expect(desk).toContain('data-closure-block="ruta-gf-abierta"');
    expect(desk).toContain("gfRouteReportHref(routeId)");
    expect(desk).toContain("<GfRoutePath routeId={gfRouteBlock.routeIds[0]} />");
    expect(desk).toContain("Grupo GF Courier › Rutas ›");
    expect(desk).toContain("«Reparto y liquidación»");
    expect(desk).toContain("GF_ROUTE_PATH_LABEL");
  });

  it("anulado en Shopify, la Mesa no promete que cerrar la ruta lo pase a entregado", () => {
    expect(desk).toContain('data-closure-block="ruta-gf-anulado-shopify"');
    // La tienda del pedido (MOM §38.12): «Shopify» por defecto, «WooCommerce» si vino de ahí.
    expect(flat(desk)).toContain("pero el pedido está anulado en {storePlatform}: terminar la ruta en");
    expect(flat(desk)).toContain("no lo marca entregado. Si la entrega vale, la cambia desde esta ficha («Gestión manual»)");
  });
});

describe("(E) el lote a entregado respeta la observación de cuadre abierta (§30.8)", () => {
  const bulk = body(actions, "export async function applyOrderStatusBulk(");

  it("lee las observaciones abiertas de los pedidos visibles y salta esos", () => {
    expect(bulk).toContain('if (input.general === "entregado")');
    expect(bulk).toContain('.from("sheet_observations")');
    expect(bulk).toContain('.eq("status", "abierta")');
    expect(bulk).toContain("bulkDeliveredSkips(input.general, unique, withOpen)");
    expect(bulk).toContain("if (skippedIds.has(orderId)) continue;");
  });

  it("si no puede leerlas no aplica nada", () => {
    expect(flat(bulk)).toContain("No se pudieron leer las observaciones de cuadre (${openError.message}). No se aplicó nada; vuelve a intentarlo.");
  });

  it("informa cuántos se saltaron y por qué", () => {
    expect(bulk).toContain("failed: [...skipped, ...failed]");
    expect(bulk).toContain("bulkStatusNotice({ applied: applied.length, skipped: skipped.length, failed: failed.length })");
    expect(bulk).toContain("bulkAllSkippedError(skipped.length)");
  });

  it("la barra del lote enlaza a Liquidaciones 2, que no está en el menú", () => {
    const bar = flat(read("components/orders-master.tsx"));
    expect(bar).toContain("setObservationSkips(result.skipped?.length ?? 0);");
    expect(bar).toContain("<a href={OBSERVATIONS_SCREEN_HREF}");
    expect(bar).toContain("Abrir Liquidaciones 2");
  });
});

describe("la ficha le pasa a la Mesa lo que necesita para avisar antes del clic", () => {
  it("la fila del Master y las entregas de Grupo GF, con la ruta de cada parada", () => {
    const drawer = flat(read("components/order-drawer.tsx"));
    const start = drawer.indexOf("<OrderClosureDesk");
    expect(start).toBeGreaterThan(-1);
    const tag = drawer.slice(start, drawer.indexOf("/>", start));
    expect(tag).toContain("row={detail.row}");
    expect(tag).toContain("gfDeliveries={detail.gfDeliveries}");
    expect(tag).toContain("cancelledInShopify={Boolean(detail.shopifyCancelledAt)}");
    // `cancelled_at` sale de la fila de `orders` del detalle (con `platform` si
    // la 0274 está, MOM §38.12).
    expect(read("lib/orders-master-access.ts")).toContain('const ORDER_DETAIL_COLUMNS = "line_items,raw,cancelled_at";');
    expect(read("lib/orders-master-access.ts")).toContain("readOrderForDetail(sb, orderId),");
    // Sin la ruta, «Reparto y liquidación» sale sin enlace.
    expect(read("lib/orders-master-access.ts")).toContain("routeId: st.route_id,");
  });
});
