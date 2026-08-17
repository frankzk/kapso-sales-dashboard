import { describe, it, expect } from "vitest";
import {
  isFillableRouteOutput,
  pickFillableRouteOutput,
  manualOutputIsCancelable,
  COURIER_TBD,
  MANUAL_ROUTE_CREATED_VIA,
  ROUTE_OUTPUT_FILLED,
  filledShipmentIds,
  manualRouteGuideCode,
  restoredRouteOutputPatch,
} from "@/lib/shipment-output";
import { stripKeys } from "@/lib/route-output-fill";

/**
 * Rellenar la salida «por definir» con la guía del courier.
 *
 * El rodeo que esto elimina: para crear la guía de Tanders había que ANULAR la
 * salida —el guardián de «ya tiene guía activa» la contaba—, y anularla
 * arrastraba al pedido a `anulado` (#KP127639). Rellenarla es además lo que ya
 * hacen físicamente: el rótulo interno dice «Por definir» y le pegan el del
 * courier encima.
 *
 * Lo que se prueba es a QUÉ salida se le puede escribir encima. Equivocarse acá
 * no lanza: pisa una caja que no era, o duplica una que sí se podía reusar.
 */

const salida = (over: Record<string, unknown> = {}) => ({
  courier: COURIER_TBD,
  created_via: MANUAL_ROUTE_CREATED_VIA,
  delivery_status: "pendiente",
  custody_state: "empresa",
  custody_transferred_at: null as string | null,
  output_number: 1,
  ...over,
});

describe("isFillableRouteOutput", () => {
  it("una salida por definir, pendiente y en almacén se rellena", () => {
    expect(isFillableRouteOutput(salida())).toBe(true);
  });

  it("con courier ya decidido NO se rellena", () => {
    // Escribir encima pisaría una decisión anterior. Cambiar de courier es otra
    // cosa y tiene su propio camino: se anula la guía del courier y se crea otra.
    expect(isFillableRouteOutput(salida({ courier: "tanders" }))).toBe(false);
    expect(isFillableRouteOutput(salida({ courier: "shalom" }))).toBe(false);
  });

  it("una guía de courier (no ruta manual) NO se rellena", () => {
    // Aliclik y Shalom emiten del otro lado: escribir encima dejaría su guía
    // viva allá y otra distinta acá.
    expect(isFillableRouteOutput(salida({ created_via: "aliclik_api" }))).toBe(false);
    expect(isFillableRouteOutput(salida({ created_via: null }))).toBe(false);
  });

  it("si la caja ya salió con el motorizado NO se rellena", () => {
    // Hay un paquete en la calle: reescribir su fila lo haría desaparecer del
    // seguimiento sin que nadie se entere.
    expect(isFillableRouteOutput(salida({ custody_transferred_at: "2026-08-12T10:00:00Z" }))).toBe(false);
    expect(isFillableRouteOutput(salida({ custody_state: "motorizado" }))).toBe(false);
  });

  it("solo `pendiente`: en ruta, entregada o anulada ya pasaron cosas", () => {
    for (const estado of ["en_ruta", "entregado", "devuelto", "anulado"]) {
      expect(isFillableRouteOutput(salida({ delivery_status: estado })), estado).toBe(false);
    }
  });

  it("es MÁS estricto que poder anularla: la anulable con courier no se rellena", () => {
    // Las dos preguntas comparten condiciones pero no son la misma. Una salida
    // con courier decidido se puede anular (se creó con el equivocado) y NO se
    // puede rellenar: rellenarla escondería el cambio de courier.
    const conCourier = salida({ courier: "tanders" });
    expect(manualOutputIsCancelable(conCourier)).toBe(true);
    expect(isFillableRouteOutput(conCourier)).toBe(false);
  });
});

describe("pickFillableRouteOutput", () => {
  it("sin candidatas devuelve null y se crea una salida nueva", () => {
    expect(pickFillableRouteOutput([])).toBeNull();
    expect(pickFillableRouteOutput([salida({ courier: "tanders" })])).toBeNull();
  });

  it("elige la de consecutivo MÁS ALTO", () => {
    // Es la última creada, o sea la caja que el almacén tiene delante. Elegir la
    // más vieja rellenaría una salida que quizá ya se dio por perdida.
    const elegida = pickFillableRouteOutput([
      salida({ output_number: 1 }),
      salida({ output_number: 3 }),
      salida({ output_number: 2 }),
    ]);
    expect(elegida?.output_number).toBe(3);
  });

  it("ignora las que no se pueden rellenar aunque tengan consecutivo mayor", () => {
    const elegida = pickFillableRouteOutput([
      salida({ output_number: 1 }),
      salida({ output_number: 9, custody_transferred_at: "2026-08-12T10:00:00Z" }),
    ]);
    expect(elegida?.output_number).toBe(1);
  });

  it("un consecutivo nulo no gana a uno real", () => {
    const elegida = pickFillableRouteOutput([
      salida({ output_number: null }),
      salida({ output_number: 1 }),
    ]);
    expect(elegida?.output_number).toBe(1);
  });
});

