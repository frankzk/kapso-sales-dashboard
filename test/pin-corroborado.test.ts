import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPARTAMENTO_POR_ISO,
  departamentoDeCodigoIso,
  pinSinCorroborar,
} from "@/lib/pin-corroborado";
import { shopifyDepartamentoElegido } from "@/lib/shopify-address";

/**
 * «Aquí un pedido de Puno se mandó a Cusco.»
 *
 * #KP133769, 11-09-2026. La clienta eligió Puno en el desplegable del checkout,
 * escribió «Puno» como ciudad y su checkout geocodificó el punto en Puno. La
 * guía salió con un pin en Santiago, Cusco — 331 km — y el paquete volvió.
 *
 * A Aliclik solo se le mandan `warehouseId`, `lat` y `lng`: el pin ES el
 * destino. El aviso que existía comparaba solo el distrito y saltaba en 1.958
 * de 4.173 guías (47%), casi siempre por nada; este caso salió ahí dentro.
 */

/** Los cinco casos medidos en que el pin estaba mal. Ninguno se entregó. */
const PIN_MALO = [
  {
    pedido: "#KP133769",
    iso: "PE-PUN",
    ciudad: "Puno",
    pinDistrito: "Santiago",
    pinDepartamento: "Cusco",
  },
  {
    pedido: "#KP134170",
    iso: "PE-PIU",
    ciudad: "Sullana",
    pinDistrito: "La Esperanza",
    pinDepartamento: "La Libertad",
  },
  {
    pedido: "#KP130297",
    iso: "PE-ICA",
    ciudad: "Chincha Alta",
    pinDistrito: "Victor Larco Herrera",
    pinDepartamento: "La Libertad",
  },
  {
    pedido: "#KP127265",
    iso: "PE-CUS",
    ciudad: "Cusco",
    pinDistrito: "Paucarpata",
    pinDepartamento: "Arequipa",
  },
  {
    pedido: "#KP123779",
    iso: "PE-CAJ",
    ciudad: "Cajamarca",
    pinDistrito: "Cayma",
    pinDepartamento: "Arequipa",
  },
];

/**
 * Los cuatro casos medidos en que el pin estaba BIEN y quien se equivocó fue la
 * clienta al elegir el departamento. #KP126473 se entregó sin problema.
 */
const DESPLEGABLE_MALO = [
  {
    pedido: "#KP126473",
    iso: "PE-LIM",
    ciudad: "Pucallpa",
    pinDistrito: "Pucallpa",
    pinDepartamento: "Ucayali",
  },
  {
    pedido: "#KP132869",
    iso: "PE-JUN",
    ciudad: "Cajamarca",
    pinDistrito: "Cajamarca",
    pinDepartamento: "Cajamarca",
  },
  {
    pedido: "#KP131735",
    iso: "PE-LAL",
    ciudad: "Cajamarca",
    pinDistrito: "Cajamarca",
    pinDepartamento: "Cajamarca",
  },
  {
    pedido: "#KP125277",
    iso: "PE-LMA",
    ciudad: "Ica",
    pinDistrito: "Ica",
    pinDepartamento: "Ica",
  },
];

const evaluar = (c: {
  iso: string;
  ciudad: string;
  pinDistrito: string;
  pinDepartamento: string;
}) =>
  pinSinCorroborar({
    departamentoDelPin: c.pinDepartamento,
    distritoDelPin: c.pinDistrito,
    isoDelCheckout: c.iso,
    ciudadEscrita: c.ciudad,
  });

describe("separa el pin equivocado del desplegable equivocado", () => {
  it("bloquea los cinco casos en que el pin contradijo a todo el pedido", () => {
    for (const caso of PIN_MALO) {
      expect(evaluar(caso), caso.pedido).toBeTruthy();
    }
  });

  /**
   * ESTO ES LO QUE EVITA QUE LA REGLA SE VUELVA RUIDO. Si el pin cae en el
   * distrito que ella misma escribió, el pin está corroborado aunque el
   * desplegable diga otra cosa. Sin esta segunda oportunidad, la regla
   * bloquearía cuatro guías legítimas —una de ellas ya entregada.
   */
  it("deja pasar los cuatro en que el pin sí coincidía con la ciudad escrita", () => {
    for (const caso of DESPLEGABLE_MALO) {
      expect(evaluar(caso), caso.pedido).toBeNull();
    }
  });

  it("el aviso nombra los dos sitios, que es lo que hay que comparar", () => {
    const aviso = evaluar(PIN_MALO[0]!)!;
    expect(aviso).toContain("Santiago, Cusco");
    expect(aviso).toContain("Puno");
    expect(aviso).toContain("Ubicación y cobertura");
  });
});

