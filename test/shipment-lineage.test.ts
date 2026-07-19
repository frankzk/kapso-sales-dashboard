import { describe, expect, it } from "vitest";
import { buildShipmentLineage, type ShipmentLineageNode } from "@/lib/shipment-lineage";

function guide(id: string, child: string | null): ShipmentLineageNode {
  return {
    id,
    courier: id === "a" ? "aliclik" : "fenix",
    guide_code: id.toUpperCase(),
    delivery_status: child ? "transferido" : "en_ruta",
    status_category: child ? "transferred" : "in_route",
    fenix_shipment_id: child,
  };
}

describe("buildShipmentLineage", () => {
  const candidates = [guide("a", "b"), guide("b", "c"), guide("c", null)];

  it("returns every mother guide when the current guide is the latest child", () => {
    expect(buildShipmentLineage(candidates, "c").map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("includes ancestors and descendants when opening a middle guide", () => {
    expect(buildShipmentLineage(candidates, "b").map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("ignores unrelated guides and stops safely on a cycle", () => {
    const rows = [...candidates, guide("other", null), guide("cycle-a", "cycle-b"), guide("cycle-b", "cycle-a")];
    expect(buildShipmentLineage(rows, "other").map((row) => row.id)).toEqual(["other"]);
    expect(buildShipmentLineage(rows, "cycle-a").map((row) => row.id)).toEqual(["cycle-b", "cycle-a"]);
  });
});
