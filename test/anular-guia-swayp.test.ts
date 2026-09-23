import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FENIX_DIRECT_CREATED_VIA,
  MANUAL_ROUTE_CREATED_VIA,
  fenixOutputIsCancelable,
  manualOutputIsCancelable,
  restoredRouteOutputPatch,
} from "@/lib/shipment-output";

/**
 * Anular la guía de Swayp: el botón que faltaba.
 *
 * #AUR176830. Su salida nació «por definir», se le escribió encima la guía de
 * Swayp y al querer cambiar de courier no quedaba ningún botón: rellenarla le
 * cambia la vía, así que «Anular salida» deja de ofrecerse, y «Anular» es de
 * Shalom. El único alcanzable era el de Envíos, cuya disposición «cancela»
 * significa que la clienta canceló la venta — y cerró el pedido.
 */

const swaypDirecta = {
  courier: "fenix",
  created_via: FENIX_DIRECT_CREATED_VIA,
  delivery_status: "en_ruta",
  dispatched_at: null,
  custody_state: "empresa",
  custody_transferred_at: null,
};

describe("fenixOutputIsCancelable", () => {
  it("una guía Swayp directa que sigue en el almacén, sí", () => {
    expect(fenixOutputIsCancelable(swaypDirecta)).toBe(true);
    expect(fenixOutputIsCancelable({ ...swaypDirecta, delivery_status: "pendiente" })).toBe(true);
  });

  it("en cuanto la caja se movió, no: el camino es el retorno", () => {
    expect(
      fenixOutputIsCancelable({ ...swaypDirecta, dispatched_at: "2026-09-15T10:00:00Z" }),
    ).toBe(false);
    expect(
      fenixOutputIsCancelable({ ...swaypDirecta, custody_transferred_at: "2026-09-15T10:00:00Z" }),
    ).toBe(false);
    expect(fenixOutputIsCancelable({ ...swaypDirecta, custody_state: "motorizado" })).toBe(false);
  });

  it("una guía ya cerrada no es una guía por corregir", () => {
    for (const estado of ["entregado", "devuelto", "anulado", "transferido"]) {
      expect(fenixOutputIsCancelable({ ...swaypDirecta, delivery_status: estado })).toBe(false);
    }
  });

  it("solo las DIRECTAS: la hija de una reprogramación es un hecho de reproprovincia", () => {
    expect(fenixOutputIsCancelable({ ...swaypDirecta, created_via: null })).toBe(false);
    expect(
      fenixOutputIsCancelable({ ...swaypDirecta, created_via: MANUAL_ROUTE_CREATED_VIA }),
    ).toBe(false);
  });

  it("y solo Swayp: los demás couriers tienen su propio botón", () => {
    for (const courier of ["shalom", "tanders", "aliclik", "por_definir"]) {
      expect(fenixOutputIsCancelable({ ...swaypDirecta, courier })).toBe(false);
    }
  });

  it("no pisa el botón de la ruta manual ni al revés: son excluyentes", () => {
    const manual = {
      courier: "por_definir",
      created_via: MANUAL_ROUTE_CREATED_VIA,
      delivery_status: "pendiente",
      custody_state: "empresa",
      custody_transferred_at: null,
    };
    expect(manualOutputIsCancelable(manual)).toBe(true);
    expect(fenixOutputIsCancelable(manual)).toBe(false);
    expect(manualOutputIsCancelable(swaypDirecta)).toBe(false);
  });
});

describe("qué deja la anulación, según de dónde venga la salida", () => {
  it("una salida RELLENADA vuelve a «por definir»; la caja no se movió", () => {
    const patch = restoredRouteOutputPatch("#AUR176830", "3ff64775-1197-46f0-9618-5ecb8e95557c");
    expect(patch.delivery_status).toBe("pendiente");
    expect(patch.courier).toBe("por_definir");
    expect(patch.created_via).toBe(MANUAL_ROUTE_CREATED_VIA);
    // El consecutivo, el QR y el avance de preparación no viajan en el patch:
    // son de la caja, no de la guía.
    expect(patch).not.toHaveProperty("output_number");
    expect(patch).not.toHaveProperty("qr_token");
    expect(patch).not.toHaveProperty("preparation_state");
  });
});

