import type { LeadConversation, LeadThread } from "@/app/dashboard/leads/actions";

// Periodic discovery still detects session rotation and newly connected numbers.
export function canUseActiveChatPoll(lastDiscoveryAt: number | null, now: number): boolean {
  return lastDiscoveryAt !== null && now >= lastDiscoveryAt && now - lastDiscoveryAt < 120_000;
}

export function chatThreadsAfterRead(
  previous: { activeId: string | null; threads: LeadThread[] } | null,
  response: LeadConversation,
): LeadThread[] {
  return response.threadsUnchanged && previous?.activeId === response.activeConversationId
    ? previous.threads
    : response.threads;
}
