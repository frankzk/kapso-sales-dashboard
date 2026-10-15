import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ownRiderAttempts, urpiAttempts } from "@/lib/order-status";

const stop = (stopId: string, status: string) => ({ kind: "stop_reported", payload: { stop_id: stopId, status, outcome_reason: "no_contesta" } });
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("intentos del motorizado propio (MOM §14, 15-10-2026)", () => {
  it("#KP140941: dos salidas con Roy, «No contesta» las dos, son dos intentos", () => {
    expect(ownRiderAttempts([
      { kind: "custody_transferred", payload: { route_date: "2026-10-13" } },
      stop("2dd8a697", "no_entregado"),
      { kind: "returned_to_office", payload: { stop_id: "2dd8a697" } },
      stop("eb9e7a58", "no_entregado"),
    ])).toBe(2);
  });
  it("la entrega también es un intento; corregir la misma parada no suma otro", () => {
    expect(ownRiderAttempts([stop("a", "no_entregado"), stop("b", "entregado")])).toBe(2);
    expect(ownRiderAttempts([stop("a", "no_entregado"), stop("a", "entregado")])).toBe(1);
  });
  it("sin paradas reportadas no inventa intentos", () => {
    expect(ownRiderAttempts([])).toBe(0);
    expect(ownRiderAttempts([{ kind: "stop_reported", payload: null }, { kind: "stop_reported", payload: { stop_id: "" } }])).toBe(0);
  });
  it("#KP131545: el «Cancelado» de Urpi del 01/09 es un intento; lo programado todavía no", () => {
    expect(urpiAttempts([{ result_code: "cancelado" }])).toBe(1);
    expect(urpiAttempts([{ result_code: "reprogramado" }, { result_code: "entregado" }])).toBe(2);
    expect(urpiAttempts([{ result_code: "programado" }, { result_code: "en_coordinacion" }, { result_code: "sin_resultado" }, { result_code: "otro" }, { result_code: null }])).toBe(0);
  });
  it("el Master los suma a la columna, pero el costo sigue con los del courier", () => {
    const master = read("lib/order-master.ts");
    expect(master).toContain("attempt_count: state.attemptCount + ownRiderAttempts(stateEvents) + (urpiAttemptsByOrder.get(order.id) ?? 0),");
    expect(master).toContain("attempts: state.attemptCount,");
  });
  it("el MOM lo documenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("#### Intentos de entrega (15-10-2026)");
    expect(mom).toContain("cada parada que reporta un motorizado propio es un intento");
    expect(mom).toContain("«Intentos de entrega»: Todos, 0 intentos, 1 intento, 2 intentos, 3 intentos y 4 a más intentos");
    expect(mom).toContain("«0 intentos» es «ningún intento reportado», no «nunca salió»");
    expect(mom).toContain("**Urpi también cuenta (v1.28, 15-10-2026).**");
  });
  it("el barrido detecta las filas de Urpi nuevas (0265)", () => {
    const sql = read("db/migrations/0265_order_master_stale_urpi.sql");
    expect(sql).toContain("select r.order_id, r.updated_at from urpi_report_rows r where r.order_id is not null");
    expect(sql).toContain("grant execute on function order_master_stale(uuid, int) to service_role;");
    expect(read("scripts/sql/order_master_stale_smoke.sql")).toContain("un intento de Urpi posterior al recálculo debería contar");
  });
});
