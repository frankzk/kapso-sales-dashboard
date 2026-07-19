export interface ShipmentLineageNode {
  id: string;
  courier: string;
  guide_code: string;
  delivery_status: string;
  status_category: string;
  fenix_shipment_id: string | null;
  created_at?: string | null;
}

/**
 * Return the exact connected guide chain, from the original guide to the most
 * recent child. Candidates may contain other guides for the same order; only
 * explicit `fenix_shipment_id` links are followed.
 */
export function buildShipmentLineage(
  candidates: ShipmentLineageNode[],
  currentId: string,
  maxGuides = 30,
): ShipmentLineageNode[] {
  const byId = new Map(candidates.map((shipment) => [shipment.id, shipment]));
  const current = byId.get(currentId);
  if (!current) return [];

  const parentByChild = new Map<string, ShipmentLineageNode>();
  for (const shipment of candidates) {
    if (shipment.fenix_shipment_id && !parentByChild.has(shipment.fenix_shipment_id)) {
      parentByChild.set(shipment.fenix_shipment_id, shipment);
    }
  }

  const seen = new Set<string>([current.id]);
  const ancestors: ShipmentLineageNode[] = [];
  let cursor = current;
  while (ancestors.length < maxGuides - 1) {
    const parent = parentByChild.get(cursor.id);
    if (!parent || seen.has(parent.id)) break;
    ancestors.unshift(parent);
    seen.add(parent.id);
    cursor = parent;
  }

  const descendants: ShipmentLineageNode[] = [];
  cursor = current;
  while (ancestors.length + descendants.length < maxGuides - 1) {
    const childId = cursor.fenix_shipment_id;
    if (!childId) break;
    const child = byId.get(childId);
    if (!child || seen.has(child.id)) break;
    descendants.push(child);
    seen.add(child.id);
    cursor = child;
  }

  return [...ancestors, current, ...descendants];
}
