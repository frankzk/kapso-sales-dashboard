// Validar el cobro del courier cierra la liquidación del pedido.
//
// EL CASO. Un pedido contraentrega entregado se queda en «Por cerrar ·
// Pendiente de liquidación» hasta que exista un evento `liquidation_closed`
// (order-macro-stage.ts, ya probado en su propio archivo). La regla es
// correcta —no declarar un cierre financiero que nadie respalda— pero el
// 12-09-2026 no había NI UN evento así en toda la historia de la base: 4.204
// pedidos esperando una firma que nadie daba, porque la única forma de darla
// era un botón enterrado en el drawer, pedido a pedido.
//
// Ahora la firma existe y llega por donde tiene sentido: alguien mira el
// comprobante del motorizado en «Validar pagos» y dice que el dinero llegó.
// Lo que se fija acá es ese cableado, y sobre todo que se pueda DESHACER: un
// pedido no puede quedarse finalizado por una firma que después se retiró.
//
// Se comprueba sobre el código —como test/payment-four-eyes.test.ts— porque
// son server actions: lo que importa es que el evento se emita en los tres
// sitios y con el signo correcto, y eso es una propiedad del texto.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COURIER_COLLECTION_KIND } from "@/lib/tanders/collection-payment";

const ACTIONS = readFileSync(
  resolve(process.cwd(), "app/dashboard/pedidos/payment-actions.ts"),
  "utf8",
);

/** El cuerpo de una función exportada, para poder mirarla aislada. */
function cuerpoDe(nombre: string): string {
  const desde = ACTIONS.indexOf(`export async function ${nombre}(`);
  expect(desde, `no se encontró ${nombre}`).toBeGreaterThan(-1);
  const siguiente = ACTIONS.indexOf("\nexport ", desde + 1);
  return ACTIONS.slice(desde, siguiente === -1 ? undefined : siguiente);
}

describe("el cobro del courier cierra el pedido", () => {
  it("validar emite el cierre de liquidación", () => {
    expect(cuerpoDe("validatePayment")).toContain("ajustarLiquidacionDelCobro");
  });

  it("rechazar y observar lo reabren, no lo cierran otra vez", () => {
    // El tercer argumento es el signo: `true` cierra, `false` reabre. Si estos
    // dos cerraran, retirar la validación dejaría el pedido finalizado igual.
    for (const accion of ["rejectPayment", "observePayment"]) {
      const cuerpo = cuerpoDe(accion);
      expect(cuerpo, accion).toContain("ajustarLiquidacionDelCobro");
      expect(cuerpo, accion).toContain("false,");
      expect(cuerpo, accion).not.toMatch(/ajustarLiquidacionDelCobro\([\s\S]{0,120}?true,/);
    }
  });

  it("solo reabre lo que ESTABA validado", () => {
    // Rechazar un cobro que nunca se validó no tiene liquidación que reabrir, y
    // emitir el evento igual dejaría una observación abierta de la nada que
    // bloquearía el cierre para siempre.
    for (const accion of ["rejectPayment", "observePayment"]) {
      expect(cuerpoDe(accion), accion).toContain('payment.validation_status === "validado"');
    }
  });

  it("no toca los pagos de la clienta: solo el cobro del courier", () => {
    // Un adelanto validado NO liquida nada — el courier sigue debiendo el
    // efectivo que cobró. La guarda vive en un solo sitio para que no se pueda
    // olvidar en uno de los tres.
    const helper = ACTIONS.slice(ACTIONS.indexOf("async function ajustarLiquidacionDelCobro"));
    expect(helper).toContain(`payment.kind !== COURIER_COLLECTION_KIND`);
    expect(COURIER_COLLECTION_KIND).toBe("cobro_courier");
  });

  it("usa el MISMO evento que el cierre manual del drawer", () => {
    // Si inventara un evento propio, la macroetapa no lo entendería y el pedido
    // seguiría en «Pendiente de liquidación» con la firma ya puesta.
    const helper = ACTIONS.slice(ACTIONS.indexOf("async function ajustarLiquidacionDelCobro"));
    expect(helper).toContain('"liquidation_closed"');
    expect(helper).toContain('"liquidation_observed"');
  });
});
