// Explicit pre-activation fixture for existing sales/voice/read tests. Routing
// authorization itself is exercised in lead-routing-access and SQL smoke tests.
export async function getLeadRoutingScope() { return { enabled: false, allowed: true, blockedIds: [], blocks: [], signature: "routing-off" }; }
export const readRoutingForActor = getLeadRoutingScope;
export function filterRoutedLeads<T>(rows: T[]) { return rows; }
