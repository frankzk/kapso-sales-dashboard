// «Sacar con salida nueva» (12-10-2026, decisión del owner; MOM §9.3, §29.13).
// El motorizado todavía tiene la caja «No entregado» (S01) —Johnny (Yhoni) y Roy
// la traen al día siguiente, Alexis cada dos o tres días— y el pedido sale con
// una salida nueva (S02) armada desde stock. La S01 queda en devolución a su
// nombre y, al recibirla, vuelve a stock.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReplacedOwnOutput, isReturningOwnOutput, officeReturnOutcome, replacedOutputIds } from "@/lib/gf-replaced-output";
import {
  daysBetween,
  ownRetryDecision,
  outputsBlockingRetry,
  ownReplaceDecision,
  ownRetryOutput,
  reprogramBlockReason,
  replaceDecisionMessage,
  replacedOutputLabel,
  replacedOutputNotice,
  replacedOutputReason,
} from "@/lib/gf-retry";
import { pastBoxDecision, pastBoxMessage, replacedReceivedMessage } from "@/lib/gf-scan-return";
import { gfReturnDecision } from "@/lib/gf-returns-scan";
import { isReplaceable } from "@/lib/dispatch-day";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

type Output = Parameters<typeof ownReplaceDecision>[1][number];

const s01 = (over: Partial<Output> = {}): Output => ({
  id: "s01",
  courier: "propio",
  delivery_status: "pendiente",
  custody_state: "courier",
  returned_at: null,
  output_number: 1,
  status_category: "pending",
  dispatched_at: "2026-10-09T14:00:00.000Z",
  reported_status: null,
  swayp_state: null,
  ...over,
} as Output);

const reprogram = { macro_stage: "en_curso", macro_substage: "por_reprogramar_lima" };
const box = { riderName: "Alexis", routeDate: "2026-10-09", undeliveredReason: "no_contesta" };

describe("isReturningOwnOutput: la salida propia en devolución con el motorizado", () => {
  it("propia, viva para su courier, en `retorno` y sin recibir", () => {
    expect(isReturningOwnOutput({ courier: "propio", delivery_status: "pendiente", custody_state: "retorno", returned_at: null })).toBe(true);
    expect(isReturningOwnOutput({ courier: "PROPIO ", delivery_status: "en_ruta", custody_state: "retorno" })).toBe(true);
  });

  it("recibida, devuelta, en la calle, anulada o de otro courier, no", () => {
    expect(isReturningOwnOutput({ courier: "propio", delivery_status: "pendiente", custody_state: "retorno", returned_at: "2026-10-12T15:00:00Z" })).toBe(false);
    expect(isReturningOwnOutput({ courier: "propio", delivery_status: "pendiente", custody_state: "devuelto" })).toBe(false);
    expect(isReturningOwnOutput({ courier: "propio", delivery_status: "pendiente", custody_state: "courier" })).toBe(false);
    expect(isReturningOwnOutput({ courier: "propio", delivery_status: "anulado", custody_state: "retorno" })).toBe(false);
    expect(isReturningOwnOutput({ courier: "tanders", delivery_status: "en_ruta", custody_state: "retorno" })).toBe(false);
  });

  it("los eventos `output_replaced` dicen qué salidas se reemplazaron", () => {
    const ids = replacedOutputIds([
      { kind: "output_replaced", shipment_id: "s01" },
      { kind: "returned_to_office", shipment_id: "s02" },
      { kind: "output_replaced", shipment_id: null },
    ]);
    expect([...ids]).toEqual(["s01"]);
  });
});

