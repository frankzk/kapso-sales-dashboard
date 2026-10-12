// «Qué hacer con la caja» en Repro Lima (decisión 8 del owner; MOM §9.3).
// La acción la calcula Kapta (lib/repro-box-action.ts); Almacén no la elige.

import { describe, expect, it } from "vitest";
import {
  BOX_ACTION_LABEL,
  boxActionReadyLabel,
  otherLiveCourierOf,
  priorOutputsWith,
  reproBoxAction,
  type ReproBoxActionInput,
} from "@/lib/repro-box-action";
import { BOX_ACTION_LABEL as LABEL_FROM_LIMA, BOX_ACTIONS, type BoxLocation } from "@/lib/repro-lima";
import { sameCourier } from "@/lib/shipment-output";

const ownOffice: BoxLocation = { kind: "en_oficina", since: "2026-10-12T14:00:00Z", courier: "propio" };
const withRoy: BoxLocation = { kind: "con_motorizado", riderName: "Roy", since: "2026-10-10" };
const tandersBack: BoxLocation = { kind: "volviendo_courier", courier: "tanders" };
const tandersOffice: BoxLocation = { kind: "en_oficina", since: "2026-10-11T16:00:00Z", courier: "tanders" };

/** Grupo GF no entregó con su S01, que está en oficina, y se vuelve a acordar con Grupo GF. */
const base = (extra: Partial<ReproBoxActionInput> = {}): ReproBoxActionInput => ({
  outcome: "confirma",
  courier: "propio",
  changes: {},
  box: ownOffice,
  ownLiveCourier: "propio",
  lastFailedCourier: null,
  otherLiveCourier: null,
  totalOutputs: 1,
  priorWithCourier: 1,
  ...extra,
});

/** Tanders no entregó y su caja vuelve; no hay salida propia viva. */
const fromTanders = (extra: Partial<ReproBoxActionInput> = {}): ReproBoxActionInput =>
  base({ box: tandersBack, ownLiveCourier: null, lastFailedCourier: "tanders", priorWithCourier: 0, ...extra });

const action = (input: ReproBoxActionInput) => {
  const result = reproBoxAction(input);
  if ("problem" in result) throw new Error(`problema inesperado: ${result.problem}`);
  return result;
};
const problem = (input: ReproBoxActionInput) => {
  const result = reproBoxAction(input);
  if (!("problem" in result)) throw new Error(`se esperaba un problema y salió ${result.action}`);
  return result.problem;
};

describe("una acción por regla", () => {
  it("1. ya no lo quiere: desarmar y cerrar, sin anular la venta", () => {
    expect(reproBoxAction(base({ outcome: "no_quiere", courier: null }))).toEqual({
      action: "desarmar_cerrar",
      newSalida: false,
      label: "Almacén la desarma cuando esté en oficina (cuaderno «DESARMAR»). No anula la venta.",
    });
    // Aunque haya otra guía viva o el courier sea Urpi.
    expect(action(base({ outcome: "no_quiere", otherLiveCourier: "aliclik", courier: "urpi" })).action).toBe("desarmar_cerrar");
  });

  it("4. no esperar la caja con Roy: caja nueva desde stock con «Sacar con salida nueva»", () => {
    expect(reproBoxAction(base({ box: withRoy, changes: { no_esperar_caja: true } }))).toEqual({
      action: "caja_nueva_stock",
      newSalida: true,
      label: "Caja nueva desde stock con «Sacar con salida nueva» en Despacho del día; la de Roy se desarma al recibirla.",
    });
  });

  it("4. no esperar la caja que vuelve con Tanders", () => {
    expect(action(fromTanders({ changes: { no_esperar_caja: true } }))).toEqual({
      action: "caja_nueva_stock",
      newSalida: true,
      label: "Caja nueva desde stock y salida nueva de Grupo GF (la crea al tomarlo en Despacho del día); la que vuelve con Tanders se desarma al recibirla.",
    });
  });

  it("5. cambió el producto o la caja está dañada: desarmar y rearmar", () => {
    expect(reproBoxAction(base({ changes: { producto: true } }))).toEqual({
      action: "desarmar_rearmar",
      newSalida: true,
      label: "Desarmar y rearmar: salida, QR y rótulo nuevos (§9.3).",
    });
    expect(action(base({ changes: { caja_danada: true } })).action).toBe("desarmar_rearmar");
  });

  it("6. sin salida propia viva: salida nueva", () => {
    expect(action(fromTanders({ box: tandersOffice })).action).toBe("salida_nueva_rearmar");
  });

  it("7. cambió la dirección o el monto: reimprimir el rótulo de la misma salida", () => {
    const address = action(base({ changes: { direccion: true } }));
    expect(address.action).toBe("reimprimir_misma_salida");
    expect(address.newSalida).toBe(false);
    expect(address.label).toBe(
      "Reimprimir el rótulo de la misma salida: se retira el rótulo viejo (o se tacha el monto), se marca «REIMPRESO dd-mm» y el despachador compara el monto. Corrige antes la dirección en el editor de destino de la salida.",
    );
    const amount = action(base({ changes: { monto: true } }));
    expect(amount.action).toBe("reimprimir_misma_salida");
    expect(amount.label).not.toContain("editor de destino");
  });

  it("8. nada cambió: mantener", () => {
    expect(reproBoxAction(base())).toEqual({ action: "mantener", newSalida: false, label: "Mantener la caja: misma salida, QR y rótulo." });
  });

  it("8. solo el teléfono: mantener, y el teléfono va a la ficha y al motorizado", () => {
    const phone = action(base({ changes: { telefono: true } }));
    expect(phone.action).toBe("mantener");
    expect(phone.label).toBe(
      "Mantener la caja: misma salida, QR y rótulo. El teléfono nuevo se anota en la ficha y se le pasa al motorizado (§9.5, paso 4).",
    );
  });

  it("«No esperar la caja» con la caja en oficina no cambia nada", () => {
    expect(action(base({ changes: { no_esperar_caja: true } })).action).toBe("mantener");
  });

  it("un caso reabierto con la caja que no consta puede pedir caja nueva (E29)", () => {
    const reopened = action(base({ box: { kind: "desconocida" }, ownLiveCourier: null, changes: { no_esperar_caja: true } }));
    expect(reopened.action).toBe("caja_nueva_stock");
    expect(reopened.label).toContain("si aparece la anterior, se desarma");
  });
});

