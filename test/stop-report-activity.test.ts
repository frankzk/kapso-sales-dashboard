import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("reporte de parada en la actividad del pedido (MOM §29.12)", () => {
  it("cada reporte escribe stop_reported y la ficha lo etiqueta", () => {
    const writer = read("lib/stop-report.ts");
    expect(writer).toContain('kind: "stop_reported"');
    expect(writer).toContain("writeStopReportedEvent(");
    // Solo reportes reales, no el «pendiente» que deshace un reporte.
    expect(writer.indexOf('} else {\n    await writeStopReportedEvent(')).toBeGreaterThan(0);
    // Deshacer deja su propio rastro, y el reporte recalcula la etapa (mom-v1.14).
    expect(writer).toContain("await writeStopUndoEvent(");
    expect(writer).toContain("await recomputeOrderMasterSafe(admin, [stop.order_id])");
    expect(read("components/order-master-shared.tsx")).toContain('stop_reported: "Reporte del motorizado"');
  });

  it("la foto y el comprobante se abren desde Reparto y liquidación", () => {
    const route = read("app/api/reparto/foto/route.ts");
    expect(route).toContain("export async function GET(");
    // Quién puede verla lo decide la base: la parada tiene que ser visible bajo RLS.
    expect(route).toContain('from("delivery_stops")');
    expect(route).toContain("photo_path.eq.");
    const table = read("components/routes.tsx");
    expect(table).toContain("/api/reparto/foto?path=${encodeURIComponent(s.photo_path)}");
    expect(table).toContain("/api/reparto/foto?path=${encodeURIComponent(s.voucher_path)}");
  });
});