describe("la salida reemplazada no estorba ni se reusa", () => {
  const replaced = s01({ custody_state: "retorno" });
  const fresh = s01({ id: "s02", custody_state: "empresa", dispatched_at: null, output_number: 2 });
  const replacedIds = new Set(["s01"]);

  it("la marca es su evento, no la custodia sola", () => {
    expect(isReplacedOwnOutput(replaced, replacedIds)).toBe(true);
    expect(isReplacedOwnOutput(replaced, new Set())).toBe(false);
    expect(isReplacedOwnOutput(s01({ custody_state: "retorno", returned_at: "2026-10-12T10:00:00Z" }), replacedIds)).toBe(false);
  });

  it("no bloquea otra salida", () => {
    expect(outputsBlockingRetry([replaced, fresh], replacedIds).map((o) => o.id)).toEqual(["s02"]);
  });

  it("no es la que se toma con su misma salida: con la S02 fallida, se toma la S02", () => {
    expect(ownRetryOutput(reprogram, [replaced], replacedIds)).toBeNull();
    expect(ownRetryOutput(reprogram, [replaced, fresh], replacedIds)?.id).toBe("s02");
  });

  it("sola, el pedido no tiene salida viva que sacar", () => {
    expect(reprogramBlockReason([replaced], replacedIds)).toBe("sin_salida");
  });

  it("«Solicitar devolución» (§13) sin reemplazo sigue como siempre: se recibe en oficina y se reprograma", () => {
    // En `retorno` por la Mesa de cierre, en la caja con «No entregado».
    const requested = s01({ custody_state: "retorno" });
    expect(outputsBlockingRetry([requested], new Set()).map((o) => o.id)).toEqual(["s01"]);
    expect(ownRetryOutput(reprogram, [requested], new Set())?.id).toBe("s01");
    expect(ownRetryDecision(requested, box, false)).toEqual({ action: "recibir_en_oficina" });
    // No se saca con salida nueva: ya está en devolución.
    expect(ownReplaceDecision(reprogram, [requested], requested, box, null, new Set())).toEqual({ action: "bloquear", reason: "en_devolucion" });
  });
});