describe("la acción de servidor", () => {
  const src = readFileSync(resolve(process.cwd(), "app/dashboard/pedidos/actions.ts"), "utf8");
  const action = src.slice(src.indexOf("export async function cancelFenixOutput"));
  const body = action.slice(0, action.indexOf("\n// ---"));

  it("revalida el predicado en el servidor, no solo al pintar el botón", () => {
    expect(body).toContain("fenixOutputIsCancelable(output)");
  });

  it("avisa a Swayp ANTES de tocar nada, y si Swayp dice que no, se para", () => {
    const swaypCall = body.indexOf("cancelGuides(");
    const localWrite = body.indexOf('.from("shipments")\n    .update(');
    expect(swaypCall).toBeGreaterThan(-1);
    expect(localWrite).toBeGreaterThan(swaypCall);
    expect(body).toContain("La guía sigue viva allá, así que no se tocó acá.");
  });

  it("una guía con código local no tiene a quién avisar", () => {
    expect(body).toContain("if (output.swayp_guide && env.swaypEnabled())");
  });

  it("pregunta por el EVENTO de relleno, no por la forma de la fila", () => {
    expect(body).toContain("ROUTE_OUTPUT_FILLED");
    expect(body).toContain("filledShipmentIds(");
  });

  it("limpia los campos del courier al restaurar: si no, diría tener guía sin tenerla", () => {
    expect(body).toContain("swayp_guide: null");
    expect(body).toContain("swayp_state: null");
    expect(body).toContain("fenix_shipment_id: null");
  });

  it("la escritura repite las condiciones de la lectura", () => {
    expect(body).toContain('.eq("created_via", FENIX_DIRECT_CREATED_VIA)');
    expect(body).toContain('.is("dispatched_at", null)');
    expect(body).toContain('.is("custody_transferred_at", null)');
  });

  it("deja rastro y recalcula el pedido", () => {
    expect(body).toContain('kind: "guide_cancelled"');
    expect(body).toContain("recomputeOrderMasterSafe(admin, [output.order_id])");
  });
});

describe("el drawer", () => {
  const ui = readFileSync(resolve(process.cwd(), "components/order-drawer.tsx"), "utf8");

  it("ofrece el botón solo cuando la guía se puede anular", () => {
    expect(ui).toContain("canEdit && fenixOutputIsCancelable(g) && (");
  });

  it("promete lo que va a pasar de verdad, que son dos cosas distintas", () => {
    // El botón es pieza compartida entre el Master y la ficha (order-master-shared.tsx).
    const shared = readFileSync(resolve(process.cwd(), "components/order-master-shared.tsx"), "utf8");
    const boton = shared.slice(shared.indexOf("function FenixCancelButton"));
    expect(boton.slice(0, 3000)).toContain("wasFilled");
    expect(boton.slice(0, 3000)).toContain(
      "La caja se queda como está y la salida vuelve a quedar sin courier",
    );
  });

  it("y lo sabe por el evento que trae el detalle, no deduciéndolo", () => {
    expect(ui).toContain("wasFilled={detail.filledOutputIds.includes(g.id)}");
    const access = readFileSync(resolve(process.cwd(), "lib/orders-master-access.ts"), "utf8");
    expect(access).toContain("filledOutputIds: [...filledShipmentIds(events)]");
    // Y las columnas que el predicado necesita llegan al cliente.
    expect(access).toContain("swayp_guide,swayp_state,dispatched_at,");
  });
});

describe("el MOM dice la regla nueva", () => {
  it("cada courier con guía tiene su botón, y anular una rellenada no la anula", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
    expect(mom).toContain("tiene que tener su propio\n  botón de anular");
    expect(mom).toContain("Anular la guía de una salida RELLENADA la devuelve a `por definir`");
    expect(mom).toContain("se cancela allá primero y solo entonces\n  acá");
  });
});