describe("precedencia", () => {
  it("producto + «no esperar» con la caja fuera: caja nueva desde stock", () => {
    expect(action(base({ box: withRoy, changes: { producto: true, no_esperar_caja: true } })).action).toBe("caja_nueva_stock");
    expect(action(fromTanders({ changes: { producto: true, no_esperar_caja: true } })).action).toBe("caja_nueva_stock");
  });

  it("producto + dirección: desarmar y rearmar", () => {
    expect(action(base({ changes: { producto: true, direccion: true } })).action).toBe("desarmar_rearmar");
  });

  it("cambio de courier + dirección: salida nueva, no reimpresión", () => {
    expect(action(base({ courier: "tanders", priorWithCourier: 0, changes: { direccion: true } })).action).toBe("salida_nueva_rearmar");
  });

  it("la caja que vuelve sin «no esperar» no cambia la acción (el plan dice cuándo)", () => {
    expect(action(fromTanders()).action).toBe("salida_nueva_rearmar");
  });
});

describe("las etiquetas dicen el courier acordado (E17)", () => {
  it("de Tanders a Grupo GF: el rótulo nuevo va encima, tapando el QR", () => {
    expect(action(fromTanders({ box: tandersOffice })).label).toBe(
      "Salida nueva de Grupo GF: el rótulo nuevo va encima del anterior, tapando su QR (§9.3).",
    );
  });

  it("de Grupo GF a Tanders: se rearma y se retira la etiqueta vieja", () => {
    expect(action(base({ courier: "tanders", priorWithCourier: 0 }))).toEqual({
      action: "salida_nueva_rearmar",
      newSalida: true,
      label: "Salida nueva de Tanders desde la Mesa de ruta: se rearma y se retira la etiqueta vieja.",
    });
  });

  it("caja de Roy y otro courier: nunca promete «Sacar con salida nueva»", () => {
    const label = action(base({ box: withRoy, courier: "tanders", priorWithCourier: 0, changes: { no_esperar_caja: true } })).label;
    expect(label).toBe("Caja nueva desde stock y salida de Tanders desde la Mesa de ruta; la de Roy se desarma al recibirla.");
    expect(label).not.toContain("Sacar con salida nueva");
  });

  it("producto cambiado con otro courier: su salida desde la Mesa de ruta", () => {
    expect(action(base({ courier: "axel", priorWithCourier: 0, changes: { producto: true } })).label).toBe(
      "Desarmar y rearmar con salida, QR y rótulo nuevos de Axel desde la Mesa de ruta (§9.3).",
    );
  });

  it("Swayp guardado como `swayp` o `fenix` es el mismo courier (E20)", () => {
    expect(sameCourier("swayp", "fenix")).toBe(true);
    expect(sameCourier("Motorizado propio", "propio")).toBe(true);
    expect(sameCourier("axel courier", "axel")).toBe(true);
    expect(sameCourier(null, "propio")).toBe(false);
    expect(priorOutputsWith([{ courier: "swayp" }, { courier: "fenix" }, { courier: "propio" }], "fenix")).toBe(2);
  });
});