describe("ownReplaceDecision: cuándo se saca con salida nueva", () => {
  it("«No entregado» en la caja de cualquier motorizado, en Por reprogramar Lima: se saca", () => {
    for (const riderName of ["Alexis", "Yhoni", "Roy", "Douglas"]) {
      const riderBox = { ...box, riderName };
      expect(ownReplaceDecision(reprogram, [s01()], s01(), riderBox, null, new Set())).toEqual({ action: "sacar" });
    }
    // Con la solicitud de Grupo GF en esa misma salida, también.
    expect(ownReplaceDecision(reprogram, [s01()], s01(), box, "s01", new Set())).toEqual({ action: "sacar" });
  });

  it("ya reemplazada va primero: el segundo clic no dice «fuera de etapa»", () => {
    const replaced = s01({ custody_state: "retorno" });
    const afterReplace = { macro_stage: "preparacion", macro_substage: "por_armar" };
    expect(ownReplaceDecision(afterReplace, [replaced], replaced, box, "s02", new Set(["s01"]))).toEqual({ action: "ya_reemplazada" });
  });

  it.each([
    ["fuera_de_etapa", { macro_stage: "por_despachar", macro_substage: "listo_para_asignar" }, [s01()], s01(), box, null],
    ["entregado", reprogram, [s01(), s01({ id: "x", delivery_status: "entregado" })], s01(), box, null],
    ["no_es_propia", reprogram, [s01({ courier: "tanders" })], s01({ courier: "tanders" }), box, null],
    ["no_es_propia", reprogram, [s01({ custody_state: "devuelto" })], s01({ custody_state: "devuelto" }), box, null],
    ["no_en_caja", reprogram, [s01()], s01(), null, null],
    ["caja_sin_reporte", reprogram, [s01()], s01(), { ...box, undeliveredReason: null }, null],
    ["otra_salida_viva", reprogram, [s01(), s01({ id: "s02", custody_state: "empresa" })], s01(), box, null],
    ["solicitud_en_otra_salida", reprogram, [s01()], s01(), box, "otra"],
    ["tope", reprogram, [s01(), ...["a", "b", "c", "d"].map((id) => s01({ id, delivery_status: "anulado" }))], s01(), box, null],
  ] as const)("bloquea: %s", (reason, order, outputs, target, theBox, requestShipment) => {
    expect(ownReplaceDecision(order, outputs as unknown as Output[], target as Output, theBox, requestShipment, new Set())).toEqual({ action: "bloquear", reason });
  });

  it("los mensajes nombran la salida, el motorizado y la salida nueva", () => {
    expect(replaceDecisionMessage({ action: "ya_reemplazada" }, box, "KP140009-S01", "KP140009-S02"))
      .toBe("KP140009-S01 ya salió con otra salida (KP140009-S02); sigue en devolución con Alexis.");
    expect(replaceDecisionMessage({ action: "bloquear", reason: "no_en_caja" }, box, "KP140009-S01"))
      .toBe("KP140009-S01 ya no está en la caja del motorizado: tómalo con su misma salida.");
    expect(replaceDecisionMessage({ action: "bloquear", reason: "caja_sin_reporte" }, box, "KP140009-S01"))
      .toBe("KP140009-S01 sigue en la caja de Alexis sin «No entregado»: revisa su parada.");
    expect(replaceDecisionMessage({ action: "bloquear", reason: "tope" }, box, null)).toBe("El pedido ya alcanzó el máximo de 5 salidas.");
  });

  it("el motivo de la salida adicional y el aviso", () => {
    expect(replacedOutputReason({ riderName: "Alexis", routeDate: "2026-10-09", outputCode: "KP140009-S01" }))
      .toBe("Alexis no entregó KP140009-S01 (caja del 09/10) y todavía la tiene: sale con una salida nueva armada desde stock.");
    expect(replacedOutputNotice("#KP140009", "KP140009-S02", "KP140009-S01", "Alexis"))
      .toBe("#KP140009 sale con KP140009-S02: Almacén arma otra caja desde stock; imprime su rótulo. KP140009-S01 queda en devolución con Alexis.");
  });

  it("la chapa de la caja que vuelve cuenta los días con el motorizado", () => {
    expect(daysBetween("2026-10-09", "2026-10-12")).toBe(3);
    expect(daysBetween("2026-10-12", "2026-10-12")).toBe(0);
    expect(replacedOutputLabel("KP140009-S01", "Alexis", 3)).toBe("S01 vuelve con Alexis · 3 d");
    expect(replacedOutputLabel("KP140009-S01", "Roy", 0)).toBe("S01 vuelve con Roy");
  });
});

describe("escanear la caja reemplazada la recibe y vuelve a stock", () => {
  it("en Despacho del día: sea del día que sea, no se asigna", () => {
    expect(pastBoxDecision({ boxRouteDate: "2026-10-09", targetDay: "2026-10-12", stopStatus: "no_entregado", outcomeReason: "no_contesta", replaced: true })).toBe("recibir_a_stock");
    expect(pastBoxDecision({ boxRouteDate: "2026-10-12", targetDay: "2026-10-12", stopStatus: "no_entregado", outcomeReason: "rechazado", replaced: true })).toBe("recibir_a_stock");
    // Sin reemplazo, la regla de siempre.
    expect(pastBoxDecision({ boxRouteDate: "2026-10-09", targetDay: "2026-10-12", stopStatus: "no_entregado", outcomeReason: "no_contesta" })).toBe("recibir_y_asignar");
    expect(pastBoxMessage("recibir_a_stock", "Alexis", "2026-10-09")).toContain("desármala y regístrala como reingreso a stock");
    expect(replacedReceivedMessage("KP140009-S01", "Alexis", "2026-10-09", "KP140009-S02"))
      .toBe("KP140009-S01 era la caja reemplazada (Alexis del 09/10): recibida en oficina; desármala y regístrala como reingreso a stock. El pedido sale con KP140009-S02.");
  });

  it("en Devoluciones de Almacén, la que ya consta devuelta y sigue en la caja también va a stock; la de devolución solicitada, no", () => {
    const inBox = { riderName: "Alexis", routeDate: "2026-10-09", stopStatus: "no_entregado" };
    expect(gfReturnDecision("KP1-S01", { box: inBox, custodyState: "devuelto", receivedInOffice: false })).toEqual({ kind: "recibir", toStock: true });
    expect(gfReturnDecision("KP1-S01", { box: inBox, custodyState: "retorno", receivedInOffice: false, replaced: false })).toEqual({ kind: "recibir" });
  });

  it("en Devoluciones de Almacén: se recibe a stock; ya recibida, se avisa", () => {
    const facts = { box: { riderName: "Alexis", routeDate: "2026-10-09", stopStatus: "no_entregado" }, custodyState: "retorno", receivedInOffice: false, replaced: true };
    expect(gfReturnDecision("KP140009-S01", facts)).toEqual({ kind: "recibir", toStock: true });
    const back = gfReturnDecision("KP140009-S01", { ...facts, box: null, custodyState: "devuelto" });
    expect(back).toMatchObject({ kind: "aviso" });
    expect((back as { message: string }).message).toContain("era la caja reemplazada");
  });
});

