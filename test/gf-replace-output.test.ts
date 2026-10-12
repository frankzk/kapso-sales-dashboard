// «Sacar con salida nueva» (12-10-2026, decisión del owner; MOM §9.3, §29.13).
// El motorizado todavía tiene la caja «No entregado» (S01) —Johnny (Yhoni) y Roy
// la traen al día siguiente, Alexis cada dos o tres días— y el pedido sale con
// una salida nueva (S02) armada desde stock. La S01 queda en devolución a su
// nombre y, al recibirla, vuelve a stock.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReturningOwnOutput, replacedOutputIds } from "@/lib/gf-replaced-output";
import {
  daysBetween,
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

describe("la salida en devolución no estorba ni se reusa", () => {
  const replaced = s01({ custody_state: "retorno" });
  const fresh = s01({ id: "s02", custody_state: "empresa", dispatched_at: null, output_number: 2 });

  it("no bloquea otra salida", () => {
    expect(outputsBlockingRetry([replaced, fresh]).map((o) => o.id)).toEqual(["s02"]);
  });

  it("no es la que se toma con su misma salida: con la S02 fallida, se toma la S02", () => {
    expect(ownRetryOutput(reprogram, [replaced])).toBeNull();
    expect(ownRetryOutput(reprogram, [replaced, fresh])?.id).toBe("s02");
  });

  it("sola, el pedido no tiene salida viva que sacar", () => {
    expect(reprogramBlockReason([replaced])).toBe("sin_salida");
  });
});

describe("ownReplaceDecision: cuándo se saca con salida nueva", () => {
  it("«No entregado» en la caja de cualquier motorizado, en Por reprogramar Lima: se saca", () => {
    for (const riderName of ["Alexis", "Yhoni", "Roy", "Douglas"]) {
      const riderBox = { ...box, riderName };
      expect(ownReplaceDecision(reprogram, [s01()], s01(), riderBox, null)).toEqual({ action: "sacar" });
    }
    // Con la solicitud de Grupo GF en esa misma salida, también.
    expect(ownReplaceDecision(reprogram, [s01()], s01(), box, "s01")).toEqual({ action: "sacar" });
  });

  it("ya reemplazada va primero: el segundo clic no dice «fuera de etapa»", () => {
    const replaced = s01({ custody_state: "retorno" });
    const afterReplace = { macro_stage: "preparacion", macro_substage: "por_armar" };
    expect(ownReplaceDecision(afterReplace, [replaced], replaced, box, "s02")).toEqual({ action: "ya_reemplazada" });
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
    expect(ownReplaceDecision(order, outputs as unknown as Output[], target as Output, theBox, requestShipment)).toEqual({ action: "bloquear", reason });
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

  it("recibir la caja reemplazada la deja devuelta, conserva su salida y no vuelve a la cola", () => {
    const branch = migration.slice(migration.indexOf("if v_shipment.custody_state = 'retorno' then"), migration.indexOf("return v_shipment.order_id;\n  end if;"));
    expect(branch).toContain("custody_state = 'devuelto', returned_at = now()");
    expect(branch).not.toContain("dispatched_at = null");
    expect(branch).toContain("'return_received'");
    expect(branch).not.toContain("'returned_to_office', p_actor, 'dispatch'");
  });

  it("la parada no cambia y el cuaderno no se la lleva", () => {
    expect(migration).toContain("create trigger delivery_stops_guard_replaced");
    expect(migration).toContain("and sh.custody_state is distinct from 'retorno'");
    expect(read("lib/stop-report.ts")).toContain("if (returning) return { ok: false, error: REPLACED_STOP_ERROR };");
    expect(read("lib/notebook-import-access.ts")).toContain('.eq("custody_state", "retorno");');
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

  it("recibir en oficina va por salida: el QR recibe ESA salida y la caja reemplazada vuelve a stock", () => {
    expect(body("returnUndeliveredByCode")).toContain("returnUndeliveredShipments(admin, auth, orgId, [{ id: byOutput.id, store_id: byOutput.store_id }])");
    expect(body("returnUndeliveredToOffice")).toContain("return box?.manifestId === item.manifest_id && Boolean(box.undeliveredReason);");
    expect(body("returnUndeliveredOutputs")).toContain('if (!auth.canManageDispatch) return { error: "No tienes permiso para organizar rutas." };');
    const scan = body("scanAssignToRider");
    expect(scan).toContain('found.shipment.custody_state === "retorno"');
    expect(scan).toContain("replaced: true,");
    // Recibida, no se toma ni se asigna.
    expect(scan.indexOf("replacedReceivedMessage(")).toBeLessThan(scan.indexOf("takeOrdersCore("));
    expect(body("moveManifestItem")).toContain('if (shipment.custody_state === "retorno") {');
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
    expect(mom).toContain("`MOM_RESOLUTION_VERSION` sube a\n  `mom-v1.26`.");
  });
});
