// MOM §29.5 (0192): un reintento sale con el mismo envío; solo se prohíben dos
// paradas pendientes del mismo paquete a la vez.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("reintento de un paquete no entregado", () => {
  it("la unicidad de parada por envío solo cubre paradas pendientes", () => {
    const sql = read("db/migrations/0192_gf_stop_retry_same_shipment.sql");
    expect(sql).toContain("drop index if exists delivery_stop_shipment_uniq;");
    expect(sql).toMatch(/create unique index if not exists delivery_stop_shipment_open_uniq\s+on delivery_stops\(shipment_id\) where shipment_id is not null and status = 'pendiente';/);
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("delivery_stop_shipment_open_uniq");
  });
});
