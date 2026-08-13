import { describe, it, expect } from "vitest";
import {
  isFillableRouteOutput,
  pickFillableRouteOutput,
  manualOutputIsCancelable,
  COURIER_TBD,
  MANUAL_ROUTE_CREATED_VIA,
} from "@/lib/shipment-output";

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
