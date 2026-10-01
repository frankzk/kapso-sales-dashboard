import type { LeadConversation, LeadThread } from "@/app/dashboard/leads/actions";

// Periodic discovery still detects session rotation and newly connected numbers.
export function canUseActiveChatPoll(lastDiscoveryAt: number | null, now: number): boolean {
  return lastDiscoveryAt !== null && now >= lastDiscoveryAt && now - lastDiscoveryAt < 120_000;
}

export function chatContextAfterRead(
  previous: { activeId: string | null; threads: LeadThread[]; activePhoneNumberId: string | null } | null,
  response: LeadConversation,
): { threads: LeadThread[]; activePhoneNumberId: string | null } {
  return response.threadsUnchanged && previous?.activeId === response.activeConversationId
    ? { threads: previous.threads, activePhoneNumberId: previous.activePhoneNumberId }
    : { threads: response.threads, activePhoneNumberId: response.activePhoneNumberId };
}
