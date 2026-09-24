import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  nombreDeCourier,
  puertaDeSalidaAdicional,
  salidasQueEstorban,
  type SalidaExistente,
} from "@/lib/shipment-output";

/**
 * «Un pedido puede tener varias salidas en Lima. No es necesario esperar el
 * reporte o la liquidación de la ruta de otro courier para sacarlo con otro
 * courier o motorizado.»
 *
 * Es el principio 7 del MOM y §9 («no es obligatorio esperar la devolución
 * anterior para crear otra salida»). La mesa de ruta manual ya lo cumplía; Tanders
 * y Swayp directa se negaban con «anúlala antes de crear otra» — y con la caja en
 * la calle no hay cómo anularla. Así quedaron #KP134960 y #KP134416 (24-09-2026).
 */

/** #KP134416: Grupo GF la tomó, custodia al motorizado, en la ruta de Alexis. */
const GRUPO_GF_EN_LA_CALLE: SalidaExistente = {
  courier: "propio",
  delivery_status: "pendiente",
  guide_code: "MOM-KP134416-PROPIO-21DD145C",
  output_code: "KP134416-S01",
  created_via: "grupo_gf_courier",
  custody_state: "courier",
  custody_transferred_at: "2026-09-20T01:50:41Z",
};

/** #KP134960: «por definir» con la custodia ya fuera de casa. */
const POR_DEFINIR_FUERA: SalidaExistente = {
  courier: "por_definir",
  delivery_status: "pendiente",
  guide_code: "MOM-KP134960-POR_DEFINIR-4139D779",
  output_code: "KP134960-S01",
  created_via: "mom_manual_route",
  custody_state: "courier",
  custody_transferred_at: "2026-09-18T17:00:00Z",
};

/** Una «por definir» todavía en casa: la guía se le escribe encima. */
const POR_DEFINIR_EN_CASA: SalidaExistente = {
  courier: "por_definir",
  delivery_status: "pendiente",
  output_code: "KP1-S01",
  created_via: "mom_manual_route",
  custody_state: "empresa",
  custody_transferred_at: null,
};

describe("en Lima, otra salida viva no bloquea: pide motivo", () => {
  for (const [pedido, courier, salida] of [
    ["#KP134960", "tanders", POR_DEFINIR_FUERA],
    ["#KP134416", "fenix", GRUPO_GF_EN_LA_CALLE],
  ] as const) {
    it(`${pedido}: sin motivo lo pide, con motivo pasa`, () => {
      const sin = puertaDeSalidaAdicional({
        courier,
        operation: "lima",
        outputs: [salida],
        motivo: null,
      });
      expect(sin.ok).toBe(false);
      if (!sin.ok) {
        expect(sin.pideMotivo).toBe(true);
        expect(sin.error).toContain("sin esperar su reporte");
        expect(sin.error).toContain(salida.output_code!);
      }

      const con = puertaDeSalidaAdicional({
        courier,
        operation: "lima",
        outputs: [salida],
        motivo: "Grupo GF no lo entregó hoy.",
      });
      expect(con.ok).toBe(true);
      if (con.ok) {
        expect(con.motivo).toBe("Grupo GF no lo entregó hoy.");
        expect(con.estorban).toHaveLength(1);
      }
    });
  }

  it("un motivo en blanco no cuenta como motivo", () => {
    const r = puertaDeSalidaAdicional({
      courier: "tanders",
      operation: "lima",
      outputs: [GRUPO_GF_EN_LA_CALLE],
      motivo: "   ",
    });
    expect(r.ok).toBe(false);
  });

  it("sin nada vivo no pide nada, como hasta hoy", () => {
    const r = puertaDeSalidaAdicional({
      courier: "tanders",
      operation: "lima",
      outputs: [POR_DEFINIR_EN_CASA, { ...GRUPO_GF_EN_LA_CALLE, delivery_status: "anulado" }],
      motivo: null,
    });
    expect(r).toEqual({ ok: true, estorban: [], motivo: null });
  });
});

