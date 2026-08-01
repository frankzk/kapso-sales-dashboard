import { describe, expect, it } from "vitest";
import { MASTER_DETAIL_EXTRA_COLUMNS } from "@/lib/orders-master-access";

describe("Master de Pedidos: columnas del drawer", () => {
  it("incluye los datos de destino y sus fuentes sin agregarlos al listado pesado", () => {
    expect(MASTER_DETAIL_EXTRA_COLUMNS).toEqual(
      expect.arrayContaining([
        "shopify_order_id",
        "address",
        "reference",
        "geo_source",
        "status_source",
      ]),
    );
  });
});
