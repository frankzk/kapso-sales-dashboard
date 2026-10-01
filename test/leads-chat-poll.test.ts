import { describe, expect, it } from "vitest";
import { canUseActiveChatPoll, chatThreadsAfterRead } from "@/lib/leads-chat-poll";
import type { LeadConversation, LeadThread } from "@/app/dashboard/leads/actions";

describe("chat polling discovery and selector", () => {
  it("discovers on open, every two minutes, and after a clock reset", () => {
    expect(canUseActiveChatPoll(null, 1000)).toBe(false);
    expect(canUseActiveChatPoll(1000, 21_000)).toBe(true);
    expect(canUseActiveChatPoll(1000, 120_999)).toBe(true);
    expect(canUseActiveChatPoll(1000, 121_000)).toBe(false);
    expect(canUseActiveChatPoll(1000, 999)).toBe(false);
  });
  const threads: LeadThread[] = [{ conversationId: "active", phoneNumberId: "number", label: "Sales", displayPhone: null, lastActiveAt: null }];
  const partial: LeadConversation = { messages: [], threads: [], threadsUnchanged: true, activeConversationId: "active", activePhoneNumberId: "number" };
  it("retains number choices for a transcript-only refresh, including provider failure", () => {
    expect(chatThreadsAfterRead({ activeId: "active", threads }, partial)).toEqual(threads);
    expect(chatThreadsAfterRead({ activeId: "active", threads }, { ...partial, reason: "Provider unavailable" })).toEqual(threads);
  });
  it("does not retain another lead/thread's selector or override fresh discovery", () => {
    expect(chatThreadsAfterRead({ activeId: "other", threads }, partial)).toEqual([]);
    expect(chatThreadsAfterRead(null, partial)).toEqual([]);
    expect(chatThreadsAfterRead({ activeId: "active", threads }, { ...partial, threadsUnchanged: undefined })).toEqual([]);
  });
});