describe("lo que NO se afloja, porque también es del MOM", () => {
  /** §9.3: Swayp, Urpi y Tanders una sola vez por pedido en Lima. */
  it("Tanders no se repite en Lima aunque haya motivo", () => {
    const tandersViva: SalidaExistente = {
      courier: "tanders",
      delivery_status: "pendiente",
      output_code: "KP1-S01",
      created_via: "tanders_api",
      custody_state: "courier",
    };
    const r = puertaDeSalidaAdicional({
      courier: "tanders",
      operation: "lima",
      outputs: [tandersViva],
      motivo: "otra vez",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.pideMotivo).toBe(false);
      expect(r.error).toContain("solo se permite una vez");
    }
  });

  it("Swayp tampoco, y se reconoce aunque la fila diga «fenix»", () => {
    const swaypViva: SalidaExistente = {
      courier: "fenix",
      delivery_status: "en_ruta",
      output_code: "KP1-S01",
      created_via: "fenix_directo",
    };
    const r = puertaDeSalidaAdicional({
      courier: "fenix",
      operation: "lima",
      outputs: [swaypViva],
      motivo: "otra vez",
    });
    expect(r.ok).toBe(false);
  });

  /** §4: el límite global es cinco salidas por pedido. */
  it("el máximo de cinco salidas", () => {
    const cinco: SalidaExistente[] = [
      GRUPO_GF_EN_LA_CALLE,
      ...Array.from({ length: 4 }, () => ({ courier: "axel", delivery_status: "devuelto" })),
    ];
    const r = puertaDeSalidaAdicional({
      courier: "tanders",
      operation: "lima",
      outputs: cinco,
      motivo: "sí",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("máximo de 5");
  });

  /**
   * FUERA DE LIMA NO CAMBIA NADA. Reproprovincia sigue exigiendo que no haya
   * otra salida viva antes de una Swayp directa (Fase 3 del MOM).
   */
  it("en provincia, otra salida viva sigue bloqueando, con o sin motivo", () => {
    for (const operation of ["provincia_cod", "agencia", "desconocida"] as const) {
      const r = puertaDeSalidaAdicional({
        courier: "fenix",
        operation,
        outputs: [GRUPO_GF_EN_LA_CALLE],
        motivo: "cualquier cosa",
      });
      expect(r.ok, operation).toBe(false);
      if (!r.ok) expect(r.pideMotivo, operation).toBe(false);
    }
  });
});

describe("salidasQueEstorban", () => {
  it("la «por definir» en casa no estorba: se rellena", () => {
    expect(salidasQueEstorban([POR_DEFINIR_EN_CASA])).toEqual([]);
  });

  it("la «por definir» ya fuera de casa sí, y la devuelta no", () => {
    expect(salidasQueEstorban([POR_DEFINIR_FUERA])).toHaveLength(1);
    expect(
      salidasQueEstorban([{ ...GRUPO_GF_EN_LA_CALLE, custody_state: "devuelto" }]),
    ).toEqual([]);
  });
});

describe("el aviso nombra al courier de verdad", () => {
  /**
   * #KP134416: la salida era de Grupo GF y el aviso decía «Aliclik», porque el
   * código elegía entre dos nombres. Quien lo leía iba a buscar al panel de
   * Aliclik una guía que no estaba ahí.
   */
  it("una salida de Grupo GF se llama Grupo GF, no Aliclik", () => {
    expect(nombreDeCourier("propio")).toBe("Grupo GF Courier");
    const r = puertaDeSalidaAdicional({
      courier: "fenix",
      operation: "lima",
      outputs: [GRUPO_GF_EN_LA_CALLE],
      motivo: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Grupo GF Courier");
      expect(r.error).not.toContain("Aliclik");
    }
  });

  it("cada courier con su nombre, y lo desconocido tal cual", () => {
    expect(nombreDeCourier("fenix")).toBe("Swayp");
    expect(nombreDeCourier("tanders")).toBe("Tanders");
    expect(nombreDeCourier("aliclik")).toBe("Aliclik");
    expect(nombreDeCourier("axel")).toBe("Axel Courier");
    expect(nombreDeCourier("nuevo_courier")).toBe("nuevo_courier");
  });

  it("ninguna de las dos pantallas vuelve a elegir entre dos nombres", () => {
    for (const file of [
      "app/dashboard/envios/actions.ts",
      "components/direct-fenix-guide-modal.tsx",
    ]) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(src, file).not.toMatch(/=== "fenix" \? "Swayp" : "Aliclik"/);
    }
  });
});

describe("las dos puertas usan la misma regla y dejan rastro", () => {
  const tanders = readFileSync(
    resolve(process.cwd(), "app/dashboard/pedidos/tanders-actions.ts"),
    "utf8",
  );
  const swayp = readFileSync(resolve(process.cwd(), "app/dashboard/envios/actions.ts"), "utf8");

  it("Tanders y Swayp directa pasan por puertaDeSalidaAdicional al crear", () => {
    expect(tanders).toContain("motivo: input.motivoSalidaAdicional");
    expect(swayp).toContain("motivo: input.motivoSalidaAdicional");
  });

  it("la justificación queda en su propio evento", () => {
    expect(tanders).toContain('kind: "additional_output_reason"');
    expect(swayp).toContain('kind: "additional_output_reason"');
  });

  it("Swayp decide Lima con la misma fuente que la mesa manual", () => {
    expect(swayp).toContain('.select("macro_operation")');
  });
});