describe("rellenar decide el courier, no deshace el trabajo del almacén", () => {
  // La caja ya existe: lo nuevo es quién la lleva. Lo que el almacén hizo sobre
  // ella —y la identidad con la que se rotuló— sobrevive al relleno.
  const fila = {
    courier: "shalom",
    guide_code: "92084077",
    created_via: "shalom_pro_manual",
    delivery_status: "pendiente",
    // Lo que NO debe viajar en el UPDATE:
    store_id: "st-1",
    order_id: "or-1",
    preparation_state: "rotulo_generado",
    custody_state: "empresa",
    custody_transferred_at: null,
    ready_at: null,
    qr_token: "token-nuevo",
    output_number: 9,
    output_code: "KP1-S09",
  };

  it("la guía sí se escribe", () => {
    const out = stripKeys(fila);
    expect(out.courier).toBe("shalom");
    expect(out.guide_code).toBe("92084077");
    expect(out.created_via).toBe("shalom_pro_manual");
    expect(out.delivery_status).toBe("pendiente");
  });

  it("el avance de preparación NO se pisa", () => {
    // Mandar `rotulo_generado` haría retroceder una caja ya escaneada como
    // `listo_despacho`: borrar un escaneo real para registrar una guía.
    const out = stripKeys(fila);
    expect(out).not.toHaveProperty("preparation_state");
    expect(out).not.toHaveProperty("custody_state");
    expect(out).not.toHaveProperty("custody_transferred_at");
    expect(out).not.toHaveProperty("ready_at");
  });

  it("la identidad de la salida NO se pisa", () => {
    // El rótulo ya está pegado a la caja: cambiarle el QR o el consecutivo a
    // mitad de camino deja un papel que apunta a otra cosa.
    const out = stripKeys(fila);
    expect(out).not.toHaveProperty("qr_token");
    expect(out).not.toHaveProperty("output_number");
    expect(out).not.toHaveProperty("output_code");
  });

  it("tampoco se mueve de tienda ni de pedido", () => {
    const out = stripKeys(fila);
    expect(out).not.toHaveProperty("store_id");
    expect(out).not.toHaveProperty("order_id");
  });

  it("una fila que solo trae guía pasa entera", () => {
    const minima = { courier: "tanders", guide_code: "T-1", created_via: "tanders_api" };
    expect(stripKeys(minima)).toEqual(minima);
  });
});

describe("deshacer el relleno cuando se anula la guía del courier", () => {
  // Anular la guía de Shalom sobre una salida RELLENADA no puede significar lo
  // mismo que anular una salida cualquiera: la caja sigue armada y en almacén.
  // Con una sola salida, marcarla `anulado` cerraba la venta entera — la misma
  // forma de #KP127639 llegando por la puerta del courier.

  it("saber que fue rellenada sale del EVENTO, no de la forma de la fila", () => {
    // Una fila rellenada y una creada de cero acaban idénticas: courier del
    // courier, `created_via` del courier, `pendiente`. No hay forma que las
    // distinga, y deducirlo fue el error que documenta cancelledAsRecordCorrection.
    const eventos = [
      { kind: ROUTE_OUTPUT_FILLED, shipment_id: "rellenada" },
      { kind: "guide_created", shipment_id: "nueva" },
      { kind: "route_output_cancelled", shipment_id: "otra" },
    ];
    const ids = filledShipmentIds(eventos);
    expect(ids.has("rellenada")).toBe(true);
    expect(ids.has("nueva")).toBe(false);
    expect(ids.has("otra")).toBe(false);
  });

  it("un evento sin salida no ensucia el conjunto", () => {
    expect(filledShipmentIds([{ kind: ROUTE_OUTPUT_FILLED, shipment_id: null }]).size).toBe(0);
  });

  it("la salida vuelve a «por definir» y a pendiente, no a anulada", () => {
    const patch = restoredRouteOutputPatch("#KP128169", "a053a4fa-6130-4ac1-adbe-dc9a6d161d2e");
    expect(patch.courier).toBe(COURIER_TBD);
    expect(patch.created_via).toBe(MANUAL_ROUTE_CREATED_VIA);
    expect(patch.delivery_status).toBe("pendiente");
    expect(patch.status_category).toBe("pending");
    // La agencia y el sub-estado eran del courier que acaba de irse.
    expect(patch.pickup_state).toBeNull();
    expect(patch.agency_branch).toBeNull();
  });

  it("no toca la identidad ni el avance de la caja", () => {
    // El consecutivo, el QR y el escaneo nunca dejaron de ser de esta caja.
    const patch = restoredRouteOutputPatch("#KP128169", "a053a4fa");
    for (const k of [
      "output_code",
      "output_number",
      "qr_token",
      "preparation_state",
      "custody_state",
      "ready_at",
    ]) {
      expect(patch).not.toHaveProperty(k);
    }
  });

  it("el código interno se reconstruye idéntico al que tuvo", () => {
    // Se perdió cuando el número del courier lo pisó, pero es función pura del
    // pedido y del id de la fila. Si las dos fórmulas divergieran, la caja
    // quedaría con un rótulo pegado que ya no casa con su fila.
    const id = "7f1ea6f4-3581-40f6-9d22-37541aaddf55";
    expect(manualRouteGuideCode("#KP127579", id)).toBe("MOM-KP127579-POR_DEFINIR-7F1EA6F4");
    expect(restoredRouteOutputPatch("#KP127579", id).guide_code).toBe(
      "MOM-KP127579-POR_DEFINIR-7F1EA6F4",
    );
  });

  it("el mismo generador sirve para los couriers manuales", () => {
    // Lo comparte quien CREA la salida, para que las dos fórmulas no diverjan.
    expect(manualRouteGuideCode("#KP1", "abcdef12-0000-0000-0000-000000000000", "olva")).toBe(
      "MOM-KP1-OLVA-ABCDEF12",
    );
  });

  it("sin nombre de pedido sigue dando un código utilizable", () => {
    expect(manualRouteGuideCode(null, "abcdef12-0000-0000-0000-000000000000")).toBe(
      "MOM-ABCDEF12-POR_DEFINIR-ABCDEF12",
    );
  });
});