describe("no bloquea por diferencias que no son de lugar", () => {
  it("Cusco y Cuzco son el mismo sitio", () => {
    expect(
      pinSinCorroborar({
        departamentoDelPin: "Cusco",
        distritoDelPin: "Wanchaq",
        isoDelCheckout: "PE-CUS",
        ciudadEscrita: "Cuzco",
      }),
    ).toBeNull();
  });

  it("las tildes tampoco", () => {
    expect(
      pinSinCorroborar({
        departamentoDelPin: "Junin",
        distritoDelPin: "El Tambo",
        isoDelCheckout: "PE-JUN",
        ciudadEscrita: "Huancayo",
      }),
    ).toBeNull();
  });

  /** PE-LIM y PE-LMA son dos códigos para el departamento que Aliclik llama Lima. */
  it("los dos códigos de Lima valen para el mismo departamento", () => {
    for (const iso of ["PE-LIM", "PE-LMA"]) {
      expect(
        pinSinCorroborar({
          departamentoDelPin: "Lima",
          distritoDelPin: "San Martin de Porres",
          isoDelCheckout: iso,
          ciudadEscrita: "Los Olivos",
        }),
        iso,
      ).toBeNull();
    }
  });
});

describe("no se inventa un bloqueo cuando falta la segunda declaración", () => {
  /**
   * 8.264 de 23.034 pedidos no traen el código. Para ellos esto no cambia nada:
   * siguen con el aviso de distrito de siempre. Bloquear con una sola fuente
   * sería exactamente el error que esta regla existe para no cometer.
   */
  it("sin código ISO no hay puerta", () => {
    expect(
      pinSinCorroborar({
        departamentoDelPin: "Cusco",
        distritoDelPin: "Santiago",
        isoDelCheckout: null,
        ciudadEscrita: "Puno",
      }),
    ).toBeNull();
  });

  /**
   * El mismo campo llega a veces con texto libre —«Trujillo», «San Roman», y en
   * un pedido el nombre de la clienta—. Eso no es una declaración del
   * departamento: es otra cosa escrita en el hueco equivocado.
   */
  it("el texto libre en ese campo no cuenta como elección", () => {
    for (const basura of ["Trujillo", "San Roman", "vanessa pena", "PE-XXXX", "PUN", ""]) {
      expect(departamentoDeCodigoIso(basura), basura).toBeNull();
    }
  });

  it("sin departamento del pin tampoco se decide nada", () => {
    expect(
      pinSinCorroborar({
        departamentoDelPin: null,
        distritoDelPin: null,
        isoDelCheckout: "PE-PUN",
        ciudadEscrita: "Puno",
      }),
    ).toBeNull();
  });
});

describe("la tabla ISO", () => {
  it("cubre los 25 departamentos más el Callao, sin inventar códigos", () => {
    // 26 claves: los 24 departamentos, el Callao, y los DOS códigos de Lima.
    expect(Object.keys(DEPARTAMENTO_POR_ISO)).toHaveLength(26);
    expect(new Set(Object.values(DEPARTAMENTO_POR_ISO)).size).toBe(25);
    for (const code of Object.keys(DEPARTAMENTO_POR_ISO)) {
      expect(code, code).toMatch(/^PE-[A-Z]{3}$/);
    }
  });

  it("resuelve el código del caso que lo originó", () => {
    expect(departamentoDeCodigoIso("PE-PUN")).toBe("Puno");
    expect(departamentoDeCodigoIso("pe-pun")).toBe("Puno");
  });
});

describe("leer el desplegable del pedido de Shopify", () => {
  /** El payload real de #KP133769, recortado. */
  const raw = {
    customAttributes: [
      { key: "Ciudad", value: "Puno" },
      { key: "Dirección completa:", value: "JR.velasco Astete 191" },
      { key: "Provincia:", value: "PE-PUN" },
      { key: "country", value: "PE" },
    ],
  };

  it("saca el código de #KP133769", () => {
    expect(shopifyDepartamentoElegido(raw)).toBe("PE-PUN");
  });

  it("acepta también la forma REST del webhook", () => {
    expect(
      shopifyDepartamentoElegido({ note_attributes: [{ name: "Provincia:", value: "PE-CUS" }] }),
    ).toBe("PE-CUS");
  });

  it("ignora lo que hay en ese campo cuando no es un código", () => {
    expect(
      shopifyDepartamentoElegido({ customAttributes: [{ key: "Provincia:", value: "Trujillo" }] }),
    ).toBeNull();
    expect(shopifyDepartamentoElegido({})).toBeNull();
    expect(shopifyDepartamentoElegido(null)).toBeNull();
  });
});

describe("la puerta está en el sitio por el que pasan las dos acciones", () => {
  const src = readFileSync(
    resolve(process.cwd(), "app/dashboard/pedidos/aliclik-actions.ts"),
    "utf8",
  );

  /**
   * `createAliclikGuide` revalida llamando a `previewAliclikGuide`. Poner la
   * comprobación en la vista previa la deja cubriendo las dos puertas con un
   * solo candado; ponerla solo en la creación dejaría cotizar sin aviso.
   */
  it("la comprobación vive en la vista previa, que es lo que revalida la creación", () => {
    const check = src.indexOf("const pinDudoso = pinSinCorroborar({");
    expect(check).toBeGreaterThan(-1);
    expect(src).toContain("if (pinDudoso && !input.pinExceptionReason?.trim())");
  });

  it("la excepción se exige por escrito y queda registrada", () => {
    expect(src).toContain('kind: "aliclik_pin_exception"');
    expect(src).toContain("reason: pinExceptionReason");
  });

  it("la creación le pasa la excepción a la revalidación", () => {
    expect(src).toContain("pinExceptionReason: input.pinExceptionReason");
  });
});
