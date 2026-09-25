import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOOR_REJECTION_BAN_THRESHOLD,
  ROUTES_STILL_ALLOWED,
  aliclikDoorBan,
  countDoorRejections,
} from "@/lib/door-rejection";
import { etiquetaDiceRechazoEnPuerta } from "@/lib/aliclik-status";

/**
 * EL CASO (25-09-2026). Dos clientes rechazaron en la puerta DOS veces y la
 * segunda guía Aliclik salió igual, con la ficha de riesgo del §8 ya puesta y ya
 * bloqueando. No falló el cruce de tiendas: falló que `confirmationRisk` cuenta
 * `anulado + devuelto` sobre `general_status`, y 92 de las 133 guías con
 * `REFUSED` están en `en_proceso`. El rechazo no pesaba hasta que el paquete
 * terminaba de volver, semanas después.
 */

describe("etiquetaDiceRechazoEnPuerta: solo el primer segmento", () => {
  it("REFUSED en cabeza es un rechazo en la puerta", () => {
    for (const etiqueta of [
      "REFUSED · RETURNED · CONFIRMED",
      "REFUSED · TO_RETURN · CONFIRMED",
      "REFUSED · PICKED · CONFIRMED",
      "REFUSED",
      "  refused  · RETURNED",
    ]) {
      expect(etiquetaDiceRechazoEnPuerta(etiqueta), etiqueta).toBe(true);
    }
  });

  it("los otros finales malos NO son rechazo en la puerta", () => {
    // A quien no contestó se le vuelve a intentar; a quien lo tuvo en la mano y
    // lo devolvió, no. Meterlos en el mismo saco cerraría Aliclik a medio Perú.
    for (const etiqueta of [
      "NOT_RESPOND · RETURNED · CONFIRMED",
      "CANCEL · TO_RETURN · CONFIRMED",
      "ANNULLED · RETURNED",
      "PENDING_DELIVERY · TO_RETURN · CONFIRMED",
      "DELIVERED · PICKED · CONFIRMED",
    ]) {
      expect(etiquetaDiceRechazoEnPuerta(etiqueta), etiqueta).toBe(false);
    }
  });

  it("la palabra en OTRO segmento no cuenta", () => {
    // Un `contains("REFUSED")` daría true acá. El despacho y la llamada tienen
    // su propio vocabulario y nada impide que mañana traigan la palabra.
    expect(etiquetaDiceRechazoEnPuerta("CANCEL · REFUSED_BY_AGENCY · CONFIRMED")).toBe(false);
  });

  it("sin dato no es un rechazo: la ausencia no acusa", () => {
    for (const vacio of [null, undefined, "", "   "]) {
      expect(etiquetaDiceRechazoEnPuerta(vacio)).toBe(false);
    }
  });
});

describe("countDoorRejections: cuenta PEDIDOS, no guías", () => {
  it("dos pedidos rechazados son dos", () => {
    expect(
      countDoorRejections([
        { order_id: "a", reported_status: "REFUSED · LEFT_IN_WAREHOUSE · CONFIRMED" },
        { order_id: "b", reported_status: "REFUSED · TO_RETURN · CONFIRMED" },
      ]),
    ).toBe(2);
  });

  it("dos guías del MISMO pedido son UNA venta rechazada", () => {
    // Un pedido reintentado arrastra la etiqueta a la guía nueva. Contar guías
    // cerraría la ruta con un solo rechazo real, y el bloqueo no tiene marcha
    // atrás: ante la duda, la cuenta baja.
    expect(
      countDoorRejections([
        { order_id: "a", reported_status: "REFUSED · RETURNED · CONFIRMED" },
        { order_id: "a", reported_status: "REFUSED · TO_RETURN · CONFIRMED" },
      ]),
    ).toBe(1);
  });

  it("una guía huérfana no se le cuenta a nadie", () => {
    expect(countDoorRejections([{ order_id: null, reported_status: "REFUSED · RETURNED" }])).toBe(0);
  });

  it("las guías sin motivo no suman", () => {
    expect(
      countDoorRejections([
        { order_id: "a", reported_status: null },
        { order_id: "b", reported_status: "NOT_RESPOND · RETURNED" },
      ]),
    ).toBe(0);
  });
});

