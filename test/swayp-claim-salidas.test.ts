import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 0219: `swayp_emission_claim` rechazaba toda guía Swayp directa porque contaba
// como «otra guía activa» la salida «por definir» sobre la que se iba a escribir
// (#KP138264, #KP138197) y la salida adicional de Lima con motivo (#KP138302).
// El chequeo es del reintento automático (MOM §11.9), no de las emisiones por
// botón o voz, que aplican `puertaDeSalidaAdicional` en la app.

const sql = readFileSync(join(process.cwd(), "db/migrations/0219_swayp_claim_salida_por_definir.sql"), "utf8");

describe("swayp_emission_claim — salidas vivas solo bloquean el automático", () => {
  it("el chequeo de otra salida viva va DENTRO de `if p_auto then`", () => {
    const auto = sql.indexOf("if p_auto then");
    const guard = sql.indexOf("El pedido tiene otra guía activa o entregada");
    const insert = sql.indexOf("insert into swayp_guide_emissions");
    expect(auto).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(auto);
    expect(guard).toBeLessThan(insert);
    // Una sola vez: no quedó una copia fuera del bloque automático.
    expect(sql.split("El pedido tiene otra guía activa o entregada").length).toBe(2);
  });

  it("la reserva compartida sigue aplicando a todas las emisiones", () => {
    const auto = sql.indexOf("if p_auto then");
    const reserva = sql.indexOf("Emisión previa o incierta");
    expect(reserva).toBeGreaterThan(0);
    expect(reserva).toBeLessThan(auto);
  });

  it("la guía directa sigue pasando por la regla de salidas de la app", () => {
    const src = readFileSync(join(process.cwd(), "app/dashboard/envios/actions.ts"), "utf8");
    expect(src).toContain("puertaDeSalidaAdicional({");
    expect(src).toContain("sourceKey: `direct:${order.id}:${input.dispatchDateIso}`");
  });
});
