import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADELANTO_MINIMO, ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";
import { SHALOM_MINIMUM_ADVANCE, paymentState } from "@/lib/pickup-key";
import { PAYMENT_REQUIREMENT_LABEL, aliclikRiskGate } from "@/lib/order-confirmation-brief";

/**
 * El adelanto mínimo: UN número, UN sitio.
 *
 * EL CASO. #KP133181 (Agencia, S/ 80,10) tenía un adelanto de S/ 20 VALIDADO y
 * el drawer decía «Faltan S/ 10.00 para el adelanto mínimo» y «Sigue en
 * confirmación hasta validar el pago exigido». La operación acepta S/ 20 a
 * diario —de 78 cargados, 76 validados— pero el sistema exigía 30.
 *
 * LO QUE SE ENCONTRÓ AL BAJARLO. El 30 no vivía en una constante: vivía en una
 * constante Y copiado a mano en siete sitios más — dos comprobaciones (el
 * servidor que crea Olva, `validated < 30`, y el KPI de «Adelanto de Agencia»,
 * `>= 30`) y cinco textos de pantalla. Cambiar la constante sola habría dejado
 * al sistema aceptando S/ 20 mientras Olva seguía exigiendo 30 en el servidor y
 * la pantalla seguía pidiendo 30. Es la forma exacta del bug que este
 * repositorio arrastra: el mismo hecho escrito en dos lugares, libres de
 * separarse.
 *
 * Por eso el número vive ahora en un módulo hoja sin imports y TODO lo demás lo
 * lee de ahí. Estas pruebas son el candado.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

/**
 * Código sin comentarios. La prosa puede —y debe— contar la historia («un Yape
 * de S/ 30 validado» en #AUR176259, «era S/ 30 hasta el 08-09»); lo que no puede
 * es que el número esté en una comparación o en un texto que se enseña. Sin
 * esto, la explicación de por qué cambió el número haría fallar la prueba.
 */
function sinComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("el número", () => {
  it("es 20, decidido el 08-09-2026", () => {
    expect(ADELANTO_MINIMO).toBe(20);
    expect(ADELANTO_MINIMO_LABEL).toBe("S/ 20");
  });

  it("y `SHALOM_MINIMUM_ADVANCE` es el MISMO número, no una copia", () => {
    // `pickup-key` lo re-expone para no romper a quien lo importaba de ahí. Si
    // alguien vuelve a escribir un literal en `pickup-key`, esto lo delata.
    expect(SHALOM_MINIMUM_ADVANCE).toBe(ADELANTO_MINIMO);
    const src = read("lib/pickup-key.ts");
    expect(src).toContain("export const SHALOM_MINIMUM_ADVANCE = ADELANTO_MINIMO;");
    expect(src).not.toMatch(/SHALOM_MINIMUM_ADVANCE\s*=\s*\d/);
  });

  it("vive en un módulo hoja: sin imports, para que nadie arriesgue un ciclo", () => {
    expect(read("lib/adelanto-minimo.ts")).not.toMatch(/^\s*import\s/m);
  });
});

describe("todo el mundo lo lee de ahí", () => {
  // Cada archivo que antes tenía el número escrito a mano. Si alguno vuelve a
  // escribir «S/ 30», «S/ 20», «< 30» o «>= 30» junto a la palabra adelanto,
  // falla. Se busca cerca de la palabra para no disparar con un «30 días».
  const sitios = [
    "app/dashboard/pedidos/actions.ts",
    "lib/mom-owner-summary.ts",
    "lib/order-route-plan.ts",
    "lib/shalom/draft.ts",
    "components/manual-route-output-modal.tsx",
    "components/mom-owner-summary.tsx",
    "lib/order-confirmation-brief.ts",
    "lib/confirmacion-agencia.ts",
    "components/pickup-key-panel.tsx",
  ];

  for (const sitio of sitios) {
    it(`${sitio} no lleva el número a mano`, () => {
      const src = sinComentarios(read(sitio));
      // Tres formas válidas de no tener el número: leerlo del módulo hoja,
      // leerlo de `pickup-key` (que lo re-expone como enlace) o delegar en
      // `advanceValidated`, que ya lo aplica. Lo que no vale es escribirlo.
      expect(
        src.includes('from "@/lib/adelanto-minimo"') ||
          src.includes("SHALOM_MINIMUM_ADVANCE") ||
          src.includes(".advanceValidated"),
      ).toBe(true);
      // Texto «S/ 20» o «S/ 30» literal, con o sin espacio.
      expect(src).not.toMatch(/S\/\s?(20|30)\b/);
      // Comparaciones numéricas contra el umbral.
      expect(src).not.toMatch(/(<|>=)\s*(20|30)\b/);
    });
  }

  it("las dos comprobaciones de verdad usan la constante", () => {
    // No basta con que el texto sea correcto: Olva se bloquea en el SERVIDOR y
    // el KPI cuenta pedidos. Ésos son los que mentían con más consecuencia.
    expect(read("app/dashboard/pedidos/actions.ts")).toContain("validated < ADELANTO_MINIMO");
    expect(read("lib/mom-owner-summary.ts")).toContain(">= ADELANTO_MINIMO");
  });
});

describe("y el sistema se comporta como dice", () => {
  it("S/ 20 validados ya cuentan como adelanto validado", () => {
    // Lo que #KP133181 no conseguía.
    expect(
      paymentState(
        [{ kind: "adelanto", validation_status: "validado", order_id: "o", amount: 20 }],
        80.1,
      ),
    ).toBe("adelanto_validado");
  });

  it("por debajo del mínimo sigue siendo «cargado»", () => {
    expect(
      paymentState(
        [{ kind: "adelanto", validation_status: "validado", order_id: "o", amount: ADELANTO_MINIMO - 1 }],
        80.1,
      ),
    ).toBe("adelanto_cargado");
  });

  it("la escalera de riesgo dice el mismo número que el mínimo", () => {
    // Son EL MISMO número: la compuerta lee `payment_state`, que se deriva de la
    // constante. Un rótulo que dijera «30» mientras la compuerta acepta 20
    // sería la mentira de siempre.
    expect(PAYMENT_REQUIREMENT_LABEL.exigir_adelanto).toBe(`Exigir adelanto de ${ADELANTO_MINIMO_LABEL}`);
    expect(PAYMENT_REQUIREMENT_LABEL.sugerir_adelanto).toBe(`Sugerir adelanto de ${ADELANTO_MINIMO_LABEL}`);
    expect(aliclikRiskGate("exigir_adelanto", "sin_pago").message).toContain(ADELANTO_MINIMO_LABEL);
  });
});

describe("queda escrito donde manda", () => {
  it("el MOM dice 20 en las reglas, no 30", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("Adelanto mínimo: **S/20** validado antes de generar rótulo");
    expect(mom).toContain("| 1 | Sugerir adelanto de S/20 |");
    expect(mom).toContain("| 2 | Exigir adelanto de S/20 |");
    expect(mom).toContain("Olva no se crea con menos de S/ 20 validados");
    expect(mom).toContain("lib/adelanto-minimo.ts");
  });
});