describe("aliclikDoorBan: el primer rechazo no cierra, el segundo sí", () => {
  it("cero y uno dejan pasar", () => {
    // 12 reenvíos medidos tras un rechazo: 4 entregados. Un tercio se recupera,
    // así que el primero no cierra la ruta — ahí manda la escalera del §8.
    expect(aliclikDoorBan(0).banned).toBe(false);
    expect(aliclikDoorBan(0).message).toBeNull();
    expect(aliclikDoorBan(1).banned).toBe(false);
  });

  it("dos cierran, y tres también", () => {
    expect(aliclikDoorBan(2).banned).toBe(true);
    expect(aliclikDoorBan(5).banned).toBe(true);
  });

  it("el umbral es el que dice la constante", () => {
    expect(aliclikDoorBan(DOOR_REJECTION_BAN_THRESHOLD - 1).banned).toBe(false);
    expect(aliclikDoorBan(DOOR_REJECTION_BAN_THRESHOLD).banned).toBe(true);
  });

  it("el mensaje dice por dónde SÍ puede salir, no solo que no", () => {
    // Quien lee esto tiene un pedido esperando. Un «no» sin salida obliga a
    // preguntar, y preguntar a las 7 de la tarde termina en que alguien lo
    // despacha igual.
    const m = aliclikDoorBan(2).message ?? "";
    expect(m).toContain("Shalom");
    expect(m).toContain("Olva");
    expect(m).toContain("Swayp");
    expect(m).toContain("permanente");
  });

  it("Aliclik es lo ÚNICO que se cierra", () => {
    // Es la única ruta que cobra el intento fallido. El cliente puede seguir
    // comprando: solo no por la que nos cuesta cuando falla.
    expect(ROUTES_STILL_ALLOWED).not.toContain("aliclik");
    for (const ruta of ["shalom", "olva", "swayp", "fenix"]) {
      expect(ROUTES_STILL_ALLOWED, ruta).toContain(ruta);
    }
  });

  it("`fenix` y `swayp` están las dos: son una ruta con dos nombres", () => {
    // Las guías Fénix se emiten por la API de Swayp (serie 5000…). Nombrar solo
    // una dejaría fuera la mitad de lo que aparece en `shipments.courier`.
    expect(ROUTES_STILL_ALLOWED).toContain("fenix");
    expect(ROUTES_STILL_ALLOWED).toContain("swayp");
  });
});

describe("el bloqueo es duro: no hay excepción que lo levante", () => {
  const banSource = readFileSync(resolve(process.cwd(), "lib/door-rejection.ts"), "utf8");
  const actions = readFileSync(
    resolve(process.cwd(), "app/dashboard/pedidos/aliclik-actions.ts"),
    "utf8",
  );

  it("`aliclikDoorBan` no recibe justificación por ningún lado", () => {
    // `aliclikRiskGate` sí la recibe y se ablanda con 8 caracteres. Este no: si
    // un día alguien le añade el parámetro, esta prueba se cae primero.
    expect(aliclikDoorBan.length).toBe(1);
    expect(banSource).not.toContain("exceptionReason");
  });

  it("la creación real lo consulta, y antes que la compuerta de plata", () => {
    const door = actions.indexOf("aliclikDoorBan(");
    const risk = actions.indexOf("aliclikRiskGate(");
    expect(door).toBeGreaterThan(-1);
    expect(risk).toBeGreaterThan(-1);
    // Por ruta antes que por plata: saber que la guía no va a salir importa
    // antes que saber cuánto hay que cobrar para que salga.
    expect(door).toBeLessThan(risk);
  });

  it("«no se pudo verificar» NO autoriza", () => {
    // Un fallo de lectura que se leyera como cero abriría la compuerta en
    // silencio. Así se perdieron dos guías el 05-09.
    expect(actions).toContain("confirmationBrief.doorRejections === null");
    const bloque = actions.slice(
      actions.indexOf("confirmationBrief.doorRejections === null"),
      actions.indexOf("aliclikDoorBan("),
    );
    expect(bloque).toContain("return");
  });
});

describe("la cuenta NO depende de que el paquete haya vuelto", () => {
  it("un rechazo con el paquete todavía en la calle ya cuenta", () => {
    // ESTE es el agujero que dejó pasar la segunda guía de Edwin: 92 de 133
    // rechazos están en `general_status = 'en_proceso'`, y la tabla del §8 solo
    // cuenta `anulado + devuelto`. Acá no se mira el estado del pedido.
    const rows = [
      { order_id: "a", reported_status: "REFUSED · PICKED · CONFIRMED" },
      { order_id: "b", reported_status: "REFUSED · REMAINING_IN_TRANSIT · CONFIRMED" },
    ];
    expect(countDoorRejections(rows)).toBe(2);
    expect(aliclikDoorBan(countDoorRejections(rows)).banned).toBe(true);
  });
});

describe("el MOM lo dice", () => {
  const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

  it("§8.2 nombra la regla, el umbral y que no se exceptúa", () => {
    expect(mom).toContain("### 8.2 Dos rechazos en la puerta cierran Aliclik para siempre");
    // El MOM va a 80 columnas y usa negritas, así que se compara sin saltos,
    // sin asteriscos y sin distinguir mayúsculas.
    const plano = mom.replace(/\s+/g, " ").replace(/\*/g, "").toLowerCase();
    expect(plano).toContain("no se puede exceptuar");
    expect(plano).toContain("shalom, olva o swayp/fénix");
    expect(plano).toContain("dos o más pedidos rechazados en la puerta");
  });
});