describe("problemas", () => {
  it("otra guía viva: la trabaja ese courier", () => {
    expect(problem(base({ otherLiveCourier: "aliclik" }))).toBe("La guía de Aliclik sigue viva: la trabaja ese courier. Revísala en la ficha.");
    expect(problem(base({ otherLiveCourier: "fenix" }))).toBe("La guía de Swayp sigue viva: la trabaja ese courier. Revísala en la ficha.");
  });

  it("Urpi no lleva reprogramados en 1a (E16)", () => {
    expect(problem(fromTanders({ courier: "urpi" }))).toBe("Urpi solo lleva primeros despachos (§9.1); un reprogramado no pasa a Urpi en esta fase.");
    expect(problem(base({ courier: "urpi", hadPropio: true }))).toContain("Urpi solo lleva primeros despachos");
  });

  it("cinco salidas: solo queda «Desarmar y cerrar»", () => {
    expect(problem(fromTanders({ totalOutputs: 5 }))).toBe("Ya usó las 5 salidas: solo queda «Desarmar y cerrar».");
    expect(problem(base({ totalOutputs: 5, changes: { producto: true } }))).toBe("Ya usó las 5 salidas: solo queda «Desarmar y cerrar».");
    // Sin salida nueva el tope no estorba.
    expect(action(base({ totalOutputs: 5 })).action).toBe("mantener");
    expect(action(base({ totalOutputs: 5, changes: { direccion: true } })).action).toBe("reimprimir_misma_salida");
  });

  it("Tanders dos veces: en Lima va una sola vez", () => {
    expect(problem(fromTanders({ courier: "tanders", priorWithCourier: 1 }))).toBe("Tanders ya llevó este pedido: en Lima va una sola vez.");
    expect(problem(base({ courier: "fenix", priorWithCourier: 1 }))).toBe("Swayp ya llevó este pedido: en Lima va una sola vez.");
    // Grupo GF y Axel se repiten.
    expect(action(base({ courier: "axel", priorWithCourier: 2 })).action).toBe("salida_nueva_rearmar");
  });

  it("caja nueva con la caja de Roy que «Sacar con salida nueva» no puede sacar: su motivo (E18)", () => {
    expect(problem(base({
      box: withRoy,
      changes: { no_esperar_caja: true },
      ownReplace: { decision: { action: "bloquear", reason: "caja_sin_reporte" }, outputCode: "KP138029-S01" },
    }))).toBe("KP138029-S01 sigue en la caja de Roy sin «No entregado»: revisa su parada.");
    expect(problem(base({
      box: withRoy,
      changes: { no_esperar_caja: true },
      ownReplace: { decision: { action: "bloquear", reason: "solicitud_en_otra_salida" }, outputCode: "KP138029-S01" },
    }))).toBe("La solicitud de Grupo GF del pedido es de otra salida: revísala en la ficha.");
    expect(action(base({
      box: withRoy,
      changes: { no_esperar_caja: true },
      ownReplace: { decision: { action: "sacar" }, outputCode: "KP138029-S01" },
    })).action).toBe("caja_nueva_stock");
  });

  it("sin courier elegido", () => {
    expect(problem(base({ courier: null }))).toBe("Elige con qué courier sale.");
  });
});

describe("lista para (E14)", () => {
  it("mantener hoy hasta el corte; lo de la noche anterior, desde mañana", () => {
    expect(boxActionReadyLabel("mantener", "propio", "12:00:00")).toBe("Lista para hoy si se confirma hasta las 12:00.");
    expect(boxActionReadyLabel("reimprimir_misma_salida", "propio", "12:00")).toBe("Lista desde mañana: se prepara la noche anterior.");
    expect(boxActionReadyLabel("desarmar_rearmar", "propio", "12:00")).toBe("Lista desde mañana: se prepara la noche anterior.");
    expect(boxActionReadyLabel("salida_nueva_rearmar", "tanders", "12:00")).toBe("Lista desde mañana: se prepara la noche anterior.");
    expect(boxActionReadyLabel("caja_nueva_stock", "fenix", "12:00")).toBe("Lista desde mañana: Swayp arma su ruta el día anterior.");
  });
});

describe("otherLiveCourierOf", () => {
  it("la guía viva de otro courier, no la de Tanders que vuelve ni la propia", () => {
    expect(otherLiveCourierOf([
      { id: "a", courier: "aliclik", delivery_status: "pendiente" },
      { id: "t", courier: "tanders", delivery_status: "en_ruta", reported_status: "RETURNING" },
    ])).toBe("aliclik");
    expect(otherLiveCourierOf([
      { id: "t", courier: "tanders", delivery_status: "en_ruta", reported_status: "RETURNING" },
      { id: "g", courier: "propio", delivery_status: "pendiente" },
    ])).toBeNull();
    expect(otherLiveCourierOf([{ id: "x", courier: "por_definir", delivery_status: "pendiente" }])).toBeNull();
  });
});

describe("BOX_ACTION_LABEL", () => {
  it("seis acciones, la misma tabla desde los dos módulos", () => {
    expect(Object.keys(BOX_ACTION_LABEL).sort()).toEqual([...BOX_ACTIONS].sort());
    expect(BOX_ACTION_LABEL).toBe(LABEL_FROM_LIMA);
    expect(BOX_ACTION_LABEL.mantener).toBe("Mantener");
    expect(BOX_ACTION_LABEL.caja_nueva_stock).toBe("Caja nueva desde stock");
  });
});
