import { afterEach, describe, expect, it, vi } from "vitest";
import {
  debeSincronizar,
  fuenteAutomaticaDesdeEnv,
  HORAS_ENTRE_SYNCS,
  motivoParaRetener,
  type PlanDeCiudad,
} from "@/lib/swayp-inventory-sync";
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

describe("fuenteAutomaticaDesdeEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("usa la API de integraciones con la credencial de las guías", () => {
    vi.stubEnv("SWAYP_TOKEN", "INT");
    vi.stubEnv("SWAYP_EMAIL", "api@kapta.pe");
    vi.stubEnv("SWAYP_INVENTORY_ORG_ID", "org-1");
    const r = credencial();
    expect(r).toMatchObject({ ok: true, orgId: "org-1", fuente: { tipo: "integracion" } });
    if (r.ok && r.fuente.tipo === "integracion") {
      expect(r.fuente.opts).toMatchObject({ token: "INT", email: "api@kapta.pe" });
    }
  });

  it("sin credencial de guías o sin organización, dice qué falta", () => {
    vi.stubEnv("SWAYP_TOKEN", "");
    vi.stubEnv("SWAYP_EMAIL", "");
    vi.stubEnv("SWAYP_INVENTORY_ORG_ID", "");
    expect(credencial()).toEqual({ ok: false, faltan: ["SWAYP_TOKEN / SWAYP_EMAIL", "SWAYP_INVENTORY_ORG_ID"] });
  });

  function credencial() {
    return fuenteAutomaticaDesdeEnv();
  }
});

describe("debeSincronizar", () => {
  const ahora = new Date("2026-09-29T15:00:00Z");
  it("sí si nunca se sincronizó", () => {
    expect(debeSincronizar(null, ahora)).toBe(true);
  });
  it("una vez al día: no antes de 20 h desde la última buena; sí desde las 20 h", () => {
    expect(HORAS_ENTRE_SYNCS).toBe(20);
    expect(debeSincronizar(new Date("2026-09-28T20:00:00Z"), ahora)).toBe(false); // 19 h
    expect(debeSincronizar(new Date("2026-09-28T19:00:00Z"), ahora)).toBe(true); // 20 h
  });
});
