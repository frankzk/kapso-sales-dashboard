// Kapso parte el chat de un contacto en "conversaciones" por ventana de sesión,
// así que un cliente recurrente acumula muchas. Con 10 el hilo del drawer
// arrancaba a mitad de camino y la asesora se iba a Kapso a leer el historial.
// Se dobla a 20; para que no cueste más latencia (la otra queja), las sesiones
// VIEJAS se leen con 1 página en vez de 2 (ver loadLeadConversation): mismo
// número de requests que antes, el doble de historia.
export const MAX_DRAWER_CONVERSATIONS = 20;

/** Conversation ids needed for one drawer read. The fast pass returns only the
 * active session; the background pass adds older sessions, deduped and bounded. */
export function drawerConversationIds(
  activeId: string,
  sessionIds: string[],
  includeOlder: boolean,
): string[] {
  if (!includeOlder) return [activeId];
  return [...new Set([activeId, ...sessionIds])].slice(0, MAX_DRAWER_CONVERSATIONS);
}
