import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 0230: «Mover» un paquete escaneado en la oficina aunque su caja ya esté en
// poder del motorizado (#KP138381, de Yhoni a Alexis, 05-10-2026). Antes el
// botón fallaba y el aviso quedaba fuera de la pantalla: parecía no hacer nada.

const sql = readFileSync(join(process.cwd(), "db/migrations/0230_gf_office_reclaim.sql"), "utf8");
const actions = readFileSync(join(process.cwd(), "app/dashboard/courier/actions.ts"), "utf8");
const board = readFileSync(join(process.cwd(), "components/dispatch-day-board.tsx"), "utf8");

describe("gf_office_reclaim", () => {
  it("solo con la parada pendiente: una reportada se resuelve por su reporte", () => {
    expect(sql).toContain("v_stop_status <> 'pendiente'");
    expect(sql).toContain("Esa parada ya fue reportada");
  });

  it("solo cajas de Grupo GF en poder del motorizado", () => {
    expect(sql).toContain("v_manifest.courier <> 'propio'");
    expect(sql).toContain("v_manifest.state <> 'in_custody'");
  });

  it("retira con la marca de retiro autorizado y devuelve la custodia a la empresa", () => {
    expect(sql.indexOf("set_config('gf.withdraw', 'on', true)")).toBeLessThan(sql.indexOf("update dispatch_manifest_items"));
    expect(sql).toContain("custody_state = 'empresa'");
    expect(sql).toContain("delete from delivery_stops");
  });

  it("deja rastro en la caja y en el pedido, sin acceso desde el navegador", () => {
    expect(sql).toContain("'reclaimed_in_office'");
    expect(sql).toContain("'returned_to_office'");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});

describe("Mover desde el escaneo", () => {
  it("la acción usa la recuperación en oficina solo si el paquete está en la mano", () => {
    expect(actions).toContain("const reclaimInOffice = sourceInCustody && opts.inHand === true;");
    expect(actions).toContain('admin.rpc("gf_office_reclaim"');
  });

  it("el botón del escaneo pide inHand y muestra el error en su fila", () => {
    expect(board).toContain("{ inHand: true }");
    expect(board).toContain("onClick={() => void moveScanned(l)}");
    expect(board).toContain('{l.moveError && <p role="alert"');
  });
});
