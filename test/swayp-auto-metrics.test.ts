import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * El resultado del automático Aliclik → Swayp se lee del ESTADO DE SWAYP
 * (0237, 09-10-2026). La pantalla decía «0 devueltas · 25 pendientes» con 18
 * guías en Devolución: Swayp nunca deja una guía `devuelto` en Kapta. La prueba
 * de la vista contra una base real vive en scripts/sql/swayp_auto_smoke.sql.
 */
const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const MIGRATION = "db/migrations/0237_swayp_auto_metrics_estado_swayp.sql";

describe("swayp_auto_metrics lee el estado de Swayp", () => {
  const sql = read(MIGRATION);

  it("la Devolución de Swayp (8, 9, 12) y la caja de vuelta cuentan como devueltas", () => {
    expect(sql).toContain("when s.swayp_state in (8,9,12) or s.returned_at is not null or s.delivery_status='devuelto' then 'devuelto'");
  });

  it("la entrega gana a todo, y solo lo anulado que no volvió es anulado", () => {
    const entregado = sql.indexOf("then 'entregado'");
    const devuelto = sql.indexOf("then 'devuelto'");
    const anulado = sql.indexOf("then 'anulado'");
    expect(entregado).toBeGreaterThan(0);
    expect(entregado).toBeLessThan(devuelto);
    expect(devuelto).toBeLessThan(anulado);
  });

  it("conserva las columnas que lee la pantalla", () => {
    for (const col of ["attempts", "issued", "delivered", "returned", "cancelled", "review", "pending", "missing_cost", "quoted_cost"]) {
      expect(sql).toContain(col);
    }
  });

  it("el smoke de la base prueba una Devolución contada como devuelta", () => {
    expect(read("scripts/sql/swayp_auto_smoke.sql")).toContain("Swayp return counted as pending");
  });

  it("la pantalla describe el piloto vigente (1 a 2 intentos con visita, PR #879)", () => {
    const page = read("app/dashboard/envios/automatico/page.tsx");
    expect(page).toContain("de 1 a 2 intentos Aliclik informados con el paquete en reparto o de vuelta");
    expect(page).not.toContain("de 0 a 2 intentos");
  });
});
