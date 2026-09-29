import { afterEach, describe, expect, it, vi } from "vitest";
import { credencialInventarioDesdeEnv, motivoParaRetener, type PlanDeCiudad } from "@/lib/swayp-inventory-sync";
import type { Ajuste, PlanImportacion } from "@/lib/swayp-inventario";

// El sync automático aplica sin que nadie mire. Estas pruebas fijan cuándo se
// NIEGA a aplicar una ciudad (retenciones) y de dónde saca la credencial.

function ajuste(antes: number, despues: number, i: number): Ajuste {
  return { id: `r${i}`, product: `P${i}`, sku: null, cantidadAnterior: antes, cantidadNueva: despues, codbar: `C${i}` };
}

function plan(ciudad: string, p: Partial<PlanImportacion>, filasConStock: number): PlanDeCiudad {
  return {
    ciudad,
    filasConStock,
    plan: {
      ciudad,
      ajustes: [],
      altas: [],
      sinCambio: 0,
      sinControl: 0,
      huerfanos: [],
      totalSwayp: 0,
      totalNuestro: 0,
      ...p,
    },
  };
}

describe("motivoParaRetener", () => {
  it("retiene una ciudad que Swayp traería vacía si Kapta tiene stock", () => {
    expect(motivoParaRetener(plan("arequipa", { totalSwayp: 0, totalNuestro: 120 }, 10))).toMatch(/vaciaría/);
  });

  it("retiene si deja en 0 más de la mitad de los productos con stock (y al menos 5)", () => {
    const ajustes = Array.from({ length: 6 }, (_, i) => ajuste(10, 0, i));
    expect(motivoParaRetener(plan("trujillo", { ajustes, totalSwayp: 40, totalNuestro: 100 }, 10))).toMatch(
      /6 de 10/,
    );
  });

  it("deja pasar un día normal: pocos a 0 o menos de la mitad", () => {
    // Trujillo el 29-09-2026: 11 a 0 de 25 con stock → se aplica.
    const ajustes = Array.from({ length: 11 }, (_, i) => ajuste(4, 0, i));
    expect(motivoParaRetener(plan("trujillo", { ajustes, totalSwayp: 114, totalNuestro: 177 }, 25))).toBeNull();
    // 4 a 0 de 5: mayoría, pero menos de 5 → se aplica.
    const pocos = Array.from({ length: 4 }, (_, i) => ajuste(2, 0, i));
    expect(motivoParaRetener(plan("piura", { ajustes: pocos, totalSwayp: 10, totalNuestro: 18 }, 5))).toBeNull();
  });

  it("nunca retiene una ciudad sin control de cantidad (Lima)", () => {
    expect(motivoParaRetener(plan("lima", { totalSwayp: 0, totalNuestro: 50 }, 0))).toBeNull();
  });
});

describe("credencialInventarioDesdeEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  const base = {
    SWAYP_INVENTORY_TOKEN: "",
    SWAYP_INVENTORY_EMAIL: "",
    SWAYP_TOKEN: "",
    SWAYP_EMAIL: "",
    SWAYP_INVENTORY_RUC: "",
    SWAYP_INVENTORY_COMPANY_ID: "",
    SWAYP_INVENTORY_ORG_ID: "",
  };
  function stub(vals: Partial<typeof base>) {
    for (const [k, v] of Object.entries({ ...base, ...vals })) vi.stubEnv(k, v);
  }

  it("sin configuración, dice qué falta", () => {
    stub({});
    const r = credencialInventarioDesdeEnv();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.faltan).toHaveLength(5);
  });

  it("NO usa la credencial de las guías: Swayp la rechaza para inventario (403 7301)", () => {
    stub({
      SWAYP_TOKEN: "INT",
      SWAYP_EMAIL: "api@kapta.pe",
      SWAYP_INVENTORY_RUC: "20610091823",
      SWAYP_INVENTORY_COMPANY_ID: "IsjvRm8cEqQBFP4r0TxF",
      SWAYP_INVENTORY_ORG_ID: "org-1",
    });
    const r = credencialInventarioDesdeEnv();
    expect(r).toEqual({ ok: false, faltan: ["SWAYP_INVENTORY_TOKEN"] });
  });

  it("con una credencial exclusiva de inventario, arma todo (el correo puede ser el de las guías)", () => {
    stub({
      SWAYP_TOKEN: "INT",
      SWAYP_EMAIL: "api@kapta.pe",
      SWAYP_INVENTORY_TOKEN: "Bearer INV",
      SWAYP_INVENTORY_RUC: "20610091823",
      SWAYP_INVENTORY_COMPANY_ID: "IsjvRm8cEqQBFP4r0TxF",
      SWAYP_INVENTORY_ORG_ID: "org-1",
    });
    expect(credencialInventarioDesdeEnv()).toMatchObject({
      ok: true,
      orgId: "org-1",
      creds: { token: "INV", email: "api@kapta.pe", user: "20610091823", idCompany: "IsjvRm8cEqQBFP4r0TxF" },
    });
  });
});
