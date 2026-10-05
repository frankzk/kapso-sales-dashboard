import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cancelledScanMessage } from "@/lib/scan-cancelled";

// El escaneo de un pedido anulado respondía «Ese paquete no pertenece a esta
// ruta» (#AUR177767, cancelado por la clienta en Shopify el 04-10 a las 20:31
// de Lima). Lo primero que tiene que decir es que está anulado y no sale.

describe("cancelledScanMessage", () => {
  it("#AUR177767: anulado en Shopify, con fecha y motivo", () => {
    expect(
      cancelledScanMessage({
        orderName: "#AUR177767",
        cancelledAt: "2026-10-05T01:31:07Z",
        cancelReason: "customer",
        generalStatus: "anulado",
      }),
    ).toBe("#AUR177767 está ANULADO en Shopify (el 04/10, lo canceló el cliente): no sale. Sepáralo para devolverlo al stock.");
  });

  it("anulado en Kapta aunque Shopify no lo marque", () => {
    expect(cancelledScanMessage({ orderName: "#KP1", cancelledAt: null, cancelReason: null, generalStatus: "anulado" }))
      .toBe("#KP1 está ANULADO: no sale. Sepáralo para devolverlo al stock.");
  });

  it("un pedido vivo no tiene aviso", () => {
    expect(cancelledScanMessage({ orderName: "#AUR177791", cancelledAt: null, cancelReason: null, generalStatus: "en_proceso" })).toBeNull();
  });

  it("un motivo desconocido no inventa texto", () => {
    expect(cancelledScanMessage({ orderName: "#X", cancelledAt: "2026-10-05T01:31:07Z", cancelReason: "algo_nuevo", generalStatus: null }))
      .toBe("#X está ANULADO en Shopify (el 04/10): no sale. Sepáralo para devolverlo al stock.");
  });
});

describe("los escaneos lo dicen antes que cualquier otra cosa", () => {
  const despacho = readFileSync(join(process.cwd(), "app/dashboard/pedidos/despacho/actions.ts"), "utf8");
  const courier = readFileSync(join(process.cwd(), "app/dashboard/courier/actions.ts"), "utf8");

  it("cotejo: antes de «Ese paquete no pertenece a esta ruta»", () => {
    const body = despacho.slice(despacho.indexOf("export async function scanManifestItem"));
    expect(body.indexOf("cancelledScanNotice(")).toBeGreaterThan(0);
    expect(body.indexOf("cancelledScanNotice(")).toBeLessThan(body.indexOf("Ese paquete no pertenece a esta ruta."));
  });

  it("armado en almacén y agregar a ruta también", () => {
    const ready = despacho.slice(despacho.indexOf("export async function markShipmentReady"), despacho.indexOf("export async function receiveReturnedPackage"));
    expect(ready).toContain("cancelledScanNotice(");
    const add = despacho.slice(despacho.indexOf("export async function addShipmentToManifest"), despacho.indexOf("export async function addShipmentsToManifest"));
    expect(add).toContain("cancelledScanNotice(");
  });

  it("caja del motorizado de Grupo GF", () => {
    const scan = courier.slice(courier.indexOf("export async function scanAssignToRider"));
    expect(scan.indexOf("cancelledScanNotice(admin, orderId)")).toBeGreaterThan(0);
    expect(scan.indexOf("cancelledScanNotice(admin, orderId)")).toBeLessThan(scan.indexOf("// 2) ¿Ya está en una caja activa?"));
  });
});
