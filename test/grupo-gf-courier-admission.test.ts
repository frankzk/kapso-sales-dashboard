import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

describe("admisión de pedidos de Grupo GF Courier", () => {
  it("impide dos solicitudes activas para el mismo pedido y operador", () => {
    const sql = readFileSync(
      resolve(root, "db/migrations/0138_group_gf_logistics_requests.sql"),
      "utf8",
    );
    expect(sql).toContain("logistics_requests_active_order_uniq");
    expect(sql).toContain("on logistics_requests(provider_id, order_id)");
    expect(sql).toContain("where status <> 'cancelled'");
    expect(sql).toContain("logistics_request_events");
  });

  it("vuelve a tomar un pedido que Grupo GF ya tiene sin rechazarlo por su salida", () => {
    // Al escanear en Despacho del día un pedido tomado días antes, la salida
    // que dejó esa toma ya lleva courier; si la admisión mirara primero la
    // salida, lo leería como «asignada a otro courier». Ya tomado se decide
    // antes que cualquier comprobación de salidas.
    const src = readFileSync(resolve(root, "app/dashboard/courier/actions.ts"), "utf8");
    const start = src.indexOf("export async function takeGroupGfCourierOrders(");
    const body = src.slice(start, src.indexOf("\nexport ", start + 1));
    const alreadyTaken = body.indexOf('.in("status", ["accepting", "accepted", "scheduled"])');
    const outputCheck = body.indexOf("activeAssignedOutput(outputs");
    expect(alreadyTaken).toBeGreaterThan(0);
    expect(outputCheck).toBeGreaterThan(alreadyTaken);
    expect(body.slice(alreadyTaken, outputCheck)).toContain("alreadyAccepted.push(orderId)");
  });

  it("una fecha prevista ya pasada se mueve al día de la caja antes de abrir la carga", () => {
    // Solicitudes tomadas semanas atrás guardan su fecha de entonces; abrir la
    // carga de ese día tropieza con una ruta liquidada. Se agrupa por el día
    // de la caja y el cambio queda en el historial del pedido.
    const src = readFileSync(resolve(root, "app/dashboard/courier/actions.ts"), "utf8");
    const start = src.indexOf("export async function assignGroupGfCourierRoute(");
    const body = src.slice(start, src.indexOf("\nexport ", start + 1));
    expect(body).toContain("request.scheduled_for < boxDay ? boxDay : request.scheduled_for");
    expect(body).toContain('kind: "logistics_request_rescheduled"');
    expect(body.indexOf("groups.set(routeDate")).toBeGreaterThan(body.indexOf("logistics_request_rescheduled"));
    expect(body).not.toContain("groups.set(request.scheduled_for");
  });

  it("toma pedidos desde la bandeja y no desde el modal manual del pedido", () => {
    const courier = readFileSync(resolve(root, "components/grupo-gf-courier.tsx"), "utf8");
    const master = readFileSync(resolve(root, "components/order-drawer.tsx"), "utf8");
    expect(courier).toContain("Pedidos disponibles");
    expect(courier).toContain("takeGroupGfCourierOrders");
    expect(courier).toContain("Tomar pedido");
    expect(master).toContain("/dashboard/courier?pedido=");
    expect(master).not.toContain('{ key: "propio", label: "Grupo GF Courier" }');
  });

  it("conserva el QR al rellenar una salida por definir", () => {
    const action = readFileSync(resolve(root, "app/dashboard/courier/actions.ts"), "utf8");
    expect(action).toContain("writeCourierGuide(admin, orderId");
    expect(action).toContain("const newShipmentId = fillable?.id ?? randomUUID()");
    expect(action).toContain("Se reutilizó la salida existente y su QR.");
    expect(action).toContain("reusedOutput: write.filled");
  });

  it("prioriza pedidos que nunca tuvieron un despacho físico", () => {
    const action = readFileSync(resolve(root, "app/dashboard/courier/actions.ts"), "utf8");
    const courier = readFileSync(resolve(root, "components/grupo-gf-courier.tsx"), "utf8");
    const mom = readFileSync(resolve(root, "docs/mom/master-pedidos-v1.md"), "utf8");
    expect(action).toContain("hasPriorDispatch: lastDispatchByOrder.has(order.order_id)");
    expect(courier).toContain("Prioridad urgente · nunca salieron");
    expect(courier).toContain("Con salida previa");
    expect(mom).toContain("Crear o anular un rótulo sin transferir físicamente");
  });

  it("permite tomar antes o después del armado sin enviar al courier a Almacén", () => {
    const action = readFileSync(resolve(root, "app/dashboard/courier/actions.ts"), "utf8");
    const courier = readFileSync(resolve(root, "components/grupo-gf-courier.tsx"), "utf8");
    const output = readFileSync(resolve(root, "lib/route-output-fill.ts"), "utf8");
    expect(action).toContain("macro_substage.in.(por_generar_rotulo,por_armar)");
    expect(action).toContain("macro_substage.eq.listo_para_asignar");
    expect(action).toContain("createIfMissing: mayCreateOutput");
    expect(output).toContain("options.createIfMissing === false");
    expect(courier).toContain("Puedes tomarlos antes, durante o después del armado");
    expect(courier).toContain("Armado · listo para ruta");
    expect(courier).not.toContain("Ir a Almacén");
  });

  it("asigna pedidos tomados a la caja diaria sin exigir que Almacén termine", () => {
    const action = readFileSync(resolve(root, "app/dashboard/courier/actions.ts"), "utf8");
    const courier = readFileSync(resolve(root, "components/grupo-gf-courier.tsx"), "utf8");
    const dispatchPage = readFileSync(
      resolve(root, "app/dashboard/pedidos/despacho/page.tsx"),
      "utf8",
    );
    const mom = readFileSync(resolve(root, "docs/mom/master-pedidos-v1.md"), "utf8");
    expect(action).toContain("assignGroupGfCourierRoute");
    expect(action).toContain('.from("dispatch_manifests")');
    expect(action).toContain('.from("dispatch_manifest_items")');
    expect(action).not.toContain('preparation_state", "listo_despacho"');
    expect(courier).toContain("Asignar a ruta diaria");
    expect(courier).toContain("Abrir caja y cotejar");
    expect(dispatchPage).toContain("requestedManifestId");
    expect(mom).toContain("Tomar, asignar y cotejar son hechos distintos");
    expect(mom).toContain("pero nunca combina asignar con cotejar");
    expect(action).toContain("takeAndAssignGroupGfCourierOrders");
  });
});