describe("Despacho del día: qué fila ofrece «Sacar con salida nueva»", () => {
  const route = { riderName: "Alexis", routeDate: "2026-10-09", loadNumber: 1, state: "in_custody", officeCheckedAt: null, pickupCheckedAt: null };
  it("un «No entregado» en la caja, con su salida", () => {
    expect(isReplaceable({ route: { ...route, undeliveredReason: "no_contesta", shipmentId: "s01" } })).toBe(true);
    expect(isReplaceable({ route: { ...route, undeliveredReason: "no_contesta" } })).toBe(false);
    expect(isReplaceable({ route: { ...route, undeliveredReason: null, shipmentId: "s01" } })).toBe(false);
    expect(isReplaceable({ route: null })).toBe(false);
  });
});

describe("las piezas en el código", () => {
  const migration = read("db/migrations/0246_gf_replace_output.sql");
  const actions = read("app/dashboard/courier/actions.ts");
  const body = (name: string) => {
    const start = actions.indexOf(`export async function ${name}(`);
    expect(start, name).toBeGreaterThan(0);
    return actions.slice(start, actions.indexOf("\nexport ", start + 1));
  };

  it("la 0246 reemplaza con candado, repite el tope y es solo del servidor", () => {
    const fn = migration.slice(migration.indexOf("create or replace function public.gf_replace_output("), migration.indexOf("grant execute on function public.gf_replace_output"));
    expect(fn).toContain("from delivery_stops");
    expect(fn).toContain("for update;");
    expect(fn).toContain("if v_count > 5 then raise exception 'TOPE:");
    expect(fn).toContain("raise exception 'REPLACED:%'");
    expect(fn).toContain("update shipments set custody_state = 'retorno' where id = v_old.id;");
    expect(migration).toContain("grant execute on function public.gf_replace_output(uuid, uuid, uuid, date, text, uuid) to service_role;");
  });

  it("la marca de la reemplazada es su evento, no la custodia sola", () => {
    expect(migration).toContain("create or replace function public.gf_output_replaced(p_shipment uuid)");
    expect(migration).toContain("select 1 from order_events where shipment_id = p_shipment and kind = 'output_replaced'");
    // Una salida en `retorno` por «Solicitar devolución» no se saca con salida nueva.
    expect(migration).toContain("if v_old.custody_state = 'retorno' and not gf_output_replaced(v_old.id) then");
  });

  it("recibir la caja reemplazada (o la ya devuelta que sigue en la caja) la deja devuelta y no vuelve a la cola", () => {
    const start = migration.indexOf("v_replaced := gf_output_replaced(v_shipment.id);");
    const branch = migration.slice(start, migration.indexOf("return v_shipment.order_id;\n  end if;", start));
    expect(branch).toContain("if v_shipment.custody_state = 'devuelto' or v_shipment.returned_at is not null\n     or (v_shipment.custody_state = 'retorno' and v_replaced) then");
    expect(branch).toContain("custody_state = 'devuelto', returned_at = coalesce(returned_at, now())");
    expect(branch).not.toContain("dispatched_at = null");
    expect(branch).toContain("'return_received'");
    expect(branch).not.toContain("'returned_to_office', p_actor, 'dispatch'");
  });

  it("la parada no cambia —tampoco escrita por el motorizado— y el cuaderno no se la lleva", () => {
    expect(migration).toContain("create trigger delivery_stops_guard_replaced");
    const guard = migration.slice(migration.indexOf("create or replace function public.gf_guard_replaced_stop()"), migration.indexOf("drop trigger if exists delivery_stops_guard_replaced"));
    // El motorizado escribe bajo RLS y no ve `shipments`.
    expect(guard).toContain("security definer");
    expect(guard).toContain("and gf_output_replaced(old.shipment_id) then");
    // El cuaderno no se lleva la reemplazada, que se reconoce por su evento: una
    // en `retorno` por «Solicitar devolución» pasa como siempre.
    const carry = migration.slice(migration.indexOf("create or replace function public.gf_carry_over("));
    expect(carry).toContain("and not (sh.custody_state = 'retorno' and public.gf_output_replaced(sh.id))");
    expect(carry).not.toContain("custody_state is distinct from 'retorno'");
    expect(carry).toContain("if v_custody = 'retorno' and public.gf_output_replaced(r.shipment_id) then");
    // Candados de todo el lote primero (ítems y luego cajas, por id), y relee
    // con candado antes de sacar el paquete de la caja.
    const lockItems = carry.indexOf("perform 1 from dispatch_manifest_items\n   where shipment_id = any(p_shipment_ids) and removed_at is null\n   order by id for update;");
    const lockBoxes = carry.indexOf("perform 1 from dispatch_manifests\n   where id in (select manifest_id from dispatch_manifest_items");
    expect(lockItems).toBeGreaterThan(0);
    expect(lockBoxes).toBeGreaterThan(lockItems);
    expect(lockBoxes).toBeLessThan(carry.indexOf("  for r in"));
    expect(carry).toContain("select * into v_item_row from dispatch_manifest_items where id = r.item_id for update;");
    expect(carry).toContain("select custody_state into v_custody from shipments where id = r.shipment_id for update;");
    expect(carry.indexOf("for update;")).toBeLessThan(carry.indexOf("-- 1. Sale de la caja anterior"));
    // También ante soltar la parada de su salida o de su caja, o borrarla; la
    // nota se corrige.
    expect(guard).toContain("new.status is not distinct from old.status");
    expect(guard).toContain("where s.id = old.shipment_id and s.courier = 'propio'");
    expect(migration).toContain("before update of status, shipment_id, dispatch_manifest_id or delete on public.delivery_stops");
    const report = read("lib/stop-report.ts");
    expect(report).toContain("if (await stopIsFrozenByReplacement(admin, stop.id, input.status)) return { ok: false, error: REPLACED_STOP_ERROR };");
    expect(report).toContain('if (!row?.shipment_id || row.status === nextStatus) return false;');
    const notebook = read("lib/notebook-import-access.ts");
    expect(notebook).toContain('.eq("kind", OUTPUT_REPLACED_KIND).in("shipment_id", inBoxIds)');
    expect(notebook).toContain(".filter((id) => replacedIds.has(id))");
  });

  it("la salida nueva no entra en la ruta del mismo motorizado y día que la reemplazada", () => {
    expect(migration).toContain("create trigger dispatch_items_guard_replaced_route");
    expect(migration).toContain("raise exception 'Este pedido tiene su caja anterior (%) en la ruta de % del %: la salida nueva va con otro motorizado u otro día.'");
  });

  it("la acción pide organizar rutas y la tienda, escribe el motivo y deshace lo que creó", () => {
    const replace = body("replaceOwnOutputs");
    expect(replace).toContain("await requireOperator(orgId)");
    expect(replace).toContain('if (!auth.canManageDispatch) return { error: "No tienes permiso para organizar rutas.", ...empty };');
    expect(replace).toContain("if (!storeAllowed(auth, old.store_id)) {");
    expect(replace).toContain('puertaDeSalidaAdicional({ courier: "propio", operation: "lima", outputs, motivo: reason })');
    expect(replace).toContain("{ createIfMissing: true, forceNew: true }");
    expect(replace).toContain('admin.rpc("gf_replace_output"');
    expect(replace).toContain('kind: "additional_output_reason"');
    expect(replace).toContain("if (createdShipment) await discardNewOutput(admin, createdShipment);");
    // La decisión va antes de cualquier escritura.
    expect(replace.indexOf("ownReplaceDecision(")).toBeLessThan(replace.indexOf('.from("logistics_requests")\n          .insert('));
    expect(replace.indexOf("ownReplaceDecision(")).toBeLessThan(replace.indexOf("writeCourierGuide("));
  });

  it("recibir en oficina va por salida: el QR, la fila, la lista y la ruta reciben ESA caja", () => {
    const byCode = body("returnUndeliveredByCode");
    expect(byCode).toContain("returnUndeliveredShipments(admin, auth, orgId, [{ id: byOutput.id, store_id: byOutput.store_id }])");
    // Solo el QR, el código de salida o la guía designan la caja; el número de
    // pedido recibe por pedido, y con la reemplazada fuera pide el QR.
    expect(byCode).toContain('const byOutput = found.shipment && !found.byOrderName && courierKey(found.shipment.courier) === "propio" ? found.shipment : null;');
    expect(byCode).toContain('else if (found.scanHold) return { error: found.error ?? "Escanea el QR de la caja." };');
    const toOffice = body("returnUndeliveredToOffice");
    expect(toOffice).toContain("{ byOrder: true }");
    // Por número de pedido, con dos cajas «No entregado», no se recibe ninguna.
    expect(toOffice).toContain("const twoBoxes = (perOrder.get(orderOf.get(item.shipment_id) ?? item.shipment_id) ?? 0) > 1;");
    expect(toOffice).toContain("(!opts.manifestIds || opts.manifestIds.has(item.manifest_id))");
    expect(body("returnUndeliveredOutputs")).toContain('if (!auth.canManageDispatch) return { error: "No tienes permiso para organizar rutas." };');
    const scanner = read("components/returns-scanner.tsx");
    expect(scanner).toContain("await returnUndeliveredOutputs(orgId, [row.shipmentId])");
    expect(scanner).toContain("<tr key={p.shipmentId}");
    expect(read("components/dispatch-day-board.tsx")).toContain("await returnUndeliveredOutputs(orgId, shipmentIds)");
    expect(read("lib/courier-route-ledger.ts")).toContain("replaced: replaced.has(s.shipment_id),");
  });

  it("el escaneo de la caja reemplazada la recibe a stock y nunca toma ni asigna la salida nueva", () => {
    const scan = body("scanAssignToRider");
    expect(scan).toContain("if (!(await outputWasReplaced(admin, found.shipment!.id))) return null;");
    expect(scan).toContain("if (replacedScan && !active) {");
    expect(scan).toContain("if (box && replacedScan) {");
    expect(scan).toContain("replaced: true,");
    expect(scan).toContain('status: "recibido_a_stock",');
    // Ni recibida ni en su caja se llega a tomar o asignar.
    expect(scan.indexOf("if (replacedScan && !active) {")).toBeLessThan(scan.indexOf("takeOrdersCore("));
    expect(scan.indexOf("replacedReceivedMessage(")).toBeLessThan(scan.indexOf("takeOrdersCore("));
    // Sin revalidar la página dentro del escaneo: lo refresca el navegador.
    const branch = scan.slice(scan.indexOf("if (box && replacedScan) {"), scan.indexOf("// Una caja de un día ANTERIOR"));
    expect(branch).not.toContain("revalidatePath(");
    expect(read("components/dispatch-day-board.tsx")).toContain('if (line.status === "asignado" || line.status === "ya_en_caja" || line.receivedFrom) scheduleRefresh();');
    // «Se reemplazó» solo si se reemplazó: «Solicitar devolución» conserva su aviso.
    expect(body("moveManifestItem")).toContain('if (shipment.custody_state === "retorno" && (await outputWasReplaced(admin, shipmentId))) {');
  });

  it("por número de pedido, con la reemplazada fuera, el escaneo no elige: pide el QR", () => {
    // La S01 y la S02 llevan el mismo código de barras (el número de pedido).
    const despacho = read("app/dashboard/pedidos/despacho/actions.ts");
    expect(despacho).toContain("if (candidates.length) return { candidates, byOrderName: true, hold: await replacedOutHold(candidates) };");
    expect(despacho).toContain('.eq("kind", OUTPUT_REPLACED_KIND)\n    .in("shipment_id", returning.map((candidate) => candidate.id));');
    expect(despacho).toContain("if (hold) return { error: hold, byOrderName, scanHold: true };");
    // Preparar, recibir, agregar a una ruta y cotejar tampoco eligen.
    expect(despacho.split("if (scan.hold) return { error: scan.hold };").length - 1).toBe(4);
    const scan = body("scanAssignToRider");
    expect(scan).toContain("} else if (found.scanHold) {");
    expect(scan.indexOf("} else if (found.scanHold) {")).toBeLessThan(scan.indexOf("takeOrdersCore("));
  });

  it("recibida de una caja vieja, se mira lo que hizo la base antes de tomar o asignar", () => {
    const scan = body("scanAssignToRider");
    const outcome = scan.indexOf("const outcome = officeReturnOutcome(afterRow?.custody_state, replacedNow);");
    expect(outcome).toBeGreaterThan(0);
    expect(outcome).toBeLessThan(scan.indexOf("takeOrdersCore("));
    expect(scan).toContain('if (outcome !== "por_asignar") {');
    expect(officeReturnOutcome("devuelto", true)).toBe("a_stock_reemplazada");
    expect(officeReturnOutcome("devuelto", false)).toBe("ya_devuelta");
    expect(officeReturnOutcome("empresa", true)).toBe("por_asignar");
    expect(officeReturnOutcome(null, false)).toBe("por_asignar");
    // El panel de la caja se actualiza también cuando el escaneo la recibió.
    expect(read("components/gf-box-add-packages.tsx")).toContain("} else if (line.receivedFrom) {");
  });

  it("con la reemplazada fuera no se añade una parada sin salida: no dice de qué caja habla", () => {
    const report = read("lib/stop-report.ts");
    expect(report).toContain("export async function ordersWithReplacedOutputOut(");
    expect(report).toContain("if (replaced.has(row.id) && !out.has(row.order_id)) out.set(row.order_id, row.output_code);");
    const reparto = read("app/reparto/actions.ts");
    const manual = reparto.slice(reparto.indexOf("export async function addManualStop("));
    expect(manual.indexOf("ordersWithReplacedOutputOut(g.admin, [o.id])")).toBeGreaterThan(0);
    expect(manual.indexOf("ordersWithReplacedOutputOut(g.admin, [o.id])")).toBeLessThan(manual.indexOf('.from("delivery_stops").insert('));
    const rutas = read("app/dashboard/rutas/actions.ts");
    const add = rutas.slice(rutas.indexOf("export async function addStops("));
    expect(add.indexOf("ordersWithReplacedOutputOut(g.admin, orderIds)")).toBeGreaterThan(0);
    expect(add.indexOf("ordersWithReplacedOutputOut(g.admin, orderIds)")).toBeLessThan(add.indexOf(".upsert(rows"));
  });

  it("si la llamada falla sin respuesta clara, no deshace un reemplazo que sí se hizo", () => {
    const replace = body("replaceOwnOutputs");
    expect(replace).toContain("const committed = rpcError ? await replacementCommitted(admin, write.shipmentId) : false;");
    expect(replace).toContain("if (rpcError && !committed) {");
    expect(actions).toContain("if (await replacementCommitted(admin, shipmentId)) return;");
    // Lo que no salió se dice con su pedido, también junto a lo que sí.
    expect(replace).toContain("if (failed.length && (replaced.length || alreadyReplaced.length)) {");
  });

  it("la cola, la toma y el reemplazo leen el evento: la custodia sola no es reemplazo", () => {
    expect(actions).toContain("const replacedIds = await loadReplacedIds(admin, ((admissionShipmentRows ?? []) as AdmissionShipmentRow[]).map((row) => row.id));");
    expect(actions).toContain("ownRetryOutput(order, shipmentsByOrder.get(order.order_id) ?? [], replacedIds)");
    expect(actions).toContain("ownRetryOutput(row, outputs, replacedIds)");
    expect(body("replaceOwnOutputs")).toContain("ownReplaceDecision(row, outputs, old, box, request?.shipment_id ?? null, replacedIds)");
    // «A stock» solo para la reemplazada o la ya devuelta, como la base, y
    // leído DESPUÉS de recibir: un reemplazo simultáneo cambia la rama.
    const core = body("returnUndeliveredToOffice");
    expect(core).toContain("const outcome = officeReturnOutcome(row.custody_state, replacedIds.has(row.id));");
    expect(core.indexOf('admin.rpc("gf_return_to_office"')).toBeLessThan(core.indexOf("officeReturnOutcome("));
    const despacho = read("app/dashboard/pedidos/despacho/actions.ts");
    expect(despacho).toContain("const replaced = Boolean(replacedEvents?.length);");
    expect(despacho.indexOf('admin.rpc("gf_return_to_office"')).toBeLessThan(despacho.indexOf("const outcome = officeReturnOutcome("));
  });

  it("la Mesa de cierre no recibe una caja que sigue con el motorizado", () => {
    const closure = read("app/dashboard/pedidos/actions.ts");
    expect(closure).toContain('if (action === "return_receive" && selectedShipment && (selectedShipment.courier ?? "").toLowerCase() === "propio") {');
    expect(closure).toContain("recíbela en Despacho del día («En devolución» o «Devoluciones», o escaneando su QR)");
  });

  it("el tablero ofrece «Sacar con salida nueva» y la píldora «En devolución»", () => {
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain("Sacar con salida nueva {selectedReplaceable.length}");
    expect(board).toContain('label="En devolución"');
    expect(board).toContain("run(() => replaceOwnOutputs(orgId, ids));");
    expect(board).toContain("run(() => returnUndeliveredOutputs(orgId, ids));");
  });

  it("el MOM lo documenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("**«Sacar con salida nueva»: el pedido sale mientras el motorizado todavía tiene la caja (12-10-2026, decisión del owner).**");
    expect(mom).toContain("salvo\n  **«Sacar con salida nueva»** (12-10-2026, §29.13)");
    expect(mom).toContain("`MOM_RESOLUTION_VERSION` sube a `mom-v1.26`.");
    expect(mom).toContain("- **Por número de pedido, mientras la reemplazada siga fuera, el escaneo no\n  elige: pide el QR.**");
    expect(mom).toContain("Una parada sin salida (del cuaderno o a mano) nunca se le atribuye a la caja\n  reemplazada");
  });
});
