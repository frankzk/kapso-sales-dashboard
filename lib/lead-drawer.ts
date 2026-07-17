export const MAX_DRAWER_CONVERSATIONS = 10;

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
